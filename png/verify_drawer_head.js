// 日期格子是 div 不是 button，上一版选择器点不中。这版按 .calendar-cell 的父 div 点。
const { spawn } = require('child_process');
const OUT='/root/.openclaw/workspace/work-hours-tracker/png';
const URL='http://127.0.0.1:9522/index.html';
const chrome=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9254',`--user-data-dir=${OUT}/.chrome-drawer2`,'--window-size=360,900','about:blank'],{stdio:['ignore','ignore','pipe']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9254/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('cdp');}
(async()=>{
  const ws=new WebSocket(await getWs());let id=0;const p=new Map();let or;const o=new Promise(r=>or=r);ws.onopen=or;
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};await o;
  const send=(me,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:pa}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:URL});await sleep(1300);
  await ev(`(function(){localStorage.clear();localStorage.setItem('work_records',JSON.stringify({
    '2026-09-08':{status:'work',shift_type:'day',hours:8,contraband_found:1,contraband_missed:0,other_penalty:null,penalty_reason:''}
  }));return 1;})()`);

  const openDay = async (d) => {
    await send('Page.navigate',{url:URL});await sleep(1500);
    const hit = await ev(`(function(){
      const cells=Array.from(document.querySelectorAll('.grid.grid-cols-7 > div'));
      const t=cells.find(c=>{const n=c.querySelector('.day-num, .rounded-full');return n && n.textContent.trim()==='${d}';});
      if(!t) return 'NOT_FOUND';
      t.click(); return 'CLICKED';
    })()`);
    await sleep(700);
    const head = await ev(`(function(){
      const ds=Array.from(document.querySelectorAll('.fixed.inset-0.z-50'));
      const d=ds.find(x=>/\\u6253\\u5361/.test(x.innerText));
      return d ? d.innerText.split('\\n').filter(s=>s.trim()).slice(0,5).join(' | ') : 'NO_DRAWER';
    })()`);
    return { hit, head };
  };

  const r8 = await openDay(8);
  console.log('8日(上半月) click=%s\n  抽屉前5行 = %s', r8.hit, JSON.stringify(r8.head));
  const s=await send('Page.captureScreenshot',{format:'png'});
  require('fs').writeFileSync(OUT+'/drawer_no_subtitle.png',Buffer.from(s.result.data,'base64'));
  const r20 = await openDay(20);
  console.log('20日(下半月) click=%s\n  抽屉前5行 = %s', r20.hit, JSON.stringify(r20.head));
  console.log('全页残留旧副标题 =', await ev(`/工时计入|奖惩定稿后随次月/.test(document.body.innerText)`));
  console.log('screenshot -> png/drawer_no_subtitle.png');
  ws.close();chrome.kill();process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
