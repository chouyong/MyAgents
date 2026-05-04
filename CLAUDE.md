# MyAgents — Desktop AI Agent

基于 Claude Agent SDK 的桌面端通用 Agent 产品。开源（Apache-2.0），Conventional Commits，不提交敏感信息。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Node.js v24 + Claude Agent SDK 0.2.119（多实例 Sidecar） |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 运行时 | 单一 Node.js v24（Sidecar / Plugin Bridge / MCP Server / CLI），内置于应用包 |

## 项目布局

- `src/renderer/` — React 前端（api/、context/、hooks/、components/、pages/）
- `src/server/` — Node.js 后端 Sidecar（esbuild 打包成 `server-dist.js`）
- `src/server/plugin-bridge/` — OpenClaw Plugin Bridge（独立 Node 进程）
- `src/cli/` — `myagents` CLI（同步到 `~/.myagents/bin/`）
- `src/shared/` — 前后端共享类型
- `src-tauri/` — Tauri Rust 层
- `specs/` — 设计文档（ARCHITECTURE.md / DESIGN.md / tech_docs/ / guides/）
- `bundled-agents/myagents_helper/` — 内置 MA 小助理

---

## 文档体系（必读）

本项目文档分四层。**每次会话只自动加载本 CLAUDE.md**，其它按需读取。

| 层 | 文档 | 加载方式 |
|----|------|---------|
| L1 | 本 CLAUDE.md | 每次自动加载，红线 + 元认知 + 文档导航 |
| L2 | `specs/ARCHITECTURE.md` | **不自动加载**。任务匹配下方触发条件时 MUST 主动 Read |
| L3 | `specs/tech_docs/*.md` | 改特定模块时 MUST 主动 Read 对应文档 |
| L4 | `specs/DESIGN.md` | 前端开发 MUST 主动 Read |

### MUST 主动 Read `specs/ARCHITECTURE.md` 的触发条件

- 任何"设计 / 评估 / 规划 / 重构"层面的请求
- 修改 Sidecar 生命周期、Session 切换、Owner 模型、Pre-warm
- 跨模块 / 跨进程 / 新通信模式的功能
- 涉及 SSE / HTTP 代理 / Tab 隔离 / SDK 交互的改动
- 新增 IM 适配器、Runtime、MCP server、Channel 类型
- 你不确定某个功能"应该走哪条已有路径"

### MUST 主动 Read 对应 `tech_docs/` 的触发条件

| 改动范围 | 必读 |
|---------|------|
| Pit-of-Success helper 细节 / 新增 helper | `tech_docs/pit_of_success.md` |
| Sidecar 启动性能 / 冷启动退化排查 | `tech_docs/sidecar_cold_start.md` |
| 任务中心 / Task Store / Thought Store | `tech_docs/task_center.md` |
| IM Bot / Telegram / Dingtalk / 飞书 | `tech_docs/im_integration_architecture.md` |
| Plugin Bridge / OpenClaw / SDK shim | `tech_docs/plugin_bridge_architecture.md` |
| Claude Code / Codex / Gemini Runtime | `tech_docs/multi_agent_runtime.md` |
| Session ID / 存储 / 状态同步 | `tech_docs/session_architecture.md` |
| Task / Cron provider routing 三层架构 | `tech_docs/task_provider_routing.md` |
| 全文搜索（Tantivy / jieba） | `tech_docs/search_architecture.md` |
| 内置 Node.js / SDK native binary / PATH 注入 | `tech_docs/bundled_node.md` |
| `myagents` CLI / Admin API | `tech_docs/cli_architecture.md` |
| 三方供应商 / OpenAI Bridge | `tech_docs/third_party_providers.md` |
| 系统代理 / SOCKS5 桥接 | `tech_docs/proxy_config.md` |
| 统一日志 | `tech_docs/unified_logging.md` |
| Windows 编码约束（路径前缀 / 进程 / CSP） | `tech_docs/windows_platform.md` |
| Linux 构建与分发 | `guides/linux_build_guide.md` |
| 构建问题排查 | `guides/build_troubleshooting.md` |
| 自动更新机制 | `tech_docs/auto_update.md` |
| SDK `canUseTool` / 工具权限回调 | `tech_docs/sdk_canUseTool_guide.md` |
| SDK 自定义 Tool / `createSdkMcpServer` | `tech_docs/sdk_custom_tools_guide.md` |
| React 稳定性 5 条规则 | `tech_docs/react_stability_rules.md` |

---

## 第一原则：架构延续性

**每个功能都在已有架构上生长，不另起炉灶。**

项目已有成熟的分层、通信、安全、前端规范。新功能 MUST 复用现有模块和模式（`local_http`、`process_cmd`、`broadcast()`、`awaitSessionTermination()` 等），禁止为单点需求发明新的技术方案。

开发前 MUST 做的三件事：

1. **判断触发条件** — 对照上方"主动 Read"清单，决定要读哪些文档
2. **搜索现有实现** — `grep` / `find` 类似功能，复用而非重建
3. **读 SDK 源码** — 对接外部 SDK / 插件时 MUST 读源码确认接口（函数签名、config schema、返回值），再写适配层

如果需求**确实**需要架构变更（新通信模式、新状态管理、新进程类型），MUST 先与用户讨论方案，不得自行引入。

## SDK 交互规范

项目核心 AI 运行时是 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）。SDK 持续迭代，API 行为、环境变量、消息类型可能随版本变更。

**禁止凭假设编写 SDK 交互代码。** 涉及 SDK 的任何开发（`query()` 参数、`SDKMessage` 类型处理、环境变量、Hook 注册、MCP 集成等），MUST 先查阅官方文档确认实际行为：

- **SDK 文档**：https://platform.claude.com/docs/zh-CN/agent-sdk/overview
- **SDK 类型定义**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（当前版本 0.2.119）
- **SDK 工具类型**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`

典型错误：臆测 `seedReadState` 调用时机导致"先读后改"语义被绕过、臆测环境变量名导致模型别名不生效。这类问题的根因都是没有查文档就动手写代码。

---

## 核心架构骨架（细节见 ARCHITECTURE.md）

理解以下抽象是改任何功能的前置认知。每条只列名字 + 关键约束。

### Sidecar Owner 模型
Sidecar 进程 = Claude Agent SDK 实例；Session : Sidecar = 1 : 1；Tab / CronTask / BackgroundCompletion / Agent 四种 Owner 共享 Sidecar，全部释放才停止。详见 ARCHITECTURE「核心抽象 / 资源管理」。

### Tab-Scoped 隔离
每个 Chat Tab 独立 Sidecar。Tab 内 MUST 用 `useTabState()` 的 `apiGet` / `apiPost`，**禁止**使用全局 `apiPostJson` / `apiGetJson`（会发到 Global Sidecar）。详见 ARCHITECTURE「核心抽象」。

### Rust 代理层
所有前端 HTTP / SSE MUST 经 Rust（`invoke` → reqwest → Sidecar）。**禁止** WebView 直发 HTTP。详见 ARCHITECTURE「通信模式」。

### 持久 Session
`messageGenerator()` 使用 `while(true)` 永远 yield，SDK subprocess 全程存活。
- 所有中止 MUST 用 `abortPersistentSession()`，**禁止**直接设置 `shouldAbortSession = true`（generator 会永久阻塞）
- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI "失忆"
- 两种重启不要混淆：直接 abort（立即 + interrupt）vs `scheduleDeferredRestart('mcp' | 'agents')`（防抖 + 下次 pre-warm 柔性重启）

详见 ARCHITECTURE「核心抽象 / Session 切换」。

### Pre-warm 机制
MCP / Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步**不**触发。持久 Session 中 pre-warm 即最终 session，用户消息通过 `wakeGenerator()` 注入。**任何 `!preWarm` 守卫都可能在持久模式下永远不执行。**

**MCP 配置权威来源分离**：Tab 由前端 `/api/mcp/set` 配，IM/Cron 由 self-resolve 从磁盘读。混用会导致 fingerprint 差异 → abort → 30s 重启循环。

### Multi-Agent Runtime
内置 SDK（builtin）+ 外部 Runtime（Claude Code CLI / Codex CLI / Gemini CLI）。功能门控 `config.multiAgentRuntime`（默认关闭）。**新增 config 同步端点 MUST 检查 `shouldUseExternalRuntime()` 并分流到 `external-session.ts`。** 详见 `tech_docs/multi_agent_runtime.md`。

### 定时任务系统
Rust `CronTaskManager` 统一管理所有定时任务（Chat 定时 / 独立创建 / AI 工具 / IM Cron / Heartbeat）。Cron Tool（`im-cron` MCP）已泛化为**所有 Session 可用**，始终信任。新增 `CronTask` 字段 MUST 带 `#[serde(default)]`。详见 ARCHITECTURE「定时任务系统」。

### Config 持久化（disk-first）
`AppConfig` 同时存在于磁盘（`config.json`）和 React 状态，可能不同步。写盘 MUST 以磁盘为准（`await loadAppConfig()` 读最新再合并），**禁止**直接用 React `config` 状态写盘。Agent 配置走 Rust `cmd_update_agent_config`，写盘后 MUST 调 `refreshConfig()` 同步 React。

### Builtin MCP 懒加载
6 个 in-process 内置 MCP 采用 META / INSTANCE 两层懒加载。`src/server/tools/*.ts` **禁止顶层 value-import** SDK / zod（结构性 ESLint 规则封禁）。MUST 在 `createXxxServer()` 内部 `await import(...)`。详见 `tech_docs/pit_of_success.md` 的「Builtin MCP 懒加载」节。

### Plugin Bridge
独立 Node.js 进程加载 OpenClaw Channel Plugin。MUST 与 Sidecar 同等待遇（环境变量、日志宏、config 范围）。修改 SDK shim MUST 三处同步 bump 版本（`sdk-shim/package.json` / `compat-runtime.ts` / `bridge.rs::SHIM_COMPAT_VERSION`）。详见 `tech_docs/plugin_bridge_architecture.md`。

### 工作区文件 IO（两层模型）
"OS 文件操作" 与 "AI runtime 容器" 解耦：所有工作区文件操作走 Tauri invoke（`cmd_workspace_*`，`src-tauri/src/workspace_files/`），**禁止**走 Sidecar HTTP。Launcher 没 Sidecar 也能用文件能力；云端协作时客户端可拆。前端唯一入口 `useWorkspaceFileService(workspacePath)`。
- **读侧**用 `path_safety::resolve_existing_inside_workspace`（canonicalize + prefix-check 防 `evil_link → /etc/passwd` symlink 逃逸）
- **写侧**用 `path_safety::resolve_inside_workspace`（lexical，因 `fs::canonicalize` 在不存在路径上失败）
- **绝对路径揭示**（Skill/Command 详情）走 `cmd_open_path_external`，挡 home/tmp prefix + credential 黑名单
- **fs watcher** 用 token-based handle：`watch_start` 返回 `{token, eventKey}`，`watch_stop({token})` 索引；进程 nonce 防跨重启 token 碰撞

详见 ARCHITECTURE「工作区文件 IO」。

---

## Pit-of-Success 红线总表

每条：禁止 / 后果 / 正确做法。**违反任意一条都会引入难诊断的生产事故**。详细 rationale 与 helper API 见 `tech_docs/pit_of_success.md`。

| 禁止 | 后果 | 正确做法 |
|------|------|---------|
| 裸 `reqwest::Client::new()` 连 localhost | 系统代理拦 localhost → 502 | `crate::local_http::builder()` / `json_client()` / `sse_client()` |
| 裸 `std::process::Command::new()` | Windows GUI 弹黑色控制台窗口 | `crate::process_cmd::new()` |
| 裸 `tokio::spawn` / `tokio::task::spawn` | macOS startup-abort（panic 跨 FFI 不能 unwind） | `tauri::async_runtime::spawn`（clippy 已硬封禁） |
| 子进程 spawn 不调 `apply_to_subprocess` | Node fetch 读继承的 HTTP_PROXY → localhost 通信被代理 → 502 | `crate::proxy_config::apply_to_subprocess(&mut cmd)` |
| 裸 `which::which()` 查系统工具 | Finder 启动时 PATH 缺失 | `crate::system_binary::find()` |
| Tauri `resource_dir()` / `current_exe()` 路径直接喂 Node / npm / URL / 子进程 | Windows `\\?\` 长路径前缀让 `fileURLToPath` / spawn 报 `ERR_INVALID_FILE_URL_PATH` 或静默挂 | `crate::sidecar::normalize_external_path(p)`，在路径"出 Rust 边界"前剥前缀 |
| `~/.myagents/config.json` 裸 `tmp + rename` | 多写者 race，密钥静默丢失 | Node `withConfigLock` / Rust `with_config_lock` / renderer `withConfigLock` |
| 单写者文件裸 append / read-modify-write | 应用内多 owner race | `withFileLock` / `with_file_lock` / `with_file_lock_blocking` |
| Runtime 子进程 stop 用裸 `SIGTERM + waitForExit` | 进程拒收 SIGTERM 时永久卡死 | `killWithEscalation` |
| 工具 / bridge 裸 `fetch()` 无 AbortSignal | 下游卡住 → tool turn 永久 hang | `cancellableFetch` / `withAbortSignal` |
| 大 payload（>256KB）直接进 SSE / IPC JSON | OOM / UI 卡死 / 慢 client 拖死 sidecar | `maybeSpill` + `/refs/:id` + SSE 优先级队列 |
| Sidecar 路由直接给 WebView fetch 使用却不带 `Access-Control-Allow-Origin` | 渲染器 native `fetch('http://127.0.0.1:<port>/...')` 拿到 opaque 响应，被 WebKit 拒绝可读，JS 侧报 `TypeError: Load failed`（#109 实战出现）。绝大部分 sidecar 接口走 Tauri invoke proxy 不走原生 fetch，所以这条只对**渲染器直连 sidecar HTTP 端口**的接口生效（比如 `>1MB` 溢出回 ref-url 的 `/refs/:id`、附件 `/attachment/*`） | 这类接口必须返回 `Access-Control-Allow-Origin: '*'`。已有惯例：`fileResponse(path, { headers: { 'Access-Control-Allow-Origin': '*' } })`。CSP 同步——`connect-src` 里的 `http(s)://...` 条目要同步出现在 `fetch-src` 里（fetch-src 在 WebKit 上是非标准但被实现，部分场景真的会拦） |
| 同步 busy-wait（`Atomics.wait` / spin / `while Date.now()`） | 阻塞 event loop / pegs CPU | 异步 polling / 现成 helper |
| readiness 等同 liveness | renderer 假就绪 | `/health/{live,ready,functional}` 三分；renderer 挂 `/health/ready` |
| `src/server/tools/*.ts` 顶层 import SDK / zod | builtin MCP 懒加载失效，冷启动每次税 ~1s | factory 内部 `await import(...)`（ESLint 已封禁顶层） |
| 直接设置 `shouldAbortSession = true` | generator 永久阻塞 | `abortPersistentSession()` |
| 函数参数用 `undefined` / `null` 表特定动作 | 内部调用方误触发 | 自解释字面量（如 `'subscription'`） |
| 新增 SSE 事件不注册白名单 | 前端静默丢弃 | 在 `SseConnection.ts::JSON_EVENTS` 注册 |
| Sidecar 用 `__dirname` / `readFileSync` | esbuild 硬编码路径，生产出错 | 内联常量 / `fileURLToPath(import.meta.url)` / `getScriptDir()` |
| 日志日期用 UTC `toISOString` | 与本地日期文件名不匹配 | `localDate()`（`shared/logTime.ts`） |
| Rust 日志用 `log::info!` | 不进统一日志 | `ulog_info!` / `ulog_error!` |
| 前端 `@tauri-apps/plugin-fs` 读写工作区 | Tauri fs scope 仅覆盖 `~/.myagents/**` | `invoke('cmd_read_workspace_file')` / `cmd_write_workspace_file` |
| 工作区文件 IO 走 sidecar HTTP（`/api/files/*`、`/api/commands`、`/api/git/branch`、`/api/claude-md`、`/agent/{dir,dir/expand,file,download,import,new-file,new-folder,rename,delete,move,open-in-finder,open-with-default,open-path,search-files,check-paths,save-file}` 共 18 个端点） | 启动页没有 Sidecar，这些路径在 launcher 直接死掉（PRD 0.2.7 实战：`'API 未就绪'` toast、空斜杠菜单）；把"AI runtime 容器"和"OS 文件操作"耦合，云端协作时分不开 | 走 Rust invoke：`cmd_workspace_*`（见 `src-tauri/src/workspace_files/`）。前端入口 `useWorkspaceFileService(workspacePath)`；绝对路径揭示用 `cmd_open_path_external`（Skill/Command 详情面板）；CLAUDE.md 编辑用 `cmd_workspace_read_claude_md` / `cmd_workspace_write_claude_md`。**18 个 sidecar 端点已全部下线（v0.2.7 Phase E）**；ESLint `no-restricted-syntax` 规则封禁了字面量复用 |
| Chat / Launcher 各自实现"选项变更持久化" | 字段集合 / 分支条件漂移（v0.2.7 之前 Chat 把 external runtime 的 permission mode 写到 `Agent.permissionMode` 而不是 `runtimeConfig.permissionMode`，launcher 是对的；cross-protocol guard 仅 Chat 有；MCP 写盘字段也不同） | 调统一 `persistInputOptionChange(...)`（`src/renderer/api/persistInputOption.ts`）。helper 接 `sessionId` / `isExternalRuntime` / `currentRuntimeConfig`，分支由它处理。新增字段只改这一个文件 |
| 依赖用户系统安装的运行时 | 用户未装 → 功能不可用 | 内置 Node.js（`runtime.ts::getBundledNodePath()`） |
| 用 `existsSync` / `Path::exists()` 当"路径上有没有东西"探针，紧接着 `cpSync({recursive:true})` / `fs::create_dir_all` / `fs::remove_dir_all` 跑过去 | 跟随 symlink 语义 → **断链 symlink 返回 false** → 代码以为不存在 → Node v24 `cpSync` 走进 `std::filesystem::equivalent` 抛**未捕获 C++ 异常**（`libc++abi: filesystem error: in equivalent: Operation not supported`），JS try/catch 接不住，整个 sidecar abort，Tauri 健康检查重启 → 死循环（v0.2.5 实战：`~/.myagents/skills/docx` 是断链让全局 sidecar 起不来）。注意 async `fs.cp` 不崩，**只有 sync `cpSync` 崩** | 在跑写操作之前 MUST 用**不跟随 symlink** 的 API 探：Node 用 `lstatSync` + `existsSync` 双探（`isSymbolicLink && !existsSync` ⇒ 断链，先 `unlinkSync`），Rust **MUST 用 `fs::symlink_metadata`，不要用 `fs::metadata()`**（后者跟随 symlink 与 `Path::exists()` 同病）；拿到 `Metadata` 后 `is_symlink() \|\| is_file()` → `remove_file`，是目录 → `remove_dir_all`。修复样板见 `src/server/index.ts::seedBundledSkills` 与 `src-tauri/src/commands.rs::cmd_sync_system_skills` |
| 新增 overlay / 可关闭面板不调 `useCloseLayer` | Cmd+W 跳过该面板直接关 Tab | `useCloseLayer(handler, zIndex)`，zIndex 与 CSS 一致 |
| Overlay 遮罩用裸 `<div>` + `onClick` / `onMouseDown` | 选中文字拖到面板外松手会误关 | `<OverlayBackdrop>` 组件 |
| onClick 里 `requestAnimationFrame(() => otherEl.focus())` 抢焦点 | macOS WebKit 触摸板 tap 会被吞掉 | `onMouseDown={retainFocusOnMouseDown}`（`@/utils/focusRetention`） |
| 前端硬编码颜色（`#fff`、`bg-blue-500`） | 破坏设计系统一致性 | CSS Token `var(--xxx)`，参考 DESIGN.md |
| 表单原生 `<select>` | 系统下拉框跨平台不一致 | `<CustomSelect>` 组件 |
| 新增手写 SDK shim 不加入 `_handwritten.json` | `generate:sdk-shims` 下次覆盖手写 | 同步加入 `sdk-shim/plugin-sdk/_handwritten.json` |

---

## 开发命令

```bash
npm install                       # 依赖安装（v0.2.0+ 统一 npm）
./start_dev.sh                    # 浏览器开发模式（快速迭代）
npm run tauri:dev                 # Tauri 开发模式（完整桌面体验）
./build_dev.sh                    # Debug 构建（含 DevTools）
./build_macos.sh                  # 生产构建
./publish_release.sh              # 发布到 R2
npm run typecheck && npm run lint # 代码质量检查
```

## Git 与工作流

- **提交前 MUST**：`npm run typecheck`，检查当前分支（`git branch --show-current`）
- **分支策略**：`dev/x.x.x` 开发 → 合并到 `main`。MUST NOT 在 main 直接提交
- **合并到 main**：需 typecheck + lint 通过 + 用户明确确认
- **Commit 格式**：Conventional Commits（`feat:` / `fix:` / `refactor:`）
- **发布流程**：先更新 CHANGELOG.md → `npm version` → `./build_macos.sh` → `./publish_release.sh` → push tag

## 日志与排查

日志来自三层（React / Node.js Sidecar / Rust），汇入统一日志 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。**用户报告问题时 MUST 主动读日志，不等用户粘贴。**

- **IM Bot 问题**：搜 `[feishu]` `[im]` `[telegram]` `[dingtalk]` `[bridge]` `[openclaw]`
- **AI / Agent 异常**：搜 `[agent]` `pre-warm` `timeout`
- **定时任务**：搜 `[CronTask]`
- **终端**：搜 `[terminal]`
- **Rust 层**：额外查 `~/Library/Logs/com.myagents.app/MyAgents.log`

详见 `tech_docs/unified_logging.md`。

---

## 内置 MA 小助理（修改约束）

应用内置 AI 助手运行在 `~/.myagents/`，通过 `/myagents-cli` system skill 调用 `myagents` CLI **直接执行**用户管理操作（不是输出操作步骤）。该 skill 是全局的——所有 session（Chat / IM Bot / Cron / Helper）都能用它驱动 MyAgents 的产品能力。

- 修改 `bundled-agents/myagents_helper/` 的 CLAUDE.md 或 Skills → MUST bump `ADMIN_AGENT_VERSION`（`src-tauri/src/commands.rs`）
- 修改 `src/cli/myagents.ts` 或 `src/cli/myagents.cmd` → MUST bump `CLI_VERSION`，并同步更新 `bundled-skills/myagents-cli/SKILL.md`（CLI surface 变化必须在 skill 文档里反映出来）+ bump `SYSTEM_SKILLS_VERSION`
- 修改 `bundled-skills/` 中 system skill（清单见 `SYSTEM_SKILLS`） → MUST bump `SYSTEM_SKILLS_VERSION`
- 新增 system skill：(1) 放入 `bundled-skills/<name>/`；(2) 加入 Rust `SYSTEM_SKILLS` 和 Node `src/server/index.ts::SYSTEM_SKILLS` 两个清单；(3) bump 版本
- **utility skill vs system skill**：清单内 = system（强制更新）；其它 = utility（首次 seed 后归用户）

---

## 求助 / 反馈

- `/help` — Claude Code 用法
- 反馈：https://github.com/anthropics/claude-code/issues
