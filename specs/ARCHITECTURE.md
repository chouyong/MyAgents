# MyAgents 架构总览

> 全景认知地图。每个模块只给"是什么 / 关键约束 / 跳转"。代码细节、踩坑案例、API surface 见 `tech_docs/`。

## 项目定位

MyAgents 是基于 Tauri v2 的桌面 AI Agent 客户端，提供 Claude Agent SDK 的图形界面。

支持：
- 多 Tab 对话
- IM Bot（Telegram / 钉钉 / OpenClaw 社区插件）
- 定时任务
- MCP 工具集成
- 多 Agent Runtime（Claude Code CLI / Codex CLI / Gemini CLI）
- 任务中心（想法速记 + 任务编辑 + 调度 + 状态机审计）

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 桌面框架 | Tauri v2 (Rust) |
| 后端 | Node.js v24 + Claude Agent SDK 0.2.119（多实例 Sidecar 进程） |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 拖拽 | @dnd-kit/sortable |

> **单一 runtime 原则**：所有 MyAgents 自己的代码（Sidecar / Bridge / CLI）跑在内置 Node.js v24 上。
> SDK native binary 子进程内部静态链接的 Bun 是 SDK 团队的实现细节，通过 stdio NDJSON 与我们通信，
> 我们不感知、不共享状态。详见 `tech_docs/bundled_node.md`。

## 全景架构图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Tauri Desktop App                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│                              React Frontend                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐ ┌──────────┐ ┌──────────────┐       │
│  │ Tab1 │ │ Tab2 │ │ Tab3 │ │Settings│ │ Launcher │ │  TaskCenter  │       │
│  └───┬──┘ └───┬──┘ └───┬──┘ └────┬───┘ └────┬─────┘ └──────┬───────┘       │
│      │        │        │         │           │              │               │
│  ┌───┴────────┴────────┴─┐   ┌───┴─────────────────────────┴──┐              │
│  │ Embedded Browser/Term │   │      Tab-scoped useTabState     │              │
│  │  (Tauri子Webview/PTY) │   │   apiGet/apiPost/SSE listeners  │              │
│  └───────────────────────┘   └─────────────────────────────────┘              │
├──────────────────────────────────────────────────────────────────────────────┤
│                              Rust Layer                                      │
│  ┌────────────────┐ ┌──────────────────┐ ┌─────────────────────────────┐    │
│  │ SidecarManager │ │ ManagedAgents +  │ │ CronTaskManager / TaskStore │    │
│  │ Session-1:1   │ │ ManagedImBots    │ │ ThoughtStore / SearchEngine │    │
│  │ Owner Model   │ │ (Channels)       │ │ (Tantivy + jieba)           │    │
│  └───────┬────────┘ └────────┬─────────┘ └─────────────────────────────┘    │
│          │                   │                                              │
│  ┌───────┴────────────────┐  ├─ Telegram (Bot API)                          │
│  │  HTTP/SSE Proxy        │  ├─ Dingtalk (Stream)                           │
│  │  (reqwest local_http)  │  └─ BridgeAdapter ───── Plugin Bridge (Node)    │
│  └───────┬────────────────┘                          ↕ HTTP                 │
│          │                                       OpenClaw 社区插件          │
│  ┌───────┴───────┐ ┌────────────────────┐ ┌──────────────────────────┐     │
│  │ Management API│ │  Tauri IPC         │ │  Embedded Terminal       │     │
│  │ (Node→Rust)   │ │  (cmd_*)           │ │  Embedded Browser        │     │
│  └───────────────┘ └────────────────────┘ └──────────────────────────┘     │
├──────────────────────────────────────────────────────────────────────────────┤
│                  Node.js Sidecar (per Session, 1:1)                         │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │  Runtime Selector (config.multiAgentRuntime gate)              │        │
│  │  ┌─────────────┬───────────────┬──────────┬──────────────┐     │        │
│  │  │ builtin SDK │ Claude Code   │ Codex    │ Gemini       │     │        │
│  │  │ (in-proc)   │ CLI (NDJSON)  │ CLI(JSON │ CLI (ACP     │     │        │
│  │  │             │               │ -RPC2.0) │  JSON-RPC)   │     │        │
│  │  └─────────────┴───────────────┴──────────┴──────────────┘     │        │
│  │                                                                 │        │
│  │  Builtin MCP (META/INSTANCE 懒加载):                            │        │
│  │   cron-tools / im-cron / im-media /                             │        │
│  │   gemini-image / edge-tts                                       │        │
│  │                                                                 │        │
│  │  External MCP via npx + 预置原生二进制 (cuse)                   │        │
│  │                                                                 │        │
│  │  OpenAI Bridge (DeepSeek/Gemini/Moonshot 协议翻译)              │        │
│  └─────────────────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────────┘
```

每个 Sidecar 服务一个 Session。Tab / CronTask / BackgroundCompletion / Agent 四种 Owner 共享同一 Sidecar，全部释放才停止进程。

---

## 核心抽象

理解以下抽象是改任何功能的前置认知。

### Sidecar Owner 模型

| 概念 | 说明 |
|------|------|
| **Sidecar = Agent 实例** | 一个 Sidecar 进程 = 一个 Claude Agent SDK 实例 |
| **Session : Sidecar = 1 : 1** | 每个 Session 最多一个 Sidecar，严格对应 |
| **后端优先，前端辅助** | Sidecar 可独立运行（定时任务、Agent Channel），无需前端 Tab |
| **Owner 模型** | Tab、CronTask、BackgroundCompletion、Agent 四种 Owner 是 Sidecar 的"使用者"。所有 Owner 释放后 Sidecar 才停止 |

```rust
pub enum SidecarOwner {
    Tab(String),                   // Tab ID
    CronTask(String),              // CronTask ID
    BackgroundCompletion(String),  // Session ID（AI 后台完成保活）
    Agent(String),                 // session_key（Agent Channel 消息处理）
}
```

### Tab-Scoped 隔离

每个 Chat Tab 拥有独立的 Node.js Sidecar 进程。

| 页面类型 | TabProvider | Sidecar 类型 | API 来源 |
|----------|-------------|--------------|----------|
| Chat | ✅ 包裹 | Session Sidecar | `useTabState()` |
| Settings | ❌ 不包裹 | Global Sidecar | `apiFetch.ts`（全局） |
| Launcher | ❌ 不包裹 | Global Sidecar | `apiFetch.ts`（全局） |
| IM Bot / Agent Channel | — (Rust 驱动) | Session Sidecar | Rust `ensure_session_sidecar()` |

不在 TabProvider 内的组件调用 `useTabStateOptional()` 返回 `null`，自动 fallback 到 Global API。

### 持久 Session

`messageGenerator()` 使用 `while(true)` 持续 yield，SDK subprocess 全程存活。

- 所有中止场景 MUST 使用 `abortPersistentSession()`（设置 abort 标志 + 唤醒 generator Promise 门控 + interrupt subprocess）
- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI "失忆"
- 所有 `await sessionTerminationPromise` 通过 `awaitSessionTermination(10_000, label)` 带 10 秒超时防护，防止死锁

**两种重启机制不要混淆：**

| 机制 | 行为 | 触发点 |
|------|------|--------|
| 直接 abort（`abortPersistentSession()`） | 立即中断 + interrupt subprocess | resetSession / switchToSession / rewindSession / recoverFromStaleSession / enqueueUserMessage provider change / provider proxy 凭证变化 / startup timeout / watchdog / end-of-turn drain / pre-warm drain |
| 延迟重启（`scheduleDeferredRestart('mcp' \| 'agents')`） | 合并防抖 + 下次 pre-warm 时柔性重启 | `setMcpServers` / `setAgents` |

### Pre-warm 机制

- MCP / Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步**不**触发
- 持久 Session 中 pre-warm 就是最终 session，用户消息通过 `wakeGenerator()` 注入
- 任何 `!preWarm` 条件守卫都可能在持久模式下永远不执行
- 新增配置同步端点时，确保 `currentXxx` 变量在 pre-warm 前已设置

**MCP 配置权威来源分离：**
- Tab 会话的 MCP 由前端 `/api/mcp/set` 配置（`initializeAgent` 中 MUST NOT self-resolve MCP）
- IM / Cron 会话的 MCP 由 self-resolve 从磁盘读取
- 混用会导致 fingerprint 差异 → abort → 30s 重启循环

### Rust 代理层

所有前端 HTTP / SSE 流量 MUST 通过 Rust 代理层（`invoke` → Rust → reqwest → Node.js Sidecar）。**禁止**从 WebView 直接发起 HTTP 请求。

所有连接本地 Sidecar（`127.0.0.1`）的 reqwest 客户端 MUST 通过 `crate::local_http::*` 创建，内置 `.no_proxy()` 防止系统代理拦截 → 502。

详见 `tech_docs/pit_of_success.md` 的 `local_http` 节。

---

## 通信模式

### SSE 流式事件

Rust SSE Proxy (`src-tauri/src/sse_proxy.rs`) 多连接代理，按 Tab 隔离事件：

```
事件格式: sse:${tabId}:${eventName}
示例:     sse:tab-xxx:chat:message-chunk
```

```
Tab1 listen('sse:tab1:*') ◄── Rust emit(sse:tab1:event) ◄── reqwest stream ◄── Sidecar:31415
Tab2 listen('sse:tab2:*') ◄── Rust emit(sse:tab2:event) ◄── reqwest stream ◄── Sidecar:31416
```

Node.js SSE Server (`src/server/sse.ts`) 管理客户端连接、heartbeat、广播：
- `broadcast(event, data)` —— 向所有客户端广播
- **Last-Value Cache** —— 缓存 `chat:status` 最新值。新 SSE 客户端连接时自动 replay
- **日志降噪** —— 高频流式事件（chunk / delta）跳过 `console.log`

新增 SSE 事件 MUST 在 `SseConnection.ts::JSON_EVENTS` 注册白名单，否则前端静默丢弃。

### HTTP API 调用

```
Tab1 apiPost() ──► getSessionPort(session_123) ──► Rust proxy ──► Sidecar:31415
Tab2 apiPost() ──► getSessionPort(session_456) ──► Rust proxy ──► Sidecar:31416
```

### Tauri IPC

用于不需要流式的 Rust ↔ 前端调用：
- 内嵌终端事件（`terminal:data:{id}`）
- 内嵌浏览器事件（`browser:url-changed:{tabId}`）
- 任务状态变更（`task:status-changed`）
- 工作区文件变更（`workspace:files-changed:{eventKey}`，`eventKey` 由 `watch_start` 返回）
- 工作区文件操作（`cmd_workspace_*`，所有 `src-tauri/src/workspace_files/` 命令）
- Sidecar 端口查询、Session 激活管理

不走 SSE Proxy。

### Management API（Node→Rust 反向通道）

`src-tauri/src/management_api.rs` 在 app 启动时监听 `127.0.0.1:${随机端口}`（axum），直接暴露 HTTP 路由给 Node 内部工具调用。端口通过 `MYAGENTS_MANAGEMENT_PORT` 注入到 Sidecar 进程。

| 前缀 | 职责 | 调用方 |
|------|------|--------|
| `/api/cron/*`（9 条） | CronTask CRUD + 调度控制 | CLI、`im-cron-tool.ts` |
| `/api/task/*`（13 条） | Task Center 任务 CRUD + run/rerun + doc 读写 | CLI、`admin-api.ts` |
| `/api/thought/*`（2 条） | 想法 create / list | CLI、`admin-api.ts` |
| `/api/im/*` + `/api/im-bridge/*` | IM Bot 唤醒 + 媒体下发 + Plugin Bridge 回调 | Node.js / 社区插件 Bridge |
| `/api/plugin/*`（3 条） | OpenClaw 插件 CRUD | CLI |
| `/api/agent/runtime-status` | Agent 运行时状态查询 | Node.js / 前端 |

这是项目内**唯一**的"Node → Rust"反向 HTTP 通道，规避了"所有前端 HTTP 走 Rust proxy → Node"主流向对后端间通信的不适配。所有客户端 MUST 走 `crate::local_http::builder()`（loopback，仍复用 no_proxy 保护）。

---

## 模块地图

每个模块：一段简介 + 关键文件 + 跳转。

### 1. Sidecar Manager (`src-tauri/src/sidecar.rs`)

Tauri State `ManagedSidecars` 管理 `HashMap<sessionId, SessionSidecar>`。Owner 释放规则保证生命周期收敛。

**IPC 命令：**

| 命令 | 用途 |
|------|------|
| `cmd_ensure_session_sidecar` | 确保 Session 有运行中的 Sidecar |
| `cmd_release_session_sidecar` | 释放 Owner 对 Sidecar 的使用 |
| `cmd_get_session_port` | 获取 Session 的 Sidecar 端口 |
| `cmd_activate_session` / `cmd_deactivate_session` | Session 激活管理 |
| `cmd_upgrade_session_id` | Session ID 升级（场景 4 handover） |
| `cmd_start_global_sidecar` | 启动 Global Sidecar |
| `cmd_stop_all_sidecars` | 应用退出清理 |

冷启动性能详见 `tech_docs/sidecar_cold_start.md`。

### 2. Multi-Tab 前端 (`src/renderer/context/`)

| 组件 | 职责 |
|------|------|
| `TabContext.tsx` | Context 定义，提供 Tab-scoped API |
| `TabProvider.tsx` | 状态容器，管理 messages / logs / SSE / Session |

Tab 内 MUST 用 `useTabState()` 的 `apiGet` / `apiPost`，禁止全局 `apiPostJson` / `apiGetJson`（会发到 Global Sidecar）。

### 3. 系统提示词组装 (`src/server/system-prompt.ts`)

三层 Prompt 架构：

| 层 | 用途 | 何时包含 |
|----|------|---------|
| **L1** 基础身份 | 告诉 AI 运行在 MyAgents 产品中 | 始终 |
| **L2** 交互方式 | 桌面客户端 / IM Bot / Agent Channel | 互斥选一 |
| **L3** 场景指令 | Cron 定时任务上下文 / IM 心跳 / Browser Storage | 按需叠加 |

```typescript
type InteractionScenario =
  | { type: 'desktop' }
  | { type: 'im'; platform: 'telegram' | 'feishu'; sourceType: 'private' | 'group'; botName?: string }
  | { type: 'agent-channel'; platform: string; sourceType: 'private' | 'group'; botName?: string; agentName?: string }
  | { type: 'cron'; taskId: string; intervalMinutes: number; aiCanExit: boolean };
```

### 4. 自配置 CLI (`src/cli/` + `src-tauri/src/cli.rs`)

内置命令行 `myagents`，让 AI 和用户都能通过 Bash 管理应用配置（MCP / Provider / Agent / Cron / Plugin），能力与 GUI 对等。

**两个使用场景：**

| 场景 | 调用方式 | 端口来源 |
|------|---------|---------|
| AI 内部调用（主要） | SDK Bash 工具 → `myagents mcp add ...` | `MYAGENTS_PORT` 环境变量 |
| 用户终端调用 | `MyAgents mcp list` | `~/.myagents/sidecar.port` 文件 |

为什么 CLI 放在 `~/.myagents/bin/` 而非 app bundle：SDK 子进程 PATH 不含 app bundle 内部路径；shebang 执行需要可执行权限和去掉 `.ts` 后缀；`~/.myagents/bin/` 是跨平台稳定的工具投放点。

详见 `tech_docs/cli_architecture.md`。

### 5. 定时任务系统

**Rust 层**（`src-tauri/src/cron_task.rs`）：
- `CronTaskManager` 单例，管理任务 CRUD、tokio 调度循环、持久化、崩溃恢复
- 三种 `CronSchedule`：`Every { minutes, start_at? }` / `Cron { expr, tz? }` / `At { at }`
- 调度器使用 wall-clock polling（`sleep_until_wallclock`），系统休眠后能正确唤醒
- 持久化：`~/.myagents/cron_tasks.json`（原子写入），执行记录 `~/.myagents/cron_runs/<taskId>.jsonl`

**Node.js 层**（`src/server/tools/im-cron-tool.ts`）：
- `im-cron` MCP server —— **所有 Session 可用**（不仅 IM Bot）
- 始终信任（`canUseTool` auto-allow），`list` / `status` 按工作区过滤

新增 `CronTask` 字段 MUST 带 `#[serde(default)]`。

### 6. Agent 架构 (`src-tauri/src/im/`)

```
Project (工作区)
  = Basic Agent（被动型，用户在客户端主动交互）
  + 可选的「主动 Agent」模式 → AgentConfig（24h 感知与行动）
    └── Channels: Telegram / Dingtalk / OpenClaw Plugin（飞书/微信/QQ 等）
```

**适配器：**

| 适配器 | 协议 | 说明 |
|--------|------|------|
| `TelegramAdapter` | Bot API 长轮询 | 内置，消息收发 / 白名单 / 碎片合并 |
| `DingtalkAdapter` | Stream 长连接 | 内置，消息收发 |
| `BridgeAdapter` | HTTP 双向转发 | OpenClaw 社区插件，Rust → 独立 Node.js Bridge 进程 |

详见 `tech_docs/im_integration_architecture.md`。

### 7. Plugin Bridge (`src/server/plugin-bridge/`)

独立 Node.js 进程加载 OpenClaw Channel Plugin。MUST 与 Sidecar 保持同等待遇（环境变量注入、日志宏、config 查询范围）。

**关键约束：**
- **入口解析协议**：按 OpenClaw 官方 `package.json["openclaw"].extensions[]` 读取，**不再**信任 `main` / `exports`
- **CJS+ESM 混用插件兼容**：通过 `module.registerHooks()` 同步 loader hook 拦截 `openclaw-plugins/*/node_modules/**` 下所有 `.js` 文件
- **始终注入 `--import tsx/esm`**（dev 和 prod 都要）
- **SDK Shim 全量覆盖**：手写 + 自动生成 stub。手写模块受 `_handwritten.json` 清单保护
- **Shim 修改 MUST bump 版本**：三处同步（`sdk-shim/package.json` / `compat-runtime.ts` / `bridge.rs::SHIM_COMPAT_VERSION`）

详见 `tech_docs/plugin_bridge_architecture.md`。

### 8. 三方供应商支持 (OpenAI Bridge)

`src/server/openai-bridge/`：当供应商使用 OpenAI 协议（DeepSeek / Gemini / Moonshot），SDK 的 Anthropic 请求 loopback 到 Sidecar 的 Bridge handler，翻译为 OpenAI 格式后转发：

```
SDK subprocess → ANTHROPIC_BASE_URL=127.0.0.1:${sidecarPort}
  → /v1/messages → Bridge handler → translateRequest → upstream OpenAI API
  → translateResponse → Anthropic 格式 → SDK
```

**模型别名映射：** 子 Agent 指定 `model: "sonnet"` 时，SDK 通过 `ANTHROPIC_DEFAULT_SONNET_MODEL` 解析为供应商模型。三个别名变量：`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`。

**Provider Self-Resolve：** IM/Cron Session 的 Provider 和 Model 从磁盘自 resolve，不依赖前端 `/api/provider/set`。解析链：`agent.providerId → config.defaultProviderId → persisted snapshot`。

详见 `tech_docs/third_party_providers.md`。

### 9. Multi-Agent Runtime

除内置 Claude Agent SDK（builtin）外，支持 Claude Code CLI、OpenAI Codex CLI、Google Gemini CLI 作为外部 Runtime。功能门控：`config.multiAgentRuntime`（默认关闭，设置 → 关于 → 实验室）。

**抽象层**（`src/server/runtimes/`）：

| 文件 | 职责 |
|------|------|
| `types.ts` | `AgentRuntime` 接口 + `UnifiedEvent` 联合类型 |
| `factory.ts` | Runtime 工厂，`getCurrentRuntimeType()` 读 `MYAGENTS_RUNTIME` 环境变量 |
| `claude-code.ts` | CC Runtime：NDJSON over stdio，`-p` 模式 |
| `codex.ts` | Codex Runtime：JSON-RPC 2.0 over stdio，`app-server` 持久进程 |
| `gemini.ts` | Gemini Runtime：ACP JSON-RPC 2.0 over stdio，`gemini --acp` |
| `external-session.ts` | 统一会话管理：内容块持久化、配置变更、并发守卫、看门狗、Token 用量 |

**门控链路：** Rust `sidecar.rs` 启动 Sidecar 时读取 `config.multiAgentRuntime` + `agent.runtime` → 注入 `MYAGENTS_RUNTIME` 环境变量 → Node.js `factory.ts` 读取 → `shouldUseExternalRuntime()` 分流。前端 `Chat.tsx` 用同样门控决定 `currentRuntime`。

新增 config 同步端点时，MUST 检查 `shouldUseExternalRuntime()` 并分流到 `external-session.ts`。

详见 `tech_docs/multi_agent_runtime.md`。

### 10. Session 切换与持久化

| 场景 | 描述 | 行为 |
|------|------|------|
| 1 | 新 Tab + 新 Session | 创建新 Sidecar |
| 2 | 新 Tab + 其他 Tab 正在用的 Session | 跳转到已有 Tab |
| 3 | 同 Tab 切换到定时任务 Session | 跳转 / 连接到 CronTask Sidecar |
| 4 | 同 Tab 切换到无人使用的 Session | **Handover**：Sidecar 资源复用 |

**编排收敛**（PRD 0.2.6）：所有切换入口（`handleSwitchSession` / `handleLaunchProject` / `OPEN_SESSION_IN_NEW_TAB`）MUST 通过纯函数 `src/renderer/utils/sessionOpenPlan.ts::planSessionOpen()` 拿到统一 plan 类型（`jump-to-tab` / `open-new-tab` / `attach-existing-sidecar` / `switch-current-tab`）再执行。**plan 内 cron-attach 必须排在 runtime-mismatch 检查前**——否则 cron-owned session 会被路由到 new-tab 路径丢失 task_id 激活。

**Cross-runtime 检测**：比较**目标 session.runtime vs 当前 Tab 已加载 session.runtime**（agent template 仅在没有当前 session 时 fallback）。Agent.runtime 可从 Tab 已冻结的 session.runtime 漂移，旧实现以 agent 为基准会让漂移触发不必要的 fork。

**Loading 安全**：`TabProvider.loadSession()` MUST `await /sessions/switch` 成功后再替换 history；失败时保留可见 messages、回滚 `currentSessionIdRef`，让 UI 与后端始终一致。

**Live config 采纳**：Tab 加入活跃 IM/Cron Sidecar 时，`/api/session/config` 返回 sidecar 的 runtime + external-runtime model + permissionMode，Tab 采纳 live config 而非 push 自己的；Chat 用 sticky `adoptedSessionRef` 防止 sessionMeta hydration 覆盖已采纳的值。

**分层 Config Snapshot：** Session 创建时按 Owner 类型选择 config 快照策略：

| Owner 类型 | Snapshot helper | 策略 |
|-----------|----------------|------|
| Tab / Cron / Background | `snapshotForOwnedSession(agent)` | 冻结 model / permission / MCP / provider / runtime |
| IM / Agent Channel | `snapshotForImSession(agent)` | 只记 runtime；其它每次消息 live resolve |

读侧通过 `resolveSessionConfig(sessionMeta, ownerKind)` 统一消费。详见 `tech_docs/pit_of_success.md` 的「Snapshot Helpers」节。

跨 Runtime Session 保护见模块 9 的「跨 Runtime Session 保护」节，详见 `tech_docs/multi_agent_runtime.md`。

### 11. 内嵌终端 (`src-tauri/src/terminal.rs` + `src/renderer/components/TerminalPanel.tsx`)

Chat 分屏右侧面板的交互式 PTY 终端，工作目录为当前工作区。

```
用户按键 → xterm.onData → invoke('cmd_terminal_write') → PTY master write
PTY master read → emit('terminal:data:{id}') → xterm.write → 屏幕渲染
```

**关键设计：**
- Rust `TerminalManager` 管理 `HashMap<String, TerminalSession>`，每个 session 持有 PTY pair（`portable-pty`）
- 不走 SSE Proxy，用 Tauri event
- 终端绑定 Tab 生命周期，面板关闭不杀进程
- 环境注入：内置 Node.js + `~/.myagents/bin` + `MYAGENTS_PORT` + `TERM=xterm-256color`
- Shell 以 login shell（`-l`）启动
- 主题：日间 / 夜间双主题自动切换（MutationObserver 监听 `<html>.dark`）

PTY 进程由 `portable-pty` 管理，**不走** `process_cmd`。

### 12. 内嵌浏览器 (`src-tauri/src/browser.rs` + `src/renderer/components/BrowserPanel.tsx`)

Chat 分屏右侧面板的 URL 预览器（Tauri Multi-Webview）。AI Markdown 链接和 HTML 文件优先在此打开。

**关键设计：**
- 依赖 Tauri `"unstable"` feature（`Window::add_child()` 多 Webview API）
- **安全隔离**：`browser.json` Capability 零权限，Webview 无法访问 Tauri IPC；`on_navigation` 限制 http/https scheme
- **Overlay 协调**：原生 Webview 浮于 React DOM 之上，Overlay 出现时通过 `closeLayer.hasOverlayLayer()` 自动 hide
- **Cookie 持久化**：同 App 所有 Webview 共享，默认持久化磁盘
- **关闭即销毁**，不后台保活

### 13. 层级关闭系统 (`src/renderer/utils/closeLayer.ts`)

Cmd+W 层级关闭：Overlay → 分屏面板 → Tab，高 z-index 优先。

- 注册表：模块级 `layers[]` 数组，每个 Overlay/面板 mount 时 `registerCloseLayer(handler, zIndex)`，unmount 自动 deregister
- 优先级：以组件 CSS z-index 为排序依据（z-300 ConfirmDialog > z-200 WorkspaceConfigPanel > z-0 分屏面板）
- 同级 LIFO：相同 z-index 按注册顺序后进先出（最新 mount 的先关闭）
- Hook：`useCloseLayer(handler, zIndex)` —— 一行集成
- 浏览器联动：`hasOverlayLayer()` 当有 z-index > 0 注册层时自动隐藏原生 Webview

新增 overlay/可关闭面板 MUST 调用 `useCloseLayer`，否则 Cmd+W 会跳过该面板直接关 Tab。

### 14. 全文搜索引擎 (`src-tauri/src/search/`)

基于 Tantivy + tantivy-jieba 的 Rust 子系统。`SearchEngine` Tauri managed state 单例，为两类查询提供全文检索：Session 历史（跨工作区）与工作区文件内容。

**仅 Tauri 可用** —— 前端通过 `invoke('cmd_search_*')` 直接调 Rust，不经 Sidecar。浏览器开发模式不提供 fallback。

**关键设计：**
- Session 索引：单一全局索引 `~/.myagents/search_index/sessions/`
- Session watcher：`notify-debouncer-full` 5s 滑动去抖观察 `~/.myagents/sessions/`，**任何**写入者的变更都自动流入索引
- 读写并发：`Arc<SessionIndex>`（无外层 mutex），读路径 lock-free
- 中文分词：`tantivy-jieba`（~37 万词词典），字段 MUST 显式 `"chinese"` tokenizer
- Schema 版本门控：`SCHEMA_VERSION` + `.schema_version` 磁盘 marker，不一致时自动删除重建

详见 `tech_docs/search_architecture.md`。

### 15. Skill URL 安装 (`src/server/skills/`)

支持从 GitHub 链接、`npx skills add` 命令或直连 zip 一键把社区 skill 装到 `~/.myagents/skills/`（或当前工作区 `.claude/skills/`）。

**三段流水线：**
```
url-resolver.ts      — 宽容解析 → ResolvedSkillSource
    ▼
tarball-fetcher.ts   — codeload.github.com 下载 zip → 内存解包 + 安全限额
    ▼
installer.ts         — 扫描 SKILL.md / marketplace.json → InstallAnalysis
```

**安全限额：** tarball ≤ 50MB、单文件 ≤ 5MB、文件总数 ≤ 2000、超时 60s、Zip-Slip 防御。

**MVP 明确不支持：** GitLab、私有仓库、git SSH URL、搜索集成、市场订阅持久化、`skill update`、跨 IDE symlink 同步、npm spec 形态。

详见 `guides/skill_marketplace.md`。

### 16. 任务中心 (`src-tauri/src/task.rs` + `src-tauri/src/thought.rs` + `src/renderer/components/task-center/`)

把"想法速记 → 对齐 → 派发 → 执行 → 验收 → 审计"的完整工作流一等公民化。

**两个持久化 Store：**
- `ThoughtStore` —— `~/.myagents/thoughts/<YYYY-MM>/<id>.md`
- `TaskStore` —— `~/.myagents/tasks.jsonl` + `~/.myagents/tasks/<id>/{task.md, verify.md, progress.md, alignment/}`

**关键设计：**
- Task 状态机 + 审计链（每次状态变更原子写入 `statusHistory`）
- Task ↔ CronTask 反向指针：Task 不自己跑，登记 `CronTask { task_id }`，调度器 tick 时动态构造 Prompt（用户中途编辑 task.md 立即生效）
- AI 讨论路径：想法卡 →「AI 讨论」打开新 Tab + 注入 `task-alignment` Skill → 完成后 `myagents task create-from-alignment`
- 状态变更广播 Tauri event `task:status-changed`（非 SSE），所有打开的任务中心 Tab 实时同步

详见 `tech_docs/task_center.md`。

---

### 17. 工作区文件 IO (`src-tauri/src/workspace_files/`)

把 "OS 文件操作" 从 "AI runtime 容器（Sidecar）" 里剥出来，走 Tauri invoke 而非 Sidecar HTTP。

**核心动机：**
- 启动页（Launcher）没有 Sidecar，但仍要能 @ 文件、列 / 命令、附图、新建/重命名 — 不能依赖 AI runtime 起来。
- 未来云端协作把 "客户端" 与 "AI runtime" 分进程 / 分主机时，文件操作天然留在客户端侧。

**模块结构（`src-tauri/src/workspace_files/`）：**

| 子模块 | 职责 | 暴露的 cmd |
|------|------|-----------|
| `path_safety` | 唯一路径解析 chokepoint：`validate_workspace_root`、`resolve_inside_workspace`（lexical，写侧）、`resolve_existing_inside_workspace`（canonicalize，读侧）、`validate_item_name`（含 Windows reserved name + trailing dot/space）、`sanitize_filename` | — |
| `tree` | 工作区目录树初始化 + 懒展开 | `cmd_workspace_dir_tree` / `cmd_workspace_dir_expand` |
| `read_preview` | 文本文件预览（≤512KB，bounded read 防 TOCTOU 增长） | `cmd_workspace_read_preview` |
| `download` | 二进制下载（≤25MB，base64 IPC） | `cmd_workspace_download_file` |
| `crud` | new-file / new-folder / rename / move（symlink-safe `slot_occupied`） | 4 个 cmd |
| `delete` | 删除（含断链 symlink） | `cmd_workspace_delete` |
| `transfer` | drag-drop 路径拷贝（路径侧），symlink-safe collision check | `cmd_workspace_copy_paths` |
| `files_b64` | drag-drop 字节侧（base64 IPC，import + read），拒 symlink + bounded read 防身份伪装 | `cmd_workspace_import_files_b64` / `cmd_workspace_read_files_b64` |
| `check_paths` | 200-batch existence 探针（与读侧 symlink-escape gate 一致，挡 chip 假阳性） | `cmd_workspace_check_paths` |
| `gitignore` | `.gitignore` append（`with_file_lock_blocking` 串行写） | `cmd_workspace_add_gitignore` |
| `slash` | / 命令扫描（builtin + 项目 + 用户 skills；`agent-browser` Windows 屏蔽） | `cmd_list_slash_commands` |
| `search` | 模糊文件名搜索（fuzzy_matcher，跳 node_modules / dotfiles） | `cmd_workspace_search_files_fuzzy` |
| `git_branch` | 当前 git 分支查询 | `cmd_workspace_git_branch` |
| `system_open` | 揭示在文件管理器 / 默认应用打开（`process_cmd::new` 防 Windows console flash） | `cmd_workspace_open_in_finder` / `cmd_workspace_open_with_default` / `cmd_open_path_external`（绝对路径，过 credential 黑名单） |
| `watcher` | 进程级 fs watcher 注册表（ref-counted，token-based handle） | `cmd_workspace_watch_start` / `cmd_workspace_watch_stop` |

**关键约束：**

- **路径解析**：写侧 lexical（路径可不存在），读侧 canonical（防 `evil_link → /etc/passwd` 符号链逃逸）。两套 helper 命名带 "_existing_" 后缀区分。
- **symlink-safe 写**：`crud.rs::slot_occupied` / `transfer.rs::slot_occupied` 用 `fs::symlink_metadata` 不是 `Path::exists()`（断链 symlink 会被后者误报为空，CLAUDE.md v0.2.5 红线）。
- **bounded read**：所有读取大文件命令用 `File::open + take(MAX+1).read_to_end`（不是 `fs::read_to_string`），防 TOCTOU 文件增长被 OOM。
- **watcher token**：`watch_start` 返回 `{token, eventKey}` 而非按路径派生 key — 进程内 monotonic counter + per-process nonce，跨进程 token 不复用。锁顺序固定 REGISTRY → TOKENS（防未来死锁）。
- **CORS 不涉及**：所有命令走 Tauri invoke，不挂 HTTP 端口。

**前端入口：**

- `useWorkspaceFileService(workspacePath)` — 唯一对前端开放的 hook。返回 `useMemo` 稳定的服务对象，每方法 `useCallback` 包装。所有方法的 JSDoc 标注 `[requires workspace]` vs `[workspace-free]`，传 `null` 也能调 workspace-free 方法（`openPathExternal` / `readPathsAsBase64` / `watchStop`）。
- `persistInputOptionChange(...)` (`src/renderer/api/persistInputOption.ts`) — Chat 和 Launcher 共用的 "选项变更持久化" helper，分支条件（`isExternalRuntime` / `runtimeConfig` / MCP push）由它处理。新增字段只改这一个文件。

**Phase 状态：**

- Phase A-D（v0.2.7）：launcher 输入框 + DirectoryPanel 迁移。
- Phase D.5（v0.2.7）：FileActionContext / FilePreviewModal / Markdown / Skill·Command 详情面板的残余 sidecar HTTP 调用全部迁移；watcher 改 token API；读侧加 symlink-escape gate；`cmd_open_path_external` 套 credential 黑名单。
- Phase E（v0.2.7，已完成）：sidecar 端 18 个 workspace IO endpoint 全部删除（`/api/files/*`、`/api/commands`、`/api/git/branch`、`/api/claude-md`、`/agent/{dir,file,download,save-file,...}`）；`syncSkillsIfNeeded` wrapper + 生成号优化删除（Rust `cmd_list_slash_commands` 总是 sync，幂等）；`/agent/save-file` 与 `/api/claude-md` 加新 Rust cmd（`cmd_workspace_save_file` / `cmd_workspace_read_claude_md` / `cmd_workspace_write_claude_md`）。`file-watcher.ts` 与 `agent:files-changed` SSE 同步删除——renderer 走 Tauri event。ESLint `no-restricted-syntax` 规则封禁被删 endpoint 字面量复活。

---

### 18. Tool Attachment 一等公民管道 (v0.2.15)

AI 运行时（Codex / 未来 Gemini / CC / builtin）产出的富媒体（图片为主，预留音频/PDF）走同一条
`UnifiedEvent.tool_result.attachments[]` 通道，前端用单一 `ToolAttachmentGallery` 组件渲染。
本期 wire 上 Codex Runtime；builtin SDK / Gemini / CC 接入留 v0.2.16+。

**关键设计：**

- **协议一等公民**：`UnifiedEvent.tool_result` 加 optional `attachments?: ToolAttachment[]`；新增
  `tool_attachment_update` event 用于异步 placeholder 填充。`PersistContentBlock.tool.attachments?`
  随之扩展，老 sessions 反序列化时该字段 undefined，向后兼容
- **三种落盘源**：base64（OpenAI `image_generation_call.result`）/ externalPath（Codex savedPath
  零拷贝引用）/ url（dynamicToolCall.imageUrl 走 cancellableFetch 拉取）
- **异步落盘不阻塞 SSE**：`scheduleAttachmentSave` fire-and-forget，先 emit placeholder + pendingId，
  落盘成功后 `tool_attachment_update` 第二轮 SSE patch；`persistTurnResult` 进入即
  `await awaitInFlightSaves()` 防 placeholder 飞越 turn 边界 stranded 在磁盘上
- **session resume 重 register**：`rebuildAttachmentRegistryFromBlocks` 在 `startExternalSession`
  载入历史时调用，把 Codex savedPath 重新注册进 in-process registry，解决 sidecar restart 后
  attachment 404
- **5 层路径校验**：blacklist + canonicalize symlinks（读侧 default true）+ 拒绝 symlink leaf +
  positive allow-list（仅 `~/.codex/` `~/.myagents/` `~/Documents/` 等）+ trusted root（写侧）
- **SSRF 防护**：URL 下载限定 `https:` + 拒绝 loopback / RFC1918 / 169.254/16 / IPv6 ULA +
  `redirect: 'error'`
- **错误暴露面**：`makeErrorAttachment` 把 throw 映射到固定 enum（`too_large` / `rejected_path` /
  `not_found` / `fetch_failed` / `unsupported_url` / `decode_failed` / `unknown`）；raw error.message
  不进 SSE / 不写 SessionStore（防绝对路径泄漏）
- **前端归一化**：`ToolUse.tsx` 在 specialized tool body 之后外挂 `ToolAttachmentGallery`；
  `TOOLS_THAT_OWN_GALLERY_PREFIXES = ['mcp__gemini-image__']` 老组件兜底自渲染避免双重显示；
  `mergeAttachmentsByPendingId` 防 `tool-result-complete` 重发覆盖已 patched 的 entry

**多 Sidecar 边界**：attachment endpoint 注册在每个 Sidecar 的 HTTP server 上，Sidecar Owner 模型
决定 attachments 由 sessionOwner sidecar 持有；Handover scenario 4 切到目标 Sidecar 时通过
SessionStore 反查 attachments 重 register。跨 Sidecar fetch attachment **不支持**。

**HTTP endpoint**：`GET /api/attachment/tool/<sessionId>/<turnId>/<filename>`（CORS + Cache-Control
immutable）。第一轮查内存 `externalPathRegistry`（Codex savedPath 命中），miss 后 fallback 到
trusted root `~/.myagents/generated/tool-attachments/<sid>/<tid>/<file>`（base64/url 落盘命中）。

详见 `tech_docs/tool_attachment_pipeline.md`。

---

## Pit-of-Success 索引

每个模块在 helper 层把"正确路径"做成默认。完整 Problem / Surface / Invariants / Don't 见 `tech_docs/pit_of_success.md`。

| 模块 | 层 | 用途 |
|------|----|------|
| `local_http` | Rust | 防系统代理拦截 localhost → 502 |
| `process_cmd` | Rust | 防 Windows 控制台窗口弹出 |
| `proxy_config` | Rust | 子进程 NO_PROXY 注入 |
| `system_binary` | Rust | 系统工具查找（Finder PATH 缺失） |
| `tauri::async_runtime::spawn` + clippy ban | Rust | 防 macOS startup-abort（`tokio::spawn` 跨 FFI 不能 unwind） |
| Session watcher | Rust | 文件系统观察索引（写入路径解耦） |
| `withConfigLock` / `with_config_lock` | Node + Rust + renderer | `config.json` 跨进程串行写入 |
| `withFileLock` / `with_file_lock` | Node + Rust | 单写者文件原子性 |
| `killWithEscalation` | Node | 子进程 stop SIGTERM → SIGKILL → orphan 升级链 |
| `withAbortSignal` / `cancellableFetch` | Node | 统一 cancel 协议（fetch / stream / process） |
| `maybeSpill` + `/refs/:id` + SSE 优先级 | Node + Rust | 大 payload 流到 ref，SSE 三档队列 |
| `withLogContext` + ALS pipeline | Node + Rust | 自动注入 sessionId/tabId/turnId/runtime/requestId |
| `DeferredInitState` + readiness endpoints | Node | 三分健康探针（live/ready/functional） |
| `fs-utils` | Node | 跨平台 mkdir / 目录判定（Windows junction） |
| `subprocess` | Node | Bun→Node spawn 形态适配 |
| `file-response` | Node | 流式 HTTP 文件响应 |
| Builtin MCP META/INSTANCE 懒加载 | Node | 防冷启动每次付 ~1s SDK+zod 税 |
| Snapshot helpers | Node | owned vs live-follow 命名分裂 |
| Legacy CronTask CAS upgrade | Rust | 幂等迁移（防并发重复创建） |
| `saveToolAttachment` + `path-safety.ts` | Node | 任意工具图片产物统一落盘 + symlink-safe 路径校验 + SSRF 防护 |
| `awaitInFlightSaves` + `rebuildAttachmentRegistry` | Node | 异步 attachment 落盘的 turn-boundary 守卫 + session resume 重 register |

---

## 资源管理

| 事件 | 操作 |
|------|------|
| 打开/切换 Session | `ensureSessionSidecar(sessionId, workspace, ownerType, ownerId)` |
| 关闭 Tab | `releaseSessionSidecar(sessionId, 'tab', tabId)` |
| 定时任务启动 | `ensureSessionSidecar(sessionId, workspace, 'cron', taskId)` |
| 定时任务结束 | `releaseSessionSidecar(sessionId, 'cron', taskId)` |
| IM 消息到达 | `ensureSessionSidecar(sessionId, workspace, 'agent', sessionKey)` |
| IM Session 空闲超时 | `releaseSessionSidecar(sessionId, 'agent', sessionKey)` |
| 终端打开 | `cmd_terminal_create(workspace, rows, cols, port, id)` |
| 终端关闭 / Tab 关闭 | `cmd_terminal_close(terminalId)` |
| 浏览器打开 | `cmd_browser_create(tabId, url, x, y, width, height)` |
| 浏览器关闭 / Tab 关闭 | `cmd_browser_close(tabId)` |
| 任务立即执行 / 重新派发 | `task::run` → 登记 `CronTask { task_id }` + 触发调度 |
| Task 软删除 | `TaskStore::delete` → 写 `→ deleted` 伪状态 + 联动清理 thought |
| 应用退出 | `stopAllSidecars()` + `close_all_terminals()` + `close_all_browsers()` |

**Owner 释放规则：** 当一个 Session 的所有 Owner 都释放后，Sidecar 才停止。

---

## 安全设计

- **FS 权限：** Tauri scope 仅允许 `~/.myagents` 配置目录
- **Agent 目录验证：** 阻止访问系统敏感目录
- **Tauri Capabilities：** 最小权限原则
- **本地绑定：** Sidecar 仅监听 `127.0.0.1`
- **CSP：** `img-src` 允许 `https:`（支持 AI Markdown 图片预览），`connect-src` 和 `fetch-src` 严格锁定
- **代理安全：** `local_http` 模块内置 `.no_proxy()` 防止系统代理拦截 localhost
- **浏览器沙箱：** 内嵌浏览器 Webview 通过 Capability 隔离（`browser.json` 零权限），无法访问 Tauri IPC；URL scheme 限制为 http/https

---

## 跨平台策略

### 平台差异

| 特性 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 字体渲染 | 更平滑 | 更锐利 | 介于之间 |
| 窗口控制 | 左上红绿灯 | 右上三按钮 | 取决于桌面环境 |
| 滚动条 | 自动隐藏 | 常显示 | 取决于桌面环境 |
| Shell | zsh | PowerShell / cmd | bash |
| Console window 抑制 | — | `process_cmd::new()` 注入 `CREATE_NO_WINDOW` | — |
| 系统 PATH 查找 | `system_binary::find()`（Finder 启动 PATH 缺失） | — | — |

### 跨平台环境变量 (`src/server/utils/platform.ts`)

`buildCrossPlatformEnv()` 自动设置双平台变量：

| 用途 | macOS / Linux | Windows |
|------|--------------|---------|
| Home 目录 | `HOME` | `USERPROFILE` |
| 用户名 | `USER` | `USERNAME` |
| 临时目录 | `TMPDIR` | `TEMP` / `TMP` |

详见 `tech_docs/windows_platform.md` / `guides/linux_build_guide.md`。

---

## 单一运行时与预置二进制

### Node.js v24（唯一 MyAgents 自有 runtime）

| 用途 |
|------|
| Sidecar |
| Plugin Bridge |
| MCP Server (`npx`) |
| 社区 npm 包 |
| `myagents` CLI |
| AI Bash `node` / `npx` / `npm` |

打包位置：`src-tauri/resources/nodejs/`。

### SDK Native Binary（SDK 团队的实现细节）

`src-tauri/resources/claude-agent-sdk/claude[.exe]` —— SDK 0.2.113+ 用 `bun build --compile` 产物分发，内嵌 SDK team pin 的 Bun。独立进程，stdio NDJSON 与我们通信，**不感知、不共享状态**。

`src/server/agent-session.ts::resolveClaudeCodeCli()` 按 platform triple 定位。

### 预置原生二进制 MCP

| 二进制 | 用途 | 来源 | 打包位置 |
|--------|------|------|---------|
| **cuse** | 预置 Computer-Use MCP（截图/点击/输入/滚动，仅 macOS/Windows） | Cloudflare R2: `https://download.myagents.io/cuse/...`（源头是私有 `hAcKlyc/MyAgents-Cuse` GH Release，由该仓库的 `publish_r2.sh` 镜像到 R2 供本开源 repo build 使用） | `src-tauri/binaries/cuse-*-<triple>[.exe]` |

新增同类二进制约定：
- 注册到 `PRESET_MCP_SERVERS` 时用 `command: '__bundled_xxx__'` 哨兵
- 平台差异通过 `McpServerDefinition.platforms` 字段
- `build_macos.sh` 通配 `src-tauri/binaries/*-apple-darwin` 自动继承应用签名

### Git for Windows

Windows 无自带 git/bash，NSIS 静默安装 Git for Windows（`src-tauri/nsis/Git-Installer.exe`），SDK 依赖。

### PATH 注入

`buildClaudeSessionEnv()` 优先级：`systemNodeDirs`（用户安装的 Node.js） → `bundledNodeDir` → `~/.myagents/bin` → 系统路径。

详见 `tech_docs/bundled_node.md`。

---

## 日志与排查

### Boot Banner

应用启动和每个 Sidecar 创建时输出 `[boot]` 单行自检信息：
```
[boot] v=0.2.0 build=release os=macos-aarch64 provider=deepseek mcp=2 agents=3 channels=5 cron=12 proxy=false dir=/Users/xxx/.myagents
[boot] pid=12345 port=31415 workspace=/path session=abc-123 resume=true model=deepseek-chat bridge=yes mcp=playwright,im-cron
```

排查第一步：`grep '\[boot\]' ~/.myagents/logs/unified-*.log` 获取完整环境。

### 统一日志格式

三个来源汇入 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`（本地时间）：
- **[REACT]** 前端日志
- **[NODE]** Node.js Sidecar 日志（logger interceptor 直写）
- **[RUST]** Rust 层日志

详见 `tech_docs/unified_logging.md`。

---

## 开发脚本

### macOS

| 脚本 | 用途 |
|------|------|
| `setup.sh` | 首次环境初始化 |
| `start_dev.sh` | 浏览器开发模式 |
| `build_dev.sh` | Debug 构建（含 DevTools） |
| `build_macos.sh` | 生产 DMG 构建 |
| `publish_release.sh` | 发布到 R2 |

### Windows

| 脚本 | 用途 |
|------|------|
| `setup_windows.ps1` | 首次环境初始化 |
| `build_windows.ps1` | 生产构建（NSIS + 便携版） |
| `publish_windows.ps1` | 发布到 R2 |

详见 `guides/windows_build_guide.md`。

---

## 深度文档索引

按场景分组：

### 启动与运行时
- [Node.js 打包架构](./tech_docs/bundled_node.md) — 内置 Node.js v24 + SDK native binary 分发、PATH 注入
- [Sidecar 冷启动性能](./tech_docs/sidecar_cold_start.md) — listen 时序、Tier 2 懒加载、Tab fast-path
- [Pit-of-Success 模块完整规范](./tech_docs/pit_of_success.md) — Rust + Node 全部 helper
- [自动更新系统](./tech_docs/auto_update.md) — Chrome/VSCode 风格静默更新机制

### 通信与会话
- [Session 架构](./tech_docs/session_architecture.md) — ID 格式、JSONL 存储、SDK 双重存储、状态同步
- [代理配置](./tech_docs/proxy_config.md) — 系统代理 + SOCKS5 桥接
- [统一日志](./tech_docs/unified_logging.md) — 日志格式、来源、排查指南
- [三方供应商](./tech_docs/third_party_providers.md) — 环境变量、认证模式、Bridge 原理

### Multi-Agent Runtime / Agent / IM
- [Multi-Agent Runtime](./tech_docs/multi_agent_runtime.md) — CC / Codex / Gemini 协议、会话管理、门控链路
- [Tool Attachment 管道](./tech_docs/tool_attachment_pipeline.md) — 任意 runtime 产图归一化、落盘 helper、SSRF 防护、placeholder 异步落盘
- [IM 集成技术架构](./tech_docs/im_integration_architecture.md) — Agent / Channel 详细设计、适配器模型
- [Plugin Bridge 架构](./tech_docs/plugin_bridge_architecture.md) — OpenClaw 插件加载、SDK shim、CJS/ESM 混用插件 runtime 补丁

### 任务中心 / 搜索
- [任务中心架构](./tech_docs/task_center.md) — 数据模型、状态机、CronTask 反向指针、CLI
- [全文搜索架构](./tech_docs/search_architecture.md) — Tantivy + jieba、session watcher、UTF-16 高亮

### SDK 集成
- [`canUseTool` 回调指南](./tech_docs/sdk_canUseTool_guide.md) — 人工干预工具权限的实现要点
- [自定义 Tools 指南](./tech_docs/sdk_custom_tools_guide.md) — `createSdkMcpServer` + `tool` 用法、当前 SDK 工具清单

### 平台与构建
- [Windows 编码约束](./tech_docs/windows_platform.md) — 路径前缀 / 进程 / 环境变量 / CSP（写代码时查）
- [Linux 构建与分发](./guides/linux_build_guide.md) — AppImage / deb / 支持矩阵
- [构建问题排查](./guides/build_troubleshooting.md) — Windows 构建 / CSP / Resources 缓存 / 代理

### 前端
- [设计系统](./DESIGN.md) — Token / 组件 / 页面规范
- [React 稳定性规范](./tech_docs/react_stability_rules.md) — Context / useEffect / memo 5 条规则

### CLI
- [CLI 架构](./tech_docs/cli_architecture.md) — 自配置 CLI 设计、版本门控、Admin API、PATH 注入
