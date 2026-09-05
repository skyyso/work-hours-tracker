// 验收：顶部三胶囊必须单行（不折行）。覆盖 320/360/390/414/430 五档 × 普通/最坏两种数据
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9238', `--user-data-dir=${OUT_DIR}/.chrome-pillv`,'--window-size=390,900','about:blank'
], { stdio:['ignore','ignore','pipe'] });
const stderr=[]; chrome.stderr.on('data',d=>stderr.push(d.toString()));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9238/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('CDP fail '+stderr.join('').slice(-300));}

let pass=0, fail=0;
const ok=(n,c,x='')=>{ if(c){pass++;console.log('  ✅ '+n+(x?' → '+x:''));} else {fail++;console.log('  ❌ '+n+(x?' → '+x:''));} };

const DATA = {
  normal: `(function(){const rec={};for(let d=1;d<=2;d++)rec['2026-09-0'+d]={status:'work',shift_type:'day',hours:d===1?8:6.5,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};localStorage.setItem('work_records',JSON.stringify(rec));return 1;})()`,
  worst:  `(function(){const rec={};for(let d=1;d<=27;d++)rec['2026-09-'+String(d).padStart(2,'0')]={status:'work',shift_type:'night',hours:12,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};localStorage.setItem('work_records',JSON.stringify(rec));return 1;})()`
};

(async()=>{
  const ws=new WebSocket(await getWs()); let id=0; const pending=new Map(); const logs=[];
  let or; const op=new Promise(r=>or=r); ws.onopen=or;
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}
    else if(m.method==='Runtime.exceptionThrown')logs.push('EXC '+JSON.stringify(m.params.exceptionDetails).slice(0,250));};
  await op;
  const send=(me,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  const shot=async n=>{const s=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(OUT_DIR+'/'+n,Buffer.from(s.result.data,'base64'));};
  await send('Runtime.enable'); await send('Page.enable');

  const measure = () => ev(`(function(){
    const wrap=document.querySelector('header .flex.flex-nowrap');
    if(!wrap) return {err:'wrap not found'};
    const ps=Array.from(document.querySelectorAll('header .pill'));
    const items=ps.map(p=>{const r=p.getBoundingClientRect();return {t:p.innerText.replace(/\\s+/g,' ').trim(),w:+r.width.toFixed(1),top:+r.top.toFixed(1),h:+r.height.toFixed(1)};});
    const gap=parseFloat(getComputedStyle(wrap).gap)||0;
    const need=items.reduce((a,b)=>a+b.w,0)+gap*(items.length-1);
    const wr=wrap.getBoundingClientRect();
    return { vw:innerWidth, wrapW:+wr.width.toFixed(1), wrapH:+wr.height.toFixed(1), gap,
      rows:new Set(items.map(i=>i.top)).size, need:+need.toFixed(1),
      scrollW:wrap.scrollWidth, clientW:wrap.clientWidth,
      pillH:items[0]?items[0].h:0, items };
  })()`);

  for (const [kind, seed] of Object.entries(DATA)) {
    for (const W of [320, 360, 390, 414, 430]) {
      await send('Emulation.setDeviceMetricsOverride',{width:W,height:900,deviceScaleFactor:1,mobile:true});
      await send('Page.navigate',{url:URL}); await sleep(1100);
      await ev(seed);
      await send('Page.navigate',{url:URL}); await sleep(1250);
      const r = await measure();
      console.log(`\n── ${kind==='normal'?'常规数据':'最坏数据(27天×12h → ¥6318.0)'} @ ${W}px`);
      if (r.err) { ok('容器存在', false, r.err); continue; }
      console.log(`   容器 ${r.wrapW}px | gap ${r.gap}px | 需 ${r.need}px | scrollW ${r.scrollW} / clientW ${r.clientW}`);
      r.items.forEach(i=>console.log(`     ${String(i.w).padStart(6)}px  top=${i.top}  "${i.t}"`));
      ok(`单行（所有胶囊 top 相同）`, r.rows===1, `rows=${r.rows}`);
      ok(`容器高度为单行高（≈${r.pillH}px）`, Math.abs(r.wrapH - r.pillH) < 2, `wrapH=${r.wrapH} pillH=${r.pillH}`);
      if (W >= 360) ok(`360+ 无需横滑即可容纳`, r.scrollW <= r.clientW + 1, `scrollW=${r.scrollW} clientW=${r.clientW}`);
      if (kind==='worst' && W===360) await shot('p_worst_360.png');
      if (kind==='worst' && W===320) await shot('p_worst_320.png');
      if (kind==='normal' && W===360) await shot('p_normal_360.png');
    }
  }
  console.log('\n=== 异常 ===');
  console.log(logs.length?logs.join('\n'):'(无异常)');
  console.log('\n==============================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==============================================');
  ws.close(); chrome.kill(); process.exit(fail?1:0);
})().catch(e=>{console.error('FAILED:',e.message);console.error(stderr.join('').slice(-300));try{chrome.kill();}catch(_){}process.exit(1);});
