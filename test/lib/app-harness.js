// 在 Node 里跑 index.html 内联的那坨 setup()，拿到它返回的全部 computed。
//
// 这个文件是**唯一**焊在 index.html 结构上的东西：它靠正则抠出内联 <script>，
// 一旦前端拆成 SFC 就会立刻失效。这是刻意的——它的职责只剩「重构前后行为一致」对照，
// 前端拆完那天连同 app-parity 测试一起删掉，而 shared/payroll.js 上的那套断言不受影响。
//
// 与 verify_payroll.js 里那份内联桩件的区别：
//   1. Date 可冻结 → payDayAPassed / isCurrentMonth / cellClass 这些吃「今天」的输出变成确定值，
//      否则基准 JSON 每天跑出来都不一样，根本没法当基准。
//   2. 会把 shared/payroll.js 先注入沙箱，让重构后的 index.html 找得到 WHTPayroll。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const HTML = path.join(ROOT, 'index.html');
const PAYROLL = path.join(ROOT, 'shared', 'payroll.js');

/** 冻结「现在」：无参 new Date() 与 Date.now() 都回到固定时刻，带参构造照常。 */
function frozenDate(iso) {
  const FIXED = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(FIXED);
      else super(...args);
    }
    static now() { return FIXED; }
  };
}

/** 极简 Vue 桩件：测试只需要能读写与求值，不需要真响应式。 */
function makeVue() {
  const mounted = [];
  const Vue = {
    ref: (v) => ({ value: v }),
    reactive: (o) => o,
    computed: (fn) => ({ get value() { return fn(); } }),
    watch: () => {},
    onMounted: (fn) => mounted.push(fn),
    createApp(opts) {
      Vue._captured = opts.setup();
      return { mount: () => Vue._captured };
    }
  };
  return { Vue, mounted };
}

function makeStore(seed) {
  const data = { ...seed };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
    _raw: () => data,
    _records: () => JSON.parse(data.work_records || '{}'),
    _settings: () => (data.work_settings ? JSON.parse(data.work_settings) : null),
    _adjust: () => (data.work_month_adjust ? JSON.parse(data.work_month_adjust) : null)
  };
}

/**
 * 载入应用。
 * @param {object} o
 * @param {object} o.records   打卡记录，key 'YYYY-MM-DD'
 * @param {number} o.year      当前查看年
 * @param {number} o.month     当前查看月（0–11）
 * @param {object} [o.settings] 覆盖设置，null/undefined 表示用默认
 * @param {object} [o.adjust]  月度奖惩终稿，key 'YYYY-MM'
 * @param {string} [o.now]     冻结的「现在」（ISO）
 */
function loadApp({ records = {}, year, month, settings = null, adjust = null, now = null }) {
  const seed = { work_records: JSON.stringify(records) };
  if (settings) seed.work_settings = JSON.stringify(settings);
  if (adjust) seed.work_month_adjust = JSON.stringify(adjust);

  const localStorage = makeStore(seed);
  const { Vue, mounted } = makeVue();
  const DateImpl = now ? frozenDate(now) : Date;

  const sandbox = {
    Vue, localStorage, console,
    Date: DateImpl, JSON, Math, Number, RegExp, Object, Array, String, Boolean, Error,
    navigator: {},
    document: {
      createElement: () => ({ style: {}, select() {}, click() {} }),
      body: { appendChild() {}, removeChild() {} },
      getElementById: () => null,
      addEventListener() {}
    },
    confirm: () => true,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    Blob: function () {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    // 刻意不提供 window.WHTSync：测试跑「未登录/纯离线」路径，
    // 顺带验证同步缺席时算钱逻辑完全不受影响。
    location: { origin: 'http://test' },
    fetch: () => Promise.reject(new Error('offline in test'))
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // 先注入纯模块：重构后的 index.html 依赖它。重构前注入也无害（没人引用）。
  if (fs.existsSync(PAYROLL)) {
    vm.runInContext(fs.readFileSync(PAYROLL, 'utf8'), sandbox, { filename: 'shared/payroll.js' });
  }

  const src = fs.readFileSync(HTML, 'utf8');
  const m = src.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  if (!m) throw new Error('index.html 里没找到应用内联 <script>，harness 需要更新');
  vm.runInContext(m[1], sandbox, { filename: 'index.html#app' });

  mounted.forEach((fn) => fn());          // 触发 records / settings / adjust 载入
  const app = Vue._captured;
  app.currentYear.value = year;
  app.currentMonth.value = month;
  return { app, localStorage, sandbox };
}

module.exports = { loadApp, frozenDate, ROOT };
