# 工时记账与薪酬核算系统 (Work Hours Tracker)

轻量级工时排班记账与多周期薪酬核算系统。采用 Local-First（本地优先）离线架构，支持移动端秒开、增量双向同步，并将薪酬算法收口为同构纯函数引擎。

---

## 一、 开发目的

1. **解决复杂排班与工时结算痛点**
   - 针对非标工时制（大小夜班、跨日班次、工时补扣、满勤奖惩等）场景，解决人工核算繁琐、极易出错的问题。
   - 实现**工时填报即时核算、多周期薪酬实时预估**，让收入与扣罚明细清晰透明。

2. **本地优先 (Local-First) 与离线可用**
   - 保证在弱网、无网或服务离线环境下，移动端仍可秒开并正常记账与查询。
   - 采用增量版本变更日志机制，网络恢复后自动与服务端完成双向合并，避免数据冲突与丢失。

3. **算法同构与高可靠性保障**
   - 核心薪酬核算逻辑完全剥离为纯函数模块（`shared/payroll.js`），实现**前端交互实时核算**与**后端/测试环境同构复用**。
   - 配备涵盖 100+ 真实场景的自动化基线测试（Parity Test），保障业务规则演进时算法零误差。

---

## 二、 核心架构与业务流程

```
┌────────────────────────────────────────────────────────┐
│                   前端 (Vue 3 PWA)                     │
│  - 日历排班视图 / 工时打卡 / 薪酬看板 / 扣罚明细      │
│  - 本地持久化 (LocalStorage / IndexedDB)              │
│  - 纯函数核算引擎 (shared/payroll.js)                  │
│  - 启动守卫：依赖加载失败时静默自愈，无错误卡片       │
└──────────────────────────┬─────────────────────────────┘
                           │ 增量双向同步 (/api/push, /api/changes)
                           ▼
┌────────────────────────────────────────────────────────┐
│                后端服务 (Node.js REST API)             │
│  - 鉴权与用户管理 (Token-based Auth)                   │
│  - 数据版本控制与原子合并                             │
│  - 静态资产安全分发与白名单隔离                       │
│  - 数据持久化存储引擎                                  │
└────────────────────────────────────────────────────────┘
```

### 1. 业务交互流程
1. **工时录入与即时核算**：
   - 用户在日历/表单选择班次类型（白班/夜班/连班）及加班时数。
   - 前端直接调用 `WHTPayroll` 引擎，实时计算日收益、月累计工时、基础底薪、满勤补贴与扣罚。
2. **离线持久化与同步入队**：
   - 变更记录即刻写入本地持久化存储，并生成操作变更日志（Changelog）。
3. **数据合并与同步**：
   - 同步模块（`sync.js`）触发后台长轮询或网络恢复监听，通过 `/api/push` 提交本地变更，并通过 `/api/changes` 拉取服务端增量更新，按时间戳与修订号完成双向一致性合并。

### 2. 项目目录结构
- `index.html`：主交互界面，包含日历打卡、月度明细、薪酬测算看板与自定义规则配置。
  内置启动守卫：Vue / 薪酬模块加载失败时不弹任何错误卡片，白屏中央仅一行「正在恢复连接…」小灰字，
  后台退避轮询（2s→4s→…封顶 30s）自动重取资源并恢复；每会话自动 reload 上限 2 次防闪屏，
  额度用尽后转纯后台轮询。技术日志仅输出到控制台（`[boot-guard]` 前缀）。
- `shared/payroll.js`：独立同构薪酬计算模块（包含时薪折算、截断规则、周期合并等 30+ 纯函数）。
- `sync.js`：本地优先增量同步适配层。
- `server/`：轻量级 REST API 服务端（支持鉴权、版本同步、健康检查 `/api/health`）。
- `test/` & `tools/`：基线测试（Parity Test）、断言验证与回归测试工具。

---

## 三、 部署方式

系统支持 **Node.js 直接部署 (Systemd 守护)** 与 **反向代理部署**。

### 1. 环境要求
- **Node.js**：`>= 22.5.0`
- **操作系统**：Linux (Debian/Ubuntu/CentOS 等)

### 2. 部署步骤

#### 步骤一：克隆代码与安装依赖
```bash
git clone https://gitea.king.nyc.mn/openclaw/work-hours-tracker.git
cd work-hours-tracker

# 安装主项目及服务端依赖
npm install
cd server && npm install && cd ..
```

#### 步骤二：运行测试门禁验证
在正式启动前，确保全量计算基线与服务端测试全部通过：
```bash
npm run test
# 预期输出：test:payroll 与 test:server 全部通过
```

#### 步骤三：Systemd 服务配置
仓库内已带与线上运行一致的单元文件 `server/work-hours-tracker.service`，拷贝后启用即可：
```bash
cp server/work-hours-tracker.service /etc/systemd/system/work-hours-tracker.service
# 部署路径不同时，先修改单元文件里的 WorkingDirectory 再 daemon-reload
systemctl daemon-reload
systemctl enable --now work-hours-tracker.service
```

单元文件关键内容（端口固定 9522：localStorage 按 origin 隔离，换端口 = 换 origin，
已有打卡数据会看不见，勿改）：
```ini
[Unit]
Description=Work Hours Tracker (Node: static + sync API)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/.openclaw/workspace/work-hours-tracker/server
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning node-server.js
Environment=PORT=9522
Environment=HOST=0.0.0.0
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

加载并启动服务：
```bash
systemctl daemon-reload
systemctl enable --now work-hours-tracker.service
```

#### 步骤四：服务检查与连通性验证
```bash
# 查看运行状态
systemctl status work-hours-tracker.service

# 接口健康检查
curl -s http://127.0.0.1:9522/api/health
# 正常返回: {"ok":true,"users":1}
```

---

## 四、 运维与日常管理

- **更新重启**：
  ```bash
  systemctl restart work-hours-tracker.service
  ```
- **查看实时日志**：
  ```bash
  journalctl -u work-hours-tracker.service -f
  ```
- **基线快照校验**（当薪酬规则发生改动时）：
  ```bash
  npm run baseline        # 校验基线无漂移
  npm run baseline:write  # 确认规则变更并更新快照
  ```
