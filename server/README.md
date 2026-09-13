# 工时记账 · 服务端与同步

数据从「只在浏览器 localStorage」升级为「服务器 SQLite/D1 + 本地离线缓存」。
本地仍是唯一真相，断网、没登录都照常记账；同步只是额外把数据推到服务器。

## 目录结构

```
work-hours-tracker/
├── index.html              前端（已内置同步面板）
├── sync.js                 客户端同步引擎（不依赖 Vue，可复用到 APP 壳）
├── verify_payroll.js       核算算法用例（220 项）
└── server/
    ├── core/               ← 平台无关，VPS 与 CF Workers 共用
    │   ├── api.js          HTTP 接口逻辑（收发标准 Request/Response）
    │   ├── auth.js         PBKDF2 密码 + SHA-256 令牌（纯 Web Crypto）
    │   ├── mcp.js          只读 MCP 端点（JSON-RPC 2.0）+ DB 真开关 + 令牌管理
    │   ├── store.js        存储契约 + 输入校验（含 app_settings 读写）
    │   └── schema.sql      建表语句（SQLite / D1 通用）
    ├── adapters/
    │   ├── sqlite-node.js  VPS：node:sqlite（Node 22 内置，零 npm 依赖）
    │   └── d1.js           Cloudflare D1
    ├── node-server.js      VPS 入口：静态页 + /api/* + /mcp 同一端口
    ├── worker.js           CF Workers 入口
    ├── wrangler.toml       CF 部署配置
    └── test/               api.test.js（72 项）+ mcp.test.js（39 项）
```

换平台只需换适配器，`core/` 一行都不用动。

## VPS 部署（当前方式）

```bash
cd server
npm start                    # 默认 9523，静态页与 API 同源
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 9523 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DB_PATH` | `server/data/work-hours.db` | SQLite 文件位置 |
| `STATIC_DIR` | 项目根 | 静态目录 |
| `ALLOW_REGISTER` | 未设 | 设 `1` 才开放注册 |
| `MCP_AUTH_TOKEN` | 未设 | MCP 端点接入令牌，**仅首次种子**：库里已有令牌后以 DB 为准（页面后台可改），可不设 |

首次访问 `http://<地址>:9523` → 设置页 → 云端同步 → 创建首个账号。
**建首个账号后注册自动关闭**，公网暴露也不会被陌生人开号。

跑测试：

```bash
cd server && npm test        # 72 项 API + 39 项 MCP
cd .. && node verify_payroll.js   # 220 项
```

## MCP Server（POST /mcp）

服务端内置只读 MCP 端点（Streamable HTTP，JSON-RPC 2.0），让对话式 AI 查询出勤与薪酬。
工具 7 个：`get_month_summary` / `get_shift_records` / `get_payroll_settings` / `get_penalty_details` / `simulate_leave` / `list_month_overview` / `get_business_rules`。
算钱一律复用 `shared/payroll.js` 引擎（与前端看板同源），不让 AI 口算。

- **配置存 DB**（`app_settings` 表），页面「设置 → AI 接入 (MCP)」可开关/生成/重置令牌，**即时生效无需重启**
- `MCP_AUTH_TOKEN` 环境变量只做首启种子（库里从没有过令牌时迁入 DB），不设也行
- 状态语义：未配置 → `404`（端点视为不存在）；已配置但关闭 → `503`；令牌错误 → `401`
- 管理 API（登录态）：`GET /api/mcp/status`（掩码）、`POST /api/mcp/token`（生成/重置，明文仅回一次）、`GET /api/mcp/token`（复制用取回明文）、`POST /api/mcp/enabled`
- 只读约束：任何工具都不写库，AI 最多能看，不能改

### systemd

现有 `work-hours-tracker.service` 是 `python3 -m http.server 9522`，只发静态文件，
且会把 `.bak`、`server/`、数据库一并发出去。切到新服务顺带解决这个问题：

```ini
[Unit]
Description=Work Hours Tracker
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/.openclaw/workspace/work-hours-tracker/server
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning node-server.js
Environment=PORT=9523
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Cloudflare Workers 部署

```bash
cd server
wrangler d1 create work-hours       # 把 database_id 填进 wrangler.toml
npm run cf:migrate                  # 建表
npm run cf:deploy
```

静态资源走 Workers Assets（`wrangler.toml` 的 `[assets]`），API 走同一个 Worker，仍是同源。

已确认可行：`core/` 只用 `Request`/`Response`/`crypto.subtle`/`TextEncoder`，这些 Workers 全都有；
PBKDF2 十万次迭代实测约 17ms，远低于 Workers 的 CPU 时间预算。

## 接口

除 `/api/health`、`/api/register`、`/api/login` 外都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 探活，返回用户数（前端据此决定显示「登录」还是「创建首个账号」） |
| POST | `/api/register` | 注册（默认仅首个账号） |
| POST | `/api/login` | 登录，返回 token 与当前 rev |
| POST | `/api/logout` | 令牌立即失效 |
| GET | `/api/me` | 当前用户与 rev |
| GET | `/api/data` | 全量拉取 |
| GET | `/api/changes?since=N` | 增量拉取（含删除墓碑） |
| POST | `/api/push` | 推送变更，整批原子写入，返回新 rev |
| DELETE | `/api/record/YYYY-MM-DD` | 删单日 |
| DELETE | `/api/adjust/YYYY-MM` | 删单月奖惩 |
| GET | `/api/export` | 导出 JSON，与前端「导出备份」同构，可互相导入 |
| GET | `/api/mcp/status` | MCP 接入状态（configured/enabled/令牌掩码） |
| POST | `/api/mcp/token` | 生成/重置 MCP 令牌（明文仅此一次，自动启用） |
| GET | `/api/mcp/token` | 取回 MCP 令牌明文（复制用） |
| POST | `/api/mcp/enabled` | 开/关 MCP 端点（即时生效，无需重启） |

## 同步机制

**版本号 rev。** 每个用户一个单调递增计数器，任何写入都 +1，被改动的行打上这个 rev。
客户端记住上次见过的 rev，拉取时只问「比它新的」，不做全量对比。

**墓碑删除。** 删除不物理删行，而是置 `deleted=1`。否则「这天被删了」这件事没法传播到其他设备——
对方只会看到自己有、服务器没有，然后又给推回来。

**先推后拉。** 本地改动记在 dirty 集合里，同步时先 push 再 pull，所以本地改动天然赢，
不会被远端旧值覆盖。dirty 里的键在应用远端数据时会被跳过。

**离线优先。** localStorage 始终是本地真相。没登录、断网、服务器挂了都能照常记账，
改动攒在 dirty 里，等能连上再一次推上去。

**设置合并而非覆盖。** 客户端可能只传改动的字段，服务端与现有值合并，不会把没传的清掉。

**首次登录的冲突处理**（`index.html` 的 `doLogin`）：
先 `pullAll` 看服务端有没有数据——服务端为空且本地有数据 → 自动 `pushAll` 上传；
否则拉下来合并。不静默丢任何一边。

## 数据模型

| 表 | 主键 | 说明 |
|---|---|---|
| `users` | id | 含 `rev`，该用户的全局版本号 |
| `sessions` | token_hash | 只存 SHA-256，泄库换不出可用 token |
| `records` | (user_id, day) | day = `2026-09-08` |
| `month_adjust` | (user_id, month) | month = `2026-09`，`status` = draft/final |
| `settings` | user_id | 整份 JSON，字段会迭代所以不拆列 |
| `app_settings` | key | App 级运行时配置（MCP 开关/令牌），不属于任何用户，不参与同步 |

## 安全

已做：

- 密码 PBKDF2-SHA256 十万次迭代 + 随机盐，不存明文
- 令牌只存哈希，登出立即失效，30 天过期
- 登录/注册限流（每 IP 每分钟 10 次）
- 用户名不存在时也走一次真实密码校验开销，防止靠响应时间枚举用户名
- 首个账号建立后自动关闭注册
- 逐用户数据隔离（已有用例验证两账号互不可见）
- 静态服务屏蔽 `server/`、`.trash/`、`png/`、`.bak`、`.db`、`.sql`、`verify_*.js`，防目录穿越
- 服务端输入校验：非法状态/班次/工时/件数、`2026-13`、`2026-02-31` 这类假日期全部拒收

未做，公网暴露前需要补：

- **HTTPS**。当前 HTTP 明文，密码与令牌在链路上可见。上公网必须配反代 + 证书，或直接用 CF Workers（自带 HTTPS）。
- 令牌存在 localStorage，XSS 可窃取。当前页面无用户生成内容渲染，风险低。
- 无二次验证、无密码找回。忘记密码只能删库重建。

## 前端接入点

`sync.js` 暴露 `window.WHTSync`：

```js
WHTSync.setApplyHook(fn)      // 注册「如何把远端数据写进本地」
WHTSync.markDirty(kind, key)  // kind: 'record' | 'adjust' | 'settings'
WHTSync.syncNow()             // 手动同步
WHTSync.pullAll()             // 服务器覆盖本地
WHTSync.pushAll()             // 本地全量上传
WHTSync.onChange(fn)          // 订阅状态变化
WHTSync.setApiBase(url)       // 跨域部署时指定 API 地址，留空 = 同源
```

`index.html` 里 `persist(dirtyDays)` / `persistAdjust(dirtyMonths)` 接收改动的键并自动标脏，
1.5 秒防抖后上传。回到前台、网络恢复时各补一次同步。

`suppressSync` 标志用于远端数据写回本地时关闭标脏，避免「拉下来 → 又当成本地改动推回去」的回环。

## 做 APP 时

`sync.js` 只依赖 `localStorage` 与 `fetch`，不碰 Vue 也不碰浏览器独有 API。
套 Capacitor / WebView / React Native 时这一层可整块复用，把 `setApiBase()` 指向服务器即可。
`core/` 已经是平台无关的，换 Bun/Deno/其他 runtime 也只需要写一个入口文件。
