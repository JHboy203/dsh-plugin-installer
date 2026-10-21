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
 *   · 渲染诊断卡 / 设置面板（42 项）—— 由 dev/render-check.cjs 负责，这里只提示。
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
export const EXPECTED_ASSERTIONS = 364;

/** 期望注册的宿主工具（漏一个 = 模型看不见一项能力）。 */
const EXPECTED_TOOLS = [
	"install_hub_status",
	"install_hub_search_plugins",
	"install_hub_submit_request",
	"install_hub_review",
	"install_hub_doctor"
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
	eq("工具数量固定为 5", tools.length, EXPECTED_TOOLS.length);
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
	console.log("  2) node dev/render-check.cjs                          —— 界面无头渲染，62 项");
	if (failures.length === 0) console.log("\nSUMMARY audit passed");
	process.exitCode = failures.length === 0 ? 0 : 1;
}

await main();
