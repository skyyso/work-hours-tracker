// 无头实测：点齿轮 -> 设置抽屉是否弹出（returnByValue 版）
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:9522/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9225', `--user-data-dir=${OUT_DIR}/.chrome-test`,
  '--window-size=420,900','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = [];
chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await (await fetch('http://127.0.0.1:9225/json/list')).json();
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

    // 1) 初始状态有多少 .z-50
    const before = await ev(`({ z50: document.querySelectorAll('.z-50').length, gear: !!document.querySelector('button[title="设置"]') })`);
    console.log('初始:', JSON.stringify(before));

    // 2) 点齿轮
    const after = await ev(`
      new Promise(r => {
        const btn = document.querySelector('button[title="设置"]');
        if (!btn) return r({ err: 'no gear btn' });
        btn.click();
        setTimeout(() => {
          const all = document.querySelectorAll('.fixed.inset-0');
          const viz = [];
          all.forEach(d => {
            const s = getComputedStyle(d);
            viz.push({ cls: d.className.replace(/\\s+/g,' ').slice(0,70), disp: s.display, vis: s.visibility, op: s.opacity });
          });
          r({
            z50: document.querySelectorAll('.z-50').length,
            overlays: viz,
            toolbarCooked: document.body.innerText.includes('薪酬规则'),
            gearIcon: btn.outerHTML.slice(0,120)
          });
        }, 450);
      })
    `);
    console.log('点齿轮后:', JSON.stringify(after, null, 2));

    // 3) 强制直接验证 settingsOpen 是否被置 true（绕过 DOM）
    const stateProbe = await ev(`(function(){ 
      // 尝试从 app 实例读状态不可行(生产vue未暴露)，改为再点一次+立即读 body
      return 'probe';
    })()`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT_DIR + '/gear_final.png', Buffer.from(shot.result.data, 'base64'));
    console.log('截图 gear_final.png');

    console.log('\n=== 控制台 ===');
    console.log(logs.length ? logs.join('\n') : '(无)');
    ws.close(); chrome.kill(); process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message); console.error(stderr.join('').slice(-400));
    try { chrome.kill(); } catch(_){} process.exit(1);
  }
})();
