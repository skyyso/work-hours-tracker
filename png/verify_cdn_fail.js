// 分别模拟：CDN 完全不可达 / CDN 很慢，看刷新瞬间屏幕上到底是什么
const { spawn } = require('child_process');
const fs = require('fs');
const OUT = __dirname;
const URL_ = 'http://127.0.0.1:9523/index.html';
const chrome = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9262',`--user-data-dir=${OUT}/.chrome-cdn`,'--window-size=360,900','about:blank'], { stdio:['ignore','ignore','pipe'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9262/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('cdp');}
(async () => {
  const ws = new WebSocket(await getWs()); let id=0; const p=new Map(); let or; const o=new Promise(r=>or=r); ws.onopen=or;
  ws.onmessage = e => { const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);} };
  await o;
  const send=(me,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:pa}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:2,mobile:true});
  await send('Network.setCacheDisabled',{cacheDisabled:true});

  const probe = async (tag) => {
    const hasMustache = await ev(`/\\{\\{[^}]*\\}\\}/.test(document.body.innerHTML)`);
    const twStyle = await ev(`Array.from(document.querySelectorAll('style')).some(s=>/tailwind|--tw-/.test(s.textContent))`);
    const bodyH = await ev(`document.body.scrollHeight`);
    const txt = await ev(`document.body.innerText.replace(/\\s+/g,' ').slice(0,150)`);
    console.log(`  ${tag}  裸模板=${hasMustache?'是':'否'}  tailwind样式=${twStyle?'有':'无'}  页高=${bodyH}px`);
    console.log(`      屏上文字="${txt}"`);
  };

  console.log('=== 场景 A：两个 CDN 全部不可达（模拟被墙/断外网）===');
  await send('Network.setBlockedURLs',{urls:['*cdn.tailwindcss.com*','*unpkg.com*']});
  await send('Page.navigate',{url:URL_}); await sleep(2500);
  await probe('2500ms');
  let s = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT+'/fouc_cdn_blocked.png', Buffer.from(s.result.data,'base64'));
  console.log('      -> png/fouc_cdn_blocked.png');

  console.log('\n=== 场景 B：只有 tailwind 不可达，Vue 正常 ===');
  await send('Network.setBlockedURLs',{urls:['*cdn.tailwindcss.com*']});
  await send('Page.navigate',{url:URL_}); await sleep(2500);
  await probe('2500ms');
  s = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT+'/fouc_tailwind_blocked.png', Buffer.from(s.result.data,'base64'));
  console.log('      -> png/fouc_tailwind_blocked.png');

  console.log('\n=== 场景 C：只有 Vue 不可达，tailwind 正常 ===');
  await send('Network.setBlockedURLs',{urls:['*unpkg.com*']});
  await send('Page.navigate',{url:URL_}); await sleep(2500);
  await probe('2500ms');
  s = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT+'/fouc_vue_blocked.png', Buffer.from(s.result.data,'base64'));
  console.log('      -> png/fouc_vue_blocked.png');

  console.log('\n=== 场景 D：CDN 很慢（3G 限速），逐帧看 ===');
  await send('Network.setBlockedURLs',{urls:[]});
  await send('Network.emulateNetworkConditions',{offline:false,latency:400,downloadThroughput:400*1024/8,uploadThroughput:400*1024/8});
  const t0 = Date.now();
  send('Page.navigate',{url:URL_});
  for (const at of [600, 1200, 2000, 3500, 6000]) {
    while (Date.now()-t0 < at) await sleep(20);
    await probe(String(at)+'ms');
    if (at===1200){ s=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(OUT+'/fouc_slow_1200ms.png', Buffer.from(s.result.data,'base64')); }
  }
  console.log('      -> png/fouc_slow_1200ms.png');
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
