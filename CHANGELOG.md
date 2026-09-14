## 七、 版本发布历史 (Changelog)

### v1.0.2 (2026-09-15)
- **修复 (MCP 状态联动与生命周期)**：
  - 修复退出登录后前端 `mcp` 响应式对象残留已开启状态、点击关闭弹出「未登录」错误的问题。
  - 新增 `resetMcpState(authNeeded)` 函数，在 `doLogout` 成功退出时联动重置 MCP 状态并清空掩码。
  - `loadMcpStatus` 增加登录凭证前置检测与 401/403 异常拦截重置；在 `doLogin` 成功后自动拉取当前账号的专属 MCP 状态。
  - 未登录时 MCP 接入开关与生成令牌按钮自动置灰禁用，右上角徽章明确显示「本设备请先登录」，`toggleMcp` 增加前置拦截提示。
- **Android 原生资产与版本**：
  - 静态资产同步至 `android/app/src/main/assets/www/`。
  - 版本号升级：`versionCode 3`，`versionName "1.0.2"`。

### v1.0.1 (2026-09-15)
- **应用名称统一**：
  - Android 原生应用名称统一由「工时记账」修改为「工时打卡」（`strings.xml`）。
  - `MainActivity.java` 连续双击返回退出提示文案同步更新为「再按一次退出工时打卡」。
- **默认远程服务器探活与回退**：
  - `sync.js` 预设 `DEFAULT_REMOTE_BASE = 'https://daka.kory.kdns.fr'`。
  - 深度适配 Android WebView `file:///android_asset/...` 环境，未手动指定服务器地址时自动探活并回退到默认远程服务器。
- **设置页交互分流与体验重构**：
  - 底部导航栏点击「设置」原生切换至 `<section v-show="tab === 'settings'">` 独立全屏视图，保持打卡、汇总、设置三页平级体验。
  - 顶部导航栏齿轮图标保留快速弹出轻量半屏抽屉（`settingsOpen`）能力，满足快捷调整设置的需求。
- **登录 / 注册模式解耦**：
  - 在设置页「云端同步」卡片中引入「账号登录 / 注册新账号」模式切换（`authMode`）。
  - 彻底解除了等待服务端异步探测返回 `allowRegister` 按钮才浮现的延迟限制。
- **文档与发版**：
  - 补充 README「六、 Android 客户端与移动端打包」章节。
  - 版本号升级：`versionCode 2`，`versionName "1.0.1"`。

### v1.0.0 (2026-09-15)
- **Android 原生离线客户端支持**：
  - 新增基于 Android WebView 的原生包装容器（`android/` 工程）。
  - 将前端静态资产封装在本地 assets，支持完全脱网离线运行及沉浸式体验。
- **构建环境与依赖约束修复**：
  - 解决 GitHub Actions CI 构建 Release APK 出现的 Kotlin stdlib 多版本冲突（`Duplicate class kotlin.collections.jdk8.CollectionsJDK8Kt`）。
  - 在 `android/app/build.gradle` 引入 Kotlin BOM 平台依赖约束：`org.jetbrains.kotlin:kotlin-bom:1.8.22`。
- **CI/CD 自动化构建流水线**：
  - 新增 `.github/workflows/build-apk.yml` 自动化构建工作流。
  - 支持推送 `v*` 标签时自动编译、签名并发布 GitHub Release 及附带 APK 校验和。
- **系统核心基线**：
  - Local-First 本地优先架构、纯函数薪酬计算引擎（`shared/payroll.js`）、启动自愈守卫、多用户数据隔离与用户级只读 MCP 服务。
