// 薪酬口径断言 —— 期望值全部写死在这个文件里。
//
// 与 baseline.test.js 的分工，这条界线很重要：
//   baseline  = 「现在算出来的还是不是原来那个数」，它不知道什么是对的，只知道有没有变。
//   本文件    = 「这个数为什么该是这个数」，每条都能对着业务规则念出来。
// 只有 baseline 的话，一开始就算错的规则会被永久固化成「正确」。所以两者都要有。
//
// 口径来源：shared/payroll.js 顶部注释里那份用户确认过的规则，不是从代码反推的。
//   时薪 19.5 ｜ 满勤门槛 27 天 ｜ 满勤奖 1 元/工时 ｜ 查获 +10/件 ｜ 漏查 -20/件
//   上半月截止 15 日 ｜ payDayA=22 发本月上半月工时 ｜ payDayB=次月 10 号发下半月工时+满勤奖+已定稿奖惩
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../shared/payroll.js');
const { W, FINAL, DRAFT, fullMonth } = require('./lib/scenarios.js');

const CFG = P.normalizeSettings({});
const ctxOf = (records, adjust, cfg) => ({ records, monthAdjust: adjust || {}, cfg: cfg || CFG });
const agg = (records, adjust, y = 2026, m = 8, cfg) => P.aggregateMonth(y, m, ctxOf(records, adjust, cfg));

/** 本月 + 上月 + 现金流，一次算齐（跨月口径必须两头同源，见 flowsOf 注释）。 */
function flows(records, adjust, y = 2026, m = 8, cfg = CFG) {
  const ctx = ctxOf(records, adjust, cfg);
  const cur = P.aggregateMonth(y, m, ctx);
  const pl = P.prevMonthOf(y, m);
  const prev = P.aggregateMonth(pl.year, pl.month, ctx);
  return { cur, prev, f: P.flowsOf({ cur, prev, cfg }) };
}

// ───────────────────────── 默认规则值 ─────────────────────────

test('默认规则值就是用户确认的那套', () => {
  assert.equal(CFG.rate, 19.5);
  assert.equal(CFG.fullDays, 27);
  assert.equal(CFG.fullBonusPerHour, 1);
  assert.equal(CFG.foundBonus, 10);
  assert.equal(CFG.missedPenalty, 20);
  assert.equal(CFG.cutoff, 15);
  assert.equal(CFG.payDayA, 22);
  assert.equal(CFG.payDayB, 10);
  assert.equal(CFG.dayHours, 8);
  assert.equal(CFG.nightHours, 10);
  assert.equal(CFG.defaultShift, 'day');
});

test('工时可选 6–12h 步进 0.5，共 13 档', () => {
  assert.equal(P.hourOptions.length, 13);
  assert.equal(P.hourOptions[0], 6);
  assert.equal(P.hourOptions.at(-1), 12);
  assert.deepEqual(P.hourOptions, [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12]);
});

// ───────────────────────── 上下半月分段 ─────────────────────────

test('15 日算上半月、16 日算下半月（截止日本身归上半月）', () => {
  const s = agg({ '2026-09-15': W(12), '2026-09-16': W(12) });
  assert.equal(s.h1, 12);
  assert.equal(s.h2, 12);
  assert.equal(s.totalHours, 24);
  assert.equal(s.basePay, 24 * 19.5);   // 468
});

test('夜班跨天：工时整段归开始打卡那一天，不按自然日切开', () => {
  // 15 日夜班 10h 实际干到 16 日，但 10h 全进上半月
  const s = agg({ '2026-09-15': W(10, { shift_type: 'night' }) });
  assert.equal(s.h1, 10);
  assert.equal(s.h2, 0);
  assert.equal(s.nightShifts, 1);
  assert.equal(s.dayShifts, 0);
});

test('月份隔离：相邻月记录不串进来', () => {
  const s = agg({ '2026-08-05': W(12), '2026-10-05': W(12), '2026-09-05': W(8) });
  assert.equal(s.totalHours, 8);
  assert.equal(s.workDays, 1);
});

test('休息/请假不计工时也不计出勤天数', () => {
  const s = agg({
    '2026-09-03': W(8),
    '2026-09-04': { status: 'rest' },
    '2026-09-05': { status: 'leave' },
    '2026-09-06': { status: 'rest' }
  });
  assert.equal(s.totalHours, 8);
  assert.equal(s.workDays, 1);
  assert.equal(s.restDays, 2);
  assert.equal(s.leaveDays, 1);
});

// ───────────────────────── 满勤奖 ─────────────────────────

test('满勤达标：27 天 × 8h → 满勤奖 = 总工时 × 1 = 216', () => {
  const s = agg(fullMonth(27));
  assert.equal(s.workDays, 27);
  assert.equal(s.totalHours, 216);
  assert.equal(s.fullBonus, 216);
  assert.equal(s.adjustNet, 216);      // 无奖惩时 adjustNet 就是满勤奖
  assert.equal(P.fullDaysLeft(s, CFG), 0);
});

test('差 1 天不满勤：26 天 → 满勤奖归零，不按比例给', () => {
  const s = agg(fullMonth(26));
  assert.equal(s.workDays, 26);
  assert.equal(s.totalHours, 208);
  assert.equal(s.fullBonus, 0);
  assert.equal(s.adjustNet, 0);
  assert.equal(P.fullDaysLeft(s, CFG), 1);
});

test('满勤只看出勤天数，不受奖惩审核影响', () => {
  // 27 天满勤 + 查获 5 件未定稿：满勤奖照给，奖惩按 0
  const s = agg(Object.assign(fullMonth(27), { '2026-09-05': W(8, { contraband_found: 5 }) }));
  assert.equal(s.fullBonus, 216);
  assert.equal(s.rawReview, 50);       // 记录在案
  assert.equal(s.reviewNet, 0);        // 未定稿不发
  assert.equal(s.adjustNet, 216);      // 只含满勤奖
});

// ───────────────────────── 奖惩与审核定稿 ─────────────────────────

test('奖惩四项归集：查获 +10/件、漏查 -20/件、其他扣款按日填', () => {
  const s = agg({
    '2026-09-05': W(8, { contraband_found: 3 }),
    '2026-09-20': W(8, { contraband_missed: 2 }),
    '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' })
  });
  assert.equal(s.foundCount, 3);
  assert.equal(s.missedCount, 2);
  assert.equal(s.otherPenalties, 50);
  assert.equal(s.foundBonus, 30);
  assert.equal(s.missedPenalty, 40);
  assert.equal(s.rawReview, 30 - 40 - 50);   // -60
});

test('未定稿一律按 0：累计 -60 记着，但不进应得也不进发放', () => {
  const { cur, f } = flows({
    '2026-09-05': W(8, { contraband_found: 3 }),
    '2026-09-20': W(8, { contraband_missed: 2 }),
    '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' })
  });
  assert.equal(cur.rawReview, -60);
  assert.equal(cur.finalized, false);
  assert.equal(cur.reviewAmount, 0);
  assert.equal(cur.reviewDelta, 0);      // 未定稿不谈差额
  assert.equal(cur.adjustNet, 0);
  assert.equal(f.earnedTotal, 468);      // 24h × 19.5，奖惩不掺和
});

test('已定稿 -60：按审核终稿计入，差额为 0', () => {
  const recs = {
    '2026-09-05': W(8, { contraband_found: 3 }),
    '2026-09-20': W(8, { contraband_missed: 2 }),
    '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' })
  };
  const { cur, f } = flows(recs, FINAL('2026-09', -60));
  assert.equal(cur.finalized, true);
  assert.equal(cur.reviewAmount, -60);
  assert.equal(cur.reviewDelta, 0);
  assert.equal(cur.adjustNet, -60);
  assert.equal(f.earnedTotal, 468 - 60);   // 408
});

test('审核改数：累计 +30 但组长只批 +20 → 认 20，差额 -10', () => {
  const { cur } = flows({ '2026-09-05': W(8, { contraband_found: 3 }) }, FINAL('2026-09', 20));
  assert.equal(cur.rawReview, 30);
  assert.equal(cur.reviewAmount, 20);
  assert.equal(cur.reviewDelta, -10);
  assert.equal(cur.adjustNet, 20);
});

test('草稿不生效：status=draft 即使带金额也按 0', () => {
  const { cur } = flows({ '2026-09-05': W(8, { contraband_found: 3 }) }, DRAFT('2026-09', 30));
  assert.equal(cur.adjustStatus, 'draft');
  assert.equal(cur.finalized, false);
  assert.equal(cur.reviewAmount, 0);
  assert.equal(cur.adjustNet, 0);
});

test('已知怪癖钉死：final + finalAmount:null 会被当成「已定稿 ¥0」', () => {
  // Number(null)===0 且 isFinite(0) 为真 → finalized 判定命中。
  // UI 走不到（writeAdjust 会拦），只有导入脏备份碰得到。
  // 重构阶段保持原行为，改它属于业务变更，要单独提。
  const { cur } = flows({ '2026-09-05': W(8, { contraband_found: 3 }) }, FINAL('2026-09', null));
  assert.equal(cur.finalized, true);
  assert.equal(cur.reviewAmount, 0);
  assert.equal(cur.reviewDelta, -30);     // 累计 +30 被抹成 0
  assert.equal(cur.adjustNet, 0);
});

// ───────────────────────── 发薪流与地板 ─────────────────────────

test('两笔发薪：payDayA 只发本月上半月工时，payDayB 发上月下半月+上月奖惩', () => {
  const { f } = flows({
    '2026-09-03': W(8), '2026-09-14': W(8),      // 上半月 16h
    '2026-09-20': W(10), '2026-09-28': W(10)     // 下半月 20h
  });
  assert.equal(f.thisA, 16 * 19.5);              // 312
  assert.equal(f.thisB, 0);                      // 8 月没记录
  assert.equal(f.nextB, 20 * 19.5);              // 390，次月 10 号发
  assert.equal(f.earnedTotal, 36 * 19.5);        // 702 归属制
  assert.equal(f.cashTotal, f.thisA + f.thisB);  // 312 收付制
});

test('跨月结转：上月下半月工时次月才进账，上月未定稿奖惩不进', () => {
  const CROSS = {
    '2026-08-10': W(8),
    '2026-08-18': W(10), '2026-08-22': W(10),
    '2026-08-27': W(10, { contraband_found: 5, contraband_missed: 1 }),
    '2026-09-02': W(8), '2026-09-09': W(8)
  };
  const a = flows(CROSS);
  assert.equal(a.prev.h2, 30);
  assert.equal(a.prev.adjustNet, 0);                 // 8 月未定稿
  assert.equal(a.f.thisB, 30 * 19.5);                // 585
  assert.equal(a.f.cashTotal, 16 * 19.5 + 585);      // 897

  const b = flows(CROSS, FINAL('2026-08', 30));
  assert.equal(b.prev.adjustNet, 30);
  assert.equal(b.f.thisB, 585 + 30);                 // 615
  assert.equal(b.f.cashTotal, 312 + 615);            // 927
  // 9 月自己那份没变：定稿的是 8 月
  assert.equal(b.f.earnedTotal, a.f.earnedTotal);
});

test('结转 ≡ 次月实际到账（carry 与 nextB 同一个数，不留账目缺口）', () => {
  const { f } = flows(fullMonth(27));
  assert.equal(f.carry, f.nextB);
  assert.equal(f.split.carry, f.nextB);
  assert.equal(f.split.paid, f.thisA);
});

test('处罚吃穿下半月工资：到账被 ¥0 兜住，earnedTotal 允许为负并升 floored 旗', () => {
  const recs = { '2026-09-20': W(6, { contraband_missed: 10, other_penalty: 200 }) };

  const undecided = flows(recs);
  assert.equal(undecided.cur.rawReview, -400);
  assert.equal(undecided.f.nextB, 117);          // 未定稿 → 处罚不生效，6h×19.5 照发
  assert.equal(undecided.f.floored, false);

  const finalized = flows(recs, FINAL('2026-09', -400));
  assert.equal(finalized.cur.adjustNet, -400);
  assert.equal(finalized.f.nextB, 0);            // max(0, 117-400) → 地板
  assert.equal(finalized.f.floored, true);
  assert.equal(finalized.f.earnedTotal, 117 - 400);   // -283，归属制照实说
  // 地板兜住之后 paid+carry 会大于 earnedTotal，页面必须明说，别让用户自己对不上
  assert.ok(finalized.f.split.paid + finalized.f.carry > finalized.f.earnedTotal);
});

test('earnedTotal 恒等于 basePay + adjustNet（三项加总严丝合缝）', () => {
  for (const [recs, adj] of [
    [fullMonth(27), null],
    [fullMonth(27), FINAL('2026-09', 50)],
    [{ '2026-09-05': W(8, { contraband_missed: 4 }) }, FINAL('2026-09', -80)],
    [{}, null]
  ]) {
    const { cur, f } = flows(recs, adj);
    assert.equal(f.earnedTotal, cur.basePay + cur.adjustNet);
    assert.equal(cur.adjustNet, cur.fullBonus + cur.reviewNet);
  }
});

// ───────────────────────── 跨年 ─────────────────────────

test('跨年边界：2026 年 1 月的上月是 2025 年 12 月', () => {
  assert.deepEqual(P.prevMonthOf(2026, 0), { year: 2025, month: 11 });
  assert.deepEqual(P.nextMonthOf(2026, 11), { year: 2027, month: 0 });

  const recs = {
    '2025-12-20': W(10), '2025-12-28': W(10, { contraband_found: 2 }),
    '2026-01-05': W(8)
  };
  const a = flows(recs, null, 2026, 0);
  assert.equal(a.prev.h2, 20);
  assert.equal(a.f.thisB, 20 * 19.5);                      // 390
  const b = flows(recs, FINAL('2025-12', 20), 2026, 0);
  assert.equal(b.f.thisB, 390 + 20);                       // 跨年定稿也认
});

test('闰年天数与月首星期', () => {
  assert.equal(P.daysInMonth(2028, 1), 29);
  assert.equal(P.daysInMonth(2026, 1), 28);
  assert.equal(P.daysInMonth(2026, 8), 30);
  assert.equal(P.firstDayOfWeek(2026, 8), 2);   // 2026-09-01 周二
});

test('日期键拼装', () => {
  assert.equal(P.pad2(3), '03');
  assert.equal(P.pad2(30), '30');
  assert.equal(P.monthPrefix(2026, 8), '2026-09-');
  assert.equal(P.keyOf(2026, 8, 5), '2026-09-05');
  assert.equal(P.monthKeyOf(2026, 0), '2026-01');
});

// ───────────────────────── 脏数据兜底 ─────────────────────────

test('其他扣款为负时夹到 0，不能变成倒给钱', () => {
  const s = agg({ '2026-09-20': W(8, { other_penalty: -500 }) });
  assert.equal(s.otherPenalties, 0);
  assert.equal(s.rawReview, 0);
});

test('sn 兜底：空串/null 回落默认，负数回落默认，0 是有效值', () => {
  assert.equal(P.sn('', 9), 9);
  assert.equal(P.sn(null, 9), 9);
  assert.equal(P.sn(undefined, 9), 9);
  assert.equal(P.sn(-1, 9), 9);
  assert.equal(P.sn(NaN, 9), 9);
  assert.equal(P.sn(0, 9), 0);       // 关键：0 不能被当成「空」
  assert.equal(P.sn('7.5', 9), 7.5);
});

test('clampHours 夹到 6–12 并对齐 0.5 步进', () => {
  assert.equal(P.clampHours(2), 6);
  assert.equal(P.clampHours(20), 12);
  assert.equal(P.clampHours(8.3), 8.5);
  assert.equal(P.clampHours(8.2), 8);
  assert.equal(P.clampHours(NaN, 7), 7);
});

test('非法设置全部回落/夹紧，不让计算变 0 或 NaN', () => {
  const c = P.normalizeSettings({
    rate: null, fullDays: 0, fullBonusPerHour: undefined,
    cutoff: 99, foundBonus: -5, missedPenalty: NaN,
    payDayA: 0, payDayB: 99, dayHours: 2, nightHours: 20, defaultShift: 'x'
  });
  assert.equal(c.rate, 19.5);
  assert.equal(c.fullDays, 27);          // 0 天满勤没意义 → 回落
  assert.equal(c.fullBonusPerHour, 1);
  assert.equal(c.foundBonus, 10);
  assert.equal(c.missedPenalty, 20);
  assert.equal(c.cutoff, 28);            // 夹到上限
  assert.equal(c.payDayA, 1);            // 夹到下限，否则日历判定永不命中
  assert.equal(c.payDayB, 31);
  assert.equal(c.dayHours, 6);
  assert.equal(c.nightHours, 12);
  assert.equal(c.defaultShift, 'day');
});

test('越界的旧打卡记录原样参与计算，不被设置的夹紧规则改写', () => {
  // clampHours 只作用于设置里的「默认工时」，不碰已保存记录
  const s = agg({ '2026-09-05': W(14), '2026-09-06': W(4), '2026-09-07': W(8.5) });
  assert.equal(s.h1, 26.5);
  assert.equal(s.basePay, 26.5 * 19.5);
});

test('空数据不崩，全部归零', () => {
  const { cur, f } = flows({});
  assert.equal(cur.totalHours, 0);
  assert.equal(cur.workDays, 0);
  assert.equal(cur.basePay, 0);
  assert.equal(f.earnedTotal, 0);
  assert.equal(f.cashTotal, 0);
  assert.equal(f.floored, false);
});

// ───────────────────────── 自定义设置 ─────────────────────────

test('自定义设置全程生效：时薪30/满勤20天/满勤奖2/截止10日', () => {
  const cfg = P.normalizeSettings({ rate: 30, fullDays: 20, fullBonusPerHour: 2, cutoff: 10, payDayA: 25, payDayB: 5 });
  const recs = {};
  for (let d = 1; d <= 20; d++) recs[`2026-09-${String(d).padStart(2, '0')}`] = W(10);
  const { cur, f } = flows(recs, null, 2026, 8, cfg);
  assert.equal(cur.h1, 100);                 // 1–10 日
  assert.equal(cur.h2, 100);                 // 11–20 日
  assert.equal(cur.workDays, 20);
  assert.equal(cur.fullBonus, 200 * 2);      // 400
  assert.equal(cur.basePay, 200 * 30);       // 6000
  assert.equal(f.thisA, 100 * 30);           // 3000
  assert.equal(f.nextB, 100 * 30 + 400);     // 3400
  assert.equal(f.earnedTotal, 6400);
});

// ───────────────────────── 处罚明细 ─────────────────────────

test('处罚明细按日排序、原因拼接、金额<=0 不列', () => {
  const list = P.penaltyDetails(2026, 8, ctxOf({
    '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' }),
    '2026-09-08': W(8, { contraband_missed: 2 }),
    '2026-09-12': W(8, { contraband_missed: 1, other_penalty: 30 }),
    '2026-09-15': W(8),                                    // 无处罚 → 不列
    '2026-09-18': { status: 'rest', contraband_missed: 9 }  // 非上班日 → 不看
  }));
  assert.deepEqual(list, [
    { day: 8, reason: '漏查2件', amount: 40 },
    { day: 12, reason: '漏查1件·其他扣款', amount: 50 },
    { day: 25, reason: '迟到', amount: 50 }
  ]);
});

// ───────────────────────── 日历判定 ─────────────────────────

test('分界虚线正好 7 格：cutoff-6 … cutoff', () => {
  const edge = (cfg) => Array.from({ length: 31 }, (_, i) => i + 1).filter((d) => P.isCutEdge(d, cfg));
  assert.deepEqual(edge(CFG), [9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(edge(P.normalizeSettings({ cutoff: 10 })), [4, 5, 6, 7, 8, 9, 10]);
});

test('发薪日角标 a/b 各认各的日子', () => {
  assert.equal(P.payDayKind(22, CFG), 'a');
  assert.equal(P.payDayKind(10, CFG), 'b');
  assert.equal(P.payDayKind(15, CFG), null);
});

test('payDayAPassed：当月看日子，历史月一律已发，未来月一律未发', () => {
  const NOW = new Date('2026-09-20T10:00:00+08:00');   // 20 日 < payDayA 22
  assert.equal(P.payDayAPassed(2026, 8, CFG, NOW), false);   // 当月未到
  assert.equal(P.payDayAPassed(2026, 7, CFG, NOW), true);    // 8 月
  assert.equal(P.payDayAPassed(2025, 11, CFG, NOW), true);   // 去年 12 月
  assert.equal(P.payDayAPassed(2026, 9, CFG, NOW), false);   // 10 月
  assert.equal(P.payDayAPassed(2027, 0, CFG, NOW), false);   // 明年 1 月

  const LATER = new Date('2026-09-22T00:30:00+08:00');
  assert.equal(P.payDayAPassed(2026, 8, CFG, LATER), true);  // 到日子了
});

test('isCurrentMonth / isSameDay 只认传进来的 now', () => {
  const NOW = new Date('2026-09-20T10:00:00+08:00');
  assert.equal(P.isCurrentMonth(2026, 8, NOW), true);
  assert.equal(P.isCurrentMonth(2026, 7, NOW), false);
  assert.equal(P.isSameDay(2026, 8, 20, NOW), true);
  assert.equal(P.isSameDay(2026, 8, 21, NOW), false);
});

// ───────────────────────── 格式化 ─────────────────────────

test('金额格式化保留原始数据（分位不截断，不进位），null/undefined 当 0', () => {
  assert.equal(P.fmt(undefined), '0.0');
  assert.equal(P.money(null), '¥0');
  assert.equal(P.money(1234.56), '¥1234.56');
  assert.equal(P.money(2018.25), '¥2018.25');
  assert.equal(P.signed(0), '+¥0');
  assert.equal(P.signed(-5), '-¥5');
  assert.equal(P.signed(-50.25), '-¥50.25');
  assert.equal(P.signed(30), '+¥30');
});

test('moneyParts 保留原始数据小数位，千分位与小数部拆分对齐', () => {
  assert.deepEqual(P.moneyParts(99.96), { sign: '', int: '99', frac: '.96' });
  assert.deepEqual(P.moneyParts(2018.25), { sign: '', int: '2,018', frac: '.25' });
  assert.deepEqual(P.moneyParts(-1234.56), { sign: '-', int: '1,234', frac: '.56' });
  assert.deepEqual(P.moneyParts(0), { sign: '', int: '0', frac: '' });
  assert.deepEqual(P.moneyParts(1234567.8), { sign: '', int: '1,234,567', frac: '.8' });
});

test('日历格子工时拆分：只认整数与 .5', () => {
  assert.equal(P.hInt(8.5), 8);
  assert.equal(P.hFrac(8.5), '.5');
  assert.equal(P.hFrac(8), '');
  assert.equal(P.hFrac(8.25), '');    // 非 .5 不显示，避免半个槽位错位
});

// ───────────────────────── 草稿 ─────────────────────────

test('newDraft 按班次给默认工时', () => {
  assert.equal(P.newDraft('day', CFG).hours, 8);
  assert.equal(P.newDraft('night', CFG).hours, 10);
  assert.equal(P.newDraft('night', CFG).shift_type, 'night');
  assert.equal(P.newDraft('day', CFG).status, 'work');
  assert.equal(P.newDraft('day', P.normalizeSettings({ dayHours: 12 })).hours, 12);
});

test('normalizeDraft：非正扣款回落 null，非上班日清空全部奖惩', () => {
  assert.equal(P.normalizeDraft({ status: 'work', other_penalty: -5 }).other_penalty, null);
  assert.equal(P.normalizeDraft({ status: 'work', other_penalty: 0 }).other_penalty, null);
  assert.equal(P.normalizeDraft({ status: 'work', other_penalty: '30' }).other_penalty, 30);
  assert.deepEqual(
    P.normalizeDraft({ status: 'rest', contraband_found: 3, contraband_missed: 1, other_penalty: 50, penalty_reason: 'x' }),
    { status: 'rest', contraband_found: 0, contraband_missed: 0, other_penalty: null, penalty_reason: '' }
  );
});

test('normalizeDraft 是原地改（调用方持有的就是待落库那份）', () => {
  const d = { status: 'work', other_penalty: -1 };
  assert.equal(P.normalizeDraft(d), d);
  assert.equal(d.other_penalty, null);
});

// ───────────────────────── 纯度：不改入参 ─────────────────────────

test('算钱函数不改 records / monthAdjust（硬性约束 2）', () => {
  const records = {
    '2026-09-05': W(8, { contraband_found: 3 }),
    '2026-09-20': W(8, { contraband_missed: 2, other_penalty: -9 }),
    '2026-09-04': { status: 'rest' }
  };
  const adjust = FINAL('2026-09', -60);
  const settings = { rate: 21, cutoff: 12 };
  const snap = JSON.stringify({ records, adjust, settings });

  const cfg = P.normalizeSettings(settings);
  const ctx = ctxOf(records, adjust, cfg);
  P.aggregateMonth(2026, 8, ctx);
  P.aggregateMonth(2026, 7, ctx);
  P.penaltyDetails(2026, 8, ctx);
  P.flowsOf({ cur: P.aggregateMonth(2026, 8, ctx), prev: P.aggregateMonth(2026, 7, ctx), cfg });
  P.getMonthAdjust(adjust, 2026, 8);

  assert.equal(JSON.stringify({ records, adjust, settings }), snap);
});

test('normalizeSettings 返回新对象，不写回原 settings', () => {
  const settings = { rate: 30 };
  const c = P.normalizeSettings(settings);
  assert.notEqual(c, settings);
  assert.deepEqual(settings, { rate: 30 });   // 没被塞进默认值
  assert.equal(c.fullDays, 27);
});

test('normalizeSettings 不传参也能用', () => {
  assert.deepEqual(P.normalizeSettings(), P.normalizeSettings({}));
  assert.deepEqual(P.normalizeSettings(null), P.normalizeSettings({}));
});
