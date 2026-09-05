// 平台无关的 API 核心。
// 输入标准 Request，输出标准 Response，不碰任何 Node 或 Workers 专属 API。
// VPS（node-server.js）与 Cloudflare Workers（worker.js）都只是把请求转进来。

import {
  hashPassword, verifyPassword, newToken, hashToken, bearerFrom, SESSION_TTL_MS
} from './auth.js';
import {
  BadRequest, normalizeRecord, normalizeAdjust, normalizeSettings,
  recordRowToClient, adjustRowToClient, DAY_RE, MONTH_RE
} from './store.js';

export const API_VERSION = 1;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function err(message, status = 400, code) {
  return json({ ok: false, error: message, code: code || undefined }, status);
}

async function readJson(request, maxBytes = 4 * 1024 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new BadRequest('请求体过大');
  let text;
  try { text = await request.text(); } catch { throw new BadRequest('请求体读取失败'); }
  if (text.length > maxBytes) throw new BadRequest('请求体过大');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new BadRequest('请求体不是合法 JSON'); }
}

/** 简易滑窗限流：登录/注册专用，防在线爆破。内存态，Workers 冷启动会重置，够用。 */
class RateLimiter {
  constructor(limit = 10, windowMs = 60000) {
    this.limit = limit; this.windowMs = windowMs; this.hits = new Map();
  }
  check(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (arr.length >= this.limit) return false;
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.hits.clear(); // 兜底，别把内存吃了
    return true;
  }
}

const loginLimiter = new RateLimiter(10, 60000);

function clientKey(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || request.headers.get('x-real-ip')
    || 'local';
}

async function requireAuth(store, request) {
  const token = bearerFrom(request);
  if (!token) throw Object.assign(new Error('未登录'), { status: 401 });
  const hit = await store.getSessionWithUser(await hashToken(token));
  if (!hit) throw Object.assign(new Error('登录已失效，请重新登录'), { status: 401 });
  if (new Date(hit.session.expires_at).getTime() < Date.now()) {
    await store.deleteSession(hit.session.token_hash);
    throw Object.assign(new Error('登录已过期，请重新登录'), { status: 401 });
  }
  return hit.user;
}

function validUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.-]{3,32}$/.test(u);
}

/**
 * 主入口。
 * @param {Request} request
 * @param {object} store  适配器实例（见 core/store.js 顶部契约）
 * @param {object} opts   { allowRegister } allowRegister=false 时只允许首个用户注册
 */
export async function handleApi(request, store, opts = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': request.headers.get('origin') || '*',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
        'access-control-max-age': '86400'
      }
    });
  }

  try {
    // ---------- 健康检查 ----------
    if (path === '/api/health' && method === 'GET') {
      return json({ ok: true, api: API_VERSION, users: await store.countUsers(), now: new Date().toISOString() });
    }

    // ---------- 注册 ----------
    // 默认策略：只有库里还没有任何用户时才允许注册（首用户即管理员）。
    // 这样公网暴露也不会被陌生人开号。要开放注册就显式传 allowRegister:true。
    if (path === '/api/register' && method === 'POST') {
      if (!loginLimiter.check('reg:' + clientKey(request))) return err('操作过于频繁，请稍后再试', 429);
      const body = await readJson(request);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!validUsername(username)) return err('用户名需 3–32 位，仅限字母数字与 _ . -');
      if (password.length < 8) return err('密码至少 8 位');

      const existing = await store.countUsers();
      if (existing > 0 && !opts.allowRegister) return err('注册已关闭', 403, 'REGISTER_CLOSED');
      if (await store.getUserByUsername(username)) return err('用户名已被占用', 409);

      const { pwHash, pwSalt, pwIter } = await hashPassword(password);
      const user = await store.createUser({ username, pwHash, pwSalt, pwIter, createdAt: new Date().toISOString() });
      return json({ ok: true, user: { id: user.id, username: user.username } }, 201);
    }

    // ---------- 登录 ----------
    if (path === '/api/login' && method === 'POST') {
      if (!loginLimiter.check('login:' + clientKey(request))) return err('尝试过于频繁，请稍后再试', 429);
      const body = await readJson(request);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = await store.getUserByUsername(username);
      // 用户不存在也要走一次真实的密码校验开销，否则能靠响应时间枚举用户名
      const okPw = user
        ? await verifyPassword(password, user)
        : await verifyPassword(password, { pw_salt: '00'.repeat(16), pw_iter: 100000, pw_hash: '' });
      if (!user || !okPw) return err('用户名或密码错误', 401);

      const token = newToken();
      const now = new Date();
      await store.createSession({
        tokenHash: await hashToken(token),
        userId: user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString()
      });
      await store.purgeExpiredSessions(now.toISOString());
      return json({ ok: true, token, user: { id: user.id, username: user.username }, rev: user.rev });
    }

    // ---------- 以下均需登录 ----------
    if (path === '/api/logout' && method === 'POST') {
      const token = bearerFrom(request);
      if (token) await store.deleteSession(await hashToken(token));
      return json({ ok: true });
    }

    if (path === '/api/me' && method === 'GET') {
      const user = await requireAuth(store, request);
      return json({ ok: true, user: { id: user.id, username: user.username }, rev: await store.getRev(user.id) });
    }

    // 全量拉取：首次登录、或本地想直接覆盖时用
    if (path === '/api/data' && method === 'GET') {
      const user = await requireAuth(store, request);
      const dump = await store.fullDump(user.id);
      return json({ ok: true, ...dump });
    }

    // 增量拉取：?since=<rev>，只回比它新的变更（含删除墓碑）
    if (path === '/api/changes' && method === 'GET') {
      const user = await requireAuth(store, request);
      const since = Number(url.searchParams.get('since') || 0);
      if (!Number.isFinite(since) || since < 0) return err('since 必须是非负整数');
      const out = await store.changesSince(user.id, since);
      return json({ ok: true, since, ...out });
    }

    // 推送本地变更。整批原子写入，返回新 rev。
    if (path === '/api/push' && method === 'POST') {
      const user = await requireAuth(store, request);
      const body = await readJson(request);

      const records = [];
      if (body.records && typeof body.records === 'object') {
        for (const [day, raw] of Object.entries(body.records)) records.push(normalizeRecord(day, raw));
      }
      const adjust = [];
      if (body.monthAdjust && typeof body.monthAdjust === 'object') {
        for (const [month, raw] of Object.entries(body.monthAdjust)) adjust.push(normalizeAdjust(month, raw));
      }
      const settings = body.settings !== undefined && body.settings !== null
        ? normalizeSettings(body.settings)
        : null;

      if (!records.length && !adjust.length && !settings) {
        return json({ ok: true, rev: await store.getRev(user.id), applied: 0 });
      }
      const rev = await store.applyPush(user.id, { records, adjust, settings });
      return json({ ok: true, rev, applied: records.length + adjust.length + (settings ? 1 : 0) });
    }

    // 删除单日 / 单月：等价于 push 一个墓碑，给客户端一个更直白的入口
    if (method === 'DELETE' && path.startsWith('/api/record/')) {
      const user = await requireAuth(store, request);
      const day = path.slice('/api/record/'.length);
      if (!DAY_RE.test(day)) return err('日期格式错误');
      const rev = await store.applyPush(user.id, { records: [{ day, deleted: 1 }], adjust: [], settings: null });
      return json({ ok: true, rev });
    }
    if (method === 'DELETE' && path.startsWith('/api/adjust/')) {
      const user = await requireAuth(store, request);
      const month = path.slice('/api/adjust/'.length);
      if (!MONTH_RE.test(month)) return err('月份格式错误');
      const rev = await store.applyPush(user.id, { records: [], adjust: [{ month, deleted: 1 }], settings: null });
      return json({ ok: true, rev });
    }

    // 服务端导出：与前端「导出备份」同一份 bundle 结构，可直接互相导入
    if (path === '/api/export' && method === 'GET') {
      const user = await requireAuth(store, request);
      const dump = await store.fullDump(user.id);
      const recs = {};
      for (const [k, v] of Object.entries(dump.records)) recs[k] = recordRowToClient(v);
      const adj = {};
      for (const [k, v] of Object.entries(dump.adjust)) adj[k] = adjustRowToClient(v);
      return json({
        app: 'work-hours-tracker',
        version: 3,
        exportedAt: new Date().toISOString(),
        rev: dump.rev,
        settings: dump.settings || {},
        records: recs,
        monthAdjust: adj
      }, 200, { 'content-disposition': 'attachment; filename="work-hours-backup.json"' });
    }

    return err('接口不存在: ' + path, 404);
  } catch (e) {
    const status = e.status || (e instanceof BadRequest ? 400 : 500);
    if (status >= 500) console.error('[api]', e);
    return err(e.message || '服务器内部错误', status);
  }
}
