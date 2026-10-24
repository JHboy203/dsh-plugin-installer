# dsh-plugin-installer · 插件 / Skill 安装面板

[English](README.en.md)


侧边栏一个图标，点开是「插件 / Skill 安装」面板：把 GitHub 链接、Release 页、`.tgz`/`.zip`
直链，或者本机压缩包/目录丢进去，面板自己完成 **下载 → 解包 → 识别 → 安全预检 → 快照 →
安装 → 诊断 →（按需）回滚**。

**安装执行全程不调用模型**：确定性代码在宿主侧跑，AI 只做「推荐」和「递请求」。
本机实测一次 Skill 安装 **约 1.8 秒**、插件安装到确认前 **约 0.6 秒**，都不花 token。

**R12 起它也回答「我装了哪些、哪些能升级」**：面板里多一张「已装插件」卡（默认折叠），
按 profile 的四类来源分开标（npm / 本机 `link:` 目录 / 本面板重打包的 `.tgz` / Git），
点「检查更新」才联网比对 npm 最新版 —— 本机实测 17 个可比对的包里 **7 个可升级**，
每一行都能直接点「升级到 x.y.z」走原流水线（预检 / 快照 / 诊断 / 回滚一个不少）。

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
>    随宿主升级过期、最近一次启动失败（`crash-*-host.log` 宿主崩溃 / `crash-*-web-boot.log` 前端入口
>    没激活，R17 起两类都读）点名了哪些插件、属于已知签名里的哪一类。`apply:true` 除原有两项外，
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
> 「接着跑 host_selfcheck（744）+ render-check（122）」。自洽检查现已 **125 项**。
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
> 6. 自检 269 → **372**（+103：分诊 10 / 文案与拒绝码 14 / 批准闭环 20 / 落盘竞态 3 / 豁免与兼容 44 / 接线与暴露面 12），
>    无头渲染 42 → **62**（+20：批准卡两态 + 兼容卡三态），自洽 28 → **52**。
>
> **R10（2026-10-22 01:45）「版本不兼容」从死路变成一条说得清的路**（宿主侧 + 面板）：
> 1. **面板不认宿主已有的豁免 → 死循环**（真 bug）：判定兼容性时没把 profile 的
>    `compatibility.json` 传进 `evaluatePluginCompatibility`，于是「已经授权过的版本」
>    回来装还是被红牌挡住，而卡片给的下一步是「先退出 DSH 再跑 CLI」。现在：读记录
>    （`lib/exemptions.js`，宿主接口优先、文件兜底）+ 认证传参，授权过的版本按
>    「不兼容但已豁免」继续装。
> 2. **体检误报**（真 bug，本机实测）：`install_hub_doctor` 把 **3 个已豁免**的插件报成
>    「会被跳过」—— 而那三只当时工具全都好用。现在：体检也带豁免判定，分成
>    「真会被跳过（error）」与「已豁免（info，只知情）」，外加「豁免对当前 DSH 已失效」的
>    warn（升级后常见）。
> 3. **面板里直接授权**：对「装到一半被版本判据挡住」的任务给一张卡 —— 点名 `包@精确版本` + 当前
>    DSH + 不满足的范围，二次确认（写明可能崩溃/损坏数据、只对这一个版本生效、写进
>    `compatibility.json`）→ 走宿主 `setVersionExemption(...)` → **回读确认** → 开新任务重试。
>    目标由服务端从预检结论推出，客户端不能自带包名/版本（不能用来预先放宽一个兼容的包）；
>    五个工具都不暴露它。
> 4. **降级判定对齐宿主**（真 bug）：版本侦测不到时，本地 semver 用严格预发布规则会把
>    **17 个**插件判成不兼容（宿主真值 3 个）。现在两条修正：`evaluateCompat` 接受调用方显式
>    传入的运行版本；本地判定改用宿主的宽容口径（`includePrerelease`）。修完实测与宿主**完全一致**：
>    `incompatible=0 / exempted=3`。
>
> **R11（2026-10-22 02:00）「等确认的现场不许被按时间清掉」+ 状态里多一行「环境注意」**：
> 1. **staging 生命周期按「任务还有没有后续动作」判**（真 bug）：`prune()` 原来只按 24 小时清
>    `data/staging/*`，于是一个「等待确认」的任务放一天多再点确认，解包现场已经没了 ——
>    用户看到「文件不在」而他什么也没做错。现在：非终态任务（`queued` / `running` /
>    `awaiting-confirm`）的现场一律不按时间清；终态的老现场照常清。
> 2. **`install_hub_status` 多一行「环境注意」**：把「版本豁免 N 条（M 条对当前 DSH 已失效：
>    …）」与「待批准安装脚本 K 个（…）—— 下次装同一个依赖还会卡住」压成一行。这两件事
>    不提醒就等于没有（一个让插件安静消失、一个让下一次安装卡在同一处），但都只读、只提醒，
>    修/批仍然只能在面板里由人点头。
> 3. 自检 372 → **378**（+6：staging 真目录 + 真 mtime 验证两条 / 环境注意四态），
>    自洽 52 → **55**（+3：三处接线）。
>
> **R11.1（2026-10-22 02:05）「跑的是不是新代码」变成自动答案（`lib/codestamp.js`）**：
> R9/R10 各踩一次「改了 `lib/*` 却没换新」，当时只能人工做行为探针（加一个动作、再打一次请求看谁回话）。
> 现在：模块首次被 import 时把 `index.js + client.js + lib/*.js` 的内容哈希记在内存里（那就是真正被加载的代码），
> 之后 `/health` 的 `code` 与 `install_hub_status` 的「**运行中的代码**」一行直接回答：
> `与磁盘一致（31 个文件 · ab12…）` 或 `旧（磁盘已改：lib/x.js，需要重启 DSH 才会换新）`。
> 构建标签（源码 mtime）从此只用于「磁盘上新不新」，不再冒充「跑的是哪一版」。
> 自检 378 → **383**（+5：freshness 判定 / 指纹覆盖面 / 两种人话 / 降级），自洽 55 → **57**（+2）。
>
> **R12（2026-10-22 02:3x）「我装了哪些、哪些能升级」—— 面板第一次有"已有资产"的视角**：
> 以前它只会**装**：想升级一个已装插件得自己记得名字、搜一次、再提交一次，而「哪些落后了」
> 从来没被回答过。现在多一张**已装插件**卡（折叠时只说规模，展开才逐条列）：
> 1. `lib/inventory.js`（纯本地读，30 秒缓存）：把 profile 的 44 条依赖按**声明形态**分成四类，
>    **它们的「能不能升级」完全不同**——`npm` 范围才有 registry 最新版可比；`link:` 是本机源码目录
>    （改了就生效，没有"新版本"）、`file:` 是本面板重打包的 `.tgz`（升级要重新提交新包）、
>    `github:` 的版本在仓库里而不在 registry 上。混为一谈就会产出真误导（把本机目录说成"落后"）。
>    `@deepseek-ai/*` 一律标「宿主自带、不参与升级」——从 npm 装第二份会遮蔽宿主（dsh-tools 那个雷的同类）。
> 2. `lib/updates.js`（**只在人点「检查更新」时联网**）：registry `/<pkg>/latest` 比对，
>    失败**逐条隔离**（404/超时/被墙不拖垮整张表）、30 分钟 TTL、并发封顶 4、弃用标记原样带回。
>    本机实测：17 个可比对的包里 **7 个可升级**（`dsh-checkpoint-rewind` 0.6.24→0.6.33 等）。
> 3. 可升级行直接给「升级到 x.y.z」按钮 → 走 `npm:<包>@<版本>` 交给原流水线（预检/快照/诊断/回滚一个不少）。
> 4. 搜索结果与状态工具也接上了：命中带「**已装 vX**」标记（不重复装同一个包）；
>    `install_hub_status({updates:true})` 多「已装 / 更新 / 可升级」三行（默认不联网）。
> 5. **顺手修了一个真 bug**：输入 `npm:包名@版本` 时把 `npm:` 前缀当成了包名的一部分 →
>    registry 404 → **静态扫描被跳过**（安全降级），安装时又把非法 spec 交给 pnpm。现在两处都剥掉前缀。
> 自检 383 → **453**（+70：清单判据 24 / 更新比对 20 / npm 前缀 4 / 接线 9 / **codestamp re-apply 5** / 其它 8），
> 渲染 62 → **80**（+18：折叠态 / 展开态 / 可升级按钮 / 三种兜底态），自洽 57 → **69**（+12）。
> 渲染脚本从此自己比对条数（`EXPECTED_TOTAL`）—— 源码里 `check(` 有 103 处、实际只跑 80 条
> （其余在 `else`/`catch` 兜底分支里），**数源码不等于数断言**。
>
> **R12.1（同一轮顺手）：把「运行中的代码」那一行从会误报改成会说清。**
> 实测撞出来的：`/inventory` 已经回 200（新代码在跑），可这一行还在说「旧 · 需要重启 DSH」——
> 根因是「指纹只在 `codestamp.js` 自己被加载时算一次」+「宿主是**逐文件**换新的」
> （`codestamp.js` 没改，就一直沿用 02:04 那个实例）。判据反过来指挥人做无用功，是最坏的一种错。
> 修法：`apply()` 每次（重新）apply 都记账（`recordApply()` → `globalThis`），`freshness()` 多回
> `appliedAt` / `appliedAfterLoad`，于是三档分开说：一致 / 「宿主已在 HH:MM 重新 apply，看行为、
> 别盲目重启」/「改完没有任何 re-apply → 真该重启」。**它仍不是万灵药**：只证明入口被重新 apply 过，
> 不证明每个 `lib/*` 都换了 —— 真判据只能是行为（新路由/新字段回不回话）。

> **R13（2026-10-22 12:5x）「装上了 ≠ 起来了」—— 一次真实静默失效换来的三条判据。**
> 起因：本机 10 小时里装过 `dsh-imgops` 两次，两条任务都是红色「安装失败」，可 pnpm 明明是成功的。
> 翻回执才看清：宿主是**正常返回** `{ application: "failed", stage: "enable", error: { code: "operation-error",
> diagnostic: "dsh: warning: 1 entry did not activate\nimgops (dsh-imgops): Error: cannot get property \"tools\" without inject" } }`
> —— 包装进了 profile，但**激活**那一步炸了：插件入口 `apply(ctx)` 用了 `ctx.tools`，却没写 `export const inject = ["tools"]`。
> 而面板当时报的是「package manager 报告安装失败」，⑨诊断还判「一切正常」。三条病一起治：
>
> 1. **`lib/inject.js`（新）**：静态扫「入口函数体里用了 `ctx.<服务>`，但 inject 没声明它」。判据刻意做窄 ——
>    只认 `apply` 自己的**函数体**（同文件里 canvas 的 `ctx.fillRect` 不会被算成服务），注释里的示例不算，
>    `inject: [...]`（客户端 bundle 的对象写法）也算声明。修法直接给一行可粘的 `export const inject = ['tools']`。
>    接在**预检**（装之前拦）与**诊断**（装之后兜）两处。
> 2. **失败分诊补上「不抛异常的那种失败」**：`application:"failed"` 以前不走 `describeInstallFailure`，
>    于是 `failure = null`，面板只剩一句错的通用话。现在把宿主的 `error.code` + `diagnostic` + pnpm 输出一起喂进去，
>    新增 `kind: "activation-failed"`（标题点名「装上了但没激活」+ 缺哪个服务 + 那一行修法）。
> 3. **诊断第一次看得见「行勾着但没激活」**：`fiberPhase` 是宿主行记录里的真字段（active / null），但旧代码的
>    `plugins.find(p => p.entryId === row.id)` **永远匹配不上** —— 宿主给的是 `include:<rowId>`，于是那一整段
>    「插件行没有运行」从来没生效过。现在按 `include:` 前缀宽匹配，并新增判据：`enabled && fiberPhase !== "active"`
>    → error「装上了，但没激活」，带上宿主原话与修法。
> 4. **`already-installed` 不再算失败**：第二条任务就是它（同版本再装一次）。它表示「已经在依赖里、这次没改动」，
>    现在收成 done + 备注，并**照常跑诊断**（用户真正想知道的是「它起没起来」）。
> 5. **端到端又撞出第二个真 bug（同一轮修掉）**：把 `dsh-imgops` 修好、版本提到 0.1.1 重新提交，
>    宿主仍回 `already-installed` —— 因为判「装过没有」看的是依赖行里的 **spec 字符串**，不看文件内容；
>    而 vendor 包名一直是 `pkg-<名字>.tgz`（不含版本），换了内容也是同一个 spec。于是**「重装/升级」静默无效**，
>    用户只会看到一条红色的「安装失败」。修法：vendor 包名带版本（`pkg-<名字>-<版本>.tgz`），
>    并把同一个插件**没人引用**的旧包收掉（profile 还指着的绝不删，宁可少删）。
>
> 6. **体检也升级了**：`install_hub_doctor` 现在会逐插件扫 inject 契约，并读 `listPlugins()` 的
>    `fiberPhase` 报「行开着但没激活」—— 这正是「装了怎么没反应」最常见的两个答案。
> 7. **固定成插件能力（不是留在脚本里）**：判据抽成唯一的 `lib/activation.js`
>    （`scanActivation` / `activationFindings` / `summarizeActivation`），被**安装后诊断、环境体检、
>    状态工具、新增的 `GET /plugin-installer/activation`** 四处共用；`install_hub_status` 多一行
>    「激活：47 行在跑 / 共 48 行 · 1 行没激活」，面板的体检卡直接显示对应 finding。
>    `node dev/verify-r13.mjs --port <端口> --yes` 是对应的端到端验收器（中文路径必须走它）。
>
> 断言：hosttest **453 → 506**（+53：inject 六种写法/边界 14、回执分诊 10、诊断行匹配与 fiberPhase 4、
> 版本化 vendor 名与旧包清理 4、codestamp 的「apply 是否晚于磁盘」3、体检两项 5、激活视图 10、接线 3）。

> **R14（2026-10-22 14:0x）补齐「Skill」那一半**：面板标题从第一版起就写着「插件 / Skill 安装」，
> 可是它只回答过插件那一半 —— 装了哪些技能、宿主认不认、名字有没有撞车，全都没有入口。
> 而本机真出现过「技能装了却从不被自动调用」，根因恰恰是这些看不见的事实。
>
> 1. **新增「已装 Skill」卡 + `GET /plugin-installer/skills`**：磁盘扫技能根（59 个目录，每个读 SKILL.md
>    的 name/description），再和宿主 `ctx.skills.list()` 的 `SkillSummary` 对账，给出四类异常：
>    **宿主没认**（磁盘有、清单没有 = 装了但用不上）/ **重名**（同层两个目录声明同一个 name）/
>    **备份残留**（`.bak-*` 还躺在技能根里，且带着同样的 name）/ **不会自动调用**（宿主 `modelInvocable=false`）。
>    摘要一行与状态工具、体检共用同一句话（`lib/skills.js` 是唯一口径）。
> 2. **修掉一个「读到了但读错」的真 bug**：`parseSkillFrontmatter` 只认单行标量，于是 `description: >`
>    这种折叠块把指示符 `>` 当成了描述 —— 面板上显示一个「>」，用途推断还拿它去和能力比对。
>    本机 **11 个技能**是这种写法。现在按 YAML 处理三种形态（`>` 折叠 / `|` 字面 / 缩进续行）、剥 BOM、剥引号。
> 3. **对账的假结论被钉死**：读不到宿主清单时**不许**把每个技能都标成「没被认」（那是最容易犯的错）。
>    `buildSkillView` 用 `hostKnown` 闸门分开「对账不了」与「没被认」，两种情况的摘要与结论都不同；
>    hosttest 里各有一条断言盯着它（`ctx.get("skills")` 也一样：本插件没 inject skills，只写 `ctx.skills`
>    会永远读到 undefined —— 那会得到一个「本机没有技能服务」的假结论）。
> 4. **体检并入技能结论**：`install_hub_doctor` 现在也会报「N 个技能目录宿主没认」（error）、
>    「N 组合法性问题」（warn）、「N 个备份残留」（info），每条都带大白话与处置步骤。
> 5. **线上实测立刻抓到三个「装了却永远用不上」的技能**（这条路自己证明了自己有用）：
>    `github-private-backup` / `win-desktop-automation` / `windows-disk-reclaim` 在磁盘上 name/description
>    都齐，但宿主清单里没有（55 个技能里只有这 3 个没被认）。用 PyYAML 复核根因 —— **frontmatter 不是合法 YAML**：
>    三者的 description 都是未加引号的 plain 标量，里面却有 `Triggers: "…"` 这种「冒号 + 空格」，解析器报
>    `mapping values are not allowed here`，于是宿主读不出 name、整条跳过。
>    这比「重名」更隐蔽（文件看起来完美），所以加了 `yamlFrontmatterIssue()` 判据（R14 的第二类结论
>    `skill-yaml-invalid`，error 级），把「YAML 写坏」与「宿主没认」**分开计数**并给出逐条改法。
>    **三个技能已修好并当场验证**：`.tools/fix-skill-frontmatter.py`（默认预览、`--apply` 才写、写前备份到
>    `.tools/backups/skills-frontmatter-<stamp>/`、写后 PyYAML 复核）把它们改成 `description: >` 块标量；
>    宿主自己重扫后，面板计数从「3 个 frontmatter 写坏 · 宿主认 64」变成 **「宿主认 67 · 0 个写坏 · 0 个没被认」**
>    （55 个磁盘技能全部认到了），技能目录也随即出现在模型的技能清单里。
>    本机修好后的状态：**55 个技能 · 宿主认 67（含 12 个 bundled/runtime）· 4 个备份残留 · 4 组重名 ·
>    18 个不会自动调用（frontmatter 里写了 disable-model-invocation）**。
>
> 断言：hosttest **506 → 570**（+64：frontmatter 三种块标量/BOM/引号 10、YAML 硬错误判据 7、备份与来源 6、
> 磁盘扫描 5、对账计数与标签 21、结论分级 5、盲区闸门 4、接线 10），render **80 → 101**（+21），
> audit **69 → 84**（+15）。

> **R15（2026-10-22 19:0x）把两条判据改对，并把「报了却动不了」变成「一次点选」**：
>
> 1. **「运行中的代码」不再把客户端算进宿主指纹**。旧实现把 `index.js + client.js + lib/*.js`
>    哈希成一枚，而 `client.js` 是宿主**自动热重载**的 —— 于是「只改了客户端」也会让状态工具报
>    「这一版还没被 apply / 要重启」，一句会指挥人做无用功的假告警（R14 会话里连踩两次）。
>    现在 `sourceDigests()` 分**宿主**（`index.js` + `lib/*.js`）与**客户端**（`client.js`）两栏：
>    宿主变 → 真需要重新 apply；只有客户端变 → 明确说「宿主会自动重载，看面板 BUILD 号，别为这个重启」。
>    旧进程（`LOADED` 只有合并指纹）自动退回旧口径 —— **宁可暂时保持旧行为，也不编假结论**。
> 2. **技能备份终于有「移出」入口**：`.bak-*` 目录与正式那份同名，宿主只会用其中一份。面板以前只能
>    报「4 组重名」，现在每个备份行有「移出技能根…」→ 二次确认（写明「不删除、随时能搬回」）→
>    `POST action:park-skill-backup` → 移到 `<plugin>/data/parked-skills/<时间戳>/` 并立即回传新视图。
>    判据是纯函数 `planSkillPark()`：只接受技能根**下一层**的名字、必须是备份形态、拼完再 resolve 一次防逃逸；
>    存在性在执行时用 `stat` 判。**这个动作不暴露给模型**（与「批准」「授权」同类：动文件只能人按）。
>
> 断言：hosttest **570 → 595**（+25：指纹两栏 8、备份处置 17，含一次真实的「移完再移」），render **101 → 105**（+4：移出入口 + 确认态 3），
> audit **84 → 94**（+10）。

> **R16（2026-10-22 21:2x）把「修 frontmatter」也收进插件 —— 换会话不再是能力边界**：
>
> R14 给了诊断（`yamlFrontmatterIssue`）、R15 给了「移走备份」，但真正把技能救回来的那一步
> （把坏掉的那行改成块标量）还留在 `.tools/fix-skill-frontmatter.py` 里。那意味着换个会话、
> 换台机器就没有这个能力。R16 把它做成插件里的确定性动作：
>
> 1. **`rewriteSkillFrontmatter()`（纯函数）**：只改未加引号且含 `: ` / ` #` 的顶格标量 →
>    `key: >` 块标量；引号值、块标量、缩进续行、CRLF 与正文一律不动。
> 2. **三道自检，缺一不可**：改写后 ① `yamlFrontmatterIssue` 必须清零；② `name` 不许变；
>    ③ `description` 语义不许变。任一条不过 → 放弃并说明原因（**宁可不修，也不许改坏**）。
> 3. **`repairSkillFrontmatter()`（pipeline）**：路径判据与 park 同源（一层、防逃逸）→ 读文件 →
>    必须真的命 YAML 错误 → 原文备份到 `data/skill-fixes/<时间戳>/<目录>/SKILL.md` →
>    **tmp + rename 原子写** → 重扫并回传新视图。
> 4. **面板两段式**：「修成块标量…」→「我确认修复」（写明「先备份原文、不删任何内容」）／「取消」；
>    动作 `POST action:fix-skill-frontmatter` **不暴露给模型**（改用户文件只能人按）。
>
> 断言：hosttest **595 → 618**（+23：改写纯函数与三道自检 12、真实修复与幂等 8、路径判据 3），
> render **105 → 108**（+3：修入口 + 确认态），audit **94 → 101**（+7）。

> **R17（2026-10-23 19:2x）修好「最近一次启动失败」的判据：它一直在看错的那份日志**：
>
> 本机实测：今天 14:29 / 18:20 / 19:03 各有一份 `crash-*-web-boot.log`（网页界面入口没激活），
> 而体检只认 `crash-*-host.log` —— 于是它报的是 **5.7 小时前**那次宿主崩溃，**最近一次（8 分钟前）
> 完全没看见**。更糟的是那句大白话**无条件**写「日志点名了这些插件」，而那次宿主崩溃的原文是
> `desktop welcome: Web authentication failed`（登录态 cookie 堆积，一个插件都没点名）——
> 文案把人往「删插件」上带，方向正好相反。
>
> 1. **两类日志都读**（`readNewestCrash`）：`host` 与 `web-boot` 取**最新那份**；另一类若也在 24h 内，
>    作为 `sibling` 进 detail（「另：5.7h 前还有一次宿主启动失败（路径）」），不吞掉。
> 2. **分开成条**：`host` → `crash-recent`（起不来、可能弹恢复对话框）；`web-boot` → `web-boot-recent`
>    （宿主起来了，但某块面板整块不见）。标题直接点名入口（如 `dsh-web-research`）。
> 3. **已知签名表**（`CRASH_SIGNATURES`）：`Web authentication failed` → 登录态 cookie 堆积
>    （处置：完全退出 + `dsh_boot_guard` 清 `dsh-auth-*`，**别**点「禁用第三方插件」）；
>    `CallId` → 陈旧 dsh-tools 覆盖；`must declare output` → 工具契约。认不出的走通用兜底，不硬猜。
> 4. **文案跟着数据走**：点名了插件才说「修掉它们」；没点名就说「多半不是插件，先看第一条错误」。
> 5. **长错误压成包名**：链式失败会把几十个 bundle 塞进同一行 → `client 包加载失败（dsh-web-research/client.js）`；
>    renderer console 段里真正的 `ReferenceError` 单独拎出来（最多 3 条）。
> 6. `dev/probe-crash.mjs`：不进宿主、只读真实日志，改完立刻能看新判据（宿主里改 `lib/*` 仍要重启才生效）。
>
> 断言：hosttest **618 → 645**（+27：两类日志与 sibling 12、签名与文案 10、长错误与异常 5），
> render **108 → 108**（纯宿主侧，客户端未动），audit **101 → 101**（`EXPECTED_ASSERTIONS` 同步 645）。

> **R18（2026-10-24 00:1x）给启动失败结论加「新鲜度」：修好了就别再指挥人重装**：
>
> R17 上线后（21:02 重启、运行中代码 21:02:22 与磁盘一致）实测：19:03 那份 `web-boot` 失败之后，
> 21:02 的重启**没有再产生任何新日志**，而面板仍按 **error** 说「重装 dsh-web-research」。
> 重装一个已经正常的插件是无用功；而且它是**本机目录（link:）来源**，「升级」这条路也走不通。
>
> 1. **判据带进程启动时刻**（`PROCESS_STARTED_AT = Date.now() - process.uptime()`）：崩溃日志早于
>    本进程启动 = 「上一次启动」留下的 → `info.crash.stale = true`。
> 2. **stale 降级 + 改口**：severity `error → warn`；标题「**上一次启动有**前端入口没激活」；
>    detail 加一行「本次启动（HH:MM:SS）之后没有新的失败日志 —— 这条可能已自愈」；`describeCrash`
>    输出「上次启动 · 前端入口没激活 10.6h 前（…）· 本次未复现」。
> 3. **处置不再假设「可以升级」**：stale 时第一条是「先确认那块面板现在在不在；在就什么都不用做（这条只是留痕）」；
>    client 包那条改成 **npm 来源重装 / 本机目录来源重新构建 client.js**。
> 4. host 崩溃同理（stale → warn，标题「上一次启动失败」，detail「本次启动已正常」）。
>
> 真实数据（`dev/probe-crash.mjs`，00:10）：
> `[warn] 上一次启动有前端入口没激活（dsh-web-research）· 本次启动（00:10:55）之后没有新的失败日志`。
>
> 断言：hosttest **645 → 657**（+12：A 的 error 判据 1、stale web-boot 7、stale host 4），
> render **108 → 108**，audit **101 → 101**（`EXPECTED_ASSERTIONS` 同步 657）。

> **R19（2026-10-24 00:2x）把「重装点名的插件」换成那一步真正能做的事**：
>
> R18 的处置里写「npm 来源重装 / 本机目录来源重新构建 client.js」—— 方向对，但用户还得自己去查
> 这个插件到底是哪一类。实测一查：`dsh-web-research` 是 **`link:` 本机目录**，面板「已装插件」里
> **根本没有重装/升级入口**，泛泛一句「重装点名的插件」等于让人找一个不存在的按钮。
>
> 1. **来源判据复用** `inventory.classifyDepSpec`（同一份正则，不在 profilehealth 里再写一套）：
>    从 profile 的 `dependencies` 取 spec → `link` / `tarball` / `git` / `npm`。
> 2. **每条处置落到具体动作**：
>    - `link:` → 「来自本机目录 `D:\…\dsh-web-research` —— 面板没有能替你重建的动作；去那个目录重新构建
>      client.js（先看它的 package.json scripts），再刷新界面」；
>    - `.tgz` → 「重新提交一份新包，或先回滚到安装前的快照」；
>    - `git` / `npm` → 「在面板『已装插件』里重装/更新」。
> 3. 来源判不出（插件不在 profile 依赖里）**不编**，仍走通用三步。
> 4. 已知签名表 **3 → 5 条**：加 `Cannot read … (reading 'prepare')`（服务就绪前访问 host）与
>    `value is not lossless JSON`（工具返回值不合法），各带大白话与两步处置。
>
> 真实数据（`dev/probe-crash.mjs`，00:27）：
> `dsh-web-research 来自本机目录 D:/信息库/AI工作区/DSH-Plugin/dsh-web-research（link:）——
> 面板没有能替你重建的动作；去那个目录重新构建 client.js…`。
>
> 断言：hosttest **657 → 666**（+9：来源四类 5、新签名 4），render **108 → 108**，audit **101 → 101**。

> **R20（2026-10-24 00:3x）窄屏（360×658）真量了一遍，并把它钉成文本契约**：
>
> 交接文件里一直挂着「没在真机上看过设置面板与二次确认的布局」。这轮在**运行中的 GUI** 里把
> 面板临时压到 360px，逐个量溢出（不是看截图，量的是 `getBoundingClientRect` 与 `scrollWidth`）：
>
> | 表面 | 结果 |
> |---|---|
> | 主面板（8 张卡） | 宽 360 / 内容 311 / `scrollWidth` 355 / **0 处越界** |
> | 设置面板（12 行 / 5 段，压到 360×634） | `scrollWidth` 354、`scrollHeight` 1375 内部滚动 / **0 处越界** |
> | 已装 Skill 展开（55 行） | 卡宽 311 / `scrollWidth` 310 / **0 处越界** |
>
> 布局本身是好的（`min(620px,100%)`、`flex-wrap`、`min-width:0`、760px 媒体查询都在），
> 缺的是**没人再量**。所以加 5 条**文本契约**到无头渲染自检：
>
> 1. CSS 能被提取（提取失败 → 这组检查静默失效，是最坏的假绿）；
> 2. 存在 `@media (max-width:760px)`；
> 3. 媒体查询里确实收紧了 `.dpi-panel` 的内边距；
> 4. `.dpi-settings` 宽度流体（`min(...)`/`100%`）+ 可内部滚动 + 有 `max-height`；
> 5. **不许出现 >320px 的固定宽度**（360 宽下必溢出，这条专拦以后有人加 `width:520px`）。
>
> 断言：render **108 → 113**（+5），hosttest **666 → 666**，audit **101 → 101**。
> 顺带把「窄屏真机验收」从 §7 待办移到**已量**（确认态需要夹具，仍未覆盖，见 §7）。

> **R21（2026-10-24 00:4x）YAML 硬错误判据从 2 类扩到 5 类，并分流「能不能自动修」**：
>
> 以前只认 `: ` 与 ` #` 两种「未加引号的 plain 标量」错误。但还有三类**同样让整个 frontmatter
> 解析失败**（宿主直接跳过这个技能，面板只会说「目录清单里读不到」）的情况完全没被看见：
>
> | 新判据 | YAML 里的后果 | 能不能自动改写 |
> |---|---|---|
> | **Tab 缩进**（行首是 Tab） | js-yaml 直接报错（缩进只认空格） | 不能 —— 给手工改法 |
> | **重复键**（同一顶层 key 两次） | `duplicated mapping key` | 不能 —— 给手工改法 |
> | **引号没闭合**（值以 `"`/`'` 开头且后半段没有同类引号） | 后面内容全被当成字符串 | 不能 —— 给手工改法 |
>
> 关键设计：`yamlFrontmatterIssue` 现在返回 `fixable`，**面板只对可改写的两种给「修成块标量…」按钮**。
> 给一个按下去也不会好的按钮，比不给更糟；`rewriteSkillFrontmatter` 也在这三类上直接拒绝并说清原因。
>
> 两个**防误报**的收紧（诊断说人坏话必须确定）：
> - Tab 只认「行首就是 Tab」—— 块标量正文里以空格缩进、内容带 Tab 是合法的；
> - 引号只认「后半段再没有同类引号」—— `description: "abc" # 注释` 是合法的。
>
> 真实数据核查（新增 `dev/probe-skills.mjs`，不进宿主）：本机 **55 个技能、55 个 valid、`yamlBroken=0`**，
> 三类新判据**零误报**。
>
> 断言：hosttest **666 → 674**（+8：三类检出与 fixable 5、防误报 2、改写拒绝 1），
> render **113 → 115**（+2：不可自动改写态只给改法、不给按钮），audit **101 → 101**。
> `client.js` 的 BUILD 提到 **r21.0**（并顺手把「build 号必须匹配 r1x」的旧断言改成「大版本号单调前进」——
> 旧正则在 r20 之后会误报）。

> **R22（2026-10-24 01:0x）在运行中的宿主上把「修技能」整条链路真跑了一遍**（验证轮，无代码改动）：
>
> 交接文件里一直挂着两件「还没在真实宿主上验过」的事：R16 的「真修一个坏技能」与 R21 的「不可自动改写
> 要拒绝」。这轮用两个临时技能夹具（`zz-r22-colon` / `zz-r22-tab`，验证完立即删除）在**运行中的宿主**
> （01:02:50 加载、与磁盘一致）上跑通了整条链路：
>
> | 步骤 | 结果 |
> |---|---|
> | `GET /skills?refresh=1` | 识别出 `zz-r22-colon` → `colon-space` **`fixable:true`**；`zz-r22-tab` → `tab-indent` **`fixable:false`**（R21 新字段在跑） |
> | `POST action:fix-skill-frontmatter {dir:"zz-r22-colon"}` | `ok:true`，`changes:[{key:"description",line:2,code:"colon-space"}]`，备份写入 `data/skill-fixes/2026-10-23T17-05-59/zz-r22-colon`；重扫后该行 `yamlIssue:null` |
> | 宿主侧效果 | 修好后宿主**当场认了**这个技能（模型 skill catalog 里出现 `zz-r22-colon`）—— 不只是文件变了 |
> | `POST … {dir:"zz-r22-tab"}` | `ok:false`，原文「这类问题不能自动改写（tab-indent）：把缩进里的 Tab 换成两个空格…」 |
> | 清理 | 两个夹具目录 + 测试备份删除 → `GET /skills?refresh=1` 回到 **55 个技能 / 55 valid / yamlBroken 0**，catalog 里也不再出现夹具 |
>
> 结论：R16 的「先备份原文 → 原子写 → 三道自检 → 宿主重扫」与 R21 的「可修复性分流」在真实宿主上都成立。
> 自检数字不变（674 / 115 / 101）。

> **R23（2026-10-24 12:4x）搜索结果标出「影子包」：名字撞官方、但全名不是官方那个**：
>
> 一直挂着的候选 ④「同名抢注靠人看」。真实的形态很具体：本机官方包是 `@deepseek-ai/dsh-base`、
> `@deepseek-ai/dsh-tools`……而 npm 上可能另有**未加作用域的同名包**（`dsh-base`）或**别的作者的同名包**
> （`@someone/dsh-tools`）。两者在搜索结果卡上看起来几乎一样，装错了就是另一份代码。
>
> 判据只用**本机事实**，不靠「名字像官方」猜：`officialBasenames(profileDir)` 从三处汇总
> `@deepseek-ai/*` 的 basename —— profile 的 `dependencies`、`dsh.profile.bundles`、
> `node_modules/@deepseek-ai/` 目录。
>
> `annotateShadows(items, official)` 的行为：
> - 未加作用域的同名包 → `trust.flags` 加一条 **error** 红旗：「未加作用域的同名包；官方那份是
>   `@deepseek-ai/dsh-base` —— 这条不是它，装之前确认要哪一个」，并**扣 20 分**；
> - 别的作用域的同名包（`@someone/dsh-tools`）同样标出，文案说清作用域不同；
> - **官方包自己绝不误报**（`@deepseek-ai/` 开头直接放行）；
> - 没有官方名可判（空集合）时**原样返回**，不猜。
>
> 接线在 `pipeline.search()`（与 R12 的「已装」标记同一条链），客户端早已渲染 `trust.flags`，
> **不需要改 client.js**。`install_hub_search_plugins` 的工具描述也补了这句。
>
> 断言：hosttest **674 → 681**（+7：三处汇总 1、影子包/别的作用域/官方不误报/无关包/空集合 6），
> render **115 → 115**，audit **101 → 101**。**宿主侧要重启才生效**。

> **R24（2026-10-24 13:3x）web-boot 失败改成「和磁盘上的字节对账」：不再说「可能已自愈」**：
>
> 现场：`crash-2026-10-24T05-03-45-web-boot.log` 点明 `dsh-web-research`、`dsh-plugin-catalog`
> 两个前端入口没激活。面板当时的结论只有「本次启动之后没有新的失败日志 —— 这条**可能**已自愈」。
> 这句既不能证明失败的那份字节已经不在了，也不能证明现在就是好的 —— 用户还是不知道该不该动手。
>
> 宿主其实给了确定性答案：`@deepseek-ai/dsh-client-modules` 给每个 client bundle 算一个 `rev`
> 写进 bundle URL（`plugins/??<包名>/client.js&rev=<12 hex>`），崩溃日志把出错的 URL **原样抄了下来**。
> rev 的算法是
> `sha1("plugin-artifact" + "\0" + Σ「<bufLen>:<part>」).hex.slice(0,12)`，三个 part 是
> `String(mtimeMs)` / `String(ctimeMs)` / `String(size)` —— **只读文件元数据，不读内容**。
>
> 所以 `lib/clientrev.js` 在宿主里反算「现在这份」的 rev，与日志里的比：
>
> | 判定 | 含义 | 结论怎么改口 |
> |---|---|---|
> | `same` | 同一份字节 | **即使这条日志是上一次启动留下的，也报 error**：重启只是再错一次 |
> | `rebuilt` | 日志里那份已被重建/覆盖 | 「那份已经不在了」；全部如此时改成「重启一次就能用上」 |
> | `unknown` | 日志没抄 rev（`import failed (see console)` 那类） | 只说「失败之后有没有改过」，不许断言好坏 |
>
> 两个真机细节（都写进断言了）：
> - **算法必须逐字一致**：拿 `dsh-diag/client.js` 的 stat 三元组反算，得到的正是日志里那个
>   `a9448b50cf9f`（`dev/fixtures/rev-vectors.json` 把它钉成固定向量，改成读内容算哈希就当场红）；
> - **combo URL 尾部那个 `&rev=` 是整条 combo 的哈希，不是最后一个包的**。真机日志里
>   `…,dsh-plugin-installer/client.js&rev=ae080526f657: skipped after…`，若记到 `dsh-plugin-installer`
>   头上就会得出「字节变了」→ 把**该修**降级成**不用修**（方向正好反了）。判据：token 里有逗号 = 一串 id，丢弃。
>
> 顺带把处置从「泛泛说重装」落到真能做的事：发现卡现在可以带 `actions`
> （`{kind:"upgrade-npm", plugin, label, hint}`），面板渲染成主按钮 —— 点它先
> `POST action:check-updates`（30 分钟缓存），**有新版才提交升级**，没有就直说
> 「已经是最新版：等作者修，或先停掉这个插件」。**只给 npm 来源**：`link:` 重装无意义、
> `file:` .tgz 同一份字节、Git 同一 spec 会被判 `already-installed` —— 那三种给按钮都是假按钮。
> `install_hub_doctor` 的工具输出也会把「↳ 面板动作：…」写出来（模型点不了按钮，但能指路）。
>
> 新增离线探针 `dev/probe-rev.mjs`（`--full` 连体检结论一起打）：换会话接手时一句话回答
> 「上次那个没激活的面板修没修」。真机实测：catalog 日志里 `a6173c156f44`、磁盘上 `1ce141eca57c`
> （13:23:35 重建）→ `rebuilt`；web-research 日志没抄 rev、包自 12:55 未再改 → `unknown`。
>
> 断言：hosttest **681 → 704**（+23：算法与入口解析 8、日志 rev 解析与 combo 守卫 2、三态与严重度 5、
> 处置文案与摘要 4、动作只给 npm 来源 1、全重建时的改口 3），render **115 → 118**
> （+3：动作按钮文字 / 是主按钮且可点 / 无动作不留空容器），
> audit **101 → 113**（+12：模块接线、算法域与长度、元数据口径、combo 守卫、入口判据、
> crash.bundles 落盘、摘要改口、动作复用原流水线、面板渲染、工具输出指路）。
> **宿主侧（`lib/*`）要重启才生效；`client.js` 提到 BUILD `r22.0`，刷新页面即生效。**

> **R25（2026-10-24 14:0x）「已装」必须分来源：同名不等于同一个包**：
> 触发点是实测：本机 47 个依赖里 **24 个是 `link:` 的本机目录**（自己写的插件），而搜索卡上的「已装」
> 以前**只按包名精确匹配**。于是 `dsh-imgops` 这种名字一旦在 npm 上被别人发过，卡片会写「已装 v0.4.0」——
> 人以为是同一个包，点「安装这个」就把本机那份换掉了。R23 的「影子包」只处理了撞 `@deepseek-ai/*` 那一半，
> 这一半没有判据。
>
> 现在两层判据，都落在**确定性事实**上：
> - **`repoKey(input)`**（`lib/inventory.js`）：把 `git+https://…`、`https://…`、`github:o/r`、
>   `git@host:o/r.git`、裸 `o/r`、`{url}` 六种写法归一到 `host/owner/repo`；`…/tree/<branch>/<subdir>`
>   只取前两段（同一个仓库的子目录不算不同来源）；认不出就返回 `null` —— **不猜**。
> - **`compareInstalledSource(known, candidate)`**：按**安装形态**分级判 —— `link:` 本机目录 vs registry
>   **一定不同**（error：会换掉本机那份）；`git`/`.tgz` 要仓库对得上才算同一个；npm 范围则**两边都已知**
>   才判，一边未知 → `unknown`（不标红）。不同时往 `trust.flags` 塞一条 `name-collision` 红旗。
>
> 还有一条真实场景：搜 `dsh-screenshot`（本机目录装的）时，6 个源里根本没有它 —— 结果是 6 条**毫不相干**
> 的官方包，而工具输出一个字都不解释（实测就是这个现象）。现在 `localOnlyHint()` 会直说
> 「「X」是本机已装的插件（本机目录），不会出现在 npm / GitHub 的检索结果里」。
> 顺带修掉工具输出的一个洞：`install_hub_search_plugins` 以前**从不显示「已装」**（只有面板有），
> 模型看不见这件事 —— 现在每条带「已装 vX（本机目录）」，面板 chip 也从「已装 vX」变成「已装 vX · 本机目录」。
>
> 断言：hosttest **704 → 744**（+40：`repoKey` 6 种写法 + 子目录 + 5 个认不出、对账 4 类形态与未知态、
> 红旗只在不同来源时出现、`localOnlyHint` 五态、原来的 `installed=版本号` 不变），
> render **118 → 122**（+4：chip 带来源形态 / 红旗画出来 / 本机插件提示 / 没有提示时不画空容器），
> audit **113 → 125**（+12：模块、写法、子目录取段、形态分级、未知不判、红旗、提示、pipeline 带 `repoUrl`
> 与 `localOnly`、三个 shaper 都带仓库、工具输出不再丢「已装」、面板渲染）。
> **宿主侧在 14:02:09 那次 re-apply 后已生效**（真机实测：搜索输出里既有「已装 0.2.1（npm）」，
> 也有「提示：「dsh-astrbot-ops」是本机已装的插件（本机目录）…」）；`client.js` 提到 BUILD `r23.0`，刷新页面即生效。

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
4. **想升级已装的** → 面板「已装插件」卡 →「检查更新」→ 可升级的行上直接点「升级到 x.y.z」。
   （本机目录 `link:` 与 `.tgz` 来源**不参与**比对：前者改源码即生效，后者要重新提交一份新包。）

底部的 **环境体检** 是两次手工救火固化进来的（R8 起合并成一次）：安装环境（dsh-tools 覆盖、悬空
`file:` 依赖、pnpm trustPolicy、git）+ **profile 层**（bundles 与实物对账、已装插件的 `output` 契约、
dsh-tools 钉子是否过期、最近一次启动失败（宿主崩溃 / 前端入口没激活）），可一键修其中四项（幂等，写前自动快照）；还顺带给手机那条
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
| GET | `/plugin-installer/inventory` | **已装清单**（本地读 profile，30 秒缓存；四类来源分开标）+ 最近一次检查更新的结果 |
| GET | `/plugin-installer/skills` | **已装 Skill**（R14）：磁盘技能目录 × 宿主 `ctx.skills.list()` 对账 —— 宿主没认 / 重名 / 备份残留 / 不会自动调用；30 秒缓存，`?fresh=1` 绕过缓存 |
| GET | `/plugin-installer/activation` | **激活视图**（R13）：逐行 `enabled`/`fiberPhase` + 缺 inject 明细 + 一句话结论；`?inject=0` 跳过源码扫描（快） |
| POST | `/plugin-installer/action` | `{action,id}`：`confirm`/`skip-review`/`cancel`/`ack`/`rollback`/`review`/`rediagnose`/`check-updates`/`approve-builds`/`exempt-version`/`repair`/`fix-landmine`/`integrations`/`park-skill-backup`（把备份目录移到 `data/parked-skills/`，不删除；只认技能根下一层的 `.bak*`，**不暴露给模型**）/`fix-skill-frontmatter`（把非法 YAML 的 frontmatter 就地改成块标量；先备份、原子写、三道自检，**不暴露给模型**） |
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
#   125 项：默认档冻结快照 / 5 个工具的 output 契约 / 构建标记形如「0.1.0 · 2026-10-22 02:40」/
#   契约扫描与 profile 体检是否真的接着线 / 失败分诊与批准闭环是否接线 / 版本豁免是否三处一起接 /
#   staging 是否保住「等确认」的现场 / 状态工具的「环境注意」行 / 「批准」与「授权」都没暴露给模型 /
#   已装清单四类来源是否分开判 / 宿主自带包是否被排除在升级外 / check-updates 是否只挂在动作上（不在轮询里）/
#   技能对账的「读不到宿主清单 ≠ 没被认」闸门 / YAML 硬错误与「宿主没认」是否分开判 /
#   面板有没有把 Skill 卡真的接进 Panel /
#   rev 对账是否接线（域名 plugin-artifact / 12 位 / 元数据口径 / combo 尾部 rev 丢弃 / crash.bundles /
#   动作复用原流水线 / 工具输出指路）/
#   客户端设置与热键入口 / settings.json 归一化后不变 / 等待确认任务的 staging 现场 /
#   README 与交接文件里的断言数是否等于 EXPECTED_ASSERTIONS（改测试就同步它）

# ② 744 项确定性自检（解包围栏 / 识别短路 / 扫描与密度 / 快照回滚 / 重打包 / prune 保鲜 / 地雷 /
#   契约扫描 / profile 体检与修复 / 已装版本对照 / 已装清单判据 / registry 最新版比对（打桩 fetch）/
#   设置归一化与审核三档 / 红点与跳过审核门禁 / 热键 / 7z 往返与围栏 / 搜索缓存 / 工具契约 /
#   pnpm 失败分诊 / allowBuilds 解析 / 批准重装 / 版本豁免读写与回读确认 / 兼容降级口径 /
#   staging 生命周期 / 环境注意 / npm: 前缀不进包名 / SKILL.md 三种 frontmatter 形态 /
#   技能备份识别 / 磁盘×宿主对账计数与结论分级 / 崩溃分诊（host×web-boot 取最新、sibling、
#   已知签名、长错误压成包名、renderer 真实异常）/
#   client 包 rev 对账（真机向量复现 / 入口解析 / combo 守卫 / same·rebuilt·unknown 三态 /
#   同一份字节即使 stale 也是 error / 动作只给 npm 来源 / 全重建时改口成「重启一次」））
host_selfcheck({ plugin: "dsh-plugin-installer" })

# ③ 无头渲染自检（微型 React 真的渲染一遍；122 项：诊断卡 / 预检卡 / 审查卡 / 设置面板 /
#   跳过审核按钮 / 安装脚本批准卡（默认态 + 二次确认态）/ 版本不兼容卡（三态 + 旧豁免失效）/
#   已装清单（折叠态 / 展开态 / 可升级按钮 / 读不到 / 空 profile）/
#   已装 Skill（折叠态 / 展开态 / 三种标签 / 读不到 / 空根 / 对账不了）/
#   发现卡动作按钮（文字 / 是主按钮且可点 / 没有动作时不留空容器））
node DSH-Plugin/dsh-plugin-installer/dev/render-check.cjs

# ④ rev 探针（离线，只读）：算法固定向量 + 最近一份 web-boot 日志里那份字节还在不在
node DSH-Plugin/dsh-plugin-installer/dev/probe-rev.mjs --full

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

## 8. 验证记录（2026-10-20，本机；2026-10-22 R9/R14 复跑）

| 场景 | 结果 |
|---|---|
| 确定性自检 | **744/744 通过**（`dev/hosttest.mjs`，含 zip/tar 构造、穿越与软链接拒绝、比例炸弹、5 种识别分支、快照还原、重打包往返、prune 引用保护、地雷处置、契约扫描、profile 体检与修复、设置归一化、审核三档、热键、pnpm 失败分诊、allowBuilds 解析、批准重装与三道闸、落盘串行、版本豁免读写与回读确认、兼容降级口径、预检「已授权不再阻断」回归、staging 生命周期、环境注意、运行中代码指纹、已装清单四类来源、registry 比对与缓存、npm: 前缀、**inject 六种写法与边界、激活失败分诊、fiberPhase 判据、SKILL.md 三种 frontmatter 形态、YAML 硬错误判据、技能备份识别与磁盘×宿主对账、指纹两栏（宿主/客户端）、备份处置的越权拒绝与真实搬运、frontmatter 改写的三道自检与真实修复、崩溃分诊两类日志与已知签名、崩溃结论的新鲜度（stale）、崩溃处置的来源判据（link:/tgz/git/npm）与两张新签名（prepare / lossless JSON）、YAML 三类新硬错误（Tab 缩进 / 重复键 / 引号没闭合）与「不可自动改写」分流、搜索结果影子包警戒（官方 @deepseek-ai/* 同名但不全等）、客户端包 rev 对账（真机向量 / combo 守卫 / same·rebuilt·unknown 与「同一份字节即使 stale 也报 error」/ 动作只给 npm 来源）**）；另 **122 项**无头渲染 + **125 项**自洽体检 |
| 已装 Skill（R14 实测，本机） | 技能根 `.dsh/skills` 下 **59 个目录 = 55 个技能 + 4 个备份残留**；上线第一分钟抓出 **3 个 frontmatter 不是合法 YAML** 的技能（`github-private-backup` / `win-desktop-automation` / `windows-disk-reclaim`，PyYAML 复核：`mapping values are not allowed here`）→ 宿主读不出 name、整条跳过；用 `.tools/fix-skill-frontmatter.py --apply`（写前备份、写后 PyYAML 复核）改成块标量后，宿主重扫即认到 —— **`hostVisible` 55/55、`yamlBroken` 0、`notVisible` 0**；`domain-modeling` / `grill-me` / `grill-with-docs` / `grilling` 各有一份 `.bak-mp20261017-1350` 同名备份（尚未清）；11 个技能的 description 是 `>` 折叠块，旧解析把它们读成「>」 |
| 激活失败的真实样本（R13 实测） | `dsh-imgops` 两次任务：①宿主返回 `application:"failed" / stage:"enable" / diagnostic:"1 entry did not activate … cannot get property \"tools\" without inject"`（pnpm exit 0、包已落地）→ 新分诊判 `activation-failed`，标题点名缺 `tools`，处置给出 `export const inject = ['tools']`；② `already-installed` → 判 noop + 照常诊断。同机 4 个健康插件（本插件 / dsh-screenshot / dsh-diag / dsh-ops）静态扫描**零误报**（canvas 的 `ctx.fillRect` 不计入） |
| 重装静默无效（R13 第二个 bug） | 修好 `dsh-imgops` 并升到 0.1.1 重新提交，宿主仍回 `already-installed`（实测 `changed:false`、`elapsedMs:11`、pnpm 没跑）—— 判据是依赖行的 spec 字符串，不含版本文件名就永远是同一个 spec。修法：`pkg-<名字>-<版本>.tgz` + 只收「没人引用的旧包」 |
| 已装清单 + 检查更新（R12 实测） | 本机 profile：**44** 个依赖（39 在 bundle 行里）= npm 17 / 本机目录 23 / 本面板装的 .tgz 2 / Git 2；17 个可比对的包 **1.9s** 查完，**7 个可升级**（`dsh-checkpoint-rewind` 0.6.24→0.6.33、`dsh-ops` 0.3.0→0.4.1、`dsh-vision-router` 3.0.4→3.0.5、`dsh-mnemon` 0.5.32→0.5.34、`dsh-provider-usage` 0.3.16→0.3.17、`dsh-chat-import` 0.26.1→0.26.2、`@linxin666/dsh-remote-web-ui` 0.4.7→0.4.8）；顺带查出 1 条「声明了但没落地」（`ghbackup` 是只挂了 `link:` 的旧别名） |
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
lib/profilehealth.js     R8：profile 层体检（bundles 对账 / 契约 / pnpm 钉子 / 崩溃日志）+ 幂等修复（R17 两类日志 + 已知签名；R18 新鲜度：早于本次启动只算留痕）
lib/purpose.js           用途推断 + 用途↔能力对账（ok / warn / error / unknown）
lib/installfailure.js    R9：pnpm 失败 10 类分诊 + 管理拒绝码 11 条 + allowBuilds（待批准脚本）读写
lib/inventory.js         R12：已装清单（四类来源分开判；宿主自带包不参与升级）+ 搜索「已装」标记
lib/updates.js           R12：registry 最新版比对（失败逐条隔离 / 30 分钟缓存 / 并发 4 / 弃用标记）
lib/inject.js            R13：服务声明静态扫描（入口函数体里用了 ctx.X 但 inject 没声明 → 激活必失败）
lib/activation.js        R13：激活判据唯一来源（enabled+fiberPhase≠active / 缺 inject），诊断·体检·状态·路由共用
lib/skills.js            R14：已装 Skill —— 磁盘扫技能根 × 宿主 ctx.skills.list() 对账（没被认/重名/备份/不会自动调用）
dev/verify-r13.mjs       R13：端到端验收器（运行中代码 / 提交 / ⑧ 回执 / ⑨ 诊断 / 体检），逐条 PASS/FAIL
lib/tools.js             五个宿主工具定义（含 output 契约）
dev/hosttest.mjs         744 项确定性自检（宿主进程跑）
dev/probe-crash.mjs      R17：不进宿主、只读真实崩溃日志，看分诊判据（改 lib 后立刻能验）
dev/probe-rev.mjs        R24：算法固定向量 + 最近一份 web-boot 日志里那份 client 包还在不在（`--full` 连体检结论）
dev/render-check.cjs     122 项无头渲染自检（诊断卡 / 预检卡 / 审查卡 / 设置面板 / 跳过审核 / 批准卡 / 兼容卡 / **已装清单 / 已装 Skill（含移出与修复确认态、不可自动改写态）/ 窄屏结构契约 / 发现卡动作按钮 / 搜索卡「已装」分来源与本机插件提示**）
dev/audit.mjs            125 项自洽体检（不碰宿主；换会话先跑这个）
dev/probe-inject.mjs     手动探针：拿本机真实插件验 inject 扫描会不会误报（R13）
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
