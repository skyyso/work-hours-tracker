// 渲染实测：满勤达标 + 奖惩定稿 → 奖惩卡尾行「计入应得合计」= 满勤 + 奖惩
const { spawn } = require('child_process');
const OUT='/root/.openclaw/workspace/work-hours-tracker/png';
const URL='http://127.0.0.1:9522/index.html';
const chrome=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9252',`--user-data-dir=${OUT}/.chrome-fullsum`,'--window-size=360,900','about:blank'],{stdio:['ignore','ignore','pipe']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9252/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('cdp');}
(async()=>{
  const ws=new WebSocket(await getWs());let id=0;const p=new Map();let or;const o=new Promise(r=>or=r);ws.onopen=or;
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};await o;
  const send=(me,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:pa}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:URL});await sleep(1300);
  // 27天×8h=216h 满勤，其中5日查获5件(+50)，定稿 +50
  await ev(`(function(){localStorage.clear();const rec={};
    for(let d=1;d<=27;d++)rec['2026-09-'+String(d).padStart(2,'0')]={status:'work',shift_type:'day',hours:8,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};
    rec['2026-09-05'].contraband_found=5;
    localStorage.setItem('work_records',JSON.stringify(rec));
    localStorage.setItem('work_month_adjust',JSON.stringify({'2026-09':{status:'final',finalAmount:50,note:'组长核定',finalizedAt:'2026-10-01T09:00:00.000Z'}}));
    return 1;})()`);
  await send('Page.navigate',{url:URL});await sleep(1500);
  console.log('打卡页顶部 =',JSON.stringify(await ev(`document.querySelector('header').innerText.replace(/\\n/g,' | ')`)));
  await ev(`(function(){const b=Array.from(document.querySelectorAll('button')).find(x=>/汇总/.test(x.innerText));if(b)b.click();return 1;})()`);
  await sleep(600);
  const s=await ev(`(function(){const c=Array.from(document.querySelectorAll('.card'));
    const a=c.find(x=>/总劳动应得/.test(x.innerText)),r=c.find(x=>/奖惩记录/.test(x.innerText));
    return {earned:a?a.innerText.replace(/\\n/g,' | '):null, review:r?r.innerText.replace(/\\n/g,' | '):null};})()`);
  console.log('应得卡 =',JSON.stringify(s.earned));
  console.log('奖惩卡 =',JSON.stringify(s.review));
  const shot=await send('Page.captureScreenshot',{format:'png'});
  require('fs').writeFileSync(OUT+'/review_full_final.png',Buffer.from(shot.result.data,'base64'));
  console.log('screenshot -> png/review_full_final.png');
  ws.close();chrome.kill();process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);try{chrome.kill();}catch(_){}process.exit(1);});
