# dsh-plugin-installer · 插件 / Skill 安装面板

[English](README.en.md)


侧边栏一个图标，点开是「插件 / Skill 安装」面板：把 GitHub 链接、Release 页、`.tgz`/`.zip`
直链，或者本机压缩包/目录丢进去，面板自己完成 **下载 → 解包 → 识别 → 安全预检 → 快照 →
安装 → 诊断 →（按需）回滚**。

**安装执行全程不调用模型**：确定性代码在宿主侧跑，AI 只做「推荐」和「递请求」。
本机实测一次 Skill 安装 **约 1.8 秒**、插件安装到确认前 **约 0.6 秒**，都不花 token。

```
侧栏图标（红点在这里） ─┬─→ 点开 = main 面板
                        └─ 红点只在「装失败 / 等你确认 / 诊断有冲突」时亮
```

---

## 1. 它在哪、怎么用

> **R2（2026-10-20）新增三件事**，都不改九步流水线：
> 1. **诊断卡默认就写「怎么解决」**：每条发现带 `fix: [{text, command?}]` 步骤清单，命令可一键复制；
> 2. **「大白话解释」开关**（用户指定的名字，别再改回「通俗讲给我听」）：卡片右上角，
>    存 `localStorage` 的 `dpi.plain-explain`；打开后把术语换成大白话，原文收进「术语原文」折叠。
>    诊断卡本身**永远**先给一句大白话结论（`diagnosis.plain`）。
> 3. **7z / rar 现在能装了**：借 Windows 自带的 `%SystemRoot%\System32\tar.exe`（bsdtar +
>    libarchive 3.8，本机实测能造能解 7z），解完**再按实际落盘的东西**复核围栏
>    （链接/数量/单文件/总量/压缩比），因为 bsdtar 自己不管这些。zip64 与少见存储方法
>    （deflate64 等）也走同一个兜底。
>
> 自检从 92 → **111 项**（新增：`plain`/`fix` 数据契约、client 静态契约、7z 往返 + 围栏）。
> 7z 那组要 spawn 子进程，**只能在宿主进程里跑**（见 §7 的 `host_selfcheck`），沙箱里会 EPERM。
>
> **R3（2026-10-20 04:00）再加两件**（宿主侧代码，重启生效）：
> 1. **搜索从 2 个源扩到 6 个源**（npm 两串 / GitHub 两串 / topic 发现 / **dsh-hub.cc 商店目录**），
>    每条命中带 `trust`（官方、许可证、有源码、近期更新 + 红旗：无仓库、已归档、刷星、
>    **年轻但星极多**）与 `popularity`（**npm 周下载量**、**商店安装量/评分**、stars、本机评分）。
>    见 `lib/sources.js`。
> 2. **按用途判断权限是否合理**（`lib/purpose.js`）：推断用途档（界面/网络/媒体/运维/数据/Skill）
>    → 与扫描到的能力对账 → `ok / warn / error / unknown` + 大白话 + 建议；预检卡新增
>    「用途 vs 权限」块。**eval/vm/new Function/混淆 在任何用途里都算 error；Skill 里带可执行文件
>    直接 error；用途认不出来就不判。**
>
> 自检 111 → **132**；无头渲染 12 → **18**；新增只读探针 `dev/probe-repo.mjs`
> （下载→解包→扫描→预检+用途判定，**不安装**）。
>
> **R4（2026-10-20 13:10）把「花多少 token」变成可测的**：确定性步骤全部 **0 token**，
> 唯一模型调用是异步 AI 审查（实测材料 7,055 字符 ≈ **2.5k 输入**，封顶 ≈4k）；
> 新增 `reviewWorthIt()`（只有安装脚本/提示注入/高危命中/用途不符才审，否则**跳过并写明理由**）、
> `estimateReviewTokens()`（面板显示「≈2610 token」或「省下 ≈2650 token」）；
> 并收紧扫描规则：`obfuscation` 只认长 base64 字面量、`native` 不再误吃 `'egress.node'`，
> **每条命中带 `why`**。自检 132 → **152**，渲染 18 → **22**。
>
> **R5（2026-10-20 18:40）修三件「自检查不到」的事**（宿主侧，重启生效）：
> 1. **命中密度不再被丢掉**。`scanTree` 一直同时算了 `counts`（样本，每类最多 5 条）和真实分布，
>    但摘要只读前者 —— 实测 `dsh-our-free-model` 面板上全是「×5」，真实是 **74 个文件都在发网络请求**。
>    现在新增 `density`（每类能力出现在**几个文件**里，跨文件精确、零额外成本），摘要改用它，
>    面板显示「网络请求(74 个文件)」；`purpose` 的发现也带「N 个文件里都有」。
>    同时加一条 **`bundle-payload` 组合信号**：同类命中铺满几十个文件时折成一条，
>    明说「这是把依赖/bundle 一起提交的仓库，按发布者可信度判断，别逐条数命中」。
> 2. **搜索加了 TTL 缓存**（`memoizeTtl`：同 key 5 分钟一次、并发共享、抛错不缓存；
>    npm 下载量 30 分钟）。原因很实：一次搜索固定 6 个源 + 最多 10 个下载量请求，而
>    **GitHub 搜索 API 未认证只有 10 次/分**（一次搜索用 3 次）→ 一分钟内第 4 次搜索必 429。
>    撞限流时输出里直接给「设 `DSH_GITHUB_TOKEN` 可提到 30 次/分」的处置。
> 3. **文案与实现对齐**：工具数 4 → **5**（启动日志按实际数量打印）、`install_hub_search_plugins`
>    描述写明 **6 个源（含 dsh-hub 商店评分/安装量）**、AI 推荐提示词说明候选来自商店、
>    删掉 `download.js` 里已无调用方的旧 `searchNpm`/`searchGitHub`。
>
> 自检 152 → **172**，渲染 22 项不变。
>
> **R5.1（2026-10-20 19:05）把 R5 列出的四个缺陷修掉**（宿主侧，重启生效）：
> 1. **构建标记**：`buildStamp()` = package 版本 + 源码（index.js / client.js / lib/*.js）里最新 mtime →
>    `/health` 的 `build` 不再是写死的 `"p2-pack"`，`/state` 的 `host.build`、
>    `install_hub_status` 第二行、环境体检卡都能看到。`client.js` 另加 `BUILD` 号随 `client-state` 上报。
> 2. **「等待确认」的现场有保鲜**：`prune()` 现在用 `stagingKeepNames(pkg, jobs)` ——
>    没跑完的任务（queued/running/awaiting-confirm）引用的 `staging/uploads/<ts>/` 与
>    `staging/<jobId>/` 不再被 24 小时 mtime 清掉（以前跨夜 + 重启 = lost-state）。
> 3. **升级 / 降级 / 同版本重装说清楚**：预检读 `profile/node_modules/<name>/package.json`，
>    新增理由「这是升级：已装 0.0.5 → 本次 0.1.0」，降级给 **warn**。
> 4. **商店源用满**：`shapeHub` 展示「分类 · 界面」徽章、安装量 why 带评论数/点装数，
>    hub 搜索取 `min(20, per*2)` 条再本地重排。
>
> 自检 172 → **194**（+build 4、+prune 4、+installed 6、+hub 4、+client/index 静态契约 4）。
>
> **R6（2026-10-20 19:30）面板「设置」——个性化，但不放松判据**。右上角「设置」：
> 1. **提醒**：侧栏红点（默认开）、声音（默认关，WebAudio 一短音）、桌面弹窗（默认关，
>    `Notification`；未授权先问一次）。红点关掉后 `attention.dot=false`，但 `count/items` 照常给。
> 2. **审核三档**：严格（检出任何能力特征就停 + 低/中危也 AI 审一次）→ **普通（默认 = 现有强度）**
>    → 关闭（不停、不调模型，但 profile/未识别/版本不兼容 **照样阻断**）。
> 3. **「跳过审核」按钮**（默认开）：只在「等待确认 + 这次本来要审」时出现；点击后**原地二次确认**
>    （写明不停下 / 不花 token / 风险提示仍有效 / 可回滚），宿主留痕 `reviewSkipped` 与日志。
> 4. **其余**：轮询 2.5/5/10s、历史 5/8/20 条、快照 20/40/80 份、搜索源 npm/GitHub/商店（至少留一个）。
>    落盘 `data/settings.json`，**默认档 = 标准版**；写坏了会被归一化夹取回默认。
>
> 自检 194 → **245**（+设置 23、审核三档 9、红点与跳过审核 7、搜索源 3、路由/客户端契约 9）；
> 渲染 22 → **42**（真渲染设置面板两轮 + 跳过审核按钮三态）。
>
> **R7（2026-10-20 19:20）自检热键 `Ctrl+Alt+D`**（纯客户端）：任意页面按一下就跑一次环境自检
> （复用宿主 `action:"repair"`，不新开一套判据），结果用**游离浮窗**报（面板没挂载也看得见），
> 浮窗自己消失、热重载先摘旧监听（否则一次按键发 N 个请求）；键位存 `dpi.selfcheck.hotkey`，
> 可在设置里改 `Ctrl+Shift+D` / `Alt+Shift+D` / 关闭；有任务在跑时拒绝动手，宿主 `doctor(apply)`
> 也有并发闸。自检 +15 → **260**。

> **R8（2026-10-20 19:40）把「装完就起不来」的判据并进面板**（宿主侧，重启生效）：
> 1. **预检第 ⑤ 项：工具注册契约**（`lib/contract.js`）。DSH 0.2.1 起 `ctx.tools.register()`
>    要求 `output { schema, render }`，漏了不是静默降级 —— 插件激活失败；required 插件还会让
>    **整次启动中止**（症状：恢复对话框 + 一串「等待服务」的插件，2026-10-18 就这么挂的）。
>    现在**装之前**扫解包目录（`precheck` 给 warn + 两条处置步骤），**装之后** `diagnose`
>    再扫一遍已装的目录，直接进诊断卡。
> 2. **环境体检扩成 7 类**（`lib/profilehealth.js`）：`dsh.profile.bundles` 与 node_modules 对账
>    （被「禁用第三方插件」按钮裁到 2 项也认）、已装插件的 output 契约、pnpm 的 dsh-tools 钉子是否
>    随宿主升级过期、最近一次 `crash-*-host.log` 点名了哪些插件。`apply:true` 除原有两项外，
>    还会**把钉子同步到宿主版本**、**从最近快照写回 bundles/patch**（写前自动再存一份快照）。
> 3. **一次调用看全**：`install_hub_doctor` 默认只回「一行结论 + 每条发现一行」，`verbose:true`
>    才带 detail；`contract:false` 可跳过已装插件扫描提速。换会话 / 装完 / 起不来时只需这一个工具。
> 4. 自检 260 → **269**（+契约扫描 4、profile 体检与修复 5）。
>
> **R6.1（2026-10-20 22:30）把「怎么验收」固化成 `dev/audit.mjs`**（收尾轮）：
> 28 项自洽检查 —— **默认档冻结快照**（改 `DEFAULTS` 而不改承诺会红）/ **5 个工具的 output 契约** /
> **构建标记格式**（`0.1.0 · YYYY-MM-DD HH:MM`，且 `/health` 不许写死）/ 客户端设置与热键入口 /
> `settings.json` 归一化后逐字不变 / 等待确认任务的 staging 现场还在 / README 与交接文件里的
> 断言数是否等于 `EXPECTED_ASSERTIONS`。**不碰宿主、不 spawn、不写盘**，只打印
> 「接着跑 host_selfcheck（328）+ render-check（50）」。
> 三层分工至此固定：**audit = 自洽，host_selfcheck = 行为，render-check = 界面**。
> 线上实测：构建标签 `0.1.0 · 2026-10-20 19:45`、客户端 `r6.0`、`GET/POST /settings` 正常
> （非法值当场夹取回默认）、`clientReport` 里有 360×658 的窄屏实例。
>
> **R9（2026-10-22 01:15）「装不上」时说清为什么、并给出真能走的一步**（宿主侧；实测被运行中的宿主重新 apply，未重启即生效，但别把它当保证）：
> 1. **失败分诊**（新 `lib/installfailure.js`）：把宿主自己的两条判据搬到面板 ——
>    ① pnpm 失败的 10 类（`build-blocked` / `not-found` / `no-matching-version` / `disk-full` /
>    `permission` / `integrity` / `network` / `timeout` / `pnpm-missing` / `unknown`，次序与正则
>    **照抄** `dsh-plugin-manager` 的 `LOG_KINDS`）；② `ManagementFailure` 的 11 个拒绝码
>    （`incompatible-version` / `already-installed` / `ambiguous-install` / `not-bundle` /
>    `invalid-spec` / `stale-approval` / `management-required` / `stop-profile` / `bundle-in-use` /
>    `not-removable` / `unaddressable`）。每条都给「为什么（大白话）+ 建议 + 2–3 条处置步骤」，
>    原始输出留 4 KB。**以前**：只有 pnpm 的英文原文；宿主拒绝时甚至只有一行 `incompatible-version`。
> 2. **安装脚本待批准的完整闭环**：pnpm 拒绝执行构建脚本时，宿主机把包名以哨兵
>    `"set this to true or false"` 写进 profile 的 `pnpm-workspace.yaml → allowBuilds` 然后失败。
>    面板现在：读回名单（`parseAllowBuilds`，不引 YAML 依赖）→ 卡片逐个列名 + 二次确认 →
>    经 `installBundle(spec, { approvedBuilds })` 转交（宿主自己写 `allowBuilds=true` 再跑 pnpm；
>    名单过期它抛 `stale-approval`，我们翻成人话）。**复核在宿主侧**：只接受仍然 pending 的包名，
>    面板不提供「一键放宽权限」。
> 3. **模型拿不到这个动作**：`approve-builds` 只在面板路由里，五个工具都没有它 ——
>    「让作者写的脚本在本机执行」只能由人来按。
> 4. **体检多一条**：profile 里还挂着待批准脚本（跨任务残留，会挡住下一次装同一个依赖），只报不修。
> 5. **顺手修掉一个真 bug（线上撞出来的）**：`save()` 用固定 `state.json.tmp`，
>    而「action 响应里顺带跑的 `snapshotState()` → `ensureReconciled()` → `save()`」会和新任务的
>    `execute()` 撞在同一个 tmp 上 —— 先完成的那次 rename 走了文件，后一次报
>    `ENOENT: rename 'state.json.tmp' -> 'state.json'`，而这条错误会被当成**安装失败**记在任务上。
>    现在：save **串行** + 每次唯一 tmp 名 + rename 对瞬时错误（ENOENT/EPERM/EACCES/EBUSY）重试；
>    `settings.json` 同样处理。实测证据：修前那条重试任务报 ENOENT，修后同一条重试报出真实原因
>    （「认不出这是压缩包」）。
> 6. 自检 269 → **328**（+59：分诊 10 / 文案与拒绝码 14 / 批准闭环 20 / 落盘竞态 3 / 接线与暴露面 12），
>    无头渲染 42 → **50**（+8：批准卡两态），自洽 28 → **39**。

| 项目 | 值 |
|---|---|
| 包名 | `dsh-plugin-installer` |
| bundle 行 id | `plugin-installer` |
| 面板 id | `installer`（`sidebar.panellist` 的 id 与 `main` 的 key 相同） |
| 路由前缀 | `/plugin-installer` |
| 数据目录 | `<本插件>/data/`（`state.json`、**`settings.json`**、`snapshots/`、`vendor/` 重打包产物、`staging/` 一次性、`logs/install.log`） |
| 宿主工具 | `install_hub_status` / `install_hub_search_plugins` / `install_hub_submit_request` / `install_hub_review` / `install_hub_doctor` |

用法就三条：

1. **贴链接/路径** → `安装`。回车即可，Shift+Enter 换行。
2. **拖文件进来**：把 zip 从资源管理器拖到面板上（≤80 MB）；更大的先放到本机再填绝对路径。
3. **只记得名字** → 直接填名字点 `安装`（会先给候选）或点 `只搜索`；也可以在 `AI 推荐` 里用一句话描述需求。

底部的 **环境体检** 是两次手工救火固化进来的（R8 起合并成一次）：安装环境（dsh-tools 覆盖、悬空
`file:` 依赖、pnpm trustPolicy、git）+ **profile 层**（bundles 与实物对账、已装插件的 `output` 契约、
dsh-tools 钉子是否过期、最近一次崩溃日志），可一键修其中四项（幂等，写前自动快照）；还顺带给手机那条
`tailscale serve` 命令。

网盘链接（百度/夸克/阿里/123/蓝奏…）**不会自动下载**：面板认出域名后直接告诉你
「手动下载后拖进来」，因为登录态、验证码、限速都不是面板该碰的。

---

## 2. 流水线（九步，前一步不过就短路）

| 步 | 做什么 | 判据 / 围栏 |
|---|---|---|
| ① 输入接入 | 分类链接、补默认分支、选 Release 资产 | GitHub API 拿默认分支；有 `.zip/.tgz` 资产优先用资产，否则 `codeload` 源码归档；网盘/普通网页直接拦下 |
| ② 下载 | 流式落 `data/staging/<job>/dl/` | 超时 120s、`content-length` 与实收字节双上限（默认 256 MiB）；直链返回 HTML 会明确报「链接失效/要登录」 |
| ③ 解包 | **只看魔数**，不看扩展名 | zip（store/deflate）、tar（ustar+prefix+pax）、tar.gz；7z/rar/exe 只识别不执行；路径围栏（绝对路径/`..`/NUL/超深/超长一律整包拒绝）、**符号链接/硬链接整包拒绝**、总量/单文件/文件数/压缩比四道上限 |
| ④ 识别 | 严格短路：`dsh.bundle` → bundle；`dsh.profile` → 拒绝；`SKILL.md`（根或一层包装内）→ Skill；都没有 → 未识别（含可执行/安装器则标记人工确认） | 先做「单子目录塌缩」剥掉 `repo-main/`、`package/` 这类包装；Skill 还会校验 frontmatter 的 `name`(kebab)/`description` |
| ⑤ 安全预检 | 版本兼容 + engines + 静态危险能力 + 信任策略 | 版本判定**用官方实现**：动态 import 安装目录 asar 里的 `@deepseek-ai/dsh-app-boot`，调它自己的 `evaluatePluginCompatibility()`（本机实测 `via app-boot(asar)`，runtime `0.2.1-rc.2`）；拿不到才降级到本地 semver 并在面板上写明。静态扫描 13 类特征（子进程/eval/vm/shell/文件读写/网络/混淆/env/原生/安装脚本/动态加载/提示注入），逐条给文件:行号 + 脱敏片段 |
| ⑥ 等待确认 | 只有**有告警**才停：中危以上、有 `postinstall`、能力与声明明显偏离、版本无法确认 | 确认后继续；取消则整条任务作废，一个字节都没装 |
| ⑦ 安装前快照 | 复制 profile 三件套 + 插件/行清单 + 技能目录名，并整份备份**将被覆盖的同名技能** | 快照写在 `data/snapshots/snap-*`，保留最近 40 份 |
| ⑧ 安装 | 插件走 `ctx.pluginManager.installBundle()`；Skill 复制到技能根 | **装的就是扫描过的那份字节**：插件用解包后的本地绝对路径作为 spec，不是让 pnpm 再去网上下一次 |
| ⑨ 安装后诊断 | bundle 是否在清单/是否 enabled/`availability`/行是否 failed/跨 bundle 重复 id；Skill 是否出现在 `ctx.skills.list()`、是否被更高优先级同名覆盖 | 每条结论带下一步动作与可复制命令；需要时给「回滚」按钮 |
| ⑩ 按需 AI 审查 | 仅当⑤标记了 `needsAiReview`，且**异步**、不阻塞安装 | 只喂被标记片段 + 安装脚本 + manifest 声明；先 secret redaction；判 `malicious` 标红并建议回滚，判 `safe` 不单独放行 |

---

## 3. 信任模型（为什么它敢碰安装）

```
浏览器半边  ──HTTP──▶  宿主半边（确定性）  ──▶ ctx.pluginManager / 文件系统
      │                      ▲
      └── AI（只能）─────────┘  搜索 / 推荐 / 递请求
```

* **AI 不能装**。面板里的 AI 只有三件事：`search_plugins`（直接调确定性搜索）、
  `recommend_plugin`（在候选里挑并给理由，候选之外的包名一律丢弃）、
  `submit_install_request`（就是那个「安装这个」按钮）。它没有工具、不写文件、不读整包。
* **接口只认三种来源**：本机回环；`dsh-app://app`；**同源**（Origin 的 host 等于请求 Host）。
  第三种是为了手机经 Tailscale 打开同一个 DSH 实例时可用 —— 能打开这个 GUI 的人本来就能控制这台 DSH，
  所以面板不额外扩大暴露面。
* **provenance 只作加分**：npm 的构建来源证明能说明「从哪个仓库构建」，不证明代码安全，
  所以它只进「信任说明」，从不作为唯一放行依据。

---

## 4. 快照 / 回滚（含两个本机专属的坑）

回滚顺序：卸插件（`removeBundle`）→ 还原 profile 三件套 → 清掉悬空 `link:` 链接 →
回滚技能（还原备份或删除）→ 再扫一次 dsh-tools。已完成的步骤如实报告，不假装全成功。

### 坑 A：pnpm 跑完，宿主会重启

本机实测：`installBundle()` 写完 `package.json`/`cordis.patch.yml` 之后宿主进程会重启。
所以流水线在**调用安装之前**就把 `install` 阶段落盘，重启后 `ensureReconciled()`
核对「其实装上了没有」—— 装上了就把任务改回 `done` 并补跑诊断，不会把成功永远显示成失败。

### 坑 B：pnpm 会在 profile 里埋 `@deepseek-ai/dsh-tools`

这是本机复发四次的雷：profile 里多一份 dsh-tools（**版本相同也炸**）→ 下次启动插件批量
加载失败（`reading 'prepare'`）。`overrides` 只管版本号、`autoInstallPeers: false` 也挡不住
`link:` 本地包。面板的处置：

* 启动时扫一次，有就挪进 `.tools/backups/dsh-tools-stale-*`（与 `dsh_doctor.py --fix` 同一处置）；
* **每次 pnpm 之后**（安装完、回滚完）再扫一次；
* 扫到过就在面板顶部留一条可追溯的黄色提示，带「再查一遍」按钮。

手动兜底：`host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/quarantine-dshtools.mjs"})`
或 `python .tools/dsh_doctor.py --fix`。

---

## 5. 边界（明确不做）

| 不做 | 原因 / 替代 |
|---|---|
| 不运行 `.exe`/`.msi`/`.dmg`/`.deb` 等系统安装器 | 识别出来只标记 `pending_manual_review`，把文件路径给你 |
| 不自动下载网盘链接 | 登录态/风控；手动下载后拖进来 |
| 不让 AI 执行安装或写文件 | 见信任模型 |
| 不在多个 profile 间让用户选 | 统一装当前/默认 profile（桌面端 `desktop`）；手机是同一实例的远程视图 |
| 7z / rar / zip64 / 加密 zip 不解 | 魔数认得出，但明确回「请用 7-Zip 转成普通 zip」 |
| 不自己写移动端适配 / 角标系统 | 用标准 `sidebar.panellist` + `main` 席位，窄屏由外壳决定抽屉；红点画在入口图标上 |
| 不负责「管」（停用/卸载/分组） | 检测 `dsh-plugin-desk`/`dsh-skill-manage`/`dsh-skill-toggles` 等是否已装，装了就让它们管；本插件只负责「装」和「诊断」 |

---

## 6. 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/plugin-installer/state` | 面板状态：任务、阶段、红点、宿主事实、warnings |
| GET | `/plugin-installer/health` | 自检：**构建标记（源码 mtime）**、版本、路径、五个工具在不在、dsh-tools 有没有被埋 |
| GET | `/plugin-installer/doctor` | 环境体检（只读）：dsh-tools / 悬空 `file:` / trustPolicy / git / 手机命令 |
| POST | `/plugin-installer/submit` | `{input}` → 建任务（网盘/普通网页会直接返回原因） |
| POST | `/plugin-installer/search` | `{query}` → 候选（6 个源：npm ×2 / GitHub ×3 / dsh-hub 商店；5 分钟内走缓存） |
| GET | `/plugin-installer/settings` | 个性化设置 + 默认值 + 合法档位 |
| POST | `/plugin-installer/settings` | 设置补丁（逐项合并并落盘 `data/settings.json`） |
| POST | `/plugin-installer/action` | `{action,id}`：`confirm`/`skip-review`/`cancel`/`ack`/`rollback`/`review`/`rediagnose`/`repair`/`fix-landmine`/`integrations` |
| POST | `/plugin-installer/upload` | 原始字节 + `x-file-name`，落到 staging 后立即提交 |
| POST | `/plugin-installer/ai` | `{message}` → 搜索 → 推荐（结构化） |
| GET | `/plugin-installer/ai-status` | AI 通道可用性与当前默认模型 |
| POST | `/plugin-installer/client-state` | 客户端自报（排查用，只发结构化摘要） |
| GET | `/plugin-installer/debug/inventory` | 只读：插件清单原始结构 |

---

## 7. 自检与排障

**三个层次，别混**：`audit` = 自洽（不碰宿主）→ `host_selfcheck` = 行为 → `render-check` = 界面。

```bash
# ① 自洽体检（最快，不碰宿主、不重启；换会话先跑这条）
node DSH-Plugin/dsh-plugin-installer/dev/audit.mjs
#   39 项：默认档冻结快照 / 5 个工具的 output 契约 / 构建标记形如「0.1.0 · 2026-10-22 01:15」/
#   契约扫描与 profile 体检是否真的接着线 / 失败分诊与批准闭环是否接线 / 「批准」没暴露给模型 /
#   客户端设置与热键入口 / settings.json 归一化后不变 / 等待确认任务的 staging 现场 /
#   README 与交接文件里的断言数是否等于 EXPECTED_ASSERTIONS（改测试就同步它）

# ② 328 项确定性自检（解包围栏 / 识别短路 / 扫描与密度 / 快照回滚 / 重打包 / prune 保鲜 / 地雷 /
#   契约扫描 / profile 体检与修复 / 已装版本对照 / 设置归一化与审核三档 / 红点与跳过审核门禁 /
#   热键 / 7z 往返与围栏 / 搜索缓存 / 工具契约 / pnpm 失败分诊 / allowBuilds 解析 / 批准重装）
host_selfcheck({ plugin: "dsh-plugin-installer" })

# ③ 无头渲染自检（微型 React 真的渲染一遍；50 项：诊断卡 / 预检卡 / 审查卡 / 设置面板 /
#   跳过审核按钮 / 安装脚本批准卡（默认态 + 二次确认态））
node DSH-Plugin/dsh-plugin-installer/dev/render-check.cjs

# 环境体检：只读 → 修（幂等：挪 dsh-tools、从 node_modules 重打包补回 .tgz）
install_hub_doctor({})
install_hub_doctor({ apply: true })

# 面板体检（工具形态，任何会话都能用）
install_hub_status({ verbose: true })

# 直接问宿主
curl -s http://127.0.0.1:<GUI端口>/plugin-installer/health

# 两个现场脚本（都要宿主权限，所以走 host_selfcheck）
host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/quarantine-dshtools.mjs" })      # 清 dsh-tools 覆盖
host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/restore-vendor-tarball.mjs" })   # 补回被删的 .tgz
```

出问题时的顺序：

1. 面板顶部有没有黄色条（dsh-tools 被埋）→ 点「再查一遍」；
2. `state` 里 `attention` 的 `reason` 就是红点那句话；
3. 任务卡在「⑧ 安装」且提示「宿主中途重启」→ 面板会自动回填，刷新一次即可；
4. 插件装了但没生效 → 诊断卡会写「为什么」：未 enabled / 行 failed / 重名 rowId / 需要重启；
5. 对结论有疑问 → 该任务的「重新诊断」（诊断器自己改进过之后也用它刷掉旧结论）；
6. 想彻底退回去 → 该任务的「回滚到安装前」。

手机/远程：**先看 `serve-watch.state.json`**（`ok` + `target` 是不是等于当前端口）。
DSH 每次启动换随机端口（`dsh-desktop-host` 里写死 `--port 0`），所以 `tailscale serve` 会指旧端口。

- **一次性**：`dev/fix-tailscale-serve.ps1`（管理员），自己找当前 GUI 端口再指过去。
- **一劳永逸**：`dev/install-serve-watch.ps1`（管理员，只需要一次）。它注册开机任务
  `DshServeWatch`（RunLevel Highest），跑 `dev/serve-watch.ps1`：
  - 每 20 秒核对一次端口，变了就自己 `tailscale serve` 重指；
  - **全局热键默认 `Ctrl+Alt+Y`**（`ctrl+alt+y → ctrl+alt+g → alt+shift+t` 依次试，
    被 QQ 之类占掉的会跳过并记进日志），按一下立刻重指；
  - 状态落 `dev/serve-watch.state.json`，事件流落 `dev/serve-watch.log`（JSONL）；
  - 自带 `-StatusOnly` / `-Once` / `-SelfTest`（自测往自己线程 `PostThreadMessage(WM_HOTKEY)`，
    不按键盘也能验链路）；`install-serve-watch.ps1 -Remove` 卸载。
- ⚠️ **旧脚本那半个 bug 已修**：它原来只认「`/plugin-installer/health` 返回 200」。
  本机 B 站客户端的本地端口 **22331** 对任意路径都回 200，端口号又比 DSH 的小，
  于是「扫到的第一个 200」把 ts.net 指到了 B 站 —— 手机打开是一张奇怪的网页，而不是 DSH。
  现在两个脚本都要求响应体里有 DSH 独有字段（`profileDir` / `versions.dsh`），
  并且**优先探 DSH 进程自己的监听端口**（按进程启动时间倒序）。


---

## 8. 验证记录（2026-10-20，本机；2026-10-22 R9 复跑）

| 场景 | 结果 |
|---|---|
| 确定性自检 | **328/328 通过**（`dev/hosttest.mjs`，含 zip/tar 构造、穿越与软链接拒绝、比例炸弹、5 种识别分支、快照还原、重打包往返、prune 引用保护、地雷处置、契约扫描、profile 体检与修复、设置归一化、审核三档、热键、pnpm 失败分诊、allowBuilds 解析、批准重装与三道闸、落盘串行）；另 **50 项**无头渲染 + **39 项**自洽体检 |
| Skill 端到端（本机目录） | 1.8s 完成：识别 `dpi-selftest` → 预检通过 → 快照（插件 57/行 233/技能 54）→ 落位 → 诊断 ok（`skills: 58`）；技能目录清单**当场出现**该技能 |
| 同一任务回滚 | 技能目录被删除、profile 三件套「未变化」、技能目录清单里它消失 |
| GitHub 端到端 | `github.com/octocat/Hello-World`：API 983ms → 下载 504ms → 解包 4ms → 识别为「未识别」→ 预检**阻断**并红点；耗时与原因都写在面板上 |
| 扩展名伪装 | 把一段普通文本命名成 `fake.zip`：`③ 解包` 直接失败，报「认不出这是压缩包（魔数：未知格式）」—— 证明判定只看魔数 |
| 网盘链接 | `pan.baidu.com/...` → 不建任务，只回「手动下载后拖进来」，并认出是「百度网盘」 |
| 确认闸门 | 自带 `fetch()` 的 probe bundle → 预检 `warn`（网络请求×1）→ 停在「等待确认」→ 确认后才进入安装 |
| 插件安装 + 回滚 | `dpi-probe-bundle` 安装后写入 profile（deps+bundles 各 +1）；宿主重启后任务被判中断；回滚把 `package.json`/`pnpm-lock.yaml` 还原、deps 回到 37、bundles 回到 39 |
| 地雷自愈 | 上述安装让 pnpm 埋了 `@deepseek-ai/dsh-tools`；`dev/quarantine-dshtools.mjs` 挪走后 `dsh_health` 回到「profile 里没有 dsh-tools 副本」 |
| 面板 AI | 输入「给对话加折叠」→ 确定性搜索 + 模型挑选 → 3 张推荐卡（`dsh-streamfold` 等），每张带理由与「安装这个」按钮；模型只从候选里选 |
| 客户端渲染 | 侧栏出现「插件安装」图标（label 正确）；点击后 `main` 里挂载 `.dpi-panel`；失败任务在图标上冒**红点**，面板顶部给一句具体原因 |
| **真插件：dsh-power-menu** | `github.com/xichen-62/dsh-power-menu` → 自动选中 **Release 资产** `dsh-power-menu-0.1.16.tgz`（1.0s）→ 下载 54 KiB（1.2s）→ 解包 11 文件（40ms）→ 识别 `bundle@0.1.16`（12ms）→ 预检 `warn`（子进程×2 / shell×5 / 网络×2 / 组合×1，26ms）→ **等确认** → 快照 1.5s → 安装 **7s**（重打包 11 个文件）→ 诊断 1.3s。装完电源按钮出现在会话标题栏（`aria-label="电源菜单"`），菜单两项「关闭DSH / 重启DSH」正常渲染；宿主路由 `GET /api/dsh-power-menu/health` 回 `{ok:true,desktop:true}` |
| 装完宿主重启 | 安装过程中 DSH 自己重启（端口 39629→21937），面板重启后把该任务从「中断」回填成 **done** 并补跑诊断 |

未在本会话重复演练的一项：**从 GitHub 直接装一个真插件**（会走 pnpm + 宿主重启，
对本机 profile 风险不成比例）；该分支的 `installBundle` 调用已由本插件自身的安装过程间接覆盖。

> 2026-10-20 补记：上面这条已被 **dsh-power-menu** 实测覆盖（见上表）。那次安装还暴露了
> 两个真问题并已修复：① 打包产物落在 `data/staging/<job>/pack/`，任务收尾一删，profile 里的
> `file:` 依赖就指向空气（下次 pnpm 必然 ENOENT）—— 现在改落 `data/vendor/`，并且 prune 会
> 保留仍被 profile 引用的 staging 目录；已经断掉的那条用 `dev/restore-vendor-tarball.mjs` 补回。
> ② 诊断把 `entryId`（组合层的 `include:<rowId>`）当重复判据，报出「patch 层重复 id：include:timer」
> 的假警报 —— 现在只比 `rowId`，且只看与本次安装的 bundle 有关的重复。

---

## 9. 文件结构

```
index.js                 宿主入口：十一条路由 + 五个工具 + 失败关闭
client.js                浏览器半边：侧栏图标（红点）+ 面板（输入/阶段/预检/诊断/AI/环境体检）
lib/pipeline.js          流水线编排、任务持久化、中断回填、地雷清扫、doctor、重新诊断
lib/formats.js           魔数嗅探 + zip/tar/tar.gz 解包（路径/体积/链接围栏）
lib/detect.js            bundle / profile / skill / unknown 识别
lib/hostinfo.js          宿主机事实：profile / 数据目录 / 技能根 / 版本 / **buildStamp()** / **已装插件版本**
lib/scan.js              13 类危险能力静态扫描（含 density 跨文件密度）、secret 脱敏、提示注入检测
lib/precheck.js          兼容性 + engines + 信任策略 + 阻断/确认判定
lib/compat.js            官方 evaluatePluginCompatibility（asar 三级兜底）+ 本地降级
lib/download.js          fetch 下载/超时/体积上限、GitHub 解析、npm 解析（搜索已迁到 sources.js）
lib/pack.js              把扫描过的目录重打成 npm 风格 .tgz（装的是检过的字节，且不依赖外部目录）
lib/install.js           installBundle / Skill 落位 / 安装后诊断
lib/snapshot.js          快照、还原、技能备份、清理
lib/landmine.js          dsh-tools 覆盖检测/隔离、悬空链接清理
lib/repair.js            环境体检 + 幂等修复（dsh-tools / 悬空 file: 依赖 / trustPolicy / git）
lib/ai.js                面板 AI（搜索/推荐/递请求）+ 语义审查 + 材料裁剪
lib/sources.js           6 个搜索源 + trust/popularity 判定 + TTL 缓存（memoizeTtl）+ 源开关
lib/settings.js          个性化设置：默认档 = 原行为；归一化/夹取、原子落盘、一行摘要
lib/contract.js          R8：工具注册契约静态扫描（漏 output 会让插件失活/中止启动）
lib/profilehealth.js     R8：profile 层体检（bundles 对账 / 契约 / pnpm 钉子 / 崩溃日志）+ 幂等修复
lib/purpose.js           用途推断 + 用途↔能力对账（ok / warn / error / unknown）
lib/installfailure.js    R9：pnpm 失败 10 类分诊 + 管理拒绝码 11 条 + allowBuilds（待批准脚本）读写
lib/tools.js             五个宿主工具定义（含 output 契约）
dev/hosttest.mjs         328 项确定性自检（宿主进程跑）
dev/render-check.cjs     50 项无头渲染自检（诊断卡 / 预检卡 / 审查卡 / 设置面板 / 跳过审核 / 批准卡）
dev/audit.mjs            39 项自洽体检（不碰宿主；换会话先跑这个）
dev/quarantine-dshtools.mjs  手动兜底：把埋下的 dsh-tools 挪进备份（薄壳，复用 lib/landmine.js）
dev/restore-vendor-tarball.mjs 手动兜底：把断掉的 file: 依赖补回来（薄壳，复用 lib/repair.js）
dev/fix-tailscale-serve.ps1  管理员脚本：找到当前 GUI 端口并重指 tailscale serve
dev/fixtures/            端到端夹具（selftest 技能 / probe bundle / fake.zip / 提交 JSON）
```

> 交接文件：`DSH-Plugin\★交接文件·插件安装面板.md`（状态层：九步判据、五个坑、运维手册、未完成清单）。
> 方法层已经并进 skill `dsh-client-plugin-ops`（见其中「装/升级插件的三条硬约束」）。


## 适用 profile

本插件面向 DSH 的 `desktop` profile（本机已在 `.dsh/profiles/desktop` 下加载）。
插件包本身不含 profile 配置，profile 名可自行替换。

## 安装（DSH 命令行）

```bash
# <profile> 换成你的 profile 名，本机为 desktop
dsh plugin --profile desktop add <本目录或包名>
```

等价方式：把本仓 `cordis.patch.yml` 的 `insert` 行追加到 profile 的 `cordis.patch.yml`。
**改了 `cordis.patch.yml` 必须重启 DSH**（Desktop 不 watch patch 层）。

## 外部依赖与权限

- 运行位置：DSH 宿主进程（Node 侧）或浏览器侧，需要本机文件读写权限。
- 外部命令：`powershell.exe`
- 环境变量（可选；值不写进仓库）：`DSH_INSTALLER_DIR`、`DSH_INSTALL_ROOT`、`DSH_PROFILE`、`DSH_PROFILE_DIR`、`DSH_SKILLS_DIR`、`DSH_VERSION`、`DSH_GITHUB_TOKEN`（只从环境读，绝不入库）、`GH_TOKEN`
- 监听/访问端口：无
- 注意：从 GitHub 下载插件/Skill 时需要网络；私有源需要 `DSH_GITHUB_TOKEN` 或 `GH_TOKEN`，**不要把 token 写进任何文件**。

## 已知限制

- 仅在本机 Windows + DSH `desktop` profile 实测，其他平台/版本未验证。
- 私有备份仓：按 `.gitignore` 排除了 `node_modules`、`data/`、`.cache/` 与调试产物。
- 文档中 `$DSH_WORKSPACE`、`%USERPROFILE%` 等是**占位符**，使用前替换为本机实际路径。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方代码、字体、图标或数据的许可证需单独核对。
