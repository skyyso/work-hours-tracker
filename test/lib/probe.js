// 探针：把「一个月的全部薪酬输出」压成一个可比较的扁平对象。
//
// 两个实现必须产出结构完全相同的对象：
//   probeApp(app)   —— 从 index.html 跑出来的 setup() 返回值上读
//   probePure(sc)   —— 只用 shared/payroll.js 算
// 于是「重构有没有改变行为」就退化成一次 deepEqual。
'use strict';

const P = require('../../shared/payroll.js');

// 浮点噪声必须先掐掉：19.5 × 22 这类乘法在不同写法下可能差 1e-13，
// 那不是行为变化，却会让 deepEqual 全线报红。金额留 4 位足够（页面只显示 1 位）。
const r4 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return v === undefined ? null : String(v);
  return Math.round(v * 1e4) / 1e4;
};

const STAT_KEYS = [
  'h1', 'h2', 'totalHours', 'workDays', 'dayShifts', 'nightShifts', 'restDays', 'leaveDays',
  'foundCount', 'missedCount', 'otherPenalties',
  'fullBonus', 'foundBonus', 'missedPenalty', 'adjustNet', 'reviewNet',
  'rawReview', 'reviewAmount', 'reviewDelta', 'basePay'
];

const CFG_KEYS = [
  'rate', 'fullDays', 'fullBonusPerHour', 'foundBonus', 'missedPenalty',
  'cutoff', 'payDayA', 'payDayB', 'dayHours', 'nightHours', 'defaultShift'
];

function pickStats(s) {
  const out = {};
  for (const k of STAT_KEYS) out[k] = r4(s[k]);
  out.finalized = s.finalized === true;
  out.adjustStatus = s.adjustStatus === undefined ? null : s.adjustStatus;
  return out;
}

function pickCfg(c) {
  const out = {};
  for (const k of CFG_KEYS) out[k] = typeof c[k] === 'string' ? c[k] : r4(c[k]);
  return out;
}

const pickPenalties = (list) =>
  Array.prototype.map.call(list, (d) => ({ day: d.day, reason: d.reason, amount: r4(d.amount) }));

/**
 * 拉回宿主 realm。
 * index.html 是在 vm 沙箱里跑的，它造出来的数组/对象带的是**沙箱的** Array.prototype，
 * 而 deepStrictEqual 会连原型一起比 —— 不做这一步，所有场景都会因为原型不同而全红，
 * 报错还长得像「结构相同但不相等」，非常容易误判成算法出了问题（实测踩过）。
 */
const hostify = (o) => JSON.parse(JSON.stringify(o));

/** 从跑起来的 index.html 应用实例上读。 */
function probeApp(app) {
  const s = app.monthStats.value;
  const p = app.prevStats.value;
  const cfg = app.cfg.value;
  const days = new Date(app.currentYear.value, app.currentMonth.value + 1, 0).getDate();
  const allDays = Array.from({ length: days }, (_, i) => i + 1);

  return hostify({
    cfg: pickCfg(cfg),
    cur: pickStats(s),
    prev: pickStats(p),
    prevLabel: { year: app.prevLabel.value.year, month: app.prevLabel.value.month },
    nextLabel: { year: app.nextLabel.value.year, month: app.nextLabel.value.month },
    flows: {
      thisA: r4(app.payoutThisA.value),
      thisB: r4(app.payoutThisB.value),
      nextB: r4(app.payoutNextB.value),
      earnedTotal: r4(app.earnedTotal.value),
      cashTotal: r4(app.cashTotal.value),
      carry: r4(app.earnedSplit.value.carry),
      paid: r4(app.earnedSplit.value.paid),
      floored: app.earnedFloored.value === true
    },
    penalties: pickPenalties(app.penaltyDetails.value),
    calendar: {
      days,
      cutEdge: allDays.filter((d) => app.isCutEdge(d)),
      payDayA: allDays.filter((d) => app.payDayKind(d) === 'a'),
      payDayB: allDays.filter((d) => app.payDayKind(d) === 'b'),
      penaltyFlag: allDays.filter((d) => app.hasPenalty(d))
    },
    misc: {
      fullDaysLeft: app.fullDaysLeft.value,
      payDayAPassed: app.payDayAPassed.value === true,
      isCurrentMonth: app.isCurrentMonth.value === true,
      recordCount: app.recordCount.value,
      boardInt: String(app.boardMain.value.int),
      boardFrac: String(app.boardMain.value.frac),
      boardSign: String(app.boardMain.value.sign),
      hourOptions: app.hourOptions.join(','),
      daysInMonth: app.daysInMonth.value,
      firstDayOfWeek: app.firstDayOfWeek.value
    }
  });
}

/** 只用 shared/payroll.js 算，不碰 Vue、不碰 index.html。 */
function probePure(sc, nowIso) {
  const cfg = P.normalizeSettings(sc.settings || {});
  const ctx = { records: sc.records || {}, monthAdjust: sc.adjust || {}, cfg };
  const cur = P.aggregateMonth(sc.year, sc.month, ctx);
  const prevL = P.prevMonthOf(sc.year, sc.month);
  const nextL = P.nextMonthOf(sc.year, sc.month);
  const prev = P.aggregateMonth(prevL.year, prevL.month, ctx);
  const flows = P.flowsOf({ cur, prev, cfg });
  const now = nowIso ? new Date(nowIso) : new Date();

  const days = P.daysInMonth(sc.year, sc.month);
  const allDays = Array.from({ length: days }, (_, i) => i + 1);
  const records = sc.records || {};
  const prefix = P.monthPrefix(sc.year, sc.month);
  const hasPenalty = (day) => {
    const rec = records[prefix + P.pad2(day)];
    return !!rec && rec.status === 'work' &&
      (Number(rec.contraband_missed || 0) > 0 || Number(rec.other_penalty || 0) > 0);
  };
  const parts = P.moneyParts(flows.earnedTotal);

  return {
    cfg: pickCfg(cfg),
    cur: pickStats(cur),
    prev: pickStats(prev),
    prevLabel: { year: prevL.year, month: prevL.month },
    nextLabel: { year: nextL.year, month: nextL.month },
    flows: {
      thisA: r4(flows.thisA),
      thisB: r4(flows.thisB),
      nextB: r4(flows.nextB),
      earnedTotal: r4(flows.earnedTotal),
      cashTotal: r4(flows.cashTotal),
      carry: r4(flows.carry),
      paid: r4(flows.split.paid),
      floored: flows.floored === true
    },
    penalties: pickPenalties(P.penaltyDetails(sc.year, sc.month, ctx)),
    calendar: {
      days,
      cutEdge: allDays.filter((d) => P.isCutEdge(d, cfg)),
      payDayA: allDays.filter((d) => P.payDayKind(d, cfg) === 'a'),
      payDayB: allDays.filter((d) => P.payDayKind(d, cfg) === 'b'),
      penaltyFlag: allDays.filter(hasPenalty)
    },
    misc: {
      fullDaysLeft: P.fullDaysLeft(cur, cfg),
      payDayAPassed: P.payDayAPassed(sc.year, sc.month, cfg, now) === true,
      isCurrentMonth: P.isCurrentMonth(sc.year, sc.month, now) === true,
      recordCount: Object.keys(records).length,
      boardInt: String(parts.int),
      boardFrac: String(parts.frac),
      boardSign: String(parts.sign),
      hourOptions: P.hourOptions.join(','),
      daysInMonth: days,
      firstDayOfWeek: P.firstDayOfWeek(sc.year, sc.month)
    }
  };
}

module.exports = { probeApp, probePure, r4, STAT_KEYS };
