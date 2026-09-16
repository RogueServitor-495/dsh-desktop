# 设计：桌面版适配新内核（浏览器鉴权握手）

## 1. 目标

一句话：让桌面版在 `0.1.2-rc.1+` 内核下与旧内核下表现同样正常。
成功标准 = 需求 G1..G5 逐条通过。

## 2. 已知信息

| 事实 | 位置 |
|---|---|
| 启动 URL 由 stdout 打印 | 新内核 `dsh-web-app` 启动时输出 `dsh web: <url>?token=...` |
| 桌面端已把 stdout 按行读入环形缓冲 + 日志文件 | `src-tauri/src/runtime.rs:409-441` |
| 就绪探测**不校验状态码**，401 也判 ready | `src-tauri/src/runtime.rs:300-312` |
| GUI 窗口用裸地址打开 | `src-tauri/src/lib.rs:237-250` |
| 状态里的 GUI 地址 | `src-tauri/src/lib.rs:170` |
| 审批桥裸 TCP，无 cookie | `src-tauri/src/approvals.rs:135-165`、`:540-570` |
| 启动参数拼装 | `src-tauri/src/runtime.rs:595-632` |
| 内置运行时版本默认值 | `scripts/bundle-runtime.mjs:32` |
| 版本/锁三处必须同步 | `VERSIONING.md` §2 |

## 3. 需求拆解 → 改动点

| P0 | 模块 | 改动 |
|---|---|---|
| T1 | `runtime.rs` | 新增 `launch_token: Option<String>` 到 `RuntimeCore`；在 stdout 行处理里正则抓 `http://127\.0\.0\.1:(\d+)/\?token=([A-Za-z0-9_-]+)`；**入库前把日志行里的 `token=` 值脱敏为 `token=***`**；每次 `start()` 清空 |
| T2 | `lib.rs` | `open_gui_inner`：有 token → 用 `?token=` 打开；窗口已存在且 token 变化 → `w.navigate(...)` 重导航；`gui_url` 返回带 token 的地址（用户在用浏览器访问，这个地址要能直接粘） |
| T3 | `approvals.rs` | 新增 `auth_cookie(port)`：用 token 发起 `GET /?token=T`（`Host: 127.0.0.1:{port}`，与后续请求同 authority，否则 cookie 签名 audience 不匹配），从 `Set-Cookie` 取 `name=value`；进程内缓存，token 变化即失效；`open_ws` 与 `http_request` 带上 `Cookie:` |
| T4 | `runtime.rs`（新文件 `kernel_caps.rs`） | `supports_browser_auth(dsh_bin) -> bool`：从 bin.js 路径回溯到 `@deepseek-ai/dsh/package.json` 读 version，`>= 0.1.2-rc.1` 为真；**为真才追加 `--no-open`** |
| T5 | `scripts/` + 资源 | `BUNDLE_DSH_VERSION` 默认改 `0.1.5-rc.2`；重生成 `src-tauri/resources/runtime/dsh/package-lock.json`；重生成 `scripts/pinned-runtime-versions.json`；跑 `bundle:runtime`（win32-x64） |

## 4. 实现思路

```
spawn kernel
   └─ stdout reader thread
        ├─ 脱敏后 push_line / 写日志
        └─ 命中启动 URL → core.launch_token = Some(t)   ← 值只进内存
                                    │
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
  open_gui_inner            Snapshot.gui_url            approvals::auth_cookie
  /?token=t                 /?token=t                   GET /?token=t → Set-Cookie
  （WebView2 自己种 cookie）  （用户可直接粘到浏览器）      → 缓存 → WS/POST 带 Cookie
```

## 5. 备选方案与取舍

| 方案 | 取舍 | 结论 |
|---|---|---|
| A 解析 stdout（本设计） | 零耦合；adopt 场景拿不到 | **采用（D2）** |
| B 读 `.credentials.yaml` 密钥自行签 cookie | adopt 也能用；但耦合内核私有格式与凭据存储 | 放弃 |
| C A+B 混合 | 覆盖面最好，复杂度×2 | 放弃 |
| D 给内核打补丁关鉴权 | 每次内核升级都要重打，下游分叉 | 放弃 |
| E 让 WS 桥走 WebView 代理 | 要重写整条审批链路 | 放弃 |

## 6. 测试与验收

| 编号 | 场景 | 期望 |
|---|---|---|
| A1 | 新内核 0.1.5-rc.2 + 隔离 DSH_HOME + 端口 3199，新 exe 启动 | 内嵌窗口显示 DSH 界面，非 401（G1） |
| A2 | 同上，脚本直连 `/api/events.mux` 带 cookie | 返回 `101 Switching Protocols`（G2） |
| A3 | 旧内核 0.1.0-rc.6 同流程 | 行为与改动前一致；命令行**不含** `--no-open`（G3） |
| A4 | 检查 `runtime.log` 全文 | 无明文 token（G4） |
| A5 | `npm run bundle:runtime` 后冷启动 | `versions.json` 显示 0.1.5-rc.2 且能拉起 web profile（G5） |

## 7. 不做什么

见需求 §4「不做」。此外本设计**不引入任何新 crate 依赖**（cookie 解析手写，SHA/HMAC 由内核侧完成）。

## 8. 风险与未知

| 编号 | 风险 | 缓解 |
|---|---|---|
| R1 | Rust/Tauri 构建可能被沙箱 `spawn EPERM` 阻断 | 先 `cargo build`（debug，`target/debug` 已有增量）验证；真被拦就单次提权重试同一条命令 |
| R2 | `bundle:runtime` 需联网装依赖 | `.runtime-cache` 已有 node 包；dsh 依赖走 npmmirror |
| R3 | 通过 bin.js 回溯 package.json 可能失败（自定义 `dshBin`） | 失败即按「不支持」处理 → 不加 `--no-open`、不启用 token 逻辑，保持旧行为 |
| R4 | token 泄漏 | 脱敏在**写日志之前**；标题只用干净地址；不进命令行 |
| R5 | adopt 外部运行时无 token | 明确提示，不静默 401（本轮不做自动登入） |
