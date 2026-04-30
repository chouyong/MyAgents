# macOS WKWebView 方向键 NSFunctionKey 泄漏 — 全面调研与修复路线

> 截止 2026-04-30，本项目已经在该问题上提交 5 次修复（c5363ab9 → 639fcd62），但用户在 0.2.5 dev 分支仍能稳定复现：连续按 ←/→ 时输入框出现 □ tofu 字符。本文档梳理目前已知的所有可能性、事实证据、被排除的路径以及下一步根治方案。

## 1 现象

- 平台：macOS / Tauri 2 / wry 0.54.4 (objc2 generated `WryWebView0.54.4`)
- 触发：在 `<textarea>` 输入框中连续按 ←/→（尤其是按住 key-repeat），输入框中出现 U+F700-F74F 范围的 NSFunctionKey 私有码点，渲染为 □ 或字体回退字形
- 用户截图：`□□□V 缸悍 V 过好几个□□□□`
- 影响：输入体验严重受损；发送给 sidecar 的内容也带毒

## 2 已知背景（上游）

| 上游 | 状态 | 说明 |
|------|------|------|
| [tauri-apps/tauri#5685](https://github.com/tauri-apps/tauri/issues/5685) | Closed by wry#769 (2022) | 老版本箭头键乱码，wry 0.22.5 修过一次 |
| [tauri-apps/wry#1175](https://github.com/tauri-apps/wry/issues/1175) | **OPEN** | 箭头键回归（2024-02） |
| [tauri-apps/tauri#10194](https://github.com/tauri-apps/tauri/issues/10194) | **OPEN** | `unstable` feature 开启后箭头键产生无效字符（2024-07） |
| wry objc2 迁移 | 2024Q4 | 老的 keyDown 拦截在迁移过程中丢失 |

我们项目启用了 `tauri/unstable`（child webview / in-app browser 必需），所以稳定踩到该 regression。wry 0.55.0（2026-03-26）仍未官方修复。

## 3 当前两层防护

### 3.1 Rust 层 `src-tauri/src/macos_arrow_filter.rs`

ObjC 方法表 swizzle，在 `WryWebView` 类上挂三个方法：

| Selector | 作用 | 当前观测 |
|----------|------|---------|
| `keyDown:` | 探针：log keycode/characters，并 super 转发 + 调度 DOM cleanup JS | **128 次/会话** 命中 |
| `insertText:` | 拦截纯函数键文本（`object_is_pure_function_key_text`），不转发 super | **0 次** 命中 |
| `insertText:replacementRange:` | 同上 | **0 次** 命中 |

DOM cleanup 脚本（`FUNCTION_KEY_DOM_CLEANUP_JS`）通过 `webview.evaluateJavaScript_completionHandler(script, None)` 调度，对 `document.activeElement` + 所有 `textarea/input` + contentEditable 做 5 次 retry：micro-task / rAF / setTimeout(0) / setTimeout(32) / 同步首次。

**问题**：completion handler 是 `None`，**脚本运行结果没有任何上报**，等同黑盒。

### 3.2 JS 层 `src/renderer/utils/macFunctionKeyGuard.ts`

document level capture-phase 监听：

| 事件 | 处理 |
|------|------|
| `beforeinput` | `inputType==='insertText'/'insertReplacementText'` 且 data 含 U+F700-F74F → `preventDefault()` |
| `input` | 读 `el.value`，若含坏码点则用 prototype 原生 setter 改写，复原选区 |

**问题**：unified log 中 0 条 `[macFunctionKeyGuard]` 输出 → 这两个事件**根本没有为泄漏触发过**。

## 4 泄漏路径推断

把上面两层防护的命中数对齐：
- `insertText:` ObjC 路径 — **0 次命中**
- WebCore `beforeinput` — **0 次命中**
- WebCore `input` — **0 次命中**
- `keyDown:` ObjC 路径 — **128 次命中**

结论：**WebKit 在 keyDown 内部沉默地把 NSFunctionKey 私有码点写入 textarea 的 DOM value，既不发 input 事件、也不走 insertText: 选择器**。这是 wry 0.54.4 + WKWebView 当前版本的一个特殊路径——`-[NSResponder interpretKeyEvents:]` 被绕开，但 WebKit 的 `EditorClient` 内部仍把 characters 串当成默认文本插入了 shadow DOM 的内部 element。

唯一兜底是 Rust → JS 的 DOM cleanup 脚本。但用户截图证明它**没擦干净**。可能原因清单：

| # | 假设 | 检验方法 | 说明 |
|---|------|---------|------|
| H1 | cleanup script 没执行（completion None 隐藏错误） | 改成 Some(block) 上报结果 + 加 console.warn | 最先排查 |
| H2 | cleanup 执行时 DOM 还没被 WebKit mutate（race）| 在脚本内 log 每次 retry 看到的 value 长度/字节 | 5 次 retry 跨 32ms 应该能覆盖 |
| H3 | `document.activeElement` 因 KVO/shadow root 拿不到 textarea | 脚本里 log activeElement 类名 + tag | 已遍历 textarea/input，应该 OK |
| H4 | Key-repeat 速度 > 清理速度（按住箭头连续灌入） | log 每次 cleanup 删除字符数 | 多次 retry 还能撑住 |
| H5 | IME 组合状态下 cleanup 触发 onCompositionEnd 把 dirty 值抢回 | 截图确实有中文字 → 可能 IME 中 | 需要排查 composition flag |
| H6 | React controlled value 在 cleanup 后又把 dirty 值写回 | 最不可能：onChange 没 fire 时 React state 是 clean，re-render 不会反向覆盖 | 排除 |
| H7 | `nativeValueSetter` 路径 + `dispatchInput('deleteContentBackward')` 触发 React onChange，但 React state 已被前一次脏值“污染”（因为某条路径 input 事件**确实** fire 过）| 翻 React DevTools / 加 onChange 日志 | 与 H6 相反，需要数据 |
| H8 | 多 webview（child webview / in-app browser）触发的 keyDown 跑到错误 webview 的 JS 上下文 | log webview pointer + window.location.href | unstable feature 下 child webview 是真实在场 |
| H9 | `evaluateJavaScript_completionHandler(_, None)` 的 None 在 objc2_web_kit 0.6 下被错误解释为 nil block，导致脚本不触发 | 加 Some(block) 测试 | 待 Some 化后排除 |
| H10 | swizzle 装早了 — keyDown 实际命中的是 KVO subclass，但我们装在 generated class | 已经处理（兼容 KVO subclass） | 排除 |
| H11 | WebKit 在 keyDown 之后插入了私有码点，但 DOM cleanup 之后**新一次 keyDown** 又灌入新的，循环超过 retry 上限 | log 累计删除数 vs 累计 keyDown 数 | 需要数据 |
| H12 | 真实泄漏是 `el.value` 之外（比如 contentEditable、shadowRoot 内一个未对外暴露的元素） | log shadowRoot 内容 | textarea 内部有 shadow，但暴露 value |
| H13 | DOM cleanup 在 capture phase 替换值后 React re-render 把 prevState 写回（state ≠ value 短暂窗口） | 翻 React 18 batching | 上文已分析为不可能（state 未变） |
| H14 | 我们的 `setValue + dispatchInput` 触发的 input 事件被 macFunctionKeyGuard.onInput 再次走 strip 路径，递归 → 无穷或栈溢出 | 加 reentrancy guard | 不至于死锁但会浪费 CPU |
| H15 | WebKit 的内部 keyDown 处理是异步派发到 web 进程的（多进程模式），cleanup JS 在脏值落地前就跑完了 5 次 retry | 加更长 retry（120ms / 250ms） | 可能 |

---

## 5 修复策略（自顶向下）

### Plan A — 立即可观测化（必做）

1. **Rust 侧**：把 `evaluateJavaScript_completionHandler(_, None)` 改成 `Some(block)`，把脚本返回值（删除字符数 / scan 数 / activeElement tag / value 哈希）回流到 ulog。
2. **JS 脚本**：内部加 `console.warn('[arrow-cleanup] pass=...')`，每个 retry 阶段都要 log。
3. **JS guard**：加一个全局 `keydown` capture listener。即便 `input/beforeinput` 不 fire，我们也在 keydown 后立即 schedule 同样的 strip 逻辑（micro-task + rAF + setTimeout 0/32/120/250）。

### Plan B — keydown 兜底层（强）

JS 端在 `installMacFunctionKeyGuard` 内追加：

```ts
document.addEventListener('keydown', onKeyDown, { capture: true });

function onKeyDown(e: KeyboardEvent) {
  if (!isArrowOrFunction(e.key)) return;
  scheduleScrub();   // micro-task + rAF + setTimeout(0) + (32) + (120)
}

function scheduleScrub() {
  const run = () => scrubAllInputs();
  queueMicrotask(run);
  requestAnimationFrame(run);
  setTimeout(run, 0);
  setTimeout(run, 32);
  setTimeout(run, 120);
}
```

`scrubAllInputs()` 复用 `flushIfLeaked` 逻辑，但不再依赖 `input` 事件触发。

### Plan C — 上游级阻断（最强）

如果 Plan A/B 仍有漏网，转向**直接在 ObjC 层吞掉私有码点的 keyDown 事件**：当 `keyDown:` 收到 event 且 `characters` 是 **纯** F700-F74F（无其他字符）且不是 modifier-only，构造一个新的 NSEvent 把 characters 替换成空串再 super 转发。这能让 WebKit 的 keyDown 处理代码不再看到坏码点 → 不会写入 DOM。

风险：如果 WebKit 依赖 characters 字段判断"这是箭头键，要移动光标"，吞掉会让光标停。需要先用 Plan A 的数据确认 WebKit 是从 keycode 还是 characters 判断方向。

实际上 WebKit `KeyboardEvent::keyIdentifierForKeyEvent` 是从 keycode 解析的，characters 只决定 `event.key` / `event.data` 文本。所以替换 characters 应该安全。

### Plan D — 不依赖 wry 类继承的最终保险（可选）

如果未来 wry 上游修了，但我们想保留兜底：在 `WKUserScript.atDocumentStart` 注入 macFunctionKeyGuard 加强版（带 keydown listener 的版本），不依赖 ESM bundle，保证即使 React 还没 mount 也已生效。

## 6 优先级

P0：Plan A + Plan B（一次提交）
P1：本地复现 + 看新日志，决定是否需要 Plan C
P2：Plan D（保险，可后置）

## 7 根因（2026-05-01 实测确认）

经过加可观测性 + 码点 dump 后定位：**泄漏字符是 ASCII C0 控制字符 U+001C-U+001F，不是 NSFunctionKey 私有码点**。

| 码点 | ASCII 名称 | macOS 方向键映射 |
|------|-----------|-----------------|
| U+001C | FS (File Separator) | ←  Left Arrow |
| U+001D | GS (Group Separator) | →  Right Arrow |
| U+001E | RS (Record Separator) | ↑  Up Arrow |
| U+001F | US (Unit Separator) | ↓  Down Arrow |

NSEvent.characters 同时存储了两套表示：
- **NSFunctionKey 系列 U+F700-F74F**（Cocoa 命名）— Rust probe 看到的是这一套
- **ASCII C0 控制字符 U+001C-U+001F**（旧 ANSI）— **WebKit 实际写到 textarea.value 的是这一套**

Rust 的 keyDown probe 日志 `chars=class=__NSCFString len=1 units=[U+F702]` 误导了我们 5 次提交 —— 那是 NSEvent 层 characters 的 NSFunctionKey 表示，但 WebKit 内部把它转成 C0 控制字符再喂给 DOM insert 路径。

**修复**：所有过滤器（JS / Rust ObjC `object_is_pure_function_key_text` / Rust 内嵌 cleanup 脚本正则）都加上 `0x001C-0x001F` 匹配。

实测截图里的 □ 字符就是 U+001C/U+001D —— 没有字体渲染 C0 控制字符，所以显示为 tofu。

## 8 后续场景：Cmd+V on empty clipboard 同样泄漏

修好方向键后用户发现：在空剪贴板状态下按 Cmd+V，输入框出现 `abc☐vv☐☐☐☐` —— 同样是控制字符泄漏，但码点不止 U+001C-1F。

观察：Cmd+V 失败时 macOS 的 keyDown fallback 会把 `Ctrl+V = U+0016 SYN` 等 C0 控制字符塞进 DOM。同理任何 Cmd/Ctrl+letter 没有绑定的快捷键，都可能漏出对应的 ASCII control 码点。

**修复**：把过滤范围从两个窄段扩展到**所有不合法的 C0/C1 控制字符**——只保留 Tab (U+0009)、LF (U+000A)、CR (U+000D) 三个合法 C0 控制字符，其余 C0 (U+0000-U+001F)、DEL (U+007F)、C1 (U+0080-U+009F)、NSFunctionKey (U+F700-U+F74F) 全部当作泄漏。

逻辑：textarea / input 不应该出现任何不可见的控制字符（除了换行）。这是输入卫生的硬规则，不是修复某个特定 leak — 是消除整个 leak 类别的根本对策。

同时在 JS 侧把 keydown scrub 触发条件扩展到带 `metaKey` / `ctrlKey` 的任意按键，并加 `paste` capture listener。

## 9 验证清单

- [ ] 连续按 ← 100 次（key-repeat），输入框无 □
- [ ] 中文 IME composition 中按 ←/→，无 □ 且不打断 IME
- [ ] 在 launcher 输入框、Chat 输入框、ThoughtInput 三处分别复测
- [ ] `unified-{date}.log` 中 cleanup pass 命中数 ≥ keyDown probe 命中数（说明每次 keyDown 都被擦干净了）
- [ ] 边界场景：cursor 在文本起点按 ←、cursor 在末尾按 →（最容易触发泄漏）
- [ ] window switch / multi-tab 切换后再按方向键仍生效
