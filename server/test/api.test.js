// 服务端 API 自测：直接调 core/api.js，不起 HTTP 端口，跑得快也不占端口。
// 存储用临时 SQLite 文件，跑完删掉。
//
//   node --disable-warning=ExperimentalWarning test/api.test.js

import { handleApi } from '../core/api.js';
import { SqliteStore } from '../adapters/sqlite-node.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const tmp = mkdtempSync(join(tmpdir(), 'wht-test-'));
const store = new SqliteStore(join(tmp, 'test.db'));

function section(t) { console.log(`\n── ${t}`); }
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `实得 ${a}，应为 ${e}`);
}

let TOKEN = null;
async function call(method, path, body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request('http://t' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const res = await handleApi(req, store, {});
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const REC = (h, extra = {}) => ({
  status: 'work', shift_type: 'day', hours: h,
  contraband_found: 0, contraband_missed: 0, other_penalty: null, penalty_reason: '',
  ...extra
});

// ==========================================================
section('健康检查与注册策略');
{
  let r = await call('GET', '/api/health');
  eq('health 200', r.status, 200);
  eq('初始 0 用户', r.body.users, 0);

  r = await call('POST', '/api/register', { username: 'ab', password: 'longenough1' });
  eq('用户名过短被拒', r.status, 400);

  r = await call('POST', '/api/register', { username: 'kory', password: 'short' });
  eq('密码过短被拒', r.status, 400);

  r = await call('POST', '/api/register', { username: 'kory', password: 'kory-pass-123' });
  eq('首个账号注册成功', r.status, 201);

  r = await call('POST', '/api/register', { username: 'kory', password: 'kory-pass-123' });
  eq('重名/注册已关闭', r.status, 403);   // 已有用户且未开放注册 → 403 先命中

  r = await call('GET', '/api/health');
  eq('health 显示 1 用户', r.body.users, 1);
}

section('登录与鉴权');
{
  let r = await call('POST', '/api/login', { username: 'kory', password: 'wrong-pass-x' }, null);
  eq('错密码 401', r.status, 401);

  r = await call('POST', '/api/login', { username: 'nobody', password: 'kory-pass-123' }, null);
  eq('不存在的用户也是 401（不泄漏用户名）', r.status, 401);

  r = await call('POST', '/api/login', { username: 'kory', password: 'kory-pass-123' }, null);
  eq('登录成功', r.status, 200);
  ok('返回 token', typeof r.body.token === 'string' && r.body.token.length === 64);
  eq('初始 rev = 0', r.body.rev, 0);
  TOKEN = r.body.token;

  r = await call('GET', '/api/data', undefined, null);
  eq('无 token 取数据 401', r.status, 401);

  r = await call('GET', '/api/data', undefined, 'deadbeef');
  eq('伪造 token 401', r.status, 401);

  r = await call('GET', '/api/me');
  eq('me 200', r.status, 200);
  eq('me 用户名', r.body.user.username, 'kory');
}

section('推送与拉取');
{
  let r = await call('POST', '/api/push', {
    records: { '2026-09-01': REC(8), '2026-09-02': REC(8), '2026-09-03': REC(6, { contraband_found: 1 }) },
    settings: { rate: 19.5, fullDays: 27 }
  });
  eq('push 200', r.status, 200);
  eq('rev 递增到 1', r.body.rev, 1);
  eq('applied = 4', r.body.applied, 4);

  r = await call('GET', '/api/data');
  eq('拉到 3 天', Object.keys(r.body.records).length, 3);
  eq('9/3 工时 6h', r.body.records['2026-09-03'].hours, 6);
  eq('9/3 查获 1 件', r.body.records['2026-09-03'].contraband_found, 1);
  eq('设置 rate', r.body.settings.rate, 19.5);

  // 增量：since=1 应该什么都没有
  r = await call('GET', '/api/changes?since=1');
  eq('since=1 无变更', Object.keys(r.body.records).length, 0);
  eq('since=1 设置无变更', r.body.settings, null);

  // 再改一天
  r = await call('POST', '/api/push', { records: { '2026-09-04': REC(10, { contraband_missed: 2 }) } });
  eq('rev 递增到 2', r.body.rev, 2);

  r = await call('GET', '/api/changes?since=1');
  eq('since=1 拿到 1 条新增', Object.keys(r.body.records).length, 1);
  eq('新增的是 9/4', Object.keys(r.body.records)[0], '2026-09-04');
  eq('changes 里 rev = 2', r.body.rev, 2);
}

section('设置是合并而非覆盖');
{
  let r = await call('POST', '/api/push', { settings: { rate: 21 } });
  eq('只推 rate', r.status, 200);
  r = await call('GET', '/api/data');
  eq('rate 已更新', r.body.settings.rate, 21);
  eq('fullDays 未被清掉', r.body.settings.fullDays, 27);
}

section('删除用墓碑传播');
{
  let r = await call('DELETE', '/api/record/2026-09-04');
  eq('删除 200', r.status, 200);
  const revAfterDelete = r.body.rev;

  r = await call('GET', '/api/data');
  ok('fullDump 里已看不到 9/4', r.body.records['2026-09-04'] === undefined);
  eq('fullDump 剩 3 天', Object.keys(r.body.records).length, 3);

  r = await call('GET', `/api/changes?since=${revAfterDelete - 1}`);
  eq('增量里能看到 9/4 墓碑', r.body.records['2026-09-04'].deleted, 1);

  r = await call('DELETE', '/api/record/2026-9-4');
  eq('非法日期格式被拒', r.status, 400);
}

section('月度奖惩：draft 不需要金额，final 必须有');
{
  let r = await call('POST', '/api/push', { monthAdjust: { '2026-09': { status: 'draft', note: '还没算完' } } });
  eq('draft 无金额可存', r.status, 200);

  r = await call('POST', '/api/push', { monthAdjust: { '2026-09': { status: 'final', note: '组长核定' } } });
  eq('final 缺金额被拒', r.status, 400);
  ok('错误信息点明原因', /终稿金额/.test(r.body.error), r.body.error);

  r = await call('POST', '/api/push', {
    monthAdjust: { '2026-09': { status: 'final', finalAmount: -55, note: '扣漏查', finalizedAt: '2026-10-01T09:00:00.000Z' } }
  });
  eq('final 带金额成功', r.status, 200);

  r = await call('GET', '/api/data');
  eq('终稿状态', r.body.adjust['2026-09'].status, 'final');
  eq('终稿金额支持负数', r.body.adjust['2026-09'].final_amount, -55);
  eq('定稿时间原样保留', r.body.adjust['2026-09'].finalized_at, '2026-10-01T09:00:00.000Z');

  r = await call('POST', '/api/push', { monthAdjust: { '2026-13': { status: 'draft' } } });
  eq('非法月份被拒', r.status, 400);
}

section('输入校验');
{
  const bad = [
    ['status 非法', { records: { '2026-09-05': { status: 'sleep' } } }],
    ['shift 非法', { records: { '2026-09-05': { status: 'work', shift_type: 'noon', hours: 8 } } }],
    ['hours 非数字', { records: { '2026-09-05': REC('abc') } }],
    ['hours 超界', { records: { '2026-09-05': REC(99) } }],
    ['查获件数为小数', { records: { '2026-09-05': REC(8, { contraband_found: 1.5 }) } }],
    ['日期键格式错', { records: { '20260905': REC(8) } }],
    ['defaultShift 非法', { settings: { defaultShift: 'noon' } }]
  ];
  for (const [name, body] of bad) {
    const r = await call('POST', '/api/push', body);
    ok(name + ' → 400', r.status === 400, `实得 ${r.status} ${r.body && r.body.error}`);
  }

  // 休息日必须把工时与奖惩清零，防脏数据参与结算
  let r = await call('POST', '/api/push', {
    records: { '2026-09-06': { status: 'rest', shift_type: 'day', hours: 8, contraband_found: 3 } }
  });
  eq('休息日可存', r.status, 200);
  r = await call('GET', '/api/data');
  eq('休息日工时归零', r.body.records['2026-09-06'].hours, 0);
  eq('休息日查获归零', r.body.records['2026-09-06'].contraband_found, 0);
  eq('休息日班次清空', r.body.records['2026-09-06'].shift_type, null);
}

section('导出格式与前端 bundle 对齐');
{
  const r = await call('GET', '/api/export');
  eq('export 200', r.status, 200);
  eq('app 标识', r.body.app, 'work-hours-tracker');
  eq('version 3', r.body.version, 3);
  ok('records 是前端结构（有 penalty_reason 无 rev）',
    r.body.records['2026-09-01'].penalty_reason !== undefined && r.body.records['2026-09-01'].rev === undefined);
  ok('monthAdjust 用 finalAmount 驼峰', r.body.monthAdjust['2026-09'].finalAmount === -55);
}

section('多用户数据隔离');
{
  // 开放注册开第二个号
  const req = new Request('http://t/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'other', password: 'other-pass-123' })
  });
  let res = await handleApi(req, store, { allowRegister: true });
  eq('第二个账号注册成功', res.status, 201);

  let r = await call('POST', '/api/login', { username: 'other', password: 'other-pass-123' }, null);
  const otherToken = r.body.token;
  eq('第二个账号 rev = 0', r.body.rev, 0);

  r = await call('GET', '/api/data', undefined, otherToken);
  eq('新账号看不到别人的记录', Object.keys(r.body.records).length, 0);

  await call('POST', '/api/push', { records: { '2026-09-01': REC(12) } }, otherToken);
  r = await call('GET', '/api/data', undefined, otherToken);
  eq('新账号自己的 9/1 是 12h', r.body.records['2026-09-01'].hours, 12);
  r = await call('GET', '/api/data');
  eq('原账号 9/1 仍是 8h（未被串改）', r.body.records['2026-09-01'].hours, 8);
}

section('登出后 token 立即失效');
{
  let r = await call('POST', '/api/logout');
  eq('logout 200', r.status, 200);
  r = await call('GET', '/api/data');
  eq('登出后 401', r.status, 401);
}

section('会话过期');
{
  const { hashToken } = await import('../core/auth.js');
  const r0 = await call('POST', '/api/login', { username: 'kory', password: 'kory-pass-123' }, null);
  const tk = r0.body.token;
  // 手动把这条会话改成已过期
  store.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run('2000-01-01T00:00:00.000Z', await hashToken(tk));
  const r = await call('GET', '/api/data', undefined, tk);
  eq('过期 token 401', r.status, 401);
  ok('提示需重新登录', /过期|失效/.test(r.body.error), r.body.error);
}

section('404 与畸形请求体');
{
  let r = await call('GET', '/api/nope');
  eq('未知接口 404', r.status, 404);

  const req = new Request('http://t/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json'
  });
  const res = await handleApi(req, store, {});
  eq('畸形 JSON 400', res.status, 400);
}

// ==========================================================
store.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);
