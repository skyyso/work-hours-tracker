// 专门验刷新循环的防线。
//
// 模拟最刁的一种故障：fetch 能拿到完整文件（所以重试判定为"成功"），
// 但 <script src> 始终起不来（插件拦截、CSP、解析失败都可能这样）。
// 这时每次 reload 都会重新触发一次"成功→reload"，若没有计数器就是无限刷新，
// 用户连导出备份都点不到。
//
// 用 resourceType 区分：script 全部 abort，fetch 全部放行。
const puppeteer = require('/root/.openclaw/workspace/web_tasks/node_modules/puppeteer');
const fs = require('fs');

const URL = 'http://127.0.0.1:9522/';
const VUE = 'vue.global.prod.js';
const PROFILE = '/tmp/wht-loop-guard';

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    userDataDir: PROFILE,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });

  let scriptBlocked = 0, fetchAllowed = 0, docLoads = 0;
  await page.setRequestInterception(true);
  page.on('request', r => {
    const isVue = r.url().includes(VUE);
    if (isVue && r.resourceType() === 'script') { scriptBlocked++; return r.abort('failed'); }
    if (isVue) fetchAllowed++;
    if (r.resourceType() === 'document') docLoads++;
    r.continue();
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 12000));   // 留足时间，若会循环这里必然刷很多次

  const s = await page.evaluate(() => ({
    cardShown: !document.getElementById('boot-fail')?.hidden,
    title: document.getElementById('boot-title')?.textContent,
    detail: document.getElementById('boot-detail')?.textContent,
    btnUsable: document.getElementById('boot-retry')?.hidden === false,
    retryCount: sessionStorage.getItem('wht_boot_retry')
  }));

  // 文档加载次数 = 1 次首访 + 最多 MAX_AUTO(2) 次 reload
  const capped = docLoads <= 3;
  const settled = s.cardShown && s.btnUsable;
  const pass = capped && settled;

  console.log(`[${pass ? 'PASS' : 'FAIL'}] 刷新循环防线`);
  console.log(`  文档加载 ${docLoads} 次（上限应为 3 = 首访 + 2 次自动 reload）`);
  console.log(`  script 被拦 ${scriptBlocked} 次 / fetch 放行 ${fetchAllowed} 次`);
  console.log(`  重试计数=${s.retryCount}  卡片显示=${s.cardShown}  按钮可点=${s.btnUsable}`);
  console.log(`  标题="${s.title}"`);
  console.log(`  详情="${s.detail}"`);

  await page.screenshot({ path: '/root/.openclaw/workspace/work-hours-tracker/png/retry_loopguard.png' });
  await browser.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
