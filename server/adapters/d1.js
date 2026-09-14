// 存储适配器：Cloudflare D1
//
// 与 sqlite-node.js 行为一致。差异只有两点：
//   1. D1 全异步，用 .bind().all()/.first()/.run()
//   2. 原子写入用 env.DB.batch()（整批在一个事务里），而不是手写 BEGIN/COMMIT
// rev 同样靠 `(SELECT rev FROM users WHERE id=?)` 在 SQL 内部取，保证批次内一致。

export class D1Store {
  constructor(db) { this.db = db; }

  async countUsers() {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM users').first();
    return r ? r.n : 0;
  }

  async getUserByUsername(username) {
    return await this.db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first() || null;
  }

  async getUserById(id) {
    return await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first() || null;
  }

  async createUser({ username, pwHash, pwSalt, pwIter, createdAt }) {
    await this.db.prepare(
      'INSERT INTO users (username, pw_hash, pw_salt, pw_iter, rev, created_at) VALUES (?,?,?,?,0,?)'
    ).bind(username, pwHash, pwSalt, pwIter, createdAt).run();
    return this.getUserByUsername(username);
  }

  async createSession({ tokenHash, userId, createdAt, expiresAt }) {
    await this.db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)'
    ).bind(tokenHash, userId, createdAt, expiresAt).run();
  }

  async getSessionWithUser(tokenHash) {
    const s = await this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
    if (!s) return null;
    const u = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(s.user_id).first();
    if (!u) return null;
    return { session: s, user: u };
  }

  async deleteSession(tokenHash) {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }

  async purgeExpiredSessions(nowIso) {
    const r = await this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso).run();
    return r.meta ? r.meta.changes : 0;
  }

  async getRev(userId) {
    const r = await this.db.prepare('SELECT rev FROM users WHERE id = ?').bind(userId).first();
    return r ? r.rev : 0;
  }

  async applyPush(userId, { records = [], adjust = [], settings = null }) {
    const now = new Date().toISOString();
    const NEW_REV = '(SELECT rev FROM users WHERE id = ?)';
    const stmts = [this.db.prepare('UPDATE users SET rev = rev + 1 WHERE id = ?').bind(userId)];

    const recSql = this.db.prepare(`
      INSERT INTO records (user_id, day, status, shift_type, hours, contraband_found,
                           contraband_missed, other_penalty, penalty_reason, deleted, rev, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,${NEW_REV},?)
      ON CONFLICT(user_id, day) DO UPDATE SET
        status=excluded.status, shift_type=excluded.shift_type, hours=excluded.hours,
        contraband_found=excluded.contraband_found, contraband_missed=excluded.contraband_missed,
        other_penalty=excluded.other_penalty, penalty_reason=excluded.penalty_reason,
        deleted=excluded.deleted, rev=excluded.rev, updated_at=excluded.updated_at
    `);
    for (const r of records) {
      stmts.push(recSql.bind(
        userId, r.day,
        r.deleted ? null : r.status,
        r.deleted ? null : (r.shift_type ?? null),
        r.deleted ? 0 : (r.hours ?? 0),
        r.deleted ? 0 : (r.contraband_found ?? 0),
        r.deleted ? 0 : (r.contraband_missed ?? 0),
        r.deleted ? null : (r.other_penalty ?? null),
        r.deleted ? '' : (r.penalty_reason ?? ''),
        r.deleted ? 1 : 0,
        userId, now
      ));
    }

    const adjSql = this.db.prepare(`
      INSERT INTO month_adjust (user_id, month, status, final_amount, note, finalized_at, deleted, rev, updated_at)
      VALUES (?,?,?,?,?,?,?,${NEW_REV},?)
      ON CONFLICT(user_id, month) DO UPDATE SET
        status=excluded.status, final_amount=excluded.final_amount, note=excluded.note,
        finalized_at=excluded.finalized_at, deleted=excluded.deleted,
        rev=excluded.rev, updated_at=excluded.updated_at
    `);
    for (const a of adjust) {
      stmts.push(adjSql.bind(
        userId, a.month,
        a.deleted ? 'draft' : a.status,
        a.deleted ? null : (a.final_amount ?? null),
        a.deleted ? '' : (a.note ?? ''),
        a.deleted ? '' : (a.finalized_at ?? ''),
        a.deleted ? 1 : 0,
        userId, now
      ));
    }

    if (settings) {
      const cur = await this.db.prepare('SELECT json FROM settings WHERE user_id = ?').bind(userId).first();
      let merged = settings;
      if (cur) { try { merged = { ...JSON.parse(cur.json), ...settings }; } catch { merged = settings; } }
      stmts.push(this.db.prepare(`
        INSERT INTO settings (user_id, json, rev, updated_at) VALUES (?,?,${NEW_REV},?)
        ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, rev=excluded.rev, updated_at=excluded.updated_at
      `).bind(userId, JSON.stringify(merged), userId, now));
    }

    await this.db.batch(stmts);
    return this.getRev(userId);
  }

  async changesSince(userId, since) {
    const [recs, adjs, st] = await Promise.all([
      this.db.prepare('SELECT * FROM records WHERE user_id = ? AND rev > ?').bind(userId, since).all(),
      this.db.prepare('SELECT * FROM month_adjust WHERE user_id = ? AND rev > ?').bind(userId, since).all(),
      this.db.prepare('SELECT * FROM settings WHERE user_id = ? AND rev > ?').bind(userId, since).first()
    ]);
    const records = {}, adjust = {};
    for (const r of (recs.results || [])) records[r.day] = r;
    for (const a of (adjs.results || [])) adjust[a.month] = a;
    return { rev: await this.getRev(userId), records, adjust, settings: st ? JSON.parse(st.json) : null };
  }

  async fullDump(userId) {
    const [recs, adjs, st] = await Promise.all([
      this.db.prepare('SELECT * FROM records WHERE user_id = ? AND deleted = 0').bind(userId).all(),
      this.db.prepare('SELECT * FROM month_adjust WHERE user_id = ? AND deleted = 0').bind(userId).all(),
      this.db.prepare('SELECT * FROM settings WHERE user_id = ?').bind(userId).first()
    ]);
    const records = {}, adjust = {};
    for (const r of (recs.results || [])) records[r.day] = r;
    for (const a of (adjs.results || [])) adjust[a.month] = a;
    return { rev: await this.getRev(userId), records, adjust, settings: st ? JSON.parse(st.json) : null };
  }

  // ---------- App 级键值 ----------
  async getSetting(key) {
    const r = await this.db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first();
    return r ? r.value : null;
  }

  async setSetting(key, value) {
    await this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).bind(key, value, new Date().toISOString()).run();
  }

  // ---------- 用户级 MCP 接入令牌 ----------
  async countActiveMcpTokens() {
    const r = await this.db.prepare('SELECT COUNT(*) AS c FROM user_mcp_tokens WHERE enabled = 1').first();
    return r ? r.c : 0;
  }

  async getUserMcpConfig(userId) {
    const r = await this.db.prepare('SELECT * FROM user_mcp_tokens WHERE user_id = ?').bind(userId).first();
    if (!r) return { configured: false, enabled: false, token: null };
    return {
      configured: true,
      enabled: r.enabled !== 0,
      token: r.token
    };
  }

  async saveUserMcpToken(userId, token, tokenHash) {
    const now = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO user_mcp_tokens (user_id, token, token_hash, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token = excluded.token,
        token_hash = excluded.token_hash,
        enabled = 1,
        updated_at = excluded.updated_at
    `).bind(userId, token, tokenHash, now, now).run();
  }

  async setUserMcpEnabled(userId, enabled) {
    const now = new Date().toISOString();
    await this.db.prepare(`
      UPDATE user_mcp_tokens SET enabled = ?, updated_at = ? WHERE user_id = ?
    `).bind(enabled ? 1 : 0, now, userId).run();
  }

  async getUserByMcpTokenHash(tokenHash) {
    const r = await this.db.prepare(`
      SELECT u.*, m.enabled AS mcp_enabled
      FROM user_mcp_tokens m
      JOIN users u ON u.id = m.user_id
      WHERE m.token_hash = ?
    `).bind(tokenHash).first();
    if (!r) return null;
    return {
      user: {
        id: r.id,
        username: r.username,
        pw_hash: r.pw_hash,
        pw_salt: r.pw_salt,
        pw_iter: r.pw_iter,
        rev: r.rev,
        created_at: r.created_at
      },
      enabled: r.mcp_enabled !== 0
    };
  }
}
