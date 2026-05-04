# Task Provider Routing — 三层架构

> 状态：v0.2.9 落地  
> 关联：PRD 0.2.9（issue #130 + 配套架构整顿），PRD #119（CronTask provider intent）

## 1. 产品语义

```
Agent 工作区  =  配置模板（live, 可修改）
                providerId, model, runtime, permission, MCP

Tab Session  =  快照（frozen on create）
                创建 Tab 时拍 Agent 当前状态；后续改 Agent 不影响这个 Tab

Task 执行    =  每次 tick 派生 session（live re-derive）
                default：用 Agent 当前状态
                override：task 自己的字段（providerId / model / ...）
```

**关键差异**：Tab Session 是 frozen-on-create，Task 是 live-on-tick。这两种"快照"语义共存，分别匹配两种用户心智。

## 2. 三层职责

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1：持久层 (tasks.jsonl + cron_tasks.json)              │
│   只存 providerId（intent），不存 credential                 │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2：调度层 (Rust ensure_cron_for_task / payload 透传)   │
│   只做"透传 + schema validation"，不解析 provider 配置       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 3：执行层 (TS sidecar /cron/execute(-sync))           │
│   每次 tick 调 resolveProviderEnv(providerId)               │
│   从 ~/.myagents/config.json (live) 拿 apiKey/aliases       │
│   provider 不存在或缺 credential → 拒绝 + 标 Blocked        │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据形态对照

| 字段 | Task (`tasks.jsonl`) | CronTask (`cron_tasks.json`) | 备注 |
|------|----------------------|------------------------------|------|
| `providerId` | ✅ 新写入路径 | ✅ 新写入路径 | PRD 0.2.9 — 唯一持久化的 provider intent |
| `model` | ✅ | ✅ | `providerId` 设置时 MUST 配对 |
| `provider_env` | ❌ 不存 | 🟡 read-only deprecated（`#[serde(default, skip_serializing)]`：load 老数据，但永远不再写盘） | apiKey / baseUrl / authType / modelAliases — 一旦下次 save_to_disk 就消失 |
| `provider_intent` | ❌ 不存 | 🟡 仍写入，但语义降级 | 当 `providerId == None` 时仍输出 `FollowAgent` / `Subscription` / `Explicit`（兼容老 cron 路径）；当 `providerId` 存在时 sidecar 忽略 intent，按 provider.type 在线决定 |

## 4. Sidecar 解析（核心）

`/cron/execute(-sync)` 收到 payload 时按以下优先级解析：

```ts
if (payload.providerId) {
  // ✅ PRD 0.2.9 主路径 — 每 tick live resolve
  effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);
  // → ResolvedProviderEnv | 'subscription' sentinel
  // → 失败抛错 → 400 → Rust 标 Task Blocked
}
else if (intent === 'followAgent') {
  // 🟡 旧路径：从 session metadata snapshot 解析
}
else if (intent === 'subscription') {
  // 🟡 旧路径：直接清空（PRD 0.2.9 R1：必须传 'subscription' sentinel）
  effectiveProviderEnv = 'subscription';
}
else if (intent === 'explicit') {
  // 🟡 旧路径：用 payload.providerEnv（已 frozen 的）
  effectiveProviderEnv = payload.providerEnv;
}
```

`resolveCronProviderRouting(providerId)`：
- provider 不存在 → 抛错（"provider 已删除"）
- `provider.type === 'subscription'` → 返回 `'subscription'` sentinel
- api-type 但缺 apiKey → 抛错（"缺少 API Key"）
- api-type 有 apiKey → 调用 `resolveProviderEnv()` 返回完整 env（含 authType / modelAliases）

## 5. `'subscription'` Sentinel

`enqueueUserMessage` 的第五参数语义（agent-session.ts:5375-5383）：

| 值 | 语义 |
|----|------|
| `undefined` | "保持当前 provider"（pit-of-success 默认） |
| `'subscription'` | "切回订阅"（清空 currentProviderEnv） |
| `ProviderEnv` 对象 | "用这个 specific provider" |

**PRD 0.2.9 R1 修复**：cron handler 之前的 subscription 分支传 `undefined`，结果"保持上一次 provider"。修复后传字面 `'subscription'`，行为正确。

**给 sidecar 调用方的硬规则**：要切回订阅 MUST 传 `'subscription'` 字符串字面量。

## 6. Schema Validation (Rust 强制)

`validate_task_provider_routing` 在 Task 持久层守门：

| 不变式 | 拒绝条件 |
|--------|----------|
| 配对 | `providerId.is_some() && model.is_none()` |
| 跨-runtime 互斥 | `runtime ∈ {claude-code, codex, gemini} && providerId.is_some()` |

应用点：`create_direct` / `create_from_alignment` / `update`（用合并后的状态校验）/ `create_migrated`。

## 7. UI 入口（TaskAdvancedConfigEditor）

**Builtin runtime 分支**：
- `useAvailableProviders()` 拿所有有 credential 的 provider
- Grouped popup：`provider.name → provider.models[]`
- 选择 model 时配对写 `(providerId, model)`
- "跟随 Agent" 选项 → 设置 `clearProviderOverride: true` flag（原子清空）

**External runtime 分支**：
- `runtimeModels`（CC_MODELS / codexModels / geminiModels）
- 写入 `runtimeConfig.model`（不写 `model` 字段）

**切 runtime 时**：renderer 自动清不兼容字段（builtin → external 清 providerId+model；反之清 runtimeConfig.model）

**Stale provider UX**：picker 区分两种失效状态：
- providerId 仍在 config 但缺 apiKey → 闭按钮显示 ⚠ 角标，picker 内额外卡片提示去配置 key
- providerId 已从 config 删除 → picker 内警告"provider 已删除，请重选"

## 8. 用户视角的行为表

| 场景 | 0.2.9 行为 |
|------|-----------|
| 编辑 task 选 OpenAI / GPT-4o，保存 | `tasks.jsonl` 有 `"providerId":"openai-..."`，无 apiKey |
| 设置里改 OpenAI 的 apiKey | 下一次 task tick 立即用新 key（不需要 re-save task） |
| 设置里删 OpenAI provider | 下一次 task tick 失败 → Task 标 Blocked，error 提示用户重选 |
| 切 task runtime 到 codex | UI 自动清 providerId+model；切回 builtin 自动清 runtimeConfig.model |
| 给 task 选了 provider 但没选 model | Rust 拒绝保存（pairing rule） |
| 老 task（0.2.8 之前的，无 providerId）| FollowAgent 路径，行为不变 |
| 老 cron 仍带 frozen provider_env | 反序列化兼容；启动日志计数；Explicit intent 路径继续 work；用户编辑 task 一次自动迁移 |

## 9. 与 PRD #119 的关系

PRD #119 在 CronTask 层引入 `ProviderIntent { FollowAgent, Subscription, Explicit }`。

PRD 0.2.9 在此之上：
1. 把 intent 从"用户面持久化字段"降级为"sidecar 内部派生量"。用户只选 providerId；当 providerId 存在时 sidecar 完全忽略 intent，自己按 provider.type 现场判定 subscription/explicit。
2. 把 `provider_env`（frozen）从"双向持久化"改为"只读 legacy"：`#[serde(default, skip_serializing)]` —— 仍能反序列化老数据让 in-memory CronTask 跑，但下一次 `save_to_disk` 就永远消失。
3. 把解析逻辑从 ensure 时（schedule）移到 tick 时（execute）。

**老 cron 兼容的精确边界**：当 cron 没有 `providerId`（pre-0.2.9 数据），sidecar 仍然按 #119 的 intent 分支走（`FollowAgent` / `Subscription` / `Explicit`），其中 `Explicit` 还会读 in-memory 的 legacy `provider_env`。但只要用户编辑这条 cron 一次，`save_to_disk` 触发，legacy `provider_env` 就从磁盘上消失，下一次启动就只剩 `provider_intent` 字段。最终态是用户在 UI 里重新挑一次 provider，老 cron 也迁移到 providerId-only。

## 10. Pit-of-Success 红线

| 禁止 | 后果 | 正确做法 |
|------|------|---------|
| 在 Task 持久层存 apiKey / baseUrl 等 credential | 安全 + 维护成本（rotation 不生效） | 只存 providerId，sidecar live resolve |
| 在 sidecar /cron/execute 的 subscription 分支传 `undefined` 给 enqueueUserMessage | 实际"保持当前 provider"，跨 provider 切换静默错路由 | 传字面 `'subscription'` |
| 让 task 同时持有 builtin `providerId` 和 `runtime ∈ external` | sidecar 把 model 误传给 codex CLI 等 | Rust validator 拒绝；UI 切 runtime 时自动清 |
| 写 `providerId` 不写 `model`（或反之） | 半残状态 → 跨 provider 静默错路由 | UI 配对写；Rust validator 拒绝 |
| 在 Rust 重写 resolveProviderEnv | 与 TS sidecar 的版本 drift（authType / modelAliases / fallback aliases） | 单一权威源在 sidecar；Rust 只透传 providerId |

## 11. 排查指南

- **task 用错了 provider**：grep unified log `[cron] execute providerId=X resolved=Y` — 确认 sidecar 解析的就是 X
- **subscription 切换没生效**：grep `[cron] execute-sync intent=subscription` 或 `providerId=... resolved=subscription` — 确认走了 'subscription' sentinel 路径
- **provider 删除后老 cron 还跑**：grep `[CronTask] N legacy task(s) still carry frozen provider_env` —— 编辑该 task 一次即可迁移
- **rotation 未生效**：检查 task 是否仍带 `providerEnv`（旧路径），无则下一 tick 必用新 key

## 12. 相关文件

- `src-tauri/src/task.rs` — Task 持久层 + validation
- `src-tauri/src/cron_task.rs` — CronTask 持久层 + execute_task_directly
- `src-tauri/src/management_api.rs` — ensure_cron_for_task / /api/cron/create
- `src-tauri/src/sidecar.rs` — CronExecutePayload struct
- `src/server/index.ts` — /cron/execute(-sync) handlers + resolveCronProviderRouting helper
- `src/server/utils/admin-config.ts` — resolveProviderEnv（sidecar 唯一 resolver）
- `src/server/agent-session.ts` — enqueueUserMessage 'subscription' sentinel 语义
- `src/renderer/components/task-center/editors/TaskAdvancedConfigEditor.tsx` — UI grouped picker
- `src/server/tools/im-cron-tool.ts` — IM cron tool（已收敛 providerId-only）
- `src/renderer/pages/Launcher.tsx` / `src/renderer/pages/Chat.tsx` — 收敛 cron 创建路径
