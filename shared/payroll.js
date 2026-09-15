/**
 * 薪酬核算纯模块 —— 零依赖，浏览器与 Node 共用同一份。
 *
 * 存在的理由：这套算钱逻辑原来焊在 index.html 的 setup() 里，唯一能测它的办法是用正则
 * 把内联 <script> 抠出来在 vm 里跑。那意味着「前端一拆，测试全废」——网挂在了要拆掉的墙上。
 * 抽成模块后，测试直接喂数据进函数，跟前端用什么框架、拆成几个文件都无关。
 *
 * 硬性约束（改这个文件前先读）：
 *   1. 不碰 DOM、不碰 localStorage、不碰 window、不读「现在」。
 *      需要「今天」的函数一律由调用方显式传 now，否则测试基准每天都不一样。
 *   2. 纯函数，不改入参。records / monthAdjust 只读。
 *   3. 金额一律返回数字，格式化只在 fmt/money/signed/moneyParts 里做。
 *
 * 业务口径（用户确认的事实，不是推测）：
 *   时薪 19.5 ｜ 满勤门槛 27 天 ｜ 满勤奖 1 元/工时（当月总工时 × 1）
 *   查获 +10 元/件 ｜ 漏查 -20 元/件 ｜ 其他扣款按日填
 *   上半月截止 15 日 ｜ 发薪日 A = 22 号（本月上半月纯工时）
 *   发薪日 B = 次月 10 号（本月下半月工时 + 满勤奖 + 已定稿奖惩）
 *   只有「上班」计出勤；休息/请假不计工时也不计出勤天数
 *   夜班跨天：工时全归开始打卡那一天
 *   满勤未达标 → 满勤奖按 0；奖惩未经组长审核定稿 → 一律按 0（同一个道理）
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.WHTPayroll = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ===== 默认规则 =====
  var DEFAULTS = {
    rate: 19.5,            // 基础时薪，当月工资只含工时
    fullDays: 27,          // 满勤门槛（天）
    fullBonusPerHour: 1,   // 满勤奖 = 当月总工时 × 该单价（属奖励，次月结）
    foundBonus: 10,        // 查获违禁品 元/件
    missedPenalty: 20,     // 漏查违禁品 元/件
    cutoff: 15,            // 上半月截止日
    payDayA: 22,           // 上半月工时 → 当月该日发
    payDayB: 10,           // 下半月工时 + 当月奖惩 → 次月该日发
    dayHours: 8,           // 白班默认工时
    nightHours: 10,        // 夜班默认工时
    defaultShift: 'day'    // 打卡默认班次：'day' 白班 / 'night' 夜班
  };

  // 设置字段中文名：登录合并冲突对照要给人看，不能直接抱 key 上屏
  var SETTING_LABELS = {
    rate: '基础时薪', fullDays: '满勤门槛（天）', fullBonusPerHour: '满勤奖单价',
    foundBonus: '查获奖励/件', missedPenalty: '漏查处罚/件', cutoff: '上半月截止日',
    payDayA: '发薪日 A', payDayB: '发薪日 B', dayHours: '白班默认工时',
    nightHours: '夜班默认工时', defaultShift: '默认班次'
  };

  // ===== 工时口径：6–12h，0.5 步进 =====
  var HOUR_MIN = 6, HOUR_MAX = 12, HOUR_STEP = 0.5;
  var hourOptions = [];
  for (var h = HOUR_MIN; h <= HOUR_MAX + 1e-9; h += HOUR_STEP) hourOptions.push(Math.round(h * 10) / 10);

  // 整数部/小数部拆开渲染（仅日历格子用）：小数位占固定宽度槽位，
  // 这样 8 与 8.5 的整数部左右对齐，不会错位。
  function hInt(v) { return Math.floor(Number(v) || 0); }
  function hFrac(v) { return (Number(v) || 0) % 1 === 0.5 ? '.5' : ''; }

  /**
   * 归一「设置里的班次默认工时」，保证默认值落在可选范围内。
   * 只作用于设置，不改写任何已保存的打卡记录（旧数据里 14h 这类越界值必须原样保留）。
   */
  function clampHours(v, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback === undefined ? DEFAULTS.dayHours : fallback;
    var snapped = Math.round(n / HOUR_STEP) * HOUR_STEP;
    return Math.min(HOUR_MAX, Math.max(HOUR_MIN, snapped));
  }

  /**
   * 数值兜底：输入框清空 / 脏数据时回落默认值，不让计算变 0 或 NaN。
   * 必须先判空 —— Number(null) 与 Number('') 都等于 0，
   * 少了这一步「清空时薪输入框」会把时薪静默变成 0。
   */
  function sn(v, d) {
    if (v === null || v === undefined || v === '') return d;
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : d;
  }

  /** 设置 → 洗过的有效配置。所有算钱函数只认这个返回值，不直接读原始 settings。 */
  function normalizeSettings(settings) {
    var s = settings || {};
    return {
      rate: sn(s.rate, DEFAULTS.rate),
      fullDays: Math.round(sn(s.fullDays, DEFAULTS.fullDays)) || DEFAULTS.fullDays,
      fullBonusPerHour: sn(s.fullBonusPerHour, DEFAULTS.fullBonusPerHour),
      foundBonus: sn(s.foundBonus, DEFAULTS.foundBonus),
      missedPenalty: sn(s.missedPenalty, DEFAULTS.missedPenalty),
      cutoff: Math.min(28, Math.max(1, Math.round(sn(s.cutoff, DEFAULTS.cutoff)))),
      // payDayA/B 原本只用于文案，现在参与日历发薪日判定，必须做同样的洗值，
      // 否则 payDayKind() 拿到 undefined，比较永不命中，角标与内描边都不出现。
      payDayA: Math.min(31, Math.max(1, Math.round(sn(s.payDayA, DEFAULTS.payDayA)))),
      payDayB: Math.min(31, Math.max(1, Math.round(sn(s.payDayB, DEFAULTS.payDayB)))),
      dayHours: clampHours(sn(s.dayHours, DEFAULTS.dayHours), DEFAULTS.dayHours),
      nightHours: clampHours(sn(s.nightHours, DEFAULTS.nightHours), DEFAULTS.nightHours),
      defaultShift: s.defaultShift === 'night' ? 'night' : 'day'
    };
  }

  // ===== 日期键 =====
  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function monthPrefix(y, m) { return y + '-' + pad2(m + 1) + '-'; }
  function keyOf(y, m, d) { return monthPrefix(y, m) + pad2(d); }
  function monthKeyOf(y, m) { return y + '-' + pad2(m + 1); }
  function prevMonthOf(y, m) { return m === 0 ? { year: y - 1, month: 11 } : { year: y, month: m - 1 }; }
  function nextMonthOf(y, m) { return m === 11 ? { year: y + 1, month: 0 } : { year: y, month: m + 1 }; }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function firstDayOfWeek(y, m) { return new Date(y, m, 1).getDay(); }

  /** 取某月的奖惩终稿；跨年也安全，因为 key 是 'YYYY-MM' 全量拼出来的。 */
  function getMonthAdjust(monthAdjust, y, m) {
    return (monthAdjust && monthAdjust[monthKeyOf(y, m)]) || null;
  }

  // ===== 核心聚合 =====
  /**
   * 聚合某月。本月与上月共用同一套口径，跨月结转才不会两头对不上。
   * @param {number} year
   * @param {number} month 0–11
   * @param {{records:object, monthAdjust?:object, cfg:object}} ctx
   */
  function aggregateMonth(year, month, ctx) {
    var c = ctx.cfg;
    var records = ctx.records || {};
    var prefix = monthPrefix(year, month);
    var h1 = 0, h2 = 0, workDays = 0, dayShifts = 0, nightShifts = 0, restDays = 0, leaveDays = 0;
    var foundCount = 0, missedCount = 0, otherPenalties = 0;

    for (var key in records) {
      if (key.indexOf(prefix) !== 0) continue;
      var rec = records[key];
      if (!rec) continue;
      if (rec.status === 'rest') { restDays++; continue; }
      if (rec.status === 'leave') { leaveDays++; continue; }
      if (rec.status !== 'work') continue;

      var day = Number(key.slice(prefix.length));
      var hours = Number(rec.hours || 0);
      // 夜班跨天：工时整段归入开始打卡那一天，不按自然日切开
      if (day <= c.cutoff) h1 += hours; else h2 += hours;

      workDays++;
      if (rec.shift_type === 'night') nightShifts++; else dayShifts++;
      foundCount += Number(rec.contraband_found || 0);
      missedCount += Number(rec.contraband_missed || 0);
      otherPenalties += Math.max(0, Number(rec.other_penalty || 0));
    }

    var totalHours = h1 + h2;
    // 满勤奖只由出勤天数客观判定，不参与人工审核修正
    var fullBonus = workDays >= c.fullDays ? totalHours * c.fullBonusPerHour : 0;
    var foundBonus = foundCount * c.foundBonus;
    var missedPenalty = missedCount * c.missedPenalty;

    // 日常累计奖惩 = 查获 - 漏查 - 其他扣款（不含满勤奖）。
    // 这只是「记录」，不是可发金额：当月只记账，实际奖金要等次月初组长审核提交后才确定。
    var rawReview = foundBonus - missedPenalty - otherPenalties;

    // 与「满勤未达标 → 满勤奖按 0」同一个道理：
    // 奖惩未定稿 → 一律按 0，不进任何应得/发放口径；只有定稿后才用审核终稿金额。
    var adj = getMonthAdjust(ctx.monthAdjust, year, month);
    // 判定条件与重构前逐字一致，包括一个已知怪癖：finalAmount 为 null 时 Number(null)===0 且
    // isFinite(0) 为真，于是「status:'final' + finalAmount:null」会被当成「已定稿¥Ｐ0」。
    // UI 走不到这个分支（writeAdjust 会先拦下非数字），只有导入脏备份才碰得到。
    // 重构阶段一律保持原行为，不在抽模块时偺带修 bug；该怪癖已被用例钉住。
    var finalized = !!(adj && adj.status === 'final' && isFinite(Number(adj.finalAmount)));
    var reviewAmount = finalized ? Number(adj.finalAmount) : 0;
    var reviewDelta = finalized ? reviewAmount - rawReview : 0;
    var reviewNet = reviewAmount;
    // 发放净额 = 满勤奖 + 已定稿奖惩。次月 payDayB 这两笔与下半月工时一起发，
    // 「挣得」与「结转」两套口径都复用它，保证同名同数。
    var adjustNet = fullBonus + reviewNet;

    return {
      h1: h1, h2: h2, totalHours: totalHours, workDays: workDays,
      dayShifts: dayShifts, nightShifts: nightShifts, restDays: restDays, leaveDays: leaveDays,
      foundCount: foundCount, missedCount: missedCount, otherPenalties: otherPenalties,
      fullBonus: fullBonus, foundBonus: foundBonus, missedPenalty: missedPenalty,
      adjustNet: adjustNet, reviewNet: reviewNet,
      rawReview: rawReview, reviewAmount: reviewAmount, reviewDelta: reviewDelta,
      finalized: finalized,
      adjustStatus: adj ? adj.status : null,
      adjustNote: adj && adj.note ? adj.note : '',
      finalizedAt: adj && adj.finalizedAt ? adj.finalizedAt : '',
      basePay: totalHours * c.rate
    };
  }

  /**
   * 现金流与两套记账口径。
   *
   * 归属制「挣得」：本月 1–月底干出来的钱，不管什么时候发。
   * 收付制「进账」：本月卡里实际进的钱，含上月结转。
   * 两者永远不相等，必须各自具名，不能都叫「本月」——这是页面之前最主要的歧义源。
   *
   * @param {{cur:object, prev:object, cfg:object}} o cur/prev 为 aggregateMonth 的返回值
   */
  function flowsOf(o) {
    var cur = o.cur, prev = o.prev, c = o.cfg;
    var thisA = Math.max(0, cur.h1 * c.rate);
    var thisB = Math.max(0, prev.h2 * c.rate + prev.adjustNet);
    var nextB = Math.max(0, cur.h2 * c.rate + cur.adjustNet);

    // 挣得 = 工时收入 + 满勤奖（未达门槛为 0）+ 奖惩净额（未定稿为 0）
    // adjustNet 本身 = fullBonus + reviewNet，所以三项相加严丝合缝等于这个值。
    var earnedTotal = cur.basePay + cur.adjustNet;
    // 结转 = 次月 payDayB 实际到账那一笔。直接复用 nextB，
    // 从公式上保证「结转」与「次月实际上账」永远同一个数，不再出现账目缺口。
    var carry = nextB;
    return {
      thisA: thisA, thisB: thisB, nextB: nextB,
      earnedTotal: earnedTotal,
      cashTotal: thisB + thisA,
      carry: carry,
      split: { paid: thisA, carry: carry },
      // 处罚吃穿下半月工时时结转被 ¥0 兜住，于是 paid+carry > earnedTotal，页面需要明说
      floored: cur.h2 * c.rate + cur.adjustNet < 0
    };
  }

  /** 处罚明细，按日排序并带原因。只看「上班」日，金额 <= 0 的不列。 */
  function penaltyDetails(year, month, ctx) {
    var c = ctx.cfg;
    var records = ctx.records || {};
    var prefix = monthPrefix(year, month);
    var out = [];
    for (var key in records) {
      if (key.indexOf(prefix) !== 0) continue;
      var r = records[key];
      if (!r || r.status !== 'work') continue;
      var missed = Number(r.contraband_missed || 0);
      var other = Math.max(0, Number(r.other_penalty || 0));
      var amount = missed * c.missedPenalty + other;
      if (amount <= 0) continue;
      var parts = [];
      if (missed > 0) parts.push('漏查' + missed + '件');
      if (other > 0) parts.push(r.penalty_reason ? r.penalty_reason : '其他扣款');
      out.push({ day: Number(key.slice(prefix.length)), reason: parts.join('·'), amount: amount });
    }
    return out.sort(function (a, b) { return a.day - b.day; });
  }

  // ===== 日历判定 =====
  /**
   * 上下半月分界格：7 列网格里 day+7 就在 day 正下方，
   * 所以给 cutoff-6 … cutoff 这 7 格加底虚线，正好描出一条完整分界线，
   * 且不必往网格里插额外元素，星期对齐不会被打乱。
   */
  function isCutEdge(day, cfg) { return day <= cfg.cutoff && day + 7 > cfg.cutoff; }

  /**
   * 发薪日判定：'a' = 当月 payDayA（上半月工时）；'b' = 当月 payDayB（上月下半月 + 上月奖惩）。
   * 只做统计标注，不处理「遇周末顺延」，实际到账日以单位为准。
   */
  function payDayKind(day, cfg) {
    if (day === cfg.payDayA) return 'a';
    if (day === cfg.payDayB) return 'b';
    return null;
  }

  function fullDaysLeft(stats, cfg) { return Math.max(0, cfg.fullDays - stats.workDays); }

  /** 上半月那笔到没到账。翻历史月份一律算已发，只有看当前月才有「待发」说法。 */
  function payDayAPassed(year, month, cfg, now) {
    var n = now || new Date();
    var isCur = n.getFullYear() === year && n.getMonth() === month;
    if (!isCur) {
      return year < n.getFullYear() || (year === n.getFullYear() && month < n.getMonth());
    }
    return n.getDate() >= cfg.payDayA;
  }

  function isCurrentMonth(year, month, now) {
    var n = now || new Date();
    return n.getFullYear() === year && n.getMonth() === month;
  }

  function isSameDay(year, month, day, now) {
    var n = now || new Date();
    return n.getFullYear() === year && n.getMonth() === month && n.getDate() === day;
  }

  // ===== 格式化 =====
  // 消除浮点二进制抖动，同时保留原始数据（不进行有损进位截断）
  function rawAmount(n) {
    var v = Number(n) || 0;
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }
  function fmt(n) { return (Number(n) || 0).toFixed(1); }
  function money(n) { return '¥' + rawAmount(n); }
  function signed(n) {
    var v = rawAmount(n);
    return (v >= 0 ? '+¥' : '-¥') + Math.abs(v);
  }

  /**
   * 金额拆成 符号/整数部/小数部，供看板主数字分层渲染（大字只放整数部）。
   * 保留原始数据的小数部分，不进行有损四舍五入。
   */
  function moneyParts(n) {
    var v = rawAmount(n);
    var s = String(Math.abs(v));
    var dot = s.indexOf('.');
    var intPart = dot !== -1 ? s.slice(0, dot) : s;
    var fracPart = dot !== -1 ? s.slice(dot) : '';
    return {
      sign: v < 0 ? '-' : '',
      int: intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ','),   // 千分位
      frac: fracPart
    };
  }

  /** 新建一条打卡草稿。班次决定默认工时。 */
  function newDraft(shift, cfg) {
    return {
      status: 'work',
      shift_type: shift,
      hours: shift === 'night' ? cfg.nightHours : cfg.dayHours,
      contraband_found: 0,
      contraband_missed: 0,
      other_penalty: null,
      penalty_reason: ''
    };
  }

  /**
   * 保存前归一：非正扣款回落 null；非「上班」日清空全部奖惩字段。
   * 原地改传入对象并返回它 —— 调用方持有的就是待落库的那份草稿。
   */
  function normalizeDraft(draft) {
    var op = Number(draft.other_penalty);
    draft.other_penalty = (isFinite(op) && op > 0) ? op : null;
    if (draft.status !== 'work') {
      draft.contraband_found = 0;
      draft.contraband_missed = 0;
      draft.other_penalty = null;
      draft.penalty_reason = '';
    }
    return draft;
  }

  return {
    DEFAULTS: DEFAULTS,
    SETTING_LABELS: SETTING_LABELS,
    HOUR_MIN: HOUR_MIN, HOUR_MAX: HOUR_MAX, HOUR_STEP: HOUR_STEP,
    hourOptions: hourOptions,
    hInt: hInt, hFrac: hFrac, clampHours: clampHours, sn: sn,
    normalizeSettings: normalizeSettings,
    pad2: pad2, monthPrefix: monthPrefix, keyOf: keyOf, monthKeyOf: monthKeyOf,
    prevMonthOf: prevMonthOf, nextMonthOf: nextMonthOf,
    daysInMonth: daysInMonth, firstDayOfWeek: firstDayOfWeek,
    getMonthAdjust: getMonthAdjust,
    aggregateMonth: aggregateMonth,
    flowsOf: flowsOf,
    penaltyDetails: penaltyDetails,
    isCutEdge: isCutEdge, payDayKind: payDayKind, fullDaysLeft: fullDaysLeft,
    payDayAPassed: payDayAPassed, isCurrentMonth: isCurrentMonth, isSameDay: isSameDay,
    fmt: fmt, money: money, signed: signed, moneyParts: moneyParts,
    newDraft: newDraft, normalizeDraft: normalizeDraft
  };
});
