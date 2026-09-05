#!/usr/bin/env python3
# 一次性重构脚本：把 index.html 内联的薪酬算法换成调 shared/payroll.js。
# 每处替换都必须在原文里出现且仅出现一次，否则整个脚本不落盘 —— 宁可不改，不能改错。
import sys, io

PATH = '/root/.openclaw/workspace/work-hours-tracker/index.html'
src = io.open(PATH, encoding='utf-8').read()
orig = src

E = []  # (标签, 旧, 新)

E.append(('工时口径+cfg', '''    const HOUR_MIN = 6, HOUR_MAX = 12, HOUR_STEP = 0.5;
    const hourOptions = [];
    for (let h = HOUR_MIN; h <= HOUR_MAX + 1e-9; h += HOUR_STEP) hourOptions.push(Math.round(h * 10) / 10);

    // 整数部与小数部拆开渲染（仅用于日历格子）：小数位占固定宽度槽位，
    // 这样 8 与 8.5 的整数部左右对齐，不会形成错位。
    const hInt = (v) => Math.floor(Number(v) || 0);
    const hFrac = (v) => (Number(v) || 0) % 1 === 0.5 ? '.5' : '';

    // 仅用于归一「设置里的班次默认工时」，保证默认值落在可选范围内。
    // 不对已保存的打卡记录做任何改写。
    const clampHours = (v, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback === undefined ? DEFAULTS.dayHours : fallback;
      const snapped = Math.round(n / HOUR_STEP) * HOUR_STEP;
      return Math.min(HOUR_MAX, Math.max(HOUR_MIN, snapped));
    };

    // ===== 数值兜底：输入框清空 / 脏数据时回落默认值，不让计算变 0 或 NaN =====
    // 注意 Number(null) 与 Number('') 都等于 0，必须先判空，否则清空输入框会把时薪静默变成 0。
    const sn = (v, d) => {
      if (v === null || v === undefined || v === '') return d;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : d;
    };
    const cfg = computed(() => ({
      rate: sn(settings.rate, DEFAULTS.rate),
      fullDays: Math.round(sn(settings.fullDays, DEFAULTS.fullDays)) || DEFAULTS.fullDays,
      fullBonusPerHour: sn(settings.fullBonusPerHour, DEFAULTS.fullBonusPerHour),
      foundBonus: sn(settings.foundBonus, DEFAULTS.foundBonus),
      missedPenalty: sn(settings.missedPenalty, DEFAULTS.missedPenalty),
      cutoff: Math.min(28, Math.max(1, Math.round(sn(settings.cutoff, DEFAULTS.cutoff)))),
      // payDayA/payDayB 原本只用于文案展示，现在参与日历发薪日判定，必须进 cfg 做同样的洗值，
      // 否则 payDayKind() 拿到 undefined，比较永远不命中，角标与内描边都不会出现。
      payDayA: Math.min(31, Math.max(1, Math.round(sn(settings.payDayA, DEFAULTS.payDayA)))),
      payDayB: Math.min(31, Math.max(1, Math.round(sn(settings.payDayB, DEFAULTS.payDayB)))),
      dayHours: clampHours(sn(settings.dayHours, DEFAULTS.dayHours), DEFAULTS.dayHours),
      nightHours: clampHours(sn(settings.nightHours, DEFAULTS.nightHours), DEFAULTS.nightHours),
      defaultShift: settings.defaultShift === 'night' ? 'night' : 'day'
    }));''', '''    // hInt/hFrac 专供日历格子拆开渲染：小数位占固定宽度槽位，8 与 8.5 的整数部才能左右对齐。
    // clampHours 只归一「设置里的班次默认工时」，不改已保存的打卡记录
    //   （旧数据里 14h 这类越界值必须原样保留，用例已钉住）。
    // sn 必须先判空：Number(null) 与 Number('') 都等于 0，少这一步「清空时薪输入框」会把时薪静默变成 0。
    const { HOUR_MIN, HOUR_MAX, HOUR_STEP, hourOptions, hInt, hFrac, clampHours, sn } = P;

    // 洗过的有效配置：所有算钱逻辑只认这个值，不直接读原始 settings。
    // 包成 computed 是为了让 settings 每次改动都重洗一遍并触发下游重算。
    // payDayA/payDayB 也必须一起洗 —— 它们现在参与日历发薪日判定，
    // 拿到 undefined 时 payDayKind() 比较永不命中，角标与内描边会整个消失。
    const cfg = computed(() => P.normalizeSettings(settings));'''))

E.append(('newDraft', '''    function newDraft(shift) {
      return {
        status: 'work',
        shift_type: shift,
        hours: shift === 'night' ? cfg.value.nightHours : cfg.value.dayHours,
        contraband_found: 0,
        contraband_missed: 0,
        other_penalty: null,
        penalty_reason: ''
      };
    }''', '''    const newDraft = (shift) => P.newDraft(shift, cfg.value);'''))

E.append(('日期辅助', '''    const daysInMonth = computed(() => new Date(currentYear.value, currentMonth.value + 1, 0).getDate());
    const firstDayOfWeek = computed(() => new Date(currentYear.value, currentMonth.value, 1).getDay());
    const monthPrefix = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}-`;
    const keyOf = (y, m, d) => monthPrefix(y, m) + String(d).padStart(2, '0');
    const monthKeyOf = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
    const getMonthAdjust = (y, m) => monthAdjust.value[monthKeyOf(y, m)] || null;
    const getRecord = (day) => records.value[keyOf(currentYear.value, currentMonth.value, day)];
    const prevMonthOf = (y, m) => m === 0 ? { year: y - 1, month: 11 } : { year: y, month: m - 1 };
    const nextMonthOf = (y, m) => m === 11 ? { year: y + 1, month: 0 } : { year: y, month: m + 1 };

    const isToday = (day) => {
      const n = new Date();
      return n.getFullYear() === currentYear.value && n.getMonth() === currentMonth.value && n.getDate() === day;
    };
    const isCurrentMonth = computed(() => {
      const n = new Date();
      return n.getFullYear() === currentYear.value && n.getMonth() === currentMonth.value;
    });''', '''    const { monthPrefix, keyOf, monthKeyOf, prevMonthOf, nextMonthOf } = P;
    const daysInMonth = computed(() => P.daysInMonth(currentYear.value, currentMonth.value));
    const firstDayOfWeek = computed(() => P.firstDayOfWeek(currentYear.value, currentMonth.value));
    const getMonthAdjust = (y, m) => P.getMonthAdjust(monthAdjust.value, y, m);
    const getRecord = (day) => records.value[keyOf(currentYear.value, currentMonth.value, day)];

    // 这两个要读「今天」。模块里不允许自己取 now（否则测试基准每天都不一样），
    // 所以由调用方决定：页面上就是省略实参，让模块回落到 new Date()。
    const isToday = (day) => P.isSameDay(currentYear.value, currentMonth.value, day);
    const isCurrentMonth = computed(() => P.isCurrentMonth(currentYear.value, currentMonth.value));'''))

E.append(('格式化', '''    const fmt = (n) => (Number(n) || 0).toFixed(1);
    const money = (n) => '¥' + (Number(n) || 0).toFixed(1);
    const signed = (n) => { const v = Number(n) || 0; return (v >= 0 ? '+¥' : '-¥') + Math.abs(v).toFixed(1); };''',
'''    // moneyParts 把金额拆成 符号/整数部/小数部，供看板主数字分层渲染（大字只放整数部）。
    // 它必须从 toFixed(1) 的结果上切，不能用 Math.floor 另算，
    // 否则 99.96 会被 money() 进为 100.0、而拆分出 99.0，两处数字对不上。
    const { fmt, money, signed, moneyParts } = P;'''))

E.append(('aggregateMonth', '''    // ===== 核心聚合：本月 / 上月共用同一套口径 =====
    // 夜班跨天：工时全部归入开始打卡的那一天。
    const aggregateMonth = (year, month) => {
      const c = cfg.value;
      const prefix = monthPrefix(year, month);
      let h1 = 0, h2 = 0, workDays = 0, dayShifts = 0, nightShifts = 0, restDays = 0, leaveDays = 0;
      let foundCount = 0, missedCount = 0, otherPenalties = 0;

      for (const key in records.value) {
        if (key.indexOf(prefix) !== 0) continue;
        const rec = records.value[key];
        if (!rec) continue;
        if (rec.status === 'rest') { restDays++; continue; }
        if (rec.status === 'leave') { leaveDays++; continue; }
        if (rec.status !== 'work') continue;

        const day = Number(key.slice(prefix.length));
        const hours = Number(rec.hours || 0);
        if (day <= c.cutoff) h1 += hours; else h2 += hours;

        workDays++;
        if (rec.shift_type === 'night') nightShifts++; else dayShifts++;
        foundCount += Number(rec.contraband_found || 0);
        missedCount += Number(rec.contraband_missed || 0);
        otherPenalties += Math.max(0, Number(rec.other_penalty || 0));
      }

      const totalHours = h1 + h2;
      // 满勤奖只由出勤天数客观判定，不参与人工审核修正
      const fullBonus = workDays >= c.fullDays ? totalHours * c.fullBonusPerHour : 0;
      const foundBonus = foundCount * c.foundBonus;
      const missedPenalty = missedCount * c.missedPenalty;

      // 日常累计奖惩 = 查获 - 漏查 - 其他扣款（不含满勤奖）。
      // 这只是「记录」，不是可发金额：查获多少件当月只记账，实际奖金要等次月初组长
      // 审核提交、扣掉漏查与其他扣款后才确定。
      const rawReview = foundBonus - missedPenalty - otherPenalties;

      // 与「满勤未达标 → 满勤奖按 0 计」同一个道理：
      // 奖惩未定稿 → 一律按 0 计，不进任何应得/发放口径；只有定稿后才用审核终稿金额。
      const adj = getMonthAdjust(year, month);
      const finalized = !!(adj && adj.status === 'final' && Number.isFinite(Number(adj.finalAmount)));
      const reviewAmount = finalized ? Number(adj.finalAmount) : 0;
      const reviewDelta = finalized ? reviewAmount - rawReview : 0;
      // 计入应得的奖惩净额：未定稿恒为 0，页面单列这一项并标明「未定稿不计」。
      const reviewNet = reviewAmount;
      // 发放净额 = 满勤奖 + 已定稿奖惩。次月 payDayB 这两笔与下半月工时一起发，
      // 「挣得」与「结转」两套口径都复用它，保证同名同数。
      const adjustNet = fullBonus + reviewNet;

      return {
        h1, h2, totalHours, workDays, dayShifts, nightShifts, restDays, leaveDays,
        foundCount, missedCount, otherPenalties,
        fullBonus, foundBonus, missedPenalty, adjustNet, reviewNet,
        rawReview, reviewAmount, reviewDelta, finalized,
        adjustStatus: adj ? adj.status : null,
        adjustNote: adj && adj.note ? adj.note : '',
        finalizedAt: adj && adj.finalizedAt ? adj.finalizedAt : '',
        basePay: totalHours * c.rate
      };
    };''', '''    // ===== 核心聚合：本月 / 上月共用同一套口径 =====
    // 口径本体在 shared/payroll.js。这里只把响应式数据打包成它要的 ctx，
    // 保留同名薄包装是刻意的：模板与下面十几处调用一行都不用改。
    //
    // 口径要点（细节与用例见 payroll.js 顶部注释）：
    //   夜班跨天工时整段归开始打卡那天；满勤未达标 → 满勤奖按 0；
    //   奖惩未经组长审核定稿 → 一律按 0（同一个道理）。
    const payrollCtx = () => ({ records: records.value, monthAdjust: monthAdjust.value, cfg: cfg.value });
    const aggregateMonth = (year, month) => P.aggregateMonth(year, month, payrollCtx());'''))

E.append(('flows', '''    // 发放口径：
    // 当月 payDayA = 当月 1–cutoff 工时 × rate
    // 当月 payDayB = 上月 cutoff+1–月底 工时 × rate + 上月奖惩净额
    const payoutThisA = computed(() => Math.max(0, monthStats.value.h1 * cfg.value.rate));
    const payoutThisB = computed(() => Math.max(0, prevStats.value.h2 * cfg.value.rate + prevStats.value.adjustNet));
    const payoutNextB = computed(() => Math.max(0, monthStats.value.h2 * cfg.value.rate + monthStats.value.adjustNet));''',
'''    // 发放口径与两套记账口径一次算齐（细节见 payroll.js 的 flowsOf 注释）：
    //   当月 payDayA = 当月 1–cutoff 工时 × rate
    //   当月 payDayB = 上月 cutoff+1–月底 工时 × rate + 上月奖惩净额
    // 必须走同一个 flowsOf：结转与「次月实际到账」若各算一遍，迟早漂成两个数。
    const flows = computed(() => P.flowsOf({ cur: monthStats.value, prev: prevStats.value, cfg: cfg.value }));
    const payoutThisA = computed(() => flows.value.thisA);
    const payoutThisB = computed(() => flows.value.thisB);
    const payoutNextB = computed(() => flows.value.nextB);'''))

E.append(('earned/carry', '''    const earnedTotal = computed(() => monthStats.value.basePay + monthStats.value.adjustNet);
    const cashTotal = computed(() => payoutThisB.value + payoutThisA.value);''',
'''    const earnedTotal = computed(() => flows.value.earnedTotal);
    const cashTotal = computed(() => flows.value.cashTotal);'''))

E.append(('earnedCarry/split', '''    const earnedCarry = computed(() => payoutNextB.value);
    const earnedSplit = computed(() => ({ paid: payoutThisA.value, carry: earnedCarry.value }));''',
'''    const earnedCarry = computed(() => flows.value.carry);
    const earnedSplit = computed(() => flows.value.split);'''))

E.append(('payDayAPassed', '''    const payDayAPassed = computed(() => {
      if (!isCurrentMonth.value) {
        const n = new Date();
        return currentYear.value < n.getFullYear() ||
          (currentYear.value === n.getFullYear() && currentMonth.value < n.getMonth());
      }
      return new Date().getDate() >= cfg.value.payDayA;
    });''', '''    const payDayAPassed = computed(() => P.payDayAPassed(currentYear.value, currentMonth.value, cfg.value));'''))

E.append(('earnedFloored', '''    const earnedFloored = computed(() => monthStats.value.h2 * cfg.value.rate + monthStats.value.adjustNet < 0);''',
'''    const earnedFloored = computed(() => flows.value.floored);'''))

E.append(('penaltyDetails', '''    const penaltyDetails = computed(() => {
      const c = cfg.value;
      const prefix = monthPrefix(currentYear.value, currentMonth.value);
      const out = [];
      for (const key in records.value) {
        if (key.indexOf(prefix) !== 0) continue;
        const r = records.value[key];
        if (!r || r.status !== 'work') continue;
        const missed = Number(r.contraband_missed || 0);
        const other = Math.max(0, Number(r.other_penalty || 0));
        const amount = missed * c.missedPenalty + other;
        if (amount <= 0) continue;
        const parts = [];
        if (missed > 0) parts.push(`漏查${missed}件`);
        if (other > 0) parts.push(r.penalty_reason ? r.penalty_reason : '其他扣款');
        out.push({ day: Number(key.slice(prefix.length)), reason: parts.join('·'), amount });
      }
      return out.sort((a, b) => a.day - b.day);
    });''', '''    const penaltyDetails = computed(() => P.penaltyDetails(currentYear.value, currentMonth.value, payrollCtx()));'''))

E.append(('fullDaysLeft', '''    const fullDaysLeft = computed(() => Math.max(0, cfg.value.fullDays - monthStats.value.workDays));''',
'''    const fullDaysLeft = computed(() => P.fullDaysLeft(monthStats.value, cfg.value));'''))

E.append(('payDayKind', '''    const payDayKind = (day) => {
      const c = cfg.value;
      if (day === c.payDayA) return 'a';
      if (day === c.payDayB) return 'b';
      return null;
    };''', '''    const payDayKind = (day) => P.payDayKind(day, cfg.value);'''))

E.append(('isCutEdge', '''    const isCutEdge = (day) => {
      const c = cfg.value.cutoff;
      return day <= c && day + 7 > c;
    };''', '''    const isCutEdge = (day) => P.isCutEdge(day, cfg.value);'''))

E.append(('saveRecord 归一', '''      const op = Number(draftRecord.value.other_penalty);
      draftRecord.value.other_penalty = (Number.isFinite(op) && op > 0) ? op : null;
      if (draftRecord.value.status !== 'work') {
        draftRecord.value.contraband_found = 0;
        draftRecord.value.contraband_missed = 0;
        draftRecord.value.other_penalty = null;
        draftRecord.value.penalty_reason = '';
      }
      const dayKey''', '''      // 原地归一：非正扣款回落 null；非「上班」日清空全部奖惩字段
      P.normalizeDraft(draftRecord.value);
      const dayKey'''))

bad = []
for tag, old, new in E:
    n = src.count(old)
    if n != 1:
        bad.append(f'{tag}: 命中 {n} 次（要求恰好 1 次）')
        continue
    src = src.replace(old, new, 1)

if bad:
    print('❌ 未落盘，以下替换不唯一或找不到：')
    for b in bad:
        print('   ' + b)
    sys.exit(1)

io.open(PATH, 'w', encoding='utf-8').write(src)
print(f'✅ {len(E)} 处替换全部命中并落盘')
print(f'   {len(orig)} → {len(src)} 字节（净减 {len(orig) - len(src)}）')
