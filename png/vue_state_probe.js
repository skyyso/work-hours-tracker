// 决定性探针：点设置后，直接读 Vue 应用实例里的 settingsOpen 状态
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9228', `--user-data-dir=${OUT_DIR}/.chrome-test4`,
  '--window-size=420,900','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = [];
chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i=0;i<40;i++){ try{ const t=await(await fetch('http://127.0.0.1:9228/json/list')).json(); if(t.length)return t[0].webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('CDP fail: '+stderr.join('').slice(-400));
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

    // 通过 __vue_app__ 拿实例（Vue3 挂在根元素上）
    const probe1 = await ev(`
      (function(){
        const appEl = document.querySelector('#app');
        const vue = appEl && (appEl.__vue_app__ || appEl._vnode);
        let keys = null;
        if (appEl && appEl.__vue_app__) {
          // 生产构建通常隐藏，尽力而为
          keys = Object.keys(appEl).filter(k=>k.startsWith('__'));
        }
        // 读所有 ref 状态：尝试从 props/暴露的 setupState
        let setupKeys = null;
        try {
          const inst = appEl.__vue_app__;
          // 遍历组件实例
          setupKeys = Object.keys(inst).filter(k=>/devtools|app/i.test(k));
        } catch(e) { setupKeys = 'ERR '+e.message; }
        return {
          appElExists: !!appEl,
          appKeys: keys,
          scan: setupKeys
        };
      })()
    `);
    console.log('Vue 实例扫描:', JSON.stringify(probe1, null, 2));

    ws.close(); chrome.kill(); process.exit(0);
  } catch(e){ console.error('FAILED:',e.message); console.error(stderr.join('').slice(-400)); try{chrome.kill();}catch(_){} process.exit(1); }
})();
