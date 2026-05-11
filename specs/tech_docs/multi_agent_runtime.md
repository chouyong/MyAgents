# Multi-Agent Runtime 架构

## 概述

Multi-Agent Runtime 允许用户选择不同的 AI Runtime 驱动 Agent 会话。除内置 Claude Agent SDK（builtin）外，支持 Claude Code CLI、OpenAI Codex CLI、Google Gemini CLI 作为外部 Runtime。

**功能门控**：设置 → 关于 → 实验室 → 「更多 Agent Runtime」开关（`config.multiAgentRuntime`），默认关闭。

## 架构总览

```
┌────────────────────────────────────────────────────────────────────┐
│                          Node.js Sidecar                               │
│                                                                    │
│   index.ts ─────── shouldUseExternalRuntime()                      │
│       │                    │                                       │
│       ▼                    ▼                                       │
│   agent-session.ts    external-session.ts                          │
│   (builtin SDK)       (CC / Codex / Gemini adapter)                │
│       │                    │                                       │
│       ▼                    ▼                                       │
│  Claude Agent SDK   ┌──────────┐  ┌─────────┐  ┌──────────┐       │
│  (内置,直接调用)     │claude-   │  │codex.ts │  │gemini.ts │       │
│                     │code.ts   │  │         │  │          │       │
│                     │NDJSON    │  │JSON-RPC │  │JSON-RPC  │       │
│                     │/stdio    │  │ 2.0     │  │2.0 (ACP) │       │
│                     └────┬─────┘  └────┬────┘  └────┬─────┘       │
│                          │             │            │             │
│                          ▼             ▼            ▼             │
│                     claude CLI     codex CLI    gemini CLI         │
│                     (-p mode)     (app-server)  (--acp mode)       │
└────────────────────────────────────────────────────────────────────┘
```

## 核心抽象

### AgentRuntime 接口 (`src/server/runtimes/types.ts`)

所有外部 Runtime 实现此接口：

```typescript
interface AgentRuntime {
  type: RuntimeType;  // 'claude-code' | 'codex' | 'gemini'
  detect(): Promise<RuntimeDetection>;       // 检测 CLI 是否安装
  queryModels(): Promise<RuntimeModelInfo[]>; // 查询可用模型
  getPermissionModes(): RuntimePermissionMode[];
  startSession(options, onEvent): Promise<RuntimeProcess>;
  sendMessage(process, message, images?): Promise<void>;
  respondPermission(process, requestId, approved, reason?): Promise<void>;
  stopSession(process): Promise<void>;
}
```

### UnifiedEvent 统一事件

Runtime 内部协议差异通过 `UnifiedEvent` 联合类型统一，`external-session.ts` 消费同一套事件：

| 类别 | 事件 | 说明 |
|------|------|------|
| 文本 | `text_delta`, `text_stop` | AI 回复流式文本 |
| 思考 | `thinking_start/delta/stop` | 推理过程 |
| 工具 | `tool_use_start`, `tool_input_delta`, `tool_use_stop`, `tool_result` | 工具调用全生命周期 |
| 权限 | `permission_request` | 委托 MyAgents UI 审批 |
| 生命周期 | `session_init`, `turn_complete`, `session_complete` | 会话状态 |
| 元数据 | `usage`, `log` | Token 用量、日志 |

### RuntimeType (`src/shared/types/runtime.ts`)

```typescript
type RuntimeType = 'builtin' | 'claude-code' | 'codex' | 'gemini';
```

## Claude Code Runtime (`src/server/runtimes/claude-code.ts`)

### 协议：NDJSON over stdio

CC 以 `-p` (prompt) 模式运行，每轮对话一次进程生命周期：

```bash
claude -p \
  --output-format stream-json --input-format stream-json \
  --verbose --include-partial-messages --bare \
  --append-system-prompt "..." \
  --permission-mode acceptEdits \
  --permission-prompt-tool stdio \
  --model sonnet \
  --resume <runtimeSessionId>
```

**stdin (发送消息)**：
```json
{"type":"user","message":{"role":"user","content":"hello"}}
```

**stdout (接收事件)**：NDJSON 行流，包含 `stream_event`（文本/工具 delta）、`system`（session_init）、`result`（turn 结果）、`control_request`（权限请求）。

### 多轮续接

CC `-p` 模式每轮退出。续接通过 `--resume <sessionId>` 恢复上下文：

```
Turn 1: claude -p --session-id abc → 执行 → 退出
Turn 2: claude -p --resume abc     → 恢复上下文 → 执行 → 退出
```

### 权限模式映射

| MyAgents | CC CLI |
|----------|--------|
| `auto` | `acceptEdits` |
| `plan` | `plan` |
| `fullAgency` | `bypassPermissions` |

### SessionStart Hook

生成临时 hook 配置文件，注入 forwarder 脚本。CC 启动后通过 hook POST `session_id` 到 Sidecar HTTP 端点 `/hook/session-start`，确保 session ID 可靠追踪。

## Codex Runtime (`src/server/runtimes/codex.ts`)

### 协议：JSON-RPC 2.0 over stdio

Codex 以 `app-server` 模式运行，进程在整个 session 生命周期内持久存活：

```
Client → Server (Request):   {"jsonrpc":"2.0","id":1,"method":"thread/start","params":{...}}
Server → Client (Response):  {"jsonrpc":"2.0","id":1,"result":{...}}
Server → Client (Notification): {"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{...}}
```

### Thread 模型

| RPC 方法 | 用途 |
|---------|------|
| `initialize` | 握手，交换 capability |
| `thread/start` | 创建新 thread |
| `thread/resume` | 恢复已有 thread |
| `turn/start` | 发送用户消息到 thread |
| `turn/interrupt` | 中断当前 turn |

### `thread/start` 参数 Schema（Codex v0.111.0）

| 参数 | 类型 | MyAgents 对接 | 说明 |
|------|------|-------------|------|
| `cwd` | string? | ✅ `workspacePath` | 工作目录 |
| `model` | string? | ✅ 用户选择的模型 | 模型覆盖（null=Codex 默认） |
| `approvalPolicy` | enum? | ✅ mapped from permissionMode | `untrusted`/`on-failure`/`on-request`/`never` |
| `sandbox` | enum? | ✅ mapped from permissionMode | `read-only`/`workspace-write`/`danger-full-access` |
| `developerInstructions` | string? | ✅ `systemPromptAppend` | MyAgents 三层系统提示词 |
| `ephemeral` | boolean? | ✅ `false` | 是否临时线程 |
| `modelProvider` | string? | ❌ 未对接 | 模型供应商覆盖 |
| `serviceTier` | enum? | ❌ 未对接 | `fast`/`flex` |
| `personality` | enum? | ❌ 未对接 | `none`/`friendly`/`pragmatic` |
| `baseInstructions` | string? | ❌ 未对接 | 基础系统指令（区别于 developerInstructions） |
| `config` | object? | ❌ 未对接 | 通用配置对象（additionalProperties） |
| `serviceName` | string? | ❌ 未对接 | 服务名称标识 |

### `thread/resume` 参数 Schema

| 参数 | 类型 | MyAgents 对接 | 说明 |
|------|------|-------------|------|
| `threadId` | **string (必填)** | ✅ `resumeSessionId` | 要恢复的线程 ID |
| `model` | string? | ✅ | 模型覆盖 |
| `approvalPolicy` | enum? | ✅ | 权限策略覆盖 |
| `sandbox` | enum? | ✅ | 沙箱覆盖 |
| `developerInstructions` | string? | ✅ | 系统提示词覆盖 |
| `cwd` | string? | ❌ 未对接 | 工作目录覆盖 |
| `modelProvider` | string? | ❌ 未对接 | 模型供应商覆盖 |
| `serviceTier` | enum? | ❌ 未对接 | |
| `personality` | enum? | ❌ 未对接 | |
| `baseInstructions` | string? | ❌ 未对接 | |

**注意**：Codex 不支持通过 `thread/start`/`thread/resume` 注入 MCP Server 配置。Codex 的 MCP 由其自身管理（`~/.codex/` 配置），MyAgents 无法控制。

### 事件映射

| Codex Notification | UnifiedEvent |
|-------------------|-------------|
| `item/agentMessage/delta` | `text_delta` |
| `item/reasoning/summaryTextDelta` | `thinking_delta` |
| `item/plan/delta` | `thinking_delta`（v0.2.15+ 真显示，之前 `plan` item silent drop） |
| `item/started` (tool types) | `tool_use_start` |
| `item/completed` (tool types) | `[tool_use_stop, tool_result]` |
| `turn/completed` | `turn_complete` |
| `thread/tokenUsage/updated` | `usage` |

### ThreadItem 类型对照（v0.128 schema）

`codex app-server generate-ts --out <dir>` 可以生成当前装机版本的真实 TS schema
（不要凭假设，schema 随 Codex 版本飘）。v0.128 schema 见 `/tmp/codex-schema/v2/ThreadItem.ts`，
本 runtime 对接的字段映射：

| Codex item.type | tool_use_start 工具名 | tool_result 内容 / attachments |
|---|---|---|
| `commandExecution` | `Bash` | `aggregatedOutput` + `exitCode` / `durationMs` / `cwd` / `source`；input 带 `commandActions[]`（已 parse 的 read/listFiles/search） |
| `fileChange` | `Edit` | 路径 + diff；`status` (PatchApplyStatus) declined/failed 显式标 isError |
| `mcpToolCall` | `mcp__<server>__<tool>` | `result.content[]` 走 MCP ContentBlock union — `text` join 进 content，`image` / `audio` 生成 ToolAttachment；`mcpAppResourceUri` 透出 |
| `dynamicToolCall` | `<tool>` | `contentItems[]`：`inputText` 进 content，`inputImage{imageUrl}` 生成 ToolAttachment；`namespace` / `durationMs` 透出 |
| `webSearch` | `WebSearch` | `action` union 全分支（search/openPage/findInPage/other） |
| `imageView` | `Read` | `path` |
| `imageGeneration` | `ImageGeneration` | **生图核心**：优先 `savedPath`（零拷贝引用 Codex 自动保存），fallback `result` (base64) 解码落盘 → ToolAttachment[]；content 留 `revisedPrompt` 文字 |
| `collabAgentToolCall` | `CollabAgent` | tool / prompt / model / senderThreadId / receiverThreadIds 摘要 |
| `plan` | — (started 走 thinking_start) | text 通过 `item/plan/delta` 流式 |
| `reasoning` | — (started 走 thinking_start) | summary 通过 `summaryTextDelta` 流式 |
| `enteredReviewMode` / `exitedReviewMode` | — (log level event) | review-mode 进入/退出提示 |
| `hookPrompt` | — (log level event) | hook 注入的提示 fragment |
| `contextCompaction` / `agentMessage` / `userMessage` | — | 通过 turn/agentMessage 路径处理 |

未列出的 item type 会在 `console.warn` 中打印 unhandled，方便 Codex 升级后定位漏接。

### 富媒体产物（ToolAttachment）

Codex 的 `imageGeneration` / `mcpToolCall` 含 image content / `dynamicToolCall` 含 inputImage 三条
路径都走统一 `saveToolAttachment(...)` → `tool_result.attachments[]`。前端用单一
`ToolAttachmentGallery` 渲染。完整管道（异步落盘 placeholder、5 层路径校验、SSRF 防护、session
resume 重 register）详见 [Tool Attachment 管道](./tool_attachment_pipeline.md)。

### 权限模式映射

| MyAgents | Codex approvalPolicy | sandbox |
|----------|---------------------|---------|
| `suggest` | `untrusted` | `read-only` |
| `auto-edit` | `on-request` | `workspace-write` |
| `full-auto` | `never` | `workspace-write` |
| `no-restrictions` | `never` | `danger-full-access` |

## Gemini Runtime (`src/server/runtimes/gemini.ts`)

### 协议:Agent Client Protocol (ACP) over stdio

Gemini CLI 通过 `gemini --acp` 原生实现了 Zed 的 Agent Client Protocol(ACP)— 同样是
JSON-RPC 2.0 持久进程,与 Codex `app-server` 形态同构。MyAgents 作为 ACP Client,
Gemini CLI 作为 ACP Agent。协议规范见 https://agentclientprotocol.com/protocol/schema。

### Agent 方法(Client → Agent)

| RPC 方法 | 用途 |
|---------|------|
| `initialize` | 握手 + 协商 protocolVersion(当前 1)+ 读取 agentCapabilities |
| `session/new` | 开新会话,参数含 `cwd` + `mcpServers[]`,返回 `sessionId` + 可用 `modes` + 可用 `models` |
| `session/load` | 恢复历史会话 |
| `session/prompt` | 发消息,返回 `{stopReason, _meta:{quota:{token_count,model_usage[]}}}` |
| `session/cancel` | 中断当前 turn(notification,不等 response) |
| `session/set_mode` | 切换审批模式(`default` / `autoEdit` / `yolo` / `plan`) |
| `session/set_model` | 会话中切换模型(ACP 稳定版本,不是 `unstable_*`) |

### 服务端通知(Agent → Client)

通过 `session/update` notification 的 discriminated union:

| `sessionUpdate` | 派生的 UnifiedEvent |
|----------------|-------------------|
| `agent_message_chunk` | `text_delta` |
| `agent_thought_chunk` | `thinking_start`(首次) + `thinking_delta` |
| `tool_call` | `tool_use_start`(ACP 在 `autoEdit`/`yolo` 模式先发这个) |
| `tool_call_update { status: completed/failed }` | `tool_use_stop` + `tool_result`(late-bind `tool_use_start` if missing) |
| `plan` | `raw`(本期透传,UI 后续升级) |
| `available_commands_update` | 忽略(IDE 命令菜单) |
| `user_message_chunk` | 忽略(session/load 回放) |

### 服务端请求(Agent → Client,需应答)

| RPC 方法 | 处理 |
|---------|------|
| `session/request_permission` | 派生 `permission_request` UnifiedEvent(同时若未发 `tool_use_start` 则 late-bind)。MyAgents 返回 `{outcome:{outcome:'selected',optionId:...}}`;选项 `optionId` 基于 ACP 回传的 `options[].kind`(`allow_once` / `allow_always` / `reject_once`)健壮匹配。`default` 模式下 Gemini 跳过 `tool_call` notification 直接发 permission request,runtime 在此路径补发 `tool_use_start`,保证前端显示一致 |
| `fs/*` / `terminal/*` | **不声明**对应 capability,Gemini 使用自己的内置工具。如仍收到 → `respondError(-32601)` |

### 系统提示词注入:`GEMINI_SYSTEM_MD` + tmp 文件合并

Gemini CLI ACP 协议本身没有 `session/new` 层面的 system instruction 参数。我们采用
Gemini 官方支持的 `GEMINI_SYSTEM_MD` 环境变量(见
https://geminicli.com/docs/cli/system-prompt/):它指向一个 markdown 文件,
内容**整体替换**Gemini 内置系统提示。

**不能简单 replace** — 这样会丢失 Gemini 的工具调用约定、安全规则、tone guidelines。
解决方案:**合并注入**。

1. **基底提取(一次性,按版本缓存)**:`extractGeminiBasePrompt(version)` 启动一个
   `gemini -p "."` 子进程,通过 `GEMINI_WRITE_SYSTEM_MD=<cachePath>` 环境变量让 Gemini
   把内置 prompt 导出到文件。Gemini 写文件发生在启动阶段、API 调用之前,runtime 轮询
   文件出现即 `kill(9)` 子进程 — **不产生 token 消耗**。
   缓存路径:`~/.myagents/tmp/gemini-prompts/base-<version>.md`,v0.37.2 约 25KB。

2. **per-session 合并**:`writeSessionSystemPrompt(sessionId, myAgentsPrompt, version)` 把
   MyAgents 的三层 prompt(base-identity + channel + scenario)前置,基底附在
   `---` 分隔符后并包上 "以 MyAgents 指令为优先" 的说明。写入:
   `~/.myagents/tmp/gemini-prompts/session-<sessionId>.md`。

3. **注入**:`spawn(['gemini', '--acp'], { env: { GEMINI_SYSTEM_MD: promptFile } })` —
   环境变量在 spawn 时即生效。

4. **生命周期**:session 结束(`proc.exited` / `stopSession`)时删除该 session 的 prompt
   文件;启动时扫描并清理超过 1 小时的残留(`cleanupStaleSessionPrompts()`),base 缓存
   文件(`base-*.md`)保留以供下次复用。

### 模式 ID 映射(D5/D6)

| MyAgents 内部值 | Gemini ACP modeId |
|----------------|-------------------|
| `default`       | `default`  |
| `autoEdit`      | `autoEdit` |
| `yolo`          | `yolo`     |
| `plan`          | `plan`     |
| 兼容:`auto`    | `autoEdit` |
| 兼容:`fullAgency` | `yolo`   |

- 桌面场景默认:`autoEdit`(通过 `getDefaultRuntimePermissionMode('gemini')` 返回)
- Cron / IM / agent-channel 场景默认:`yolo`(在 `startSession` 内 `pickDefaultMode` 覆盖)

启动时如果期望的 mode ≠ `default`,runtime 在 `session/new` 后立即调用 `session/set_mode`
应用;失败时非致命,仅打印 warning。

### 模型列表动态发现

不硬编码 `GEMINI_MODELS`(常量里只保留一个"默认"占位)。`queryModelsViaAcp()` 策略:

1. Spawn 短命 `gemini --acp`(cwd = `$HOME`,避免被当前 workspace 配置干扰)
2. `initialize` 握手 + `session/new`
3. 从 `result.models.availableModels[]` 读取 `{ modelId, name, description, isDefault }`
4. 在首位追加一个空值 `default` 条目(交给 Gemini 自选)
5. Kill 子进程

v0.37.2 实测返回 8 个模型:`auto-gemini-3`、`auto-gemini-2.5`、`gemini-3.1-pro-preview`、
`gemini-3-flash-preview`、`gemini-3.1-flash-lite-preview`、`gemini-2.5-pro`、
`gemini-2.5-flash`、`gemini-2.5-flash-lite`。TTL 缓存 5 分钟,同 Codex 做法。

**启动稳定性**:`queryModels` 调用前 `await new Promise(r => setTimeout(r, 50))` 让
stdout reader 先进入 `await read()`,防止 initialize 响应在 handler 注册之前到达的
竞态;超时由 10s 上调到 30s,覆盖 Gemini Node.js 冷启动 + OAuth 刷新的延迟。

### 认证

**完全不由 MyAgents 管理**。Gemini CLI 支持 OAuth、`GEMINI_API_KEY`、Vertex AI 三种方式,
用户自行在本机完成登录(`gemini` 交互式向导或 shell rc 导出环境变量),MyAgents 子进程
继承 Sidecar 的环境变量即可。如果用户未登录,`session/new` 会抛 `-32000` RPC 错误,
前端显示"请先在终端运行 `gemini` 完成登录"。

## External Session Handler (`src/server/runtimes/external-session.ts`)

统一管理三种外部 Runtime 的会话生命周期,是 `agent-session.ts` 的精简对应物。

### 三路消息发送

```typescript
sendExternalMessage(text, images?, permissionMode?, model?, context?)
```

| Case | 条件 | 行为 |
|------|------|------|
| 1 | 无 runtimeSessionId + 不在运行 | 全新 session |
| 2 | 进程已退出（CC -p 模式） | `--resume` 恢复 |
| 3 | 进程存活（Codex 持久模式） | `sendMessage()` 到 stdin |

### 内容块持久化

流式事件在 `handleUnifiedEvent()` 中被实时广播到前端（SSE），同时累积到 `PersistContentBlock[]`：

```typescript
interface PersistContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  tool?: { id, name, input, inputJson, result, isError, streamIndex };
  thinking?: string;
}
```

`turn_complete` 时序列化为 `JSON.stringify(ContentBlock[])` 写入 SessionStore——与 builtin runtime 格式一致，前端 `TabProvider.tsx` 的 JSON 解析路径直接复用。

### 配置变更

**Permission Mode**:`setExternalPermissionMode()` 停止当前进程 → 下次 `sendExternalMessage` 以新模式 resume。

**Model**:`setExternalModel()` 优先尝试 in-place 切换(`activeRuntime.setModel()`),失败或不支持再 fallback 到停进程 resume 路径:

| Runtime | 切换方式 |
|---------|---------|
| Gemini | ACP `session/set_model` RPC,保留活进程 + session 状态,无需 re-handshake |
| Codex | 无等价 RPC → fallback 到停进程 resume |
| Claude Code | `-p` 模式每轮都重启,无意义 → fallback 到停进程 resume |

### 预热 Pre-warm

Gemini / Codex 冷启动(spawn CLI + `initialize` + `session/new`)约 10–15 秒,用户在此期间打字无反馈。`prewarmExternalSession()` 把这段时间挪到 Tab 打开的瞬间:

**适用范围**:仅 Gemini / Codex(持久 JSON-RPC 进程)。CC `-p` 模式每轮退出,预热无意义 → HTTP 端点在到达此路径之前就拒绝。

**触发链路**:前端 `Chat.tsx` 在 Tab ready(`isActive && isConnected && sessionId`)的瞬间 POST `/api/runtime/prewarm` → `prewarmExternalSession()` → `startExternalSession({ ...options, initialMessage: undefined })`。**不**等待 `/api/runtime/models` — 该接口自身也 spawn 一个 `gemini --acp` 子进程查模型,会付同样的 ~14s 冷启动。两件事并行进行:prewarm 在用户打字时暖 session,models-fetch 在后台填充模型下拉。首次 prewarm 用 `effectiveModel`(可能 `undefined` → runtime 用自带默认),用户随后在 UI 里切模型时走 `setExternalModel()` → in-place `runtime.setModel()` 路径(见「配置变更」)。

**关键差异**(pre-warm vs 正常 start):

| 项 | pre-warm | 正常 start |
|----|----------|-----------|
| `initialMessage` | 省略 | 含用户消息 |
| Session state | 保持 `idle`(UI 不显示 spinner) | 切 `running` |
| 看门狗 | **不启动**(10 分钟进程空等是合法的) | 启动 |
| Session metadata 落盘 | 推迟 | 创建时写入 |
| 失败处理 | **静默**(log-only,不 toast) | broadcast `chat:agent-error` |

**守卫**:
- **双层重复守卫**:`isExternalSessionActive() || isRunning || startingPromise` 任一成立即视为已暖,直接返回。
- **后端 cross-runtime 校验**:读 `getSessionMetadata(sessionId)?.runtime`,若与当前 Sidecar 的 runtime 不匹配则拒绝。前端 `Chat.tsx` 也有对应校验,但 `sessionRuntime` 状态异步注入,后端检查关掉 race-window 漏洞。
- **Resume ID 守卫**:`lastSessionId === options.sessionId && lastRuntimeSessionId` 同时成立才传 `resumeSessionId`,防止 Handover 场景 4 遗留的 runtime session id 误 resume 到新 session → "No conversation found" CLI 错误。

**首条消息路径**:
- 预热成功 → `sendExternalMessage` 命中 Case 3(进程活着),`registerSessionMetadataIfNew()` 在此处写 metadata + 启动看门狗。
- 预热失败 → 进程未起,`sendExternalMessage` 命中 Case 1 或 Case 2,走正常启动路径,metadata 在 `_doStartExternalSession` 的 `initialMessage` 分支写入。
- 两条路径通过 `registerSessionMetadataIfNew()` 幂等 helper 共享逻辑,防止漂移。

**Session Complete 特判**:`!turnCompleted && currentTurnStartTime === 0` 判为 pre-warm exit(进程 spawn 后、首轮 turn 开始前崩溃),静默吞掉错误 — 下一条用户消息会走正常启动路径重试。

### 并发与序列化

`sendExternalMessage` 在分派 Case 1/2/3 之前有两道 gate:

1. **Start 并发 gate**:`await startingPromise` 等待任何在飞的 `startExternalSession`(包括 pre-warm)完成。否则用户消息可能在 `isRunning=true && activeProcess=null` 的中间态被错分到 Case 2,触发 "session already running" 静默丢弃。
2. **Turn 序列化 gate**:`!turnCompleted && currentTurnStartTime !== 0 && activeProcess` → `waitForExternalSessionIdle(5 分钟, 100ms)`。持久进程运行时(Codex/Gemini)一次只接一个 turn,并发写入 stdin 会出现 drop 或交错输出。崩溃恢复路径通过 `resetTurnAccumulators()` 把 `currentTurnStartTime` 归零,此 gate 不会误触。

### 安全机制

| 机制 | 说明 |
|------|------|
| **并发守卫** | `startingPromise` 序列化并发 `startExternalSession` 调用 |
| **Turn 序列化** | 持久进程 runtime 下,新消息等待上一个 in-flight turn 结束再派送 |
| **看门狗** | **Per-turn**(不是 per-process):pre-warm idle 不计时,turn 启动才启动计时器。10 分钟无活动 → kill |
| **Stale text 防护** | `lastTurnSucceeded` 标志,cron/heartbeat 路径检查,防止崩溃后返回上一轮旧回复 |
| **用户消息即时落盘** | 发送后立即 `saveSessionMessages()`,崩溃不丢用户消息 |
| **Token 用量** | 存储 Codex `usage` 事件(running total,replace 而非 accumulate),附加到 assistant message |
| **Cross-runtime 守卫** | pre-warm / restore / send 路径均用 `SessionMetadata.runtime` 校验,阻止跨 runtime 污染 |

## 功能门控链路

```
config.multiAgentRuntime (磁盘/React state)
  │
  ├── Rust sidecar.rs: resolve_agent_runtime_from_config()
  │     → 仅当 multiAgentRuntime=true 时读取 agent.runtime
  │     → 设置 MYAGENTS_RUNTIME 环境变量注入 Sidecar
  │
  ├── Node factory.ts: getCurrentRuntimeType()
  │     → 读取 process.env.MYAGENTS_RUNTIME
  │     → 未设置 → 'builtin'
  │     → 识别 'claude-code' | 'codex' | 'gemini'
  │
  └── React Chat.tsx:
        const currentRuntime = multiAgentRuntimeEnabled
          ? (currentAgent?.runtime || 'builtin')
          : 'builtin';  // ← 源头门控，下游自动安全
```

## 跨 Runtime Session 保护

当用户关闭功能后打开外部 Runtime 创建的历史 session：

1. **服务端** (`agent-session.ts:initializeAgent`)：检测 `meta.runtime !== 'builtin'` → 设 `sessionRegistered=false` → 跳过 SDK resume（避免 "No conversation found" 崩溃）
2. **前端** (`Chat.tsx`)：检测 `isCrossRuntimeSession` → 发消息时弹 ConfirmDialog → 用户可选择新开会话或留在当前页浏览历史
3. **Fork/Rewind**：外部 Runtime session 不支持（前端隐藏按钮 + 服务端 400 守卫）

## 文件索引

| 文件 | 职责 |
|------|------|
| `src/server/runtimes/types.ts` | AgentRuntime 接口 + UnifiedEvent 类型 |
| `src/server/runtimes/factory.ts` | Runtime 工厂 + 检测 |
| `src/server/runtimes/claude-code.ts` | CC Runtime 实现(NDJSON 协议) |
| `src/server/runtimes/codex.ts` | Codex Runtime 实现(JSON-RPC 2.0) |
| `src/server/runtimes/gemini.ts` | Gemini Runtime 实现(ACP JSON-RPC 2.0 + `GEMINI_SYSTEM_MD` 合并注入) |
| `src/server/runtimes/external-session.ts` | 外部 Runtime 统一会话管理 |
| `src/server/runtimes/env-utils.ts` | 环境变量增强（PATH 补全） |
| `src/server/runtimes/tool-attachments.ts` | `saveToolAttachment` 落盘 helper + in-flight tracker + external-path registry（PRD 0.2.15） |
| `src/server/utils/path-safety.ts` | Node 镜像 Rust `validate_file_path` 黑名单 + canonicalize symlinks（PRD 0.2.15） |
| `src/shared/types/tool-attachment.ts` | `ToolAttachment` 共享类型（PRD 0.2.15） |
| `src/shared/types/runtime.ts` | 共享类型（RuntimeType、模型列表、权限模式） |
| `src/renderer/components/RuntimeSelector.tsx` | 前端 Runtime 选择器组件 |
| `src/server/runtimes/claude-code.ts` → `FORWARDER_SCRIPT` | CC SessionStart hook 转发脚本（运行时生成至 `~/.myagents/.cc-hooks/forwarder.cjs`） |
