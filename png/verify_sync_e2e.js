// 端到端：浏览器里跑真实同步流程（登录 → 本地记账自动上传 → 换 origin 拉回）
const { spawn } = require('child_process');
const OUT='/root/.openclaw/workspace/work-hours-tracker/png';
const A='http://127.0.0.1:9524/index.html';        // 新服务：静态 + API 同源
const chrome=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9260',`--user-data-dir=${OUT}/.chrome-sync`,'--window-size=360,900','about:blank'],{stdio:['ignore','ignore','pipe']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9260/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('cdp');}
(async()=>{
  const ws=new WebSocket(await getWs());let id=0;const p=new Map();let or;const o=new Promise(r=>or=r);ws.onopen=or;
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};await o;
  const send=(me,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:pa}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
    if(r.result&&r.result.exceptionDetails) return 'JS_ERR: '+JSON.stringify(r.result.exceptionDetails.exception&&r.result.exceptionDetails.exception.description||r.result.exceptionDetails.text);
    return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:2,mobile:true});

  const errs=[];
  await send('Log.enable');
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
    if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errs.push(m.params.entry.text);});

  console.log('=== A. 首次打开：干净 localStorage，未登录 ===');
  await send('Page.navigate',{url:A});await sleep(1600);
  await ev(`(function(){localStorage.clear();return 1;})()`);
  await send('Page.navigate',{url:A});await sleep(1800);
  console.log('  WHTSync 已加载 =', await ev(`typeof window.WHTSync`));
  console.log('  health 探测到的用户数 =', await ev(`window.WHTSync.state.serverUsers`));
  console.log('  同步状态 =', await ev(`window.WHTSync.state.status`));

  console.log('\n=== B. 本地先记 2 天（未登录也能记）===');
  await ev(`(function(){
    localStorage.setItem('work_records',JSON.stringify({
      '2026-09-20':{status:'work',shift_type:'night',hours:10,contraband_found:2,contraband_missed:0,other_penalty:null,penalty_reason:''},
      '2026-09-21':{status:'work',shift_type:'day',hours:8,contraband_found:0,contraband_missed:1,other_penalty:null,penalty_reason:''}
    }));return 1;})()`);
  await send('Page.navigate',{url:A});await sleep(1800);
  console.log('  本地记录天数 =', await ev(`Object.keys(JSON.parse(localStorage.getItem('work_records'))).length`));
  console.log('  打卡页大字 =', await ev(`document.querySelector('header').innerText.replace(/\\n/g,' | ').slice(0,150)`));

  console.log('\n=== C. 登录（服务端已有 9/1、9/3 与定稿奖惩）===');
  console.log('  login →', await ev(`(async()=>{try{const r=await window.WHTSync.login('kory','kory-work-2026');return 'ok user='+r.user.username+' rev='+r.rev;}catch(e){return 'ERR '+e.message;}})()`));
  console.log('  pullAll →', await ev(`(async()=>{const d=await window.WHTSync.pullAll();return 'rev='+d.rev+' 远端天数='+Object.keys(d.records).length;})()`));
  await sleep(400);
  console.log('  拉取后本地天数 =', await ev(`Object.keys(JSON.parse(localStorage.getItem('work_records'))).length`));
  console.log('  拉取后本地键 =', await ev(`Object.keys(JSON.parse(localStorage.getItem('work_records'))).sort().join(',')`));
  console.log('  奖惩定稿是否同步下来 =', await ev(`JSON.stringify(JSON.parse(localStorage.getItem('work_month_adjust')||'{}'))`));

  console.log('\n=== D. 本地全推上去（合并两边）===');
  console.log('  pushAll →', await ev(`(async()=>{const r=await window.WHTSync.pushAll();return 'rev='+r.rev;})()`));
  await sleep(300);

  console.log('\n=== E. 新记一天 → 自动上传（不手动点同步）===');
  await ev(`(function(){
    const app=document.querySelector('#app');
    // 走真实 UI 路径：点日历 25 号 → 保存
    const cells=Array.from(document.querySelectorAll('.grid.grid-cols-7 > div'));
    const t=cells.find(c=>{const n=c.querySelector('.day-num, .rounded-full');return n&&n.textContent.trim()==='25';});
    t.click(); return 1;})()`);
  await sleep(600);
  await ev(`(function(){const b=Array.from(document.querySelectorAll('button')).find(x=>/^保存/.test(x.innerText.trim()));if(b)b.click();return b?1:'NO_SAVE_BTN';})()`);
  await sleep(500);
  console.log('  保存后 pending =', await ev(`window.WHTSync.state.pending`));
  console.log('  等待自动同步（防抖 1.5s）…');
  await sleep(3200);
  console.log('  自动同步后 pending =', await ev(`window.WHTSync.state.pending`));
  console.log('  状态 =', await ev(`window.WHTSync.state.status`), '  rev =', await ev(`window.WHTSync.state.rev`));

  console.log('\n=== F. 模拟「换设备」：清空本地后重新登录拉全量 ===');
  const tok = await ev(`localStorage.getItem('work_sync_token')`);
  await ev(`(function(){localStorage.clear();return 1;})()`);
  await send('Page.navigate',{url:A});await sleep(1700);
  console.log('  清空后本地天数 =', await ev(`Object.keys(JSON.parse(localStorage.getItem('work_records')||'{}')).length`));
  console.log('  重新登录 →', await ev(`(async()=>{try{await window.WHTSync.login('kory','kory-work-2026');const d=await window.WHTSync.pullAll();return '拉到 '+Object.keys(d.records).length+' 天, rev='+d.rev;}catch(e){return 'ERR '+e.message}})()`));
  await sleep(600);
  console.log('  恢复后本地键 =', await ev(`Object.keys(JSON.parse(localStorage.getItem('work_records'))).sort().join(',')`));
  console.log('  恢复后打卡页 =', await ev(`document.querySelector('header').innerText.replace(/\\n/g,' | ').slice(0,160)`));

  console.log('\n=== G. 设置页同步面板 ===');
  await ev(`(function(){const b=Array.from(document.querySelectorAll('button[title=设置],button')).find(x=>x.getAttribute&&x.getAttribute('title')==='设置');if(b)b.click();return 1;})()`);
  await sleep(700);
  console.log('  面板文本 =', await ev(`(function(){const cs=Array.from(document.querySelectorAll('.card'));const c=cs.find(x=>/云端同步/.test(x.innerText));return c?c.innerText.replace(/\\n+/g,' | '):'NOT_FOUND';})()`));
  const shot=await send('Page.captureScreenshot',{format:'png'});
  require('fs').writeFileSync(OUT+'/sync_panel.png',Buffer.from(shot.result.data,'base64'));
  console.log('  screenshot -> png/sync_panel.png');

  console.log('\n=== H. 控制台错误 ===');
  console.log(errs.length? errs.slice(0,5).join('\n') : '  无');
  ws.close();chrome.kill();process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
