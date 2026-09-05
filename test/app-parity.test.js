// 重构护栏：index.html 里跑出来的数 == shared/payroll.js 算出来的数。
//
// 这层网的用途只有一个：**证明前端可以安全地改用纯模块**。
// 现在 index.html 还带着自己那份内联算法（grep WHTPayroll 为 0 处），
// 两份实现并存期间，本文件保证它们逐字段等价；等 index.html 真的换成调 WHTPayroll，
// 这些断言会自动变成「同一份代码比自己」，届时连同 app-harness.js 一起删掉。
//
// 失败怎么读：
//   报「app 与 pure 不一致」→ 两份实现漂了。先确认哪份是对的，别急着改基准。
//   报「index.html 里没找到内联 <script>」→ 前端结构已变，看 app-harness.js 顶部说明。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/app-harness.js');
const { probeApp, probePure } = require('./lib/probe.js');
const { SCENARIOS, NOW } = require('./lib/scenarios.js');

/** 差异摘要：deepStrictEqual 的报文很长，先把「哪几个字段不一样」摘出来放最前面。 */
function diffKeys(a, b, path = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    if (va && vb && typeof va === 'object' && typeof vb === 'object') out.push(...diffKeys(va, vb, p));
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(`${p}: app=${JSON.stringify(va)} pure=${JSON.stringify(vb)}`);
  }
  return out;
}

for (const sc of SCENARIOS) {
  test(`app==pure · ${sc.name}`, () => {
    const { app } = loadApp({
      records: sc.records, year: sc.year, month: sc.month,
      settings: sc.settings, adjust: sc.adjust, now: NOW
    });
    const fromApp = probeApp(app);
    const fromPure = probePure(sc, NOW);
    const diff = diffKeys(fromApp, fromPure);
    assert.deepStrictEqual(fromApp, fromPure, diff.length ? '字段差异：\n  ' + diff.join('\n  ') : undefined);
  });
}

test('场景库不是空的（防止 SCENARIOS 被误清后整层网静默失效）', () => {
  assert.ok(SCENARIOS.length >= 30, `场景数 ${SCENARIOS.length}，少于 30 说明用例被删了`);
  const names = SCENARIOS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, '场景名重复，基准里会互相盖掉');
});
