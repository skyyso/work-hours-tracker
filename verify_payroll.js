// 工时薪酬助手 —— 核心算法验证
// 做法：mock 极简 Vue（ref/reactive/computed/watch/onMounted）+ localStorage，
// 直接执行 index.html 里真实的 setup()，断言其返回的计算结果。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, 'index.html');
const PAYROLL = path.join(__dirname, 'shared', 'payroll.js');
const src = fs.readFileSync(HTML, 'utf-8');
const code = src.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/)[1];

// ---------- 极简 Vue 桩件 ----------
function ref(v) { return { value: v }; }
function reactive(o) { return o; }          // 测试只需可读写对象，不需要真响应式
function computed(fn) { return { get value() { return fn(); } }; }
function watch() { /* 持久化副作用与算法无关，空实现 */ }
function onMounted(fn) { onMounted._q.push(fn); }
onMounted._q = [];

let captured = null;
const Vue = {
  createApp(opts) { captured = opts.setup(); return { mount() { return captured; } }; },
  ref, reactive, computed, watch, onMounted
};

// ---------- 环境桩件 ----------
function makeStore(records, settings, adjust) {
  const data = { work_records: JSON.stringify(records) };
  if (settings) data.work_settings = JSON.stringify(settings);
  if (adjust) data.work_month_adjust = JSON.stringify(adjust);
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    _dump: () => JSON.parse(data.work_records),
    _settings: () => data.work_settings ? JSON.parse(data.work_settings) : null
  };
}

// adjust：月度奖惩终稿，key 'YYYY-MM' → { status, finalAmount, note }
// 传入即模拟「组长审核已定稿」，不传即「未定稿，只算记录」。
function load(records, year, month, settings, adjust) {
  onMounted._q = [];
  const localStorage = makeStore(records, settings, adjust);
  const sandbox = {
    Vue, localStorage, console, Date, JSON, Math, Number, RegExp,
    navigator: {},
    document: {
      createElement: () => ({ style: {}, select() {}, click() {} }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {}
    },
    confirm: () => true,
    setTimeout: () => 0,
    Blob: function () {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    // 云端同步是可选增强：桩件刻意不提供 window.WHTSync，
    // 于是测试跑的就是「未登录/纯离线」路径，顺带验证同步缺席时算法完全不受影响。
    location: { origin: 'http://test' },
    window: { addEventListener() {} },
    fetch: () => Promise.reject(new Error('offline in test'))
  };
  vm.createContext(sandbox);
  // 必须先注入薪酬纯模块：index.html 的 setup() 现在直接读 WHTPayroll（2026-09-05 重构）。
  // 少了这一步会命中 BOOT_DEPS 缺失分支，去摸 document.getElementById 然后炸在沙箱里 ——
  // 报错长得像 DOM 问题，实际是依赖没注入，别被带跑（实测踩过）。
  vm.runInContext(fs.readFileSync(PAYROLL, 'utf-8'), sandbox, { filename: 'shared/payroll.js' });
  vm.runInContext(code, sandbox);
  onMounted._q.forEach(f => f());          // 触发 records / settings 载入
  captured.currentYear.value = year;
  captured.currentMonth.value = month;
  return { app: captured, localStorage };
}

// ---------- 断言工具 ----------
let pass = 0, fail = 0;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.05;
function eq(label, got, want) {
  if (near(got, want)) { pass++; console.log(`  ✅ ${label} = ${Number(got).toFixed(1)}`); }
  else { fail++; console.log(`  ❌ ${label}：实得 ${got}，应为 ${want}`); }
}
function ok(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? '：' + detail : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }

const W = (h, extra = {}) => Object.assign({
  status: 'work', shift_type: 'day', hours: h,
  contraband_found: 0, contraband_missed: 0, other_penalty: null, penalty_reason: ''
}, extra);

const RATE = 19.5, FULL_DAYS = 27, FOUND = 10, MISSED = 20;
// 定稿快捷构造：FINAL('2026-09', -60) 表示 9 月奖惩已由组长审核定稿为 -60
const FINAL = (monthKey, amount) => ({ [monthKey]: { status: 'final', finalAmount: amount, note: '', finalizedAt: '2026-10-01T09:00:00.000Z' } });
const DRAFT = (monthKey, amount) => ({ [monthKey]: { status: 'draft', finalAmount: amount, note: '', finalizedAt: '' } });

// ==========================================================
section('用例1：基础分段 —— 上半月 2 天、下半月 2 天，无奖惩');
{
  const rec = {
    '2026-09-03': W(8), '2026-09-14': W(8),   // 上半月 16h
    '2026-09-20': W(10), '2026-09-28': W(10)  // 下半月 20h
  };
  const { app } = load(rec, 2026, 8); // month=8 → 9月
  const s = app.monthStats.value;
  eq('上半月工时 h1', s.h1, 16);
  eq('下半月工时 h2', s.h2, 20);
  eq('总工时', s.totalHours, 36);
  eq('出勤天数', s.workDays, 4);
  eq('工时收入 basePay', s.basePay, 36 * RATE);
  eq('发放净额（无奖惩无满勤）', s.adjustNet, 0);
  eq('9月22日到账 = 上半月×19.5', app.payoutThisA.value, 16 * RATE);
  eq('10月10日预估 = 下半月×19.5', app.payoutNextB.value, 20 * RATE);
}

section('用例2：15日/16日边界 —— 15日必须算上半月');
{
  const rec = { '2026-09-15': W(12), '2026-09-16': W(12) };
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  eq('15日 → h1', s.h1, 12);
  eq('16日 → h2', s.h2, 12);
}

section('用例3：夜班跨天归开始日 —— 15日夜班10h 整段进上半月');
{
  const rec = { '2026-09-15': W(10, { shift_type: 'night' }) };
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  eq('夜班10h 全归 h1', s.h1, 10);
  eq('h2 不沾', s.h2, 0);
  eq('夜班班次计数', s.nightShifts, 1);
  eq('22日到账含该夜班', app.payoutThisA.value, 10 * RATE);
}

section('用例4：时薪恒定 19.5 —— 满勤不再抬高当月时薪');
{
  const rec = {};
  for (let d = 1; d <= 27; d++) rec[`2026-09-${String(d).padStart(2, '0')}`] = W(8);
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  const H = 27 * 8;
  eq('出勤天数', s.workDays, 27);
  eq('总工时', s.totalHours, H);
  eq('工时收入按 19.5 计（非 20.5）', s.basePay, H * RATE);
  eq('满勤奖 = 总工时 × 1，挂账', s.fullBonus, H);
  eq('发放净额 = 满勤奖（奖惩未定稿为0）', s.adjustNet, H);
  eq('22日到账不含满勤奖', app.payoutThisA.value, 120 * RATE);          // 1–15 共 15 天 ×8
  eq('下月10日 = 下半月工时 + 满勤奖', app.payoutNextB.value, 96 * RATE + H); // 16–27 共 12 天 ×8
}

section('用例5：差1天不满勤 —— 满勤奖必须为 0');
{
  const rec = {};
  for (let d = 1; d <= 26; d++) rec[`2026-09-${String(d).padStart(2, '0')}`] = W(8);
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  eq('出勤天数', s.workDays, 26);
  eq('满勤奖 = 0', s.fullBonus, 0);
  eq('发放净额 = 0', s.adjustNet, 0);
}

section('用例6：奖惩四项归集 —— 未定稿只作记录，一律不计入金额');
{
  const rec = {
    '2026-09-05': W(8, { contraband_found: 3 }),                        // +30
    '2026-09-20': W(8, { contraband_missed: 2 }),                       // -40
    '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' })   // -50
  };
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  eq('查获件数', s.foundCount, 3);
  eq('查获奖励', s.foundBonus, 30);
  eq('漏查件数', s.missedCount, 2);
  eq('漏查处罚', s.missedPenalty, 40);
  eq('其他扣款', s.otherPenalties, 50);
  eq('满勤奖（3天不满勤）', s.fullBonus, 0);
  // 与「满勤未达标 → 满勤奖按 0」同一个道理：奖惩未经组长审核定稿 → 一律按 0
  eq('日常累计（仅记录）= 30-40-50', s.rawReview, -60);
  eq('未定稿奖惩不计入', s.reviewNet, 0);
  eq('发放净额 = 0', s.adjustNet, 0);
  eq('工时收入不受奖惩影响', s.basePay, 24 * RATE);
  eq('22日到账为纯工时（8h）', app.payoutThisA.value, 8 * RATE);
}

section('用例6b：同一份记录 —— 组长定稿 -60 后才计入');
{
  const rec = {
    '2026-09-05': W(8, { contraband_found: 3 }),
    '2026-09-20': W(8, { contraband_missed: 2 }),
    '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' })
  };
  const { app } = load(rec, 2026, 8, null, FINAL('2026-09', -60));
  const s = app.monthStats.value;
  ok('已定稿标记为真', s.finalized === true);
  eq('日常累计不变', s.rawReview, -60);
  eq('定稿后奖惩计入 = -60', s.reviewNet, -60);
  eq('与累计一致 → 差额 0', s.reviewDelta, 0);
  eq('挣得含定稿奖惩', app.earnedTotal.value, 24 * RATE - 60);
}

section('用例6c：草稿不生效 —— 只有 final 才算定稿');
{
  const rec = { '2026-09-05': W(8, { contraband_found: 3 }) };
  const { app } = load(rec, 2026, 8, null, DRAFT('2026-09', 30));
  const s = app.monthStats.value;
  ok('草稿状态 finalized 为假', s.finalized === false);
  ok('adjustStatus 记为 draft', s.adjustStatus === 'draft', String(s.adjustStatus));
  eq('草稿金额不计入', s.reviewNet, 0);
  eq('挣得只含工时', app.earnedTotal.value, 8 * RATE);
}

section('用例6d：审核改数 —— 累计 +30，只认 20');
{
  const rec = { '2026-09-05': W(8, { contraband_found: 3 }) };   // 累计 +30
  const { app } = load(rec, 2026, 8, null, FINAL('2026-09', 20));
  const s = app.monthStats.value;
  eq('累计 +30', s.rawReview, 30);
  eq('终稿只认 +20', s.reviewNet, 20);
  eq('差额下调 10', s.reviewDelta, -10);
  eq('挣得按终稿', app.earnedTotal.value, 8 * RATE + 20);
}

section('用例7：跨月结转 —— 9月10日 = 8月下半月 +（已定稿的）8月奖惩');
{
  const rec = {
    // 8月：上半月 8h，下半月 30h，查获5件(+50)，漏查1件(-20)
    '2026-08-10': W(8),
    '2026-08-18': W(10), '2026-08-22': W(10), '2026-08-27': W(10, { contraband_found: 5, contraband_missed: 1 }),
    // 9月：上半月 16h
    '2026-09-02': W(8), '2026-09-09': W(8)
  };
  // 未定稿：8月奖惩只作记录，9月10日那笔只发下半月工时
  {
    const { app } = load(rec, 2026, 8);
    const p = app.prevStats.value;
    eq('8月下半月工时', p.h2, 30);
    eq('8月日常累计（仅记录）= 50-20', p.rawReview, 30);
    eq('8月未定稿 → 发放净额 0', p.adjustNet, 0);
    eq('9月10日（未定稿）= 30×19.5', app.payoutThisB.value, 30 * RATE);
    eq('9月22日 = 16×19.5', app.payoutThisA.value, 16 * RATE);
  }
  // 已定稿 +30：9月10日那笔才带上奖惩
  {
    const { app } = load(rec, 2026, 8, null, FINAL('2026-08', 30));
    const p = app.prevStats.value;
    eq('8月定稿后发放净额 = 30', p.adjustNet, 30);
    eq('9月10日 = 30×19.5 + 30', app.payoutThisB.value, 30 * RATE + 30);
    eq('9月现金流合计', app.payoutThisB.value + app.payoutThisA.value, 30 * RATE + 30 + 16 * RATE);
  }
}

section('用例8：跨年边界 —— 1月10日应取上一年12月');
{
  const rec = {
    '2025-12-20': W(10), '2025-12-28': W(10, { contraband_found: 2 }), // 下半月20h，+20
    '2026-01-05': W(8)
  };
  const { app } = load(rec, 2026, 0); // 2026年1月
  eq('上月标签年份 = 2025', app.prevLabel.value.year, 2025);
  eq('上月标签月份 index = 11', app.prevLabel.value.month, 11);
  eq('下月标签年份 = 2026', app.nextLabel.value.year, 2026);
  eq('下月标签月份 index = 1', app.nextLabel.value.month, 1);
  eq('1月10日（12月奖惩未定稿）= 20×19.5', app.payoutThisB.value, 20 * RATE);
  // 跨年 key 必须是 '2025-12'，定稿后才带上 +20
  const f = load(rec, 2026, 0, null, FINAL('2025-12', 20));
  eq('12月定稿后 1月10日 = 20×19.5 + 20', f.app.payoutThisB.value, 20 * RATE + 20);
}

section('用例9：changeMonth 跨年翻页 + 回今天');
{
  const { app } = load({}, 2026, 0);
  app.changeMonth(-1);
  eq('1月往前 → 年份 2025', app.currentYear.value, 2025);
  eq('1月往前 → 月份 index 11', app.currentMonth.value, 11);
  app.changeMonth(1);
  eq('12月往后 → 年份 2026', app.currentYear.value, 2026);
  eq('12月往后 → 月份 index 0', app.currentMonth.value, 0);
  app.goToday();
  const n = new Date();
  eq('回今天 → 年份', app.currentYear.value, n.getFullYear());
  eq('回今天 → 月份', app.currentMonth.value, n.getMonth());
  ok('回今天后 isCurrentMonth 为真', app.isCurrentMonth.value === true);
}

section('用例10：处罚超过下半月工资 —— 定稿后发放兜底 0，累计保留负数');
{
  const rec = {
    '2026-09-20': W(6, { contraband_missed: 10, other_penalty: 200 }) // 下半月6h=117元；罚 200+200=400
  };
  // 未定稿：处罚也只是记录，不能提前吃掉工时收入
  {
    const { app } = load(rec, 2026, 8);
    eq('日常累计保留真实负数', app.monthStats.value.rawReview, -400);
    eq('未定稿不扣发放', app.monthStats.value.adjustNet, 0);
    eq('下月10日 = 下半月工时', app.payoutNextB.value, 6 * RATE);
  }
  // 定稿 -400：才真正扣，且兜底 0
  {
    const { app } = load(rec, 2026, 8, null, FINAL('2026-09', -400));
    eq('定稿后发放净额 = -400', app.monthStats.value.adjustNet, -400);
    eq('下月10日发放兜底为 0', app.payoutNextB.value, 0);
  }
}

section('用例11：休息/请假不计入工时与出勤，但单独计数');
{
  const rec = {
    '2026-09-03': W(8),
    '2026-09-04': { status: 'rest' },
    '2026-09-05': { status: 'leave' },
    '2026-09-06': { status: 'rest' }
  };
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  eq('出勤天数只算 work', s.workDays, 1);
  eq('总工时只算 work', s.totalHours, 8);
  eq('休息天数', s.restDays, 2);
  eq('请假天数', s.leaveDays, 1);
}

section('用例12：其他扣款负数被夹为 0（脏数据防御）');
{
  const rec = { '2026-09-20': W(8, { other_penalty: -500 }) };
  const { app } = load(rec, 2026, 8);
  eq('负数扣款不变成奖励', app.monthStats.value.otherPenalties, 0);
  eq('奖惩净额 = 0', app.monthStats.value.adjustNet, 0);
}

section('用例13：saveRecord —— 非正扣款归一为 null；非上班清空奖惩');
{
  const { app, localStorage } = load({}, 2026, 8);
  app.selectedDay.value = 20;
  app.draftRecord.value = W(8, { other_penalty: -30 });
  app.saveRecord();
  ok('负扣款落库为 null', localStorage._dump()['2026-09-20'].other_penalty === null);

  app.draftRecord.value = W(8, { other_penalty: 60 });
  app.saveRecord();
  eq('正扣款正常落库', localStorage._dump()['2026-09-20'].other_penalty, 60);

  app.selectedDay.value = 21;
  app.draftRecord.value = W(8, { status: 'rest', contraband_found: 5, contraband_missed: 3, other_penalty: 99 });
  app.saveRecord();
  const r = localStorage._dump()['2026-09-21'];
  ok('休息日清空查获', r.contraband_found === 0);
  ok('休息日清空漏查', r.contraband_missed === 0);
  ok('休息日清空扣款', r.other_penalty === null);

  app.selectedDay.value = 20;
  app.deleteRecord();
  ok('deleteRecord 移除该日', localStorage._dump()['2026-09-20'] === undefined);
}

section('用例14：月份隔离 —— 只聚合本月，不串月');
{
  const rec = { '2026-08-05': W(12), '2026-10-05': W(12), '2026-09-05': W(8) };
  const { app } = load(rec, 2026, 8);
  eq('9月总工时不含8/10月', app.monthStats.value.totalHours, 8);
}

section('用例15：旧版记录兼容 —— 字段结构未变，直接可读');
{
  const legacy = {
    '2026-09-08': { status: 'work', shift_type: 'night', hours: 10, contraband_found: 1, contraband_missed: 0, other_penalty: null, penalty_reason: '' }
  };
  const { app } = load(legacy, 2026, 8);
  const s = app.monthStats.value;
  eq('旧记录工时可读', s.totalHours, 10);
  eq('旧记录查获奖励可读', s.foundBonus, FOUND);
  eq('旧记录归上半月', s.h1, 10);
}

section('用例16：设置可改写规则 —— 时薪/满勤/单价/截止日');
{
  const rec = {};
  for (let d = 1; d <= 20; d++) rec[`2026-09-${String(d).padStart(2, '0')}`] = W(10);
  // 自定义：时薪 30、满勤 20 天、满勤奖 2 元/h、截止日 10、发放日 25/5
  const custom = { rate: 30, fullDays: 20, fullBonusPerHour: 2, cutoff: 10, payDayA: 25, payDayB: 5 };
  const { app } = load(rec, 2026, 8, custom);
  const s = app.monthStats.value;
  eq('自定义截止日 → 上半月 10 天', s.h1, 100);
  eq('自定义截止日 → 下半月 10 天', s.h2, 100);
  eq('自定义时薪生效', s.basePay, 200 * 30);
  eq('自定义满勤门槛达成 → 满勤奖 = 200h × 2', s.fullBonus, 400);
  eq('25号到账 = 100h × 30', app.payoutThisA.value, 100 * 30);
  eq('次月5号 = 100h × 30 + 400', app.payoutNextB.value, 100 * 30 + 400);
}

section('用例17：设置为空/非法时回落默认，不产生 NaN');
{
  const rec = { '2026-09-05': W(8) };
  const bad = { rate: null, fullDays: 0, fullBonusPerHour: undefined, cutoff: 99, foundBonus: -5, missedPenalty: NaN };
  const { app } = load(rec, 2026, 8, bad);
  const c = app.cfg.value;
  eq('时薪回落 19.5', c.rate, RATE);
  eq('满勤天数回落 27', c.fullDays, FULL_DAYS);
  eq('满勤单价回落 1', c.fullBonusPerHour, 1);
  eq('截止日夹到 28', c.cutoff, 28);
  eq('查获单价回落 10', c.foundBonus, FOUND);
  eq('漏查单价回落 20', c.missedPenalty, MISSED);
  ok('basePay 不是 NaN', Number.isFinite(app.monthStats.value.basePay), String(app.monthStats.value.basePay));
  ok('adjustNet 不是 NaN', Number.isFinite(app.monthStats.value.adjustNet));
}

section('用例18：处罚明细列表 —— 按日排序并含原因');
{
  const rec = {
    '2026-09-25': W(8, { other_penalty: 50, penalty_reason: '迟到' }),
    '2026-09-08': W(8, { contraband_missed: 2 }),
    '2026-09-12': W(8, { contraband_missed: 1, other_penalty: 30 }),
    '2026-09-15': W(8)  // 无处罚，不应出现
  };
  const { app } = load(rec, 2026, 8);
  const d = app.penaltyDetails.value;
  eq('明细条数', d.length, 3);
  eq('首条按日排序 = 8日', d[0].day, 8);
  eq('8日金额 = 2×20', d[0].amount, 40);
  ok('8日原因含漏查', d[0].reason.indexOf('漏查2件') >= 0, d[0].reason);
  eq('12日金额 = 20+30', d[1].amount, 50);
  eq('25日金额 = 50', d[2].amount, 50);
  ok('25日原因取备注', d[2].reason.indexOf('迟到') >= 0, d[2].reason);
}

section('用例19：日历格子样式 —— 状态底色与半月分界虚线');
{
  const rec = {
    '2026-09-05': W(8),
    '2026-09-12': W(10, { shift_type: 'night' }),
    '2026-09-20': W(8, { contraband_missed: 1 }),
    '2026-09-06': { status: 'rest' },
    '2026-09-07': { status: 'leave' }
  };
  const { app } = load(rec, 2026, 8);
  const j = (day) => app.cellClass(day).join(' ');
  // 白班走暖橙、夜班走靛蓝，班次一眼可辨
  ok('白班日暖橙底', j(5).indexOf('bg-amber-50/70') >= 0, j(5));
  ok('夜班日靛蓝底', j(12).indexOf('bg-indigo-50/70') >= 0, j(12));
  ok('休息日灰底', j(6).indexOf('bg-slate-100/70') >= 0);
  ok('请假日晨光蓝底', j(7).indexOf('bg-sky-50/60') >= 0);
  ok('未记录日白底', j(28).indexOf('bg-white') >= 0);
  // 分界虚线：7 列网格里 cutoff-6 … cutoff 这一整周加底虚线（默认 cutoff=15 → 9–15 日）
  ok('9 日属分界行', app.isCutEdge(9) === true);
  ok('15 日（cutoff）属分界行', app.isCutEdge(15) === true);
  ok('8 日不属分界行', app.isCutEdge(8) === false);
  ok('16 日（下半月）不属分界行', app.isCutEdge(16) === false);
  ok('分界格带 cut-edge 类', j(15).indexOf('cut-edge') >= 0, j(15));
  ok('非分界格不带 cut-edge 类', j(5).indexOf('cut-edge') < 0, j(5));
  ok('分界行刚好 7 格', [...Array(31).keys()].map(i => i + 1).filter(d => app.isCutEdge(d)).length === 7);
  ok('20日有处罚标记', app.hasPenalty(20) === true);
  ok('5日无处罚标记', app.hasPenalty(5) === false);
}

section('用例20：页签与文本报告');
{
  const rec = { '2026-09-05': W(8), '2026-09-20': W(10, { contraband_found: 1 }) };
  const { app } = load(rec, 2026, 8);
  eq('默认落在打卡页', app.tab.value === 'calendar' ? 1 : 0, 1);
  eq('页签数量 = 3', app.tabs.length, 3);
  ok('页签顺序为 打卡/汇总/设置', app.tabs.map(t => t.id).join(',') === 'calendar,summary,settings', app.tabs.map(t => t.id).join(','));
  const rpt = app.buildReport();
  ok('报告含时薪 19.5', rpt.indexOf('19.5') >= 0);
  ok('报告含奖惩结算说明', rpt.indexOf('次月10号结算') >= 0);
  ok('报告含两笔到账', rpt.indexOf('9月22日') >= 0 && rpt.indexOf('9月10日') >= 0);
  ok('报告含次月预估', rpt.indexOf('10月10日预估') >= 0);
  eq('记录计数', app.recordCount.value, 2);
}

section('用例21：导入 —— 合并记录并跳过非法键');
{
  const { app } = load({ '2026-09-01': W(8) }, 2026, 8);
  const n = app.applyImport({
    records: {
      '2026-09-02': W(10),
      '2026-09-03': W(6),
      'not-a-date': W(99),
      'settings': W(99)
    },
    settings: { rate: 25 }
  });
  eq('导入计数只算合法日期', n, 2);
  eq('导入后记录总数', app.recordCount.value, 3);
  eq('导入携带的设置生效', app.cfg.value.rate, 25);
  eq('导入后 9月总工时 = 8+10+6', app.monthStats.value.totalHours, 24);
}

section('用例22：清空 —— 按月清与全清');
{
  const rec = { '2026-08-05': W(8), '2026-09-05': W(8), '2026-09-20': W(8) };
  const { app, localStorage } = load(rec, 2026, 8);
  app.clearMonth();
  eq('清空9月后剩余记录数', app.recordCount.value, 1);
  ok('8月记录仍在', localStorage._dump()['2026-08-05'] !== undefined);
  app.clearAll();
  eq('全清后记录数', app.recordCount.value, 0);
}

section('用例23：resetSettings 恢复默认');
{
  const { app } = load({}, 2026, 8, { rate: 99, fullDays: 5, cutoff: 3 });
  eq('自定义时薪已加载', app.cfg.value.rate, 99);
  app.resetSettings();
  eq('恢复后时薪', app.cfg.value.rate, RATE);
  eq('恢复后满勤天数', app.cfg.value.fullDays, FULL_DAYS);
  eq('恢复后截止日', app.cfg.value.cutoff, 15);
}

section('用例24：班次默认工时可配置');
{
  const { app } = load({}, 2026, 8, { dayHours: 7.5, nightHours: 11.5 });
  app.openDayDrawer(10);
  eq('新建默认取白班工时', app.draftRecord.value.hours, 7.5);
  app.selectShift('night');
  eq('切夜班取夜班工时', app.draftRecord.value.hours, 11.5);
  app.selectShift('day');
  eq('切回白班', app.draftRecord.value.hours, 7.5);
}

section('用例25：空数据不崩');
{
  const { app } = load({}, 2026, 8);
  const s = app.monthStats.value;
  eq('总工时 0', s.totalHours, 0);
  eq('工时收入 0', s.basePay, 0);
  eq('奖惩净额 0', s.adjustNet, 0);
  eq('本月10日 0', app.payoutThisB.value, 0);
  eq('本月22日 0', app.payoutThisA.value, 0);
  eq('次月10日 0', app.payoutNextB.value, 0);
  eq('处罚明细为空', app.penaltyDetails.value.length, 0);
}

section('用例26：结算工时选项 6–12 / 0.5 步进，共 13 项');
{
  const { app } = load({}, 2026, 8);
  eq('选项个数', app.hourOptions.length, 13);
  eq('首项 = 6', app.hourOptions[0], 6);
  eq('末项 = 12', app.hourOptions[12], 12);
  ok('完整序列 6,6.5,...,12',
     app.hourOptions.join(',') === '6,6.5,7,7.5,8,8.5,9,9.5,10,10.5,11,11.5,12',
     app.hourOptions.join(','));
  ok('无浮点误差（全部为 .0 或 .5）',
     app.hourOptions.every(h => h * 2 === Math.round(h * 2)),
     app.hourOptions.join(','));
}

section('用例27：hInt / hFrac 对齐拆分（日历格子整数与 .5 不错位）');
{
  const { app } = load({}, 2026, 8);
  eq('8 的整数部', app.hInt(8), 8);
  ok('8 的小数部为空', app.hFrac(8) === '', JSON.stringify(app.hFrac(8)));
  eq('8.5 的整数部', app.hInt(8.5), 8);
  ok('8.5 的小数部为 .5', app.hFrac(8.5) === '.5', app.hFrac(8.5));
  eq('12 的整数部', app.hInt(12), 12);
  ok('12 的小数部为空', app.hFrac(12) === '');
  ok('拼回原值 6', app.hInt(6) + app.hFrac(6) === '6', app.hInt(6) + app.hFrac(6));
  ok('拼回原值 11.5', app.hInt(11.5) + app.hFrac(11.5) === '11.5', app.hInt(11.5) + app.hFrac(11.5));
  ok('每个选项拆分后都能拼回原值',
     app.hourOptions.every(h => Number(app.hInt(h) + (app.hFrac(h) || '')) === h));
}

section('用例28：已保存记录不被静默篡改（包括越界旧值）');
{
  const rec = {
    '2026-09-05': W(14),   // 旧数据，超出 6–12
    '2026-09-06': W(4),
    '2026-09-07': W(8.5)
  };
  const { app, localStorage } = load(rec, 2026, 8);
  eq('聚合按原值（14+4+8.5）', app.monthStats.value.totalHours, 26.5);
  app.openDayDrawer(5);
  eq('打开编辑器也不改旧值', app.draftRecord.value.hours, 14);
  app.openDayDrawer(7);
  eq('合法 8.5 不变', app.draftRecord.value.hours, 8.5);
  app.selectedDay.value = 20;
  app.draftRecord.value = W(8.5);
  app.saveRecord();
  eq('选单保存 8.5 原值落库', localStorage._dump()['2026-09-20'].hours, 8.5);
}

section('用例29：班次默认工时落入 6–12 可选范围');
{
  const { app } = load({}, 2026, 8, { dayHours: 2, nightHours: 20 });
  eq('白班 2h 夹到 6', app.cfg.value.dayHours, 6);
  eq('夜班 20h 夹到 12', app.cfg.value.nightHours, 12);
  app.openDayDrawer(10);
  eq('新建取夹后白班值', app.draftRecord.value.hours, 6);
  app.selectShift('night');
  eq('切夜班取夹后值', app.draftRecord.value.hours, 12);
  ok('两个默认值都在选项里',
     app.hourOptions.indexOf(app.cfg.value.dayHours) >= 0 && app.hourOptions.indexOf(app.cfg.value.nightHours) >= 0);
}

// ==========================================================
section('用例30：统一口径 —— 挣得 = 工时 + 满勤奖(达标才计) + 奖惩净额');
{
  // 用户核对场景：9月 3天22h（8+8+6），其中1天查获1件
  const rec = {
    '2026-09-01': W(8),
    '2026-09-02': W(8),
    '2026-09-03': W(6, { contraband_found: 1 })
  };
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  eq('总工时', s.totalHours, 22);
  eq('工时收入 basePay', s.basePay, 22 * RATE);                 // 429
  eq('满勤奖未达27天不计', s.fullBonus, 0);
  // 与满勤同一个道理：查获 1 件只是记录，未经组长审核定稿前不计入金额
  eq('日常累计（仅记录）= +10', s.rawReview, FOUND);
  eq('未定稿不计入应得', s.reviewNet, 0);
  // 决策1：打卡页大字 == 汇总页合计应得 == 429 + 0 + 0 = 429
  eq('统一挣得 earnedTotal（未定稿不计）', app.earnedTotal.value, 22 * RATE);
  eq('打卡页大字与之同源', Number(String(app.boardMain.value.int).replace(/,/g, '')), 429);
  eq('距满勤天数', app.fullDaysLeft.value, FULL_DAYS - 3);
  // 决策2：结转 == 次月10号实际到账（含满勤奖，此处满勤为0）
  eq('结转 = payoutNextB', app.earnedSplit.value.carry, app.payoutNextB.value);
  eq('结转值（下半月0h、奖惩未定稿）', app.earnedSplit.value.carry, 0);
}

section('用例30b：同一场景 —— 组长定稿 +10 后才变 439');
{
  const rec = {
    '2026-09-01': W(8),
    '2026-09-02': W(8),
    '2026-09-03': W(6, { contraband_found: 1 })
  };
  const { app } = load(rec, 2026, 8, null, FINAL('2026-09', FOUND));
  const s = app.monthStats.value;
  eq('定稿后奖惩计入 = +10', s.reviewNet, FOUND);
  eq('挣得 = 429 + 0 + 10', app.earnedTotal.value, 22 * RATE + FOUND);
  eq('打卡页大字 = 439', Number(String(app.boardMain.value.int).replace(/,/g, '')), 439);
  eq('结转 = payoutNextB', app.earnedSplit.value.carry, app.payoutNextB.value);
  eq('结转值（下半月0h + 奖惩10）', app.earnedSplit.value.carry, FOUND);
  eq('三项相加 = 大字', s.basePay + s.fullBonus + s.reviewNet, app.earnedTotal.value);
}

section('用例31：满勤达标 —— 满勤奖同时进「挣得」与「结转」，两处不再打架');
{
  const rec = {};
  for (let d = 1; d <= 27; d++) rec[`2026-09-${String(d).padStart(2, '0')}`] = W(8);
  const { app } = load(rec, 2026, 8);
  const s = app.monthStats.value;
  const H = 27 * 8;                       // 216h
  eq('出勤天数达标', s.workDays, 27);
  eq('满勤奖 = 总工时×1', s.fullBonus, H);
  eq('挣得 = 工时 + 满勤奖', app.earnedTotal.value, H * RATE + H);
  eq('打卡页大字同值', Number(String(app.boardMain.value.int).replace(/,/g, '')), Math.floor(H * RATE + H));
  eq('距满勤 0 天', app.fullDaysLeft.value, 0);
  // 结转必须含满勤奖，且与次月实际到账严格相等
  eq('结转 = payoutNextB', app.earnedSplit.value.carry, app.payoutNextB.value);
  eq('结转 = 下半月工时 + 满勤奖', app.earnedSplit.value.carry, 96 * RATE + H);  // 16–27 共12天×8=96h
  // 三项相加严丝合缝等于大字
  eq('工时+满勤+奖惩 = 挣得', s.basePay + s.fullBonus + s.reviewNet, app.earnedTotal.value);
}

section('用例32：漏查处罚 —— 未定稿不扣，定稿后才扣');
{
  const rec = {
    '2026-09-10': W(8, { contraband_found: 2 }),      // +20
    '2026-09-20': W(8, { contraband_missed: 3 }),     // -60
    '2026-09-21': W(8, { other_penalty: 15 })         // -15
  };
  {
    const { app } = load(rec, 2026, 8);
    const s = app.monthStats.value;
    eq('日常累计 = 20-60-15', s.rawReview, 20 - 60 - 15);
    eq('未定稿不计入', s.reviewNet, 0);
    eq('挣得只含工时', app.earnedTotal.value, 24 * RATE);
    eq('结转 = payoutNextB', app.earnedSplit.value.carry, app.payoutNextB.value);
  }
  {
    const { app } = load(rec, 2026, 8, null, FINAL('2026-09', -55));
    const s = app.monthStats.value;
    eq('定稿后计入 = -55', s.reviewNet, -55);
    eq('挣得含负奖惩', app.earnedTotal.value, 24 * RATE + (20 - 60 - 15));
    eq('结转 = payoutNextB', app.earnedSplit.value.carry, app.payoutNextB.value);
  }
}

section('用例33：奖惩与满勤同口径 —— 未定稿一律不进任何金额口径');
{
  // 27 天满勤 + 查获 5 件（未定稿）：满勤奖计，奖惩不计
  const rec = {};
  for (let d = 1; d <= 27; d++) rec[`2026-09-${String(d).padStart(2, '0')}`] = W(8);
  rec['2026-09-05'] = W(8, { contraband_found: 5 });
  const H = 27 * 8;
  {
    const { app } = load(rec, 2026, 8);
    const s = app.monthStats.value;
    eq('满勤达标 → 满勤奖计入', s.fullBonus, H);
    eq('查获累计 +50 仅记录', s.rawReview, 50);
    eq('未定稿 → 奖惩不计', s.reviewNet, 0);
    eq('挣得 = 工时 + 满勤', app.earnedTotal.value, H * RATE + H);
    eq('三项相加 = 大字', s.basePay + s.fullBonus + s.reviewNet, app.earnedTotal.value);
    // 未定稿时尾行合计只剩满勤奖
    eq('计入应得合计 = 仅满勤奖', s.adjustNet, H);
  }
  {
    const { app } = load(rec, 2026, 8, null, FINAL('2026-09', 50));
    const s = app.monthStats.value;
    eq('定稿后三项全计', app.earnedTotal.value, H * RATE + H + 50);
    eq('三项相加仍等大字', s.basePay + s.fullBonus + s.reviewNet, app.earnedTotal.value);
    // 奖惩卡尾行「计入应得合计」= 满勤奖 + 奖惩净额，也就是 adjustNet
    eq('计入应得合计 = 满勤 + 奖惩', s.adjustNet, s.fullBonus + s.reviewNet);
    eq('计入应得合计值', s.adjustNet, H + 50);
    eq('结转 = payoutNextB', app.earnedSplit.value.carry, app.payoutNextB.value);
    eq('结转 = 下半月工时 + 满勤 + 奖惩', app.earnedSplit.value.carry, 96 * RATE + H + 50);
  }
}

// ==========================================================
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);