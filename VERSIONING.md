# 版本规范（Versioning）

本仓库包含两层版本，必须能独立演进：

## 1. 桌面版（dsh-manager / DSH Desktop）

- **格式**：`v主.次.修订`，遵循 [SemVer](https://semver.org/)（当前 `0.x` 阶段：次版本号表示功能更新，修订号表示修复）。
- **唯一来源**：`src-tauri/tauri.conf.json` 的 `version` 字段（`package.json` 与 `src-tauri/Cargo.toml` 保持同步）。
- **发布流程**：
  1. 修改 `tauri.conf.json` 的 `version`（以及 `package.json`、`Cargo.toml`），提交到 `main`；
  2. 打 tag：`git tag v0.2.0 && git push origin v0.2.0`；
  3. CI（`build-installers`）构建 Windows NSIS + macOS DMG，并校验 **tag == 应用版本**（`scripts/release-version.mjs --check`，不一致直接失败）；
  4. tag 构建产物发布为正式 Release（`v0.2.0`），`main` 上的构建持续覆盖 `nightly` Release。
- **展示**：管理面板「内核与更新 → 桌面版」显示当前版本，并对照 GitHub 最新 Release 检查更新。

## 2. dsh 内核（@deepseek-ai/dsh）与 node

- **内置运行时**（App 随附，默认）：
  - dsh 版本 = `BUNDLE_DSH_VERSION`（`scripts/bundle-runtime.mjs），依赖树由
    `src-tauri/resources/runtime/dsh/package-lock.json` + `scripts/pinned-runtime-versions.json`
    双重锁定 —— **升级内核 = 同时更新这三处**（在 runtime/dsh 目录
    `npm install --package-lock-only --omit=dev` 重新生成 lock，并把新树版本写回 pinned 文件）。
  - node 版本 = `BUNDLE_NODE_MAJOR`（默认 24）解析到的当前 LTS，实际版本记录在
    构建产物 `versions.json`。
  - `versions.json`（node/dsh）随 App 打包，管理面板展示为「运行时组件」。
- **用户管理的内核**：管理面板可从 npm registry 安装任意已发布 dsh 版本到
  `<应用数据目录>/kernels/<版本>`，与内置 node 二进制共用，可随时切换/删除；
  未选择时始终回退到内置运行时。回退顺序：显式路径 > 选定内核 > 内置运行时 > 系统 PATH。

## 3. 版本字符串展示规范

对外统一表述：`DSH Desktop v0.1.0 · dsh 0.1.0-rc.6 · node v24.19.0`
（desktop = 应用自身；dsh = 当前生效内核；node = 内置 node）。管理面板与 Release
说明均按此格式标注。

## 4. CI 触发规则

| 事件 | 效果 |
|---|---|
| push 到 `main` | 构建 + 覆盖 `nightly` Release（always） |
| push tag `v*` | 构建 + 发布正式 Release；tag 必须等于 `tauri.conf.json` 版本，否则失败 |
| 手动 workflow_dispatch | 仅构建，不发布 |
