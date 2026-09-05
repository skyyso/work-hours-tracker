// 复现排查：用真实浏览器分别从 127.0.0.1 与公网 IP 打开，看 boot-fail 会不会出现
const { spawn } = require('child_process');
const OUT = '/root/.openclaw/workspace/work-hours-tracker/png';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TARGETS = [
  ['本机同源', 'http://127.0.0.1:9522/index.html'],
  ['公网 IP  ', 'http://66.235.106.12:9522/index.html']
];

(async () => {
  const chrome = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=9264', `--user-data-dir=${OUT}/.chrome-boot`,
    '--window-size=360,900', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await (async () => {
    for (let i = 0; i < 40; i++) {
      try { const t = await (await fetch('http://127.0.0.1:9264/json/list')).json(); if (t.length) return t[0].webSocketDebuggerUrl; } catch {}
      await sleep(250);
    }
    throw new Error('CDP 起不来');
  })();

  const ws = new WebSocket(wsUrl);
  let id = 0; const pnd = new Map();
  await new Promise(r => { ws.onopen = r; });

  const reqs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pnd.has(m.id)) { pnd.get(m.id)(m); pnd.delete(m.id); }
    if (m.method === 'Network.responseReceived') {
      reqs.push(`${m.params.response.status} ${m.params.response.url.replace(/^https?:\/\/[^/]+/, '')}`);
    }
    if (m.method === 'Network.loadingFailed') reqs.push(`FAILED ${m.params.errorText}`);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pnd.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

  for (const [label, url] of TARGETS) {
    reqs.length = 0;
    await send('Page.navigate', { url }); await sleep(2600);
    console.log(`\n=== ${label} ${url} ===`);
    console.log('  Vue 是否加载 =', await ev(`typeof Vue`));
    console.log('  boot-fail 是否显示 =', await ev(`(function(){const b=document.getElementById('boot-fail');return b?!b.hidden:'元素不存在(旧版页面)';})()`));
    console.log('  #app 是否存在 =', await ev(`!!document.getElementById('app')`));
    console.log('  首屏文本 =', String(await ev(`document.body.innerText.replace(/\\n+/g,' | ').slice(0,110)`)));
    console.log('  资源请求：');
    reqs.forEach(r => console.log('    ' + r));
  }

  ws.close(); chrome.kill();
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
