const { spawn } = require('child_process');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:9522/index.html';
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9251', `--user-data-dir=${OUT_DIR}/.chrome-newtop`,'--window-size=390,900','about:blank'
], { stdio:['ignore','ignore','pipe'] });
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9251/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('CDP fail');}
const SCENES = {
  partial: `(function(){localStorage.clear();const rec={};
    rec['2026-09-01']={status:'work',shift_type:'day',hours:8,contraband_found:1,contraband_missed:0,other_penalty:null,penalty_reason:''};
    rec['2026-09-02']={status:'work',shift_type:'day',hours:8,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};
    rec['2026-09-03']={status:'work',shift_type:'day',hours:6,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};
    localStorage.setItem('work_records',JSON.stringify(rec));return 1;})()`,
  full: `(function(){localStorage.clear();const rec={};
    for(let d=1;d<=27;d++)rec['2026-09-'+String(d).padStart(2,'0')]={status:'work',shift_type:'day',hours:8,contraband_found:(d===5?2:0),contraband_missed:0,other_penalty:null,penalty_reason:''};
    localStorage.setItem('work_records',JSON.stringify(rec));return 1;})()`
};
(async()=>{
  const ws=new WebSocket(await getWs()); let id=0; const pending=new Map();
  let or; const op=new Promise(r=>or=r); ws.onopen=or;
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  await op;
  const send=(me,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:URL}); await sleep(1300);
  const fs=require('fs');
  for (const [name, script] of Object.entries(SCENES)) {
    await ev(script);
    await send('Page.navigate',{url:URL}); await sleep(1500);
    const t = await ev(`document.querySelector('header').innerText`);
    console.log(`\n===== 场景 ${name} =====`);
    console.log(t);
    const r = await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(`${OUT_DIR}/new_top_${name}.png`, Buffer.from(r.result.data,'base64'));
    // 汇总页
    await ev(`tab && (tab.value='summary')`);
    await ev(`(function(){const b=[...document.querySelectorAll('nav button')].find(x=>x.innerText.includes('汇总'));if(b)b.click();return 1;})()`);
    await sleep(900);
    const r2 = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    fs.writeFileSync(`${OUT_DIR}/new_sum_${name}.png`, Buffer.from(r2.result.data,'base64'));
  }
  console.log('\nscreenshots: png/new_top_{partial,full}.png, png/new_sum_{partial,full}.png');
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
