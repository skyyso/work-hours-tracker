// 修复后复测：冷启动逐帧 + 完全断外网 + 3G 限速，确认任何时刻都不闪裸模板
const { spawn } = require('child_process');
const fs = require('fs');
const OUT = __dirname;
const URL_ = 'http://127.0.0.1:9522/index.html';
const chrome = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9263',`--user-data-dir=${OUT}/.chrome-fixed`,'--window-size=360,900','about:blank'], { stdio:['ignore','ignore','pipe'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9263/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('cdp');}
(async () => {
  const ws = new WebSocket(await getWs()); let id=0; const p=new Map(); let or; const o=new Promise(r=>or=r); ws.onopen=or;
  ws.onmessage = e => { const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);} };
  await o;
  const send=(me,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:pa}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:2,mobile:true});
  await send('Network.setCacheDisabled',{cacheDisabled:true});

  const reqs=[]; const errs=[];
  ws.addEventListener('message', e => { const m=JSON.parse(e.data);
    if(m.method==='Network.responseReceived') reqs.push(`${m.params.response.status} ${m.params.response.url}`);
    if(m.method==='Log.entryAdded'&&m.params.entry.level==='error') errs.push(m.params.entry.text); });

  // 可见的裸模板：只算真正显示在屏上的（v-cloak 隐藏的不算）
  const VISIBLE_MUSTACHE = `(function(){
    const app=document.getElementById('app');
    if(!app) return 'NO_APP';
    const cs=getComputedStyle(app);
    if(cs.visibility==='hidden'||cs.display==='none') return 'HIDDEN';
    return /\\{\\{[^}]*\\}\\}/.test(app.innerHTML) ? 'LEAK' : 'CLEAN';
  })()`;

  const probe = async tag => {
    const st = await ev(VISIBLE_MUSTACHE);
    const txt = await ev(`document.body.innerText.replace(/\\s+/g,' ').slice(0,80)`);
    const styled = await ev(`(function(){const a=document.getElementById('app');return a?getComputedStyle(a).maxWidth:'-'})()`);
    const flag = st==='LEAK' ? '❌ 屏上出现裸模板' : st==='HIDDEN' ? '✅ 已遮住(v-cloak)' : '✅ 已渲染';
    console.log(`  ${tag.padStart(6)}  ${flag}  app.maxWidth=${styled}  "${txt}"`);
    return st;
  };

  console.log('=== 场景1：冷启动逐帧（本地资源，无缓存）===');
  let leak=false; const t0=Date.now();
  send('Page.navigate',{url:URL_});
  for (const at of [50,100,200,300,500,800,1500]) {
    while(Date.now()-t0<at) await sleep(10);
    if (await probe(at+'ms')==='LEAK') leak=true;
  }
  let s=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT+'/fixed_cold.png', Buffer.from(s.result.data,'base64'));

  console.log('\n=== 场景2：完全断外网（原先这里只剩裸模板）===');
  await send('Network.setBlockedURLs',{urls:['*cdn.tailwindcss.com*','*unpkg.com*','*://*.googleapis.com/*']});
  await send('Page.navigate',{url:URL_}); await sleep(2000);
  if (await probe('2000ms')==='LEAK') leak=true;
  s=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT+'/fixed_offline.png', Buffer.from(s.result.data,'base64'));

  console.log('\n=== 场景3：3G 限速逐帧 ===');
  await send('Network.setBlockedURLs',{urls:[]});
  await send('Network.emulateNetworkConditions',{offline:false,latency:400,downloadThroughput:400*1024/8,uploadThroughput:400*1024/8});
  const t1=Date.now(); send('Page.navigate',{url:URL_});
  for (const at of [300,800,1500,3000,5000,8000]) {
    while(Date.now()-t1<at) await sleep(20);
    if (await probe(at+'ms')==='LEAK') leak=true;
  }
  s=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT+'/fixed_slow.png', Buffer.from(s.result.data,'base64'));

  console.log('\n=== 全部网络请求 ===');
  [...new Set(reqs)].forEach(r=>console.log('  '+r));
  console.log('\n=== 控制台错误 ===');
  console.log(errs.length? errs.slice(0,5).map(x=>'  '+x).join('\n') : '  无');
  console.log('\n结论：' + (leak ? '❌ 仍有裸模板闪现' : '✅ 三个场景下均未出现裸模板'));
  ws.close(); chrome.kill(); process.exit(leak?1:0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
