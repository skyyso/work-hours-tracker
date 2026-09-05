// 基准对照：把 30 个场景的全部薪酬输出与冻结快照逐字段比。
//
// 与 payroll.test.js 的分工：
//   payroll.test.js  写死期望值，说明「为什么该是这个数」——防的是规则本身算错。
//   本文件           不判断对错，只判断有没有变——防的是重构悄悄改了数。
// 快照由 tools/gen-baseline.js 生成，默认只校验、写要带 --write（历史上它默认写，
// 等于 `node --test` 一跑就把网重新描一遍，算错也全绿；那个坑已经堵上了）。
//
// 红了怎么办：先看差在哪个字段，确认是「有意的业务变更」还是「重构漏了」。
// 前者才允许 node tools/gen-baseline.js --write，且要能逐条说清每处差异。
// 「测试红了就重新生成基准」= 把安全网剪断。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./lib/app-harness.js');
const { probeApp, probePure } = require('./lib/probe.js');
const { SCENARIOS, NOW } = require('./lib/scenarios.js');

const BASELINE = path.join(__dirname, 'baseline', 'payroll-baseline.json');

test('基准文件存在且能解析', () => {
  assert.ok(fs.existsSync(BASELINE), `缺基准文件 ${BASELINE}，先跑 node tools/gen-baseline.js --write`);
  const raw = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  assert.equal(raw.frozenNow, NOW, '基准的冻结时刻与 scenarios.js 的 NOW 不一致，两边不可比');
  assert.equal(raw.cases.length, raw.scenarioCount);
  assert.ok(raw.cases.length > 0);
});

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const byName = new Map(baseline.cases.map((c) => [c.name, c.probe]));

test('基准场景集与 scenarios.js 完全对应（防止悄悄少测）', () => {
  const now = SCENARIOS.map((s) => s.name).sort();
  const old = baseline.cases.map((c) => c.name).sort();
  assert.deepEqual(now, old, '场景增删后必须显式重写基准：node tools/gen-baseline.js --write');
});

for (const sc of SCENARIOS) {
  test(`基准 · ${sc.name}`, () => {
    const want = byName.get(sc.name);
    assert.ok(want, `基准里没有场景「${sc.name}」`);

    // index.html 现跑值 vs 冻结值
    const { app } = loadApp({
      records: sc.records, year: sc.year, month: sc.month,
      settings: sc.settings, adjust: sc.adjust, now: NOW
    });
    assert.deepStrictEqual(probeApp(app), want, 'index.html 的输出与基准不一致');

    // 纯模块现算值 vs 同一份冻结值。
    // 这一条是为「index.html 拆掉之后」准备的：那天上面那句会失效，
    // 而只要这句还在，payroll.js 被误改一样会被抓住。
    assert.deepStrictEqual(probePure(sc, NOW), want, 'shared/payroll.js 的输出与基准不一致');
  });
}
