// 验证：打卡页顶部主数字 = 纯工时(429)，不含查获奖惩(+10)与未达标满勤奖
const { spawn } = require('child_process');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:9522/index.html';
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9243', `--user-data-dir=${OUT_DIR}/.chrome-topearned`,'--window-size=360,900','about:blank'
], { stdio:['ignore','ignore','pipe'] });
const stderr=[]; chrome.stderr.on('data',d=>stderr.push(d.toString()));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9243/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('CDP fail '+stderr.join('').slice(-300));}
(async()=>{
  const ws=new WebSocket(await getWs()); let id=0; const pending=new Map();
  let or; const op=new Promise(r=>or=r); ws.onopen=or;
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  await op;
  const send=(me,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:URL}); await sleep(1300);
  // 先装载同源页面后注入（storage 属于 9522 origin），再重新导航加载
  await ev(`(function(){localStorage.clear();const rec={};
    rec['2026-09-01']={status:'work',shift_type:'day',hours:8,contraband_found:1,contraband_missed:0,other_penalty:null,penalty_reason:''};
    rec['2026-09-02']={status:'work',shift_type:'day',hours:8,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};
    rec['2026-09-03']={status:'work',shift_type:'day',hours:6,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};
    localStorage.setItem('work_records',JSON.stringify(rec));return 1;})()`);
  await send('Page.navigate',{url:URL}); await sleep(1500);
  const snap = await ev(`(function(){
    const m = document.querySelector('main');
    const headerBox = document.querySelector('header');
    return { headerText: headerBox ? headerBox.innerText.slice(0,400) : null, pills: Array.from(headerBox.querySelectorAll('.pill')).map(p=>p.innerText.replace(/\\s+/g,' ').trim()) };
  })()`);
  console.log('【9月 3天22h + 1查获】@360px');
  console.log('  顶部文本 =', JSON.stringify(snap.headerText));
  console.log('  胶囊 =', JSON.stringify(snap.pills));
  await send('Page.captureScreenshot',{format:'png'}).then(r=>{
    const fs=require('fs'); fs.writeFileSync(OUT_DIR+'/verify_top_earned.png', Buffer.from(r.result.data,'base64'));
    console.log('  screenshot -> png/verify_top_earned.png');
  });
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);console.error(stderr.join('').slice(-300));try{chrome.kill();}catch(_){}process.exit(1);});