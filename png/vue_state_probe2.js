// 决定性探针 v2：深入 __vue_app__ 组件实例树读 settingsOpen/tab
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9229', `--user-data-dir=${OUT_DIR}/.chrome-test5`,
  '--window-size=420,900','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = [];
chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i=0;i<40;i++){ try{ const t=await(await fetch('http://127.0.0.1:9229/json/list')).json(); if(t.length)return t[0].webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('CDP fail: '+stderr.join('').slice(-400));
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

    // 深入 __vue_app__ 拿 setupState（Vue3：app._instance.setupState / 通过组件的 exposed）
    const probe = await ev(`
      (function(){
        const appEl = document.querySelector('#app');
        const app = appEl.__vue_app__;
        const out = {};
        // vue 3.3+: app._instance (root instance)
        const root = app._instance;
        out.hasRootInstance = !!root;
        if (root) {
          const setup = root.setupState;
          const ctx = root.ctx;
          out.setupKeys = setup ? Object.keys(setup) : null;
          const get = (name) => {
            // ref 或 getter
            const v = setup ? setup[name] : undefined;
            if (v === undefined && ctx) return ctx[name];
            return v;
          };
          function deref(v) {
            if (v === undefined || v === null) return v;
            if (typeof v === 'object' && '_value' in v) return v._value; // ref
            return v;
          }
          const sOpen = deref(get('settingsOpen'));
          const tabVal = deref(get('tab'));
          const iso = deref(get('isDrawerOpen'));
          out.settingsOpen = sOpen;
          out.isDrawerOpen = iso;
          out.tab = tabVal && tabVal._value !== undefined ? tabVal._value : tabVal;
          out.tab_raw = tabVal;
        } else {
          // 尝试通过子组件
          const sub = app._container && app._container.__vue_app__;
          out.subSearched = !!sub;
        }
        return out;
      })()
    `);
    console.log('深度读取:', JSON.stringify(probe, null, 2));

    // 现在点击设置，再看 settingsOpen
    const clickThen = await ev(`
      new Promise(r => {
        const btn = Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').trim()==='设置');
        if (!btn) return r({err:'no btn'});
        btn.click();
        setTimeout(() => {
          const appEl = document.querySelector('#app');
          const root = appEl.__vue_app__._instance;
          const setup = root.setupState;
          function deref(v){ if(v&&typeof v==='object'&&('_value' in v))return v._value; return v; }
          r({
            settingsOpen_afterClick: deref(setup.settingsOpen),
            tab_afterClick: deref(setup.tab) && deref(setup.tab)._value!==undefined ? deref(setup.tab)._value : deref(setup.tab),
            z50: document.querySelectorAll('.z-50').length
          });
        }, 400);
      })
    `);
    console.log('点击设置后:', JSON.stringify(clickThen, null, 2));

    ws.close(); chrome.kill(); process.exit(0);
  } catch(e){ console.error('FAILED:',e.message); console.error(stderr.join('').slice(-400)); try{chrome.kill();}catch(_){} process.exit(1); }
})();
