// 生成/校验基准快照：把**当前** index.html 的薪酬输出固化成 JSON。
//
// 这是整张测试网的锚点。重构（抽模块、上 Vite、拆 SFC）之后再跑一遍对照，
// 任何一个数字变了都会被 test/app-parity.test.js 抓出来。
//
//   node tools/gen-baseline.js           # 只校验，不写（默认，安全）
//   node tools/gen-baseline.js --check   # 同上，显式写法
//   node tools/gen-baseline.js --write   # 真的重写基准（需要明确意图）
//
// ⚠️ 为什么这个文件不能放在 test/ 目录里：
//   Node 的 test runner 在不给路径时会按 `**/test/**/*.?(c|m)js` 收集文件，
//   于是 `test/gen-baseline.js` 会被当成一个测试文件**直接执行**（实测确认）。
//   它当年的默认行为是「写基准」，等于 `node --test` 一跑就把安全网重新描一遍——
//   哪怕代码算错了钱，基准也会被改成错的然后「测试全绿」。
//   双重保险：① 挪出 test/，runner 收集不到；② 默认只校验，写要带 --write。
//
// 什么时候才允许重写基准：业务规则真的变了，而且你能逐条说清每个差异为什么该变。
// 「重构后测试红了就重新生成基准」等于把安全网剪断，那还不如没有。
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp } = require('../test/lib/app-harness.js');
const { probeApp } = require('../test/lib/probe.js');
const { SCENARIOS, NOW } = require('../test/lib/scenarios.js');

const OUT_DIR = path.join(__dirname, '..', 'test', 'baseline');
const OUT = path.join(OUT_DIR, 'payroll-baseline.json');

function build() {
  const cases = SCENARIOS.map((sc) => {
    const { app } = loadApp({
      records: sc.records, year: sc.year, month: sc.month,
      settings: sc.settings, adjust: sc.adjust, now: NOW
    });
    return { name: sc.name, probe: probeApp(app) };
  });
  return { frozenNow: NOW, scenarioCount: cases.length, cases };
}

const write = process.argv.includes('--write');
const data = build();
const json = JSON.stringify(data, null, 2) + '\n';

if (!write) {
  if (!fs.existsSync(OUT)) {
    console.error('基准文件不存在：' + OUT + '\n首次生成请跑 node tools/gen-baseline.js --write');
    process.exit(1);
  }
  const old = fs.readFileSync(OUT, 'utf8');
  if (old === json) {
    console.log(`基准一致，${data.scenarioCount} 个场景无差异`);
    process.exit(0);
  }
  console.error('基准与当前 index.html 输出不一致。跑 npm test 看具体差在哪。');
  console.error('确认每处差异都该变之后，再 node tools/gen-baseline.js --write');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, json);
console.log(`已写入基准：${OUT}`);
console.log(`  场景数 ${data.scenarioCount}`);
console.log(`  冻结时刻 ${data.frozenNow}`);
