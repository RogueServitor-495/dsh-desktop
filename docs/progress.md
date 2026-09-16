# 进度：桌面版适配新内核

## 任务看板

| 编号 | 任务 | 优先级 | 状态 |
|---|---|---|---|
| T1 | runtime.rs 捕获 + 脱敏 launch token | P0 | ✅ 完成（含 5 个回归测试） |
| T2 | lib.rs GUI 窗口/地址带 token | P0 | ✅ 完成 |
| T3a | approvals.rs 用 token 换 cookie，WS/POST 带 Cookie | P0 | ✅ 完成 |
| T3b | 审批 mux 路径能力探测（remote.mux / events.mux） | P0 | ✅ 完成（实现中发现） |
| T4 | kernel_caps 版本探测 + `--no-open` 门控 | P0 | ✅ 完成（含 3 个测试） |
| T5 | 内置运行时升级到 0.1.5-rc.2（pinned/lock/树） | P0 | ✅ 完成 |
| T6 | 构建产物 + 旁路验证 | P0 | 🔄 进行中 |
| T7 | 新内核审批「响应」通路（旧 POST /api/respond 已移除） | P1 | ⛔ 需协议逆向，未排期 |
| T8 | 修复 plugins.rs 里硬编码 macOS 路径的测试 | P2 | 未排期 |

## 关键验证结果（实机）

隔离内核 `@deepseek-ai/dsh@0.1.5-rc.2`，端口 3199，DSH_HOME 隔离，带 `--no-open`：

| 检查 | 结果 |
|---|---|
| 启动 + `--no-open` | ✅ 接受，未弹浏览器（证明门控方向正确） |
| `GET /`（无 cookie） | **401**，68 字节 —— 桌面版白页的根因 |
| `GET /?token=…` | **303 → /**，`Set-Cookie: dsh-auth-<sha256(authority)>=v1.…` |
| `GET /`（带 cookie） | **200**，27660 字节 |
| WS `/api/remote.mux`（无 cookie） | **401** |
| WS `/api/remote.mux`（带 cookie） | **101 Switching Protocols** ✅ |
| WS `/api/events.mux`（新旧内核对比） | 新内核无此路由；旧内核 0.1.0-rc.6 有 |
| `POST /api/respond`（器内核） | **404 not found** —— 该端点已移除 |

## 实现中发现的两个内核变更（超出原设计假设）

1. **mux 路径改名**：0.1.5-rc.2 移除了 `@deepseek-ai/dsh-host-apiproxy`，改由
   `@deepseek-ai/dsh-api-gateway` 提供 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`。
   旧内核只有 `/api/events.mux`。二者互斥 → 采用「按能力探测、逐个尝试」，
   同一个构建在两类内核上都能连上。
2. **审批响应通路消失**：`POST /api/respond` 在新内核返回 404，全树已无该字符串。
   意味着在新内核上审批弹窗**能收到**（走 remote.mux），但**无法通过 POST 回执**；
   `answer_current` 会因错误返回 false，回退到 DOM 桥（在可见会话上仍可用）。
   后台会话的审批回执需要接入新 stream protocol —— 列为 T7（P1）。

## 内置运行时升级（T5）

按 `VERSIONING.md` 的「升级内核 = 同时更新这三大」执行：

1. `scripts/bundle-runtime.mjs`：`BUNDLE_DSH_VERSION` 默认 `0.1.0-rc.6` → `0.1.5-rc.2`
2. `scripts/pinned-runtime-versions.json`：由真实解析出的 0.1.5-rc.2 依赖树重新生成
   （496 项；旧表 113 项已不存在于新树，如 react/shiki/katex/micromark 全家桶与
   `dsh-host-apiproxy`）。跨架构原生包版本取自上游 `optionalDependencies`（权威）：
   sharp `0.35.4` / libvips `1.3.3` / koffi `3.3.0` / node-addon-require-builtin `0.1.6`。
3. `src-tauri/resources/runtime/dsh/package-lock.json`：重生成（359778 → 336600 字节），
   `npm ci --dry-run` 无 lock/package.json 不同步报错。

> 注意：先用隔离安装树生成 pinned 表是**错的**——那棵树缺 123 个包。
> 改为在真实 bundle 目录做一次干净解析后再生成。

## 日志

- 2026-09-15 排查完成，确认根因与桌面端不兼容点（见 `kernel-switch-report.md`）。
- 2026-09-15 需求/设计定稿，门禁②通过。
- 2026-09-15 T1–T5 实现完成；`cargo check` 通过；kernel_caps 3 项测试全过。
  实测确认 cookie 方案可用，并发现 mux 端点改名（→ T3b）与响应通路消失（→ T7）。
- 2026-09-15 复核：`plugins::tests::line_based_removal_preserves_comments` 失败是
  **预先存在**的环境问题（`plugins.rs:804` 硬编码 `/Users/snake/.dsh/...`），与本次改动无关。

## 已知问题（2026-09-16 新增，来自用户实机复现）

**新内核会迁移 `$DSH_HOME/.credentials.yaml`，导致回退到内置内核直接启动失败。**

实机证据（用户环境）：

- 16:08 安装内核 `0.1.6-alpha.1`；17:37 该内核把 `C:\Users\92489\.dsh\.credentials.yaml`
  重写为新 schema：顶层 `version: 1`（YAML 数字）+ `refs` + `records.client-connection/browser-session`。
- 17:52 切回内置 0.1.0-rc.6，启动即崩：
  ```
  credentials-local: the value for "version" in ...\.credentials.yaml must be a string
  ```
- 原因：旧内核 `dsh-credentials-local` 要求该文件是**扁平 字符串→字符串 映射**：
  ```js
  for (const [key, value] of Object.entries(root)) {
    if (typeof value !== "string") throw new TypeError(...must be a string);
  }
  ```
  遍历到 `version: 1`（数字）即抛错退出。

**影响**：该文件在 `$DSH_HOME` 层，**所有内核共用**，所以一旦跑过新内核，
「切回内置内核」这条退路会被污染 —— 与内核切换功能本身无关，但会让用户以为「切坏了」。

**建议（未实现）**：内核启动前对该文件做一次快照备份，或在检测到 schema 版本高于
当前内核支持时明确告警，而不是让内核以堆栈崩溃告终。

