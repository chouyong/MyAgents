# MyAgents Windows 本地启动与打包备忘

本文档记录 2026-05-17 在 Windows 本地从源码拉起 `MyAgents`、排查问题、验证首启状态，以及构建 Windows 可分发安装包时的关键经验。内容基于本次实际操作整理，默认仓库根目录为当前工作区。

## 结论摘要

- 这个项目不是纯 Node.js 服务，而是 `Tauri + React + Node sidecar + Rust` 桌面应用。
- Docker 里的 Node.js 不能替代 Windows 主机上的 Tauri 构建与运行环境。
- 开发模式已经成功拉起，应用窗口已打开，首启日志未发现应用级配置报错。
- Windows 安装包已经成功生成。
- 构建命令最终返回非零退出码，不是因为安装包没生成，而是因为当前环境缺少 `TAURI_SIGNING_PRIVATE_KEY`，导致 updater 签名步骤报错。

## 本次实际遇到的问题

### 1. `tauri dev` 常驻被误判为失败

现象：
- `tauri dev` 长时间不退出。

判断：
- 这是开发模式正常行为，不能仅凭命令是否退出判断失败。
- 需要结合窗口是否打开、sidecar 是否启动、健康检查是否通过来判断。

正确判断方式：
- 记录启动日志到 `tauri-dev.log`。
- 重点检查是否出现以下信号：
  - `Global sidecar started on port 31415`
  - `TCP health check passed`
  - `GET http://127.0.0.1:31415/... -> 200`
  - `No update available, already on latest version`

### 2. 缺少 `cuse` 二进制

报错：
- `resource path 'binaries\\cuse-x86_64-pc-windows-msvc.exe' doesn't exist`

解决：

```powershell
.\scripts\download_cuse.ps1
```

成功标志：
- 生成 `src-tauri\binaries\cuse-x86_64-pc-windows-msvc.exe`

### 3. 缺少 VC++ Runtime DLL

报错：
- `resource path '..\src-tauri\resources\vcruntime140.dll' doesn't exist`

解决：

```powershell
Copy-Item "$env:SystemRoot\System32\vcruntime140.dll" "src-tauri\resources\vcruntime140.dll" -Force
Copy-Item "$env:SystemRoot\System32\vcruntime140_1.dll" "src-tauri\resources\vcruntime140_1.dll" -Force
```

成功标志：
- `src-tauri\resources\` 下存在这两个 DLL

### 4. 缺少默认工作区 `mino`

报错：
- `resource path '..\mino' doesn't exist`

解决：

```powershell
git clone https://github.com/hAcKlyc/openmino.git mino
```

后续必须处理：
- `mino` 仅作为 bundled workspace 资源使用时，构建前应删除 `mino\.git`
- 仓库自带的 `setup_windows.ps1` 也是这么做的

原因：
- `.git` 会被 Tauri 当作资源递归扫描
- 在 Windows 上容易触发权限报错或导致 `rerun-if-changed` 扫描过重

### 5. 缺少 `src-tauri\resources\nodejs`

报错：
- `resource path '..\src-tauri\resources\nodejs' doesn't exist`

处理策略：
- 先确保目录存在并可被 Tauri 打包
- 之后再尽量缩小体积，避免把不必要内容塞进安装包

本次经验：
- 一开始直接复制了完整本机 Node 安装目录，体积过大
- 后来改成精简版 `nodejs` 目录，只保留：
  - `node.exe`
  - `npm`
  - `npm.cmd`
  - `npx`
  - `npx.cmd`
  - `node_modules`

结果：
- 精简后目录约 97.7 MB
- 后续 NSIS 打包稳定性明显更好

### 6. 缺少预打包资源，不是源码逻辑错误

典型缺失项：
- `src-tauri\resources\server-dist.js`
- `src-tauri\resources\plugin-bridge-dist.mjs`
- `src-tauri\resources\cli\myagents.js`
- `src-tauri\resources\tsx-runtime`
- `src-tauri\resources\sharp-runtime`
- `src-tauri\resources\claude-agent-sdk\claude.exe`

处理思路：
- 这些问题本质上是发布资源没有预生成，不是前端或 Rust 业务代码报错。
- 应优先补齐打包资源，而不是误判为源码 bug。

### 7. `tsx-runtime` 构建时遇到 npm 缓存权限问题

现象：
- npm 往全局缓存目录写入时报 `EPERM`

解决：

```powershell
$env:npm_config_cache='D:\knowledgeBase\MyAgents\.npm-cache'
```

说明：
- 把 npm 缓存改到工作区本地目录后，安装和构建更稳定。

### 8. NSIS 脚本变量误解析告警

现象：
- `makensis` 早期出现 `warning 6000`

原因：
- `src-tauri\nsis\hooks.nsh` 中的 PowerShell 变量写法会被 NSIS 误解析

解决：
- 将会被 NSIS 解析的 `$变量` 改为 `$$变量`

结果：
- 手动运行 `makensis` 后，该告警已消失

### 9. 正式打包卡在 `mino\.git`

报错特征：
- 构建扫描到 `..\mino\.git\objects\pack\...`
- Windows 返回 `拒绝访问。 (os error 5)`

解决：

```powershell
Remove-Item -Recurse -Force mino\.git
```

结果：
- 删除后，构建不再卡在这个权限问题

### 10. 发布脚本的前置联网检查不稳定

现象：
- `build_windows.ps1` 会尝试联网拉取 `cuse latest.json`
- 还会尝试在线升级 bundled npm
- 本地资源虽然已经齐全，但握手失败时仍会提前退出

结论：
- 这属于脚本前置检查的网络脆弱性，不代表本地构建资源缺失
- 当 `src-tauri\binaries`、`src-tauri\resources` 已就绪时，可以直接执行最终的 Tauri build 命令

## 本次用于恢复构建的关键命令

```powershell
npm install
cargo fetch
.\scripts\download_cuse.ps1
git clone https://github.com/hAcKlyc/openmino.git mino
npm run build:server
npm run build:bridge
npm run build:cli
$env:npm_config_cache='D:\knowledgeBase\MyAgents\.npm-cache'
npm run build:tsx-runtime -- win32 x64
npm run tauri:dev
```

正式打包实际使用：

```powershell
npm run tauri:build -- --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json
```

## 如何判断首启已经成功

不要只看“页面打开了”，至少同时满足以下几点：

- Tauri 应用窗口已正常显示
- `tauri-dev.log` 中出现 sidecar 启动成功日志
- 健康检查通过
- 本地 HTTP 接口返回 200
- updater 检查流程正常结束

本次日志中的有效成功信号包括：

- `Global sidecar started on port 31415`
- `TCP health check passed`
- `GET http://127.0.0.1:31415/... -> 200`
- `No update available, already on latest version`
- `Initializing bundled workspace`
- `Session sidecar health monitor started`

## 如何判断“没有首启配置报错”

优先看 `tauri-dev.log`，重点筛查：

```powershell
Select-String -Path .\tauri-dev.log -Pattern '\[ERROR\]|error:'
```

本次实际结论：

- 没有匹配到应用级 `ERROR`
- 开头出现的 `NativeCommandError` 只是 PowerShell 记录 `npm run dev:web` 子进程输出的形式，不是应用运行失败
- 日志里的 `No proxy configured` 是 updater 和 sidecar 继承系统网络配置的普通信息，不是配置异常
- `baseline-browser-mapping` 过旧提示属于前端依赖提醒，不影响首启

## Windows 安装包构建结果

本次已经成功生成以下产物：

- `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\MyAgents_0.2.16_x64-setup.exe`
- `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\MyAgents_0.2.16_x64-setup.nsis.zip`
- `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\MyAgents_0.2.16_x86_64-portable.zip`

注意：

- `tauri build` 在打包完成后仍报错：
  - `A public key has been found, but no private key`
- 原因是环境里没有设置 `TAURI_SIGNING_PRIVATE_KEY`
- 这影响 updater 签名，不影响 `setup.exe` 的实际生成

如果只是本地验证安装包是否能构建出来，当前结果已经成立。

如果要做正式发布并启用自动更新，还需要补齐签名私钥环境变量。

portable 包补充说明：

- 本次 portable ZIP 经过重新生成和内容校验，已确认包含 `myagents.exe`
- 早期一次 `Compress-Archive` 超时生成的是不完整半成品，后续已重打并覆盖
- 当前 portable ZIP 体积较大，是因为采用了完整无压缩归档，优先保证可用性与完整性

## `TAURI_SIGNING_PRIVATE_KEY` 如何获取

这个变量不是从仓库下载，也不是平台发放，而是由发布者自己生成的 Tauri updater 签名私钥。

本仓库现成约定见：

- `.env.example`
- `specs\guides\build_and_release_guide.md`
- `specs\tech_docs\auto_update.md`

推荐生成方式：

```powershell
npx tauri signer generate -w ~/.tauri/myagents.key
```

本机本次实际结果：

- 私钥文件：`C:\Users\zhouy\.tauri\myagents.key`
- 公钥文件：`C:\Users\zhouy\.tauri\myagents.key.pub`
- 用户级环境变量已经写入：
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

执行后会得到两类信息：

- 一个私钥文件，例如 `C:\Users\<你的用户名>\.tauri\myagents.key`
- 一段对应的公钥文本

你需要这样使用它们：

1. 把私钥文件内容写入环境变量 `TAURI_SIGNING_PRIVATE_KEY`
2. 如果生成私钥时设置了密码，再设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. 把生成出来的公钥更新到 `src-tauri\tauri.conf.json` 的 `plugins.updater.pubkey`

本仓库当前要更新的位置：

- 文件：`src-tauri\tauri.conf.json`
- 路径：`plugins.updater.pubkey`
- 当前定位：约第 104 行

本次检查结论：

- 新生成的公钥与仓库原先 `pubkey` 不一致
- 这说明你刚生成的是一套新的 updater 签名密钥
- 本次已按当前机器的发布需要，直接把项目切换到这套新密钥
- `src-tauri\tauri.conf.json` 中的 `plugins.updater.pubkey` 已替换为 `C:\Users\zhouy\.tauri\myagents.key.pub` 的内容
- 这意味着后续要继续使用这套私钥给更新包签名，才能和当前仓库配置保持匹配

PowerShell 示例：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME\.tauri\myagents.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "你的私钥密码"
```

如果你想长期生效，可以写入用户级环境变量：

```powershell
[Environment]::SetEnvironmentVariable(
  "TAURI_SIGNING_PRIVATE_KEY",
  (Get-Content "$HOME\.tauri\myagents.key" -Raw),
  "User"
)
[Environment]::SetEnvironmentVariable(
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "你的私钥密码",
  "User"
)
```

验证方式：

```powershell
echo $env:TAURI_SIGNING_PRIVATE_KEY
echo $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

注意事项：

- 私钥只能由发布方自己保管，不应提交到 Git
- 公钥可以放在仓库配置里，私钥绝不能放进去
- 如果只做本地自测安装包，缺少这个变量不会阻止 `setup.exe` 生成
- 如果要让自动更新可用，必须使用与 `pubkey` 配对的私钥进行签名
- 本次已经启用这套新密钥，不再需要手动替换 `pubkey`

## 本次密钥切换操作

本次已完成以下动作：

- 在本机生成新的 Tauri updater 密钥对
- 私钥写入：`C:\Users\zhouy\.tauri\myagents.key`
- 公钥写入：`C:\Users\zhouy\.tauri\myagents.key.pub`
- 用户级环境变量已写入：
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- 项目配置 [src-tauri/tauri.conf.json](D:/knowledgeBase/MyAgents/src-tauri/tauri.conf.json:104) 的 `plugins.updater.pubkey` 已切换到新公钥

当前这套发布链路的关键关系：

- 仓库里的 `pubkey` 负责校验更新包签名
- 本机的 `myagents.key` 私钥负责给更新包签名
- 两者必须配套，否则自动更新校验会失败

后续发布时建议：

- 所有本地打包、CI 打包、发布脚本都统一使用这套私钥
- 不要再混用旧私钥，否则新包会和当前 `pubkey` 不匹配
- 私钥文件和密码至少要做一份安全备份，否则后续无法继续签名同一条更新链

## 本次最终状态

- 仓库已克隆到当前目录
- 依赖已安装
- 开发模式已成功启动
- 应用窗口已打开
- 首启未发现应用级配置报错
- `mino\.git` 权限问题已排除
- Windows NSIS 安装包已成功生成
- Windows portable ZIP 已成功生成并校验包含主程序
- 新的 Tauri updater 密钥对已生成
- 项目已切换到这套新公钥
- 后续可直接使用当前机器上的私钥继续完成 updater 签名

## 2026-05-17 补充：portable 打包与签名链路

- 已确认带新私钥的正式构建成功完成，`npm run tauri:build -- --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json` 返回 `0`
- 已生成并验证以下签名相关产物：
  - `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\MyAgents_0.2.16_x64-setup.exe.sig`
  - `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\MyAgents_0.2.16_x64-setup.nsis.zip.sig`
- 已核对 `src-tauri\tauri.conf.json` 中的 `plugins.updater.pubkey` 与 `C:\Users\zhouy\.tauri\myagents.key.pub` 完全一致
- `.sig` 文件解码后的 key id 与当前公钥一致，说明当前 updater 签名链路是匹配的

portable 包修正结论：

- 原先 `build_windows.ps1` 的 portable 逻辑只尝试复制 `release\resources`，而当前实际运行时物料主要位于 `release\` 根目录
- 这会导致脚本生成一个只有 `myagents.exe` 和 VC++ DLL 的残缺 portable ZIP，体积只有几十 MB，不可视为可运行便携包
- 现已修正 `build_windows.ps1`，portable 打包改为从 `src-tauri\target\x86_64-pc-windows-msvc\release\` 根目录收集运行时物料
- 同时显式排除以下构建缓存或无关目录：
  - `.cargo-lock`
  - `.fingerprint`
  - `build`
  - `bundle`
  - `deps`
  - `incremental`
  - `myagents.d`
  - `myagents.pdb`
  - `portable`
- portable 阶段新增日志：
  - `便携版纳入 ZIP 的顶层条目: ...`
  - 用于快速确认本次 ZIP 打进去了哪些 release 根目录条目

修正后的验证结果：

- `.\build_windows.ps1 -SkipTypeCheck` 已完整跑通并返回 `0`
- 新生成的 portable 包为：
  - `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\MyAgents_0.2.16_x86_64-portable.zip`
- 新包时间：
  - `2026-05-17 19:38:44`
- 新包体积约：
  - `2.04 GB`
- 已抽样确认 ZIP 内包含以下关键条目：
  - `myagents.exe`
  - `server-dist.js`
  - `plugin-bridge-dist.mjs`
  - `nodejs\`
  - `cli\`
  - `mino\`
  - `bundled-skills\`
  - `claude-agent-sdk\`
  - `sharp-runtime\`
  - `tsx-runtime\`
  - `vcruntime140.dll`
  - `vcruntime140_1.dll`

发布判断规则更新：

- `portable.zip` 不是 Tauri updater 的验签输入
- 当前发布链路中需要上传并写入更新清单签名的是：
  - `*.nsis.zip`
  - `*.nsis.zip.sig`
- `portable.zip` 只是普通下载物料，不需要走 updater 签名流程
