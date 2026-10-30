/**
 * dev/audit.mjs — 换会话第一条命令：不碰宿主、不重启，把「这个插件现在自洽吗」一次问清。
 *
 * 为什么要有它（R6 收尾，用户问「把用得上的部分固定成插件」）：
 *   这一轮真正值钱的东西不是某个功能，而是**验收流程**：
 *   默认档不许漂 → 只能靠冻结快照；工具契约漏 output 会静默失活 → 只能靠静态断言；
 *   文档里的「自检 N 项」永远比代码慢半拍 → 只能靠一个常量对着数。
 *   这些检查以前散在对话里，现在收成一条命令。
 *
 *   node DSH-Plugin/dsh-plugin-installer/dev/audit.mjs
 *
 * 它**不**做这两件事（各自有更好的入口）：
 *   · 跑 hosttest（需要在宿主相关的 node 里跑，用 host_selfcheck）—— 这里只打印那条命令；
 *   · 渲染诊断卡 / 设置面板 / 已装清单（80 项）—— 由 dev/render-check.cjs 负责，这里只对数。
 * 所以：audit 管「自洽」，host_selfcheck 管「行为」，render-check 管「界面」。
 *
 * 设计约束：
 *   · 只读：不写任何文件、不改设置；
 *   · 不 spawn：工具沙箱里 node 起子进程会 EPERM，所以这里全部用 import / 读文件；
 *   · 中文输出走 UTF-8（用 pwsh / host_selfcheck 调用没问题；cmd 里可能乱码，那是控制台的事）。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, describeSettings, normalizeSettings } from "../lib/settings.js";
import { buildInstallerTools } from "../lib/tools.js";
import { buildStamp, dataDir, profileDir } from "../lib/hostinfo.js";
import { stagingKeepNames } from "../lib/pipeline.js";
import { compareProfile, judgePnpmState } from "../lib/profilestate.js";
import { PY_RULES, RISK_KIND_LABELS } from "../lib/scan.js";
import { PURPOSES } from "../lib/purpose.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** 冻结快照：改了默认档就必须来改这里，否则 audit 会红。 */
export const FROZEN_DEFAULTS = {
	redDot: true,
	sound: false,
	desktopPopup: false,
	reviewLevel: "normal",
	skipReview: true,
	pollMs: 2500,
	historyLimit: 8,
	snapshotKeep: 40,
	sources: { npm: true, github: true, hub: true }
};

/** 文档里声明的自检项数（改断言就先跑一次 host_selfcheck，再同步这个数）。 */
export const EXPECTED_ASSERTIONS = 1018;

/** 界面自检项数（dev/render-check.cjs）。同样是「文档对表」的一半。 */
const EXPECTED_RENDER_ASSERTIONS = 190;

/** 期望注册的宿主工具（漏一个 = 模型看不见一项能力）。R32 起 6 个（新增只读探针）。 */
const EXPECTED_TOOLS = [
	"install_hub_status",
	"install_hub_search_plugins",
	"install_hub_submit_request",
	"install_hub_review",
	"install_hub_doctor",
	"install_hub_probe_repo"
];

let passed = 0;
const failures = [];
const notes = [];

function ok(name, condition, extra) {
	if (condition) passed += 1;
	else failures.push({ name, extra });
}

function eq(name, actual, expected) {
	ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

async function readText(rel) {
	try {
		return await readFile(join(root, rel), "utf8");
	} catch {
		return null;
	}
}

/** 数 `dev/render-check.cjs` 里**声明的**断言条数（脚本自己会比对实际跑了几条）。 */
async function declaredRenderAssertions() {
	const text = await readText(join("dev", "render-check.cjs"));
	if (!text) return -1;
	const m = /const EXPECTED_TOTAL = (\d+)/.exec(text);
	return m ? Number(m[1]) : -1;
}

async function main() {
	/* ① 设置默认档 = 冻结快照（防「默认档漂移」） */
	eq("设置默认档 = 冻结快照", normalizeSettings({}), FROZEN_DEFAULTS);
	ok("设置摘要可读", /审核普通/.test(describeSettings(DEFAULTS)), describeSettings(DEFAULTS));

	/* ② 归一化的三条性质（写坏了不许炸、不许静默失真） */
	const clamped = normalizeSettings({ reviewLevel: "loose", pollMs: 3000, historyLimit: 999, snapshotKeep: "x", sound: "yes", evil: 1 });
	eq("非法审核档位回退普通", clamped.reviewLevel, "normal");
	eq("非法轮询落到最近合法值", clamped.pollMs, 2500);
	eq("未知键丢弃", "evil" in clamped, false);
	eq("三个源全关会兜回全开", normalizeSettings({ sources: { npm: false, github: false, hub: false } }).sources, FROZEN_DEFAULTS.sources);

	/* ③ 工具契约（漏 output = 整个插件静默失活） */
	const tools = buildInstallerTools({ installer: {}, ctx: {} });
	eq("工具数量固定为 6（R32 起含只读探针）", tools.length, EXPECTED_TOOLS.length);
	eq("工具名字固定", tools.map((t) => t.name), EXPECTED_TOOLS);
	ok("每个工具都声明 output 契约", tools.every((t) => t.output && t.output.schema && typeof t.output.render === "function"));
	ok("每个工具都有 parameters schema", tools.every((t) => t.parameters && t.parameters.type === "object"));

	/* ④ 构建标记（回答「改完到底重启没有」） */
	const build = await buildStamp(true);
	ok("构建标记带版本与源码时间", /^\d+\.\d+\.\d+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(build.label)), build.label);
	const indexSrc = (await readText("index.js")) || "";
	ok("宿主 /health 不再写死 build", !/build:\s*"p2-pack"/.test(indexSrc));

	/* ⑤ 客户端契约（用户看得见的那几个入口） */
	const clientSrc = (await readText("client.js")) || "";
	ok("客户端有 build 号", /const BUILD = "/.test(clientSrc));
	ok("客户端会写回 /settings", clientSrc.includes('api("/settings"'));
	ok("顶部有设置入口", clientSrc.includes("settingsOpen: true"));
	ok("跳过审核走 skip-review", clientSrc.includes('act("skip-review")'));
	ok("跳过审核有二次确认", clientSrc.includes("确认跳过审核") && clientSrc.includes("我确认跳过"));
	ok("设置面板有三种提醒", clientSrc.includes("侧边栏红点") && clientSrc.includes("声音提醒") && clientSrc.includes("桌面弹窗"));
	ok("审核三档都在", clientSrc.includes("严格") && clientSrc.includes("普通") && clientSrc.includes("关闭"));

	/* ⑤b R7/R8：两条「装完就起不来」的判据必须真的接着线 */
	const contractSrc = await readText("lib/contract.js");
	const profileHealthSrc = await readText("lib/profilehealth.js");
	const precheckSrc = (await readText("lib/precheck.js")) || "";
	const installSrc = (await readText("lib/install.js")) || "";
	const pipelineSrc = (await readText("lib/pipeline.js")) || "";
	ok("契约扫描模块存在（R8）", Boolean(contractSrc) && /export async function scanToolContract/.test(contractSrc));
	ok("预检接了契约扫描（装之前）", /scanToolContract/.test(precheckSrc));
	ok("诊断接了契约扫描（装之后）", /scanToolContract/.test(installSrc));
	ok("profile 体检模块存在（R8）", Boolean(profileHealthSrc) && /export async function inspectProfile/.test(profileHealthSrc));
	ok("doctor 接了 profile 体检", /inspectProfile/.test(pipelineSrc) && /repairProfile/.test(pipelineSrc));
	ok("自检热键可配置（R7）", clientSrc.includes("dpi.selfcheck.hotkey") && clientSrc.includes("Ctrl+Alt+D"));
	ok("自检热键可以关掉（R7）", clientSrc.includes("HOTKEY_OFF"));

	/* ⑤c R9：装不上时的分诊与「安装脚本待批准」闭环必须真的接上线 ——
	   否则 pendingBuilds 又变成「算了但没用」的死数据。 */
	const failureSrc = await readText("lib\\installfailure.js");
	const toolsSrc = (await readText("lib\\tools.js")) || "";
	const indexSrc2 = (await readText("index.js")) || "";
	ok("分诊模块存在（R9）", Boolean(failureSrc) && /export function describeInstallFailure/.test(failureSrc));
	ok("哨兵串与宿主契约一致", /UNDECIDED_BUILD = "set this to true or false"/.test(failureSrc || ""));
	ok("install 接了分诊（不再只留 code+message）", /describeInstallFailure/.test(installSrc) && /failure,/.test(installSrc));
	ok("install 真的把 approvedBuilds 递给宿主", /options\.approvedBuilds = approved/.test(installSrc));
	ok("pipeline 有「允许并重试」动作", /async approveBuilds/.test(pipelineSrc));
	ok("pipeline 重试前复核 pending 名单", /policy\.pending/.test(pipelineSrc));
	ok("doctor 报 profile 里的待批准脚本", /pendingBuildFinding/.test(pipelineSrc));
	ok("index 暴露 approve-builds 动作", /approve-builds/.test(indexSrc2));
	ok("批准动作不暴露给模型（信任决定只能人按）", !/approve-builds/.test(toolsSrc) && !/approveBuilds/.test(toolsSrc));
	ok("面板有批准卡 + 二次确认", clientSrc.includes("BuildApprovalCard") && clientSrc.includes("我确认允许"));
	ok("错误块渲染大白话与处置步骤", clientSrc.includes("job.error.plain") && clientSrc.includes("job.error.fix"));

	/* ⑤d R10：版本豁免必须**三处一起接**，少一处就回到「装了被挡、授权了还挡」的死循环 ——
	   ① 读记录的模块存在；② 判定时真的把 exemptions 传进评估器；③ 面板能授权、模型不能。 */
	const exemptionsSrc = await readText("lib\\exemptions.js");
	const profileSrc = (await readText("lib\\profilehealth.js")) || "";
	const sourcesSrc = (await readText("lib\\sources.js")) || "";
	ok("豁免模块存在（R10）", Boolean(exemptionsSrc) && /export function exemptionTarget/.test(exemptionsSrc));
	ok("豁免：记录文件名与宿主一致", /EXEMPTIONS_FILENAME = "compatibility\.json"/.test(exemptionsSrc || ""));
	ok("豁免：授权走宿主接口（不是自己写文件）", /setVersionExemption/.test(exemptionsSrc) && /acceptRisk/.test(exemptionsSrc));
	ok("豁免：授权后回读确认", /verified/.test(exemptionsSrc));
	ok("预检把已有豁免传给评估器（否则授权了也白授权）", /evaluateCompat\(manifest, \{ exemptions: ex\.exemptions/.test(precheckSrc));
	ok("体检把已有豁免传给评估器（否则已豁免的会被误报「会被跳过」）", /evaluateCompat\(manifest, \{ exemptions: ex\.exemptions/.test(profileSrc));
	ok("判定用显式运行版本（宿主外侦测不到版本时不许把所有插件的判成不兼容）", /options\.runtimeVersion \|\|/.test(await readText("lib\\compat.js")));
	ok("pipeline 有「授权并重试」动作", /async exemptVersion/.test(pipelineSrc));
	ok("授权目标只能从预检结论推出（客户端不能自带包名/版本）", /exemptionTarget\(compat\)/.test(pipelineSrc));
	ok("index 暴露 exempt-version 动作", /exempt-version/.test(indexSrc2));
	ok("授权动作不暴露给模型（风险只能人接受）", !/exempt-version/.test(toolsSrc) && !/exemptVersion/.test(toolsSrc));
	ok("面板有版本不兼容卡 + 二次确认", clientSrc.includes("CompatExemptCard") && clientSrc.includes("我确认风险"));
	ok("体检会报告「已豁免但声明不兼容」的知情条目", /bundle-incompatible-exempted/.test(profileSrc));

	/* ⑤e R11：两件「不提醒就等于没有」的事 —— staging 不能按时间清掉还在等确认的现场；
	   状态工具里要有一行读得出「豁免失效 / 待批准脚本」。 */
	ok("staging 保留在等确认的任务现场（R11）", /liveDirs/.test(pipelineSrc) && /awaiting-confirm/.test(pipelineSrc));
	ok("状态工具有一行「环境注意」", /environmentCaveats/.test(pipelineSrc) && /环境注意/.test(toolsSrc));
	ok("环境注意同时覆盖豁免失效与待批准脚本", /已失效/.test(pipelineSrc) && /待批准安装脚本/.test(pipelineSrc));
	/* R11：把「跑的是不是新代码」从人工行为探针变成自动答案 */
	const codestampSrc = await readText("lib\\codestamp.js");
	ok("codestamp 模块存在（R11）", Boolean(codestampSrc) && /export async function freshness/.test(codestampSrc));
	ok("健康检查回传「运行中 vs 磁盘」", /freshness\(\)/.test(indexSrc2) && /describeFreshness/.test((await readText("lib\\tools.js")) || ""));

	/* ⑤f R12：已装清单 + 检查更新。四个入口必须一起接上，缺一个就是「面板上有按钮但没用」；
	   另外两条判据（宿主自带不参与升级 / 三类本地来源不参与比对）是这块最容易写错的地方。 */
	const invSrc = await readText("lib\\inventory.js");
	const updSrc = await readText("lib\\updates.js");
	ok("已装清单模块存在（R12）", Boolean(invSrc) && /export async function readInventory/.test(invSrc));
	ok("已装清单：四类来源分开判（link / file / git / npm）", /function classifyDepSpec/.test(invSrc || "") && /"tarball"/.test(invSrc || "") && /"git"/.test(invSrc || ""));
	ok("已装清单：宿主自带的包不许从 npm 升级", /HOST_SCOPE/.test(invSrc || "") && /@deepseek-ai/.test(invSrc || ""));
	ok("更新比对模块存在（R12）", Boolean(updSrc) && /export async function checkUpdates/.test(updSrc));
	ok("更新比对：失败逐条隔离（不许一坏全空）", /catch \(e\)/.test(updSrc || "") && /relation: "unknown"/.test(updSrc || ""));
	ok("更新比对：有 TTL 缓存（不重复打 registry）", /memoizeTtl/.test(updSrc || ""));
	ok("check-updates 只在动作里跑（不挂在 /state 轮询上）", /check-updates/.test(indexSrc2) && !/checkUpdates\(|inventory\(/.test(((pipelineSrc.match(/async snapshotState[\s\S]{0,900}/) || [""])[0])));
	ok("面板真的把已装清单接进 Panel", /h\(Inventory\)/.test(clientSrc) && /"\/inventory"/.test(clientSrc));
	eq("界面自检项数与文档一致", await declaredRenderAssertions(), EXPECTED_RENDER_ASSERTIONS);

	/* R12.1：指纹只在 codestamp.js 加载时算一次，而宿主是**逐文件**换新的 ——
	   所以必须记下「最后一次 apply」，否则这一行会在新代码已经跑起来之后还喊「需要重启」。 */
	ok("codestamp：apply 会记录时刻（R12.1）", /recordApply\(\)/.test(indexSrc2) && /export function recordApply/.test(await readText("lib\\codestamp.js") || ""));
	ok("codestamp：健康检查回传 appliedAt / appliedAfterLoad", /appliedAfterLoad/.test(indexSrc2) && /appliedAfterLoad/.test(await readText("lib\\codestamp.js") || ""));
	ok("codestamp：已 re-apply 时不再说「需要重启」", /别为这个盲目重启/.test(await readText("lib\\codestamp.js") || ""));

	/* ⑤g R14：已装 Skill —— 面板标题一直写着「插件 / Skill 安装」，但过去只有插件那一半。
	   这一块最危险的假结论是「读不到宿主清单 → 把每个技能都标成没被认」，所以判据要钉住。 */
	const skillsSrc = await readText("lib/skills.js");
	const detectSrc = await readText("lib/detect.js");
	ok("已装 Skill 模块存在（R14）", Boolean(skillsSrc) && /export async function readSkillsOnDisk/.test(skillsSrc) && /export function buildSkillView/.test(skillsSrc));
	ok("已装 Skill：备份目录被单独认出（不许算成两个技能重名）", /BACKUP_RE/.test(skillsSrc || "") && /export function skillBackupInfo/.test(skillsSrc || ""));
	ok("已装 Skill：读不到宿主清单时不算「没被认」", /const notVisible = hostKnown[\s\S]{0,80}real\.filter/.test(skillsSrc || ""));
	ok("已装 Skill：每条结论都带大白话与处置步骤", /plain:/.test(skillsSrc || "") && /fix:/.test(skillsSrc || ""));
	ok("frontmatter 支持 `>` / `|` 块标量（R14 修掉的读错）", /export function parseFrontmatterFields/.test(detectSrc || "") && /indicator\[1\] === ">"/.test(detectSrc || ""));
	ok("frontmatter 的 YAML 硬错误判据存在（R14：冒号+空格 / 空格+#）", /export function yamlFrontmatterIssue/.test(detectSrc || "") && /colon-space/.test(detectSrc || "") && /hash-comment/.test(detectSrc || ""));
	ok("已装 Skill 把「YAML 写坏」与「宿主没认」分开", /yamlBroken/.test(skillsSrc || "") && /yamlIssue/.test(skillsSrc || ""));
	ok("已装 Skill：YAML 写坏的结论把具体改法递给人", /skill-yaml-invalid/.test(skillsSrc || "") && /first \? first\.fix :/.test(skillsSrc || ""));
	ok("已装 Skill：宿主清单走可选访问器 ctx.get(\"skills\")", /ctx\.get\("skills"\)/.test(pipelineSrc));
	ok("已装 Skill：pipeline 提供 skills() 并缓存", /async skills\(force = false\)/.test(pipelineSrc) && /_skillsAt/.test(pipelineSrc));
	ok("已装 Skill：体检并入技能结论", /skillFindings\(/.test(pipelineSrc));
	ok("已装 Skill：index 暴露 GET /skills（刷新可绕过缓存）", /path === "\/skills"/.test(indexSrc2) && /fresh/.test(indexSrc2));
	ok("已装 Skill：状态工具有「Skill：」一行", /· Skill：/.test(toolsSrc) && /skillsLine/.test(toolsSrc));
	ok("已装 Skill：面板把卡片接进 Panel", /h\(Skills\)/.test(clientSrc) && /\bSkills,/.test(clientSrc));
	ok("已装 Skill：面板标出备份 / 宿主没认 / 不会自动调用", clientSrc.includes("备份残留") && clientSrc.includes("宿主没认") && clientSrc.includes("不会自动调用"));

	/* ⑤h R15：两件「把判据改对」的事 ——
	   ①「运行中的代码」把 client.js 也算进宿主指纹，只改客户端就喊需要重启（R14 连踩两次）；
	   ② 备份目录只能报不能处置。前者必须拆两栏，后者必须是「移动、不删除、只认备份形态、模型拿不到」。 */
	const codestampSrcR15 = (await readText("lib/codestamp.js")) || "";
	ok("运行中的代码：指纹拆宿主 / 客户端两栏（R15）", /export async function sourceDigests/.test(codestampSrcR15) && /client: disk \? \{ digest: disk\.client, changed:/.test(codestampSrcR15));
	ok("运行中的代码：只改客户端时说「自动重载」而不是「需要重启」", /自动重载/.test(codestampSrcR15) && /别为这个重启/.test(codestampSrcR15));
	ok("运行中的代码：旧进程没有分栏时退回合并口径（不编假结论）", /const split = Boolean\(LOADED\.host && LOADED\.client\)/.test(codestampSrcR15));
	ok("运行中的代码：needsApply 只看宿主那半", /newest: host\.newest/.test(codestampSrcR15) && /newestFile: host\.newestFile/.test(codestampSrcR15));
	ok("技能备份处置：规划是纯函数（可单测、不碰磁盘）", /export function planSkillPark/.test(skillsSrc || ""));
	ok("技能备份处置：只接受技能根下一层 + 备份形态", /只接受技能根下一层的目录名/.test(skillsSrc || "") && /不是备份形态/.test(skillsSrc || ""));
	ok("技能备份处置：pipeline 移动不删除", /async parkSkillBackup\(/.test(pipelineSrc) && /renameWithRetry\(planned\.from, planned\.to\)/.test(pipelineSrc) && /parked-skills/.test(pipelineSrc));
	ok("技能备份处置：index 暴露 park-skill-backup", /park-skill-backup/.test(indexSrc2));
	ok("技能备份处置：不暴露给模型（动文件只能人按）", !/park-skill-backup/.test(toolsSrc) && !/parkSkillBackup/.test(toolsSrc));
	ok("技能备份处置：面板两段式确认、写明不删除", clientSrc.includes("移出技能根…") && clientSrc.includes("我确认移出") && clientSrc.includes("不删除"));

	/* ⑤i R16：把「frontmatter 写坏」的修复也做成插件能力（此前只在 .tools 脚本里）。
	   改写必须是确定性的、且不能只看「改了」——三道自检（检测清零 / name 不变 / description 语义不变）缺一不可。 */
	ok("frontmatter 修复：改写是纯函数", /export function rewriteSkillFrontmatter/.test(skillsSrc || "") && /export function planSkillFix/.test(skillsSrc || ""));
	ok("frontmatter 修复：改写后必须检测清零", /yamlFrontmatterIssue\(newBlock\[1\]\)/.test(skillsSrc || ""));
	ok("frontmatter 修复：name 变了就放弃", /name 变了/.test(skillsSrc || "") && /description 语义变了/.test(skillsSrc || ""));
	ok("frontmatter 修复：pipeline 先备份再原子写", /async repairSkillFrontmatter\(/.test(pipelineSrc) && /skill-fixes/.test(pipelineSrc) && /renameWithRetry\(tmp, planned\.file\)/.test(pipelineSrc));
	ok("frontmatter 修复：index 暴露 fix-skill-frontmatter", /fix-skill-frontmatter/.test(indexSrc2));
	ok("frontmatter 修复：不暴露给模型（改用户文件只能人按）", !/fix-skill-frontmatter/.test(toolsSrc) && !/repairSkillFrontmatter/.test(toolsSrc));
	ok("frontmatter 修复：面板两段式、写明先备份", clientSrc.includes("修成块标量…") && clientSrc.includes("我确认修复") && clientSrc.includes("先备份原文"));

	/* ⑤h R24：客户端包 rev 对账 —— 「日志里失败的那份字节，现在还在不在」。
	   这块最容易写成**看着对但方向反了**的结论（把「该修」说成「已自愈」），所以判据要钉在源码上：
	   算法必须复现宿主的（元数据 + framed sha1），combo 尾部那个 rev 必须丢掉，动作必须复用原流水线。 */
	const revSrc = await readText("lib\\clientrev.js");
	ok("rev 对账模块存在（R24）", Boolean(revSrc) && /export function artifactRevision/.test(revSrc || ""));
	ok("rev：域名与宿主一致（plugin-artifact）", /plugin-artifact/.test(revSrc || ""));
	ok("rev：12 位十六进制（宿主 HASH_REVISION_LENGTH）", /HOST_REV_LENGTH = 12/.test(revSrc || ""));
	ok("rev：拿文件元数据算，不是读内容（宿主就不读内容）", /mtimeMs/.test(revSrc || "") && /ctimeMs/.test(revSrc || "") && /Buffer\.byteLength/.test(revSrc || ""));
	ok("rev：combo 尾部的 rev 会被丢掉（记错了会把『该修』降级成『不用修』）", /includes\(","\)/.test(revSrc || ""));
	ok("rev：入口判据与宿主一致（exports[\"./client\"]）", /exports\["\.\/client"\]/.test(revSrc || ""));
	ok("体检接了 rev 对账（web-boot 点名的每个包）", /resolveClientArtifact/.test(profileSrc) && /classifyBundle/.test(profileSrc));
	ok("体检把 rev 结论写进 crash.bundles（工具面看得见）", /crash\.bundles = bundles/.test(profileSrc));
	ok("摘要行按字节状态改口（还在 / 已重建）", /字节还在/.test(profileSrc) && /字节已重建/.test(profileSrc));
	ok("动作复用原流水线（index 没有新开安装旁路）", !/reinstall/.test(indexSrc2) && /submitInput\("npm:"/.test(clientSrc));
	ok("面板渲染 finding.actions", clientSrc.includes("f.actions") && clientSrc.includes("runFindingAction"));
	ok("体检报告把「面板动作」写出来（模型点不了按钮，但能指路）", /面板动作/.test(toolsSrc));

	/* ⑤j R25：「已装」必须分来源。本机 47 个依赖里 24 个是 link: 的本机目录（自己写的插件），
	   只按名字说「已装」，同名 npm 包会被当成同一个包 —— 点安装就把本机那份换掉。
	   判据钉在源码上：仓库归一是纯函数、对账按形态分级、红旗与提示都要真的接出去。 */
	/* R25 起与 R12 共用同一个 invSrc（下面是同一份文件的另一组判据） */
	ok("来源对账模块（R25）", Boolean(invSrc) && /export function repoKey/.test(invSrc || ""));
	ok("repoKey：认 scp / github: / git+https / 裸 o/r", /\[\\w\.-\]\+@\(\[\\w\.-\]\+\):/.test(invSrc || "") && /github\|gh\|gitlab\|bitbucket/.test(invSrc || ""));
	ok("repoKey：子目录路径只取前两段（tree/<branch>/<sub> 不算不同仓库）", /clean\.length < 2/.test(invSrc || ""));
	ok("对账按安装形态分级（link 一定不同）", /known\.kind === "link"/.test(invSrc || "") && /known\.kind === "git"/.test(invSrc || "") && /known\.kind === "tarball"/.test(invSrc || ""));
	ok("对账：两边仓库都未知就不判（不猜也不标红）", /if \(!known\.repoKey \|\| !cand\) return \{ source: "unknown"/.test(invSrc || ""));
	ok("已装标记带上来源形态", /installedKindLabel: known\.kindLabel/.test(invSrc || ""));
	ok("不同来源塞 name-collision 红旗", /id: "name-collision"/.test(invSrc || ""));
	ok("只在本机：搜本机插件时给一句解释", /export function localOnlyHint/.test(invSrc || "") && /不会出现在 npm \/ GitHub/.test(invSrc || ""));
	ok("pipeline 的 search 把 repoUrl 与 localOnly 带出去", /repoUrl: item\.repoUrl/.test(pipelineSrc) && /localOnly: localOnlyHint\(inv, query, items\)/.test(pipelineSrc));
	ok("搜索结果带上游仓库地址（三个 shaper 都带）", (sourcesSrc.match(/repoUrl/g) || []).length >= 3);
	ok("工具输出不再丢掉「已装」（模型也要看得见）", /已装 " \+ \(item\.installed/.test(toolsSrc) && /result\.localOnly/.test(toolsSrc));
	ok("面板 chip 写出来源形态，并把提示渲染出来", clientSrc.includes("installedKindLabel") && clientSrc.includes("localOnly.text"));

	/* ⑤k R26：升级回滚 / 批量升级 / 三个「看得见」的小改 ——
	   最危险的一条是「升级后点回滚把插件整个卸掉」，所以判定钉在源码上。 */
	ok("升级回滚：回滚计划是纯函数（可单测）", /export function rollbackPlan/.test(pipelineSrc));
	ok("升级回滚：npm 升级按旧版本重装（不是 removeBundle）",
		/mode: "reinstall-npm"/.test(pipelineSrc) && /spec: "npm:" \+ it\.bundleName \+ "@" \+ prevVersion/.test(pipelineSrc));
	ok("升级回滚：本地包先把旧 tgz 写回原路径",
		/mode: "reinstall-file"/.test(pipelineSrc) && /restoreVendorTarball\(plan\.tarball\)/.test(pipelineSrc));
	ok("升级回滚：link/git 只还原声明（不动开发目录）", /mode: "restore-only"/.test(pipelineSrc));
	ok("升级回滚：安装前记下旧版本与旧声明",
		/job\.installedBefore = /.test(pipelineSrc) && /job\.install\.previousVersion = job\.installedBefore\.version/.test(pipelineSrc));
	ok("升级回滚：旧包在安装前被拷进快照", /backupVendorTarball\(snap\.dir/.test(pipelineSrc));
	/* R26.1：装之前就在的，回滚绝不许落到 remove；跨版本升级不跟常规升级一起排队 */
	ok("升级回滚：同版本重装 / 只有旧声明也不许卸载（R26.1）",
		/if \(prevVersion && it\.bundleName\)/.test(pipelineSrc) && /if \(prevSpec && it\.bundleName\)/.test(pipelineSrc));
	ok("批量升级：跨版本默认不排队，二次确认才 includeRisky（R26.1）",
		/export function splitUpgradeTargets/.test(pipelineSrc) &&
		/includeRisky: body\.includeRisky === true/.test(indexSrc2) &&
		clientSrc.includes("仍要一起升级"));
	/* R26.3：本机实测「升级」回 already-installed —— noop 不能当成功 */
	ok("升级停滞：目标版本不同却 noop 时报失败并清空队列（R26.3）",
		/export function upgradeStalled/.test(pipelineSrc) &&
		/job\.install\.stalled = stalled/.test(pipelineSrc) &&
		/this\._queue = \[\]/.test(pipelineSrc));
	/* R26.2：inject 扫描的两处误判修正 */
	const injectSrc = (await readText("lib/inject.js")) || "";
	ok("inject 扫描：timer 方法映射到 timer、客户端 bundle 不参与宿主扫描（R26.2）",
		/TIMER_METHODS/.test(injectSrc) && /CLIENT_BUNDLE/.test(injectSrc) &&
		/TIMER_METHODS\.has\(service\) \? "timer"/.test(injectSrc) && /CLIENT_BUNDLE\.test\(entry\.name\)/.test(injectSrc));
	ok("批量升级：有串行队列与 drain（R26）", /async upgradeOutdated/.test(pipelineSrc) && /async _drainQueue/.test(pipelineSrc));
	ok("批量升级：一次只跑一单（等确认时不启动）",
		/awaiting-confirm/.test((pipelineSrc.match(/async _drainQueue[\s\S]{0,400}/) || [""])[0]));
	ok("批量升级：index 暴露 update-all / clear-queue",
		/action === "update-all"/.test(indexSrc2) && /action === "clear-queue"/.test(indexSrc2));
	ok("批量升级：面板有「全部升级」、队列行与清空",
		clientSrc.includes("全部升级 ") && clientSrc.includes("队列：") && clientSrc.includes("清空队列"));
	ok("已装清单：跨度提示（R26）",
		/export function versionGap/.test((await readText("lib\\semver.js")) || "") &&
		/versionGap\(item\.localVersion/.test(updSrc || "") && clientSrc.includes("item.update.gap.text"));
	ok("已装清单：超过 80 条不再静默截断", clientSrc.includes("只显示前 80 个") && clientSrc.includes("showAll"));
	ok("已装 Skill：说明「来自插件包/内置」的那批",
		/来自插件包\/内置/.test(skillsSrc || "") && clientSrc.includes("counts.hostOnly > 0"));

	/* ⑤l R27：换版本 = 先卸后装（跨插件协作）——
	   这一组的价值是「把三条独立性钉在源码上」：安装器不再自己卸载、两边都不硬依赖、
	   判据只在 lib/upgrade.js 一处。 */
	const upgradeSrc = (await readText("lib\\upgrade.js")) || "";
	const collabSrc = (await readText("lib\\collaborator.js")) || "";
	ok("换版本：判据是纯函数、且只有一处（lib/upgrade.js）",
		/export function decideReplacement/.test(upgradeSrc) && /export function restoreTarget/.test(upgradeSrc) &&
		!/decideReplacement/.test(pipelineSrc.split("import")[0] || ""));
	const replaceBody = (pipelineSrc.split("async prepareAndRemoveForReplace(")[1] || "").split("async restoreAfterFailedUpgrade(")[0] || "";
	ok("换版本：安装器自己**不再**卸载（换版本方法体里没有 removeBundle）",
		replaceBody.length > 200 && !/removeBundle\(/.test(replaceBody) && /provider\.removal\.apply\(/.test(replaceBody));
	const packAt = replaceBody.indexOf("preparePluginTarball({ detected, packDir })");
	const removeAt = replaceBody.indexOf("provider.removal.apply(");
	ok("换版本：先打包再卸载（换版本方法体里 prepare 在 removal.apply 之前）",
		packAt > 0 && removeAt > 0 && packAt < removeAt, { packAt, removeAt });
	ok("换版本：卸载走两段式（plan 拿 token → apply 带 confirm）",
		/provider\.removal\.plan\(\{ name: rep\.name/.test(pipelineSrc) &&
		/provider\.removal\.apply\(\{ token: planned\.token, confirm: true/.test(pipelineSrc));
	ok("换版本：每一步都落盘（中断后能判现场）",
		/phase: "prepared"/.test(pipelineSrc) && /phase = "removing"/.test(pipelineSrc) && /phase = job\.upgrade\.removal\.ok \? "removed"/.test(pipelineSrc));
	ok("换版本：装失败会装回旧版，且按版本核对（不信回执）",
		/restoreAfterFailedUpgrade/.test(pipelineSrc) && /String\(now\.version\) === String\(upgrade\.from\)/.test(pipelineSrc));
	ok("换版本：中断可续跑，但只对「卸载后/旧版还在」这一种",
		/async resumeUpgrade/.test(pipelineSrc) && /upgrade\.phase !== "interrupted"/.test(pipelineSrc) &&
		/action === "resume-upgrade"/.test(indexSrc2));
	ok("换版本：协作方是**可选**服务（ctx.get，不在 inject 里）",
		/ctx\.get\(key\)/.test(collabSrc) && !/export const inject = .*pluginCatalog/.test(indexSrc2));
	ok("换版本：没有协作方就明确拒绝（不排无效队列）",
		/code: "needs-collaborator"/.test(pipelineSrc) && /needsCollaborator: true/.test(pipelineSrc));
	ok("换版本：两个包不许自己换自己（本插件 / 卸载方）",
		/self-replace/.test(upgradeSrc) && /entry\.name === SELF_PACKAGE/.test(pipelineSrc) &&
		/entry\.name === "dsh-plugin-catalog"/.test(pipelineSrc));
	ok("换版本：界面把协作方状态、先卸后装、续跑都渲染出来",
		clientSrc.includes("UpgradeCard") && clientSrc.includes("继续升级") &&
		clientSrc.includes("卸载协作") && clientSrc.includes("需要「插件目录」才能升级"));
	ok("换版本：工具面也说清「宿主不支持原地换版本」",
		toolsSrc.includes("already-installed") && toolsSrc.includes("卸载由「插件目录」"));
	ok("更新结果按版本对账（装/卸之后不显示过期的「可升级」）",
		/String\(found\.localVersion\) === String\(item\.localVersion\)/.test((await readText("lib\\updates.js")) || ""));

	/* R28：契约 api 2 —— 能力协商 + 装完找目录核对（两个都是**可选**能力） */
	ok("R28 契约：api 2 才算「有 inspect」，按函数在不在协商而不是按版本号猜",
		/canInspect = api >= FULL_REMOVAL_API && typeof removal\.inspect === "function"/.test(collabSrc) && /degraded: api < FULL_REMOVAL_API/.test(collabSrc));
	ok("R28 契约：旧 api（1）仍判可用并标 degraded（不因缺 inspect 就拒绝升级）",
		/provider\.ok === true/.test(pipelineSrc) && /旧契约/.test(collabSrc));
	ok("R28 装完核对：诊断后有一步找「插件目录」问「会不会被加载」",
		/crossCheckCatalog/.test(pipelineSrc) && /noteCatalogVerdict/.test(pipelineSrc) &&
		/installed-not-loaded/.test(collabSrc) === false /* 结论码由对面给，安装器不自己判 */ &&
		(collabSrc.match(/pickRemovalProvider/g) || []).length >= 1);
	ok("R28 装完核对：四处诊断收尾都接上（主路径 / 续跑 / 重诊 / 重启回填）",
		(pipelineSrc.match(/this\.noteCatalogVerdict\(/g) || []).length === 4);
	ok("R28 装完核对：判定为「装上了但不加载」要抬成 warn 并给出写回入口",
		/severity: "warn"/.test(pipelineSrc) && /写回 dsh\.profile\.bundles/.test(pipelineSrc));

	/* ⑤m R29：profile 的 pnpm 世代对账 + 带外改动归因。
	   这一组钉四件事：判据只有一处（lib/profilestate.js）、**读不到 ≠ 通过**、
	   只报不修（本插件永不自己跑 pnpm）、三个记账时机都接着线。 */
	const stateSrc = (await readText("lib\\profilestate.js")) || "";
	const healthSrc = (await readText("lib\\profilehealth.js")) || "";
	ok("R29 世代对账：判据是独立模块，且纯函数与 fs 边界分开",
		/export function parseLockfile/.test(stateSrc) && /export function compareProfile/.test(stateSrc) &&
		/export function judgePnpmState/.test(stateSrc) && /export function driftFinding/.test(stateSrc) &&
		/export async function inspectPnpmState/.test(stateSrc) && /export async function noteProfileState/.test(stateSrc));
	ok("R29 世代对账：依赖分类复用 inventory.classifyDepSpec（不写第二套口径）",
		/import \{ classifyDepSpec \} from "\.\/inventory\.js"/.test(stateSrc));
	ok("R29 世代对账：体检里接着线（finding 进 findings，且真的读了 lockfile 与 .modules.yaml）",
		/driftFinding\(pnpmState\)/.test(healthSrc) && /inspectPnpmState\(\{ profileDir, manifest \}\)/.test(healthSrc));
	ok("R29 读不到 ≠ 通过：两份记录缺任一份都判 readable:false，并单独成一条发现",
		judgePnpmState({ declared: {}, installed: {}, lock: { ok: false, error: "x" }, modules: { ok: true, hoisted: {} } }).readable === false &&
		/pnpm-generation-unreadable/.test(stateSrc));
	ok("R29 不误报：lockfile 自己声明 excludeLinksFromLockfile 时，link 缺失不算漂移",
		compareProfile({ declared: { a: "link:../a" }, locked: {}, installed: {}, excludeLinks: true }).ok === true);
	ok("R29 归因：体检只**读**台账（readJournal + readAttribution，不写盘）",
		/readAttribution\(journal \|\| \{\}, \{\}\)/.test(healthSrc) && /attributionFinding\(attribution\)/.test(healthSrc) &&
		!/writeJournal/.test(healthSrc));
	ok("R29 归因：三个记账时机都在（启动 / 任务收尾 / 人点状态）",
		/observeProfileState\(\{ reason: "startup" \}\)/.test(pipelineSrc) &&
		/noteJobProfile\(job\)/.test(pipelineSrc) && /reason: "observe"/.test(toolsSrc));
	ok("R29 归因：只有终态才记（等确认 / 运行中不记 —— 否则会把「装到一半」误报成外部改动）",
		/job\.status !== "done" && job\.status !== "failed" && job\.status !== "cancelled"/.test(pipelineSrc));
	ok("R29 工具面：状态里有一行 pnpm 世代 + 一行带外变更",
		toolsSrc.includes("· profile pnpm：") && toolsSrc.includes("· profile 变更："));
	const actionNamesR29 = Array.from(indexSrc2.matchAll(/action === "([a-z-]+)"/g)).map((m) => m[1]);
	ok("R29 纪律：动作表里没有「修 pnpm / 改 lockfile」这类入口（本插件永不自己跑 pnpm）",
		actionNamesR29.length > 5 && !actionNamesR29.some((name) => /pnpm|lockfile|install-dep|repair-deps/.test(name)),
		{ actions: actionNamesR29 });
	ok("R29 纪律：这个模块不 spawn、不 exec、不跑 pnpm",
		!/child_process/.test(stateSrc) && !/runPnpm|execa|spawn\(/.test(stateSrc));

	/* ⑤n R30：清历史（只清终态）+ 界面契约。
	   判据只在一处（`historyDropPlan` 纯函数），进行中/等待确认必须保留，
	   而且它是「整理界面」不是安装能力 —— 模型看不见这个动作。 */
	ok("R30 清历史：判据是纯函数，导出给宿主与自检共用",
		/export function historyDropPlan/.test(pipelineSrc) && /const plan = historyDropPlan\(this\.jobs\)/.test(pipelineSrc));
	ok("R30 清历史：只清终态、保留 queued / running / awaiting-confirm",
		/const keep = new Set\(\["queued", "running", "awaiting-confirm"\]\)/.test(pipelineSrc));
	ok("R30 清历史：动作接线 + 宿主没换新时如实回 503",
		/action === "clear-history"/.test(indexSrc2) && /清历史是新代码/.test(indexSrc2));
	ok("R30 清历史：**不暴露给模型**（五个 install_hub_* 工具里没有它）",
		!/clear-history/.test(toolsSrc) && !/clearHistory/.test(toolsSrc));
	ok("R30 清历史：面板按钮是两段式，且 4 秒后自己收回确认态",
		/确认清理？/.test(clientSrc) && /setConfirmClear\(false\), 4000/.test(clientSrc) && /action: "clear-history"/.test(clientSrc));
	ok("R30 界面：`--dpi-*` 局部量只在面板根定义一次（层级与配色同源）",
		/\.dpi-panel\{[^}]*--dpi-gap:/.test(clientSrc) && /--dpi-accent:/.test(clientSrc));

	/* ⑥ 数据目录：设置文件是否与运行时会一致（手改过就会出现差异） */
	const settingsFile = join(dataDir(), "settings.json");
	let rawSettings = null;
	try {
		rawSettings = JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		notes.push("没有 data/settings.json（还没在面板里改过设置；这是正常的）");
	}
	if (rawSettings) {
		const normalized = normalizeSettings(rawSettings);
		eq("settings.json 归一化后不变（没有会被静默改掉的值）", rawSettings, normalized);
	}

	/* ⑦ 未完成任务引用的 staging 目录还在不在（R5.1 的保鲜如果坏了会在这暴露） */
	let stateJobs = [];
	try {
		const state = JSON.parse(await readFile(join(dataDir(), "state.json"), "utf8"));
		stateJobs = Array.isArray(state.jobs) ? state.jobs : [];
	} catch {
		notes.push("读不到 data/state.json（新装或还没任务；正常）");
	}
	let pkg = null;
	try {
		pkg = JSON.parse(await readFile(join(profileDir() || "", "package.json"), "utf8"));
	} catch {
		notes.push("读不到 profile 的 package.json（profileDir 未知时正常）");
	}
	const keep = stagingKeepNames(pkg || {}, stateJobs);
	const waiting = stateJobs.filter((j) => j && j.status === "awaiting-confirm");
	for (const job of waiting) {
		try {
			await stat(join(dataDir(), "staging", String(job.id)));
			passed += 1;
		} catch {
			failures.push({ name: "等待确认任务的解包现场还在（" + job.id + "）", extra: "被清掉了 → 确认后会 lost-state" });
		}
	}
	ok("staging 保护集合可计算", keep instanceof Set && keep.size >= 0, keep ? keep.size : null);

	/* ⑨ R31：直连安装（不走 pnpm）与 trustPolicy 的接线 ——
	   这两条都是「改了 profile 配置」的能力，最怕的是**接线漏了**（面板有按钮、宿主没动作）。 */
	const linkSrc = await readText(join("lib", "linkinstall.js"));
	const trustSrc = await readText(join("lib", "trustpolicy.js"));
	ok("R31：lib/linkinstall.js 存在且导出判据与写盘", Boolean(linkSrc) && /export function planLinkInstall/.test(linkSrc) && /export async function applyLinkInstall/.test(linkSrc) && /export async function undoLinkInstall/.test(linkSrc));
	ok("R31：lib/trustpolicy.js 存在且导出读/改", Boolean(trustSrc) && /export function parsePolicy/.test(trustSrc) && /export function addExclude/.test(trustSrc) && /export async function writeExclude/.test(trustSrc));
	ok("R31：junction 不能用 lstat 认（判据必须走 realpath）",
		Boolean(linkSrc) && /realpath/.test(linkSrc) && /不能用 lstat 认|isSymbolicLink\(\)` 是 \*\*false\*\*/.test(linkSrc));
	ok("R31：删链接不能用 unlink（junction 会 EPERM）",
		Boolean(linkSrc) && /async function removeEntry/.test(linkSrc) && /rmdir/.test(linkSrc));
	ok("R31：两个新动作在 index.js 里接了（link-install / add-trust-exclude）",
		/action === "link-install"/.test(indexSrc2) && /action === "add-trust-exclude"/.test(indexSrc2) &&
		/linkInstall/.test(String(await readText(join("lib", "pipeline.js")))));
	ok("R31：**两个动作都不暴露给模型**（动 profile 文件只能人按）",
		!/link-install/.test(toolsSrc) && !/add-trust-exclude/.test(toolsSrc) && !/linkInstall/.test(toolsSrc));
	/* ⚠️ 这里以前把 BUILD 钉成字面量 `r31.0` —— 每加一轮都要改测试，等于用测试阻碍发版。
	   判据要的是「两张卡在 + client 有 build 号」，具体第几版由它自己报。 */
	ok("R31：面板上有两张卡，且都带 BUILD 号",
		/function LinkInstallCard/.test(clientSrc) && /function TrustExemptCard/.test(clientSrc) && /const BUILD = "r\d+\.\d+"/.test(clientSrc));
	ok("R31：安装失败时把「直连安装」当处置动作带出来（本机目录才给）",
		/kind: "link-install"/.test(String(await readText(join("lib", "pipeline.js")))));
	ok("R31：体检会报「信任策略挡过安装」这一条（只报不修）",
		/trust-downgrade/.test(String(await readText(join("lib", "pipeline.js")))) && /report\.info\.trustPolicy/.test(String(await readText(join("lib", "pipeline.js")))));

	/* ⑦b R33：Python 规则的 kind 必须三处对齐。新增一类能力最典型的失效是「接了一半」——
	   面板印出裸 kind（`db-connect`），或者某个用途档永远把它算成「越界」。
	   这两类都不会编译报错、也不会在行为自检里红（除非正好断言了那条文案）。 */
	const pyKinds = [...new Set(PY_RULES.map((rule) => rule.kind))];
	eq("R33：Python 规则产出的每个 kind 都有中文标签", pyKinds.filter((kind) => !RISK_KIND_LABELS[kind]), []);
	ok("R33：新增的 db-connect 在「数据」档里算本来就该有（否则「连数据库」会被判越界）",
		(PURPOSES.data.expected || []).includes("db-connect"));

	/* ⑧ 文档与断言数对表（提示级：改了测试忘了改文档是常态） */
	for (const doc of ["README.md", join("..", "★交接文件·插件安装面板.md")]) {
		const text = await readText(doc);
		if (!text) {
			notes.push("读不到 " + doc);
			continue;
		}
		if (!text.includes(String(EXPECTED_ASSERTIONS))) {
			failures.push({ name: doc + " 没写自检项数 " + EXPECTED_ASSERTIONS, extra: "改了断言就同步文档与 audit 里的 EXPECTED_ASSERTIONS" });
		}
	}

	/* ── 输出 ─────────────────────────────────────────────────────── */
	const total = passed + failures.length;
	console.log("dsh-plugin-installer · audit");
	console.log("· 构建：" + build.label + "（最新源码 " + (build.newestFile || "?") + "）");
	console.log("· 设置：" + describeSettings(DEFAULTS));
	console.log("· profile：" + (profileDir() || "未识别") + " · data：" + dataDir());
	console.log("");
	console.log("PASS " + passed + " / FAIL " + failures.length + "（共 " + total + "）");
	for (const f of failures) console.log("FAIL " + f.name + (f.extra ? "  " + JSON.stringify(f.extra) : ""));
	for (const n of notes) console.log("note " + n);
	console.log("");
	console.log("接下来（这两项这里不做，各有专门入口）：");
	console.log("  1) host_selfcheck({plugin:\"dsh-plugin-installer\"})   —— 行为自检，" + EXPECTED_ASSERTIONS + " 项，必须 0 FAIL");
	console.log("  2) node dev/render-check.cjs                          —— 界面无头渲染，" + EXPECTED_RENDER_ASSERTIONS + " 项");
	if (failures.length === 0) console.log("\nSUMMARY audit passed");
	process.exitCode = failures.length === 0 ? 0 : 1;
}

await main();
