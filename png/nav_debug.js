// 深挖：为什么 nav button = 0 —— 检查底部 nav 真实 DOM
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9227', `--user-data-dir=${OUT_DIR}/.chrome-test3`,
  '--window-size=420,900','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = [];
chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i=0;i<40;i++){ try{ const t=await(await fetch('http://127.0.0.1:9227/json/list')).json(); if(t.length)return t[0].webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('CDP fail: '+stderr.join('').slice(-400));
}
(async () => {
  try {
    const wsUrl = await getWsUrl();
    const ws = new WebSocket(wsUrl);
    let id=0; const pending=new Map(); const logs=[];
    let openRes; const openP=new Promise(r=>openRes=r);
    ws.onopen=openRes;
    ws.onmessage=ev=>{ const m=JSON.parse(ev.data);
      if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}
      else if(m.method==='Runtime.consoleAPICalled')logs.push('C '+(m.params.args||[]).map(a=>a.value??a.description??'').join(' '));
      else if(m.method==='Runtime.exceptionThrown')logs.push('EXC '+JSON.stringify(m.params.exceptionDetails)); };
    await openP;
    const send=(method,params={})=>new Promise(res=>{const mid=++id;pending.set(mid,res);ws.send(JSON.stringify({id:mid,method,params}));});
    const ev=async(expr)=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.result&&r.result.exceptionDetails)return{__err:JSON.stringify(r.result.exceptionDetails)}; return r.result&&r.result.result&&r.result.result.value;};

    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate',{url:URL}); await sleep(2200);

    const probe = await ev(`
      (function(){
        const navs = document.querySelectorAll('nav');
        const allButtons = document.querySelectorAll('button');
        const withIco = document.querySelectorAll('svg.ico').length;
        // 找包含 settings 图标的按钮
        const gear = document.querySelector('button[title="设置"]');
        const gearInfo = gear ? { found:true, parent: gear.parentElement.tagName+'.'+(gear.parentElement.className||'').slice(0,40), parentPar: gear.parentElement.parentElement.tagName+'.'+(gear.parentElement.parentElement.className||'').slice(0,40) } : { found:false };
        return {
          navCount: navs.length,
          navOuterHTMLlen: navs.length ? navs[0].outerHTML.length : 0,
          navFirst80: navs.length ? navs[0].outerHTML.slice(0,80) : null,
          allButtonCount: allButtons.length,
          buttonsText: Array.from(allButtons).map(b=>'['+((b.innerText||'').trim()||'~')+']').join(','),
          svgIconCount: withIco,
          gearInfo
        };
      })()
    `);
    console.log('DOM 深挖:', JSON.stringify(probe, null, 2));

    ws.close(); chrome.kill(); process.exit(0);
  } catch(e){ console.error('FAILED:',e.message); console.error(stderr.join('').slice(-400)); try{chrome.kill();}catch(_){} process.exit(1); }
})();
