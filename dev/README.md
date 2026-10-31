# dev/ —— 自检、探针与验收（换会话先看这份）

插件的**状态层**在 `DSH-Plugin/★交接文件·插件安装面板.md`，方法层在 skill
`.dsh/skills/dsh-client-plugin-ops/`。这份只讲「怎么验」，别和那两份重复。

## 三层自检（改任何东西之后都要全绿）

| 层 | 命令 | 期望 |
|---|---|---|
| 自洽（不碰宿主、不 spawn、不写盘） | `node dev/audit.mjs` **或** `host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/audit.mjs"})` | `SUMMARY audit passed`（199 项） |
| 行为（真跑宿主逻辑） | `host_selfcheck({plugin:"dsh-plugin-installer"})` | 日志 `SUMMARY 1123 passed, 0 failed`（工具头部 PASS 数是按输出尾部数的，会少算，**看日志**） |
| 界面（无头渲染） | `node dev/render-check.cjs` **或** `host_selfcheck({..., script:"dev/render-check.cjs"})` | `TOTAL 259 checks` / `all render checks passed` |

改断言数就必须同步：`dev/audit.mjs` 的 `EXPECTED_ASSERTIONS` / `EXPECTED_RENDER_ASSERTIONS`、
`dev/render-check.cjs` 的 `EXPECTED_TOTAL`、`README.md` 与本插件交接文件里的数字（audit 会当场对表）。

> **R37（2026-10-30）**：面板上只剩**一个**「检查更新」—— 主面板「插件与 MCP 更新」。
> 「已装 MCP」浮窗里的那个按钮已删除（只显示同一份结果 + 本地「刷新」）；宿主侧
> `Installer.checkAllUpdates()` 用 `allSettled` 跑两条链，哪一半失败都不拖垮另一半
> （错误写进 `inventory.error` / `mcpError`）。接线判据在 hosttest 的 R37 组与 audit 两条静态断言。

> **R38（2026-10-31）**：Skill 来源台账（`lib/skillledger.js` → `data/skill-sources.json`）：
> 安装成功时记 `owner/repo/ref/commit/仓库内路径/目录指纹`；更新检查只对台账里**有 GitHub 坐标 + commit**
> 的技能调 `commits?path=`，其余如实 unknown；存量技能没有记录 → 只在摘要里算 `untracked`。
> `reinstallSkill()` 先比目录指纹，本地改过要 `confirmEdited:true`，任何重装都要 `confirm:true`
> （覆盖前旧目录进安装前快照）。更新条改名「插件 / MCP / Skill 更新」并挪到「历史」与「环境体检」之间。
> 判据在 hosttest 的 R38 组（19 条）、render-check 的 R38 组（10 条）与 audit 4 条静态接线。

## 探针（离线优先：不用重启也能验判据）

| 探针 | 回答什么 | 跑法 |
|---|---|---|
| `dev/probe-mcp.mjs` | **MCP 判据 42 项（R36）**：组合文件解析 / Registry→安装参数 / 追加文本 / 临时 profile 真写 / 来源台账 / 更新检查三层（Registry、锁版本 npx、未锁→unknown） | `host_selfcheck({..., script:"dev/probe-mcp.mjs"})` |
| `dev/probe-mcp-live.mjs` | 真实 profile 上 MCP 视图（本机 0 台）+ 真查一次 Registry；只读 | 同上，script 换 `dev/probe-mcp-live.mjs` |
| `dev/probe-mcp-wire.mjs` | 真 search 并入 MCP 候选、假 LLM 保留 `kind/installPath/requiredEnv`（11 项） | 同上，script 换 `dev/probe-mcp-wire.mjs` |
| `dev/probe-mcp-append-real.mjs` | 复制真实 579 行 `cordis.patch.yml` 到临时目录，走一遍追加 → 原文不少 / 备份=原文 / 写后复核（5 项） | 同上，script 换 `dev/probe-mcp-append-real.mjs` |
| `dev/probe-archive-subdir.mjs` | **R38 收口判据（KNOWN-RED，R39 要先修）**：GitHub 归档的 `repo-<ref>/` 包装 × tree 链接的 `subdir`。真机 e2e 实测 `detectKind(tmp,{subdir})` 把 subdir 拼在解包根上 → kind=unknown；同时 `wrappers` 会把技能目录本身也折进去（不能当仓库内路径用）。`--strict` 在修好前应退 1 | `node dev/probe-archive-subdir.mjs [--strict]` |
| `dev/probe-skill-e2e.mjs` | **R38 端到端**：装一个真实 GitHub Skill（默认 `anthropics/skills` 的 `brand-guidelines`）→ 校验台账坐标 → 三条链检查更新 → 改本地文件后重装应被拒 → `confirmEdited` 后重装 → 清理。**默认 dry-run**；`--apply` 才真写技能根（`--keep` 保留） | `host_selfcheck({..., script:"dev/probe-skill-e2e.mjs", args:["--base","http://127.0.0.1:<端口>","--apply"]})` |
| `dev/fixtures/stacking/index.html` | **R36 层叠夹具**：`?old=1` 复现「下拉被后面卡片盖住」，不带 query 是修复后；看 `window.__stackResult.menuItemHit`。可用浏览器打开，或 `lemofilm_stills` 出 old/new 静帧 | 直接打开 / `lemofilm_stills({project:"…/dev/fixtures/stacking", q:"old=1"})` |
| `dev/probe-crash.mjs` | 真实崩溃日志上，`readNewestCrash` + `inspectProfile` 现在怎么判（两类日志 / sibling / stale / 来源处置） | `host_selfcheck({plugin, script:"dev/probe-crash.mjs"})` |
| `dev/probe-skills.mjs` | 真实技能根上，YAML 判据会不会误报、`fixable` 怎么分 | 同上，script 换 `dev/probe-skills.mjs` |
| `dev/probe-search.mjs` | 本机官方 `@deepseek-ai/*` basename 有哪些；影子包标注对不对。带 `DSH_PROBE_SEARCH="<查询>"` 会真联网搜一次 | `host_selfcheck({..., script:"dev/probe-search.mjs", env:{DSH_PROBE_SEARCH:"dsh-base"}})` |
| `dev/probe-live.mjs` | **运行中的宿主**到底是不是磁盘这一版：`/state` 的 build、`/health` 的 code、`/skills` 的计数与 YAML；带 `DSH_PROBE_LIVE_SEARCH=1` 会打一次 `/search` 看 `shadowOf` | `host_selfcheck({..., script:"dev/probe-live.mjs", args:["<GUI端口>"]})` |
| `dev/probe-rev.mjs` | **上次那个没激活的前端入口修没修**：先用固定向量验 rev 算法（其中一条是真机观测值），再把最近一份 `crash-*-web-boot.log` 里点名的每个包与磁盘对账（`same` / `rebuilt` / `unknown`）。`--full` 连体检结论与面板动作一起打 | `node dev/probe-rev.mjs --full`（自动往上找 `.dsh/profiles/<name>`，也可 `--profile <dir>`） |
| `dev/probe-sources.mjs` | **「已装分来源」在真 profile 上是什么结果**：多少依赖能算出 `host/owner/repo`（对账下限）、link 与 npm 样本、三条对账（同仓库 `same` / 换仓库 `different`(warn) / link `different`(**error**) / 未知 `unknown`）、以及「你搜的是本机插件」那句话 | `node dev/probe-sources.mjs`（同样自动找 profile，可 `--profile <dir>`；不联网） |
| `dev/probe-bridge.mjs` | **跨插件契约探针（R27）**：把真的 `CatalogService` 装成 `pluginCatalog` 服务，用 installer 的 `describeRemovalProvider()` 去探测，再按真实调用方式走一遍 plan → apply（apply 用**假宿主**，不会真卸载），核对两边字段（`token` / `expiresAt` / `text` / `warnings` / `blockers` / `verified` / 一次性 token / 老版本降级）。协作方不在本机时 **SKIP** | `node dev/probe-bridge.mjs` |
| `dev/probe-live-upgrade.mjs` | **「现在能不能真升级」一条命令（R27 收尾）**：只读三个 GET —— installer 路由在不在 / 入口是不是新的（`appliedAfterLoad`）/ `state.collaborator` 可用 / 「插件目录」的 api 与 `removeBundle`。端口取 `DSH_WEB_URL`（每次重启都会变，别写死）；对端不健康时**如实降级**（别的会话的中间态不算自己的失败） | `node dev/probe-live-upgrade.mjs [--base http://127.0.0.1:<端口>]` |
| `dev/probe-pnpmstate.mjs` | **profile 的 pnpm 世代还说得通吗（R29）**：五问一次答 —— ① 世代（package.json / lockfile / `.modules.yaml` 的 mtime + `prunedAt`，即「上一次 pnpm」）② 规模（声明 vs lockfile 记录 / 版本对不上 / 没记录 / 已卸还留着 / 版本不一致）③ 样本（逐条点名）④ 结论（`judgePnpmState` 一句话 + 体检会报的标题与前两步处置）⑤ 归因（`data/profilestate.json` 里最新一条**不是本面板干的**变更）。**只读**：不写盘、不跑 pnpm | `node dev/probe-pnpmstate.mjs`（自动找 profile；可 `--profile <dir>` / `--journal <路径>`） |
| `dev/probe-local.mjs` | **本机目录会得到什么回答（R33）**：`lib/probe.js` / `install_hub_probe_repo` 只收 GitHub 与 npm，而「把本机压缩包拖进面板」是最常见的路径 —— 这一条解包后直接在目录上跑同一套判据（`detectKind` → `scanTree` → `judgePurpose` → `precheck`），打出识别 / 第 8 类身份（`python-app` 等）/ 静态扫描与**覆盖** / 预检会说的原话。**不安装、不动 profile、不建任务** | `node dev/probe-local.mjs "<解包目录>"` |
| `dev/probe-pnpm-resolve.mjs` | **「这条 pnpm 策略报错是包的问题还是 profile 的问题」（R35）**：把 profile 的 `package.json` / `pnpm-workspace.yaml` / `.npmrc` 复制到**临时目录**，用 DSH 自带的 pnpm 跑一次 `install --lockfile-only --ignore-scripts`（git 依赖先摘掉并记账）。基线干净 → 违规来自**状态**（陈旧 lockfile），加豁免没用；基线就违规 → 是链路本身。`--pin 包=版本` 可模拟升级 | `node dev/probe-pnpm-resolve.mjs [--pin @liustack/modsearch=5.10.11] [--keep]`（宿主进程里跑也行：`host_selfcheck({script:"dev/probe-pnpm-resolve.mjs"})`） |
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

`lib/*` 改完通常要重启；`client.js` 改完**必须整体重启 DSH**（不要只刷新页面：宿主按内容 hash 发的 bundle rev 会 404，整页卡在 Loading plugins；记得提 `BUILD` 号）。

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
