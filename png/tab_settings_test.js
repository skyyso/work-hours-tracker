// 实测：点击右下角「设置」Tab -> 设置抽屉是否弹出
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:9522/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9226', `--user-data-dir=${OUT_DIR}/.chrome-test2`,
  '--window-size=420,900','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = [];
chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await (await fetch('http://127.0.0.1:9226/json/list')).json();
      if (tabs.length) return tabs[0].webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('CDP 连接失败: ' + stderr.join('').slice(-400));
}

(async () => {
  try {
    const wsUrl = await getWsUrl();
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map(); const logs = [];
    let openRes; const openP = new Promise(r => openRes = r);
    ws.onopen = openRes;
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.consoleAPICalled') logs.push('C ' + (m.params.args||[]).map(a=>a.value??a.description??'').join(' '));
      else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails));
    };
    await openP;
    const send = (method, params={}) => new Promise(res => { const mid=++id; pending.set(mid,res); ws.send(JSON.stringify({id:mid,method,params})); });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails) };
      return r.result && r.result.result && r.result.result.value;
    };

    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: URL }); await sleep(2200);

    // 定位底部 tab 按钮（文字为「设置」的 <button>）
    const probe = await ev(`
      (function(){
        const btns = Array.from(document.querySelectorAll('nav button'));
        const info = btns.map(b => ({ t: (b.innerText||'').trim(), rect: JSON.stringify({x:b.getBoundingClientRect().left,y:b.getBoundingClientRect().top,w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height}), htmlOk: b.outerHTML.slice(0,100) }));
        // 命中最上层元素（判断按钮是否被其他元素遮挡）
        const sBtn = btns.find(b => (b.innerText||'').trim() === '设置');
        let hitTop = null;
        if (sBtn) {
          const r = sBtn.getBoundingClientRect();
          const cx = r.left + r.width/2, cy = r.top + r.height/2;
          const topEl = document.elementFromPoint(cx, cy);
          hitTop = topEl ? { tag: topEl.tagName, cls: topEl.className && String(topEl.className).slice(0,80) } : null;
        }
        return { navBtnCount: btns.length, btns: info, settingsBtnHitTest: hitTop };
      })()
    `);
    console.log('底部导航按钮:', JSON.stringify(probe, null, 2));

    // 点击「设置」tab
    const clickSetup = await ev(`
      new Promise(r => {
        const btn = Array.from(document.querySelectorAll('nav button')).find(b => (b.innerText||'').trim() === '设置');
        if (!btn) return r({ err: 'no settings btn' });
        btn.click();
        setTimeout(() => {
          const z50 = document.querySelectorAll('.z-50').length;
          const overlay = document.querySelector('.fixed.inset-0.z-50');
          r({
            z50,
            overlayPresent: !!overlay,
            overlayText: overlay ? (overlay.innerText||'').replace(/\\s+/g,' ').slice(0,60) : null,
            bodyHasJiangchou: document.body.innerText.includes('薪酬规则')
          });
        }, 450);
      })
    `);
    console.log('点击设置 Tab 后:', JSON.stringify(clickSetup, null, 2));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT_DIR + '/tab_settings_click.png', Buffer.from(shot.result.data, 'base64'));
    console.log('截图 tab_settings_click.png');

    console.log('\n=== 控制台 ===');
    console.log(logs.length ? logs.join('\n') : '(无)');
    ws.close(); chrome.kill(); process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message); console.error(stderr.join('').slice(-400));
    try { chrome.kill(); } catch(_){} process.exit(1);
  }
})();
