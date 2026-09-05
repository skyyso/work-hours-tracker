// 测试场景库 —— payroll 模块、index.html 基准、重构后对照三方共用同一批数据。
//
// 为什么单独一个文件：基准快照与重构后的实测必须喂**完全相同**的输入，
// 否则对不上时分不清是「代码变了」还是「测试数据变了」。
'use strict';

const W = (h, extra) => Object.assign({
  status: 'work', shift_type: 'day', hours: h,
  contraband_found: 0, contraband_missed: 0, other_penalty: null, penalty_reason: ''
}, extra || {});

const FINAL = (mk, amount) => ({
  [mk]: { status: 'final', finalAmount: amount, note: '', finalizedAt: '2026-10-01T09:00:00.000Z' }
});
const DRAFT = (mk, amount) => ({
  [mk]: { status: 'draft', finalAmount: amount, note: '', finalizedAt: '' }
});

/** 满勤月：1–N 日全上白班 8h */
function fullMonth(days, hours) {
  const rec = {};
  for (let d = 1; d <= days; d++) rec[`2026-09-${String(d).padStart(2, '0')}`] = W(hours === undefined ? 8 : hours);
  return rec;
}

// 冻结的「现在」：不冻结的话 payDayAPassed / isCurrentMonth / 今日高亮
// 每天跑出来都不一样，基准 JSON 根本没法比。
// 取 2026-09-20 是刻意的：已过 payDayA(22)? 没过 —— 正好覆盖「上半月待发」这一支。
const NOW = '2026-09-20T10:00:00+08:00';

/**
 * 每个场景都会被喂给三方：纯模块、重构前的 index.html、重构后的 index.html。
 * 覆盖目标：12 个薪酬 computed 的全部分支。
 */
const SCENARIOS = [
  {
    name: '基础分段·上下半月各2天无奖惩',
    records: { '2026-09-03': W(8), '2026-09-14': W(8), '2026-09-20': W(10), '2026-09-28': W(10) },
    year: 2026, month: 8
  },
  {
    name: '边界·15日算上半月/16日算下半月',
    records: { '2026-09-15': W(12), '2026-09-16': W(12) },
    year: 2026, month: 8
  },
  {
    name: '夜班跨天·15日夜班10h整段进上半月',
    records: { '2026-09-15': W(10, { shift_type: 'night' }) },
    year: 2026, month: 8
  },
  {
    name: '满勤达标·27天×8h',
    records: fullMonth(27),
    year: 2026, month: 8
  },
  {
    name: '差1天不满勤·26天×8h',
    records: fullMonth(26),
    year: 2026, month: 8
  },
  {
    name: '奖惩四项归集·未定稿只记录',
    records: {
      '2026-09-05': W(8, { contraband_found: 3 }),
      '2026-09-20': W(8, { contraband_missed: 2 }),
      '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' })
    },
    year: 2026, month: 8
  },
  {
    name: '奖惩已定稿-60',
    records: {
      '2026-09-05': W(8, { contraband_found: 3 }),
      '2026-09-20': W(8, { contraband_missed: 2 }),
      '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' })
    },
    year: 2026, month: 8, adjust: FINAL('2026-09', -60)
  },
  {
    name: '草稿不生效·draft+30',
    records: { '2026-09-05': W(8, { contraband_found: 3 }) },
    year: 2026, month: 8, adjust: DRAFT('2026-09', 30)
  },
  {
    name: '审核改数·累计+30只认+20',
    records: { '2026-09-05': W(8, { contraband_found: 3 }) },
    year: 2026, month: 8, adjust: FINAL('2026-09', 20)
  },
  {
    name: '跨月结转·8月未定稿',
    records: {
      '2026-08-10': W(8),
      '2026-08-18': W(10), '2026-08-22': W(10),
      '2026-08-27': W(10, { contraband_found: 5, contraband_missed: 1 }),
      '2026-09-02': W(8), '2026-09-09': W(8)
    },
    year: 2026, month: 8
  },
  {
    name: '跨月结转·8月已定稿+30',
    records: {
      '2026-08-10': W(8),
      '2026-08-18': W(10), '2026-08-22': W(10),
      '2026-08-27': W(10, { contraband_found: 5, contraband_missed: 1 }),
      '2026-09-02': W(8), '2026-09-09': W(8)
    },
    year: 2026, month: 8, adjust: FINAL('2026-08', 30)
  },
  {
    name: '跨年边界·2026年1月取2025年12月',
    records: {
      '2025-12-20': W(10), '2025-12-28': W(10, { contraband_found: 2 }),
      '2026-01-05': W(8)
    },
    year: 2026, month: 0
  },
  {
    name: '跨年边界·2025-12已定稿+20',
    records: {
      '2025-12-20': W(10), '2025-12-28': W(10, { contraband_found: 2 }),
      '2026-01-05': W(8)
    },
    year: 2026, month: 0, adjust: FINAL('2025-12', 20)
  },
  {
    name: '处罚超过下半月工资·未定稿',
    records: { '2026-09-20': W(6, { contraband_missed: 10, other_penalty: 200 }) },
    year: 2026, month: 8
  },
  {
    name: '处罚超过下半月工资·定稿-400触发地板0',
    records: { '2026-09-20': W(6, { contraband_missed: 10, other_penalty: 200 }) },
    year: 2026, month: 8, adjust: FINAL('2026-09', -400)
  },
  {
    name: '休息请假不计工时',
    records: {
      '2026-09-03': W(8),
      '2026-09-04': { status: 'rest' },
      '2026-09-05': { status: 'leave' },
      '2026-09-06': { status: 'rest' }
    },
    year: 2026, month: 8
  },
  {
    name: '脏数据·其他扣款负数夹为0',
    records: { '2026-09-20': W(8, { other_penalty: -500 }) },
    year: 2026, month: 8
  },
  {
    name: '月份隔离·不串月',
    records: { '2026-08-05': W(12), '2026-10-05': W(12), '2026-09-05': W(8) },
    year: 2026, month: 8
  },
  {
    name: '自定义设置·时薪30/满勤20/单价2/截止10/发薪25与5',
    records: (() => {
      const rec = {};
      for (let d = 1; d <= 20; d++) rec[`2026-09-${String(d).padStart(2, '0')}`] = W(10);
      return rec;
    })(),
    year: 2026, month: 8,
    settings: { rate: 30, fullDays: 20, fullBonusPerHour: 2, cutoff: 10, payDayA: 25, payDayB: 5 }
  },
  {
    name: '非法设置全部回落默认',
    records: { '2026-09-05': W(8) },
    year: 2026, month: 8,
    settings: { rate: null, fullDays: 0, fullBonusPerHour: undefined, cutoff: 99, foundBonus: -5, missedPenalty: NaN }
  },
  {
    name: '处罚明细排序与原因',
    records: {
      '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' }),
      '2026-09-08': W(8, { contraband_missed: 2 }),
      '2026-09-12': W(8, { contraband_missed: 1, other_penalty: 30 }),
      '2026-09-15': W(8)
    },
    year: 2026, month: 8
  },
  {
    name: '空数据不崩',
    records: {},
    year: 2026, month: 8
  },
  {
    name: '越界旧值原样保留·14h与4h',
    records: { '2026-09-05': W(14), '2026-09-06': W(4), '2026-09-07': W(8.5) },
    year: 2026, month: 8
  },
  {
    name: '用户实测场景·3天22h含查获1件未定稿',
    records: { '2026-09-01': W(8), '2026-09-02': W(8), '2026-09-03': W(6, { contraband_found: 1 }) },
    year: 2026, month: 8
  },
  {
    name: '用户实测场景·同上已定稿+10',
    records: { '2026-09-01': W(8), '2026-09-02': W(8), '2026-09-03': W(6, { contraband_found: 1 }) },
    year: 2026, month: 8, adjust: FINAL('2026-09', 10)
  },
  {
    name: '满勤+查获5件未定稿·满勤计奖惩不计',
    records: Object.assign(fullMonth(27), { '2026-09-05': W(8, { contraband_found: 5 }) }),
    year: 2026, month: 8
  },
  {
    name: '满勤+查获5件已定稿+50·两项全计',
    records: Object.assign(fullMonth(27), { '2026-09-05': W(8, { contraband_found: 5 }) }),
    year: 2026, month: 8, adjust: FINAL('2026-09', 50)
  },
  {
    name: '历史月份·看8月（payDayA 已过）',
    records: { '2026-08-05': W(8), '2026-08-20': W(10) },
    year: 2026, month: 7
  },
  {
    name: '未来月份·看10月（payDayA 未过）',
    records: { '2026-10-05': W(8), '2026-10-20': W(10) },
    year: 2026, month: 9
  },
  {
    name: '班次默认工时越界·白班2h夜班20h',
    records: {},
    year: 2026, month: 8,
    settings: { dayHours: 2, nightHours: 20 }
  }
];

module.exports = { W, FINAL, DRAFT, fullMonth, SCENARIOS, NOW };
