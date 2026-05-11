# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.15] - 2026-05-12

> 长对话回溯、长任务执行、Codex 工具图片三条常见路径的可靠性收紧；外部 Runtime、Windows 下的几条阻塞性问题一并处理。

### Added

- **Codex Runtime 现在能渲染工具返回的图片**：让 Codex 用 OpenAI 官方 `image_generation` 工具画图、调返回图片的 MCP 工具、走 dynamic tool 拿回图片等场景，之前在 Chat 里完全不显示。现在与 builtin runtime 行为一致，附件随会话历史持久化，reload 后仍可看。顺带把 webSearch / fileChange / plan / review mode 等几个长期被静默丢弃的 Codex 事件类型补齐。

### Fixed

- **长对话里的时间回溯真的能回溯了**（#189）：40+ 条消息的对话里中断 AI 后再 Retry / 回溯时，过去回溯失败会把整个 session 重建——UI 顶部少几条但 AI 把之前的对话**全部忘光**。Fork 出来后立即回溯也是同样：UI 截断生效，AI 仍按完整 source 内容回复。两条路径都已修，回溯后 AI 看到的就是用户在 UI 上看到的。
- **长任务不再被记忆维护打断**（#190）：写作 / 研究 / 长工具调用进行中时，自动记忆维护会插一条指令把 AI 切走、半路回一句 "MEMORY_UPDATE_OK"。现在会话进行中时自动记忆维护会跳过，等空闲后再补做；手动触发不受影响。
- **外部 Runtime 长 turn 不再误报"AI 调用失败：网络错误"**（#188）：Codex / Gemini 跑 2 分钟以上的 turn 时桌面端会假性报错——AI 还在干活，只是前端等不到。
- **Windows 上 Claude Code CLI runtime 不再丢上下文**：之前 Windows 切到 Claude Code CLI runtime 后，每条消息都开新 session 导致多轮对话失忆。
- **元宝等 OpenClaw 插件升级后启动不再报缺接口**（#187）：插件升级后频繁出现 "does not provide an export named X"、bridge 启动超时——这次从生成器层做结构性修复，未来同类升级不再触发同样的失败。
- **点开 user-level skill / command 的文件不再误报"文件预览失败"**：在工作区里点开 `.claude/skills/<skill>/SKILL.md` 等通过 junction 链接到 `~/.myagents/skills` 的文件能正常预览。Windows 上尤其常见。
- **文件预览快速点击不再错位**：工作区面板里连点两个文件不再"看到的是先点的那个"，错误提示也不再双弹。
- **代码块行号不再被选中/复制**：跨多行框选代码时不再把左侧行号带上。

### Changed

- **想法输入框默认更高**：Task Center 的「想法」输入区默认高度由 2 行提升到 3 行，更适合写完整想法。

---

## [0.2.14] - 2026-05-11

> Session 当前由谁在驱动一目了然，对话能在桌面 ↔ 飞书/Telegram/微信之间无缝流转；顺手把通知系统、Plan 模式、IM 配置变更几条最痛的 papercut 都处理了。

### Added

- **顶栏会显示 session 当前绑定的 IM channel / 定时任务**：之前一个 session 是从飞书 channel 路由过来的，顶栏什么都没说，只能去历史抽屉里才能看出来。现在 session 标题后直接挂一个 `●飞书` / `●定时` 小标签，与历史抽屉风格一致。
- **新对话按钮在 channel-bound session 上会一起把绑定挪到新 session**：之前桌面端点 + 新对话只是清空桌面，飞书 channel 还停在老 session 上——等于"我以为换了对话，其实只换了一边"。现在等价于在 IM 里发 `/new`：channel 跟着到新 session，桌面顶栏的 `●飞书` 标签保持不动。
- **桌面 session 主动交接到 IM channel**：纯桌面 session 顶栏多了一个 `📤` 图标（与 channel 标签互斥，已绑定就消失）。点击弹窗列出当前工作区对应 Agent 的所有在线 channel，选中即把这条对话推过去——飞书/Telegram/钉钉 那边会收到一条「桌面端已将对话交接到此 channel」系统提示，IM 端用户接着聊就行；桌面端顶栏立即出现 channel 标签。继续在手机上工作的核心场景终于打通。
- **桌面 session 里的发言会镜像到绑定的 IM channel**：之前是单向的——IM 用户发什么桌面看得到，桌面发什么 IM 看不到，导致 IM 端用户视角丢一段对话。现在桌面用户消息以 `[From: 桌面端用户消息]` 前缀推到 IM，AI 回复正常推送（与直接对 bot 提问的流式格式一致）。镜像范围：用户文本 + 用户上传的 PNG/JPG + AI 文本回复块；不镜像工具调用、`canUseTool` 审批卡片、partial chunk（避免双端冲突 + 信息噪音）。
- **会话顶栏新增 ⋯ 菜单**：替代之前的条件式按钮，把 session 的 6 个常用操作（重命名 / 收藏 / 导出 md / 会话 Token 统计 / 上下文 Token 详情 / 绑定 Bot ▸ / 删除）聚合到一个稳定入口。"上下文 Token 详情" 直接以用户身份触发 `/context`，无需手动输入。
- **AI 出错后可一键重发**：错误 banner 上的「召唤小助理」换成「重新发送」按钮——直接回退并重新发送上一条用户消息，不需要重新打字。
- **Plan 模式可写修改意见**：AI 进入 plan 模式时，确认卡片下方多了一个文本框。留空提交是常规拒绝；填写反馈后提交则把意见送回 AI，AI 在同一回合内修订方案并重新出 plan，省去回到输入框重发的折腾。
- **OS 通知：跨平台体验完整化**：(a) 通知点击会唤起前台并切到对应 tab，三平台都生效——Windows 之前在企业环境下点了没反应的问题也修了；(b) 通知声音可在设置里关掉（默认开），三平台用各自的系统默认音；(c) 「启用通知」主开关现在真的生效——之前它是装饰性的，关掉之后通知照样响。升级后如果你之前在配置里把通知关了，会保留你的选择。
- **Agent 工作区 Runtime 变更时，IM bot 会自动迁到新会话**：之前在工作区把 Agent runtime 从 Claude Code CLI 切到 builtin（或反向）后，IM bot 还连在老 runtime 创建的 session 上——下次发消息要么没回应，要么报模型不存在。现在配置变更时会自动给 IM 推一条「Agent 工作区 Runtime 从「X」更新为「Y」，开始新会话（xxxxxxxx）」，新对话从干净的状态开始。老对话仍然完整保留在历史里，从桌面打开会按"它当时的 runtime + 配置"加载，跟其他历史会话表现一致。

### Fixed

- **AskUserQuestion / Plan 确认 / 权限请求弹窗不再 10 分钟后自动消失**：之前 AI 抛出选择题、计划确认或权限请求时，如果用户离开电脑超过 10 分钟回来，弹窗已经被静默清掉、AI 那边按"用户拒绝/未答"继续往下走——用户的体感是"刚才那个选择去哪了？"。Mac 睡眠唤醒时尤其明显，`setTimeout` 在唤醒瞬间就触发。修复后弹窗会一直停留直到用户回应（对齐 Claude Code CLI 行为）。
- **IM bot 绑定在 Agent 配置热更新时不再丢失**（issue #169 同类）：之前在工作区改 MCP / Skills 等设置触发 sidecar 重启时，bot ↔ chat 的绑定会被一并清掉，要么收到"Channel 没有最近活跃的对话"提示，要么得在 IM 里重新发条消息才把绑定建回来。现在绑定在 sidecar 重启时正确保留。
- **慢首次回合不再被错误标为 "AI 启动中"**：触发 `/context` 这类需要本地多轮内部计算的命令时（实测 40+ 秒），顶栏会一直停在 "AI 启动中（首次启动可能较慢）"，让人以为卡住了。现在用 SDK 自己的 ready 信号判断，启动期通常 3–5 秒就脱掉这个标签。
- **会话统计弹窗不再被工作区面板遮盖**：在右侧工作区打开的情况下点 ⋯ → 会话 Token 消耗统计，弹窗以前会被工作区面板覆盖。
- **Popover 外点击不再误关上层 ConfirmDialog**（issue #178）：之前在 Popover 内触发删除等需要二次确认的对话框，点确认按钮会被 Popover 当作"外部点击"误关，得用 Enter 才能确认。
- **元宝 Channel Plugin 2.13.x 能正常启动**（issue #180）：之前装上后 bridge 直接报 "Plugin did not register a channel"，无法进 IM 流。

### Internal

- 抽 `drainPendingInteractiveRequests` 统一 helper 处理四类 pending request 的 drain。
- Surface handover：`cmd_handover_session_to_channel` 重写 `peer_sessions[chat_key]` + 转移 `SidecarOwner::Agent` 所有权 + 通过 channel adapter 发送系统消息。镜像走新管理 API 端点 `/api/im/mirror`，Sidecar 在 desktop turn 的 user-message 持久化点 + AI text block-end 点 push。
- Runtime-change 编排：`cmd_update_agent_config` 检测 runtime 变更后调 `freeze_and_rotate_for_runtime_change`，对每个 peer_session 走"sidecar HTTP `/api/session/freeze` 优先 / 文件锁兜底"双写路径打 `OwnedSessionSnapshot`，再 mint 新 UUID 替换 `peer_sessions[*].session_id`。新增 `OwnedSessionSnapshot` 共享类型（TS Pick + Rust struct），sidecar 端点和 Rust 兜底走对称的 selective patch（只写存在字段 + 自带 `configSnapshotAt = now`）。
- Notification：Windows 走 `tauri-winrt-notification` 的 `on_activated` 闭包捕获 tab_id；macOS / Linux 走 `Empty / Single / Ambiguous` 三态 latch + 30s TTL（含两个 boundary case：旧 Single 过期当 Empty、旧 Ambiguous 过期重置为 Single）。`tray::show_main_window` 提为 `pub`，托盘点击 / 第二实例启动 / WinRT 通知点击三处共享。
- `updateSessionMetadata` 的 read-modify-write 全量挪到 `withSessionsLock` 内部，杜绝并发 writer 互相覆盖（freeze 端点的高频写入暴露的 pre-existing race）。
- `AbortSession` 在 provider-switch 终止后正确重置，避免下一条用户消息被 startup 守卫误判为"用户按了 Stop"丢弃；该守卫额外暴露 `chat:agent-error` 让 #183 的重发 banner 兜底任意 future 类似泄漏。

---

## [0.2.13] - 2026-05-09

> 0.2.12 紧急修复：消息显示两遍、多 Agent 状态错位、关闭 tab 后回切丢失 AI 回复。

### Fixed

- **每条发出去的消息不再显示两遍（issue #173）**：0.2.12 的队列重写引入回归——每发一条消息，聊天里出现两个一模一样的气泡，会话存档里也写入两条记录。问题来自后端把同一条消息推了两次，前端去重又因 id 不同没生效。修复后每条消息只渲染一次、只存档一次。
- **并行 Agent 任务的状态指示器与文字一致（issue #175）**：用 Agent 工具同时派多个子任务时，列表里的绿灯指示器会灭、Loader 图标也是静态的，但展开后文字写"Agent is running"。现在指示器、Loader、文字三者状态严格同步——每个并行任务都有自己的实时状态。
- **关闭 tab 后立刻从历史打开同一会话，AI 正在生成的内容不再丢失**：之前关闭 tab 时虽然提示「进入后台继续完成」、后端确实启动了后台任务保活，但只要用户立刻从历史菜单回到这个会话，前端会先取消后台、再重建 Sidecar——这一瞬间 AI 进程没有任何持有者就被回收了，30 秒思考与工具调用全部丢失。修复后用户回切时先把新 tab 接成持有者，再释放后台标记，AI 进程跨 tab 无缝接管，回复完整保留（这个隐患从 v0.1.14 引入后台续跑功能时就存在，触发条件较窄）。

---

## [0.2.12] - 2026-05-09

> 0.2.11 残留问题集中修复：定时任务能跑、Windows 用户能用、AI 中文输出不走样、对话细节回到正轨。

### Fixed

- **定时任务真的会执行（issue #166）**：`0 21 * * 0`（每周日 21 点）这类标准 cron 表达式之前会卡在 running 状态、永远不触发，用户完全无感知。
- **AI 中文输出的加粗和表格不再走样（issue #167）**：DeepSeek / MiniMax 等中文模型输出的全角星号 `＊＊文字＊＊` 现在能正确渲染为粗体。
- **Windows 外部 runtime 解封（issue #170）**：Codex / Claude Code / Gemini 在 Windows 启动后永久挂起的问题修复；调用外部 runtime 和 MCP 时也不再频繁弹出黑色控制台窗口；带引号或特殊字符的参数（如 Codex 的 TOML 配置）能正确传入。
- **手动编辑过的配置文件不再丢数据（issue #170）**：用 Notepad 等工具保存的 `config.json` / `cron_tasks.json` / `sessions.json`（带 UTF-8 BOM）之前会被静默丢弃回退到备份，看起来像数据丢失。
- **AI 输出过程中追加消息更及时**：AI 还在输出时按 ⏎ 追加的新消息能立即进入当前轮处理，不再等本轮完整结束。
- **同账号开多 Tab 不互相错杀（issue #169）**：两个 Tab 打开同一会话时切换不再产生路由错乱。
- **删除对话的确认按钮不再被历史菜单挡住**。
- **F5 / Cmd+R 不再误退到 launcher**，当前 Tab 上下文不会丢失。
- **微信 / 飞书 / 钉钉 bot 跟上 OpenClaw 升级（issue #171）**：插件升级后启动报「host too old or plugin SDK contract violated」的问题修复。

---

## [0.2.11] - 2026-05-08

> 重点修复：微信 bot 升级到 2.4.2 后能正常启动；切到 IM bot 历史会话不再被弹回 Launcher；订阅版 Sonnet 4.6 不再撞 1M 限额；流式输出中"取消排队消息"真的能取消。同时把定时任务 / 退出 cron / IM 发图统一到 `myagents` CLI，让外部 runtime（Codex / Gemini / Claude Code CLI）也能用。

### Added

- **说一声「记一下…」AI 直接落库**：在桌面 / IM bot / agent 渠道里，用户说「记一下周五要准备演讲」「帮我记…」「note this down」「remember this」，AI 会调 `myagents thought create` 把内容存进收件箱，而不只是嘴上回复"好的我记住了"。触发器严格区分"明确请求记录" vs "顺嘴提到的想法"——FYI / 偏好 / 头脑风暴等不会误存。

### Changed

- **定时任务 / cron 退出 / IM 发图统一走 CLI**：之前这三类能力是 builtin Claude Agent SDK 专属的内置 MCP 工具，外部 runtime（Codex CLI / Gemini CLI / Claude Code CLI）用不了。现在改为通过 `myagents` CLI 提供，所有 runtime 行为一致。同时 cron 增加跨 workspace 隔离——一个 workspace 里创建的定时任务不能被另一个 workspace 的会话删除 / 修改 / 立即执行。

### Fixed

- **微信 bot 升级到 2.4.2 后能启动**：插件升级后要求宿主在 startup 时提供新的 `channelRuntime` 接口，0.2.10 之前的 bridge 没注入这个字段，启动直接报"host too old or plugin SDK contract violated"。修复后微信 bot 重新可用，企业微信 / 飞书 / QQ bot 不受影响。
- **切到历史 IM bot 会话不再回弹 Launcher**：在桌面 workspace 里点历史下拉里某个 IM bot session 时，过去会因竞态被弹回 Launcher 视图——sessionId 已切到新会话，但视图、agent 目录、标题没跟上。现在切换流程把这几项原子写入。
- **流式输出中点 × 取消排队消息真的能取消**：AI 还在输出时用户用"深入讲讲"等快捷动作把消息塞进队列，再点 × 取消——之前内部已同步把消息丢进 SDK，× 只删 UI，AI 仍然会回。现在排队消息延后到 AI 当前轮结束才下发，期间取消即真取消（IM bot 上的取消请求若失败会如实返回 409 而非假装成功）。
- **订阅版 Sonnet 4.6 不再撞 1M 限额**：`Anthropic（订阅）`预设里 sonnet-4-6 之前被标为 1M 上下文，但订阅默认只给 200K，结果发消息直接报 `Extra usage is required for 1M context`。校正回 200K，订阅用户开箱即用；想用 1M 的可以自定义 provider 显式启用。
- **删除会话时确认按钮无响应**：会话历史里点删除，确认按钮不触发任何事件——改用统一确认弹窗组件。
- **行动模式下 AI 调用 `myagents thought create` 不再弹权限框**：AI 用单引号包裹内容（防 shell 注入）调 thought create，过去仍要用户点一次"允许"才能落库。现在符合"单引号、无尾随 shell 元字符"形式直接放行；双引号 / 不带引号等任何不安全形式仍会拦截。
- **Windows CLI 一组体感问题（issue #149）**：
  - `cron add --dry-run` 之前会真的写入任务（CLI 没把 flag 传给 server），现在按 `mcp add --dry-run` 同款形态返回 `[DRY RUN] Would apply:` 预览。
  - `myagents thought create` 在 Windows 上偶尔丢内容报 422，新增 `--content-file <abs-path>` 跨平台保底通道（写文件 → 传路径，不受任何 shell 引号问题影响），CLI 端把空内容拦在 API round-trip 之前给可恢复错误提示。
  - `myagents thought readme` 之前返回 `Unknown admin route`，现在返回简短指引（含 `--content-file` 用法）。
  - `plugin list` 之前每行字段都是 `?`（CLI formatter 字段名跟 Rust 返回结构对不上），修正字段映射。
  - `config get / mcp env get / agent channel list` 之前只显示 `✓ <action>` 没数据，补 3 个 formatter 渲染实际 key/value / env map / channel 列表。
  - `mcp show / agent show / runtime describe / task get` 在 Windows 报 "Missing required argument"（根因待 Windows 端调试，无法在 macOS 复现）：CLI 端早期校验把不清晰的 server 422 替换为带 `--<flag>` workaround 提示的清晰错误。

---

## [0.2.10] - 2026-05-07

> 重点修复：1M 上下文模型真正按 1M 用、上游 API 抖动期间能手动停止、切模型 / 切供应商后立即发消息不再丢或跑错配置；安全侧补一个工作区内 symlink 逃逸的口子。

### Fixed

- **1M 模型真的按 1M 上下文用**：选了 1M 窗口的模型（DeepSeek V4 Pro / Gemini 2.5 / GPT-5.4 / Claude 1M ……），`/context` 现在显示 1M、长对话不会过早被自动压缩、附件也不会被提前截。之前所有非 Anthropic 协议的 1M 模型都被当 200K 处理，长上下文优势用不上。
- **切模型后立即发消息保证用新模型**：模型选择器换模型后立刻按发送，首条消息现在保证在新模型上跑——之前有内部异步窗口，首轮偶尔会跑在旧模型上。
- **API 抖动期间停止按钮可用**：上游 API 临时故障时内部会指数退避重试（最长 ~5 分钟），过去用户只能干等——停止按钮被禁用。现在期间显示红色「停止重试」按钮，可以随时退出。
- **切供应商后立即发消息不会被静默吞掉**：之前内部延迟重启的逻辑会误把刚起好的子进程关掉，前端默默回到空闲、用户消息丢失。
- **聊天滚动定位**：发消息 / Tab 切换后能正确停在最底，多 tool 调用的长助手消息不会停在中段；切走再切回时不会错误退出「自动跟随最新」模式。
- **Widget 标签出现在消息正文不破坏渲染**：当 AI 在解释或讨论 `<generative-ui-widget>` 协议本身时（inline code、文字中提及、一条消息含两个 widget），消息能完整显示，不再被错当成「未闭合 widget」吞掉后续内容。
- **Windows 非系统盘工作区 / 项目级 skill 的「打开」按钮**：工作区在 `D:\` / 外接卷上、或项目里的 skill / command 路径，「在 Finder/资源管理器中显示」和「用默认应用打开」现在能正常工作（之前一律报 "Path not allowed"）。
- **渠道列表显示真实 bot 名，不再是 npm 包名**：同一个插件下挂多个 bot 时（比如两个飞书 bot），列表里之前都显示成 npm 包名（`larksuite/openclaw-lark` × 2）看不清谁是谁。现在直接拉飞书 / QQ 各自 API 的真实 bot displayName 显示。0.2.10 之前已经被写到磁盘的旧「包名」状态会在下次 channel 启动时自动清掉。

### Improved

- **飞书 Channel 配置向导更顺**：凭证步骤删掉多余的几张引导图、凭证填好后顶部出现「凭证已验证 / 接下来要做的 3 步」的状态条，整个绑定流程不再让人原地懵。

### Security

- **工作区里的 symlink 不再能指向工作区外被系统打开**：repo 中存在 `leak → ~/.ssh/id_rsa` 这类 symlink 时（无论是误提交还是恶意构造），过去会被系统级「打开」跟随到外部敏感文件。现在 reveal / 默认应用打开两条路径都会做 canonical 校验，逃逸 symlink 直接被拒。

### Changed

- **AI 决定何时画图改为基于内容**：之前要用户说「可视化 / 画一张图 / 做表」AI 才会动用 generative-ui widget；现在 AI 自己根据内容判断——比较、流程、结构、时间轴这类用图比用字更清楚的场景。多个运行时（builtin SDK / Claude Code / Codex / Gemini CLI）行为统一。

---

## [0.2.9] - 2026-05-05

### Added

- **任务编辑器：模型选择器跨厂商**：任务的「高级配置 → 模型」现在按厂商分组列出全部已配置的 provider，和 Chat / Agent 设置一致；外部 runtime（Codex / Claude Code / Gemini）也带自家的 model picker (#130)。
- **Markdown 链接 Cmd/Ctrl+click 直接走系统浏览器**：绕开内置浏览器面板 (#126)。
- **输入框跟随内容自动撑高**：去掉手动展开按钮，最多 9 行后内部滚动 (#129)。

### Changed

- **API Key 轮换立即对在跑的任务/定时任务生效**：之前任务里"用哪个 provider"是创建时的快照——你换 Key 后还得重存一遍每个任务才生效。现在任务只记住 provider 的选择，每次执行都从设置里实时读 Key / baseUrl。
- **任务编辑校验**：保存任务时检查"provider + model 配对"和"外部 runtime ↔ provider 互斥"，避免出现执行时静默走错配置的情况。

### Fixed

- **切回订阅后定时任务仍跑在第三方供应商**：PRD #119 留下的潜在 bug，订阅切换语义现在正确。
- **第三方供应商被删除后老定时任务还在用旧 Key**：删除后的下一次 tick 不再偷跑，会把任务标 Blocked。
- **空白 API Key 被当合法值发到上游产生 401**：现在直接拒绝并提示"未配置 Key"。
- **阿里百炼 Coding Plan 添加后模型管理报错** (#127)：跳过该 provider 的模型探活。
- **Windows 上点外链每次闪一个 CMD 黑窗**。
- **飞书慢响应时 IM Bot 消息挂死直到分钟级 OS 超时**：上游 fetch 现在带 30s 超时 + 父级取消传递。
- **Plan Mode 下用户拒绝方案后 AI 仍继续执行其他工具** (#131)：现在拒绝即终止整轮回答，UI 弹窗在后端超时 / 中断后也会自动消失，不再出现"前端已取消但后端不认识"的错位状态。
- **极端情况下崩溃日志暴涨到几百 GB 撑爆磁盘** (#132, #133)：sidecar 在父进程关闭其 stdout / stderr 管道后，原本会陷入 EPIPE → uncaughtException → 写日志 → 再 EPIPE 的递归循环，单文件可在几分钟内写到 100 GB。修复：捕获并静默 stdio 关闭、避免崩溃处理器递归触发；单文件 50MB 上限 + 目录 200MB 上限 + 同 fingerprint 异常去重，多重防线避免重复异常烧光预算。
- **Fork 分支后切换模型，首条消息丢上下文 / 静默失败** (#134, #135)：原来 fork 关系在第一次 SDK 启动后立即丢弃，模型切换触发 SDK 重启时找不到 session，AI 失忆。现在 fork 元数据保留到 SDK 真正持久化后才清除，期间任何重启会自动重走 fork。

### Migration

- 0.2.8 及更早创建、带凭据快照的定时任务仍可加载执行（兼容路径），用户在「任务编辑」里保存任意一次即迁到新的实时解析路径。

---

## [0.2.8] - 2026-05-03

### Added

- **AI 小助理 inbox 加「历史」入口**：设置页右上角新增「历史」按钮，点选直接新开 Tab 进会话 (#120)。
- **任意会话都能驱动 MyAgents 自身**：`/self-config` 升级为全局 `/myagents-cli`，Chat / IM Bot / Cron 都能用。

### Fixed

- **第三方供应商定时任务跑错模型**：agent 切供应商后老 cron 会拿错配的 model + endpoint 静默失败，现在每条 cron 锁定自己的供应商意图，不再被 agent 切换搞乱 (#119)。
- **验证供应商时把当前对话搞挂**：OpenAI 协议会话进行中点别的供应商 verify、或后台生成标题，原会污染当前会话路由让 Chat 报 `<synthetic>` 错。多个验证现在可以并发不相互踩 (#124)。
- **浏览器面板 file:// 链接 / 本地绝对路径打不开**：现在用 OS 默认应用打开（仍走安全校验），Windows 长路径兼容 (#125)。
- **第三方输入法语音识别刷重复内容发出去**：macOS 上微信输入法偶发把识别文本刷几十次进输入框，发送前现在会弹确认，且必须显式点按钮 (#123)。
- **最近几天日志被字节配额误清**：总量上限提到 5GB + 最近 7 天硬保护，排查问题用的日志不会因配额溢出被清 (#121)。
- **任务编辑器误显示用不了的 runtime 选项**：未开启 multi-agent runtime 时不再列出 Claude Code / Codex / Gemini CLI 选项，与 Chat / Launcher 一致。

---

## [0.2.7] - 2026-05-03

### Added

- **启动页升级为「项目主页」**：启动页输入框现在可以直接 `@` 引用文件、贴图、拖放上传，不再需要先开聊天；侧栏目录、文件预览、引用、复制路径、在 Finder 中显示在没有打开会话时也能用。
- **WorkspaceSelector 重做**：工作区下拉改为带标题的扁平列表；hover 出现「设为默认」；触摸板滚动顺滑；整体视觉与启动页输入区对齐。
- **会话收藏**：任务中心列表行 hover 出现 ★ 收藏按钮，顶部多了「收藏」筛选 chip，方便沉淀长期关注的会话。
- **MA 小助理 inbox 直接挂在「设置 → AI 供应商」页顶部**：不用再翻菜单找入口。
- **目录就地重命名 + 新建笔记**：右键目录里的文件可直接改名；右键空白处「新建笔记」自动建一个 `note-…md` 并跳进编辑模式。
- **文件预览底部信息栏显示绝对路径 + 在 Finder 中显示**：点图标直接揭示文件位置。

### Fixed

- **OpenAI 协议供应商在中国大陆 + Clash 等系统代理下 `fetch failed`**：第三方 OpenAI 兼容协议（Gemini、DeepSeek、Kimi 等通过 OpenAI 协议接入的供应商）走系统代理时不再因 undici 跨版本协议漂移报错。
- **任务中心打开非 cron 保活的历史会话进入空 UI**：之前打开某些被释放的历史会话会看到空白聊天 + 日志爆 "No running sidecar"，需要切 Tab 才能恢复。现在 sidecar 终结时 Tab 会自动回到启动页状态，刷新一致。
- **macOS 长时间使用后 Cmd+W / 关闭面板偶发不响应**：47 处事件监听点统一收口为防 race 的注册器，长会话期间不再积累 Tauri listener 泄漏。

### Improved

- **Tool 输出渲染简化**：工具结果不再有「点开后又出现一层带文件计数的折叠」这种二阶嵌套。外层用 chip 直接概览（多少个文件、多少行）。
- **启动页输入区视觉**：动画以中心为轴对称展开；底栏 chip 加阴影并与输入框同高度感；「想法」picker 与 `@` 弹出菜单行为一致。
- **任务中心 hover 按钮提示**：行 hover 按钮提示从原生 title 改为统一 Tip 组件（暗色、对齐光标、不再被滚动条遮挡）。
- **设置页 helper inbox 工具栏对齐 Chat 输入框**：按钮居中、不再显示快捷键 hint，外观与发消息那条工具栏统一。

---

## [0.2.6] - 2026-05-02

### Fixed

- **同 Tab 内切到另一段历史会话后，新消息能正常发送并收到流式回复**：0.2.5 在同一个 Tab 里跳到另一段历史会话后发消息没有结果，要重新加载历史才能看到。
- **从 Chat 顶部 banner / MCP 对话框唤起 MA 小助理时，正确加载 helper 自己的工作区设置**：之前可能误用当前 Tab 的工作区，导致 helper 看不到自己的 skills / agents。
- **删除一个内置 helper agent 时 picker 选项偶发错位**：删除项时不再误带走相邻项。
- **`~/.myagents/skills/` 里有断链 symlink 时全局 sidecar 启动崩溃**：升级到 Node v24 后，任何残留的指向已删目录的 symlink 都会让 sidecar 反复 abort、Tauri 健康检查反复重启，陷入死循环。现在启动时会安全清理这类断链。
- **静默更新偶发卡死或失败**：静默下载和点击下载共用同一份缓存；更新流程的 UI 锁定路径修整，Tauri updater 在弱网下不再静默失败。

---

## [0.2.5] - 2026-05-01

### Fixed

- **每日定时任务卡在工具权限上（0.2.4 引入的回归）**：升级到 0.2.4 之后，原本稳跑的 cron 日报会被默认权限拦下 WebSearch / Bash / MCP 工具，AI 写"工具被拒"还被错误标成成功。修复后未主动选权限的 cron 一律给最大权限。桌面对话不受影响。老配置首次启动会自动迁移一次。
- **删除定时任务后执行历史文件残留**：删除时会把 `cron_runs/` 里对应的 jsonl 一并清掉。
- **`cron update` 改时区被覆盖回 UTC**：用纯表达式（如 `"30 * * * *"`）改 schedule 时不再丢失原本设的 `Asia/Shanghai`。
- **`myagents task run` 报错指向 HTTP 路径**：错误提示改为可直接复制的 `myagents task rerun <id>`。
- **`myagents cron start` 文档误导**：以前文案写"立即执行"实际只是恢复调度。重写说明，并新增 `run-now` 才是真的立即触发。
- **CLI 偶发 `Unexpected token...` 错误信息**：当后端返回非 JSON 响应（参数格式错、后端异常等）时，CLI 会把真实的服务端错误文本透出来，不再变成无意义的 JSON 解析错。
- **macOS 输入框方向键 / Cmd+V 仍偶发泄露 tofu 字符（0.2.3 没修干净）**：上版本只过滤了 NSFunctionKey 一段范围，漏掉 ANSI C0 控制字符这条隐藏路径。这次连 Cmd+V 空剪贴板触发的同款问题也一并修了。

### Added

- **`myagents cron run-now <id>`**：立即跑一次而不动调度 / 状态。CLI 立即返回，会话 ID 一并打出来好查。任务正在执行时拒绝重叠。
- **`cron list` 多了几列实用信息**：下次触发时间、上次成败 ✓✗、上次耗时、总执行次数。任务此刻在跑时 ID 后会出现 `*` 标记。
- **`cron runs` 默认折行截断 + `--full` 旗标**：长输出不再撑乱表格；要看全文加 `--full`。
- **`cron update` 立即显示下次触发时间**：改完 schedule 后 CLI 直接打 `next fire: 2026-05-01 20:33 Asia/Shanghai (in 1m 33s)`，不用再 list 自己核。

---

## [0.2.4] - 2026-04-30

### Added

- **任务高级配置**：派发和编辑面板新增「高级配置」折叠区，单个任务可单独覆盖 runtime（builtin / Claude Code / Codex / Gemini）、模型、权限模式、MCP 服务器，不影响工作区默认。
- **想法多选合并 / 删除**：框选多条想法批量合并或删除。
- **想法搜索关键词高亮**。
- **AI 输入框 `@` 引用支持「想法」**：`@` picker 增加想法 tab，⌘/Ctrl+←/→ 切 tab，回车插入全文。
- **任务卡 hover「查看任务会话」按钮**：单击直达该任务最近一次会话 Tab。
- **派发任务时一并写 verify.md**：建任务时同步落盘验收清单。
- **任务编辑模式开放三份文档**：task.md / verify.md 可编辑，progress.md 只读预览。
- **内嵌浏览器面板**：工作区工具栏新增地球图标，分屏面板里打开浏览器；地址栏、前进后退、刷新、在系统浏览器打开、关闭俱全。Cmd / Ctrl / 中键点链接跳系统默认浏览器。

### Fixed

- **Cron 日报偶发不送达 IM Bot（自 0.2.2 起的回归）**：定时任务结果不再丢，最迟 30 分钟内一定送达。
- **任务级 MCP override 配了不生效**：高级配置勾的 MCP 在 cron 触发时立即应用。
- **多个 Cron tick 并发互相打断**：高频任务不再串扰；跟随 Agent 模式不会被前一任务的覆盖配置污染。
- **聊天流式输出时切 Tab 回来不再丢底部锚定 / 不再跳到对话顶部**。

### Improved

- **任务派发 / 详情 / 编辑三面板视觉打通**：宽度、间距、标题层级、Toggle、快捷键全部对齐。
- **任务卡 progress.md 长内容自动收纳**：默认 ~280px 高加渐隐 +「展开全部 / 收起」。
- **任务卡活动栏改单行**：长内容截断不再撑爆卡片。
- **任务多选交互精简**：去掉「多选模式」横条，浮动菜单贴左。
- **「会话详情」按钮换 icon + 文案 + 黑色 tooltip**：更显眼。

---

## [0.2.3] - 2026-04-29

### Added

- **任务中心「想法 → AI 讨论」体验改进**：从想法卡片直接发起讨论时，原本会出现「query 在屏幕上但没有 loading 提示，~10 秒后才进入响应中」的怪异中间态。现在新 Tab 一打开就显示「AI 启动中」直到 AI 真正开始流式输出，状态全程一致。配套优化：外部 runtime（Gemini CLI / Codex CLI）的 Tab 启动从 ~17s 缩短到 ~10s（消除了重复的 CLI 进程冷启动）。
- **文件预览支持引用到聊天**：在文件预览面板里，可以选择整文件或某几行直接引用到当前聊天输入框。
- **图片粘贴在不支持图像的模型下也不丢失**：以前在 DeepSeek、Kimi 文本模型等不支持图片输入的模型下粘图，sidecar 会偷偷把图片丢掉、只把文本送给 AI。现在改成自动把图片存到工作区 `myagents_files/`，输入框里出现 `@图片路径` 引用，AI 至少知道你给了它什么文件，可以用 Read / OCR 等工具自己想办法处理。Tab UI（粘贴 + 拖拽）和 IM Bot（飞书 / Telegram / 钉钉 / 微信收图）都覆盖。Toast 文案也从「会自动过滤，仅文本送达」改成「已转为文件存入工作区供模型读取」。
- **右键 Skill / Agent 列表的「设置」直达详情**：以前要先点开 Skill / Agent 再切到设置，现在右键直接进入详情面板。

### Fixed

- **从「想法 → AI 讨论」启动会话时 API key 验证失败（P1）**：当工作区配置的 AI 供应商和全局默认供应商不一致时（例如工作区用 Anthropic、全局默认是 OpenRouter），讨论 Tab 启动时会用错位的供应商 + 工作区的 model 名发请求，立刻撞 API key 验证失败。修复后所有从工作区发起的会话严格遵守 `Agent → 工作区 → 全局默认` 的优先级链。
- **macOS 输入栏偶尔出现 tofu / 乱码字符**：在 macOS 上当输入光标处于文本边界时按方向键 / Page-Up / Page-Down / Home / End 等功能键，会把 WebKit 内部私有码点泄漏到输入框值里显示成 tofu。已彻底拦掉。
- **IM Bot 闲置后日志反复刷重试连接**：IM Bot 进入空闲后 sidecar 正常关闭，但事件订阅器还在每 5 秒尝试连一次已经退出的端口，统一日志会被反复刷屏。修复后 sidecar 生命周期与事件订阅严格对齐。
- **IM Bot 首条消息可能没用上工作区 MCP**：预热 SDK 时还没注入 context MCP，首条消息进来 AI 的工具列表不完整。现在预热完成后立即注入。
- **`/new` 重置会话后第一轮回复偶尔不抵达 IM Bot**：在外部 runtime（Gemini / Codex CLI）下，`/new` 之后第一条 AI 回复有时没投递到 bot 端，已修复。
- **OpenClaw 插件兼容性提升（飞书 / 微信 / 企业微信 / QQ）**：一连串底层兼容修（fetch 适配、HTTP 客户端 patch、媒体上传参数翻译、出站媒体接口实现），OpenClaw 插件链路更稳，社区插件接入不再需要逐一验证 HTTP 行为。
- **聊天滚动时用户气泡偶尔消失**：滚动容器的样式调整后气泡不再被裁切。
- **Gemini CLI 偶发会话失效能自动恢复**：CLI 报告会话过期时不再需要手动重启 Tab，自动重建会话继续。

### Improved

- **图像 fallback 时 toast 文案更准确**：以前批量上传里只有部分图片 fallback 到工作区文件、其余实际成功，仍会弹绿色「全部成功」toast。现在 fallback-only 批次抑制该 toast。

---

## [0.2.2] - 2026-04-28

### Added

- **CLAUDE.md / 使用指南 空状态升级为引导卡片**：以前只有一个孤零零的「创建」按钮，现在 CLAUDE.md 空状态变成三张卡片——「智能生成」一键让 AI 分析项目结构自动写出 CLAUDE.md（运行 `/init`），「从模板库添加」可以挑一个内置或自己保存的 Agent 模板合并到当前工作区（覆盖前会列出所有受影响文件让你确认），「手动创建」从空白进入编辑器。使用指南页面对齐了同款布局。
- **Markdown 编辑器换成实时保存 + 预览/编辑切换**：以前要点「编辑」「保存」「取消」三段式，重而繁琐。现在像 Typora / Obsidian 一样默默落盘，标题栏右侧用一个 `预览 | 编辑` 切换按钮在两种视图间切换。

### Improved

- **Markdown 编辑器更适合中文写作**：单换行也会渲染换行（之前要打两个空格才认）；编辑器字号从 13 加大到 14；右侧加了视觉边距，文字不再贴边或被滚动条挡住。
- **代码 / Markdown 编辑器在中文场景下不再"嘈杂"**：全角标点 `，` `。` `；` 不再被橙色方框圈起来；光标停留时不再到处闪 highlight；双击中文不再一选选一整段——会以中文标点为边界停下，更接近预期。
- **使用统计图表正确响应时间范围**：以前选「7 天」依然显示 60 多根柱子（任何最近活跃过的会话都会把整段历史灌进来），顶部数字与图表也对不上。现在严格按范围过滤，summary 与图表数字保持一致；日期标签也会随密度自动倾斜或转纵向，不再叠成一团。

### Fixed

- **统一日志中再降一层噪音**：v0.2.1 已经把 Rust 侧「关 tab 时还有飞行请求」一类的事件从 ERROR 降到 WARN，但渲染器侧还在把同一事件记成 ERROR，统一日志里两条信号互相矛盾。现在渲染器侧也按相同规则分类——生命周期事件 console.warn，真正的错误才 console.error。
- **主动点停止时不再弹「工具执行被中断」横幅**：AI 流式输出时点停止已经不弹了，但 AI 正在调用工具的瞬间被你停掉还会弹一个「可重新发送让 AI 重试」的横幅——明明是你主动停的，多此一举。现在两种时机一视同仁，主动停止不再被横幅打扰。

---

## [0.2.1] - 2026-04-27

### Fixed

- **大工作区文件树打不开 / 长会话恢复失败（修复 #109）**：在 macOS 上打开几千文件的工作区（笔记仓库 / 知识库类），左侧文件树会一直显示「Load failed」；恢复历史很长的对话时也偶发同样的报错。任何超过 1 MB 的响应都会撞到这个坑，所以现象不止文件树。
- **顺手把不必要的错误日志降级**：标签关闭时还有飞行中的请求、子进程被回收时正在传输的响应——这两类正常生命周期事件之前都按 ERROR 记，把统一日志噪音占满。现在这两类降到 WARN，真正的错误更容易被看到。

### Improved

- **文件树首次加载更快**：以前不论工作区多大，都把目录递归走 6 层（最多 5 万条目）才返回。现在第一次只展开 4 层、最多 1 万条目，更深的目录点开时按需加载。结果：4000 文件的工作区打开速度从「秒级 → 不到 50 毫秒」。


---

## [0.2.0] - 2026-04-26

> 本版本紧接 0.1.70。底层运行时从 Bun 切到 Node.js v24，外加一批 Windows / Linux 平台问题修复和启动加速。

### Breaking

- **`agent-browser` 浏览器自动化 CLI 不再随应用打包**：DMG / 安装包体积减少 ~84 MB。首次让 AI 做浏览器自动化任务时，会自动用 `npm install -g` 装一次（约 10 秒），之后即时可用。网络受限环境也可临时让 AI 用 `npx` 顶替。
- **少数从 v0.1.x 直接跨级升级用户首次访问网站需要重新登录**：旧的浏览器 Cookie 持久化迁移随同 `agent-browser` bundle 一起清理。如果你之前一直跟着小版本升级（0.1.65 → 0.1.66 → … → 0.1.70 → 0.2.0），不会受影响。
- **运行时切到 Node.js v24，Bun 移除**：用户侧完全无感（应用启动方式 / 配置 / 数据都不变）。开发者从此用 `npm install` / `npm run` 代替 `bun install` / `bun run`；同步把 Claude Agent SDK 升到 0.2.119（按平台 native binary 分发，安装包随之变大但跨架构兼容性更好）。

### Improved

- **Plugin Bridge 兼容性跃升**：飞书 / QQ / 微信 / 企业微信等 OpenClaw 插件之前偶发 30 秒挂起 / 静默连不上的问题彻底消失。社区新插件接入不再需要一个一个验证 HTTP 行为是否兼容。
- **长对话稳定性提升**：30 分钟以上的连续对话内存增长被显著抑制，长 session 不再越用越卡。
- **大文件上传不再吃光内存**：长视频 / 大图片改为流式上传，单文件几百 MB 也不会让 Sidecar 内存爆掉。
- **错误信息更清晰**：以前看到孤单的 `exit code -1`，现在直接告诉你「找不到可执行文件」/「CPU 架构不匹配」等真实原因。

### Fixed

- **Windows 安装后能正常启动**：之前 Windows 用户装好 0.2.0 打开应用，会卡在「正在加载历史会话」永远进不去。现在 Windows 一键启动，和 macOS 一样开箱即用。
- **Linux 上 `myagents` CLI 能直接执行**：之前在 Linux 装完应用后跑 `myagents --help` 会被系统拒绝（脚本头部多了一行旧时代留下的 shebang），现在恢复正常。
- **Windows 上保存配置 / 项目列表 / 启动页历史不再失败**：之前在 Windows 上偶尔出现「拒绝访问」的红色错误（杀软 / OneDrive / Backblaze 在我们写完文件的瞬间扫描占用），导致刚切换的工作区下次打开应用就丢了。现在自动等开扫窗口过去再写盘，用户感知不到。
- **Windows 上 npm 安装的 CLI 工具能正常调用**：之前从 npm 装的 `codex` / `gemini` / `npx` 等带 `.cmd` 后缀的命令在 Windows 上启动失败，现在恢复正常。
- **Windows 大日志导出不再卡死**：之前在 Windows 上用 zip 打包大日志或者 PowerShell 命令输出大量内容时偶尔会无限挂起，已修复。
- **IM Bot 自动启动稳定**：飞书 / 企业微信 / 微信 / QQ 等 OpenClaw 插件之前偶发「启动失败 → 自动重试 → 又失败」的循环（多个 Bot 同时启动时会互相破坏对方的依赖目录）。现在多个 Bot 并发启动彼此隔离，重启 / 切工作区不再触发这个问题。
- **应用闪退后 `myagents` CLI 不再损坏**：极端情况下应用进程被强杀的瞬间正好在同步 CLI，会把 `~/.myagents/bin/myagents` 写到一半，下次终端调用直接报「文件损坏」。现在采用原子替换，要么旧版本要么新版本，不会卡在中间态。
- **任务中心「想法」输入光标位置精确**：在想法输入框打 `#标签` 时，标签的高亮位置偶尔会跟实际文字错开半个字符，长内容下越走越偏。修复后高亮、光标、文本三层永远对齐。
- **AI 实时输出更稳**：少数情况下 AI 的实时事件（外部 Runtime 状态切换、turn 完成等）在网络抖动时会被静默丢弃，前端看到「打字打了一半就停了」。所有结构性事件现在都标记为关键优先级，背压时优先送达。
- **OpenAI 兼容供应商在系统代理后面能正常走代理**：之前接 OpenAI 兼容供应商时系统代理 / SOCKS5 会被静默绕过，请求直连，现在严格走代理。
- **磁盘满时大工具结果不再连累界面**：以前磁盘满时前端会被大块工具结果直接灌爆 UI，现在直接告失败而不是把整个会话拖下水。
- **外部 Runtime 子进程不再变僵尸**：终止 Claude Code / Codex / Gemini 时模型 / 工具子进程会随之退出，不会留在后台。
- **多个 IM Bot 并发时身份不再串线**：之前在同一时间多个 IM 入口同时触达时，偶发把 A 用户的 OAuth 票据 / cron 任务 / 媒体投递错给 B 的极小概率问题修复。

### Performance

- **Sidecar 冷启动从 ~5-7 秒降到 ~2-3 秒**：新开 Tab / 唤起对话的等待感显著缩短。多处优化叠加的结果——HTTP 服务器优先就绪、内置 MCP 懒加载（首次用到才加载）、Tab 切换跳过不必要的磁盘扫描，以及 Rust 端 health check 改成指数退避。

---

## [0.1.70] - 2026-04-24

### Added
- **启动页「想法」模式拥有和任务中心一模一样的体验**：输入 `#` 弹候选、文本里 `#标签` 实时高亮、输入框下方有 `#` 按钮，⌘/Ctrl+Enter 提交。任务/想法模式切换时草稿和附件完整保留，不再因切换丢失。
- **`#` 标签候选默认包含所有 Agent 工作区名字**：按下 `#` 一眼就能把想法归类到任意工作区，不需要先手动打过一次该 tag 才出现在候选里。和右侧的「Agent 工作区」面板一一对应（过滤掉诊断目录等内部工作区）。
- **`myagents mcp show <id>`**：查看单个 MCP 服务器的完整配置、全局 / 工作区两级启用状态、传输层信息（env / headers 自动脱敏）。和 `agent show` / `runtime describe` 形态对等。
- **`myagents cron --schedule` 支持 JSON 形式**：除了原有的 cron 表达式（`"*/30 * * * *"`），现在也直接接受与内部结构一致的 JSON —— `{"kind":"at","at":"..."}` / `{"kind":"every","minutes":30}` / `{"kind":"cron","expr":"...","tz":"..."}` / `{"kind":"loop"}`。字段校验在 CLI 边界立即报错，不再出现莫名的 "Failed to parse JSON"。`--message` 是 `--prompt` 的正式别名。
- **SiliconFlow 预设刷新**：Kimi K2.6、GLM 5.1、MiniMax M2.5 开箱即用。
- **DeepSeek 预设刷新**：DeepSeek V4 Pro / V4 Flash 两个新模型已进入预设，Pro 为默认首选；子 Agent 别名对齐（sonnet/opus → Pro、haiku → Flash）。旧 `deepseek-chat` / `deepseek-reasoner` 保留在列表中，升级后老工作区的选择不会消失。

### Improved
- **Agent 设置的「模型」下拉只显示可用供应商**：和 AI 对话框的模型切换器完全一致 —— 只显示已配置 API Key 或完成订阅登录的供应商。如果之前保存的供应商后来失去了凭据，会显示「⚠ 暂不可用」提示你重新选择。
- **Cmd/Ctrl+Shift+T 快捷键在启动页真正切换任务/想法模式**：之前这个组合键和新开 Tab 撞车，按下去直接新开 Tab 而不是切换模式；现在两个快捷键各行其道。
- **弹层遮挡优化**：嵌在 Overlay 里的下拉菜单（Runtime 选择器 / Skill 详情 / BugReport 模型选择 / Template 图标选择等）不再被自身面板遮住。
- **SubAgent 模型 / 工具 / 提示词修改立刻生效**：编辑 `~/.myagents/agents/<agent>/<name>.md` 后执行 `myagents reload`，下一轮对话就能看到新配置，不再需要重启整个应用。

### Fixed
- **Windows 首次启动卡 10 秒**：旧 Sidecar 清理移到后台，主线程不再阻塞，打开应用瞬时可见 UI。
- **外部 Runtime（Claude Code / Gemini）会话自动恢复**：当 CLI 那边清理掉会话 ID 后，MyAgents 能检测到并自动新开对话，不再死循环报错。
- **技能稳定性**：symlink / junction 形式的技能目录现在能正确识别并展示；skill 安装后 `/health` 不再短暂阻塞；sub-agent 扫描对齐 Claude Agent SDK 最新协议，非标准布局的 Agent 目录也能正确找到。
- **Chat Tab 切换时偶现的 UI 状态错乱**：按 PRD v0.1.69 §4.3 对齐双写策略。
- **CLI 错误信息友好化**：`myagents mcp show` 从原来的「Unknown admin route」恢复为正常命令；`cron --schedule` 错误提示在 CLI 边界清晰给出。

### Notes
- GetNote MCP（社区第三方工具）的 `list_notes` 返回 tag 显示为 `[object Object]` 是**上游 MCP server 自己的序列化 bug**，与 MyAgents 无关，请到对应仓库报告。MyAgents 对 MCP 返回内容是原样透传的。

---

## [0.1.69] - 2026-04-23

### Added
- **任务中心（Task Center）**：全新的任务管理 Tab，左栏是「想法」速记流（`#tag` 自动识别 + 按月归档），右栏是任务列表（进行中 / 规划中 / 已完成三段式 + 卡片 / 列表双视图）。点击任务卡唤起详情 Overlay，包含：
  - 完整的任务编辑面板 —— 名称、描述、Prompt、执行模式（一次性 / 定时）、per-task 覆盖 Runtime / 模型 / 权限模式、结束条件（执行次数 / deadline）、通知订阅
  - 定时任务的 interval（每 N 分钟）和 cron 表达式统一在一个切换器里配置
  - 运行统计、状态变更历史、关联 Session 列表，支持立即执行、重新派发、状态变更、归档、删除
  - 任务 / 想法搜索栏（独立过滤）+ 全局 ⌘K 搜索都能检索任务内容
  - 顶部导航栏新增「任务」入口
- **任务 / 想法 模式切换器**：启动页 + Chat Tab 输入框上方都有 `任务 | 想法` 切换（`Cmd/Ctrl+Shift+T` 快捷键）。选中「想法」后回车保存为想法而非启动对话，写完自动切回「任务」。
- **AI 讨论路径（想法 → 正式任务）**：想法卡「AI 讨论」按钮打开新 Chat Tab，自动注入 `task-alignment` Skill；对齐完成后 AI 直接把四份文档（alignment / task / verify / progress）迁入正式任务目录，登记为「AI 对齐」任务，一键就能开始执行。
- **执行闭环：编辑即生效**：任务立即执行 / 重新派发时，每次触发都会动态从最新的 task.md 读取内容构造首条消息。你中途编辑任务描述后，下一次执行立即生效，不需要手动同步。定时任务走同一套机制。
- **`myagents task` / `thought` CLI**：AI 和用户通过终端完整自管任务生命周期 —— `task list / get / run / rerun / update-status / update-progress / append-session / archive / delete / create-direct / create-from-alignment` + `thought list / create`。支持 per-task 运行时 / 模型 / 权限模式覆盖参数。AI 子进程、用户终端、UI 三条入口的身份自动识别，互不伪造，审计链可追溯。
- **通知系统**：每次任务状态变更自动分发 —— 桌面通知 + IM Bot 消息（`done / blocked / endCondition` 默认订阅 + per-task 自定义）。派发对话框和任务详情 Overlay 两处都能编辑通知配置。通知 Bot 选择器按「工作区 · 平台」分组展示，稳定排序。
- **状态机 + 审计链 + 实时同步**：Task 持久化状态变更历史（谁、何时、从什么状态到什么状态、原因），每次变更原子写入 + 追加到 progress.md + 广播 SSE 事件，所有打开的任务中心 Tab 实时同步；崩溃恢复自动把遗留 running / verifying 状态迁到 blocked 并记入历史；删除也写入审计可溯。
- **想法 ↔ 任务双向绑定**：派发想法生成的任务 ID 自动追加回想法记录；任务被删除时反向清理想法中的绑定。
- **Moonshot Kimi-K2.6 + CodingPlan 预设**：供应商下拉新增 Moonshot 官方 Coding 预设，Kimi-K2.6 模型开箱即用。
- **Claude Code 的 AskUserQuestion 走结构化 UI**：CC Runtime 下 AI 问用户问题（多选）时，前端直接渲染成可点击按钮组，而不是纯文本让你手打答案。

### Improved
- **启动页 / 任务中心 / 聊天输入框视觉升级**：
  - 卡片系统 V2 —— 悬浮式无边框卡片、阴影降一档，整体更轻盈
  - 启动页模式切换器改为 macOS 风格图标分段控件（任务 / 对话）
  - 13 处下拉菜单统一用新的 Popover 原语，弹出位置、翻转方向、关闭行为一致
  - 点击反馈动画统一 scale(0.98) 并正确 scope 到最内层元素（点卡片里的按钮不再带动整张卡片动）
  - 任务（CheckSquare）、小助理（Bot）、记录想法（PenLine）等图标调整
- **聊天页稳定性**：
  - 工具调用卡片不再把一段连续文本切成两半
  - 工具数量 badge 和弹窗里的工具列表对齐
  - Virtuoso 滚动在"强制到底"模式下不再卡顿
  - 切 Tab 时全局监听器不再越权响应其他 Tab 的事件
  - AI 中止期间 SDK 的诊断噪音被抑制，不再刷屏

### Fixed
- **Windows 硬杀会话时消息不丢失**：之前在 Windows 上中断会话可能让最近几条消息丢失，现在队列生命周期架构化处理，即使硬杀也能完整保留。
- **Gemini 临时提示词文件不再残留**：之前 Gemini 进程意外退出时会留下临时的 system prompt 文件，现在改由 session 生命周期管理，进程 crash / 空闲超时都会正确清理。
- **Sidecar 未就绪时的竞态**：打开 Tab 瞬间发消息偶尔会因为 Sidecar 还没起好而失败，现在会先等待就绪再发送，用户无感。
- **macOS 触摸板轻按首次点击失效**：之前在 macOS 上用触摸板 tap 某些按钮，物理按下正常但轻按首次无反应（隐蔽的焦点抢夺陷阱）。修复后所有按钮触摸板轻按稳定响应。
- **启动页 Tab 切换按钮真的会切换**：之前 tooltip 说"点击切换模式"但点了没反应，现在 Tab 键 + 点击都能正常切换任务 / 对话模式。
- **Bun-on-Windows 目录创建崩溃**：系统性修复 Windows 平台下 Bun 在多处零散出现的 `mkdirSync` 遇到已存在目录报 EEXIST 的问题。
- **Claude Code 订阅登录隔离**：CC Runtime 现在完全由 CLI 自己管推理路由，MyAgents 不再尝试注入 provider，避免跨入口（Tab / 微信 / 定时任务）互相干扰订阅登录态。
- **验证供应商时的错误提示**：之前桥接连接失败统一显示"超时"，现在区分真正的超时和连接错误，给出具体原因。
- **Runtime 切换防串线加固**：外部 Runtime 的会话标识以 session 为权威来源，切换 Runtime / 续接历史时不再发生 runtime 不匹配导致的状态污染。
- **系统级 Skills 强制更新**：`task-alignment` / `task-implement` 作为系统 Skill 随版本强制更新，确保你本地的任务对齐和执行逻辑永远与产品同步。
- **内置 MA 小助理升级**：`self-config` Skill 新增任务中心 CLI 操作说明（建任务 / 管想法 / 改配置都可以直接对小助理说），`task-alignment` Skill 补充 AI 讨论路径自动化指令。

---

## [0.1.68] - 2026-04-17

### Added
- **Gemini / Codex 自动继承项目 CLAUDE.md 和 .claude/rules**：切到外部 Runtime 后，AI 也能读到你项目里写好的开发约束和规则文件，不再"失忆"。Codex 走原生配置发现，Gemini 写入合并后的系统提示，零额外配置。
- **外部 Runtime 会话标题自动生成**：之前切到 Gemini / Claude Code / Codex 后，会话标题一直显示默认名。现在会用对应 Runtime 自动生成摘要标题，和内置 Runtime 体验一致。
- **外部 Runtime 冷启动加速（Pre-warm）**：首次发消息前在后台预启动 Runtime 进程，隐藏 10-15 秒的冷启动延迟。
- **Anthropic 模型别名锁定**：新版 SDK 移除了 `claude-sonnet-4-20250514` 等旧 ID 的内置映射，现在 MyAgents 在启动时主动注入 `sonnet → claude-sonnet-4-20250514` 等别名，子 Agent 指定 `model: "sonnet"` 不再报"模型不存在"。

### Fixed
- **Gemini 长时间工具调用不再误报超时**：之前 Gemini 执行耗时工具（如网络搜索）超过 10 分钟会弹红色错误。现在取消了硬超时，改由无活动看门狗兜底，正常执行不受影响。
- **Gemini Edit 工具结果显示真实 diff**：之前 Gemini 编辑文件后结果栏只显示"Tool executed"，现在正确提取并展示 unified-diff 格式的修改内容。
- **Gemini Read / Grep / Glob 工具结果文案优化**：这些工具的输出由 Gemini 内部消化不对外暴露，之前统一显示"Tool executed"容易误解，现在显示更准确的提示。
- **外部 Runtime 工具调用行在执行中也可展开**：之前工具输入为空时（如 Read），执行期间工具行无法展开、没有箭头，现在执行中即可交互查看。
- **后台任务完成状态显示在正确位置**：之前后台任务完成后状态可能渲染到错误的聊天位置，根因是内部 ID 不匹配，已修复。
- **安全加固**：工作区指令注入增加 symlink 拒绝、文件大小限额、递归深度限制；后台任务状态池增加 LRU 淘汰防内存泄漏；配置变更重启原因可追溯。

---

## [0.1.67] - 2026-04-16

### Added
- **内置 cuse 电脑操作 MCP(macOS / Windows)**:开箱即用的桌面操作工具,让 AI 能直接帮你点鼠标、打字、截屏、在应用之间切换,不再需要手动装任何命令行工具或配置 MCP。首次使用时 macOS 会弹窗申请屏幕录制、辅助功能、Apple Events 权限,授权一次以后持久生效。Linux 暂不支持(工具列表里会自动隐藏)。
- **切到 Gemini / Claude Code / Codex 也能用定时任务、发图、生成图表卡片**:之前这三项能力是 MyAgents 内置 Runtime 专属,换到外部 Runtime 后就丢了。现在这些 Runtime 也可以创建心跳循环、让 Bot 发图片 / 视频 / 音频、生成可交互的数据图表卡片 —— 和内置 Runtime 体验一致,无缝切换。
- **AI 回答中断时显示原因和行动按钮**:之前 AI "突然停了" 只能干瞪眼。现在会显示具体原因,比如:
  - 对话轮数达上限 → 黄色提示条 + 「新开会话」按钮
  - 上下文装不下了 → 红色提示条 + 说明
  - 图片解析失败 / 模型报错 → 具体错误信息
  - 正常结束或你主动点停止 → 不打扰
- **定时任务支持超长 prompt 从文件读入**:如果你的心跳循环 prompt 很长(几千字起跳),之前只能挤在一行参数里,现在可以写到一个文件里用 `myagents cron add --prompt-file <path>` 传入,体验参考 `git commit -F`。

### Fixed
- **macOS 点 X 按钮关不掉窗口**:最近几个版本在 macOS 上点窗口左上角的 X 按钮,窗口不会关闭(无论"最小化到托盘"是否开启)。有循环任务时弹出的退出确认框,点"退出"也没反应。本版本修复 —— 之前只能靠 Cmd+Q 或托盘"退出"菜单来关。
- **Claude Code 订阅登录被项目里的 .env 文件破坏**:如果你订阅模式登录了 Claude Code,但打开的项目目录里有 `.env` 文件且含 `ANTHROPIC_API_KEY=sk-ant-your-anthropic-key-here` 这类占位符(比如从 `.env.example` 拷贝出来忘了改),之前会收到"Not logged in · Please run /login"报错。现在会正确忽略这些占位符,你的 Keychain 登录状态不再被破坏。
- **Windows 中文显示为宋体**:中文版 Windows 上,工具调用结果、文件搜索、部分正文区域中文会显示为宋体(SimSun/NSimSun)而非微软雅黑,观感粗糙。根因是字体链里一个容易踩的陷阱,现已修复为正确使用 Microsoft YaHei / YaHei UI。
- **"回复被中断"横幅不再无意义打扰**:之前用户主动点停止、切换 Runtime、配置变更等场景会误触发黄色提示条,现已正确识别这些预期行为不再打扰,但会记录到统一日志便于事后排查。
- **安全加固:发图工具的路径校验**:IM Bot 发图 / 视频 / 音频时对文件路径做了严格的白名单 + symlink 真实路径校验,防御通过 symlink 泄露敏感文件(如 `~/.ssh/id_rsa`)的风险。

---

## [0.1.66] - 2026-04-15

### Added
- **Gemini CLI 加入 Agent Runtime 阵容**:在原有的内置、Claude Code、Codex 之外,新增 Google Gemini CLI 作为第四个可选运行环境。只要你本机装好 `gemini` 并登录过,设置里一键切过去就能用 —— MyAgents 完全不管 API Key / OAuth,你原来怎么登录的还是怎么用。
  - 支持 Gemini 3.1 Pro、Gemini 3 Flash、Gemini 2.5 Pro 等**当前账户可用的全部模型**,Settings 下拉列表是实时从 Gemini CLI 读出来的,不用手动维护
  - 工具调用(Shell / Read / Edit / Grep / Glob / WebFetch / WebSearch)、思考过程、Token 用量都正常显示,和 Claude Code / Codex 一致
  - 工具 badge 展示 Gemini 的**原始工具名**(比如 `run_shell_command`、`grep_search`),点开看到命令/参数/输出的完整细节,不再是干巴巴的 "Run command"
  - 桌面 Chat、定时任务、IM Bot(微信 / 飞书 / 钉钉 / Telegram) 三条路径全部打通,切换到 Gemini 后所有入口都用它
- **从 GitHub URL 安装技能**:Skills 设置页新增"从 URL 导入"入口,粘贴任意 GitHub 仓库或 npm 包地址就能把对方写好的 Skill 拉到你本地。内置 AI 助手 MA 也能通过 `npx` 等命令直接帮你装技能。
- **聊天内文本查找 (⌘F / Ctrl+F)**:在对话里按快捷键唤起顶部查找栏,高亮所有匹配、方向键切换、回车跳转。作用域仅限当前已加载的消息,全历史搜索仍然用 ⌘K。

### Changed
- **Agent 身份提示现在真实反映当前 Runtime**:AI 回答"你在哪运行?"时会正确说"MyAgents + Gemini CLI / Claude Code / Codex / 内置 SDK",而不是一律说"基于 Claude Agent SDK"。换 Runtime 后立刻生效。
- **Claude Agent SDK 升级至 0.2.107**:跟进上游修复与稳定性改进。

### Fixed
- **切换 Agent Runtime 后微信 Bot 自动开新对话 + 提示**:当你在 Settings 里把 Agent 的 Runtime 换了(比如 Codex → Gemini),下一条 IM 消息会自动检测并创建一条新对话,微信里会收到 "🔁 运行环境已切换为 XXX,已自动创建新对话 (xxxxxxxx)" 提示,旧历史仍然保留在会话记录里可以翻回来。之前会出现"换了 Runtime 但 Bot 还在用老的"的情况,现在不会了。
- **切回 Claude Code 时微信 Bot 不再报 "Please run /login"**:修复了 CC CLI 在 IM 场景下的一个启动参数导致 OAuth 登录状态被忽略的问题。现在只要你在本机 `claude /login` 登录过,所有入口(Tab / 微信 / 飞书 / Cron)都能正常用。
- **恢复历史 Gemini 会话不再出现"回答复读一次"**:之前加载旧 Gemini 对话会把上一轮的回复当作新消息再显示一次,现已正确识别并过滤回放事件。
- **Gemini 会话空闲超时的吓人报错不再弹**:当 Gemini 进程在两轮对话间被系统回收内存时,不再向用户显示"Gemini process exited with code 137"红色错误,下一条消息会自动无感恢复。
- **权限模式和默认模型显示与实际一致**:之前用 Gemini 时权限下拉栏经常显示 "Default" 但实际跑的是别的模式,现在 UI 和后台统一。切换 Runtime 时持久化的旧值会自动校正到新 Runtime 合法的选项。
- **安装 Skill 的一些边角问题**:修复了从 URL 安装时的 SSRF 风险、部分失败后残留文件、超大 YAML 导致卡住等问题。
- **终端侧栏错误横幅不会被消息完成覆盖**:Agent 报错后的警示条在后续消息写入时仍然保留。

---

## [0.1.65] - 2026-04-14

### Added
- **全文搜索**：⌘F 唤起全局搜索，一次性检索所有历史会话和工作区文件，中文分词支持，长期积累的对话和代码随用随找

### Improved
- **告别长会话/多窗口卡顿**：专门针对"开多个 Tab 跑任务 + 任务完成回来点击"的日常场景做了深度优化，典型的几秒 UI 冻结场景现在都是毫秒级响应
  - 打开含大量截图的历史会话秒开，不再需要等服务端把图片塞进响应体
  - 切换到超长会话（数百条消息）不再卡顿，首屏只加载最近内容，向上滚动按需补齐更早的历史
  - 后台定时任务完成后回到前台，新消息增量追加而不是整段重载，点击立即响应
  - 多窗口同时流式输出时主界面保持流畅

### Fixed
- **打开旧会话不再"闪一下就空白"**：打开某些早期会话时，历史会显示一两秒后又变空白的情况彻底消失，即使底层会话上下文无法恢复，你看到的 14 条/28 条历史也会稳定保留在界面上
- **活跃工作区打开历史会话不再频繁访问后端**：工作区里有 tsc/vite 等后台写文件时，打开一个静态历史会话不再每秒反复刷文件路径检测接口
- **IM Bot 工具调用不再卡住**：IM 场景下 AI 调用工具不再因为没人点权限确认而永久等待，Bot 会自动信任工具并持续响应
- **外部 Runtime 的启动页发送按钮**：使用 Claude Code CLI / Codex CLI 时，启动页发送按钮不再意外置灰
- **代理配置界面不再反复刷新**：填入相对路径代理 URL 时会正确提示而不是触发界面连锁重渲染
- **内嵌浏览器打开失败静默问题**：AI 回复里的链接无法在内嵌浏览器打开时，会明确提示原因而不是无反应
- **Markdown 链接点击稳定性**：链接点击路径的渲染稳定性补齐，点击长对话里的链接不再偶发掉字

---

## [0.1.64] - 2026-04-11

### Improved
- **工作区文件树更稳定**：文件/文件夹拖拽移动保留原有交互体验，并解决多窗口或多标签场景下的界面渲染错误
- **IM Bot 外部 Runtime 体验对齐**：使用 Codex 或 Claude Code CLI 时，Bot 会按当前 Runtime 的模型与权限运行，不再混用内置供应商配置
- **IM Bot 模型与权限指令优化**：`/provider` 会清晰说明当前 Runtime 的供应商管理方式，`/model` 和 `/mode` 可用于查看或切换当前 Runtime 支持的选项
- **日志体积优化**：流式输出和长内容日志更紧凑，排查问题时能保留关键信息并减少冗余刷屏

### Fixed
- **Codex Bot 模型串线**：工作区切到 Codex 后，微信等 IM Bot 不会再把内置模型传给 Codex 导致请求失败
- **外部 Runtime 后台任务一致性**：Codex 与 Claude Code CLI 在 IM、心跳和定时任务入口下会使用一致的 Runtime 配置与权限策略
- **任务列表刷新一致性**：最近任务和后台任务状态刷新更稳定，降低任务状态与实际会话不一致的情况

---

## [0.1.63] - 2026-04-10

### Improved
- **Codex 工具结果展示**：使用 Codex Runtime 时，Bash/编辑/搜索等工具调用现在会显示更完整的过程与结果，命令输出阅读体验更接近终端
- **Bash 卡片样式统一**：外部 Runtime 的 Bash 工具输入和输出统一为终端样式，查看命令与结果更直观

### Fixed
- **Claude 切换提示修正**：切换模型时的“需新开会话”提示只会在真正需要的 Anthropic 会话场景出现，不再在 Anthropic/OpenAI 兼容协议之间误弹
- **Claude 历史签名保护补齐**：切换到受签名历史约束的 Claude 会话时，桌面端、Channel 等不同入口现在都会一致地安全处理历史记录
- **最近任务恢复空白**：使用 Codex 或 Claude Code CLI 时，AI 在后台继续执行期间从最近任务重新打开会话，不会再先看到空白页
- **Codex 首条短回复不再丢失**：Codex 返回很短的文本回复时，聊天页不会再出现消息已保存但界面显示空白的情况

---

## [0.1.62] - 2026-04-10

### Added
- **日志面板搜索**：⌘F 打开搜索，关键词高亮 + 上下跳转，快速定位问题日志

### Improved
- **外部 Runtime 日志诊断**：Claude Code CLI 和 Codex CLI 的日志增加完整参数（模型、工具、token 用量等），排查问题不再需要猜测
- **Runtime 切换稳定性**：切换 Runtime 后旧会话不再错误尝试恢复，已有会话始终使用创建时的 Runtime

### Fixed
- **短回复空白问题**：使用 Claude Code CLI 时，AI 简短回复（如数学计算）偶尔显示空白，现已修复
- **Windows 频繁崩溃**：Windows 用户编辑配置文件后应用反复崩溃（UTF-8 BOM 导致），现已自动兼容
- **外部 Runtime 默认模型**：模型选择器显示的默认模型（如 gpt-5.4）未实际传递给 Runtime，现已修复
- **macOS 外部 CLI 检测**：从 Finder 启动时，NVM/fnm 安装的 claude/codex CLI 检测不到，现已修复

### Security
- **路径遍历防护**：工作区文件读写接口增加路径验证，阻止访问系统敏感目录
- **XSS 防护加强**：AI 回复中的 HTML 预览使用 DOMParser 替代正则清理，Mermaid 图表启用 strict 安全模式
- **OAuth 安全**：Token 端点强制 HTTPS（localhost 除外），撤销授权时尝试服务端 token 撤销

---

## [0.1.61] - 2026-04-09

### Added
- **外部 Runtime 图片支持**：使用 Claude Code CLI 或 Codex CLI 时，现在可以发送图片给 AI，不再提示"没有附带图片"
- **三方供应商工具截图保存**：使用 DeepSeek/Gemini 等三方供应商时，MCP 工具返回的截图/图片不再丢失，自动保存到工作区并告知 AI 路径

### Improved
- **AI 回复排版优化**：Markdown 渲染全面对齐设计规范 — 标题行高、段落间距、代码配色、表格样式、有序列表序号，长文阅读更舒适
- **工作区文件目录统一**：Gemini 生成图片、TTS 音频、工具截图等所有 AI 生成的文件统一放在 `myagents_files/` 目录下，不再散落在多个顶级目录
- **错误提示优化**：API 临时异常（限流/重试）不再弹出红色错误横幅，只有真正失败时才提示

### Fixed
- **切换 Runtime 后无限弹窗**：切换到 Claude Code/Codex Runtime 后发送消息，反复弹出"此会话由其他 Runtime 创建"对话框并不断开新 Tab
- **外部 Runtime 检测失败**：从 Finder 启动应用时，因系统 PATH 缺少 Homebrew 路径导致检测不到已安装的 Claude Code CLI 和 Codex CLI
- **Markdown HTML 安全加固**：AI 回复中的 raw HTML 现在经过清理过滤，防止潜在的脚本注入风险

---

## [0.1.60] - 2026-04-07

### Added
- **多 Agent Runtime 支持（实验室）**：除内置 Claude Agent SDK 外，可接入 Claude Code CLI 和 OpenAI Codex 作为 AI 运行时。在「关于 → 实验室」中开启后，每个工作区可独立选择 Runtime
- **MCP OAuth 认证**：MCP 工具支持 OAuth 授权流程，设置页自动检测需要认证的工具并引导完成授权

### Improved
- **自定义供应商模型输入**：添加模型时新增「+」按钮，除回车外多一种添加方式
- **子 Agent 设置面板**：模型和权限选择器改为自定义下拉框，Skills 输入支持从可用列表选择
- **启动页 Runtime 适配**：工作区配置了外部 Runtime 时，启动页输入栏自动显示对应 Runtime 的模型和权限选项
- **三方供应商切换保护**：从三方供应商切换到 Anthropic 原生时，弹窗确认并新开 Tab，避免历史消息不兼容

### Fixed
- **AI 思考状态卡住**：AI 思考指示器可能卡住数十分钟不消失（实际后台已完成）。修复了子 Agent 思考块未正确关闭、turn 边界遗漏清理等多个根因
- **QR 登录空白页**：OpenClaw 插件扫码登录时，wizard 步骤冲突导致页面空白
- **三方供应商思考签名污染**：使用 Gemini 等思考模型时，签名字段污染 SDK 历史导致后续请求报错

---

## [0.1.59] - 2026-04-04

### Added
- **内嵌浏览器**：Chat 分屏新增网页预览面板，AI 消息中的链接和 HTML 文件优先在应用内打开。支持前进/后退/刷新、地址栏编辑导航、在系统浏览器中打开
- **HTML 实时预览**：点击工作区 .html 文件直接渲染预览，工具栏一键切换「编辑源码 ↔ 网页预览」，编辑自动保存后预览同步刷新
- **模型管理面板**：供应商设置新增统一模型管理入口，支持从 API 自动发现可用模型、设置首选模型、删除/添加模型
- **工作区使用指南**：支持 INTRODUCTION.md 文件，新建对话时自动展示 Agent 使用说明
- **群聊智能回复**：群聊消息注入发送者、时间戳、@提及标记，AI 能区分多人对话并按需回复
- **文件树拖拽分栏**：工作区文件树与 Agent 能力面板支持上下拖拽调整比例

### Improved
- **Cmd+W 层级关闭**：关闭快捷键按层级递进（弹窗 → 分屏面板 → 标签页 → 启动页），不再意外退出程序
- **弹窗交互优化**：所有弹窗遮罩层改用 mouseDown 关闭，防止选中文字拖拽到外部时意外关闭面板
- **后台任务通知**：后台任务完成后在对话中插入状态卡片，消除 AI "自说自话" 的困惑感
- **Permission Mode 同步**：Plan 模式等权限切换在前后端实时同步，UI 开关始终反映实际状态

### Fixed
- **MCP 工具卡死**：停止响应后 MCP 工具可能挂起长达 10 分钟。现在 3 秒内强制终止
- **飞书群聊消息路由错误**：群聊回复发送到私聊、群消息被策略拦截、群组自动发现重复等系列问题
- **MCP 配置加载崩溃**：config.json 中数组字段类型异常时不再报 TypeError
- **OpenClaw 通道名称**：Bot 显示名改用 Agent 名称替代 npm 包名
- **Thinking 计时器泄漏**：历史消息的思考时间指示器不再永久运行

---

## [0.1.58] - 2026-04-02

### Fixed
- **飞书 Bot 不回复**：飞书 Bot 收到消息后无任何回复，由上一版修复企微时引入的回归问题导致
- **Windows 更新失败**：更新或卸载时因 node.exe 文件锁导致安装器报错

---

## [0.1.57] - 2026-04-02

### Added
- **内嵌终端**：Chat 页面右侧新增分屏终端，无需切换窗口即可执行命令。支持日间/夜间主题自动切换、Tab 切换时状态保持、Shell 退出自动清理
- **代码编辑**：文件预览支持直接编辑并自动保存，体验接近 VSCode
- **企业微信 Bot**：新增企业微信渠道，支持扫码和手动配置两种创建方式
- **更新进度可视化**：应用更新下载时显示进度百分比和进度条
- **快速求助**：AI 出错时，错误横幅新增「召唤小助理」按钮，一键跳转诊断

### Improved
- **文件预览升级**：预览器从 react-syntax-highlighter 升级至 Monaco Editor，语法高亮更准确，大文件性能更好
- **交互反馈**：所有按钮和列表项点击时统一添加了微缩反馈动效

### Fixed
- **应用冻结**：快速切换 Tab 时可能触发端口竞态导致应用卡死最长 5 分钟
- **MCP 工具崩溃**：添加与 SDK 保留名同名的 MCP 工具（如 computer-use）会导致 session 反复崩溃重启
- **代理环境联网**：使用系统代理时 MCP 子进程无法访问网络
- **供应商验证**：硅基流动等供应商验证超时或报 400 错误
- **企微插件崩溃**：企业微信插件因 runtime 上下文缺失导致消息收发失败
- **SSE 重连重复**：重连后 AI 思考过程内容重复显示
- **Windows 终端无法使用**：内嵌终端在 Windows 上降级到 cmd.exe，所有 Unix 风格命令（ls/pwd/clear 等）均无效。修复 shell 检测链加入 PowerShell 5.1（Windows 自带）
- **终端中文字体**：终端字体栈缺少中文字体，Windows 中文显示为宋体。补充 PingFang SC / Microsoft YaHei
- **终端标题 Windows 路径**：标题栏路径分割未处理反斜杠，Windows 下显示为 `~/C:\full\path`

---

## [0.1.56] - 2026-03-30

### Added
- **分屏文件预览**：点击工作区文件在右侧分屏打开预览（支持代码高亮、Markdown 渲染、编辑），默认开启，可在设置中关闭
- **目录树吸顶**：深度浏览文件时，父目录固定在顶部显示（最多 3 层），点击可收起
- **工作区悬浮模式**：窄屏或分屏时，工作区文件列表变为右侧悬浮抽屉，不再挤压对话区域

### Improved
- **停止按钮响应提速**：从最慢 25 秒缩短到 5 秒，MCP 工具卡死时也能可靠终止
- **飞书插件工具完整性**：修复 OAuth 授权失败导致 19/34 个工具被静默过滤的问题
- **全屏预览加宽**：文件预览弹窗显示面积增大，减少两侧空白
- **右上角入口**：「反馈」改为「小助理」，更贴合产品定位

### Fixed
- **MCP 工具调用永久挂起**：Playwright 等 MCP 工具无响应时，10 分钟后自动终止并提示用户重试，Stop 按钮也能可靠恢复会话
- **第三方供应商报错**：硅基流动等 Anthropic 协议供应商因 thinking 参数不兼容导致 400 错误

---

## [0.1.55] - 2026-03-29

### Added
- **Generative UI**：AI 可以在对话中生成交互式可视化组件（图表、表单、仪表盘等），支持流式渲染，对话即应用
- **MCP 工具名称优化**：工具列表显示来源 MCP 服务名称和彩色图标，一眼区分工具归属

### Improved
- **Widget 渲染体验**：骨架屏 shimmer 动画 + 基于实际高度的智能展开，消除加载跳动
- **定时任务管理**：Agent 设置页只显示活跃任务并按时间倒序；Launcher 点击执行历史可直接跳转到对应对话

### Fixed
- **对话历史丢失**：Rewind（时间回溯）后产生的新对话不会出现在历史列表，即使手动命名也找不到。同时加固了历史索引文件的写入安全性，防止异常中断导致数据丢失
- **应用启动闪断**：Windows 上启动时健康检查过于激进，误判正在初始化的后台服务为异常并强制重启，导致短暂的功能不可用

---

## [0.1.54] - 2026-03-28

### Added
- **定时任务结果投递到 IM**：桌面端创建的定时任务执行完成后，可将结果自动发送到飞书、微信等 IM 渠道，不再需要打开客户端查看
- **无限循环任务**：新增 Ralph Loop 模式 — 任务完成后自动触发下一次执行，失败时自动退避等待，适合需要持续运行的场景
- **文本选中操作**：选中 AI 回复中的文字，弹出「引用」和「深入讲讲」快捷操作
- **对话导出**：历史记录中支持将任意对话导出为 Markdown 文件
- **IM 即时反馈**：IM Bot 收到消息后立即显示「思考中…」提示，用户不再面对长时间的空白等待
- **系统消息标记**：对话中来自定时任务和心跳的系统消息会显示来源标签，便于区分
- **超长消息折叠**：过长的用户消息自动折叠，点击即可展开查看完整内容

### Improved
- **Claude Agent SDK 升级至 0.2.84**
- **网络代理**：未配置代理时自动继承系统网络设置（如 Clash 全局代理），不再强制直连
- **目录树刷新**：文件变化实时推送更新，不再依赖 2 分钟轮询
- **MCP 环境变量**：支持同时填写变量名和值后一步添加，增加重复检测
- **OpenClaw 插件兼容**：全量覆盖 SDK 154 个子模块，社区插件不再因缺少模块而崩溃

### Fixed
- **时间回溯失败后 UI 不回滚**：后端回溯失败时前端消息列表恢复到回溯前状态
- **新建 IM Bot 报「模型不可用」**：首次启动时缺少默认供应商配置
- **Agent 页面定时任务不显示**：桌面端创建的任务在 Agent 设置页无法看到
- **MCP 工具配置错误导致全部 MCP 不可用**：单个 MCP 配置出错不再影响其他工具
- **AI 不知道当前时间**：系统提示词引导 AI 主动获取时间信息

---

## [0.1.53] - 2026-03-26

### Added
- **三方供应商子 Agent 模型别名映射**：通过 `ANTHROPIC_DEFAULT_SONNET/OPUS/HAIKU_MODEL` 环境变量 + OpenAI Bridge `modelMapping`，子 Agent 指定 `model: "sonnet"` 时自动映射到供应商模型（如 `deepseek-chat`），不再发送 raw `claude-*` 导致卡住
- **OpenClaw plugin shim 升级至 3.22 兼容级别**：新增 `channel-config-schema`、`channel-contract`、`command-auth`、`core`、`infra-runtime`、`plugin-entry`、`text-runtime` 7 个 shim 模块，解决微信插件 v2.0.1 启动 crash
- **SSE Last-Value Cache**：新客户端连接 SSE 时立即 replay 缓存的 `chat:status`，Tab 中途接入 IM 运行中的 session 不再短暂闪过 idle 状态
- **Boot Banner**：应用启动和 Sidecar 创建时输出 `[boot]` 单行自检信息（版本/OS/Provider/MCP/Agent/Cron 数量），`grep '[boot]'` 即可获取完整环境
- **`system_binary` 模块**：集中系统工具查找（taskkill/pgrep/wmic），pit-of-success 模式

### Improved
- **统一日志降噪**：SSE 流式事件静默、Health Check 静默、HTTP 路由高频路径静默、SDK message 去重（摘要替代完整 JSON）、bun-out 彻底去重（Bun logger 初始化后停止 stdout 捕获），日志信噪比从 36% → ~85%
- **插件刷新并行**：多个 Bot 刷新按钮可同时点击，互不影响
- **供应商设置 UI**：`maxOutputTokensParamName` 改用 Select 下拉；原生 select 替换为 CustomSelect 统一设计系统

### Fixed
- **Rewind 死锁**：`forceAbortCurrentTurnAndRecover` 不再 eager pre-warm，消除 `await sessionTerminationPromise` 永久阻塞；所有 6 处 await 加 10 秒超时兜底
- **Rewind 失忆**：`startStreamingSession` 的 `currentSessionUuids.clear()` 改为仅非 resume session 执行，关闭 Tab 重开后 rewind 保留上下文
- **IM Bot / Cron "Not logged in"**：pit-of-success 架构修复，订阅模式 Sidecar 不再误注入三方 Provider 环境
- **自定义供应商 modelAliases 默认值**：无配置时自动用 `primaryModel` 兜底
- **旧版内置飞书入口隐藏**：聊天机器人 Bot 页面移除旧版飞书卡片（已被 OpenClaw 官方插件替代）
- **插件更新 icon 闪烁**：刷新时保持平台 icon 不变，仅首次安装显示 loading
- **Agent 工具样式**：复用 Task 子 Agent 样式，显示 `subagent_type` + `description`

---

## [0.1.52] - 2026-03-24

### Added
- **OpenAI Bridge `maxOutputTokensParamName` 配置**：用户可选 `max_tokens`（默认，兼容 DeepSeek/Qwen 等）、`max_completion_tokens`（OpenAI o1/o3/GPT-5、vLLM）、`max_output_tokens`（Responses API），UI 改为接口格式 + key-value 联动形式
- **Bridge `supports_edit` 能力自适应**：从 Plugin `/capabilities` 接口读取 `edit` 能力，不支持编辑的插件（如微信）自动跳过 draft+edit 流程，一次性发送完整消息
- **单实例 PID lock file**：`~/.myagents/app.lock` 防止 macOS 自动重启导致生产版与 debug 版双实例冲突
- **`app_dirs` 模块**：集中管理数据目录路径 `myagents_data_dir()`，预留未来 dev/prod 隔离扩展点

### Fixed
- **OpenAI Bridge 兼容性**：不再默认转发 `max_tokens`/`temperature`/`top_p`/`stop`，解决 OpenAI 推理模型（o1/o3/GPT-5）返回 400 的问题
- **微信 Bot 长文丢失**：finalize 检测到 501 时发送完整消息替代静默丢弃，用户不再只看到前 50 字符
- **Session Sidecar SSE 自动恢复**：系统休眠/crash 后 Tab 不再永久 loading
- **定时任务"仅一次"模式显示错误**：StatusBar/Overlay 未读 schedule 字段导致显示为"每 30 分钟"
- **飞书 Bot 输出中断**：`capabilities.edit` 从 `editMessage` 函数存在性推导，飞书不再被误判为不支持编辑
- **时间回溯丢失 Session 上下文**：从磁盘消息种子填充 `currentSessionUuids`，pre-warm 窗口期 rewind 不再创建空 session

---

## [0.1.51] - 2026-03-24

### Added
- **MCP OAuth 规范完整实现**：零配置授权 + Token 生命周期管理（发现、注册、PKCE 授权、刷新、撤销），支持 OAuth 2.1 保护的远程 MCP Server
- **浏览器并发隔离**：Playwright isolated 模式 + storage-state 持久化，多 Session 独立 cookie/登录态
- **CLI 模式**：Tauri 二进制支持 CLI 参数（`myagents --help/status/mcp/model/cron/plugin`），修复 Issue #43 所有子命令无输出
- **Admin API 完整性补齐**：定时任务（cron）8 个路由、OpenClaw 插件管理 3 个路由、Agent 运行时状态、版本信息——CLI 管理通道与 GUI 对等覆盖
- **SDK shim 全面补齐**：openclaw plugin-sdk 从 5 个 → 16 个 shim 模块，覆盖 lark 插件新版所有依赖
- **浏览器模式选择器**：Playwright 设置面板支持 isolated/persistent 模式切换 + cookie 管理 UI

### Improved
- **Helper 小助理元认知升级**：CLAUDE.md 新增管理通道架构图、CLI 能力域表格、配置修改用 CLI 原则；self-config/support skill 触发优化
- **插件安装 UI**：Bot 图标安装时保持稳定（半透明 + 叠加 spinner），不再整个替换为 loading

### Fixed
- **微信 Bot 短消息重复发送**：Bridge finalize_message 对 501 Not Implemented 的 fallback 重发问题，改为结构化 status code 匹配
- **插件 restart 卡住 3 分钟**：heartbeat 持 router 锁调 ensure_sidecar 阻塞 shutdown，改为 abort() 立即释放锁
- **飞书插件启动失败**：SDK shim 缺 channel-status + tool-send 等模块 + exports 白名单未注册
- **飞书群聊历史丢失**：reply-history shim 的 buildPendingHistoryContextFromMap 未正确委托，recordPendingHistoryEntry 未读 params.entry
- **Intel Mac Node.js 架构不匹配**：构建脚本按目标架构下载对应 Node.js
- **MCP OAuth 安全修复**：TOCTOU 竞态、dead code、缓存一致性、并行刷新 token
- **bridge-tools 误报 ERROR**：微信等不提供 MCP 工具的插件，日志从 warn 降为 log
- **ADMIN_AGENT_VERSION 未 bump**：新增禁止规则——修改 helper 后必须 bump 版本

---

## [0.1.50] - 2026-03-23

### Added
- **Session Sidecar 健康监控**：15 秒间隔检测死掉的 Session Sidecar（Tab/Cron/IM），自动重启并保留 owner 关联，recovery queue 机制确保重启失败后不丢失跟踪
- **Agent Channel 健康监控**：30 秒间隔检测 Error/Stopped 的 IM Bot Channel，自动从磁盘配置重建，支持指数退避（30s→300s）和 orphaned channel 重试
- **IM 发送诊断日志**：Bridge adapter 4 个发送函数 + stream_to_im 全链路约 50 处静默 `let _ =` 改为带上下文的 `ulog_warn` 日志
- **QR 登录状态展示**：Channel 详情页 QR 区域在已登录时显示绿点 + accountId + "重新扫码"按钮

### Fixed
- **微信 QR 重新登录后消息不回复**：sendText/sendMedia 闭包捕获了 loadPlugin() 时的局部 `account` 变量，QR 重登录更新 `currentAccount` 后闭包仍用旧 token，改为引用模块级 `currentAccount`
- **微信图标**：替换手绘 SVG 为真实微信 App 圆角矩形 PNG 图标

---

## [0.1.49] - 2026-03-23

### Added
- **AgentConfig 通用化架构**：每个工作区自动创建 basicAgent，AgentConfig 成为 model/provider/permissionMode/MCP 的单一数据源，Tab 输入栏与 Agent 设置面板双向同步
- **Plugin Bridge 附件传递**：支持图片/文件/语音/视频在 IM 和 AI 之间双向传递
- **Self-Config CLI**：内置 `myagents` CLI 让 AI Agent 通过 Bash 自主配置 MCP/Model/Agent
- **QR 扫码登录**：Channel 详情页支持 QR 扫码登录（微信等 OpenClaw 插件）
- **Cron 跨 Channel 投递**：桌面端创建的定时任务可发送结果到 IM Channel
- **Sidecar 自解析架构**：消除 IM Bot 对物化视图的依赖，Sidecar 启动时自行解析 AgentConfig
- **运行时 fallback 链**：Bun/Node.js 每个场景增加系统级兜底
- **微信 OpenClaw 插件支持**：npmSpec 清洗 + SDK shim 补全 + QR 扫码登录

### Improved
- **Claude Agent SDK 升级**：0.2.45 → 0.2.80，适配新功能
- **Node.js 运行时优先级翻转**：系统 Node.js 优先（用户维护、npm 更可靠），内置兜底
- **Helper 小助手增强**：self-config Skill 自动同步 + 行动优先原则 + description 精准化
- **model add/remove**：支持通过 CLI 添加/删除自定义模型供应商 + 完整 mcp test/model verify

### Fixed
- **删除当前 session 后断联**：resetSession 不再清空 sessionId，避免 Tab 与 Sidecar 失联
- **安全修复（cross-review）**：路径穿越 + 原型污染 + CLI flag 泄漏 + 6 项安全修复
- **IM Bot 供应商被 Heartbeat 重置**：4 项 provider 迁移修复
- **心跳误报 + 错误螺旋**：HEARTBEAT_OK 误报 + 连续失败后 IM 暂停通知
- **Rewind/Fork 修复**：UUID 校验 + JSONL 持久化不同步 + fork UUID 校验误判
- **QR 登录全链路修复**：sessionKey 透传、CSP 图片策略、超时自动重试、凭证持久化
- **Plugin Bridge 协议对齐**：gateway context 补全 + isConfigured 签名修正 + MIME 类型处理
- **工作区卡片 channel tag**：统一短名称显示，与最近任务一致
- **SDK 0.2.80 兼容**：exports 限制导致 cli.js 解析失败
- **飞书用户名**：优先 nickname 显示

### Security
- 路径穿越防护、原型污染防护、CLI flag 泄漏修复

### Hotfix
- **微信 Bot 回复丢失**：stub dispatcher 空函数被误判为真实协议回调 + mid-turn injection 时 imCallbackNulledDuringTurn 未重置导致 SSE 事件被过滤（Windows 特有时序触发）
- **Channel 崩溃后无法重启**：Bridge 进程死亡后 channel 条目未从 HashMap 移除，dedup 检查误判为 "already running"，Error/Stopped 状态现允许重启
- **微信向导多余 BIND 口令**：QR 登录插件不再显示 BindCodePanel，替换为"扫码即可使用"提示
- **Channel 详情页已绑定用户为空**：QR 登录 dmPolicy=open 不需要白名单，UI 对齐

---

## [0.1.46] - 2026-03-20

### Improved
- **插件安装兼容性**：OpenClaw 插件安装从 Bun 切换到内置 Node.js (npm)，解决 Windows 上部分 npm 包安装失败的问题。Bun 保留为 fallback
- **内置 Node.js 升级**：v22.16.0 → v24.14.0 (最新 LTS)，支持要求 node >=24 的 npm 包
- **智能起名 prompt**：增加显式生成指令，防止模型输出元指令（如"对话标题应该是什么"）作为标题

### Fixed
- **Fork 按钮流式不可见**：assistant 消息的 sdkUuid 未通过 SSE 广播到前端，且 `chat:message-sdk-uuid` 事件未注册 SSE 白名单导致前端静默丢弃。通过 message-complete 事件捎带 sdkUuid 绕过前后端消息 ID 不匹配
- **npm postinstall 失败**：插件安装时 npm 子进程的 PATH 未包含内置 Node.js 目录，导致 postinstall 脚本 `node: command not found`
- **Settings 页面 macOS 无法滚动**：flex 行布局中右侧内容区缺少显式高度声明，WebKit 不触发 overflow 滚动
- **proxy 注入逻辑重复**：提取 `apply_proxy_env()` 共享函数，bridge spawn 和 npm install 统一使用

---

## [0.1.45] - 2026-03-20

### Added
- **Session Fork（会话分支）**：从任意助手消息创建会话分支，类似 git branch，在已有对话的任意节点分叉出新方向，原对话不受影响
- **消息列表虚拟化**：使用 react-virtuoso 替代平铺渲染，支持上百轮长对话不卡顿，自动跟踪滚动 + 用户滚离底部自动停止跟踪
- **SOCKS5 代理支持**：自动检测 socks5:// 代理并启动 HTTP-to-SOCKS5 bridge，解决 Bun/Node.js 不原生支持 SOCKS5 的问题
- **MCP OAuth 2.0 授权**：支持需要 OAuth 授权的 MCP Server，自动发现、授权码流程（含 PKCE）、Token 持久化与自动刷新
- **Bridge 群聊完整支持**：飞书插件群聊元数据透传、群名显示、引用回复、群系统提示注入，群聊体验与私聊对齐
- **Tool Result 展示优化**：Bash 输出终端风格渲染、JSON 自动解析高亮、Read/Grep/Glob 结果结构化展示、超长内容限高可展开

### Improved
- **智能起名准确度**：从 1 轮对话就起名改为 3 轮对话后触发，基于多轮上下文提炼主题，禁止摘抄原文，标题更准确。1-2 轮对话显示用户消息截取
- **预设供应商模型显示**：模型标签显示真实模型 ID（如 `kimi-k2.5`）而非友好名（Kimi K2.5），避免用户填错模型名
- **超长图片处理**：统一 1568px 阈值，超长图按 1:2 比例切片上传，图片处理失败时通知用户而非静默丢弃

### Fixed
- **自主操作权限**：Heartbeat、定时任务、记忆更新统一使用 fullAgency 权限，不再因无人审批导致 Bash 等工具 10 分钟超时后被拒绝
- **记忆更新打断用户对话**：记忆更新前检查 session 最近 15 分钟是否有用户活动，活跃的 session 推迟 15 分钟后重试
- **飞书 Bot 消息分发崩溃**：dispatch 函数缺少返回值导致解构 null 报错
- **飞书群聊 isMention 误判**：默认值从全局 true 改为按 chatType 区分（私聊 true、群聊 false）
- **群聊权限命令失败**：群内 /allow、/block 等权限命令未查询 ManagedAgents，显示 "Bot not running"
- **未配置供应商时误导**：移除默认 fallback 到 Anthropic 订阅的逻辑，避免未登录用户看到 "need to log in" 错误
- **IM 定时任务立即执行失败**：cron 工具 `run_now` 未正确路由到执行端点
- **飞书消息投递失败**：Plugin Bridge 消息发送路径修复

---

## [0.1.44] - 2026-03-18

### Added
- **双运行时架构**：内置 Node.js 运行 MCP Server / 社区 npm 包，Bun 运行 Agent Runtime / Sidecar。用户无需自行安装任何运行时。PATH 注入优先级：bundledBun → bundledNode → ~/.myagents/bin → 系统路径
- **OpenClaw 插件工具动态透传**：Bridge MCP handler 动态发现插件注册的工具，通过 im-bridge-tools 创建 SDK MCP server 透传到 AI，支持工具组过滤与 ownerOnly 权限控制
- **OpenClaw 插件斜杠命令**：Rust 层路由插件注册的 `/feishu auth`、`/feishu_diagnose` 等命令，/help 中展示并翻译为中文
- **飞书自动 OAuth 授权**：工具返回 `need_user_authorization` 时自动触发授权卡片，用户无需手动发送 `/feishu auth`

### Improved
- **飞书流式响应速度**：CardKit streaming 节流从 100ms 提升到 500ms，减少 5 倍 API 调用量，响应延迟从 15 秒降至 ≤5 秒
- **Channel 模型选择器**：增加「默认（继承 Agent）」选项，Channel 可不指定独立模型
- **Channel AI config 持久化**：写入 agentConfig.overrides，重启不丢失

### Fixed
- **飞书流式内容三倍重复**：`mergeStreamingText()` 的 append fallback 在 AI 中途切换 Markdown 格式时触发拼接，改为 `return next`（累积文本总是最新权威版本）
- **Pre-warm 竞态导致消息孤立**：`schedulePreWarm` 从 stale await 改为递归重试 + enqueueUserMessage 安全网 + interruptCurrentResponse 孤立队列清理
- **Stop 按钮 UI 卡死**：`alreadyStopped` 分支 flushSync 重置 isLoading/isStreamingRef
- **Tab 加入已完成 IM 会话时 isLoading 卡住**
- **Bridge 工具组匹配 403**：从精确 key 匹配改为前缀推断
- **OpenClaw execute 参数顺序 + 返回值格式**
- **ownerOnly fail-closed**：无白名单 = 无 owner，非 owner 调用 ownerOnly 工具被拒绝
- **群聊 mention 门控**：插件斜杠命令绕过 mention 检查（与内置 /help /model 一致）
- **macOS 构建 Node.js 二进制签名**：补充 TCC/notarization codesign
- **Memory Update toggle 尺寸**：与 Heartbeat toggle 统一

---

## [0.1.43] - 2026-03-17

### Added
- **记忆自动更新**：Agent 在夜间窗口（默认 00:00-06:00）自动对工作区内所有达标 session 执行 UPDATE_MEMORY.md 中的记忆维护指令。支持配置更新间隔（24/48/72h）、触发阈值、时间窗口。搭载心跳周期检查，tokio::spawn 独立批次任务，同 Agent 内串行、不同 Agent 间并发
- **Query Navigator**：Chat 页面右侧浮动导航器，快速跳转 session 内的用户 query。未 hover 时显示微弱横杠指示，hover 展开文字面板（backdrop-blur + 渐隐遮罩），点击平滑滚动到对应消息。IntersectionObserver 跟踪当前可视区 query
- **工作区文件读写命令**：新增 `cmd_read_workspace_file` / `cmd_write_workspace_file` Rust 命令，绕过 Tauri fs plugin scope 限制，支持任意上下文（Tab/Launcher/Settings）读写工作区文件

### Improved
- **HEARTBEAT 机制对齐**：心跳 prompt 增加 `<system-reminder>` 外层包裹、YAML frontmatter 剥离、自动创建的 HEARTBEAT.md 带 description 说明
- **夜间模式**：全量 CSS Token 化 + "暖夜"主题
- **活跃中筛选**：增加 48h 时间门控，防止遗留 IM session 永久出现在活跃列表

### Fixed
- **系统注入消息隔离**：HEARTBEAT/MEMORY_UPDATE 等系统消息不再覆盖 session 的 lastMessagePreview 和 lastActiveAt
- **OpenClaw 插件显示名**：session 列表标签优先使用 PLATFORM_DISPLAY_NAMES（"QQ"而非"QQ Bot"），与 Agent 设置保持一致
- **MCP warmup 退出码**：非 0/1 退出码一律 warmup_failed；'not found' 关键词收紧为 'package not found'/'module not found'
- **BugReportOverlay**：排除 invalid 状态的 provider
- **BlockGroup hasTextAfter 死 prop 清理**
- **Launcher patchProject 类型还原**：`Record<string, unknown>` 改回 `Partial<Omit<Project, 'id'>>`
- **SimpleChatInput provider helpers**：从 render body 提取到 module-level 纯函数
- **超长 session 加载不滚动到底部**
- **Chat header 渐变阴影暗色模式适配**
- **Agent 设置图标 dark mode 反色**
- **WebView 心跳健康监测误判**：移除（macOS App Nap 导致误判自动重载）

---

## [0.1.42] - 2026-03-16

### Added
- **定时任务能力升级**：支持独立创建定时任务（从任务中心/首页直接创建，无需先打开 Chat）、三种调度类型（固定间隔/Cron 表达式/一次性）、执行模式选择（新开对话/连续对话）、可视化调度构建器、执行历史查看
- **定时任务详情页编辑模式**：点击编辑切换为内联编辑视图，支持修改调度计划、结束条件、通知设置
- **Chat 定时面板改造**：执行模式选择 + 三种调度类型 + 新开对话路径
- **飞书官方 OpenClaw 插件接入**：CardKit Streaming、工具桥接（多维表格/日历/任务/群聊等 25 个工具）、SDK Shim 兼容层
- **Tab 状态指示器**：运行中/思考中圆点 + 自定义 tooltip + 通知点击自动跳转
- **WebView 崩溃保护**：React Error Boundary 兜底白屏崩溃

### Fixed
- **Windows 白屏死循环**：agent.channels undefined 导致 React 崩溃 → 错误边界卸载 App → cleanup 杀 sidecar → 死循环。防御性归一化 + 移除 useEffect cleanup 中的 stopAllSidecars
- **定时任务 loading 卡死**：Cron 执行改用 fullAgency 权限，避免 Bash 等工具 permission request 在无人值守时永远阻塞
- **定时任务创建后列表不刷新**：RecentTasks 传 onCreated 回调给 TaskCreateModal
- **im-cron 跨 workspace 安全漏洞**：添加 verifyTaskOwnership 校验，防止跨 session 修改/删除其他工作区的任务
- **CronTaskSettingsModal executionTarget 重置**：从 initialConfig 初始化，防止重开 modal 时静默重置
- **CronTaskDetailPanel 缺 isMountedRef guard**：4 个 async handler 添加 unmount 保护
- **无效 Cron 表达式可提交**：cron 表达式格式验证加入 errors
- **通知导航 hijack**：timeout 从 10s 缩至 2s，仅 hidden→visible 转换时消费
- **CustomSelect dropdown 滚动脱离**：添加 scroll/resize 事件监听动态更新位置
- **「允许 AI 自主结束任务」选项隐藏**：永久运行模式下也显示该选项
- **/new 后飞书 Bridge 工具丢失**：IM context（im-media/im-bridge-tools）改为 Sidecar 级别生命周期，不在 session 结束时清除
- **IM Bot provider 不同步**：patchAgentConfig 自动解析 providerEnvJson + AgentInstance 初始化补全
- **飞书插件消息处理崩溃**：compat-runtime 补全 config/logging/system 模块
- **Bridge 进程不使用代理配置**：导致飞书 API 超时
- **CardKit streaming 400 错误**：withReplyDispatcher 返回值修复
- **IM Bot idle collector 误杀长任务 sidecar**

### Changed
- **「循环」文案统一改为「定时」**
- **添加 IM Bot 选择平台隐藏内置飞书**：由官方插件版本替代
- **任务中心 tag 文案统一**：Feishu→飞书、QQ Bot→QQ，与 Agent 工作区一致

---

## [0.1.41] - 2026-03-14

### Added
- **Agent 中心架构升级**：IM Bot 中心架构全面升级为 Agent 中心架构，数据模型迁移、Rust 层重构、UI 改造三阶段完成。旧版 ImBotConfig 自动迁移为 AgentConfig，按工作区聚合、保留 bot ID 作为 channel ID
- **供应商子 Agent 模型别名映射**：解决 SDK 内置子 Agent 硬编码模型问题，支持自定义供应商模型别名
- **文件预览器增强**：空文档占位提示与编辑入口、二进制黑名单判断替代文本白名单、createPortal 修复滚动穿透
- **文件树图标 + 拖拽移动**：基于 @dnd-kit 重构，替换 HTML5 DnD
- **Launcher 主动 Agent UX 改进**：卡片展示 channel 状态标签、心跳图标、Agent 设置快捷入口

### Fixed
- **Windows 标题生成 404** (#23)：双层修复 — (1) generateSessionTitle 改用 Tab-scoped API 替代 Global Sidecar；(2) pre-warm 竞态导致 system_init 永不 replay，前端 sessionId 停留在 pending 占位符
- **fullAgency 模式下工具仍请求权限**：permissionMode/model 跟踪变量在 session abort 期间丢失，收窄更新范围至 abort 场景
- **Gemini thinking 模型 400 错误** (#22)：thought_signature 持久化 + 双位置归一化 + direct/extra_content.google 同步
- **定时任务系统休眠后延迟数小时触发**：改用 wall-clock 轮询替代 setInterval
- **后台 Agent 子任务完成后 UI 状态不更新**
- **AI 小助理面板**：模型下拉被遮挡（移除 overflow-hidden）、底部圆角溢出、右键选中文本
- **session 加载时消息跳动 + 空白屏优化**
- **OpenClaw 插件更新后版本号消失 + 自动重启相关 Bot**
- **Tray 退出改为 app.exit(0)**：不再绕行前端 WebView
- **Windows VM bun 崩溃**：切换 baseline 构建 + 系统 fallback
- **v0.1.41 技术债清理 (TD-1 ~ TD-6 主体)**：消除 IM Bot 兼容层，start_channel 提取、agent: session key 激活、健康文件路径迁移、shim 删除、ImSettings 移除

### Changed
- **关于页面排版优化**：产品描述改为「开发者来信」风格
- **「心跳循环」更名为「循环」**：图标换为 Timer
- **「项目设置」统一更名为「Agent 设置」**
- **Tauri crate 升级**：2.9.5 → 2.9.6

---

## [0.1.40] - 2026-03-10

### Added
- **飞书 Card Kit v2.0 原生渲染**：含表格或代码块的消息自动使用 Interactive Card 发送，飞书客户端原生渲染 markdown 表格和代码高亮
- **Global Sidecar 健康监控**：后台进程死亡自动重启，前端日志熔断器防止刷屏

### Fixed
- **钉钉/飞书 WS 连接因 NAT 静默断开频繁重连**：新增客户端 ping（30s 间隔）保持 NAT 映射存活
- **IM Bot 会话中断**：健康检查误判 + interrupt 超时级联故障修复
- **AI 回复结束后页面跳动**：spacer 收缩动画优化 + AssistantActions 延迟渲染
- **Windows 首次安装后 SDK 找不到 bun/git**：bun.exe 别名 + Git PATH 发现 + 重复 PATH 去重
- **Markdown 表格内 inline code 占位符未还原**（显示 ◆CODE{n}◆）
- **rewind 阻塞 103 秒**：5s 超时 + 图片 MIME type 丢失修复
- **飞书 Card 表格内加粗标记未渲染**：发送前 strip 表格行内 `**` 标记
- **Sidecar 指数退避溢出**：连续失败 61 次后 panic，改用 saturating 算术
- **Windows portable 构建 bun.exe 过期**：始终覆盖确保版本一致
- **API watchdog 误杀复杂任务**：超时从 5 分钟放宽至 15 分钟

### Changed
- **流式首发攒句优化**：累积到标点或 20 字后才首发，避免单字闪烁
- **移除 ZenMux 预设 zenmux/auto 模型**

---

## [0.1.39] - 2026-03-10

### Added
- **对话流内联 TTS 音频播放** (#14)：TTS 工具结果支持内联播放/暂停控件，音频文件存储到工作区 `myagents-generated/` 目录
- **思考中实时显示已用时间**：思考过程中显示 "思考中… (3s)"，完成后显示 "思考了 5s"
- **API 响应超时 watchdog**：检测 Sidecar 响应超时并提供中止选项

### Fixed
- **Spacer 收缩跳动**：CSS transition 改 JS RAF 动画，每帧检测 scrollTop 位置，消除自动滚动时的视觉抖动
- **Markdown 预处理破坏 GFM 表格**：含 `#` 的单元格被误判为标题
- **CSS 变量未定义**：`--accent-hover` → `--accent-warm-hover`
- **watchdog 空闲后误触发**：abort handler 增加 `signal.aborted` 前置检查
- **`myagents-generated/` 目录自动创建 `.gitignore`**：防止误提交生成文件
- **思考完成后始终显示耗时秒数**：不足 1s 时显示 1s
- **Windows asset 协议兼容**：convertFileSrc + CSP `https://asset.localhost`

### Changed
- **音频播放器重构**：toggleAudio 移入 singleton、AudioState 去重、watchdog 可读性改进
- **TTS/图片生成文件存储重构**：统一存储到工作区 `myagents-generated/` 目录

---

## [0.1.38] - 2026-03-09

### Added
- **OpenClaw Channel Plugin 兼容**：Plugin Bridge 架构，支持社区 Channel 插件（如 QQ Bot）以独立 Bun 进程加载运行，Promoted Plugin 获得一等 UI 待遇（自定义图标、品牌色、安装引导）
- **Mid-turn message injection**：去除 turn 级阻塞，支持 AI 处理中注入新消息，无需等待当前回复完成
- **标题栏反馈按钮**：快速反馈入口

### Fixed
- **聊天页自动滚动全面优化**：content-aware 双目标滚动公式（用户消息置顶 → 跟随 AI 内容）、动态 spacer 按需扩缩（避免过大空白）、wasClamped 启发式防止布局钳制误禁用自动滚动、平滑动画替代瞬间跳跃
- **后台任务运行时 chat 中断卡死**：SDK Task 生命周期消息处理修复
- **引用全局 Agent 时 Task 工具无法识别自定义 sub-agent** (#13)
- **自动更新请求未走用户代理配置**：更新检查现通过用户配置的代理发送
- **Plugin Bridge 进程崩溃后残留**：添加 sidecar 标记确保清理
- **Bridge 进程因 --myagents-sidecar 参数崩溃**
- **插件安装后配置字段未预填 + 安装 toast 提示**
- **QQ Bot npm 包名修正**：更正为 @sliverp/qqbot
- **路径遍历、pluginId 不匹配、Popover 交互**：cross-review 修复

### Changed
- **依赖升级**：@tauri-apps/api ~2.10、plugin-updater ~2.10

---

## [0.1.37] - 2026-03-07

### Added
- **埋点系统升级**：新增 15 个前端事件（session_rewind/title_edit、message_retry/copy、agent_add/remove、skill_use、im_bot_create/toggle/remove、workspace_create、tts_play、task_center_open、bug_report_submit）+ 服务端统一 `ai_turn_complete` 指标覆盖所有 AI 执行来源（交互对话/IM Bot/定时任务/Heartbeat）
- **工作区模板库**：新增「从模板创建工作区」功能，内置 Mino 模板；Phosphor 图标系统支持 50+ 工作区图标选择
- **Tavily 搜索预设**：新增 Tavily Web Search MCP 预设工具 + MCP 设置引导优化
- **macOS 本地化**：Info.plist 声明 CFBundleLocalizations，原生 UI（WebView 右键菜单等）跟随系统语言
- **Windows 平台增强**：VC++ Runtime app-local 部署、Sidecar 启动失败诊断增强、用户友好错误提示

### Fixed
- **AI 回复最后几个字丢失**：React 18 批处理竞态导致流式输出末尾内容未渲染
- **Gemini thinking 模型 400 错误**：工具调用后 `thought_signature` 丢失，全链路透传修复
- **Sub-Agent 重命名后列表仍显示旧名称**：Agent 列表未刷新缓存
- **飞书 Bot 群聊管理空状态提示**：优化空群组引导文案
- **触摸板横滑切换 Tab 冲突**：与内部可横滑元素（代码块等）手势冲突
- **右键菜单改进**：AgentCapabilitiesPanel 菜单项补全 icon；生产环境屏蔽原生 Reload/Inspect Element 菜单，保留输入框/文本选中/媒体元素原生菜单
- **MCP 列表 UX**：简化 DuckDuckGo 描述文案；截断文本 hover 展示完整内容；设置面板标题下方展示副标题描述
- **服务端埋点健壮性**：config 缓存加 TTL 重试修复启动竞态；endpoint 校验与前端三重检查一致

### Changed
- **对话页侧栏重构**：工作区面板与 Launcher 风格统一、两行布局 + 能力面板排序优化
- **埋点开源最佳实践**：移除硬编码 endpoint，`isAnalyticsEnabled()` 强化为三重检查，fork 构建零泄漏

---

## [0.1.36] - 2026-03-06

### Added
- **Session 智能标题自动生成**：首轮 QA 后 AI 自动生成语义化短标题（≤30 字），贯穿 Tab 栏、Chat 顶栏、历史记录、任务中心；支持 Chat 顶栏内联点击重命名，手动重命名后不再自动覆盖（`titleSource` 三态：default/auto/user）
- **触控板双指水平滑动切换 Tab**：跟手动画 + 惯性检测 + 边界回弹，支持 macOS 触控板自然手势
- **对话文件路径菜单「打开」选项**：右键文件路径可直接在系统中打开
- **模型用量分布表格供应商筛选器**：使用统计页支持按供应商筛选模型用量

### Fixed
- **飞书群聊管理未识别群组** (#11)：飞书 Bot 仅通过生命周期事件发现群组，新增与钉钉相同的消息级自动发现机制
- **Gemini 工具调用 400 错误** (#10)：OpenAI 桥接层丢失 Gemini 思考模型的 `thought_signature` 字段，全链路增加透传
- **代码块选中复制换行问题**：视觉换行被当成真实换行复制
- **输入框工具栏窄屏换行**：工具栏按钮在窄宽度下自动隐藏文字标签，模型名称截断显示
- **Rust 代理层缺少 PATCH 方法**：`proxy_http_request` 不支持 PATCH，导致 session 更新（重命名等）静默失败
- **AI 分析内容误触发 Agent error 横幅**：非流式供应商正常响应被误显示为错误
- **会话统计弹窗层级错误**：Modal 嵌套在 dropdown 内导致输入框浮于遮罩之上，改用 Portal 渲染到 document root
- **会话统计弹窗样式**：卡片/表头背景与设置页使用统计面板风格统一（paper-elevated）
- **飞书 Bot 权限缺失**：补充 `contact:contact.base:readonly` 权限

---

## [0.1.35] - 2026-03-05

### Fixed
- **「不再提示」全局配置覆盖弹窗**：重启应用后弹窗仍然显示，修复持久化逻辑
- **Bridge thinking 模式 tool_call**：thinking 模式下 tool_call 消息缺失 reasoning_content
- **IM Bot im-media 工具丢失**：IM 频道发送图片/文件时工具不可用 + 首消息 SSE 超时
- **AI 小助理面板圆角**：底部圆角被子元素背景色遮挡，添加 overflow-hidden

### Changed
- **Design Polish v2.2**：CSS Token 重建 + 组件样式统一 + 页面视觉打磨
- **模型选择器重构**：从两级菜单（先选供应商 → 再选模型）改为单级分组菜单，按供应商分组平铺所有可用模型；空状态显示引导跳转设置页
- **Settings 文案修正**："工具 & MCP" → "工具 MCP"

---

## [0.1.34] - 2026-03-04

### Added
- **Edge TTS 语音合成**：新增免费 TTS MCP 工具，基于自研 WebSocket 协议实现（绕过 Bun ws polyfill 限制），支持 400+ 语音、语速/音量/音调调节、多种输出格式
- **Gemini Image 工具前端组件**：AI 生成图片支持内联预览展示
- **AI 消息操作栏**：新增复制/重试按钮，用户消息操作栏布局重构
- **Google Gemini 预设供应商**：添加 Gemini（OpenAI 协议兼容）预设配置
- **Playwright MCP 设置面板升级**：结构化控件替代通用对话框
- **Chat 工具弹窗设置入口**：增加设置图标，点击跳转 Settings MCP 配置面板
- **MCP 预设工具「免费」标签**：帮助用户识别无需 API Key 的免费工具
- **Telegram Draft 流式打字机**：sendMessageDraft 实验性流式打字效果

### Fixed
- **Bridge 429 无限重试**：区分 quota-exhausted（永久限速）与临时 429，避免无限循环
- **Session 死亡自动恢复**：防止 generator 死亡导致消息队列卡死
- **MCP Streamable HTTP 验证**：Accept 头不符合规范导致智谱等端点 400 错误
- **Feishu IM 稳定性**：撤回通知处理 + 排队消息响应丢失 + cross-turn 防护
- **IM Bot MCP 工具**：取消勾选失败 + Telegram Draft 默认开启
- **消息操作栏样式**：hover 时间戳残留 + 图标对齐 + 间距优化
- **非流式供应商误报错**：正常响应被误显示为 Agent error 横幅

### Changed
- **Builtin MCP 注册模式重构**：统一 registry pattern + config fingerprint 变更检测
- **CSP 安全策略更新**：添加 media-src 指令支持音频 Blob URL 播放

---

## [0.1.33] - 2026-03-03

### Added
- **钉钉 Bot 集成**：新增钉钉机器人 IM 渠道，支持私聊和群聊；Windows 单实例防护避免多开冲突
- **OpenAI Bridge Responses API**：兼容 OpenAI Responses API 格式 (`upstreamFormat: 'responses'`)，支持 `maxOutputTokens` 配置上限
- **全局 Token 使用统计**：Settings 页新增使用统计面板，含 5 项汇总卡片、每日用量趋势 SVG 柱状图、模型用量分布表，支持 7 天 / 30 天 / 60 天时间范围切换
- **项目设置重构**：双 Tab 布局（系统提示词 + 项目设置），支持多文件系统提示词管理
- **MCP 运行环境弹窗**：增加「让 AI 小助理安装」按钮，一键委托 AI 安装 MCP 依赖
- **全局配置覆盖弹窗**：增加「不再提示」选项，避免重复确认

### Fixed
- **MCP 超尺寸图片**：工具返回超大 base64 图片导致 Claude API 400 错误，增加尺寸检测与压缩
- **供应商验证竞态**：并发验证请求中，超时的过期请求覆盖已成功的验证状态，使用 generation counter 丢弃过期结果
- **OpenAI 协议验证 max_tokens 超限**：验证流程未传递 `maxOutputTokens` 导致 Bridge 无法限制默认 token 上限
- **cron_task ProviderEnv 构造补全**：定时任务缺失 provider 环境变量字段
- **日志降噪**：恢复重要 SDK 消息日志，截断超长字符串；AI 反馈答疑文案改为"AI 小助理"
- **项目设置 Overlay**：删除文件后编辑态未重置 + tooltip 被 overflow 裁切不可见

### Changed
- **GitHub Release 上传脚本拆分**：发布上传逻辑拆分为独立脚本，`publish_release.sh` / `publish_windows.ps1` 调用
- **CLAUDE.md 精简**：从 562 行精简至 126 行最佳实践
- **OpenAI Bridge 代码清理**：重构 Bridge 模块 + Settings UI 优化

---

## [0.1.32] - 2026-03-02

### Added
- **AI 智能 Bug 上报**：一键向开发者报告问题，AI 自动收集运行日志、系统环境、对话上下文，生成结构化 Bug Report
  - 支持图片上传、粘贴和拖拽附加截图
  - 模型菜单只显示可用 provider，无可用 provider 时引导跳转设置
  - 重构为 bundled-agents 文件化架构（`bundled-agents/myagents_helper/`）
- **内置助手 v2**：全新 `myagents_helper` Agent，增加产品定位与开发者愿景、工作区写保护约束
- **Launcher 无 Provider 引导**：未配置任何 API Key 时显示「配置模型供应商」引导入口

### Fixed
- **RecentTasks 显示数量修复**：列表条目计数逻辑修正
- **关闭 AI 对话中的 Tab**：不再弹确认框，改为 toast 提示
- **`.gitignore` 修正**：只忽略根目录 `.claude/`，允许子目录 `.claude/` 被 Git 跟踪

### Changed
- **统一系统提示词架构**：重构为三层 Prompt 架构（L1 基础身份 + L2 交互方式 + L3 场景指令），所有场景统一使用 append 模式
  - AI 始终知道自己运行在 MyAgents 产品中（桌面聊天、IM Bot、Cron 任务）
  - 旧 SystemPromptConfig（preset/replace/append 三模式）替换为 InteractionScenario 类型
  - IM Bot 启动时传递 botName，AI 感知自身 Bot 名称
  - 模板内容内联为字符串常量（bun build 禁止 `__dirname`）
- **IM Bot 文件存储重构**：运行时状态文件从 `~/.myagents/im_{botId}_*.json` 扁平散落迁移到 `~/.myagents/im_bots/{botId}/` 子目录组织
  - 三代自动迁移（v1 单 bot → v2 flat 多 bot → v3 子目录）
  - 孤儿文件启动时自动清理，删除 bot 时清理持久化数据
- **统一日志优化**：本地化时间戳、减少噪音
- **Settings 页面 UI 重构**：「报告问题」从「关于」移至「通用」运行日志下方

---

## [0.1.31] - 2026-03-01

### Fixed
- **agent-browser 反检测配置路径统一**：使用 `~/.agent-browser/config.json`（agent-browser 默认路径），移除 `AGENT_BROWSER_CONFIG` 环境变量，避免路径不一致
- **agent-browser Profile 路径统一**：与 Playwright MCP 共享 `~/.playwright-mcp-profile/`，避免重复登录
- **agent-browser comma-in-args bug**：`--window-size=1440,900` 被 Rust CLI 按逗号拆分导致参数错误，改用 `--start-maximized`
- **Windows agent-browser 不可用**：上游 daemon 在 Windows 使用 Unix socket 导致连接失败（vercel-labs/agent-browser#398），暂时在 Windows 上跳过 agent-browser 技能加载
- **agent-browser 反检测参数优化**：禁用自动化控制标志、匹配系统 locale、最大化窗口绕过 viewport 指纹

### Changed
- **平台技能屏蔽机制**：新增 `PLATFORM_BLOCKED_SKILLS` 集中配置，支持按平台跳过不可用的内置技能（seed / wrapper / symlink / API 列表统一过滤）
- **发布脚本集成 GitHub Release 上传**：`publish_release.sh` 和 `publish_windows.ps1` 在 R2 上传后自动将构建产物上传到 GitHub Release

---

## [0.1.30] - 2026-02-28

### Added
- **agent-browser 内置浏览器自动化**：集成 agent-browser CLI 作为内置技能，支持网页截图、表单填写、数据提取
  - Chromium 自动安装（文件锁防并发）
  - 开发模式自动安装 + 首次使用提示
  - 项目技能右键「同步至全局技能」
- **IM Bot 多媒体发送**：SDK 自定义工具 send_media，支持发送图片/文档到 IM
- **代理配置热更新**：Settings 修改代理后实时传播到所有运行中 Sidecar
- **MCP 添加面板 JSON 批量导入**：支持一次性导入多个 MCP 服务器 + DDG-Search 预设
- **工作区右键「用默认应用打开」**：文件可用系统默认程序打开
- **检测并清除 settings.json 环境变量覆盖**：防止 CLAUDE_CONFIG_DIR 等覆盖影响认证
- **agent-browser 反检测默认配置 + Profile 持久化**：自动生成 headed 模式、真实 UA、持久化 Profile 的反检测配置，解决知乎/微博等网站被拦截问题

### Fixed
- **Windows Sidecar 启动失败**：UNC 路径前缀导致 Bun 无法识别资源路径
- **Windows agent-browser 浏览器自动化不可用**：daemon 启动失败（无 Node.js）+ 命令找不到（Git Bash 不识别 .cmd）
- **Windows 技能同步失败**：symlink junction 删除需要 recursive 选项
- **Windows 启动诊断增强**：崩溃日志跨平台 + 启动 beacon + 健康检查可见化
- **agent-browser 构建产物缺失**：运行时报 "No binary found"
- **agent-browser 构建脚本预装卡死**：改用预生成 lockfile 秒级安装
- **macOS 公证失败**：agent-browser 原生二进制未签名
- **Global Sidecar pre-warm 异常**：无效 pre-warm 启动 + Tab pre-warm 超时误杀 + 僵尸进程
- **Global Sidecar 意外加载 MCP**：Settings/Launcher 不应加载用户 MCP 配置
- **IM Bot 重启后 "No conversation found" 死循环**
- **新会话首条消息 loading 状态闪断**
- **Windows 文件重命名导致文件被移到 AppData 目录**
- **供应商选择菜单溢出屏幕**
- **工作区大目录无法展开**（条目上限 50000）
- **macOS 全屏退出后 Tab 遮挡红绿灯**
- **Provider 验证 auth 错误未正确检测**：SDK 返回 403/401 时误报验证成功

### Changed
- **路径 normalize Pit of Success 重构**：源头统一处理，消除消费端重复 strip
- **Bun 输出接入统一日志**：Sidecar stdout/stderr 可在日志面板查看
- **消除 Rust 编译 warning**：平台分离 graceful shutdown 逻辑
- **Code Review 修复**：构建版本校验 + 签名失败硬中断 + 死代码清理

---

## [0.1.29] - 2026-02-27

### Added
- **火山方舟双供应商拆分**：原「火山引擎」拆分为两个独立供应商
  - 「火山方舟 Coding Plan」：baseUrl `/api/coding`，预设 Doubao Seed 2.0 Code、GLM 4.7、DeepSeek V3.2、Kimi K2.5
  - 「火山方舟 API调用」：baseUrl `/api/compatible`，预设 Doubao Seed 2.0 Pro/Code Preview/Lite
- **用户级 Skill 原生可用**：Skill enable/disable 通过 SDK staging directory 过滤，支持项目级 symlink 同步
- **远程 MCP 连接验证**：新增 SSE/HTTP 类型 MCP 服务器的连接可达性检测
- **新增阿里云百炼供应商**：Coding Plan 预设，支持 Qwen 3.5 Plus、Kimi K2.5、GLM 5、MiniMax M2.5

### Fixed
- **系统代理泄漏导致网络超时**：清理继承的代理环境变量 + 禁用 SDK 非必要流量
- **IM Bot "No conversation found" 死循环**：过期 session 自动重置
- **飞书 WebSocket 死连接检测**：增加 read timeout 及时发现断线
- **Skill symlink 完整性**：CRUD 同步 + 悬空清理 + 死代码清除
- **全局 Command 同步到项目目录**：SDK 静默错误在持久 Session 中可靠展示
- **供应商切换按钮可点击区域过小**：增大 hover/click 区域提升交互体验

### Changed
- **Skill 同步改用项目级 symlink**：避免 CLAUDE_CONFIG_DIR 破坏订阅认证
- **Code Review 修复**：is_error 错误样式 + 函数重命名 + Windows 注释

---

## [0.1.28] - 2026-02-26

### Added
- **IM Bot 群聊完整支持**：实现群聊全链路功能
  - 群授权审批流程：Bot 入群 → 桌面端 pending/approved 管理 → 群内提示消息
  - 智能触发模式：mention 模式（@Bot / 回复 Bot / `/ask`）+ always 模式（NO_REPLY 静默）
  - 群聊上下文增强：发送者身份 `[from: name]`、Pending History 积累、群聊系统提示
  - 安全隔离：群工具黑名单（SDK disallowedTools）、Heartbeat 屏蔽群聊
  - 前端 UI：群权限管理列表（折叠/徽标）+ 激活模式切换
  - 飞书：用户名 LRU 缓存、群事件检测、@mention 检测
  - Telegram：my_chat_member 订阅、reply-to-bot 检测、大小写不敏感 @mention
- **ultra-research bundled skill**：新增 ultra-research 内置技能

### Fixed
- **定时任务不执行**：SDK 升级后要求 `--resume` 参数为标准 UUID 格式，旧 `cron-im-{uuid}` 前缀格式被拒绝导致进程退出。Session ID 改用纯 UUID，并增加三级 UUID 校验策略兼容历史数据
- **用户消息换行符双倍渲染**：`whitespace-pre-wrap` CSS 与 `remarkBreaks` 插件冲突，ReactMarkdown 在块元素间插入的 `\n` 文本节点被二次渲染为可见换行
- **图片自动缩放移至后端统一处理**：前端 Canvas API 缩放无法覆盖 IM Bot 图片路径（Telegram/飞书图片走 Rust→Bun 管道），且 GIF 缩放后 mimeType 不一致。迁移到后端 `enqueueUserMessage()` 使用 jimp 统一处理

---

## [0.1.27] - 2026-02-25

### Added
- **Cron 工具 runs/status/wake 能力增强**：IM Bot 的 `cron` 工具新增三个 action
  - `runs`：查询任务历次执行记录（JSONL 持久化，上限 500 条）
  - `status`：查询当前 Bot 的任务统计（总数/运行中/最近执行/下次执行）
  - `wake`：手动触发即时心跳检查，支持注入文本到 Bot Sidecar
- **Cron 任务 `updatedAt` 字段**：记录最后活动时间（创建/启动/停止/执行/编辑），任务列表按最近操作排序

### Fixed
- **Heartbeat 502 Bad Gateway**：HeartbeatRunner 的 reqwest 客户端缺少 `.no_proxy()`，系统代理拦截 localhost 请求
- **Cron 结果未投递到 IM**：`deliver_cron_result_to_bot()` 使用 `reqwest::Client::new()` 同样缺少 `.no_proxy()`，system-event POST 失败导致心跳触发普通提示而非 Cron 结果注入
- **IM Bot Cron 定时任务结果投递链路三层修复**：一次性定时任务执行后立即停止导致跳过投递、heartbeat JSON 解析 `sidecar_port` 类型不匹配、Cron session_id 与 IM peer session_id 不一致
- **Tab 间 Provider/Model 交叉污染**：`selectedProviderId` 从全局变量改为 Tab 局部状态，避免切换 Tab 时污染其他 Tab 的供应商选择
- **用户消息气泡换行符不显示**：`<HEARTBEAT>` 标签触发 Markdown HTML block 模式，绕过 remarkBreaks，通过 `whitespace-pre-wrap` 修复
- **任务中心列表不刷新**：重启任务后列表不更新，新增 `cron:task-started` 事件从 Rust 同步发射，前端即时监听刷新
- **Session 消息计数归零**：Sidecar 重启后首条消息触发 `createSessionMetadata()` + `saveSessionMetadata()` 全量替换 sessions.json 条目，导致累积 stats 被清空。改为先检查已有 metadata 再决定创建或更新
- **统一日志日期不一致**：Bun 侧 `toISOString()` 产生 UTC 日期，与 Rust 本地日期不同，UTC+8 时区下日志分散到不同文件

### Changed
- **`local_http` 模块集中化**：所有 localhost reqwest 客户端统一通过 `crate::local_http::builder()` 创建，内置 `.no_proxy()`，消除散落在 7 个文件中 11 处 `.no_proxy()` 调用的遗漏风险
- **定时任务列表排序优化**：running 组按 nextExecutionAt 升序，stopped 组按 updatedAt 降序（最近有操作的在前）

---

## [0.1.26] - 2026-02-24

### Changed
- **前端配置服务域拆分**：将 1028 行 configService.ts 上帝模块拆分为 6 个域模块（configStore / appConfigService / providerService / mcpService / projectService / projectSettingsService），原文件保留为 barrel re-export，所有现有 import 无需修改
- **ConfigProvider 共享状态架构**：新增 ConfigProvider 双 Context（ConfigDataContext + ConfigActionsContext），消除 useConfig 独立 hook 多调用者状态不同步问题。useConfig 改为兼容 wrapper，现有消费者零改动
- **消除 CONFIG_CHANGED DOM 事件桥接**：配置变更通过 ConfigProvider 的 setState 直接同步，不再依赖 window.dispatchEvent 临时方案
- **im:bot-config-changed 监听上移**：从 ImBotDetail 移入 ConfigProvider，所有消费者通过 Context 自动获得最新配置
- **atomicModifyConfig 统一写入模式**：providerService 和 mcpService 的 9 处写入函数从手动 lock+read+write 改为 atomicModifyConfig，_writeAppConfigLocked 收为模块私有
- **IM Bot 配置架构统一**：建立 Rust 层作为 IM Bot 配置唯一管理者，前端和 IM 命令共享同一条配置变更通道

### Fixed
- **safeWriteJson 并发读写竞态**：备份步骤从 rename（删除原文件）改为 copyFile（保留原文件），消除并发读取时 "No such file or directory" 错误
- **safeLoadJson 读操作中写文件竞态**：改为纯只读恢复，不在读操作中触发写入
- **共享 isLoading 全局闪烁**：移除 Launcher/Settings 的冗余 reloadConfig 调用，避免 ConfigProvider 共享 isLoading 导致 ImSettings 等组件闪烁
- **Windows 手动检查更新误报「已是最新版本」**

---

## [0.1.25] - 2026-02-23

### Added
- **任务中心（Task Center）**：新增全局任务面板，集中查看所有会话（对话、定时任务、IM Bot 后台会话）
  - 会话列表支持分类标签（对话/定时/IM）和最后一条消息预览
  - 定时任务详情面板，展示 cron 信息和运行状态
  - 后端支持 cron 信息聚合、后台会话查询、IM 事件上报
- **会话列表 Hover 菜单**：会话列表项支持悬停显示统计信息和删除操作，ConfirmDialog 支持键盘操作（Enter/Escape）
- **PlanMode 方案审核**：接入 SDK 的 ExitPlanMode/EnterPlanMode 工具
  - ExitPlanMode 卡片展示 AI 生成的方案内容，用户可批准/拒绝
  - 卡片在用户决策后保留显示「已批准/已拒绝」状态
  - 支持权限模式热切换（运行中切换 Plan ↔ Auto）
  - EnterPlanMode 自动批准，无需用户手动确认

### Fixed
- **中文文件名图片预览 500 错误**：含中文字符的图片路径导致预览接口返回 500
- **Agent 错误展示**：报错时展示详细错误描述，而非仅显示错误码
- **ExitPlanMode 卡片位置错位**：卡片从 Message 外部移入内部（slot 模式），解决用户批准后新内容「插入」到卡片上方的视觉问题

### Changed
- **全局 Overlay 毛玻璃遮罩统一**：所有 Overlay 遮罩统一使用 `bg-black/30 backdrop-blur-sm`
- **ExitPlanMode 卡片样式**：宽度与工具行对齐（撑满父容器），方案内容区高度增加 30%
- **ProcessRow 简化**：移除 thinking 指示器的特殊颜色样式

---

## [0.1.24] - 2026-02-23

### Added
- **OpenAI 兼容协议桥接**：内置 Anthropic → OpenAI Chat Completions API 转译桥，支持 OpenAI 兼容端点（DeepSeek、Qwen 等）通过 loopback 架构接入 Claude Agent SDK。包含完整的请求/响应转译、SSE 流式传输、`reasoning_content` ↔ thinking block 双向映射、代理感知上游请求
- **统一日志导出**：设置 > 通用 > 运行日志区域新增导出按钮，将近 3 天统一日志打包为 zip 导出到桌面

### Fixed
- **IM Bot `/provider` & `/model` 命令配置持久化**：命令切换 Provider/Model 后持久化到 config.json 并同步 Sidecar，前端设置页实时刷新
- **IM Bot Session ID 失同步**：第三方 → Anthropic 供应商切换时 Bun 内部新建 session，Rust 侧通过 `upgrade_peer_session_id()` 同步 PeerSession + SidecarManager
- **IM Bot auto-start availableProvidersJson 缺失**：前端启动时持久化 `availableProvidersJson` 到磁盘，Rust auto-start 迁移逻辑兼容旧配置
- **IM Bot `/model` 动态模型列表**：`/model` 命令显示当前供应商可用模型索引列表，支持按序号选择

---

## [0.1.23] - 2026-02-22

### Fixed
- **IM Bot 第三方模型 auto-start 失败**：`providerEnvJson`（含 baseUrl/apiKey/authType）只在前端手动启动时构建，Rust auto-start 从磁盘读不到 → 第三方供应商（DeepSeek、Moonshot 等）报 "所选模型不可用"。现在前端在启动/切换 Provider 时持久化 `providerEnvJson` 到 config.json
- **IM Bot auto-start 向前兼容迁移**：Rust 侧新增 `migrate_provider_env()`，对旧配置（无 `providerEnvJson` 字段）从 `providerApiKeys` + 预设供应商 baseUrl 映射自动重建，确保升级后首次 auto-start 即可用
- **IM Bot `/new` 命令 port 0 崩溃**：App 重启后恢复的 session `sidecar_port` 为 0，`/new` 发起 HTTP 请求到 `127.0.0.1:0` 导致报错。现在检测 port 0 时本地重置 session 元数据
- **IM Bot SDK 错误透传与本地化**：SDK `is_error` 标志正确透传到 IM 端、图片历史污染自动重置 session、新增 6 类错误中文本地化（认证失败、频率限制、余额不足、模型不可用等）
- **更新检查 Toast 重复**：后台下载进行中时重复弹出"正在下载更新"提示

---

## [0.1.22] - 2026-02-22

### Added
- **飞书 Bot 多媒体接收**：支持接收图片、文件、音频、视频附件，图片走 SDK Vision，文件保存到工作区
- **MCP 内置服务器 args/env 配置**：内置 MCP 服务器支持自定义启动参数和环境变量
- **download-anything 内置 Skill**：新增文件下载 bundled skill
- **Mermaid 图表预览/代码切换**：Mermaid 代码块新增预览/源码切换按钮和复制按钮
- **YAML Frontmatter 代码高亮**：文件预览中 YAML frontmatter 渲染为语法高亮代码块
- **上传文件功能升级**：Plus 菜单「上传图片」升级为「上传文件」，支持更多文件类型

### Fixed
- **心跳/IM 消息竞态条件**：心跳 runner 未获取 peer_lock 导致与用户消息并发访问 imStreamCallback，造成响应丢失和双重 "(No response)"。现在心跳与用户消息通过 peer_lock 串行化，Bun 侧增加纵深防御
- **Monaco 编辑器 CJK 输入法**：修复中日韩输入法组合输入时的闪烁和异常行为（两轮修复）
- **Mermaid 图表加载卡死**：多图表场景下 Mermaid 渲染卡在 loading 状态
- **模态框拖拽误关闭**：拖拽选中文本到遮罩层时不再误触发关闭
- **Bot 工作区复制校验**：从 bundled mino 复制工作区时增加校验和 fallback
- **飞书向导步骤优化**：「添加应用能力-机器人」提前到 Step 1，减少配置遗漏

### Changed
- **Launcher 工作区选择器**：从输入框上方浮动 pill 移入输入框工具栏内，布局更紧凑
- **README 更新**：同步当前功能列表、支持的供应商和架构说明

---

## [0.1.21] - 2026-02-21

### Added
- **Bot 创建向导新增工作区步骤**：创建 Bot 时可直接配置独立工作区路径
- **飞书 Post 富文本消息支持**：Bot 接收飞书 Post 类型消息（含代码块、加粗、列表等富文本），解析 text/a/at/img/emotion/code_block 元素为纯文本
- **IM Bot /help 命令**：飞书和 Telegram Bot 均支持 `/help` 查看所有可用命令
- **IM Bot /mode 命令**：通过 `/mode plan|auto|full` 切换权限模式（计划/自动/全自主）
- **工作区文件单击预览**：右侧「项目工作区」面板中单击文件直接触发预览（原需双击），Ctrl+单击多选保持不变

### Fixed
- **飞书 Bot 幽灵消息**：dedup 缓存持久化到磁盘（TTL 72h），App 重启后不再重复处理飞书重传的旧事件
- **飞书消息静默丢失**：含代码块/加粗等格式的消息（msg_type: post）不再被忽略
- **IM 来源标签错误**：飞书消息不再显示 "via Telegram 群聊"，改用 SOURCE_LABELS 映射正确显示平台名
- **Provider API Key 验证超时**：使用 project-level settingSources 和 bypassPermissions 避免用户级插件加载阻塞
- **文件预览 FileReader 挂起**：添加 onerror/reject 处理，防止 Blob 损坏时 isPreviewLoading 永久卡死
- **Tab 关闭确认误弹**：持久 Owner 保持 Sidecar 存活时跳过关闭确认
- **Telegram 向导输入顺序**：修正向导步骤输入框顺序，跳过按钮改为返回按钮
- **绑定消息误处理**：已绑定用户的 BIND 消息静默忽略，避免重复处理

### Performance
- **前端流式消息隔离**：Playwright tool.result 从前端剥离，流式消息状态独立管理，减少不必要的重渲染

### Changed
- **飞书代码块输出样式**：AI 回复中的代码块使用 `─── ✦ ───` 分隔线 + 斜体缩进，内联代码映射为加粗+斜体
- **IM Bot 热更新**：权限模式、MCP 服务器、Provider 等配置变更无需重启 Bot
- **Heartbeat 系统提示词**：心跳检查使用独立 system prompt，修复 Bot 停止/重启可靠性

---

## [0.1.20] - 2026-02-19

### Added
- **飞书 Bot 平台支持**：新增飞书适配器（WebSocket 长连接 + protobuf），与 Telegram 共享多 Bot 架构、Session 路由、消息缓冲
- **IM Bot 交互式权限审批**：非 fullAgency 模式下，工具权限请求通过飞书交互卡片 / Telegram Inline Keyboard 展示，用户点击按钮或回复文本完成审批
- **ZenMux 预设供应商**：新增 ZenMux 云服务商聚合平台，支持 9 个预设模型（zenmux/auto、Gemini 3.1 Pro、Claude Sonnet/Opus 4.6 等）

### Fixed
- **飞书 WebSocket 事件重放**：新增数据帧 ACK 机制，dedup 缓存 TTL 从 30 分钟延长至 24 小时，防止断连重连后消息重复处理
- **IM Bot 停止按钮状态回弹**：`toggleBot` 写盘后未调用 `refreshConfig()` 同步 React 状态，导致轮询 fallback 到过期的 `cfg.enabled`
- **工具输入截断 UTF-8 panic**：权限审批卡片中 `tool_input[..200]` 字节截断改为 `char_indices().nth(200)` 字符安全截断

---

## [0.1.19] - 2026-02-18

### Added
- **IM 多 Bot 架构**：支持创建和管理多个 Telegram Bot 实例，独立配置工作区、权限、AI 供应商和 MCP 工具
- **IM Bot AI 配置**：每个 Bot 独立设置 Provider/Model/MCP 服务，支持 Telegram `/model` 和 `/provider` 命令切换
- **Telegram 多媒体消息支持**：支持图片（SDK Vision）、语音、音频、视频、文档（保存到工作区）、贴纸、位置、相册（500ms 缓冲合并）
- **IM Bot 自动启动**：应用启动时自动恢复上次运行中的 Bot

### Fixed
- **Telegram 代理支持**：文件下载复用代理配置的 HTTP 客户端
- **IM Bot 启停按钮状态回弹**：轮询跳过正在操作的 Bot，避免覆盖乐观更新；toggleBot 使用 ref 读取最新状态消除闭包陈旧
- **TodoWriteTool 白屏崩溃**：流式 JSON 解析中间态 `todos` 可能为对象而非数组，改用 `Array.isArray()` 守卫
- **IM 私聊 emoji 移除**：去掉 Telegram 私聊消息的手机 emoji，群聊保留群组图标
- **IM Bot 列表页 UI 闪烁**：消除空状态闪烁和按钮颜色闪烁
- **多媒体安全加固**：文件名路径穿越防护（sanitize_filename）、下载大小限制（20MB）、图片编码限制（10MB）、异步文件 I/O

### Changed
- **IM 会话列表标签化**：用平台标签替代 emoji 标识 IM 来源
- **SDK 升级**：claude-agent-sdk 升级至 0.2.45
- **模型更新**：新增 Sonnet 4.6，移除 Opus 4.5

---

## [0.1.18] - 2026-02-17

### Added
- **用户消息气泡 Hover 菜单**：鼠标悬停显示操作菜单（复制、时间回溯），Tooltip 提示
- **时间回溯功能**：回溯对话到指定用户消息之前的状态，回退文件修改，被回溯的消息文本恢复到输入框
- **Launcher 工作区设置双向同步**：工作区卡片设置面板变更实时同步到已打开的 Tab

### Performance
- **持久 Session 架构**：SDK subprocess 全程存活，消除每轮对话的 spawn → init → MCP 连接 → 历史重放开销
  - 事件驱动 Promise 门控替代 100ms 轮询，消息交付零延迟
  - 对话延迟不再随历史消息增长线性退化
  - 净减少约 106 行代码（删除 `executeRewind` 等死代码）

### Fixed
- **permissionMode 映射错误**：「自主行动」（auto）和「规划模式」（plan）权限模式实际使用了 `default`，现已正确映射到 SDK 的 `acceptEdits` 和 `plan`
- **订阅供应商误显可用**：未验证订阅的供应商不再显示为可用，发送按钮和 Enter 键增加供应商可用性守卫
- **持久 Session 启动超时死锁**：startup timeout 改用统一中止 `abortPersistentSession()`，解除 generator Promise 门控阻塞
- **Rewind SDK 历史未截断**：`resumeSessionAt` 在 pre-warm 中正确传递，确保 SDK 历史与前端同步截断
- **Rewind 后 AI 重复已回答内容**：assistant `sdkUuid` 改存最后一条消息（text）而非第一条（thinking），确保 `resumeSessionAt` 保留完整回复
- **超时链路对齐**：Cron 执行超时 11min → 60min，智谱 AI 超时 50min → 10min，Permission 等待 5min → 10min
- **用户消息气泡宽度**：最大宽度改为容器 2/3，文字先横向扩展再换行

---

## [0.1.17] - 2026-02-16

### Added
- **工作区记住模型和权限模式**：每个工作区独立保存最近使用的 model 和 permissionMode，切换时自动恢复

### Performance
- **Tab 切换性能深度优化**：隔离 isActive 到独立 TabActiveContext，content-visibility 延迟渲染，组件 memo + ref 稳定化，消除切换时全量重渲染

### Fixed
- **启动页图片粘贴报错** + Tab 栏单击不选中
- **首次启动卡死**：projects.json 损坏恢复 + 日志重复修复
- **Windows 更新重启 bun 进程未清理**：kill_process 改用 taskkill /T /F 杀进程树，新增 shutdown_for_update 阻塞等待所有进程退出，Settings 页更新按钮同步修复
- **JSON 持久化加固**：所有 JSON 配置文件统一使用原子写入（.tmp → .bak → rename），三级恢复链（.json → .bak → .tmp）+ 结构校验，防止进程崩溃导致数据丢失

---

## [0.1.16] - 2026-02-14

### Added
- **启动页改版——任务优先模式**：左侧 BrandSection 新增全功能输入框 + 工作区选择器，支持直接发送消息启动工作区
  - 工作区选择器：默认/最近打开分组、向上展开菜单
  - 输入框复用 SimpleChatInput，支持文本、图片、Provider/Model、权限模式、MCP 工具选择
  - 发送设置自动持久化，下次启动恢复上次选择
- **默认工作区 mino**：内置 openmino 预设工作区，首次启动自动复制到用户目录
- **Settings 默认工作区配置**：通用设置新增默认工作区选择，自定义 CustomSelect 替换原生 select
- **Windows setup 补充 mino 克隆**：`setup_windows.ps1` 与 macOS `setup.sh` 对齐

### Changed
- **Launcher 右侧面板精简**：移除快捷功能区块，工作区卡片精简为可点击双列紧凑卡片
  - 移除 Provider 选择器、启动按钮、三点菜单
  - 整卡点击启动，右键上下文菜单移除工作区
  - 工作区列表从单列改为双列 grid 布局
- **视觉统一与细节打磨**
  - Launcher 左右区域背景色统一，分割线改为不到顶的浮动线
  - Settings 侧边栏分割线同步改为浮动线
  - 品牌标题字号调小、字间距加宽，Slogan 更新为中文
  - MCP 工具菜单开关样式对齐设置页（accent 暖色 + 白色滑块）
  - Provider/MCP 静态卡片移除无效 hover 阴影
- **日志面板改版**：过滤器三组重构、新增导出功能、默认隐藏 stream/analytics

### Removed
- 移除 Launcher 死代码：subscriptionStatus 无用 API 调用、onOpenSettings 死 prop、QuickAccess 组件

---

## [0.1.15] - 2026-02-13

### Added
- **文件预览器 Markdown 本地图片加载**：相对路径引用的图片通过 download API 解析显示，支持 `./`、`../` 路径
- **MiniMax 预设新增模型**：M2.5、M2.5-lightning，M2.5 设为默认
- **文件预览器顶部信息优化**：文件大小改 KB/MB 格式、副标题改路径显示、新增「打开所在文件夹」按钮
- **macOS 路径显示缩短**：全局路径展示将 `/Users/<name>/` 替换为 `~/`

### Performance
- 流式渲染性能优化：消除级联重渲染，输入框/侧边栏不再卡顿

### Fixed
- 修复流式回复中段落分裂（防御性合并相邻文本块）
- 修复系统暗色主题导致 UI 颜色异常（强制日间模式）

---

## [0.1.14] - 2026-02-11

### Added
- **后台会话完成**：AI 流式回复中切换对话/关闭标签页不再丢失数据，旧 Sidecar 在后台继续运行直到回复完成
- **手动检查更新**：设置页「关于」区域增加检查更新按钮与下载进度展示
- **MCP 服务器编辑**：自定义 MCP 卡片增加设置按钮，复用添加弹窗编辑配置
- **新增预设供应商**：硅基流动 SiliconFlow（Kimi K2.5、GLM 4.7、DeepSeek V3.2、MiniMax M2.1、Step 3.5 Flash）
- **供应商「去官网」链接**：7 个预设供应商卡片增加官网入口
- **智谱 AI 新增 GLM 5 模型**
- **Settings 双栏布局**：供应商、MCP、技能、Agent 页面统一为双栏卡片网格

### Changed
- Settings 页面样式全面统一（Toggle、Button、Card、Input、Modal 共 24 处对齐）

### Fixed
- 修复首消息 5~13 秒延迟（stale resumeSessionId + 模型未同步导致阻塞）
- 修复编辑供应商保存时 API Key 被清空（React config 状态覆盖磁盘数据）
- 修复定时任务超时导致流式数据丢失（四层防御）
- 修复自定义 MCP 启用检测找不到系统 npx/node（PATH 环境变量未传递）
- 修复 MCP 设置按钮无响应 & 切换 Tab 残留 MCP 面板（Modal 渲染位置错误）
- 修复 Launcher 移除按钮使用未定义 CSS 变量 `--danger`
- 修复 Windows CSP 配置缺失导致 IPC 通信失败

---

## [0.1.13] - 2026-02-10

### Added
- **消息队列**：AI 响应中可追加发送消息，排队消息在当前响应完成后自动执行
  - 排队消息合并为右对齐半透明面板，支持取消和立即发送操作
  - 采用 Optimistic UI 模式，回车即清空输入框
  - 与心跳循环兼容：Cron 消息走正常队列，不中断当前 AI 响应
- **后台任务实时统计**：后台 Agent 运行时显示实时运行时间和工具调用次数
  - 通过轮询 output_file 获取增量数据，3 秒刷新
  - 折叠视图显示"后台"徽标和"(后台)"标签后缀
- **自定义服务商认证方式选择器**：创建/编辑自定义服务商时可选择 AUTH_TOKEN 或 API_KEY
- **工作区文件夹右键刷新**：文件夹右键菜单新增「刷新」按钮，ContextMenu 组件支持分隔线

### Changed
- **停止按钮三态交互**：点击停止按钮立即显示"停止中"视觉反馈（Loader 旋转），后端中断超时从 10s 缩短至 5s

### Fixed
- 修复历史会话切换供应商时 "Session ID already in use" 错误（区分历史/新会话的 resume 策略）
- 修复 Provider 切换时 pre-warm 未完成导致 resume 无效 session ID 的错误
- 修复 Cron single_session 模式下误中断当前 AI 响应
- 修复队列 SSE 事件未注册导致前端排队面板不显示
- 修复心跳循环状态栏背景透明导致内容透出
- 修复排队面板与心跳状态栏层级顺序（心跳始终紧贴输入框）

### Security
- 修复后台任务轮询端点路径穿越漏洞（resolve + homeDir 校验）
- 错误消息 ID 改用 crypto.randomUUID() 避免碰撞
- queue:started 广播携带 attachments，消除前端附件数据源不可靠隐患

---

## [0.1.12] - 2026-02-08

### Added
- **AI 输出路径可交互**：对话中内联代码如果是真实存在的文件/文件夹路径，自动显示虚线下划线，点击或右键弹出快捷菜单（预览、引用、打开所在文件夹）

### Fixed
- **Tab 栏触控板交互优化**：Mac 触控板轻触切换 Tab 不再误触发拖拽
- **Tab 关闭按钮偶尔无响应**：缩小拖拽监听范围至标题区域，扩大关闭按钮热区
- **Monaco Editor 大文件卡死**：延迟挂载编辑器 + 大文件自动降级纯文本模式
- **图片文件右键预览菜单**：右键菜单的「预览」选项现在对图片文件也可用

---

## [0.1.11] - 2026-02-06

### Added
- **Sub-Agent 能力管理**：为 AI 配备多种"专家角色"，模型自主判断何时委派
  - 支持全局 Agent（`~/.myagents/agents/`）和项目 Agent（`.claude/agents/`）双层管理
  - Agent 定义文件与 Claude Code 格式完全兼容（Markdown + YAML Frontmatter）
  - 可配置工具限制、模型选择、权限模式、最大轮次等
  - 项目工作区支持引入全局 Agent（引用机制，实时同步）
  - 启用/禁用控制，禁用的 Agent 不注入 SDK
  - 从 Claude Code 同步全局 Agent
- **Chat 侧边栏「Agent 能力」面板**：展示当前项目已启用的 Sub-Agents / Skills / Commands
  - 折叠/展开面板，按类型分组显示
  - 悬停查看描述，点击 Skill/Command 插入到输入框
  - 右键菜单快速跳转设置页
- **预置内置技能**：开箱即用 6 个常用技能
  - docx（Word 文档）、pdf、pptx（PPT）、xlsx（Excel）、skill-creator（技能创建向导）、summarize（内容摘要）
  - 首次启动自动种子到 `~/.myagents/skills/`，不覆盖用户已有内容
- **全局技能启用/禁用**：Settings 技能列表支持 toggle 开关
  - 禁用的技能不出现在 `/` 斜杠命令和能力面板中
  - 状态持久化到 `~/.myagents/skills-config.json`

### Changed
- **统一 Session ID 架构**：通过 SDK 0.2.33 新特性消除双 ID 映射，新 session 在产品层和 SDK 层使用同一 ID
- 升级 Claude Agent SDK 到 0.2.34
- **SDK 预热机制**：打开 Tab 时提前启动 SDK 子进程和 MCP 服务器，消除首次发送消息的冷启动延迟
  - 500ms 防抖批量处理快速配置变更
  - 预热失败自动重试（最多 3 次），配置变更时重置
  - 预热会话对前端不可见，首条消息时无缝切换为活跃状态
- **MCP 版本锁定**：预设 MCP 服务（Playwright）锁定到具体版本号，避免每次启动的 npm 注册表查询延迟（2-5s）
- **网络代理设置移至「通用」**：从「关于 - 开发者模式」移至「通用设置」，普通用户可直接使用
- Settings 页面新增 Agents 分区，与 Skills 平级
- WorkspaceConfigPanel 新增 Agents Tab

---

## [0.1.10] - 2026-02-05

### Added
- **定时任务功能**：让 AI Agent 按设定周期自动执行任务
  - 支持设置任务间隔时间（分钟）
  - 多种结束条件：截止时间、执行次数、AI 主动退出
  - 运行模式：单 Session 持续执行 / 每次新建 Session
  - 任务运行时输入框显示状态遮罩，支持查看设置和停止任务
  - 历史记录中显示「定时」标签标识
- **后台运行支持**：应用可最小化到系统托盘持续运行
  - 点击关闭按钮最小化到托盘（可在设置中关闭）
  - 托盘右键菜单：打开、设置、退出
  - macOS 点击 Dock 图标恢复窗口
  - macOS 菜单栏使用标准模板图标
  - 退出时若有运行中任务会弹窗确认
- **通用设置页面**：新增「通用」设置 Tab
  - 开机启动开关
  - 最小化到托盘开关
  - 任务消息通知开关
- **技术架构升级**：Session-Centric Sidecar 管理，支持多入口（Tab/定时任务）共享 Agent 实例

---

## [0.1.9] - 2026-02-02

### Added
- **MCP 零门槛使用**：预设 MCP（如 Playwright）使用内置 bun 执行，无需安装 Node.js
- **MCP 运行时检测**：启用自定义 MCP 时自动检测命令是否存在，不存在则弹窗引导下载
- **系统通知**：AI 任务完成、权限请求、问答确认时自动发送系统通知（窗口失焦时）
- 技能/指令卡片展示作者信息
- Chat 页面顶部显示当前项目名称

### Changed
- 项目设置只展示项目级数据，新增「查看用户技能/指令」跳转链接
- 项目设置图标改为黑底白色齿轮
- 输入框视觉优化：更大的字号和行高
- 快捷功能卡片改为横向布局
- 项目工作区折叠按钮移至标题栏最右端

### Fixed
- 彻底修复 Chat 页面滚动回弹问题
- **Windows 10 1909 兼容性修复**：安装程序自动安装 Git for Windows（Claude Agent SDK 依赖）

---

## [0.1.8] - 2026-02-01

### Added
- **Analytics 系统**
  - 匿名使用统计，帮助改进产品体验
  - 默认关闭，需通过环境变量 `MYAGENTS_ANALYTICS_ENABLED=true` 启用
  - 支持事件批量发送、防抖、节流（每分钟最多 200 事件）
  - 数据加密传输，不收集任何敏感信息（代码、对话内容等）
  - device_id 持久化存储到 `~/.myagents/device_id`（跨安装保持一致）


---

## [0.1.7] - 2026-01-31

### Added
- Windows 平台开发工具（`build_dev_win.ps1`）
- 设置页面「关于」新增用户交流群二维码（自动缓存，离线可用）
- 代理配置支持（Settings > About > Developer Mode）
  - 支持 HTTP/HTTPS/SOCKS5 协议
  - 自动应用于 Claude Agent SDK 和应用更新下载

### Changed
- 改进 Windows 安装器升级体验，支持直接覆盖安装（无需先卸载旧版本）
- 优化网络连接池配置（降低资源占用）

### Fixed
- **Windows 平台关键修复**：
  - 修复 Windows 生产包无法启动的问题
  - 修复 Sidecar 连接失败（代理配置冲突）
  - 修复 Windows Tauri IPC 通信错误（CSP 配置不完整）
  - 修复构建脚本导致的配置缓存问题
  - 修复启动页工作区名称显示完整路径（应显示文件夹名）
  - 修复工具徽章 Windows 路径显示问题（3 处）
- 修复二维码加载失败问题（Windows CSP 限制）
- 修复代理环境下 localhost 连接失败
- 修复 Tab 关闭确认对话框无效（正在生成时关闭未被阻止）
- 修复 Windows 关闭最后一个 Tab 时程序退出
- 修复 React ref 在渲染期间更新（ESLint 警告）
- 修复多项代码质量问题（进程清理竞态、错误处理等）

### Technical
- 统一代理配置模块，消除代码重复
- Tab 关闭确认重构：使用 ConfirmDialog 替代 window.confirm()（符合 React 声明式编程）
- 路径处理标准化：优先使用 Tauri `basename()` API，同步场景使用 `/[/\\]/` 正则
- 完善错误处理和日志记录
- 增强构建脚本健壮性（清理验证、容错处理）
- 新增技术文档：代理配置、构建问题排查、Windows 平台指南

**详见**: [specs/prd/prd_0.1.7.md](./specs/prd/prd_0.1.7.md)

---

## [0.1.6] - 2026-01-30

### Added
- **Windows 客户端支持**
  - NSIS 安装包 (`MyAgents_x.x.x_x64-setup.exe`)
  - 便携版 ZIP (`MyAgents_x.x.x_x86_64-portable.zip`)
  - 自动更新支持（共用 Tauri 签名密钥）
- 新增 Windows 构建脚本
  - `setup_windows.ps1` - 环境初始化
  - `build_windows.ps1` - 构建脚本
  - `publish_windows.ps1` - 发布脚本（含 `latest_win.json` 生成）
- 新增 `src/server/utils/platform.ts` 跨平台工具模块
- **支持 `server_tool_use` 内容块类型**（第三方 API 如智谱 GLM-4.7 的服务端工具调用）
- **设置页面添加用户交流群二维码**
  - 位于「关于」页面，从 R2 动态加载
  - 网络异常时自动隐藏
  - 新增 `upload_qr_code.sh` 上传脚本
- **MCP 表单 UI 改进**
  - 优化服务器配置表单交互体验

### Changed
- `runtime.ts` 支持 Windows 路径检测 (`bun.exe`, `%USERPROFILE%\.bun`, etc.)
- `sidecar.rs` 支持 Windows 进程管理 (`wmic` + `taskkill`)
- 统一跨平台环境变量处理（消除 10+ 处重复代码）
- **全局视觉优化与设计规范更新**
- 工作区右键菜单「快速预览」改为「预览」
- **会话统计 UI 优化**
  - 「缓存读取」改为「输入缓存」（= cache_read + cache_creation）
  - 消息明细新增「输入缓存」列

### Fixed
- 修复 Windows 自定义标题栏按钮无效（缺少 Tauri 权限）
- 修复 UI 卡在 loading 状态（`chat:system-status` 事件未注册 + React 批量更新延迟）
- 修复 `MultiEdit` 工具完成后工作区不刷新
- 修复 MCP 服务器和命令系统的 Windows 跨平台路径问题
- 修复智谱 GLM-4.7 `server_tool_use` 的输入解析（JSON 字符串 → 对象）
- 过滤智谱 API 返回的装饰性工具文本（避免干扰正常内容显示）
- **Token 统计修复**
  - 从 SDK result 消息提取统计数据（更可靠）
  - 支持多模型分别统计（新增 `modelUsage` 字段）
  - 修复智谱/Anthropic 等供应商统计数据为 0 的问题
- 修复流式输出中空白 chunk 过滤（保留有效换行和空格）
- 修复进程终止信号被错误保存为错误消息
- 为未知工具添加兜底图标 (Wrench)

### Technical
- Windows 数据目录：`%APPDATA%\MyAgents\`
- 添加 `buildCrossPlatformEnv()` 统一子进程环境变量构建
- 使用 `flushSync` 强制同步关键 UI 状态更新
- 装饰性文本过滤使用多条件匹配，避免误伤正常内容
- 新增 `ModelUsageEntry` 类型支持按模型分组存储 token 统计

**详见**: [specs/prd/prd_0.1.6.md](./specs/prd/prd_0.1.6.md)

---

## [0.1.5] - 2026-01-29

### Added
- 添加网络代理设置功能（开发者模式）
  - 支持 HTTP/SOCKS5 协议
  - 设置入口：设置 → 关于 → 点击 Logo 5次 → 开发者区域
  - Sidecar 启动时自动注入 HTTP_PROXY/HTTPS_PROXY 环境变量

### Changed
- 升级 Claude Agent SDK 从 0.2.7 到 0.2.23
- 建立 E2E 测试基础设施（Anthropic/Moonshot 双供应商测试）
- 统一 `/api/commands` 端点的命令解析逻辑
  - 使用 `parseFullCommandContent()` 替代 `parseYamlFrontmatter()`
  - 优先使用 frontmatter.name，回退到文件名
  - 提取 `scanCommandsDir()` 消除代码重复
- 统一版本记录到 CHANGELOG.md（移除 specs/version.md）

### Fixed
- 修复全局用户指令在对话 `/` 菜单中不显示的问题
  - `/api/commands` 端点新增扫描 `~/.myagents/commands/` 目录

### Technical
- 代理设置提取 `PROXY_DEFAULTS` 常量，消除魔数
- 添加 `isValidProxyHost()` 验证函数
- Rust 侧同步添加默认值常量

---

## [0.1.4] - 2026-01-29

### Added
- 支持编辑自定义供应商的名称、云服务商标签、Base URL、模型列表
- 编辑面板内增加「删除」按钮，附确认弹窗
- 删除供应商时自动切换受影响项目到其他可用供应商
- 模型标签 hover 显示删除按钮（用户添加的模型可删除）
- 预设供应商支持用户添加自定义模型
- 预设模型显示「预设」标签，不可删除
- 历史记录显示消息数和 Token 消耗统计
- 新增统计详情弹窗（按模型分组、消息明细）
- 无 MCP 工具时显示引导文案，链接至设置页面
- 工作区右键菜单「引用」（文件/文件夹/多选均支持插入 `@路径`）
- 新建技能对话框增加「导入文件夹」选项（桌面端）
- Moonshot 供应商新增 Kimi K2.5 模型

### Changed
- 消息存储升级为 JSONL 格式（O(1) 追加，崩溃容错）
- 增量统计计算、行数缓存、文件锁机制
- Tab 切换时自动同步供应商、API Key、MCP 配置
- Slash 命令菜单键盘导航时自动滚动保持选中项可见

### Fixed
- 修复消息中断后 Thinking Block 卡在加载状态
- 修复 API Key 模式切换到订阅模式报错（`Invalid signature in thinking block`）
- 修复长文本（如 JSON）在消息气泡中不换行
- 修复历史记录「当前」标签不更新
- 修复历史记录按钮点击无法关闭
- 修复加载历史会话后新消息统计不更新
- 修复 switchToSession 未终止旧 session 导致模型/供应商切换失效
- 修复三方供应商切换到 Anthropic 官方时 thinking block 签名冲突
- 修复第三方供应商模型切换后 UI 卡住（thinking/tool 块加载状态未结束）
- 修复 AI 回复完成后 Loading 指示器和停止按钮卡住（补全 9 种结束场景的 sessionState 重置）
- 修复发送消息后不自动滚动到底部
- 修复系统任务（如 Compact）期间显示停止按钮的误导
- 修复进程泄露问题（SDK/MCP 子进程随应用关闭正确清理）
- 优化文件预览性能（React.lazy + useMemo 缓存）

### Technical
- 应用退出支持 Cmd+Q 和 Dock 右键退出的进程清理（RunEvent::ExitRequested）
- 进程清理函数重构，统一 SIGTERM → SIGKILL 两阶段关闭
- 启动时清理扩展至 SDK 和 MCP 子进程

**详见**: [specs/prd/prd_0.1.4.md](./specs/prd/prd_0.1.4.md)

---

## [0.1.3] - 2026-01-27

### Added
- 支持从 Claude Code 同步 Skills 配置（`~/.claude/skills/` → `~/.myagents/skills/`）
- ProcessRow 显示任务运行时间
- 展开状态显示实时统计信息（工具调用次数、Token 消耗）
- 新增 Trace 列表查看子代理工具调用记录
- Settings 页面增加 Rust 日志监听

### Changed
- 技能/指令详情页焦点控制优化
- 描述区域支持多行输入
- 内容区域高度自适应视口

### Fixed
- 修复 Toast/ImagePreview Context 稳定性问题
- 统一 useEffect 依赖数组规范
- 统一定时器初始化模式
- 修复权限弹框重复弹出问题
- 修复 Settings 页面事件监听竞态条件
- 修复 tauri-plugin-updater 架构目标识别问题
- 移除非标准 platform 字段，符合 Tauri v2 官方 schema
- 修复事件发射错误处理
- 修复更新按钮样式（emerald 配色 + rounded-full）

### Technical
- 增加文件描述符限制至 65536，防止 Bun 启动失败
- 添加 `--myagents-sidecar` 标记精确识别进程
- 实现两阶段清理机制（SIGTERM → SIGKILL）
- 明确 Tab Sidecar 与 Global Sidecar 使用边界
- Settings/Launcher 不再包裹 TabProvider
- Release 构建启用 INFO 级别日志支持诊断
- 调试日志包装 `isDebugMode()` 避免生产环境刷屏

**详见**: [specs/prd/prd_0.1.3.md](./specs/prd/prd_0.1.3.md)

---

## [0.1.2] - 2026-01-25

### Added
- 实现自定义服务商完整的 CRUD 功能
- 服务商配置持久化到 `~/.myagents/providers/`

### Fixed
- 修复 MCP 开关状态与实际请求不一致问题
- 初始化时始终同步 MCP 配置（包括空数组）
- MCP 变化时正确重启 SDK 会话
- 切换配置时保持对话上下文（通过 resume session_id）
- 修复 AI "失忆" 问题
- 实现用户级 Skill 按需复制到项目目录
- `/` 菜单去重（项目级优先）
- 修复详情页交互问题（保存后自动关闭、名称字段、路径重命名）
- 修复 `/cost` 和 `/context` 命令输出不显示问题
- 正确处理 `<local-command-stdout>` 包裹的字符串内容

### Changed
- 设置页版本号动态读取
- 日志规范化（生产环境不输出调试日志）

**详见**: [specs/prd/prd_0.1.2.md](./specs/prd/prd_0.1.2.md)

---

## [0.1.1] - 2026-01-26

### Added
- 添加订阅凭证真实验证功能
- 设置页显示验证状态（验证中/已验证/验证失败）
- 支持拖拽文件到工作区文件夹
- 支持 Cmd+V 粘贴文件到工作区
- 支持拖拽/粘贴文件到对话输入框（自动复制到 `myagents_files/`）
- AskUserQuestion 工具向导式问答 UI
- 单选自动跳转 / 多选手动确认
- 自定义输入框支持
- 进度指示器和回退修改
- Agent 日志懒加载创建
- 日志存储到 `~/.myagents/logs/`
- React/Bun/Rust 日志统一到 UnifiedLogs 面板

### Fixed
- 修复 Anthropic 订阅检测逻辑（`~/.claude.json` 中的 `oauthAccount`）

### Changed
- 文件名冲突自动重命名
- Cmd+Z 撤销支持
- 30 天日志自动清理

**详见**: [specs/prd/prd_0.1.1.md](./specs/prd/prd_0.1.1.md)

---

## [0.1.0] - 2026-01-24

### Added
- Initial open source release
- Native macOS desktop application with Tauri v2
- Multi-tab support with independent Sidecar processes
- Multi-project management
- Claude Agent SDK integration
- Support for multiple AI providers:
  - Anthropic (Claude Sonnet/Haiku/Opus 4.5)
  - DeepSeek
  - Moonshot (Kimi)
  - Zhipu AI
  - MiniMax
  - Volcengine
  - OpenRouter
- Slash Commands (built-in and custom)
- MCP integration (STDIO/HTTP/SSE)
- Tool permission management (Act/Plan/Auto modes)
- Visual configuration editor for CLAUDE.md, Skills, and Commands
- Keyboard shortcuts (Cmd+T, Cmd+W)
- Local data storage in `~/.myagents/`

### Technical
- React 19 + TypeScript frontend
- Bun runtime bundled in app
- Rust HTTP/SSE proxy layer
- Chrome-style frameless window
- 零外部依赖（内置 Bun 运行时）

**详见**: [specs/prd/prd_0.1.0/](./specs/prd/prd_0.1.0/) (21 个迭代 PRD)

---
