// MCP Server（Model Context Protocol）——挂在主服务的 /mcp 端点上
//
// 为什么不用官方 SDK / 不起新进程：
//   服务端全程零 npm 依赖（连密码哈希都是内置 Web Crypto），MCP 本质就是 JSON-RPC 2.0，
//   无状态 Streamable HTTP 模式只需要 POST + 响应。挂进现有 node-server.js 的 9522 端口，
//   复用同一套 systemd、访问日志与反代，不新增进程与攻击面。
//
// 传输形态（Streamable HTTP，无状态）：
//   POST /mcp   单条 JSON-RPC 请求 → 单条响应；通知（无 id）→ 202 空响应
//   GET/DELETE  405（不提供 SSE 长连接与会话）
//
// 安全模型：
//   1. Bearer Token，配置存 DB（app_settings 表）：后台「设置 → AI 接入 (MCP)」可随时
//      开关/轮换，即时生效无需重启。env MCP_AUTH_TOKEN 只做一次性种子：库里还没有
//      令牌时迁入 DB，之后以 DB 为准（换 env 不会顶掉已生成的令牌）。
//      两者都没配 → 端点关闭（404）。「没给钥匙的门直接不存在」比「存在但报 401」少暴露一层。
//   2. 只读工具：任何工具都不写库。补卡 / 改金额这类敏感操作永远不通过 MCP 暴露，
//      AI 客户端最多能看，不能改。
//   3. 定长比较（timingSafeEqual）防逐字节探测 token。
//
// 引擎复用（本实现最重要的一条设计约束）：
//   所有算钱一律调 shared/payroll.js 的 aggregateMonth / flowsOf / penaltyDetails，
//   与前端看板同源。绝不把薪资规则复述给 AI 让它自己算——模型口算 19.5×7.5×28
//   迟早出错，而引擎带 100+ 基线用例。MCP 只做「取数 + 喂给引擎 + 结构化返回」。
//
//   测试：node --disable-warning=ExperimentalWarning test/mcp.test.js

import { timingSafeEqual } from 'node:crypto';
import payroll from '../../shared/payroll.js';
import { hashToken } from './auth.js';

const SERVER_INFO = { name: 'work-hours-tracker-mcp', version: '1.0.0' };
// 与 MCP 官方已发布版本对齐；客户端发来的版本若认得就原样回，否则回兜底版本。
const SUPPORTED_PROTOCOLS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const FALLBACK_PROTOCOL = '2025-03-26';

// ---------- 业务规则说明（喂给 AI 的口径，避免它用通用常识猜） ----------
export const BUSINESS_RULES = [
  '时薪制：工资只有工时收入，没有底薪。基础时薪见 settings.rate。',
  '双批次发薪：上半月（1 日—cutoff 日，含 cutoff）纯工时 → 当月 payDayA 发；下半月工时 + 当月满勤奖 + 当月已定稿奖惩 → 次月 payDayB 发。',
  '满勤奖：当月「上班」出勤天数 ≥ settings.fullDays 才有，金额 = 当月总工时 × settings.fullBonusPerHour；差一天都没有。',
  '查获奖励：每件 +settings.foundBonus；漏查处罚：每件 -settings.missedPenalty；其他扣款按日录入（正数）。',
  '日常累计奖惩只是记录，不是可发金额：要等次月初组长审核「定稿」后，以定稿终稿金额为准。',
  '未定稿的奖惩一律按 0 计入应得/发放口径（与满勤未达标归零同一个道理）。',
  '处罚吃穿下半月工时时，次月 payDayB 结转按 0 兜底（floored=true，此时两批合计可能大于挣得总额）。',
  '只有 status=work 的日子计工时与出勤；rest（休）/leave（请）都不计。',
  '夜班跨天：工时整段归入开始打卡那一天。',
  'earnedTotal 是「挣得口径」（本月干出来的钱），cashTotal 是「收付口径」（本月实际进账，含上月结转），两者永远不相等，不能混称「本月工资」。'
].join('\n');

// ---------- 工具清单 ----------
const TOOLS = [
  {
    name: 'get_month_summary',
    description: '获取指定月份薪酬大盘：出勤与工时、上下半月拆分、基础工钱、满勤奖（含达标判定）、奖惩定稿状态与金额、挣得总额、两批发薪金额与结转。分析任何月薪问题先用它。',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '公历年份，如 2026' },
        month: { type: 'integer', minimum: 1, maximum: 12, description: '月份 1-12' }
      },
      required: ['year', 'month']
    }
  },
  {
    name: 'get_shift_records',
    description: '获取某月每日打卡明细（日期、状态 work/rest/leave、班次 day/night、工时、查获/漏查件数、扣款、当日工钱），可按班次或状态过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '公历年份' },
        month: { type: 'integer', minimum: 1, maximum: 12, description: '月份 1-12' },
        filter: { type: 'string', enum: ['all', 'work', 'day', 'night', 'rest', 'leave'], description: '过滤：all 全部 / work 上班 / day 白班 / night 夜班 / rest 休 / leave 请' }
      },
      required: ['year', 'month']
    }
  },
  {
    name: 'get_payroll_settings',
    description: '获取薪酬规则参数：时薪、满勤门槛与单价、查获/漏查奖惩单价、上半月截数日、发薪日 A/B、白班/夜班默认工时。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_penalty_details',
    description: '获取某月处罚/奖励明细：按日的漏查与其他扣款清单、查获与漏查件数合计、日常累计净额、组长审核定稿状态与终稿金额。',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '公历年份' },
        month: { type: 'integer', minimum: 1, maximum: 12, description: '月份 1-12' }
      },
      required: ['year', 'month']
    }
  },
  {
    name: 'simulate_leave',
    description: '假设请假试算（只读，不改任何数据）：把某月 N 个工作日按请假重算薪酬，返回与现状的逐项差异（含满勤奖是否丢失）。默认取该月最后 N 个工作日，可用 specific_days 指定具体日期。',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '公历年份' },
        month: { type: 'integer', minimum: 1, maximum: 12, description: '月份 1-12' },
        days: { type: 'integer', minimum: 1, maximum: 31, description: '假设请假的天数' },
        specific_days: {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 31 },
          description: '可选：明确指定请哪几天（几号）。指定后 days 参数被忽略。'
        }
      },
      required: ['year', 'month', 'days']
    }
  },
  {
    name: 'list_month_overview',
    description: '列出所有有数据的月份及各月核心指标（出勤、工时、工钱、满勤奖、定稿奖惩、挣得总额、实际时薪），用于跨月对比（如近 3 个月时薪趋势）。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_business_rules',
    description: '获取本系统薪酬业务规则说明（双批次发薪、满勤判定、未定稿按 0、结转兜底等口径）。做薪酬分析前建议先读，避免用通用薪资常识算错。',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ---------- 小工具 ----------
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** token 比对：定长比较，防时序泄漏也防长度探测 */
function tokenEquals(provided, expected) {
  try {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch { return false; }
}

// ---------- 配置（DB 真开关，后台改动即时生效） ----------
// 开关与令牌存 app_settings 表（不属于任何用户、不参与同步协议，客户端 push 碰不到）。
// 管理入口：/api/mcp/*（见 core/api.js，登录态）与前端设置页「AI 接入 (MCP)」卡片。
export const MCP_KEYS = { token: 'mcp_token', enabled: 'mcp_enabled' };

/** 掩码展示：头 6 尾 4，中间省略。短令牌整个打码。 */
export function maskToken(token) {
  const t = String(token || '');
  if (t.length <= 10) return '…';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

/** 新令牌：64 位 hex（Web Crypto，与 auth.js 同源思路，Node 22 与 Workers 都有） */
export function newMcpToken() {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * 读指定用户的生效配置：{ configured, enabled, token }。
 * 兼容旧数据与种子：如果 user_mcp_tokens 查无记录，但 app_settings/seedToken 中存在旧 token，
 * 则自动为 id=1 的老用户迁入，保证向后无感兼容。
 */
export async function readUserMcpConfig(store, userId, seedToken = '') {
  let cfg = await store.getUserMcpConfig(userId);
  if (cfg && cfg.configured) return cfg;

  // 兼容老单人自用历史数据迁移
  if (userId === 1) {
    let legacyToken = await store.getSetting(MCP_KEYS.token);
    if (!legacyToken && seedToken) {
      legacyToken = seedToken;
      await store.setSetting(MCP_KEYS.token, legacyToken);
    }
    if (legacyToken) {
      const legacyEnabled = (await store.getSetting(MCP_KEYS.enabled)) !== '0';
      const tokenHash = await hashToken(legacyToken);
      await store.saveUserMcpToken(1, legacyToken, tokenHash);
      if (!legacyEnabled) {
        await store.setUserMcpEnabled(1, false);
      }
      return {
        configured: true,
        enabled: legacyEnabled,
        token: legacyToken
      };
    }
  }

  return { configured: false, enabled: false, token: null };
}

/** 生成/轮换用户专有令牌并自动启用 */
export async function saveUserMcpToken(store, userId, token) {
  const tokenHash = await hashToken(token);
  await store.saveUserMcpToken(userId, token, tokenHash);
}

export async function setUserMcpEnabled(store, userId, enabled) {
  await store.setUserMcpEnabled(userId, enabled);
}

// ---------- 参数校验 ----------
function needInt(args, key, { min = null, max = null } = {}) {
  const v = args?.[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw { code: -32602, message: `参数 ${key} 必须是整数` };
  }
  if ((min !== null && v < min) || (max !== null && v > max)) {
    throw { code: -32602, message: `参数 ${key} 超出范围 [${min}, ${max}]` };
  }
  return v;
}

// ---------- 数据装配 ----------
/**
 * 从存储层拉全量并映射成 payroll 引擎要吃的形态。
 * DB 行是 snake_case（final_amount），payroll 认 camelCase（finalAmount），
 * 必须在这里掰过来——引擎是纯函数，不该感知存储形态。
 */
async function buildCtx(store, userId) {
  const dump = await store.fullDump(userId);
  const records = {};
  for (const [day, r] of Object.entries(dump.records)) {
    records[day] = {
      status: r.status, shift_type: r.shift_type, hours: r.hours,
      contraband_found: r.contraband_found, contraband_missed: r.contraband_missed,
      other_penalty: r.other_penalty, penalty_reason: r.penalty_reason || ''
    };
  }
  const monthAdjust = {};
  for (const [month, a] of Object.entries(dump.adjust)) {
    monthAdjust[month] = {
      status: a.status, finalAmount: a.final_amount,
      note: a.note || '', finalizedAt: a.finalized_at || ''
    };
  }
  return {
    records, monthAdjust,
    cfg: payroll.normalizeSettings(dump.settings || {}),
    rev: dump.rev
  };
}

const monthCtxOf = ctx => ({ records: ctx.records, monthAdjust: ctx.monthAdjust, cfg: ctx.cfg });

function summarize(year, month1, ctx) {
  const m0 = month1 - 1;
  const s = payroll.aggregateMonth(year, m0, monthCtxOf(ctx));
  const prev = payroll.prevMonthOf(year, m0);
  const prevAgg = payroll.aggregateMonth(prev.year, prev.month, monthCtxOf(ctx));
  const flows = payroll.flowsOf({ cur: s, prev: prevAgg, cfg: ctx.cfg });
  const c = ctx.cfg;
  return {
    period: `${year}-${String(month1).padStart(2, '0')}`,
    dataRev: ctx.rev,
    rules: {
      rate: c.rate, fullDays: c.fullDays, fullBonusPerHour: c.fullBonusPerHour,
      cutoff: c.cutoff, payDayA: c.payDayA, payDayB: c.payDayB,
      foundBonus: c.foundBonus, missedPenalty: c.missedPenalty
    },
    attendance: {
      workDays: s.workDays, dayShifts: s.dayShifts, nightShifts: s.nightShifts,
      restDays: s.restDays, leaveDays: s.leaveDays
    },
    hours: {
      total: r2(s.totalHours), firstHalf: r2(s.h1), secondHalf: r2(s.h2),
      note: `上半月 1-${c.cutoff} 日，下半月 ${c.cutoff + 1}-月末；夜班跨天工时归开始打卡日`
    },
    pay: {
      basePay: r2(s.basePay),
      fullBonus: r2(s.fullBonus),
      fullBonusQualified: s.workDays >= c.fullDays,
      fullDaysLeft: Math.max(0, c.fullDays - s.workDays),
      earnedTotal: r2(flows.earnedTotal),
      payoutBatchA: r2(flows.thisA),
      payoutBatchB: r2(flows.thisB),
      carryToNextMonth: r2(flows.carry),
      cashTotal: r2(flows.cashTotal),
      floored: flows.floored,
      flooredNote: flows.floored ? '处罚吃穿下半月工时，结转按 0 兜底，两批合计会大于挣得总额' : undefined
    },
    review: {
      foundCount: s.foundCount, missedCount: s.missedCount,
      foundBonus: r2(s.foundBonus), missedPenalty: r2(s.missedPenalty),
      otherPenalties: r2(s.otherPenalties),
      rawReview: r2(s.rawReview),
      adjustStatus: s.adjustStatus, adjustNote: s.adjustNote,
      finalized: s.finalized, finalizedAt: s.finalizedAt,
      finalizedAmount: r2(s.reviewAmount),
      reviewNet: r2(s.reviewNet),
      reviewDelta: r2(s.reviewDelta),
      note: '未定稿时 reviewNet/finalizedAmount 按 0 计'
    }
  };
}

function shiftRecords(year, month1, ctx, filter) {
  const c = ctx.cfg;
  const prefix = `${year}-${String(month1).padStart(2, '0')}-`;
  const out = [];
  for (const [day, r] of Object.entries(ctx.records)) {
    if (!day.startsWith(prefix)) continue;
    if (filter === 'work' && r.status !== 'work') continue;
    if (filter === 'day' && !(r.status === 'work' && r.shift_type === 'day')) continue;
    if (filter === 'night' && !(r.status === 'work' && r.shift_type === 'night')) continue;
    if (filter === 'rest' && r.status !== 'rest') continue;
    if (filter === 'leave' && r.status !== 'leave') continue;
    out.push({
      day,
      status: r.status,
      shiftType: r.shift_type,
      hours: r2(r.hours),
      found: r.contraband_found || 0,
      missed: r.contraband_missed || 0,
      otherPenalty: (r.other_penalty === null || r.other_penalty === undefined) ? null : r2(r.other_penalty),
      penaltyReason: r.penalty_reason || '',
      dayPay: r.status === 'work' ? r2(r.hours * c.rate) : 0
    });
  }
  out.sort((a, b) => a.day < b.day ? -1 : 1);
  return {
    period: prefix.slice(0, 7), filter: filter || 'all',
    count: out.length,
    totalHours: r2(out.reduce((s, x) => s + x.hours, 0)),
    totalDayPay: r2(out.reduce((s, x) => s + x.dayPay, 0)),
    records: out
  };
}

function penaltyDetailsOf(year, month1, ctx) {
  const c = ctx.cfg;
  const details = payroll.penaltyDetails(year, month1 - 1, monthCtxOf(ctx)).map(d => ({
    day: d.day, reason: d.reason, amount: r2(d.amount)
  }));
  const s = payroll.aggregateMonth(year, month1 - 1, monthCtxOf(ctx));
  return {
    period: `${year}-${String(month1).padStart(2, '0')}`,
    unitPrices: { foundBonus: c.foundBonus, missedPenalty: c.missedPenalty },
    counts: { found: s.foundCount, missed: s.missedCount },
    totals: {
      foundBonus: r2(s.foundBonus), missedPenalty: r2(s.missedPenalty),
      otherPenalties: r2(s.otherPenalties),
      rawReview: r2(s.rawReview),
      note: 'rawReview = 查获 - 漏查 - 其他扣款（日常累计，未含满勤奖）'
    },
    details,
    finalize: {
      status: s.adjustStatus, finalized: s.finalized,
      finalizedAmount: r2(s.reviewAmount), note: s.adjustNote,
      finalizedAt: s.finalizedAt,
      effect: s.finalized ? '定稿终稿金额替代日常累计额计入当月奖惩' : '未定稿 → 当月奖惩按 0 计入应得口径'
    }
  };
}

function simulateLeave(year, month1, ctx, days, specificDays) {
  const prefix = `${year}-${String(month1).padStart(2, '0')}-`;
  const workDays = Object.entries(ctx.records)
    .filter(([day, r]) => day.startsWith(prefix) && r.status === 'work')
    .map(([day]) => day)
    .sort();

  // 选哪几天：指定 specific_days → 校验；否则默认取该月最后 N 个工作日
  // （看当前月时它们通常还没到，「把后面的班请掉」最贴近真实请假场景）
  let targets;
  if (Array.isArray(specificDays) && specificDays.length > 0) {
    targets = specificDays.map(d => {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 31) {
        throw { code: -32602, message: `specific_days 里的值必须是 1-31 的整数，收到 ${JSON.stringify(d)}` };
      }
      const key = prefix + String(d).padStart(2, '0');
      if (!ctx.records[key] || ctx.records[key].status !== 'work') {
        throw { code: -32602, message: `日期 ${key} 不是该月的工作日，无法假设请假` };
      }
      return key;
    });
  } else {
    if (days > workDays.length) {
      throw { code: -32602, message: `该月只有 ${workDays.length} 个工作日，无法请假 ${days} 天` };
    }
    targets = workDays.slice(-days);
  }

  const altered = { ...ctx.records };
  for (const key of targets) {
    altered[key] = {
      ...ctx.records[key], status: 'leave',
      shift_type: null, hours: 0,
      contraband_found: 0, contraband_missed: 0,
      other_penalty: null, penalty_reason: ''
    };
  }
  const afterCtx = { records: altered, monthAdjust: ctx.monthAdjust, cfg: ctx.cfg };
  const before = payroll.aggregateMonth(year, month1 - 1, monthCtxOf(ctx));
  const prev = payroll.prevMonthOf(year, month1 - 1);
  const prevAgg = payroll.aggregateMonth(prev.year, prev.month, monthCtxOf(ctx));
  const beforeFlows = payroll.flowsOf({ cur: before, prev: prevAgg, cfg: ctx.cfg });
  const after = payroll.aggregateMonth(year, month1 - 1, monthCtxOf(afterCtx));
  const afterFlows = payroll.flowsOf({ cur: after, prev: prevAgg, cfg: ctx.cfg });

  const snap = (s, f) => ({
    workDays: s.workDays, totalHours: r2(s.totalHours),
    basePay: r2(s.basePay), fullBonus: r2(s.fullBonus),
    fullBonusQualified: s.workDays >= ctx.cfg.fullDays,
    earnedTotal: r2(f.earnedTotal), carryToNextMonth: r2(f.carry)
  });
  const b = snap(before, beforeFlows), a = snap(after, afterFlows);
  const notes = [];
  if (b.fullBonusQualified && !a.fullBonusQualified) {
    notes.push(`出勤将跌破满勤门槛 ${ctx.cfg.fullDays} 天 → 满勤奖 ${b.fullBonus} 元归零，这是最大的损失项`);
  } else if (b.fullBonus > 0) {
    notes.push('满勤奖不受影响（仍达标）');
  }
  notes.push('请假日本身不产生工时收入，只损失当日工钱与可能的满勤奖');
  return {
    period: prefix.slice(0, 7),
    assumedLeaveDays: targets,
    before: b, after: a,
    delta: {
      workDays: a.workDays - b.workDays,
      totalHours: r2(a.totalHours - b.totalHours),
      basePay: r2(a.basePay - b.basePay),
      fullBonus: r2(a.fullBonus - b.fullBonus),
      earnedTotal: r2(a.earnedTotal - b.earnedTotal),
      carryToNextMonth: r2(a.carryToNextMonth - b.carryToNextMonth)
    },
    notes,
    disclaimer: '只读试算，未写入任何数据；请假日期为假设值，返回中已列明具体日期供核对'
  };
}

function monthOverview(ctx) {
  const months = new Set();
  for (const day of Object.keys(ctx.records)) months.add(day.slice(0, 7));
  for (const month of Object.keys(ctx.monthAdjust)) months.add(month);
  const out = [];
  for (const period of [...months].sort().reverse()) {
    const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
    const s = payroll.aggregateMonth(y, m - 1, monthCtxOf(ctx));
    const prev = payroll.prevMonthOf(y, m - 1);
    const flows = payroll.flowsOf({
      cur: s, prev: payroll.aggregateMonth(prev.year, prev.month, monthCtxOf(ctx)), cfg: ctx.cfg
    });
    out.push({
      period,
      workDays: s.workDays, totalHours: r2(s.totalHours),
      basePay: r2(s.basePay), fullBonus: r2(s.fullBonus),
      reviewNet: r2(s.reviewNet), finalized: s.finalized,
      earnedTotal: r2(flows.earnedTotal),
      effectiveHourly: s.totalHours > 0 ? r2(flows.earnedTotal / s.totalHours) : null
    });
  }
  return {
    count: out.length, months: out,
    effectiveHourlyNote: 'effectiveHourly = earnedTotal / 总工时（挣得口径的实际时薪，含满勤奖与定稿奖惩）'
  };
}

// ---------- 工具分发 ----------
async function callTool(name, args, ctx) {
  switch (name) {
    case 'get_payroll_settings':
      return { settings: ctx.cfg, labels: payroll.SETTING_LABELS, rules: BUSINESS_RULES };
    case 'list_month_overview':
      return monthOverview(ctx);
    case 'get_business_rules':
      return { rules: BUSINESS_RULES };
    case 'get_month_summary':
      return summarize(needInt(args, 'year', { min: 2000, max: 2100 }), needInt(args, 'month', { min: 1, max: 12 }), ctx);
    case 'get_penalty_details':
      return penaltyDetailsOf(needInt(args, 'year', { min: 2000, max: 2100 }), needInt(args, 'month', { min: 1, max: 12 }), ctx);
    case 'get_shift_records': {
      const year = needInt(args, 'year', { min: 2000, max: 2100 });
      const month = needInt(args, 'month', { min: 1, max: 12 });
      const f = args.filter === undefined ? 'all' : String(args.filter);
      if (!['all', 'work', 'day', 'night', 'rest', 'leave'].includes(f)) {
        throw { code: -32602, message: `filter 只能是 all/work/day/night/rest/leave，收到 ${f}` };
      }
      return shiftRecords(year, month, ctx, f);
    }
    case 'simulate_leave': {
      const year = needInt(args, 'year', { min: 2000, max: 2100 });
      const month = needInt(args, 'month', { min: 1, max: 12 });
      const days = needInt(args, 'days', { min: 1, max: 31 });
      return simulateLeave(year, month, ctx, days, args.specific_days);
    }
    default:
      throw { code: -32602, message: `未知工具: ${name}` };
  }
}

// ---------- JSON-RPC 入口 ----------
async function handleRpcMessage(msg, store, userId) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(null, -32600, '不是合法的 JSON-RPC 2.0 请求');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    switch (msg.method) {
      case 'initialize':
        if (isNotification) return null;
        return rpcResult(msg.id, {
          protocolVersion: SUPPORTED_PROTOCOLS.has(msg.params?.protocolVersion) ? msg.params.protocolVersion : FALLBACK_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO
        });
      case 'notifications/initialized':
        return null;   // 通知不回包（HTTP 层转 202）
      case 'ping':
        return isNotification ? null : rpcResult(msg.id, {});
      case 'tools/list':
        return isNotification ? null : rpcResult(msg.id, { tools: TOOLS });
      case 'tools/call': {
        if (isNotification) return null;
        const name = msg.params?.name;
        if (typeof name !== 'string' || !TOOLS.some(t => t.name === name)) {
          return rpcError(msg.id, -32602, `未知工具: ${String(name)}`);
        }
        // 每次调用现拉全量，保证 AI 拿到的是最新打卡（全量很小：42 行记录）
        const fresh = await buildCtx(store, userId);
        const data = await callTool(name, msg.params.arguments || {}, fresh);
        const text = JSON.stringify(data, null, 2);
        return rpcResult(msg.id, { content: [{ type: 'text', text }], structuredContent: data });
      }
      default:
        return isNotification ? null : rpcError(msg.id, -32601, `未知方法: ${String(msg.method)}`);
    }
  } catch (e) {
    if (isNotification) return null;
    if (e && e.code === -32602) return rpcError(msg.id, -32602, e.message);
    return rpcError(msg.id, -32603, '内部错误：' + (e?.message || String(e)));
  }
}

/**
 * HTTP 入口。
 * 多用户架构：MCP 请求由 Bearer Token 鉴权，根据 tokenHash 检索绑定的 user。
 * 完全解绑单人 id=1 硬编码，不同用户的 AI 客户端独立查各自打卡与薪酬。
 * @param {Request} request
 * @param {object} store   SqliteStore / D1Store 实例
 * @param {{seedToken?:string}} opts  MCP_AUTH_TOKEN 环境变量值（仅首次种子用）
 */
export async function handleMcp(request, store, opts = {}) {
  // 全局若未配置过任何可用 token，端点按设计直接关闭（404 隐藏端点）
  const activeCount = await store.countActiveMcpTokens();
  let legacyCfg1 = null;
  if (activeCount === 0) {
    legacyCfg1 = await readUserMcpConfig(store, 1, opts.seedToken);
    if (!legacyCfg1.configured) {
      return new Response('MCP 未启用：尚未配置接入令牌（页面「设置 → AI 接入 (MCP)」可一键生成）', { status: 404 });
    }
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed（本端点只接受 POST）', {
      status: 405, headers: { allow: 'POST' }
    });
  }

  const provided = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!provided) {
    return json({ error: 'unauthorized', message: '缺少 Authorization Bearer 令牌' }, 401);
  }

  const tokenHash = await hashToken(provided);
  let hit = await store.getUserByMcpTokenHash(tokenHash);

  // 兜底兼容迁移：若尚未迁入 user_mcp_tokens，检查 user 1 是否有遗留配置
  if (!hit) {
    const cfg1 = legacyCfg1 || await readUserMcpConfig(store, 1, opts.seedToken);
    if (cfg1.configured && cfg1.token && tokenEquals(provided, cfg1.token)) {
      const u1 = await store.getUserById(1);
      if (u1) hit = { user: u1, enabled: cfg1.enabled };
    }
  }

  if (!hit) {
    return json({ error: 'unauthorized', message: '无效的 MCP 访问令牌' }, 401);
  }

  if (!hit.enabled) {
    return new Response('MCP 已在后台关闭：可在页面「设置 → AI 接入 (MCP)」重新开启', { status: 503 });
  }

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json(rpcError(null, -32700, 'JSON 解析失败'), 400);
  }

  const user = hit.user;

  if (Array.isArray(body)) {
    const responses = [];
    for (const msg of body) {
      const r = await handleRpcMessage(msg, store, user.id);
      if (r) responses.push(r);
    }
    return responses.length ? json(responses) : new Response(null, { status: 202 });
  }

  const response = await handleRpcMessage(body, store, user.id);
  if (!response) return new Response(null, { status: 202 });
  return json(response);
}
