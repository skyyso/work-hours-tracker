-- 工时记账服务端 schema
-- 同时兼容 VPS 上的 node:sqlite 与 Cloudflare D1（都是 SQLite 方言）
-- 设计要点：
--   1. users.rev 是该用户的单调递增版本号，任何写入都 +1，客户端靠它做增量拉取
--   2. records / month_adjust 用 deleted 墓碑标记而非物理删除，否则增量同步无法传播「删除」
--   3. 所有时间戳统一存 ISO 8601 字符串（UTC），避免 D1 与 SQLite 的时间函数差异

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE,
  pw_hash    TEXT    NOT NULL,
  pw_salt    TEXT    NOT NULL,
  pw_iter    INTEGER NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- 每日打卡：主键 (user_id, day)，day 形如 2026-09-08
CREATE TABLE IF NOT EXISTS records (
  user_id           INTEGER NOT NULL,
  day               TEXT    NOT NULL,
  status            TEXT,
  shift_type        TEXT,
  hours             REAL,
  contraband_found  INTEGER NOT NULL DEFAULT 0,
  contraband_missed INTEGER NOT NULL DEFAULT 0,
  other_penalty     REAL,
  penalty_reason    TEXT,
  deleted           INTEGER NOT NULL DEFAULT 0,
  rev               INTEGER NOT NULL,
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_records_rev ON records(user_id, rev);

-- 月度奖惩终稿：主键 (user_id, month)，month 形如 2026-09
-- status = draft(草稿，不计入金额) | final(组长审核定稿，计入金额)
CREATE TABLE IF NOT EXISTS month_adjust (
  user_id      INTEGER NOT NULL,
  month        TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  final_amount REAL,
  note         TEXT,
  finalized_at TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0,
  rev          INTEGER NOT NULL,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (user_id, month)
);
CREATE INDEX IF NOT EXISTS idx_adjust_rev ON month_adjust(user_id, rev);

-- 设置整体存一份 JSON：字段会随功能迭代增减，拆列反而不好演进
CREATE TABLE IF NOT EXISTS settings (
  user_id    INTEGER PRIMARY KEY,
  json       TEXT    NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at TEXT    NOT NULL
);

-- App 级键值：服务自身的运行时配置（当前用于 MCP 接入开关与令牌）。
-- 刻意与 users/settings 分开：它不属于任何用户，不参与同步协议，
-- 客户端 push 碰不到它，增量拉取也不会把它带出去。
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

-- App 级键值：服务自身的运行时配置（当前用于 MCP 接入开关与令牌）。
-- 刻意与 users/settings 分开：它不属于任何用户，不参与同步协议，
-- 客户端 push 碰不到它，增量拉取也不会把它带出去。
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
 );
