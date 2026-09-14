// 存储层契约（Store Contract）
//
// 为什么要有这一层：现在跑 VPS（node:sqlite），以后要上 Cloudflare Workers（D1），
// 再往后做 APP 还可能换别的后端。把「业务逻辑」和「怎么存」切开，
// 换平台只需要重写一个适配器，core/api.js 一行都不用动。
//
// 适配器必须实现下列方法。所有时间统一 ISO 8601 UTC 字符串。
//
//   // ---- 用户与会话 ----
//   countUsers(): Promise<number>
//   getUserByUsername(username): Promise<UserRow|null>
//   getUserById(id): Promise<UserRow|null>
//   createUser({ username, pwHash, pwSalt, pwIter, createdAt }): Promise<UserRow>
//   createSession({ tokenHash, userId, createdAt, expiresAt }): Promise<void>
//   getSessionWithUser(tokenHash): Promise<{ session, user }|null>
//   deleteSession(tokenHash): Promise<void>
//   purgeExpiredSessions(nowIso): Promise<number>
//
//   // ---- 数据同步 ----
//   getRev(userId): Promise<number>
//   // 原子写入：内部自行 +1 rev、给所有行打上同一个 rev，返回新 rev
//   applyPush(userId, { records, adjust, settings }): Promise<number>
//   // 增量拉取：返回 rev > since 的全部变更（含 deleted 墓碑）
//   changesSince(userId, since): Promise<{ rev, records, adjust, settings }>
//   // 全量导出，用于备份与首次同步
//   fullDump(userId): Promise<{ rev, records, adjust, settings }>
//
//   // ---- App 级键值 ----（运行时配置，如全局系统开关；不属于任何用户，不参与同步）
//   getSetting(key): Promise<string|null>
//   setSetting(key, value): Promise<void>
//
//   // ---- 用户级 MCP 接入令牌 ----
//   countActiveMcpTokens(): Promise<number>
//   getUserMcpConfig(userId): Promise<{ configured: boolean, enabled: boolean, token: string|null }|null>
//   saveUserMcpToken(userId, token, tokenHash): Promise<void>
//   setUserMcpEnabled(userId, enabled): Promise<void>
//   getUserByMcpTokenHash(tokenHash): Promise<{ user: UserRow, enabled: boolean }|null>
//
// UserRow: { id, username, pw_hash, pw_salt, pw_iter, rev, created_at }

export const HOUR_MIN = 6;
export const HOUR_MAX = 12;

const STATUS = new Set(['work', 'rest', 'leave']);
const SHIFT = new Set(['day', 'night']);
const ADJUST_STATUS = new Set(['draft', 'final']);

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * 键的合法性不能只看形状。`2026-13` 能过 /^\d{4}-\d{2}$/，`2026-02-31` 也能过日期正则，
 * 但它们都不是真实存在的月份/日期，放进库里会变成永远算不进任何月份的孤儿行。
 */
export function isValidMonthKey(k) {
  if (!MONTH_RE.test(k)) return false;
  const mo = Number(k.slice(5, 7));
  return mo >= 1 && mo <= 12;
}

export function isValidDayKey(k) {
  if (!DAY_RE.test(k)) return false;
  const y = Number(k.slice(0, 4)), mo = Number(k.slice(5, 7)), d = Number(k.slice(8, 10));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // 用 UTC 构造再回读，闰年与月末天数一次性交给 Date 判定
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 设置字段白名单：与前端 DEFAULTS 对齐，多余字段一律丢弃 */
export const SETTINGS_FIELDS = {
  rate: 'number',
  fullDays: 'number',
  fullBonusPerHour: 'number',
  foundBonus: 'number',
  missedPenalty: 'number',
  cutoff: 'number',
  payDayA: 'number',
  payDayB: 'number',
  dayHours: 'number',
  nightHours: 'number',
  defaultShift: 'shift'
};

export class BadRequest extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

function num(v, name, { min = -1e9, max = 1e9, int = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequest(`${name} 必须是数字`);
  if (int && !Number.isInteger(n)) throw new BadRequest(`${name} 必须是整数`);
  if (n < min || n > max) throw new BadRequest(`${name} 超出范围 [${min}, ${max}]`);
  return n;
}

/**
 * 规范化单日打卡。
 * 服务端不做「业务合理性」判断（比如工时必须 6–12），只做类型与边界校验，
 * 因为业务规则会变，而历史数据不该因为改规则就存不进来。
 */
export function normalizeRecord(day, raw) {
  if (!isValidDayKey(day)) throw new BadRequest(`日期键不是有效日期: ${day}`);
  if (raw === null || raw === undefined) return { day, deleted: 1 };
  if (typeof raw !== 'object') throw new BadRequest(`${day} 的记录必须是对象`);
  if (raw.deleted === true || raw.deleted === 1) return { day, deleted: 1 };

  const status = String(raw.status || '');
  if (!STATUS.has(status)) throw new BadRequest(`${day} 的 status 只能是 work/rest/leave`);

  if (status !== 'work') {
    // 休息/请假不携带工时与奖惩，统一清零，避免脏数据参与结算
    return {
      day, deleted: 0, status,
      shift_type: null, hours: 0,
      contraband_found: 0, contraband_missed: 0,
      other_penalty: null, penalty_reason: ''
    };
  }

  const shift = String(raw.shift_type || '');
  if (!SHIFT.has(shift)) throw new BadRequest(`${day} 的 shift_type 只能是 day/night`);

  const op = raw.other_penalty;
  const penalty = (op === null || op === undefined || op === '')
    ? null
    : num(op, `${day} 的 other_penalty`, { min: 0, max: 100000 });

  return {
    day, deleted: 0, status,
    shift_type: shift,
    hours: num(raw.hours, `${day} 的 hours`, { min: 0, max: 24 }),
    contraband_found: num(raw.contraband_found ?? 0, `${day} 的 contraband_found`, { min: 0, max: 9999, int: true }),
    contraband_missed: num(raw.contraband_missed ?? 0, `${day} 的 contraband_missed`, { min: 0, max: 9999, int: true }),
    other_penalty: penalty,
    penalty_reason: String(raw.penalty_reason || '').slice(0, 200)
  };
}

/** 规范化月度奖惩终稿 */
export function normalizeAdjust(month, raw) {
  if (!isValidMonthKey(month)) throw new BadRequest(`月份键不是有效月份: ${month}`);
  if (raw === null || raw === undefined) return { month, deleted: 1 };
  if (typeof raw !== 'object') throw new BadRequest(`${month} 的奖惩必须是对象`);
  if (raw.deleted === true || raw.deleted === 1) return { month, deleted: 1 };

  const status = String(raw.status || '');
  if (!ADJUST_STATUS.has(status)) throw new BadRequest(`${month} 的 status 只能是 draft/final`);

  const amt = raw.finalAmount ?? raw.final_amount;
  // draft 允许金额为空（还没填完就存草稿）；final 必须有确定金额，否则前端无法判定「已定稿」
  let finalAmount = null;
  if (amt !== null && amt !== undefined && amt !== '') {
    finalAmount = num(amt, `${month} 的 finalAmount`, { min: -1000000, max: 1000000 });
  } else if (status === 'final') {
    throw new BadRequest(`${month} 定稿必须填写终稿金额`);
  }

  return {
    month, deleted: 0, status, final_amount: finalAmount,
    note: String(raw.note || '').slice(0, 200),
    finalized_at: status === 'final' ? String(raw.finalizedAt || raw.finalized_at || new Date().toISOString()) : ''
  };
}

/** 规范化设置：只保留白名单字段 */
export function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') throw new BadRequest('settings 必须是对象');
  const out = {};
  for (const [k, kind] of Object.entries(SETTINGS_FIELDS)) {
    if (raw[k] === undefined) continue;
    if (kind === 'number') out[k] = num(raw[k], `settings.${k}`, { min: 0, max: 100000 });
    else if (kind === 'shift') {
      const v = String(raw[k]);
      if (!SHIFT.has(v)) throw new BadRequest('settings.defaultShift 只能是 day/night');
      out[k] = v;
    }
  }
  return out;
}

/** DB 行 → 前端使用的记录对象（去掉同步用的内部字段） */
export function recordRowToClient(r) {
  return {
    status: r.status,
    shift_type: r.shift_type,
    hours: r.hours,
    contraband_found: r.contraband_found,
    contraband_missed: r.contraband_missed,
    other_penalty: r.other_penalty,
    penalty_reason: r.penalty_reason || ''
  };
}

export function adjustRowToClient(r) {
  return {
    status: r.status,
    finalAmount: r.final_amount,
    note: r.note || '',
    finalizedAt: r.finalized_at || ''
  };
}
