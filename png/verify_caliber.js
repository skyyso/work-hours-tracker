// 验收：两套口径分区（挣得 / 进账）+ 归属期徽章 + 结转标注
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9232', `--user-data-dir=${OUT_DIR}/.chrome-caliber`,
  '--window-size=420,1200','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = []; chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i=0;i<40;i++){ try{ const t=await(await fetch('http://127.0.0.1:9232/json/list')).json(); if(t.length)return t[0].webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('CDP fail: '+stderr.join('').slice(-400));
}
(async () => {
  const ws = new WebSocket(await getWsUrl());
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
  const shot=async(n)=>{const s=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(OUT_DIR+'/'+n,Buffer.from(s.result.data,'base64'));};

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate',{url:URL}); await sleep(1200);
  // 8月满月打卡（含奖惩）+ 9月上半月打卡，制造出「挣得 ≠ 进账」的典型场景
  await ev(`(function(){
    const rec = {};
    for (let d=1; d<=28; d++) rec['2026-08-'+String(d).padStart(2,'0')] = { status:'work', shift_type: d%3?'day':'night', hours: d%3?8:10, contraband_found: d===5?3:0, contraband_missed: d===9?2:0, other_penalty: d===12?50:null, penalty_reason: d===12?'迟到':'' };
    for (let d=1; d<=20; d++) rec['2026-09-'+String(d).padStart(2,'0')] = { status:'work', shift_type:'day', hours:8, contraband_found: d===3?1:0, contraband_missed:0, other_penalty:null, penalty_reason:'' };
    localStorage.setItem('work_records', JSON.stringify(rec));
    localStorage.setItem('work_month_adjust', JSON.stringify({'2026-08':{status:'final',finalAmount:80,note:'与班长核对',finalizedAt:'2026-09-01T02:00:00.000Z'}}));
    return 1;
  })()`);
  await send('Page.navigate',{url:URL}); await sleep(1800);

  // ① 顶部看板：主数字换成「挣得」，副标题带结转说明
  const board = await ev(`(function(){
    const h = document.querySelector('header').innerText.replace(/\\s+/g,' ');
    return { text: h.slice(0, 210) };
  })()`);
  console.log('① 看板:', JSON.stringify(board));
  await shot('c1_board.png');

  // ② 汇总页两分区
  const sum = await ev(`new Promise(r=>{
    Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').trim()==='汇总').click();
    setTimeout(()=>{
      const sec = document.querySelector("section[class*='px-4'] , section");
      const secs = Array.from(document.querySelectorAll('section'));
      const s = secs.find(x=>x.innerText.includes('挣得'));
      const t = s ? s.innerText.replace(/\\s+/g,' ') : null;
      const badges = Array.from(document.querySelectorAll('.own-badge')).map(b=>({cls:b.className.replace('own-badge ',''),txt:b.textContent.trim()}));
      return r({
        has挣得: !!(t&&t.includes('9月挣得')), has进账: !!(t&&t.includes('9月进账')),
        has何时到手: !!(t&&t.includes('何时到手')),
        has合计应得: !!(t&&t.includes('合计应得')), has合计进账: !!(t&&t.includes('合计进账')),
        has结转标注: !!(t&&t.includes('结转10月10号发')),
        has本月22: !!(t&&t.includes('本月22号发')),
        badges,
        snippet: t ? t.slice(0, 420) : null
      });
    }, 500);
  })`);
  console.log('② 汇总分区:', JSON.stringify(sum, null, 1));
  await shot('c2_summary.png');

  // ③ 数字自洽校验：挣得 = 工时收入+奖惩净额；进账 = 两笔之和；结转 = payoutNextB
  const nums = await ev(`(function(){
    const b = document.body.innerText.replace(/\\s+/g,' ');
    const g = re => { const m = b.match(re); return m ? m[1] : null; };
    return {
      工时收入: g(/工时收入\\S*?\\s*确定\\s*¥([\\d,.]+)/),
      奖惩净额: g(/奖惩净额\\s*\\S+\\s*([+-]¥[\\d,.]+)/),
      合计应得: g(/合计应得\\s*¥([\\d,.]+)/),
      上半月已发: g(/9\\/22 上半月工时（[^）]*）\\s*¥([\\d,.]+)/),
      结转: g(/10\\/10 下半月工时\\+奖惩（结转）\\s*¥([\\d,.]+)/),
      合计进账: g(/合计进账\\s*¥([\\d,.]+)/),
      看板结转: g(/9月进账 ¥([\\d,.]+)/)
    };
  })()`);
  console.log('③ 数字:', JSON.stringify(nums));

  // ④ 文本报告分段
  const rpt = await ev(`(function(){
    const app = document.querySelector('#app');
    return null;
  })()`);
  const rptText = await ev(`(function(){
    // 通过点「复制文本报告」不便读剪贴板，改为直接取按钮上方渲染不到的内容：用 clipboard 拦截
    let captured = null;
    const orig = navigator.clipboard && navigator.clipboard.writeText;
    return new Promise(res=>{
      if (navigator.clipboard) navigator.clipboard.writeText = (t)=>{ captured = t; return Promise.resolve(); };
      const btn = Array.from(document.querySelectorAll('button')).find(b=>/复制文本报告/.test(b.innerText||''));
      btn.click();
      setTimeout(()=>{ res(captured); }, 400);
    });
  })()`);
  console.log('④ 报告:\n' + (rptText || '(未捕获)'));

  console.log('\n=== 异常/控制台 ===');
  console.log(logs.length?logs.join('\n'):'(无异常)');
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{ console.error('FAILED:',e.message); console.error(stderr.join('').slice(-400)); try{chrome.kill();}catch(_){}process.exit(1); });
