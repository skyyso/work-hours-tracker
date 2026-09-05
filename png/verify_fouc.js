// 复现「刷新瞬间闪出未渲染内容」：在导航后极早的时间点连续抓 DOM 文本与截图
const { spawn } = require('child_process');
const fs = require('fs');
const OUT = __dirname;
const URL_ = 'http://127.0.0.1:9523/index.html';
const chrome = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9261',`--user-data-dir=${OUT}/.chrome-fouc`,'--window-size=360,900','about:blank'], { stdio:['ignore','ignore','pipe'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9261/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('cdp');}
(async () => {
  const ws = new WebSocket(await getWs()); let id=0; const p=new Map(); let or; const o=new Promise(r=>or=r); ws.onopen=or;
  ws.onmessage = e => { const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);} };
  await o;
  const send=(me,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:pa}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:2,mobile:true});

  // 记录每个资源的耗时
  const timings = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Network.responseReceived') timings.push({ url: m.params.response.url, status: m.params.response.status, t: Date.now() });
  });

  console.log('=== 冷启动（无缓存）逐帧抓取 ===');
  await send('Network.setCacheDisabled',{cacheDisabled:true});
  const t0 = Date.now();
  send('Page.navigate',{url:URL_});
  for (const at of [80, 200, 400, 800, 1500, 2500]) {
    while (Date.now() - t0 < at) await sleep(20);
    const txt = await ev(`(document.getElementById('app')||document.body).innerText.replace(/\\s+/g,' ').slice(0,110)`);
    const hasMustache = await ev(`/\\{\\{[^}]*\\}\\}/.test(document.body.innerHTML)`);
    const tw = await ev(`!!window.tailwind`);
    const vue = await ev(`!!window.Vue`);
    console.log(`  ${String(at).padStart(4)}ms  裸模板=${hasMustache?'是':'否'}  tailwind=${tw?'已载':'未载'}  vue=${vue?'已载':'未载'}  屏上文字="${txt}"`);
    if (at === 400) { const s = await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(OUT+'/fouc_400ms.png', Buffer.from(s.result.data,'base64')); }
  }
  console.log('\n=== 各资源加载耗时（相对导航开始）===');
  for (const r of timings) console.log(`  ${String(r.t-t0).padStart(5)}ms  ${r.status}  ${r.url.slice(0,72)}`);
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
