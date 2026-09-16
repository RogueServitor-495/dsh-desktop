# 需求：桌面版适配新内核（浏览器鉴权握手）

- 状态：**已冻结**（2026-09-15，用户已就 3 项决策拍板）
- 关联：`kernel-switch-report.md`（上一轮排查）

## 1. 背景

dsh 内核自 **0.1.2-rc.1** 起引入浏览器鉴权：进程启动时随机生成 launch token，只打印在启动 URL
（`dsh web: http://127.0.0.1:PORT/?token=...`）。`GET /?token=X` 会 303 并把签名 cookie
（`dsh-auth-<sha256(authority)>; HttpOnly; SameSite=Strict`）种下；**此后所有请求（含 `/api/*` 与
WebSocket 升级）都必须带该 cookie**。`--trusted-host` 只过 Host/Origin 栅栏，**不能**绕过 cookie 校验。

桌面版 `v0.1.0`（`dsh-manager.exe`）没有任何 token 处理，因此切换到 0.1.2-rc.1+ 内核后：

- 内嵌 GUI 窗口打开 `http://127.0.0.1:PORT` → **401 白页**；
- 审批弹窗的 Rust 桥（`GET /api/events.mux` WS 升级、`POST /api/respond`）无 cookie → **401，审批链路全挂**；
- 新内核每次启动还会**自动弹出系统浏览器**。

## 2. 已确认的决策（冻结）

| 编号 | 决策 | 结论 |
|---|---|---|
| D1 | 范围 | **同时升级内置运行时到 `@deepseek-ai/dsh@0.1.5-rc.2`** |
| D2 | token 来源 | **只解析内核 stdout 启动 URL**；不做 `.credentials.yaml` cookie 自行签发兜底 |
| D3 | 交付方式 | **只产出构建产物 + 旁路验证**，不动正在运行的安装与 3080 运行时 |

## 3. 目标（可验证）

- G1 用 0.1.5-rc.2 内核时，内嵌 GUI 窗口正常显示 DSH 界面（不是 401）。
- G2 用 0.1.5-rc.2 内核时，审批桥（WS + POST）返回成功而非 401。
- G3 用旧内核（0.1.0-rc.6）时，行为与改动前**完全一致**。
- G4 launch token **不得**以明文出现在 `runtime.log`、窗口标题或进程命令行中。
- G5 内置运行时升级到 0.1.5-rc.2 后，冷启动仍能拉起 web profile。

## 4. 范围边界

**要做**：token 捕获与脱敏、GUI 窗口 URL、管理面板展示地址、审批桥 cookie、`--no-open`（带版本门控）、
内置运行时版本与锁文件升级。

**不做**：adopt 外部运行时场景下的 token 获取（只给明确提示）；浏览器 token 兜底签发；改动 CI/发 Release；
替换用户当前安装；Git 提交。
