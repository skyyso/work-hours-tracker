// 无头实测缓存策略：全新浏览器首访 → 二次刷新，分别记录实际发出的网络请求。
// 关注三件事：
//   1. 全新浏览器（无 localStorage）能否正常起 Vue，页面里有几条记录
//   2. 第二次刷新时 vendor/ 是否真的不再走网络
//   3. index.html 是否命中 304
const puppeteer = require('/root/.openclaw/workspace/web_tasks/node_modules/puppeteer');
const fs = require('fs');

const URL = 'http://127.0.0.1:9522/';
const PROFILE = '/tmp/wht-cache-test-profile';

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    userDataDir: PROFILE,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=390,844']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });

  const log = [];
  page.on('response', r => {
    const u = r.url().replace(URL, '/');
    log.push({ u, status: r.status(), fromCache: r.fromCache(), cc: r.headers()['cache-control'] || '-' });
  });

  const dump = tag => {
    console.log(`\n===== ${tag} =====`);
    for (const r of log) {
      console.log(
        `${String(r.status).padEnd(4)} ${r.fromCache ? 'CACHE ' : 'NET   '} ${r.u.slice(0, 60).padEnd(62)} ${r.cc}`
      );
    }
    log.length = 0;
  };

  // ---- 第一次：全新浏览器，零 localStorage ----
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  dump('首访（全新浏览器）');

  const s1 = await page.evaluate(() => ({
    vue: typeof Vue !== 'undefined',
    bootFailVisible: !document.getElementById('boot-fail')?.hidden,
    appExists: !!document.getElementById('app'),
    // 页面真的渲染出内容了才算挂载成功
    mounted: !!document.querySelector('#app')?.innerText?.trim().length,
    localRecords: Object.keys(JSON.parse(localStorage.getItem('work_records') || '{}')).length,
    hasToken: !!localStorage.getItem('work_sync_token'),
    headline: document.querySelector('#app')?.innerText?.split('\n').filter(Boolean).slice(0, 6)
  }));
  console.log('\n首访页面状态:', JSON.stringify(s1, null, 2));
  await page.screenshot({ path: '/root/.openclaw/workspace/work-hours-tracker/png/newbrowser_first.png' });

  // ---- 第二次：普通刷新（不清缓存），看还剩多少字节要走网络 ----
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  dump('二次刷新（同一浏览器）');

  const s2 = await page.evaluate(() => typeof Vue !== 'undefined');
  console.log('\n二次刷新 Vue 可用:', s2);

  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
