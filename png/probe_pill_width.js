// 量胶囊实际宽度：模拟 360px（小屏，DPR3 → 1080px 截图）与 390/430
const { spawn } = require('child_process');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9236', `--user-data-dir=${OUT_DIR}/.chrome-pill`,'--window-size=360,900','about:blank'
], { stdio:['ignore','ignore','pipe'] });
const stderr=[]; chrome.stderr.on('data',d=>stderr.push(d.toString()));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch('http://127.0.0.1:9236/json/list')).json();if(t.length)return t[0].webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('CDP fail '+stderr.join('').slice(-300));}
(async()=>{
  const ws=new WebSocket(await getWs()); let id=0; const pending=new Map();
  let or; const op=new Promise(r=>or=r); ws.onopen=or;
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  await op;
  const send=(me,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:me,params:p}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value;};
  await send('Runtime.enable'); await send('Page.enable');

  for (const W of [360, 390, 414, 430]) {
    await send('Emulation.setDeviceMetricsOverride',{width:W,height:900,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:URL}); await sleep(1300);
    // 灌数据造出 ¥282.8 这种较长的数字
    await ev(`(function(){const rec={};for(let d=1;d<=2;d++)rec['2026-09-0'+d]={status:'work',shift_type:'day',hours:d===1?8:6.5,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};localStorage.setItem('work_records',JSON.stringify(rec));return 1;})()`);
    await send('Page.navigate',{url:URL}); await sleep(1300);
    const r = await ev(`(function(){
      const wrap = document.querySelector('header .flex.flex-wrap');
      const ps = Array.from(document.querySelectorAll('header .pill'));
      const cs = getComputedStyle(wrap);
      const gap = parseFloat(cs.gap)||6;
      const items = ps.map(p=>({t:p.innerText.replace(/\\s+/g,' ').trim(), w:+p.getBoundingClientRect().width.toFixed(1), top:+p.getBoundingClientRect().top.toFixed(1)}));
      const rows = new Set(items.map(i=>i.top)).size;
      const sum = items.reduce((a,b)=>a+b.w,0) + gap*(items.length-1);
      return { vw: innerWidth, wrapW:+wrap.getBoundingClientRect().width.toFixed(1), gap, rows, sum:+sum.toFixed(1), items };
    })()`);
    console.log(`\n【视口 ${W}px】容器 ${r.wrapW}px | gap ${r.gap}px | 实际行数 ${r.rows} | 三胶囊总需 ${r.sum}px | 溢出 ${(r.sum - r.wrapW).toFixed(1)}px`);
    r.items.forEach(i=>console.log(`   ${String(i.w).padStart(6)}px  top=${i.top}  "${i.t}"`));
  }
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error('FAILED:',e.message);console.error(stderr.join('').slice(-300));try{chrome.kill();}catch(_){}process.exit(1);});
