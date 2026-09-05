// 独立验证「首次登录」的真实 UI 路径（doLogin），不走底层 pullAll。
//
// 为什么要单独测：verify_sync_e2e.js 的 C 步直接调 window.WHTSync.pullAll()，
// 而这个底层方法的语义本身就是「用服务器覆盖本机」—— 它把本地 2 天冲掉是预期行为，
// 证明不了 UI 登录路径安全。UI 走 doLogin，必须用真实点击路径独立验证。
//
// 六个场景（全部走「填表单 + 点登录按钮」）：
//   A  远端空 + 本地有        → 本地不能丢，且应上传
//   B  远端有 + 本地空        → 应拉全量
//   C  远端有 + 本地有(不同天) → 双向并集，两边都不能丢
//   D  同一天内容不同         → 弹合并窗；选「保留本机」
//   E  同一天内容不同         → 弹合并窗；选「用服务器版本」
//   F  同一天内容不同         → 选「先不处理」→ 必须冻结自动同步，数据一动不动
//
// 前置：server 跑在 9524（ALLOW_REGISTER=1，独立 DB /tmp/wht-login.db），静态页同源

const { spawn } = require('child_process');
const fs = require('fs');
const OUT = '/root/.openclaw/workspace/work-hours-tracker/png';
const BASE = 'http://127.0.0.1:9524';
const PAGE = BASE + '/index.html';
const PW = 'login-test-2026';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  if (!ok) console.log(`       实际=${got}\n       期望=${want}`);
};

const REC = (h, sh = 'day', extra = {}) => Object.assign({
  status: 'work', shift_type: sh, hours: h,
  contraband_found: 0, contraband_missed: 0, other_penalty: null, penalty_reason: ''
}, extra);

// ---------- node 侧直连服务端（独立 token，与浏览器会话互不干扰）----------
// 注意：core/api.js 的登录限流是 10 次/分钟/IP，而 clientKey 在没有代理头时统一落到 'local'。
// node 侧预置 6 个账号各登一次 + 浏览器 6 次登录 = 12 次，会把同一个桶打穿（实测 429）。
// 所以 node 侧请求带上各自的 x-forwarded-for，分到独立桶，把限额留给真正要测的 UI 登录。
const ipOf = u => '10.9.' + (users.indexOf(u) + 1) + '.1';
const jf = async (path, opt = {}) => {
  const r = await fetch(BASE + path, opt);
  return r.json();
};
const H = (u, extra = {}) => Object.assign({ 'content-type': 'application/json', 'x-forwarded-for': ipOf(u) }, extra);

async function reg(u) {
  const d = await jf('/api/register', { method: 'POST', headers: H(u), body: JSON.stringify({ username: u, password: PW }) });
  if (!d.ok) throw new Error('注册失败 ' + u + ': ' + d.error);
}
async function tok(u) {
  const d = await jf('/api/login', { method: 'POST', headers: H(u), body: JSON.stringify({ username: u, password: PW }) });
  if (!d.ok) throw new Error('登录失败 ' + u + ': ' + d.error);
  return d.token;
}
async function srvPush(u, body) {
  const d = await jf('/api/push', {
    method: 'POST', headers: H(u, { authorization: 'Bearer ' + T[u] }), body: JSON.stringify(body)
  });
  if (!d.ok) throw new Error('push 失败: ' + d.error);
  return d;
}
async function srvDump(u) {
  return jf('/api/data', { headers: { authorization: 'Bearer ' + T[u], 'x-forwarded-for': ipOf(u) } });
}
async function srvDays(u) {
  const d = await srvDump(u);
  return Object.keys(d.records || {}).sort().join(',') || '(空)';
}
async function srvDay(u, day) {
  const d = await srvDump(u);
  const r = (d.records || {})[day];
  return r ? `${r.shift_type} ${r.hours}h` : '(无)';
}

const users = ['ut.a', 'ut.b', 'ut.c', 'ut.d', 'ut.e', 'ut.f'];
const T = {};

(async () => {
  console.log('=== 0. 预置服务端账号与数据 ===');
  for (const u of users) await reg(u);
  for (const u of users) T[u] = await tok(u);

  // B/C：服务端 2 天，与本地不重叠
  const seedBC = { records: { '2026-09-01': REC(8), '2026-09-03': REC(10, 'night') } };
  await srvPush('ut.b', seedBC);
  await srvPush('ut.c', seedBC);

  // D/E/F：服务端 9-01 白班 8h（本地同一天将是夜班 12h → 冲突）+ 服务端独有 9-03
  const seedConf = { records: { '2026-09-01': REC(8, 'day'), '2026-09-03': REC(10, 'night') } };
  for (const u of ['ut.d', 'ut.e', 'ut.f']) await srvPush(u, seedConf);

  for (const u of users) console.log(`  ${u} 服务端 =`, await srvDays(u));

  // ---------- 起浏览器 ----------
  const chrome = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=9262', `--user-data-dir=${OUT}/.chrome-login`,
    '--window-size=360,900', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await (async () => {
    for (let i = 0; i < 40; i++) {
      try { const t = await (await fetch('http://127.0.0.1:9262/json/list')).json(); if (t.length) return t[0].webSocketDebuggerUrl; } catch {}
      await sleep(250);
    }
    throw new Error('CDP 起不来');
  })();

  const ws = new WebSocket(wsUrl);
  let id = 0; const pnd = new Map();
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pnd.has(m.id)) { pnd.get(m.id)(m); pnd.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pnd.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      const ed = r.result.exceptionDetails;
      return 'JS_ERR: ' + ((ed.exception && ed.exception.description) || ed.text);
    }
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 2, mobile: true });
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text);
  });

  // ---------- 页面操作原语 ----------
  const openSettings = () => ev(`(function(){const b=Array.from(document.querySelectorAll('button')).find(x=>x.getAttribute&&x.getAttribute('title')==='设置');if(b){b.click();return 'ok';}return 'NO_GEAR';})()`);

  /** 走真实 UI：开设置抽屉 → 填账号密码 → 点「登录」。waitMs 为登录后等待时长。 */
  const uiLogin = async (u, waitMs = 2600) => {
    const g = await openSettings();
    if (g !== 'ok') throw new Error('齿轮点不到: ' + g);
    await sleep(600);
    const filled = await ev(`(function(){
      const card=Array.from(document.querySelectorAll('.card')).find(c=>/云端同步/.test(c.innerText));
      if(!card) return 'NO_CARD';
      const ins=card.querySelectorAll('input');
      const u=Array.from(ins).find(i=>i.type==='text'&&/用户名/.test(i.placeholder));
      const p=Array.from(ins).find(i=>i.type==='password');
      if(!u||!p) return 'NO_INPUT';
      const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
      set(u,${JSON.stringify(u)}); set(p,${JSON.stringify(PW)});
      return 'ok';
    })()`);
    if (filled !== 'ok') throw new Error('表单填写失败: ' + filled);
    await sleep(250);
    const clicked = await ev(`(function(){
      const card=Array.from(document.querySelectorAll('.card')).find(c=>/云端同步/.test(c.innerText));
      const b=Array.from(card.querySelectorAll('button')).find(x=>x.innerText.trim()==='登录');
      if(!b) return 'NO_BTN'; b.click(); return 'ok';
    })()`);
    if (clicked !== 'ok') throw new Error('登录按钮点不到: ' + clicked);
    await sleep(waitMs);
  };

  const localDays = () => ev(`Object.keys(JSON.parse(localStorage.getItem('work_records')||'{}')).sort().join(',')||'(空)'`);
  const localDay = d => ev(`(function(){const r=(JSON.parse(localStorage.getItem('work_records')||'{}'))[${JSON.stringify(d)}];return r?r.shift_type+' '+r.hours+'h':'(无)';})()`);

  // toast 只停留两秒就消，事后去读 DOM 必然是空。用 MutationObserver 全程录下来。
  const installToastRecorder = () => ev(`(function(){
    window.__toasts=[];
    const seen=new Set();
    const scan=()=>{
      document.querySelectorAll('div').forEach(d=>{
        const c=d.className;
        if(typeof c==='string'&&c.indexOf('bg-slate-800/95')>=0&&c.indexOf('rounded-full')>=0){
          const t=(d.innerText||'').trim();
          if(t&&!seen.has(t)){seen.add(t);window.__toasts.push(t);}
        }
      });
    };
    if(window.__toastRec) window.__toastRec.disconnect();
    window.__toastRec=new MutationObserver(scan);
    window.__toastRec.observe(document.body,{childList:true,subtree:true,characterData:true});
    scan();
    return 'ok';
  })()`);
  const toasts = () => ev(`((window.__toasts||[]).join(' ‖ '))||'(无 toast)'`);
  const clearToasts = () => ev(`(function(){window.__toasts=[];return 1;})()`);

  const mergeVisible = () => ev(`(function(){const els=Array.from(document.querySelectorAll('h3')).filter(h=>/本机与服务器有冲突/.test(h.innerText));return els.length>0;})()`);
  const mergeBody = () => ev(`(function(){const h=Array.from(document.querySelectorAll('h3')).find(x=>/本机与服务器有冲突/.test(x.innerText));if(!h)return'(无弹窗)';return h.closest('div.w-full').innerText.replace(/\\n+/g,' | ');})()`);
  const clickMerge = re => ev(`(function(){
    const h=Array.from(document.querySelectorAll('h3')).find(x=>/本机与服务器有冲突/.test(x.innerText));
    if(!h) return 'NO_DIALOG';
    const b=Array.from(h.closest('div.w-full').querySelectorAll('button')).find(x=>${re}.test(x.innerText));
    if(!b) return 'NO_BTN'; b.click(); return 'ok';
  })()`);

  const resetLocal = async (recs) => {
    await send('Page.navigate', { url: PAGE }); await sleep(1400);
    await ev(`(function(){localStorage.clear();${recs ? `localStorage.setItem('work_records',JSON.stringify(${JSON.stringify(recs)}));` : ''}return 1;})()`);
    await send('Page.navigate', { url: PAGE }); await sleep(1700);
    await installToastRecorder();
  };

  // ==================== A ====================
  console.log('\n=== A. 远端空 + 本地 2 天 → 本地不能丢，且应上传 ===');
  await resetLocal({ '2026-09-20': REC(10, 'night'), '2026-09-21': REC(8) });
  console.log('  登录前本地 =', await localDays());
  await uiLogin('ut.a');
  console.log('  toast =', await toasts());
  ck('A1 登录后本地记录（不能丢）', await localDays(), '2026-09-20,2026-09-21');
  ck('A2 服务端已收到本地数据', await srvDays('ut.a'), '2026-09-20,2026-09-21');
  ck('A3 pending 归零', await ev(`window.WHTSync.state.pending`), '0');
  ck('A4 未误弹合并窗', await mergeVisible(), 'false');

  // ==================== B ====================
  console.log('\n=== B. 远端 2 天 + 本地空 → 应拉全量 ===');
  await resetLocal(null);
  console.log('  登录前本地 =', await localDays());
  await uiLogin('ut.b');
  console.log('  toast =', await toasts());
  ck('B1 拉到远端 2 天', await localDays(), '2026-09-01,2026-09-03');
  ck('B2 服务端未被空本地覆盖', await srvDays('ut.b'), '2026-09-01,2026-09-03');

  // ==================== C ====================
  console.log('\n=== C. 远端 2 天 + 本地 1 天(不同) → 双向并集 ===');
  await resetLocal({ '2026-09-25': REC(12, 'night') });
  console.log('  登录前本地 =', await localDays());
  await uiLogin('ut.c');
  console.log('  toast =', await toasts());
  ck('C1 本地应含三天', await localDays(), '2026-09-01,2026-09-03,2026-09-25');
  ck('C2 服务端应含三天', await srvDays('ut.c'), '2026-09-01,2026-09-03,2026-09-25');
  ck('C3 无冲突不该弹窗', await mergeVisible(), 'false');

  // ==================== D ====================
  console.log('\n=== D. 同一天内容不同 → 弹窗 + 选「保留本机」===');
  await resetLocal({ '2026-09-01': REC(12, 'night'), '2026-09-25': REC(8) });
  console.log('  登录前本地 9-01 =', await localDay('2026-09-01'), ' 服务端 9-01 =', await srvDay('ut.d', '2026-09-01'));
  await uiLogin('ut.d', 2000);
  ck('D1 弹出合并窗', await mergeVisible(), 'true');
  console.log('  弹窗内容 =', (await mergeBody()).slice(0, 260));
  ck('D2 弹窗未擅自改本地', await localDay('2026-09-01'), 'night 12h');
  const shotD = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '/merge_dialog.png', Buffer.from(shotD.result.data, 'base64'));
  ck('D3 点「保留本机」', await clickMerge('/保留本机/'), 'ok');
  await sleep(2600);
  console.log('  toast =', await toasts());
  ck('D4 冲突日保留本机值', await localDay('2026-09-01'), 'night 12h');
  ck('D5 服务端冲突日被本机覆盖', await srvDay('ut.d', '2026-09-01'), 'night 12h');
  ck('D6 本地含三天（并集）', await localDays(), '2026-09-01,2026-09-03,2026-09-25');
  ck('D7 服务端含三天（并集）', await srvDays('ut.d'), '2026-09-01,2026-09-03,2026-09-25');
  ck('D8 合并前留了本机快照', await ev(`!!(window.WHTSync.getLocalSnapshot()||{}).records`), 'true');

  // ==================== E ====================
  console.log('\n=== E. 同一天内容不同 → 选「用服务器版本」===');
  await resetLocal({ '2026-09-01': REC(12, 'night'), '2026-09-25': REC(8) });
  await uiLogin('ut.e', 2000);
  ck('E1 弹出合并窗', await mergeVisible(), 'true');
  ck('E2 点「用服务器版本」', await clickMerge('/服务器版本/'), 'ok');
  await sleep(2600);
  console.log('  toast =', await toasts());
  ck('E3 冲突日改用服务器值', await localDay('2026-09-01'), 'day 8h');
  ck('E4 本机独有的天仍在（没被覆盖掉）', await localDay('2026-09-25'), 'day 8h');
  ck('E5 本地含三天', await localDays(), '2026-09-01,2026-09-03,2026-09-25');
  ck('E6 服务端含三天', await srvDays('ut.e'), '2026-09-01,2026-09-03,2026-09-25');
  ck('E7 服务端冲突日保持原值', await srvDay('ut.e', '2026-09-01'), 'day 8h');

  // ==================== F ====================
  console.log('\n=== F. 选「先不处理」→ 必须冻结自动同步 ===');
  await resetLocal({ '2026-09-01': REC(12, 'night'), '2026-09-25': REC(8) });
  await uiLogin('ut.f', 2000);
  ck('F1 弹出合并窗', await mergeVisible(), 'true');
  ck('F2 点「先不处理」', await clickMerge('/先不处理/'), 'ok');
  await sleep(800);
  console.log('  toast =', await toasts());
  ck('F3 已置同步冻结标志', await ev(`!!window.WHTSync.state.hold`), 'true');
  ck('F4 本地一动不动', await localDays(), '2026-09-01,2026-09-25');
  ck('F5 状态胶囊提示冲突', await ev(`(function(){const c=Array.from(document.querySelectorAll('.card')).find(x=>/云端同步/.test(x.innerText));return c?/已暂停同步/.test(c.innerText):'NO_CARD';})()`), 'true');

  console.log('  —— 冻结期间做一次本地改动，验证不会偷偷同步 ——');
  await ev(`(function(){
    const r=JSON.parse(localStorage.getItem('work_records')||'{}');
    r['2026-09-28']={status:'work',shift_type:'day',hours:8,contraband_found:0,contraband_missed:0,other_penalty:null,penalty_reason:''};
    localStorage.setItem('work_records',JSON.stringify(r));
    window.WHTSync.markDirty('record','2026-09-28');
    return 1;})()`);
  await sleep(4000);   // 远超 1.5s 防抖窗口
  ck('F6 改动只攒着不上传', await ev(`window.WHTSync.state.pending`), '1');
  ck('F7 服务端未被偷偷写入', await srvDays('ut.f'), '2026-09-01,2026-09-03');
  ck('F8 本地 9-01 仍是本机值（远端没覆盖过来）', await localDay('2026-09-01'), 'night 12h');

  console.log('  —— 冻结后从同步面板重新进合并 ——');
  await openSettings(); await sleep(500);
  ck('F9 点「比对本机与服务器」', await ev(`(function(){const c=Array.from(document.querySelectorAll('.card')).find(x=>/云端同步/.test(x.innerText));const b=Array.from(c.querySelectorAll('button')).find(x=>/比对本机与服务器/.test(x.innerText));if(!b)return'NO_BTN';b.click();return 'ok';})()`), 'ok');
  await sleep(2200);
  ck('F10 合并窗重新弹出', await mergeVisible(), 'true');
  ck('F11 选「保留本机」收尾', await clickMerge('/保留本机/'), 'ok');
  await sleep(2800);
  ck('F12 冻结已解除', await ev(`!!window.WHTSync.state.hold`), 'false');
  ck('F13 服务端补齐四天', await srvDays('ut.f'), '2026-09-01,2026-09-03,2026-09-25,2026-09-28');
  ck('F14 pending 归零', await ev(`window.WHTSync.state.pending`), '0');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '/login_merge_done.png', Buffer.from(shot.result.data, 'base64'));

  console.log('\n=== 控制台错误 ===');
  console.log(errs.length ? errs.slice(0, 6).join('\n') : '  无');
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  ws.close(); chrome.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
