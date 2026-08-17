# dsh-plugin-manager

一个 dsh Web 的**插件管理插件**（官方插件管理功能的平替）：集成到 **设置 → 插件**页
作为一个独立的「插件管理」tab，同时保留右下角「🧩 插件管理」浮动快捷入口（可用
`fab: false` 关闭）。支持**管理已有插件**（列表 / 启用 / 停用 / 移除）和**通过 URL 等
方式导入新插件**（git URL、GitHub 短链、npm 包名、tarball URL、本地路径），并**区分
官方内置插件与外部插件**（外部可管理，官方只读展示）。

## 功能

| 能力 | 说明 |
|---|---|
| 插件市场 | 新增「插件市场」tab：爬取 GitHub topic `dsh-plugin`（官方市场），展示 50 个仓库（★star / 语言 / 更新时间 / 标准插件标记 / 已安装标记），支持搜索、一键安装（复用导入管线）；服务端缓存 5 分钟防 GitHub API 限流 |
| 设置页集成 | 注册为 设置 → 插件 的「插件管理」「插件市场」两个 tab（与官方「配置」「插件列表」并列），作为官方管理功能的平替 |
| 区分官方/外部 | 外部插件（用户补丁行，可启停/移除，橙色「外部」标记）与官方内置插件（bundle 层，只读，蓝色「官方内置」标记）分区展示 |
| 列出已注册插件 | 行 id、模块名、Cordis 状态（已挂载/等待依赖/失败…）、是否已安装、是否有客户端 half |
| 启用 / 停用 | 写入 profile 的 `cordis.patch.yml`（id 定向 `disabled` 覆盖行），dsh 的 patch HMR **热生效**，无需重启 |
| 移除插件 | 删除补丁行 + `pnpm remove` 卸载依赖 + 从 `dsh.profile.bundles` 移除 |
| 导入插件 | `pnpm add` 装入 profile：`git+https://…​.git`、`github:owner/repo`、`https://github.com/owner/repo`、npm 包名、`http(s)://…​.tgz`、`file:./路径` / 绝对路径 |
| 记录来源与版本 | 持久化 registry（`<profile>/.dsh-plugin-manager.json`）记录每个插件的 `source / url / kind / installedAt / lastVersion`，state 一并返回（已装插件按依赖 spec 自动回填 url） |
| 更新 / 切换 | `update`：重新 `pnpm add` 拉取最新（git 插件更新到远端 HEAD）；`switch`：按 tag/分支/commit（git）或版本号（npm）切换；卡片上「更新」按钮 + 版本号点击切换 |
| 服务器 API | `/api/plugin-manager/{state,toggle,import,remove}`（同源），可选 token 鉴权 |
| 浮动快捷入口 | 右下角「🧩 插件管理」按钮（与设置页共用同一视图），配置 `fab: false` 可关闭 |

导入新插件后：**服务端行通过 patch HMR 热生效**；浏览器端 half 需要**硬刷新**
（Cmd+Shift+R），若仍未出现请**重启 dsh web**（新增客户端包需重启才被扫描）。

## 原理（对应「一切皆插件」）

1. 双 half 结构：服务端 `lib/index.js` 注册 `/api/plugin-manager/*` 路由，
   浏览器端 `lib/client.js` 渲染右下角浮动面板。
2. 补丁文件 `cordis.patch.yml` 是**持久 + HMR 热加载**的唯一真相源
   （dsh-app-boot 的 `watchUserPatches` 监听该文件并事务性重放补丁）。
   编辑器对补丁文件做**文本级手术**：追加 / 删除行、追加/删除 `disabled` 覆盖行，
   **不重排文件**，因此 webserver 配置、`!!js` 表达式和注释都原样保留。
3. 依赖管理直接调用 `pnpm add|remove`（与 `dsh plugin --profile web add` 同工具），
   自动识别 pnpm workspace 根目录（加 `-w`）、处理被拦截的 build script
   （写入 `allowBuilds` 并 `pnpm rebuild`）。
4. 无第三方运行时依赖：js-yaml 已 vendored 到 `lib/vendor/js-yaml.mjs`。

## 文件结构

```
dsh-plugin-manager/
├── package.json          # dsh.client 声明 + exports["./client"]
├── lib/
│   ├── index.js          # 服务端：4 个 API 路由 + 状态聚合 + pnpm/补丁编排
│   ├── client.js         # 浏览器 bundle：FAB + 面板（列表/开关/移除/导入表单）
│   ├── patch.js          # cordis.patch.yml 读取（js-yaml 方言）+ 文本手术编辑
│   ├── toolchain.js      # pnpm/git 发现 + 无 shell 子进程
│   └── vendor/js-yaml.mjs
├── dev/                  # 独立开发实例（dsh-home/ 已 gitignore）
│   ├── start.sh          # DSH_HOME=./dsh-home 启动 127.0.0.1:3081
│   ├── setup-home.sh     # 一次性准备 dsh-home
│   ├── materialize-store.mjs
│   └── patch.test.mjs    # 补丁编辑器单元测试
└── .gitignore
```

## 安装到真实 web profile

```bash
# 1) 把插件装进 web profile 的 node_modules
dsh plugin --profile web add file:/absolute/path/to/dsh-plugin-manager

# 2) 在用户补丁里注册插件行（id 必须与 bundle 模块 id 一致）
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'

- insert:
    - id: dsh-plugin-manager
      name: 'dsh-plugin-manager'
EOF

# 3) 重启 dsh web，浏览器硬刷新后右下角出现 🧩 插件管理
```

也可以通过**已装好的管理器自己导入**：面板 → 输入 `file:/path/to/dsh-plugin-manager`
（或 `git+https://github.com/<owner>/dsh-plugin-manager.git`）→ 导入。

## 配置（补丁行 config）

```yaml
- insert:
    - id: dsh-plugin-manager
      name: 'dsh-plugin-manager'
      config:
        profile: web        # profile 名（默认 web）
        dshHome: null       # 覆盖 DSH home（默认 $DSH_HOME 或 ~/.dsh）
        profileDir: null    # 直接指定 profile 目录（覆盖上面两项）
        pnpmBin: null       # pnpm 二进制路径（默认自动发现）
        gitBin: null        # git 二进制路径（默认自动发现）
        token: null         # 设置后所有 API 需 x-plugin-manager-token 头
        fab: true           # 是否显示右下角浮动按钮（false 仅保留设置页入口）
```

> ⚠️ **安全**：dsh web 若绑定 `0.0.0.0`（局域网开放），同网段设备可调用这些 API
> （可执行 pnpm / 写补丁）。**强烈建议设置 `token`**，面板会提示输入并保存在 localStorage。

## API

- `GET  /api/plugin-manager/state` — profile / toolchain / 补丁行 / 实时 loader 条目
- `POST /api/plugin-manager/toggle`  — `{id, enabled}`
- `POST /api/plugin-manager/import`  — `{source, id?}`
- `POST /api/plugin-manager/remove`  — `{id, packageName?}`

## 本地验证（已通过）

- `node --check` 全部通过；`dev/patch.test.mjs` 18 项断言全绿（真实补丁文件，含 webserver 配置与 `!!js` 表达式）。
- 独立实例：列表 / 开关 / 移除 / 导入（file:、git+file://、GitHub 短链、tarball URL、workspace-root）全部端到端通过。
- 设置页集成：设置 → 插件 → 「插件管理」tab 渲染正常（外部插件可启停、官方内置只读分区、导入表单），Playwright 无 console 错误；FAB 与设置页共用同一视图。
- 生产 profile（3080）：热装后不重启即可列出/开关插件，webserver 行与注释原样保留；token 鉴权 401/200 正常。

## UI 设计（视觉 + 交互）

- **视觉**：渐变主按钮/FAB（蓝→紫）、卡片 hover 浮起 + 描边高亮、状态点发光（active 绿 / failed 红 / loading 脉冲）、圆角标签徽章（外部=橙、官方=蓝、已安装=绿）、骨架屏加载动画、toast 通知（成功/错误，自动消失）。
- **官方插件折叠**：默认收起（仅标题行），点击箭头展开 40 行，可「展开全部」，再点收起（设置页与右下角 FAB 面板一致）。
- **交互**：插件搜索 + 筛选 chips（全部/外部/官方）、官方列表折叠/展开、自定义确认弹窗（替代原生 confirm，支持 Esc）、开关/移除进行中置灰、导入按钮 loading 态、FAB 面板支持 Esc 关闭、Enter 直接导入。
- 设置页 tab 与浮动 FAB 共用同一套视图与样式。

## bundle 自注册插件的管理

- **概念**：包声明 `dsh.bundle.patch` 时（如 dsh-prompt-enhancer、dsh-free-search），加入 `dsh.profile.bundles` 后由包自己的补丁文件**自注册**插件行（无需在 `cordis.patch.yml` 手动加行）。
- **现在可完整管理**：管理器对「外部 bundle 插件」提供**启停开关 + 移除** —— 启停通过用户补丁层的 `disabled` 覆盖行实现（HMR 立即生效），移除会清理覆盖行 + 从 `dsh.profile.bundles` 删除 + `pnpm remove`（完全卸载需重启，bundle 层启动时合并）。
- **官方核心插件（`@deepseek-ai/*`）保持只读**：拒绝启停/移除，防止拆坏 dsh 本体。

## 导入格式注意事项

- **bundle 自注册插件**：包声明 `dsh.bundle.patch` 时（如 dsh-prompt-enhancer），管理器会加入 `dsh.profile.bundles` 让其自注册，**不再**追加用户补丁行（避免 loader 条目 id 重复）。**注意**：bundle 层在启动时合并，安装后需**重启 dsh web** 才激活。
- **导入幂等**：若依赖已存在于 profile（如上次安装被中断），重复导入会按 spec 匹配已有键并正常返回，不会报错。
- **第三方插件质量问题**：个别仓库的客户端 bundle 注册 id 与包名不一致（如 `@mlgbnb/dsh-archive-manager`），会导致整个客户端 boot 失败（显示 "Failed to load plugins"）。遇到时从 `package.json` 移除该依赖并重启即可；管理器无法预判此类问题。
- **scp 风格 git URL**（`git@github.com:owner/repo.git`）会被 pnpm 误解为「别名 `git` + 本地目录」，
  导致依赖名变成 `git`。管理器会自动规范化为 `git+ssh://git@github.com/owner/repo.git`（等价认证语义），
  并校验安装后的真实包名（若 pnpm 记录错误键则自动修正）。
- 也可以直接使用 `github:owner/repo` 或 `git+https://…​.git`。

## 生效时机（是否需要重启）

| 层 | 生效时机 |
|---|---|
| 服务端行 | **立即** —— patch HMR 热应用，导入/启停/移除后马上生效（`phase: active`） |
| 浏览器端 half | **硬刷新即可**（Cmd+Shift+R）—— client-modules 增量扫描会把新客户端纳入 boot；无需重启 dsh web |
| 管理器自身代码更新 | 需**重启一次 dsh web**（运行中进程缓存旧模块） |

## 已知边界

- 浏览器端 half 的新增/更新需要重启 dsh web 或硬刷新才进入 `__DSH_BOOT__`。
- npm 注册表导入按 pnpm 语义解析；安装带 build script 的 git 依赖时若被拦截，
  管理器会自动写入 `allowBuilds` 并重跑 `pnpm rebuild`。
- 禁用管理器自身被防护（`SELF_DISABLE`），需手动编辑补丁。
