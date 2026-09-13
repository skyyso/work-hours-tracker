// PWA 验证：SW 注册、预缓存、离线启动、可安装性要素，一次跑完。
// 跑法：node png/verify_pwa.js （真实 Chromium，验证后不清理产物，截图留证据）
const puppeteer = require('/root/.openclaw/workspace/web_tasks/node_modules/puppeteer');

const URL_BASE = 'https://daka.kory.kdns.fr';
const PROFILE = '/tmp/wht-pwa-verify';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    userDataDir: PROFILE,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });

  const results = [];
  const ok = (name, cond, detail = '') => {
    results.push(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  // ---- 1. 首次在线加载 + SW 注册 ----
  await page.goto(URL_BASE + '/', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3500)); // 给 SW install 留时间

  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    let precacheCount = 0;
    for (const k of keys) {
      if (k.startsWith('wht-precache')) {
        const c = await caches.open(k);
        precacheCount = (await c.keys()).length;
      }
    }
    return {
      supported: true,
      script: reg.active ? reg.active.scriptURL : null,
      scope: reg.scope,
      controlled: !!navigator.serviceWorker.controller,
      cacheKeys: keys,
      precacheCount
    };
  });
  ok('SW 支持（安全上下文）', swState.supported === true);
  ok('SW 注册成功', !!swState.script, swState.script || '');
  ok('SW 作用域 = /', swState.scope === URL_BASE + '/', swState.scope || '');
  ok('页面已被 SW 控制', swState.controlled === true);
  ok('预缓存条目=11', swState.precacheCount === 11, '实际 ' + swState.precacheCount);

  // ---- 2. manifest 可解析 ----
  const manifest = await page.evaluate(async () => {
    const res = await fetch('/manifest.webmanifest');
    const j = await res.json();
    return { ok: res.ok, name: j.name, icons: (j.icons || []).length, display: j.display };
  });
  ok('manifest 200 且可解析', manifest.ok === true && manifest.icons >= 4, JSON.stringify(manifest));

  // ---- 3. 离线重启：骨架必须能起来 ----
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 3500));

  const offline = await page.evaluate(() => ({
    vue: typeof globalThis.Vue !== 'undefined',
    payroll: typeof globalThis.WHTPayroll !== 'undefined',
    bootHealVisible: (() => {
      const el = document.getElementById('boot-heal');
      return !!el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
    })(),
    appText: (document.querySelector('#app') || document.body).innerText.slice(0, 60)
  }));
  ok('离线：Vue 可用', offline.vue === true);
  ok('离线：薪酬模块可用', offline.payroll === true);
  ok('离线：无 boot 恢复卡', offline.bootHealVisible === false);
  ok('离线：页面有实际内容', offline.appText.trim().length > 20, JSON.stringify(offline.appText.slice(0, 40)));

  await page.screenshot({ path: '/root/.openclaw/workspace/work-hours-tracker/png/pwa_offline_boot.png' });

  // ---- 4. 恢复在线，确认导航回源 ----
  await page.setOfflineMode(false);
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  const backOnline = await page.evaluate(() => typeof globalThis.Vue !== 'undefined');
  ok('恢复在线：页面正常', backOnline === true);

  await page.screenshot({ path: '/root/.openclaw/workspace/work-hours-tracker/png/pwa_online.png' });

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('❌')).length;
  console.log(failed === 0 ? 'PWA-VERIFY-ALL-PASS' : `PWA-VERIFY-FAILED x${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });