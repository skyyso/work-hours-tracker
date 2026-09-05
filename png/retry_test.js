// 实测自动重试：用请求拦截模拟「Vue 前 N 次取不到」，看页面能否自己恢复。
//
// 场景对应真实故障：服务端日志里失败的请求压根没有记录，说明请求没到服务器（链路丢包）。
// 这里用 request.abort() 复现同一效果 —— 浏览器侧看到的就是「拿不到这个文件」。
const puppeteer = require('/root/.openclaw/workspace/web_tasks/node_modules/puppeteer');
const fs = require('fs');

const URL = 'http://127.0.0.1:9522/';
const VUE = 'vue.global.prod.js';

async function run(label, failTimes, expect) {
  const profile = `/tmp/wht-retry-${failTimes}`;
  fs.rmSync(profile, { recursive: true, force: true });
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });

  let blocked = 0, served = 0;
  await page.setRequestInterception(true);
  page.on('request', r => {
    if (r.url().includes(VUE)) {
      if (blocked < failTimes) { blocked++; return r.abort('failed'); }
      served++;
    }
    r.continue();
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 自动重试有 800ms 递增退避 + reload，留足时间
  await new Promise(r => setTimeout(r, 6000));

  const s = await page.evaluate(() => {
    const card = document.getElementById('boot-fail');
    return {
      vue: typeof Vue !== 'undefined',
      cardShown: card ? !card.hidden : false,
      title: document.getElementById('boot-title')?.textContent || null,
      detail: document.getElementById('boot-detail')?.textContent || null,
      btnHidden: document.getElementById('boot-retry')?.hidden ?? null,
      mounted: !!document.querySelector('#app')?.innerText?.trim().length,
      retryCount: sessionStorage.getItem('wht_boot_retry')
    };
  });

  const pass = expect(s);
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${label}`);
  console.log(`  拦截 ${blocked} 次 / 放行 ${served} 次`);
  console.log(`  Vue=${s.vue} 已挂载=${s.mounted} 卡片显示=${s.cardShown} 重试计数=${s.retryCount}`);
  if (s.cardShown) console.log(`  标题="${s.title}"\n  详情="${s.detail}"`);

  await page.screenshot({
    path: `/root/.openclaw/workspace/work-hours-tracker/png/retry_fail${failTimes}.png`
  });
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
  return pass;
}

(async () => {
  const results = [];
  // 0 次失败：正常路径，卡片不该出现
  results.push(await run('正常加载（不拦截）', 0, s => s.vue && s.mounted && !s.cardShown));
  // 1 次失败：应自动重试成功，用户看不到失败卡
  results.push(await run('丢包 1 次 → 自动恢复', 1, s => s.vue && s.mounted && !s.cardShown));
  // 999 次失败：自动重试全败，应显示卡片且按钮可点
  results.push(await run('持续丢包 → 显示卡片且不刷新循环', 999,
    s => !s.vue && s.cardShown && s.title === '页面没能加载完成' && s.btnHidden === false));

  console.log('\n' + '='.repeat(46));
  console.log(results.every(Boolean) ? `全部通过（${results.length}/${results.length}）` : '有失败项');
  console.log('='.repeat(46));
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
