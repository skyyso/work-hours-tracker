// 一次性核查：重构后页面上的关键交互元素还在不在。
// 起因：png/gear_test.js 与 png/tab_settings_test.js 报「no gear btn」「navBtnCount:0」，
// 需要分清是重构改坏了 DOM，还是那两个脚本本身找错了选择器。
const puppeteer = require('/root/.openclaw/workspace/web_tasks/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('http://127.0.0.1:9522/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));

  const probe = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => Array.from(document.querySelectorAll(s));
    const navBtns = all('nav button, footer button, .fixed.bottom-0 button');
    return {
      mounted: !!q('#app') && q('#app').innerText.trim().length > 0,
      hasWHTPayroll: typeof window.WHTPayroll !== 'undefined',
      payrollKeys: typeof window.WHTPayroll !== 'undefined' ? Object.keys(window.WHTPayroll).length : 0,
      gearByTitle: !!q('button[title="设置"]'),
      navBtnCount: navBtns.length,
      navLabels: navBtns.map(b => (b.innerText || '').trim()).filter(Boolean),
      // 日历格子数与首格偏移：验证 daysInMonth / firstDayOfWeek 接线正确
      dayCells: all('#app [class*="aspect"]').length,
      // 大字看板：验证 boardMain / moneyParts 接线
      board: (q('#app') ? q('#app').innerText : '').split('\n').slice(0, 8),
      cutEdge: all('.cut-edge').length,
      payRingA: all('.pay-ring-a').length,
      payRingB: all('.pay-ring-b').length
    };
  });

  console.log(JSON.stringify(probe, null, 2));
  console.log('\n控制台错误：', errs.length ? errs : '（无）');

  // 点一下汇总 Tab，再点设置 Tab，看是否真的切得动
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const find = (t) => btns.find(b => (b.innerText || '').trim() === t);
    const out = {};
    for (const t of ['汇总', '设置', '打卡']) out[t] = !!find(t);
    const s = find('设置');
    if (s) s.click();
    return out;
  });
  await new Promise(r => setTimeout(r, 600));
  const afterSettings = await page.evaluate(() => {
    const app = document.querySelector('#app');
    const txt = app ? app.innerText : '';
    return { showsRateField: txt.includes('基础时薪'), showsFullDays: txt.includes('满勤') };
  });
  console.log('\nTab 按钮存在性：', clicked);
  console.log('点设置后：', afterSettings);

  await page.screenshot({ path: '/root/.openclaw/workspace/work-hours-tracker/png/postrefactor_settings.png' });
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
