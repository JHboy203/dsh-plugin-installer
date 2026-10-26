# dev/ —— 自检、探针与验收（换会话先看这份）

插件的**状态层**在 `DSH-Plugin/★交接文件·插件安装面板.md`，方法层在 skill
`.dsh/skills/dsh-client-plugin-ops/`。这份只讲「怎么验」，别和那两份重复。

## 三层自检（改任何东西之后都要全绿）

| 层 | 命令 | 期望 |
|---|---|---|
| 自洽（不碰宿主、不 spawn、不写盘） | `node dev/audit.mjs` **或** `host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/audit.mjs"})` | `SUMMARY audit passed`（155 项） |
| 行为（真跑宿主逻辑） | `host_selfcheck({plugin:"dsh-plugin-installer"})` | 日志 `SUMMARY 835 passed, 0 failed`（工具头部 PASS 数是按输出尾部数的，会少算，**看日志**） |
| 界面（无头渲染） | `node dev/render-check.cjs` **或** `host_selfcheck({..., script:"dev/render-check.cjs"})` | `TOTAL 141 checks` / `all render checks passed` |

改断言数就必须同步：`dev/audit.mjs` 的 `EXPECTED_ASSERTIONS` / `EXPECTED_RENDER_ASSERTIONS`、
`dev/render-check.cjs` 的 `EXPECTED_TOTAL`、`README.md` 与本插件交接文件里的数字（audit 会当场对表）。

## 探针（离线优先：不用重启也能验判据）

| 探针 | 回答什么 | 跑法 |
|---|---|---|
| `dev/probe-crash.mjs` | 真实崩溃日志上，`readNewestCrash` + `inspectProfile` 现在怎么判（两类日志 / sibling / stale / 来源处置） | `host_selfcheck({plugin, script:"dev/probe-crash.mjs"})` |
| `dev/probe-skills.mjs` | 真实技能根上，YAML 判据会不会误报、`fixable` 怎么分 | 同上，script 换 `dev/probe-skills.mjs` |
| `dev/probe-search.mjs` | 本机官方 `@deepseek-ai/*` basename 有哪些；影子包标注对不对。带 `DSH_PROBE_SEARCH="<查询>"` 会真联网搜一次 | `host_selfcheck({..., script:"dev/probe-search.mjs", env:{DSH_PROBE_SEARCH:"dsh-base"}})` |
| `dev/probe-live.mjs` | **运行中的宿主**到底是不是磁盘这一版：`/state` 的 build、`/health` 的 code、`/skills` 的计数与 YAML；带 `DSH_PROBE_LIVE_SEARCH=1` 会打一次 `/search` 看 `shadowOf` | `host_selfcheck({..., script:"dev/probe-live.mjs", args:["<GUI端口>"]})` |
| `dev/probe-rev.mjs` | **上次那个没激活的前端入口修没修**：先用固定向量验 rev 算法（其中一条是真机观测值），再把最近一份 `crash-*-web-boot.log` 里点名的每个包与磁盘对账（`same` / `rebuilt` / `unknown`）。`--full` 连体检结论与面板动作一起打 | `node dev/probe-rev.mjs --full`（自动往上找 `.dsh/profiles/<name>`，也可 `--profile <dir>`） |
| `dev/probe-sources.mjs` | **「已装分来源」在真 profile 上是什么结果**：多少依赖能算出 `host/owner/repo`（对账下限）、link 与 npm 样本、三条对账（同仓库 `same` / 换仓库 `different`(warn) / link `different`(**error**) / 未知 `unknown`）、以及「你搜的是本机插件」那句话 | `node dev/probe-sources.mjs`（同样自动找 profile，可 `--profile <dir>`；不联网） |
| `dev/probe-bridge.mjs` | **跨插件契约探针（R27）**：把真的 `CatalogService` 装成 `pluginCatalog` 服务，用 installer 的 `describeRemovalProvider()` 去探测，再按真实调用方式走一遍 plan → apply（apply 用**假宿主**，不会真卸载），核对两边字段（`token` / `expiresAt` / `text` / `warnings` / `blockers` / `verified` / 一次性 token / 老版本降级）。协作方不在本机时 **SKIP** | `node dev/probe-bridge.mjs` |
| `dev/probe-live-upgrade.mjs` | **「现在能不能真升级」一条命令（R27 收尾）**：只读三个 GET —— installer 路由在不在 / 入口是不是新的（`appliedAfterLoad`）/ `state.collaborator` 可用 / 「插件目录」的 api 与 `removeBundle`。端口取 `DSH_WEB_URL`（每次重启都会变，别写死）；对端不健康时**如实降级**（别的会话的中间态不算自己的失败） | `node dev/probe-live-upgrade.mjs [--base http://127.0.0.1:<端口>]` |
| `dev/probe-pnpmstate.mjs` | **profile 的 pnpm 世代还说得通吗（R29）**：五问一次答 —— ① 世代（package.json / lockfile / `.modules.yaml` 的 mtime + `prunedAt`，即「上一次 pnpm」）② 规模（声明 vs lockfile 记录 / 版本对不上 / 没记录 / 已卸还留着 / 版本不一致）③ 样本（逐条点名）④ 结论（`judgePnpmState` 一句话 + 体检会报的标题与前两步处置）⑤ 归因（`data/profilestate.json` 里最新一条**不是本面板干的**变更）。**只读**：不写盘、不跑 pnpm | `node dev/probe-pnpmstate.mjs`（自动找 profile；可 `--profile <dir>` / `--journal <路径>`） |
| `dev/git-commit.mjs` | **宿主侧提交**（沙箱写不了 `.git/index.lock`）：`git add -A`，或 **`--paths a.mjs,b.mjs` 只提交点名路径**（工作区里有另一个会话的未提交改动时用它）、`--push`、`--dry-run`。默认只动本仓 | `host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/git-commit.mjs", args:["--message-file","…"]})` |
| `dev/probe-inject.mjs` | **某个已安装包的服务声明扫描**：declare/used/violations 与行号。判定 `install_hub_doctor` 的「缺 inject」是真故障还是误报时用它（可传任意包目录，如 `node_modules/dsh-x`） | `node dev/probe-inject.mjs "D:/.../node_modules/dsh-x"` |
| `dev/asar-find.mjs` | **宿主契约取证**：在 `app.asar` 里按字节搜 ASCII 标记并打印上下文（只读）。R26.3 的「宿主拒绝原地换版本」就是这么定的 | `node dev/asar-find.mjs "D:/DSH/resources/app.asar" "already-installed" 4 700` |
| `dev/ui-narrow.js` | **窄屏实测片段（R20 立的法子，R30 第二次用 → 固定下来）**：把 `measure()` 整个函数体粘进 `client_eval`，它把面板克隆进离屏 360px 容器，区分「真越界」与「主动省略（ellipsis）」，给 `PASS/FAIL` + 明细。⚠️ 它**验不了** `@media (max-width:760px)` 那一段（媒体查询看视口），那部分由 `render-check` 的 5 条文本契约负责 | `client_eval` 粘 `dev/ui-narrow.js` 里的 `measure`（返回 `noHorizontalOverflow` / `overflowing` / `ellipsis`） |

### 宿主契约实测（别靠记忆，先在这里查）

- **`installBundle` 拒绝原地换版本**（2026-10-25 实测，宿主 0.2.1-rc.2 / 0.2.1-rc.3）：
  对**已在 profile 依赖里的包名**，`installBundle("name@新版本")` 直接回 `already-installed`，
  一次 pnpm 都不跑。宿主原文：
  `reasonAlreadyInstalled: "This package is already installed; uninstall it before installing another version."`
  → 「升级」只能是 **卸载旧版 → 装新版**（两步都会写 profile；本机实测 install/remove 后宿主可能重启）。
  **R27 起面板真的走这条路**：卸载由「插件目录」经 `pluginCatalog.removal` 服务执行（判据+执行+留痕在那边），
  本插件负责准备新包、编排、失败装回与中断续跑；没有协作方时**明确拒绝**而不是回 `upgrade-stalled`。
  复验：`node dev/asar-find.mjs <app.asar> "reasonAlreadyInstalled" 2 600`。
- **替换已安装包要下次启动才加载新的 JS 代**（宿主插件开发指南原文：
  *Replacing an installed package requires restart to load a fresh JavaScript module generation.*）——
  所以两阶段升级装完，面板会说「新版本要重启 DSH 才加载」。
- **`ctx.interval` / `ctx.sleep` 是 `timer` 服务的方法**，inject 要声明 `timer`，不是 `interval`。
- **`client.js` 的 `inject: ['slots','layout']` 是 web 平台声明**，不能并进宿主 inject 计算（R26.2）。

GUI 端口每次重启会变：看 `install_hub_status` 最后一行的「远程访问地址」，或运行时给的 GUI URL。

## 「我改了代码，跑的是不是新版？」

唯一可信的是**行为 + 指纹**，不是构建标签（标签只说明磁盘 mtime）：

1. `install_hub_status({})` → 「运行中的代码」一行：
   - `与磁盘一致（宿主 N 个文件 · <digest>）` = 新；
   - `旧（磁盘已改：…，但最后一次 apply 是 …）` = 没换新，重启或等宿主 re-apply。
2. 再补一刀：`probe-live.mjs` 打运行中的宿主，看新字段/新计数有没有回话（`code.fresh` 为 `false` 就是旧代码）。

`lib/*` 改完通常要重启；`client.js` 改完刷新页面即可（记得提 `BUILD` 号，行为自检会验它单调前进）。

## 端到端验收（装 / 升级真插件）

```
node dev/verify-r13.mjs --port <GUI端口> --yes      # 运行中代码指纹 → 提交 → 确认 → ⑧ 诊断
```

中文路径**不要经 bash 传**（控制台代码页会改乱），写进脚本再由 node 读。

## 环境陷阱（本机实测，省你半小时）

- **`ops_bash` / pwsh 沙箱运行器失效**（报 `--temp is not an existing directory: %TEMP%\dsh-*`）时：
  自检一律走 `host_selfcheck`（它在宿主侧起 node，不经过那个运行器）；git 需要
  `sandbox_permissions:"danger-full-access"`（否则 `index.lock: Permission denied`）。
- **别删 `%TEMP%\dsh-*`**：那是沙箱运行器的会话临时目录，删了本次会话所有 pwsh 命令都会失效。
- **pnpm 之后必查 `@deepseek-ai/dsh-tools`**：profile 里多出一份旧版，下次启动整片插件加载失败
  （本地插件用 `node .tools/dsh-plugin-install.cjs`，别跑 pnpm）。
- **验证用的夹具（临时技能目录、测试备份）验证完立即删**，删完 `GET /skills?refresh=1` 确认计数回到基线。
