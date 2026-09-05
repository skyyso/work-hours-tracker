// 验证：奖惩未定稿 → 一律按 ¥0 计（与满勤未达标同口径）；定稿后才计入
const { spawn } = require('child_process');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:9522/index.html';
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9251', `--user-data-dir=${OUT_DIR}/.chrome-review`,'--window-size=360,900','about:blank'
], { stdio:['ignore','ignore','pipe'] });
const stderr=[]; chrome.stderr.on('data',d=>stderr.push(d.toString()));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9251/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('CDP fail '+stderr.join('').slice(-300));}

// 场景：9月 3天22h（8+8+6），其中1天查获1件 → 工时 429，查获记录 +10
const RECORDS = `{
  '2026-09-01':{status:'work',shift_type:'day',hours:8,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''},
  '2026-09-02':{status:'work',shift_type:'day',hours:8,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''},
  '2026-09-03':{status:'work',shift_type:'day',hours:6,contraband_found:1,contraband_missed:0,other_penalty:null,penalty_reason:''}
}`;

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

  const readAll = async (label, shot) => {
    const snap = await ev(`(function(){
      const hb=document.querySelector('header');
      // 切到汇总页读「合计应得」卡
      const tabs=Array.from(document.querySelectorAll('nav button, footer button, button'));
      return { header: hb.innerText.replace(/\\n/g,' | ') };
    })()`);
    console.log('【'+label+'】');
    console.log('  打卡页顶部 =', JSON.stringify(snap.header));
    // 切汇总页
    await ev(`(function(){const el=Array.from(document.querySelectorAll('button')).find(b=>/汇总/.test(b.innerText));if(el)el.click();return 1;})()`);
    await sleep(500);
    const sum = await ev(`(function(){
      const cards=Array.from(document.querySelectorAll('.card'));
      const c=cards.find(x=>/总劳动应得/.test(x.innerText));
      const r=cards.find(x=>/奖惩记录/.test(x.innerText));
      return { earned: c?c.innerText.replace(/\\n/g,' | '):null, review: r?r.innerText.replace(/\\n/g,' | '):null };
    })()`);
    console.log('  汇总·应得卡 =', JSON.stringify(sum.earned));
    console.log('  汇总·奖惩卡 =', JSON.stringify(sum.review));
    if (shot) {
      const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
      require('fs').writeFileSync(OUT_DIR+'/'+shot, Buffer.from(r.result.data,'base64'));
      console.log('  screenshot -> png/'+shot);
    }
    // 切回打卡页
    await ev(`(function(){const el=Array.from(document.querySelectorAll('button')).find(b=>/打卡/.test(b.innerText));if(el)el.click();return 1;})()`);
    await sleep(300);
  };

  // ① 未定稿
  await ev(`(function(){localStorage.clear();localStorage.setItem('work_records',JSON.stringify(${RECORDS}));return 1;})()`);
  await send('Page.navigate',{url:URL}); await sleep(1500);
  await readAll('未定稿：查获1件只作记录，应得应为 ¥429.0', 'review_draft.png');

  // ② 组长审核定稿 +10
  await ev(`(function(){localStorage.setItem('work_month_adjust',JSON.stringify({'2026-09':{status:'final',finalAmount:10,note:'组长核定',finalizedAt:'2026-10-01T09:00:00.000Z'}}));return 1;})()`);
  await send('Page.navigate',{url:URL}); await sleep(1500);
  await readAll('已定稿 +10：应得应为 ¥439.0', 'review_final.png');

  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
