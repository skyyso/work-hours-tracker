/**
 * 客户端同步引擎（离线优先）
 *
 * 设计原则：
 *   1. localStorage 仍然是本地的唯一真相 —— 断网、服务器挂了、没登录，页面照常能用。
 *      同步只是「额外把数据推到服务器」，绝不是「必须联网才能记账」。
 *   2. 每次本地写入都把改动的键记进 dirty 集合。同步时先 push dirty，再 pull 远端变更。
 *      push 在前 → 本地改动天然赢，不会被远端旧值覆盖。
 *   3. 用服务端的单调 rev 做增量：只拉 rev 比本地已知值新的变更，不做全量对比。
 *   4. 这一层不依赖 Vue，也不依赖浏览器独有 API（除 localStorage/fetch），
 *      以后套 APP 壳（Capacitor / WebView / RN）可以整块复用。
 *
 * 暴露：window.WHTSync
 */
(function () {
  'use strict';

  const LS = {
    records: 'work_records',
    adjust: 'work_month_adjust',
    settings: 'work_settings',
    token: 'work_sync_token',
    user: 'work_sync_user',
    rev: 'work_sync_rev',
    dirty: 'work_sync_dirty',
    base: 'work_sync_base',
    snapshot: 'work_local_snapshot',
    hold: 'work_sync_hold'
  };

  const readLS = (k, fallback) => {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  };
  const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---------- 脏键集合 ----------
  // 形如 { records: ['2026-09-01', ...], adjust: ['2026-09'], settings: true }
  function loadDirty() {
    const d = readLS(LS.dirty, null);
    return {
      records: new Set((d && d.records) || []),
      adjust: new Set((d && d.adjust) || []),
      settings: !!(d && d.settings)
    };
  }
  function saveDirty(d) {
    writeLS(LS.dirty, {
      records: [...d.records],
      adjust: [...d.adjust],
      settings: d.settings
    });
  }

  // ---------- 状态 ----------
  const state = {
    // idle 未登录 / ready 已登录空闲 / syncing 同步中 / error 出错 / offline 连不上
    status: 'idle',
    user: readLS(LS.user, null),
    token: readLS(LS.token, null),
    rev: readLS(LS.rev, 0) || 0,
    pending: 0,
    lastSyncAt: null,
    lastError: '',
    // 冲突未解决时的硬刷阀。一旦置上，自动同步全部停止。
    // 必须落 localStorage：否则用户选了「先不处理」后一刷新，阀就没了，
    // 下一次 syncNow 会把远端值静默盖到本机冲突日上。
    hold: readLS(LS.hold, null),
    serverUsers: null   // health 探测到的服务端用户数，用于判断该显示「注册」还是「登录」
  };
  const dirty = loadDirty();
  state.pending = dirty.records.size + dirty.adjust.size + (dirty.settings ? 1 : 0);

  const listeners = new Set();
  function emit() {
    const snap = { ...state };
    listeners.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  }
  function setStatus(s, err) {
    state.status = s;
    state.lastError = err || '';
    emit();
  }

  function apiBase() {
    const saved = readLS(LS.base, '');
    if (saved) return String(saved).replace(/\/+$/, '');
    return location.origin;   // 默认同源：VPS 与 CF Workers 都是页面与 API 同一个域
  }

  async function api(path, { method = 'GET', body, auth = true, timeoutMs = 15000 } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && state.token) headers.authorization = 'Bearer ' + state.token;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(apiBase() + path, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal
      });
    } catch (e) {
      throw Object.assign(new Error(e.name === 'AbortError' ? '连接超时' : '无法连接服务器'), { offline: true });
    } finally { clearTimeout(timer); }

    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401) {
      // 令牌失效：清掉登录态但保留本地数据与 dirty，用户重新登录后照样能推上去
      state.token = null; state.user = null;
      localStorage.removeItem(LS.token);
      localStorage.removeItem(LS.user);
      throw Object.assign(new Error((data && data.error) || '登录已失效'), { unauthorized: true });
    }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  // ---------- 行 → 前端结构 ----------
  function rowToRecord(r) {
    return {
      status: r.status,
      shift_type: r.shift_type,
      hours: r.hours,
      contraband_found: r.contraband_found || 0,
      contraband_missed: r.contraband_missed || 0,
      other_penalty: r.other_penalty === undefined ? null : r.other_penalty,
      penalty_reason: r.penalty_reason || ''
    };
  }
  function rowToAdjust(r) {
    return {
      status: r.status,
      finalAmount: r.final_amount === undefined ? null : r.final_amount,
      note: r.note || '',
      finalizedAt: r.finalized_at || ''
    };
  }

  // ---------- 本地 / 远端比对 ----------
  // 首次登录要在「不写本地」的前提下判断两边差异，才能决定谁该赢、要不要问用户。
  const REC_FIELDS = ['status', 'shift_type', 'hours', 'contraband_found', 'contraband_missed', 'other_penalty', 'penalty_reason'];
  const ADJ_FIELDS = ['status', 'finalAmount', 'note'];   // finalizedAt 是时间戳，两边天然不同，不算差异

  function sameBy(fields, a, b) {
    if (!a || !b) return false;
    for (const f of fields) {
      const x = a[f], y = b[f];
      const xn = (x === '' || x === null || x === undefined) ? null : x;
      const yn = (y === '' || y === null || y === undefined) ? null : y;
      if (typeof xn === 'number' || typeof yn === 'number') {
        if (Number(xn || 0) !== Number(yn || 0)) return false;
      } else if (String(xn ?? '') !== String(yn ?? '')) return false;
    }
    return true;
  }

  // 应用远端变更到本地。onApply 由页面提供，负责写回 Vue 响应式数据并落 localStorage。
  let applyHook = null;

  function applyRemote(payload) {
    if (!applyHook) return 0;
    const recs = {}, adjs = {};
    let n = 0;
    for (const [day, row] of Object.entries(payload.records || {})) {
      // 本地还没推上去的键不许被远端覆盖，否则用户刚记的会被旧数据吃掉
      if (dirty.records.has(day)) continue;
      recs[day] = row.deleted ? null : rowToRecord(row);
      n++;
    }
    for (const [month, row] of Object.entries(payload.adjust || {})) {
      if (dirty.adjust.has(month)) continue;
      adjs[month] = row.deleted ? null : rowToAdjust(row);
      n++;
    }
    const settings = (payload.settings && !dirty.settings) ? payload.settings : null;
    if (settings) n++;
    if (n > 0) applyHook({ records: recs, adjust: adjs, settings });
    return n;
  }

  // ---------- 同步 ----------
  let syncing = false;
  let queued = false;

  async function syncNow({ silent = false, force = false } = {}) {
    if (!state.token) { if (!silent) setStatus('idle'); return { ok: false, reason: 'not-logged-in' }; }
    // 冲突未解决 → 两个方向都停。只 push 不 pull 也不行：服务端会被本机静默覆盖。
    if (state.hold && !force) return { ok: false, reason: 'conflict-hold', hold: state.hold };
    if (syncing) { queued = true; return { ok: false, reason: 'busy' }; }
    syncing = true;
    setStatus('syncing');
    // 拉取的起点必须是「推之前」的 rev。
    // push 会把 rev 抬到一个新值并给推上去的行都打上它，若用推完的 rev 去 changes，
    // 那些 rev 更小的行（别的设备早先推上来的）就会被整段跳过 —— 首次登录会一条都拉不到。
    const revBefore = state.rev;
    let pushed = 0;
    try {
      // 1) 推本地脏数据
      if (dirty.records.size || dirty.adjust.size || dirty.settings) {
        const allRecords = readLS(LS.records, {}) || {};
        const allAdjust = readLS(LS.adjust, {}) || {};
        const payload = { records: {}, monthAdjust: {} };
        // 本地已删除的键 → 传 null，服务端写墓碑，其他设备才能同步到「这天被删了」
        for (const day of dirty.records) payload.records[day] = allRecords[day] ?? null;
        for (const m of dirty.adjust) payload.monthAdjust[m] = allAdjust[m] ?? null;
        if (dirty.settings) payload.settings = readLS(LS.settings, {}) || {};
        pushed = Object.keys(payload.records).length + Object.keys(payload.monthAdjust).length + (payload.settings ? 1 : 0);

        await api('/api/push', { method: 'POST', body: payload });
        dirty.records.clear(); dirty.adjust.clear(); dirty.settings = false;
        saveDirty(dirty);
        state.pending = 0;
        // 这里刻意不写 state.rev：留给下面的 changes 用 revBefore 起拉，
        // 自己刚推的行会被一起拉回来（值相同，幂等），但远端旧行不会漏。
      }

      // 2) 拉远端增量
      const got = await api(`/api/changes?since=${revBefore}`);
      const applied = applyRemote(got);
      state.rev = got.rev;
      writeLS(LS.rev, state.rev);
      state.lastSyncAt = new Date().toISOString();
      setStatus('ready');
      return { ok: true, applied, pushed, rev: state.rev };
    } catch (e) {
      if (e.unauthorized) setStatus('idle', e.message);
      else if (e.offline) setStatus('offline', e.message);
      else setStatus('error', e.message);
      return { ok: false, error: e.message };
    } finally {
      syncing = false;
      if (queued) { queued = false; setTimeout(() => syncNow({ silent: true }), 300); }
    }
  }

  let debounceTimer = null;
  function scheduleSync(delay = 1500) {
    if (!state.token || state.hold) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => syncNow({ silent: true }), delay);
  }

  // ---------- 对外接口 ----------
  const WHTSync = {
    get state() { return { ...state }; },

    onChange(fn) { listeners.add(fn); fn({ ...state }); return () => listeners.delete(fn); },

    /** 页面注册「如何把远端数据写进本地」 */
    setApplyHook(fn) { applyHook = fn; },

    setApiBase(v) {
      const s = String(v || '').trim().replace(/\/+$/, '');
      if (s) writeLS(LS.base, s); else localStorage.removeItem(LS.base);
      emit();
    },
    getApiBase: apiBase,

    /** 标记本地改动。key 为日期(YYYY-MM-DD) / 月份(YYYY-MM) / 'settings' */
    markDirty(kind, key) {
      if (kind === 'record') dirty.records.add(key);
      else if (kind === 'adjust') dirty.adjust.add(key);
      else if (kind === 'settings') dirty.settings = true;
      else return;
      saveDirty(dirty);
      state.pending = dirty.records.size + dirty.adjust.size + (dirty.settings ? 1 : 0);
      emit();
      scheduleSync();
    },

    /**
     * 把本机现有全部数据标记为待上传。
     * 用于首次登录：此前本机的数据都是用户自己录的，一条都不能被远端悄悄吃掉。
     * @param {object} opts
     *   settings  是否连设置一起推（远端已有设置时应传 false，避免本机默认值盖掉远端）
     *   excludeRecords / excludeAdjust  这些键不标脏 → 同步时让远端版本落地（用户选了「用服务器版本」）
     */
    markAllLocalDirty({ settings = true, excludeRecords = [], excludeAdjust = [] } = {}) {
      const exR = new Set(excludeRecords), exA = new Set(excludeAdjust);
      const recs = readLS(LS.records, {}) || {};
      const adjs = readLS(LS.adjust, {}) || {};
      let nr = 0, na = 0;
      for (const k of Object.keys(recs)) if (!exR.has(k)) { dirty.records.add(k); nr++; }
      for (const k of Object.keys(adjs)) if (!exA.has(k)) { dirty.adjust.add(k); na++; }
      if (settings) dirty.settings = true;
      saveDirty(dirty);
      state.pending = dirty.records.size + dirty.adjust.size + (dirty.settings ? 1 : 0);
      emit();
      return { records: nr, adjust: na };
    },

    /** 只读拉一份服务端快照：不写本地、不动 dirty、不改 rev。用于登录前先看清两边差异。 */
    async peekRemote() {
      return api('/api/data');
    },

    /**
     * 比对本机与一份远端快照（peekRemote 的返回值）。
     * @returns { onlyLocal, onlyRemote, conflict, same, remoteHasSettings }
     *          conflict = 两边都有这一天但内容不同 —— 只有这种情况才需要让用户决定
     */
    diffLocal(dump) {
      const out = {
        onlyLocal: [], onlyRemote: [], conflict: [], same: [],
        adjustOnlyLocal: [], adjustOnlyRemote: [], adjustConflict: [],
        conflictDetail: [], adjustConflictDetail: [],
        settingsDiff: [],
        remoteHasSettings: !!(dump && dump.settings && Object.keys(dump.settings).length)
      };
      const localR = readLS(LS.records, {}) || {};
      const localA = readLS(LS.adjust, {}) || {};
      const localS = readLS(LS.settings, {}) || {};
      const remoteR = (dump && dump.records) || {};
      const remoteA = (dump && dump.adjust) || {};
      const remoteS = (dump && dump.settings) || {};

      for (const k of Object.keys(localR)) {
        if (!(k in remoteR)) out.onlyLocal.push(k);
        else {
          const rem = rowToRecord(remoteR[k]);
          if (sameBy(REC_FIELDS, localR[k], rem)) out.same.push(k);
          else { out.conflict.push(k); out.conflictDetail.push({ key: k, local: localR[k], remote: rem }); }
        }
      }
      for (const k of Object.keys(remoteR)) if (!(k in localR)) out.onlyRemote.push(k);

      for (const k of Object.keys(localA)) {
        if (!(k in remoteA)) out.adjustOnlyLocal.push(k);
        else {
          const rem = rowToAdjust(remoteA[k]);
          if (!sameBy(ADJ_FIELDS, localA[k], rem)) {
            out.adjustConflict.push(k);
            out.adjustConflictDetail.push({ key: k, local: localA[k], remote: rem });
          }
        }
      }
      for (const k of Object.keys(remoteA)) if (!(k in localA)) out.adjustOnlyRemote.push(k);

      // 设置只比两边都有的字段：远端没存过某字段不算冲突（旧版本推上去的数据可能就没那个字段）
      for (const k of Object.keys(remoteS)) {
        if (localS[k] === undefined) continue;
        if (Number(localS[k]) !== Number(remoteS[k]) && String(localS[k]) !== String(remoteS[k])) {
          out.settingsDiff.push({ key: k, local: localS[k], remote: remoteS[k] });
        }
      }

      [out.onlyLocal, out.onlyRemote, out.conflict, out.same,
       out.adjustOnlyLocal, out.adjustOnlyRemote, out.adjustConflict].forEach(a => a.sort());
      out.conflictDetail.sort((a, b) => a.key < b.key ? -1 : 1);
      return out;
    },

    /** 合并前留一份本机快照。远端覆盖本机这类操作出意外时，至少数据还在。 */
    snapshotLocal(tag) {
      const snap = {
        at: new Date().toISOString(),
        tag: tag || '',
        records: readLS(LS.records, {}) || {},
        adjust: readLS(LS.adjust, {}) || {},
        settings: readLS(LS.settings, {}) || {}
      };
      writeLS(LS.snapshot, snap);
      return snap;
    },

    getLocalSnapshot() { return readLS(LS.snapshot, null); },

    /**
     * 挂起自动同步。用户在冲突弹窗选了「先不处理」时必须调。
     * 不挂起的后果：下一次任意改动触发 syncNow → pull 会把远端值盖到本机冲突日上，
     * 用户看到的就是「我明明选了不处理，数据自己变了」。
     */
    holdSync(reason) {
      state.hold = { reason: reason || 'conflict', at: new Date().toISOString() };
      writeLS(LS.hold, state.hold);
      clearTimeout(debounceTimer);
      emit();
    },

    releaseSync() {
      state.hold = null;
      localStorage.removeItem(LS.hold);
      emit();
    },

    /** 批量标记（导入备份、清空月份等场景） */
    markManyDirty({ records = [], adjust = [], settings = false }) {
      records.forEach(k => dirty.records.add(k));
      adjust.forEach(k => dirty.adjust.add(k));
      if (settings) dirty.settings = true;
      saveDirty(dirty);
      state.pending = dirty.records.size + dirty.adjust.size + (dirty.settings ? 1 : 0);
      emit();
      scheduleSync();
    },

    async health() {
      try {
        const h = await api('/api/health', { auth: false, timeoutMs: 6000 });
        state.serverUsers = h.users;
        emit();
        return h;
      } catch (e) {
        state.serverUsers = null;
        emit();
        throw e;
      }
    },

    async register(username, password) {
      const r = await api('/api/register', { method: 'POST', auth: false, body: { username, password } });
      return r;
    },

    async login(username, password) {
      const r = await api('/api/login', { method: 'POST', auth: false, body: { username, password } });
      state.token = r.token;
      state.user = r.user;
      writeLS(LS.token, r.token);
      writeLS(LS.user, r.user);
      // 换账号/首次登录：从 0 开始拉全量，避免沿用上一个账号的 rev 导致漏数据
      state.rev = 0;
      writeLS(LS.rev, 0);
      setStatus('ready');
      return r;
    },

    async logout({ keepLocal = true } = {}) {
      try { await api('/api/logout', { method: 'POST' }); } catch {}
      state.token = null; state.user = null; state.rev = 0; state.hold = null;
      localStorage.removeItem(LS.token);
      localStorage.removeItem(LS.user);
      localStorage.removeItem(LS.rev);
      localStorage.removeItem(LS.hold);
      if (!keepLocal) {
        localStorage.removeItem(LS.records);
        localStorage.removeItem(LS.adjust);
      }
      setStatus('idle');
    },

    /** 用服务器数据整体覆盖本地（换设备后的首次拉取） */
    async pullAll() {
      const dump = await api('/api/data');
      if (applyHook) {
        const recs = {}, adjs = {};
        for (const [day, row] of Object.entries(dump.records || {})) recs[day] = rowToRecord(row);
        for (const [m, row] of Object.entries(dump.adjust || {})) adjs[m] = rowToAdjust(row);
        applyHook({ records: recs, adjust: adjs, settings: dump.settings || null, replace: true });
      }
      dirty.records.clear(); dirty.adjust.clear(); dirty.settings = false;
      saveDirty(dirty);
      state.pending = 0;
      state.rev = dump.rev;
      writeLS(LS.rev, state.rev);
      state.lastSyncAt = new Date().toISOString();
      // 全量覆盖已经把两边弄成一致了，冲突不再存在
      state.hold = null;
      localStorage.removeItem(LS.hold);
      setStatus('ready');
      return dump;
    },

    /** 把本地全部数据推到服务器（首次上传，或怀疑服务端缺数据时补齐） */
    async pushAll() {
      const records = readLS(LS.records, {}) || {};
      const monthAdjust = readLS(LS.adjust, {}) || {};
      const settings = readLS(LS.settings, {}) || {};
      const r = await api('/api/push', { method: 'POST', body: { records, monthAdjust, settings } });
      dirty.records.clear(); dirty.adjust.clear(); dirty.settings = false;
      saveDirty(dirty);
      state.pending = 0;
      state.rev = r.rev;
      writeLS(LS.rev, state.rev);
      state.lastSyncAt = new Date().toISOString();
      setStatus('ready');
      return r;
    },

    syncNow,
    scheduleSync
  };

  window.WHTSync = WHTSync;

  // 已有令牌 → 进页面就静默同步一次；回到前台、网络恢复时再补一次
  // 冲突挂起中则一步不动，等用户在合并面板里拍板
  if (state.token) {
    state.status = 'ready';
    if (!state.hold) {
      setTimeout(() => syncNow({ silent: true }), 800);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scheduleSync(500);
      });
      window.addEventListener('online', () => scheduleSync(300));
    }
  }
})();
