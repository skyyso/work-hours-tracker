// 验收：设置改底部抽屉（齿轮 + 底部Tab 触发；三种关闭；不动 tabs 数组）
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/usr/bin/chromium';
const OUT_DIR = __dirname;
const URL = 'http://127.0.0.1:8388/index.html';

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9234', `--user-data-dir=${OUT_DIR}/.chrome-drawer`,
  '--window-size=420,1000','about:blank'
], { stdio: ['ignore','ignore','pipe'] });
const stderr = []; chrome.stderr.on('data', d => stderr.push(d.toString()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  for (let i=0;i<40;i++){ try{ const t=await(await fetch('http://127.0.0.1:9234/json/list')).json(); if(t.length)return t[0].webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('CDP fail: '+stderr.join('').slice(-400));
}

let pass=0, fail=0;
const ok  = (n,c,extra='') => { if(c){pass++;console.log('  ✅ '+n+(extra?' → '+extra:''));} else {fail++;console.log('  ❌ '+n+(extra?' → '+extra:''));} };

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

  // 状态探针：抽屉可见性 / 当前 tab / 底栏指示条
  const probe = () => ev(`(function(){
    const ov = Array.from(document.querySelectorAll('div.fixed.inset-0.z-50'))
      .find(d => /设置/.test((d.querySelector('span.text-lg')||{}).textContent||''));
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    const activeLabel = (navBtns.find(b => b.querySelector('span.absolute.opacity-100, span.absolute.w-8')) || {});
    // 通过指示条 class 判断哪个 tab 处于选中态
    let active = null;
    navBtns.forEach(b => { const bar=b.querySelector('span.absolute');
      if (bar && /opacity-100/.test(bar.className)) active = (b.innerText||'').trim(); });
    return {
      drawerInDom: !!ov,
      drawerVisible: !!(ov && ov.getBoundingClientRect().height > 100),
      activeTabLabel: active,
      calendarGridVisible: !!(document.querySelector('.grid.grid-cols-7.gap-1\\\\.5')||{}).offsetParent
    };
  })()`);
  const click = (sel) => ev(`(function(){ const e=${sel}; if(!e) return 'NOTFOUND'; e.click(); return 'ok'; })()`);

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate',{url:URL}); await sleep(1600);

  console.log('── 用例A：tabs 数组契约未被破坏（verify_payroll 用例20 依赖）');
  const tabsInfo = await ev(`(function(){
    const bs = Array.from(document.querySelectorAll('nav button'));
    return { count: bs.length, labels: bs.map(b=>(b.innerText||'').trim()) };
  })()`);
  ok('底栏 3 个 Tab', tabsInfo.count===3, tabsInfo.count);
  ok('顺序 打卡/汇总/设置', JSON.stringify(tabsInfo.labels)==='["打卡","汇总","设置"]', tabsInfo.labels.join(','));

  console.log('\n── 用例B：初始态');
  let s = await probe();
  ok('抽屉未渲染', s.drawerInDom===false);
  ok('停在打卡页', s.activeTabLabel==='打卡', s.activeTabLabel);

  console.log('\n── 用例C：header 齿轮打开抽屉，且不切 tab');
  await click(`Array.from(document.querySelectorAll('header button')).find(b=>b.title==='设置')`);
  await sleep(450);
  s = await probe();
  ok('抽屉已展开', s.drawerVisible===true);
  ok('tab 仍是打卡（未整页切换）', s.activeTabLabel==='打卡', s.activeTabLabel);
  const formOk = await ev(`(function(){ const t=document.body.innerText; return { 时薪: /基础时薪/.test(t), 数据: /导出备份/.test(t), 滚动容器: !!document.querySelector('.overflow-y-auto.no-scrollbar[class*="72vh"]') }; })()`);
  ok('抽屉内含薪酬规则表单', formOk.时薪===true);
  ok('抽屉内含数据管理', formOk.数据===true);
  ok('内容区有 72vh 滚动容器', formOk.滚动容器===true);
  await shot('d1_drawer_open.png');

  console.log('\n── 用例D：关闭方式① 点 ✕');
  await click(`(function(){ const ov=Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(d=>/设置/.test((d.querySelector('span.text-lg')||{}).textContent||'')); return ov && ov.querySelectorAll('button')[0]; })()`);
  await sleep(450);
  s = await probe();
  ok('抽屉已关闭', s.drawerInDom===false);
  ok('tab 仍是打卡', s.activeTabLabel==='打卡', s.activeTabLabel);

  console.log('\n── 用例E：底部 Tab「设置」打开抽屉，且不切 tab');
  await click(`Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').trim()==='设置')`);
  await sleep(450);
  s = await probe();
  ok('抽屉已展开', s.drawerVisible===true);
  ok('tab 未切到 settings（底栏高亮仍在打卡）', s.activeTabLabel==='打卡', s.activeTabLabel);

  console.log('\n── 用例F：关闭方式② 点遮罩（@click.self）');
  await click(`Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(d=>/设置/.test((d.querySelector('span.text-lg')||{}).textContent||''))`);
  await sleep(450);
  s = await probe();
  ok('抽屉已关闭', s.drawerInDom===false);

  console.log('\n── 用例G：关闭方式③ 点下滑把手');
  await click(`Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').trim()==='设置')`);
  await sleep(450);
  await click(`(function(){ const ov=Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(d=>/设置/.test((d.querySelector('span.text-lg')||{}).textContent||'')); return ov && ov.querySelector('div.pt-2\\\\.5'); })()`);
  await sleep(450);
  s = await probe();
  ok('抽屉已关闭', s.drawerInDom===false);

  console.log('\n── 用例H：抽屉与「汇总」页共存（在汇总页也能开）');
  await click(`Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').trim()==='汇总')`);
  await sleep(400);
  await click(`Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').trim()==='设置')`);
  await sleep(450);
  s = await probe();
  ok('汇总页也能开抽屉', s.drawerVisible===true);
  ok('底栏高亮仍在汇总', s.activeTabLabel==='汇总', s.activeTabLabel);
  await shot('d2_drawer_on_summary.png');

  console.log('\n=== 异常/控制台 ===');
  console.log(logs.length?logs.join('\n'):'(无异常)');
  console.log('\n==============================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==============================================');
  ws.close(); chrome.kill(); process.exit(fail?1:0);
})().catch(e=>{ console.error('FAILED:',e.message); console.error(stderr.join('').slice(-400)); try{chrome.kill();}catch(_){}process.exit(1); });
