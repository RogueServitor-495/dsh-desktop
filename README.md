# DSH 桌面客户端

一个 **Codex 式**的 DeepSeek Harness 桌面客户端：双击打开，主窗口直接就是 dsh 的 agent 界面，内置运行时自动拉起，不需要系统安装 Node.js，也不需要先启动任何服务。

**独立运行（不需要系统 Node）**：App 内自带完整运行时（官方 Node.js LTS 二进制 ×2（Apple Silicon / Intel）+ 自包含的 `@deepseek-ai/dsh` 安装 + pnpm），通过 `Contents/Resources/resources/runtime/` 随 App 分发。检测顺序为「用户手动指定的 node/dsh 路径 → 内置运行时 → 系统 PATH / Homebrew / nvm / npx 缓存」，因此即使机器上完全没有安装 Node.js 也能一键启动 dsh（含插件管理）。

## 功能

- **打开即用（类 Codex）**：主窗口 = dsh 界面。启动时显示加载页（内置运行时自动启动），就绪后自动进入 dsh agent UI；再次打开 App 会直接**接管**仍在运行的 dsh（断点续用），无需手动启动
- **管理面板（次要入口）**：标签页式（总览/启动参数/插件管理/运行日志），从加载页按钮或菜单栏托盘打开；深色主题
- **启动参数设置**：端口、绑定主机（127.0.0.1；0.0.0.0 会被 dsh 安全拒绝并给出提示）、信任主机（trusted-host，逗号/空格分隔）、额外参数；启动命令实时预览
- **运行时生命周期**：一键启动 / 优雅停止（SIGTERM）/ 重启 `dsh web` 子进程
- **崩溃自愈与断点续用**：App 意外退出后 `dsh` 子进程（独立会话）继续存活；再次打开 App 自动**收养**该 runtime（主窗口直接进入 dsh 界面，可一键停止）
- **优雅退出契约**：停止时对进程组发 SIGTERM，等待 dsh 官方契约的优雅排水（≤5s、退出码 0）；15s 超时后才强制 SIGKILL——**只在停止请求期间生效**，正常运行时不会被误杀
- **日志**：内存环形缓冲（4000 行）+ `runtime.log` 全量落盘，管理面板实时 tail
- **托盘图标（菜单栏）**：状态行实时显示运行状态；左键点击回到 DSH 主界面；菜单项：显示 DSH 主界面、启动/停止/重启运行时、管理面板、开机自启（勾选）、退出
- **插件管理**：列出已安装插件（名称/版本/描述/来源/启用状态）、通过 npm 包名 / git URL / tarball URL 导入、启用/禁用（bundle 层切换 `dsh.profile.bundles`，普通插件生成 app 托管的 patch overlay）、删除（pnpm remove + 自动清理 patch 行）
- **内置 dsh-plugin-manager 插件**：默认随 App 内置并启用（vendored 源码在 `src-tauri/resources/plugins/dsh-plugin-manager/`，构建时打进运行时并自动写入 app overlay），打开 DSH 界面即可在「设置 → 插件」里使用插件管理面板（导入/启停/移除/更新/插件市场）；如需更新 vendored 副本，替换该目录后重新构建
- **Runtime 信息展示**：dsh 版本、node 版本、profile 名称与目录、插件数量与启用数、插件覆盖层路径
- **开机自启**：系统级登录自启（LaunchAgent）+ 可选"启动应用时自动启动运行时"
- **内嵌 DSH 界面**：应用内窗口打开 `http://127.0.0.1:<port>`，或改用系统浏览器
- **内置运行时（自包含）**：`scripts/bundle-runtime.mjs` 在构建前把 Node.js LTS（macOS arm64/x64 + Windows x64）、`@deepseek-ai/dsh` 全量依赖与 pnpm 打进 App；运行时优先使用内置 node/dsh，完全不依赖系统 Node；插件管理走内置 pnpm
- **自动检测**：手动指定路径 > 内置运行时 > 系统 PATH / Homebrew / nvm / npx 缓存；支持手动覆盖 node/dsh 路径；无 pnpm 时自动生成 npx shim（兜底）

## 安装到本机

```bash
cp -R "src-tauri/target/release/bundle/macos/DSH.app" /Applications/
# 已装好：/Applications/DSH.app（本地构建无 quarantine 标记，Gatekeeper 不会拦截）
open /Applications/DSH.app
```

## 构建

前置：Rust（rustup）、Node.js、Xcode CLT。

```bash
npm install            # 安装 @tauri-apps/cli
npm run icon           # 由 scripts/make-icon.mjs 生成的 PNG 产出各尺寸图标
npm run bundle:runtime # 下载 Node LTS(arm64/x64) + npm 安装 dsh + pnpm → src-tauri/resources/runtime
npm run build:app      # release 构建 → src-tauri/target/release/bundle/macos/DSH.app
npx tauri build --debug   # 快速调试构建
# 通用二进制（App 外壳同时支持 Intel / Apple Silicon，需先 rustup target add x86_64-apple-darwin）：
npx tauri build --target universal-apple-darwin
```


## Windows 适配

代码层已跨平台（`cfg(windows)` / `cfg(unix)` 分支）：

- **进程管理**：macOS 用进程组 + SIGTERM/SIGKILL（dsh 优雅排水契约）；Windows 用 `taskkill /PID <pid> /T`（先优雅后 `/F` 强杀，Windows 无 POSIX 信号，优雅排水为尽力而为）
- **孤儿检测**：macOS 用 `pgrep -f`；Windows 用 PowerShell `Get-CimInstance Win32_Process` 匹配命令行
- **spawn**：Windows 加 `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`，子进程不弹控制台窗口
- **路径**：内置运行时按 `node-<platform>-<arch>` 存放（darwin-arm64 / darwin-x64 / win32-x64）；`which` 在 Windows 用 `where.exe`；PATH 分隔符 `;`，node 在 Windows 无 `bin/` 子目录
- **pnpm 包装**：`bundle-runtime.mjs` 同时生成 POSIX sh 与 `pnpm.cmd` 两种包装（都指向内置 node）

**在 Windows 上打包**（需 Windows 机器，Node + Rust toolchain + VS Build Tools）：

```bash
npm install
npm run bundle:runtime   # 复用同一脚本：win32-x64 node + 原生模块（sharp/koffi/node-pty 等）
npm run build:app        # tauri build → NSIS 安装包 (DSH_0.1.0_x64-setup.exe)
```

> 注：`bundle.runtime` 在 macOS 上即可产出全部平台（darwin ×2 + win32-x64）的资源树；Windows 最终打包仍需在 Windows 上执行 `tauri build`（NSIS）。
>
> **macOS 上自检 Windows 编译**：`rustup target add x86_64-pc-windows-msvc` 后用 stub rc 跑
> `RC=<(stub llvm-rc)> cargo check --target x86_64-pc-windows-msvc`（stub 见 scripts/stub-llvm-rc.sh，
> 仅作编译自检；真实打包在 Windows 上用真实 llvm-rc）。

## 自动构建（GitHub Actions）

`.github/workflows/build.yml` 在以下时机自动生成安装包：

- **push 到 main** / **手动触发**（Actions 页面 Run workflow）：生成安装包并上传 Artifact，同时更新滚动 **Nightly Release**（`nightly` tag，Releases 页可随时下载）
  - Windows：`DSH_0.1.0_x64-setup.exe`（NSIS 安装包，`dsh-windows-installer`）
  - macOS：`DSH_0.1.0_aarch64.dmg`（`dsh-macos-dmg`）
- **打 tag（`v*`）**：额外发布正式的版本 Release，附带两个安装包与自动生成的 release notes

CI 构建细节：

- 各平台只捆绑本平台的 node（`BUNDLE_PLATFORMS` 环境变量：win32-x64 / darwin-arm64），安装包保持在 Artifact 500MB 上限内；本地开发默认仍产出全平台运行时
- Windows 用 `windows-latest`（自带 VS Build Tools，真实 llvm-rc 编译图标资源）；macOS 用 `macos-latest`（arm64）
- node 发行包缓存于 `.runtime-cache`（actions/cache），重复构建不重复下载
## 运行

```bash
open src-tauri/target/release/bundle/macos/"DSH.app"
```

脚本化控制（对自动化/验证有用，打开控制面板窗口的同时执行动作；插件操作结果写入 `plugin-cli-out.txt`）：

```bash
"DSH.app/Contents/MacOS/dsh-manager" --start-runtime
"DSH.app/Contents/MacOS/dsh-manager" --stop-runtime
"DSH.app/Contents/MacOS/dsh-manager" --restart-runtime
"DSH.app/Contents/MacOS/dsh-manager" --open-control
"DSH.app/Contents/MacOS/dsh-manager" --plugin-list
"DSH.app/Contents/MacOS/dsh-manager" --plugin-add <npm包名|git URL|tarball URL|路径>
"DSH.app/Contents/MacOS/dsh-manager" --plugin-remove <插件名>
"DSH.app/Contents/MacOS/dsh-manager" --plugin-set <插件名> on|off
```

## 插件管理原理

- profile 插件 = `$DSH_HOME/profiles/<profile>` 下 package.json 的依赖（pnpm 安装，bundle 型自动进入 `dsh.profile.bundles` 层）
- 启用状态 = bundle 层成员 || patch 行（profile 的 `cordis.patch.yml` 或应用托管的 `manager.patch.yml`，后行按同 id 覆盖前行）
- 导入走 `dsh plugin add <spec> -w`（自动兼容 pnpm workspace 根守卫）；pnpm 优先用内置版本（`runtime/dsh/node_modules/.bin/pnpm`，一个调用内置 node 的包装脚本），其次系统 PATH，最后 npx shim
- 插件变更后若运行时在跑会自动重启（启动参数带 `--patch manager.patch.yml`）

## 数据位置

- 设置：`~/Library/Application Support/com.dsh.client/settings.json`
- 日志：`~/Library/Application Support/com.dsh.client/logs/runtime.log`
- 会话/工作区数据仍归 dsh 自身管理（`$DSH_HOME`，默认 `~/.dsh`）

## 架构

```
┌──────────────────────────  DSH.app  ────────────────────────────┐
│  主窗口 (gui) = DSH agent 界面           管理面板 (次要,按需)    │
│  loading.html → 自动跳转 http://127.0.0.1:port   ui/index.html   │
│  Rust 后端 (src-tauri)                                        │
│   ├─ 进程监督: spawn/SIGTERM/重启/日志                          │
│   ├─ 断点续用: 收养已运行 runtime (orphan resume)               │
│   └─ 检测: 内置 runtime > 系统 node/dsh                        │
├────────────────────────────────────────────────────────────────┤
│  Contents/Resources/resources/runtime/（随 App 分发）           │
│   ├─ node-darwin-arm64/bin/node   (Node LTS, Apple Silicon)    │
│   ├─ node-darwin-x64/bin/node     (Node LTS, Intel)            │
│   └─ dsh/  (自包含 @deepseek-ai/dsh + 依赖 + pnpm 包装)         │
└───────────────┬────────────────────────┬───────────────────────┘
                │  spawn <runtime>/node   <runtime>/dsh/.../bin.js
        ┌───────┴────────┐
        │  dsh 运行时进程  │  (SIGTERM 优雅退出 ≤5s，setsid 独立会话)
        └────────────────┘
```

## 已验证（自动化端到端）

| 场景 | 结果 |
|---|---|
| 启动 → `dsh web` 就绪并对外服务 | ✅ 端口 200 |
| 长时间运行（>40s）不被误杀 | ✅（修复了 waiter 15s 强杀 bug） |
| 优雅停止（SIGTERM → dsh 排水 → 退出码 0） | ✅ 日志 "runtime stopped cleanly" |
| 重启（停止后重新拉起） | ✅ |
| App 退出 → dsh 孤儿存活 → 新实例收养并进入界面 | ✅ 断点续用（WebView 直连） |
| 已有 dsh 在端口运行 → 新实例收养而非冲突报错 | ✅ |
| 日志实时捕获（含 dsh 自身输出） | ✅ |
| 无系统 Node（PATH 无 node）→ 内置运行时启动 dsh web | ✅ HTTP 200，进程为 resources/runtime/node-…/bin/node |
| Intel 架构（Rosetta 下 x64 内置 node + dsh） | ✅ HTTP 200 |
| 内置 pnpm 插件 add / list / remove | ✅（remove 需用完整包名） |
| 双击打开 → 主窗口自动进入 dsh 界面（无系统 Node） | ✅ loading 自动跳转，WebKit 直连 127.0.0.1:port |

> 进程契约依据：DSH 官方 CLI 参考——`SIGTERM` = 优雅关闭（≤5 秒排水、退出码 0），第二次信号强制退出。
