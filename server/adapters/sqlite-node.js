// 存储适配器：VPS 本机 —— node:sqlite（Node 22 内置，零 npm 依赖）
//
// 与 D1 适配器保持完全相同的行为，关键是 rev 的写法：
// 用 `(SELECT rev FROM users WHERE id=?)` 直接在 SQL 里取新版本号，
// 而不是先 SELECT 回 JS 再拼进 INSERT。这样两个平台都能在单个事务/批次里原子完成。

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SqliteStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');   // 并发读不阻塞写
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(readFileSync(join(__dirname, '..', 'core', 'schema.sql'), 'utf8'));
  }

  close() { try { this.db.close(); } catch {} }

  // ---------- 用户与会话 ----------
  async countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  async getUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  }

  async getUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  async createUser({ username, pwHash, pwSalt, pwIter, createdAt }) {
    this.db.prepare(
      'INSERT INTO users (username, pw_hash, pw_salt, pw_iter, rev, created_at) VALUES (?,?,?,?,0,?)'
    ).run(username, pwHash, pwSalt, pwIter, createdAt);
    return this.getUserByUsername(username);
  }

  async createSession({ tokenHash, userId, createdAt, expiresAt }) {
    this.db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)'
    ).run(tokenHash, userId, createdAt, expiresAt);
  }

  async getSessionWithUser(tokenHash) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!s) return null;
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!u) return null;
    return { session: s, user: u };
  }

  async deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async purgeExpiredSessions(nowIso) {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso).changes;
  }

  // ---------- 同步 ----------
  async getRev(userId) {
    const r = this.db.prepare('SELECT rev FROM users WHERE id = ?').get(userId);
    return r ? r.rev : 0;
  }

  async applyPush(userId, { records = [], adjust = [], settings = null }) {
    const now = new Date().toISOString();
    const NEW_REV = '(SELECT rev FROM users WHERE id = ?)';

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE users SET rev = rev + 1 WHERE id = ?').run(userId);

      const upRec = this.db.prepare(`
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
        upRec.run(
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
        );
      }

      const upAdj = this.db.prepare(`
        INSERT INTO month_adjust (user_id, month, status, final_amount, note, finalized_at, deleted, rev, updated_at)
        VALUES (?,?,?,?,?,?,?,${NEW_REV},?)
        ON CONFLICT(user_id, month) DO UPDATE SET
          status=excluded.status, final_amount=excluded.final_amount, note=excluded.note,
          finalized_at=excluded.finalized_at, deleted=excluded.deleted,
          rev=excluded.rev, updated_at=excluded.updated_at
      `);
      for (const a of adjust) {
        upAdj.run(
          userId, a.month,
          a.deleted ? 'draft' : a.status,
          a.deleted ? null : (a.final_amount ?? null),
          a.deleted ? '' : (a.note ?? ''),
          a.deleted ? '' : (a.finalized_at ?? ''),
          a.deleted ? 1 : 0,
          userId, now
        );
      }

      if (settings) {
        // 设置是整份合并：客户端可能只传改动的字段，不能把没传的清掉
        const cur = this.db.prepare('SELECT json FROM settings WHERE user_id = ?').get(userId);
        let merged = settings;
        if (cur) {
          try { merged = { ...JSON.parse(cur.json), ...settings }; } catch { merged = settings; }
        }
        this.db.prepare(`
          INSERT INTO settings (user_id, json, rev, updated_at) VALUES (?,?,${NEW_REV},?)
          ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, rev=excluded.rev, updated_at=excluded.updated_at
        `).run(userId, JSON.stringify(merged), userId, now);
      }

      const rev = this.db.prepare('SELECT rev FROM users WHERE id = ?').get(userId).rev;
      this.db.exec('COMMIT');
      return rev;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  async changesSince(userId, since) {
    const recs = this.db.prepare('SELECT * FROM records WHERE user_id = ? AND rev > ?').all(userId, since);
    const adjs = this.db.prepare('SELECT * FROM month_adjust WHERE user_id = ? AND rev > ?').all(userId, since);
    const st = this.db.prepare('SELECT * FROM settings WHERE user_id = ? AND rev > ?').get(userId, since);
    const records = {}, adjust = {};
    for (const r of recs) records[r.day] = r;
    for (const a of adjs) adjust[a.month] = a;
    return {
      rev: await this.getRev(userId),
      records,
      adjust,
      settings: st ? JSON.parse(st.json) : null
    };
  }

  async fullDump(userId) {
    const recs = this.db.prepare('SELECT * FROM records WHERE user_id = ? AND deleted = 0').all(userId);
    const adjs = this.db.prepare('SELECT * FROM month_adjust WHERE user_id = ? AND deleted = 0').all(userId);
    const st = this.db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);
    const records = {}, adjust = {};
    for (const r of recs) records[r.day] = r;
    for (const a of adjs) adjust[a.month] = a;
    return {
      rev: await this.getRev(userId),
      records,
      adjust,
      settings: st ? JSON.parse(st.json) : null
    };
  }

  // ---------- App 级键值 ----------
  // 查无返回 null（node:sqlite 的 .get() 查无是 undefined，统一掰成 null）。
  async getSetting(key) {
    const r = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return r ? r.value : null;
  }

  async setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  // ---------- 用户级 MCP 接入令牌 ----------
  async countActiveMcpTokens() {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM user_mcp_tokens WHERE enabled = 1').get();
    return r ? r.c : 0;
  }

  async getUserMcpConfig(userId) {
    const r = this.db.prepare('SELECT * FROM user_mcp_tokens WHERE user_id = ?').get(userId);
    if (!r) return { configured: false, enabled: false, token: null };
    return {
      configured: true,
      enabled: r.enabled !== 0,
      token: r.token
    };
  }

  async saveUserMcpToken(userId, token, tokenHash) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO user_mcp_tokens (user_id, token, token_hash, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token = excluded.token,
        token_hash = excluded.token_hash,
        enabled = 1,
        updated_at = excluded.updated_at
    `).run(userId, token, tokenHash, now, now);
  }

  async setUserMcpEnabled(userId, enabled) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE user_mcp_tokens SET enabled = ?, updated_at = ? WHERE user_id = ?
    `).run(enabled ? 1 : 0, now, userId);
  }

  async getUserByMcpTokenHash(tokenHash) {
    const r = this.db.prepare(`
      SELECT u.*, m.enabled AS mcp_enabled
      FROM user_mcp_tokens m
      JOIN users u ON u.id = m.user_id
      WHERE m.token_hash = ?
    `).get(tokenHash);
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
