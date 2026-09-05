// 验收：发薪日标记 + 奖惩终稿修正入口
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9231', `--user-data-dir=${OUT_DIR}/.chrome-verify`,
  '--window-size=420,1000','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = []; chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i=0;i<40;i++){ try{ const t=await(await fetch('http://127.0.0.1:9231/json/list')).json(); if(t.length)return t[0].webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('CDP fail: '+stderr.join('').slice(-400));
}
(async () => {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  let id=0; const pending=new Map(); const logs=[];
  let openRes; const openP=new Promise(r=>openRes=r); ws.onopen=openRes;
  ws.onmessage=e=>{ const m=JSON.parse(e.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}
    else if(m.method==='Runtime.consoleAPICalled'){const t=(m.params.args||[]).map(a=>a.value??a.description??'').join(' '); if(!/tailwindcss/.test(t))logs.push('C '+t);}
    else if(m.method==='Runtime.exceptionThrown')logs.push('EXC '+JSON.stringify(m.params.exceptionDetails).slice(0,300)); };
  await openP;
  const send=(me,p={})=>new Promise(r=>{const i2=++id;pending.set(i2,r);ws.send(JSON.stringify({id:i2,method:me,params:p}));});
  const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
    if(r.result&&r.result.exceptionDetails)return{__err:JSON.stringify(r.result.exceptionDetails).slice(0,300)};
    return r.result&&r.result.result&&r.result.result.value;};

  await send('Runtime.enable'); await send('Page.enable');

  // 预置：2026-08 有打卡+奖惩数据，便于验证上月核对入口
  await send('Page.navigate',{url:URL}); await sleep(1200);
  await ev(`(function(){
    const rec = {};
    for (let d=1; d<=28; d++) {
      rec['2026-08-'+String(d).padStart(2,'0')] = { status:'work', shift_type: d%3?'day':'night', hours: d%3?8:10, contraband_found: d===5?3:0, contraband_missed: d===9?2:0, other_penalty: d===12?50:null, penalty_reason: d===12?'迟到':'' };
    }
    for (let d=1; d<=20; d++) {
      rec['2026-09-'+String(d).padStart(2,'0')] = { status:'work', shift_type:'day', hours:8, contraband_found: d===3?1:0, contraband_missed:0, other_penalty:null, penalty_reason:'' };
    }
    localStorage.setItem('work_records', JSON.stringify(rec));
    localStorage.removeItem('work_month_adjust');
    return 'seeded';
  })()`);
  await send('Page.navigate',{url:URL}); await sleep(2000);

  // ① 日历发薪日标记
  const cal = await ev(`(function(){
    const marks = Array.from(document.querySelectorAll('.pay-mark')).map(m=>({cls:m.className, txt:m.textContent}));
    const ringA = document.querySelectorAll('.pay-ring-a').length;
    const ringB = document.querySelectorAll('.pay-ring-b').length;
    return { payMarkCount: marks.length, marks: marks.slice(0,6), ringA, ringB };
  })()`);
  console.log('① 发薪日标记:', JSON.stringify(cal));

  const s1 = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT_DIR+'/v1_calendar.png', Buffer.from(s1.result.data,'base64'));

  // ② 点发薪日格子 -> 到账横幅
  const banner = await ev(`new Promise(r=>{
    const cells = Array.from(document.querySelectorAll('.grid.grid-cols-7.gap-1\\\\.5 > div'));
    const target = cells.find(c => c.querySelector('.pay-mark'));
    if(!target) return r({err:'no payday cell'});
    target.click();
    setTimeout(()=>{
      const ov = document.querySelector('.fixed.inset-0.z-50');
      const txt = ov ? ov.innerText.replace(/\\s+/g,' ') : null;
      r({ drawerOpen: !!ov, hasBanner: !!(txt && txt.includes('今日到账')), snippet: txt ? txt.slice(0,110) : null });
    }, 420);
  })`);
  console.log('② 发薪日到账横幅:', JSON.stringify(banner));

  const s2 = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT_DIR+'/v2_payday_drawer.png', Buffer.from(s2.result.data,'base64'));

  // 关抽屉
  await ev(`(function(){ const b=document.querySelector('.fixed.inset-0.z-50 button'); if(b) b.click(); return 1; })()`);
  await sleep(400);

  // ③ 汇总页 -> 上月核对入口
  const summary = await ev(`new Promise(r=>{
    const t = Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').trim()==='汇总');
    t.click();
    setTimeout(()=>{
      const btns = Array.from(document.querySelectorAll('button')).filter(b=>/核对修正|查看\\/改稿/.test(b.innerText||''));
      const tags = Array.from(document.querySelectorAll('.stat-tag')).map(x=>x.textContent.trim());
      const body = document.body.innerText.replace(/\\s+/g,' ');
      r({ correctBtnCount: btns.length, tags, hasRawReview: body.includes('日常累计'), hasKoujing: body.includes('奖惩口径') });
    }, 400);
  })`);
  console.log('③ 汇总页修正入口:', JSON.stringify(summary));

  const s3 = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT_DIR+'/v3_summary.png', Buffer.from(s3.result.data,'base64'));

  // ④ 打开上月核对抽屉，填终稿 80，定稿
  const adj = await ev(`new Promise(r=>{
    const btn = Array.from(document.querySelectorAll('button')).filter(b=>/核对修正|查看\\/改稿/.test(b.innerText||''))[0];
    if(!btn) return r({err:'no correct btn'});
    btn.click();
    setTimeout(()=>{
      const ov = document.querySelector('.fixed.inset-0.z-50');
      const txt = ov ? ov.innerText.replace(/\\s+/g,' ') : null;
      const input = ov && ov.querySelector('input[type=number]');
      r({ open: !!ov, hasRawSum: !!(txt&&txt.includes('累计小计')), prefill: input ? input.value : null, snippet: txt?txt.slice(0,150):null });
    }, 420);
  })`);
  console.log('④ 核对抽屉:', JSON.stringify(adj));

  const s4 = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT_DIR+'/v4_adjust_drawer.png', Buffer.from(s4.result.data,'base64'));

  // 填 80 并定稿
  const fin = await ev(`new Promise(r=>{
    const ov = document.querySelector('.fixed.inset-0.z-50');
    const input = ov.querySelector('input[type=number]');
    input.value = '80';
    input.dispatchEvent(new Event('input',{bubbles:true}));
    setTimeout(()=>{
      const delta = ov.innerText.replace(/\\s+/g,' ');
      const okBtn = Array.from(ov.querySelectorAll('button')).find(b=>/确认定稿/.test(b.innerText||''));
      okBtn.click();
      setTimeout(()=>{
        const store = JSON.parse(localStorage.getItem('work_month_adjust')||'{}');
        const body = document.body.innerText.replace(/\\s+/g,' ');
        r({ deltaShown: /上调|下调/.test(delta), stored: store, bodyHasFinal: body.includes('已定稿') });
      }, 500);
    }, 300);
  })`);
  console.log('⑤ 定稿写入:', JSON.stringify(fin));

  const s5 = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(OUT_DIR+'/v5_after_final.png', Buffer.from(s5.result.data,'base64'));

  // ⑥ 定稿后发放口径是否跟着变（切到 9 月看 9月10日到账）
  const payout = await ev(`(function(){
    const body = document.body.innerText.replace(/\\s+/g,' ');
    const m = body.match(/9月10日[^¥]*¥([\\d,.]+)/);
    return { snippet: body.slice(body.indexOf('本月到账'), body.indexOf('本月到账')+160), matched: m?m[1]:null };
  })()`);
  console.log('⑥ 发放口径:', JSON.stringify(payout));

  console.log('\n=== 异常/控制台 ===');
  console.log(logs.length?logs.join('\n'):'(无异常)');
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{ console.error('FAILED:',e.message); console.error(stderr.join('').slice(-400)); try{chrome.kill();}catch(_){}process.exit(1); });
