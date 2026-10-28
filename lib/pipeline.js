/**
 * pipeline.js — 安装流水线（确定性，零 token）。
 *
 *   ① 输入接入 → ② 解包与格式探测 → ③ 识别与分类 → ④ 安全预检
 *   →（需要时）等待用户确认 → ⑤ 安装前快照 → ⑥ 安装执行 → ⑦ 安装后诊断
 *   →（按需）异步 AI 语义审查
 *
 * 前一步不通过就短路。任何一步抛错都收敛成 job.error，不把异常抛给宿主。
 * 整个过程不调用模型 —— 唯一的 AI 参与在最后一步，且是可选的。
 */
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { classifyInput } from "./urls.js";
import { DEFAULT_LIMITS, UNSUPPORTED_HINT, extractToDir, sniffFormat } from "./formats.js";
import { detectKind } from "./detect.js";
import { installScripts as collectScripts, scanTree } from "./scan.js";
import { npmReputation, precheck } from "./precheck.js";
import { downloadToFile, resolveGithub, resolveNpmSpec } from "./download.js";
import { searchAll } from "./sources.js";
import { backupVendorTarball, createSnapshot, pruneSnapshots, readSnapshotMeta, restoreProfileFiles, restoreSkill, restoreVendorTarball } from "./snapshot.js";
import { diagnose, installPlugin, installSkill, preparePluginTarball } from "./install.js";
import { quarantineDshTools, removeDanglingLink } from "./landmine.js";
import { applyRepairs, inspectEnvironment } from "./repair.js";
import { inspectProfile, repairProfile } from "./profilehealth.js";
import { pendingBuildFinding, readBuildPolicy } from "./installfailure.js";
import { exemptionTarget, grantExemption, readExemptions, summarizeExemptions } from "./exemptions.js";
import { JOURNAL_NAME, inspectPnpmState, noteProfileState, readAttribution, readJournal } from "./profilestate.js";
import { buildStamp, dataDir, firstExistingDir, hostVersions, installedPluginInfo, profileDir, profileName, readProfilePackage, skillRoots } from "./hostinfo.js";
import { readInventory, summarizeInventory, annotateInstalled, officialBasenames, annotateShadows, localOnlyHint } from "./inventory.js";
import { buildSkillView, planSkillFix, planSkillPark, readSkillsOnDisk, rewriteSkillFrontmatter, skillFindings, summarizeSkills } from "./skills.js";
import { parseSkillFrontmatter } from "./detect.js";
import { activationFindings, scanActivation, summarizeActivation } from "./activation.js";
import { checkUpdates as runUpdateCheck, mergeUpdates, summarizeUpdates } from "./updates.js";
import { mergeSettings, loadSettings, normalizeSettings, saveSettings } from "./settings.js";
/* R27：换版本 = 先卸再装。协作方只提供"卸载"这一件事；装与换版本仍归本插件。 */
import { REMOVAL_API, describeCollaboratorLine, describeRemovalProvider, pickRemovalProvider } from "./collaborator.js";
import { SELF_PACKAGE, decideReplacement, replacementReason, restoreTarget, summarizeReplacement } from "./upgrade.js";
/* R31：本机目录插件的直连安装（不走 pnpm）与 profile 的供应链策略（trustPolicy）。 */
import { applyLinkInstall, planLinkInstall, probeEntry, undoLinkInstall } from "./linkinstall.js";
import { describePolicy, readPolicy, writeExclude } from "./trustpolicy.js";

const STAGES = [
	{ key: "input", label: "① 输入接入" },
	{ key: "download", label: "② 下载" },
	{ key: "unpack", label: "③ 解包与格式探测" },
	{ key: "detect", label: "④ 识别与分类" },
	{ key: "precheck", label: "⑤ 安全预检" },
	{ key: "confirm", label: "⑥ 等待确认" },
	{ key: "snapshot", label: "⑦ 安装前快照" },
	/* R27：换版本（升级/降级/回滚装回）只有一条路 —— 先卸载旧版再装。
	   卸载交给「插件目录」（lib/collaborator.js）；这一步就是那个交接点。
	   放在 install 之前，是为了让时间线上能看出"卡在卸载"还是"卡在安装"。 */
	{ key: "replace", label: "⑦b 卸载旧版（交给插件目录）" },
	{ key: "install", label: "⑧ 安装" },
	{ key: "diagnose", label: "⑨ 安装后诊断" }
];

const ATTENTION_WORTHY = new Set(["failed", "awaiting-confirm"]);

/** 字节数的人类读法（13 B 不该显示成 0 KiB）。 */
function fmtBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return n + " B";
	if (n < 1048576) return Math.round(n / 1024) + " KiB";
	return (n / 1048576).toFixed(1) + " MiB";
}

/**
 * Windows 上 `rename(tmp, dest)` 是「替换目标」语义，但**两个 rename 同时指向同一个目标**
 * 时会撞 EPERM（而不是 ENOENT）；杀软/索引器短暂持有句柄时也会。这类错误都是瞬时，
 * 重试一次就过去了 —— 与之相对，真正的路径不存在（ENOENT）只在「别人先把 tmp 搬走了」
 * 时出现，也正是我们做唯一 tmp 名要根治的那一种。
 */
const TRANSIENT_RENAME = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(from, to, attempts = 4) {
	let lastError = null;
	for (let i = 0; i < attempts; i += 1) {
		try {
			await rename(from, to);
			return true;
		} catch (e) {
			lastError = e;
			if (!e || !TRANSIENT_RENAME.has(e.code)) throw e;
			await new Promise((resolve) => setTimeout(resolve, 40 * (i + 1)));
		}
	}
	throw lastError;
}

class StageError extends Error {
	constructor(code, message, hint, extra) {
		super(message);
		this.name = "StageError";
		this.code = code;
		this.hint = hint;
		/* R9：「为什么失败」的结构化说明（plain 大白话 + fix 处置步骤）随错误一起
		   走到 job.error，面板不用再猜该显示什么。
		   R31：多一个 `actions` —— 面板能直接点的处置（如「豁免某个版本」「直连安装」）。 */
		if (extra && typeof extra === "object") {
			if (extra.plain) this.plain = String(extra.plain);
			if (Array.isArray(extra.fix)) this.fix = extra.fix;
			if (extra.kind) this.kind = String(extra.kind);
			if (Array.isArray(extra.actions)) this.actions = extra.actions;
		}
	}
}

function nowIso() {
	return new Date().toISOString();
}

function newJobId() {
	return "job-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
}

function freshStages() {
	return STAGES.map((s) => ({ key: s.key, label: s.label, status: "pending", detail: null, ms: null }));
}

function stageOf(job, key) {
	return job.stages.find((s) => s.key === key) || null;
}

function setStage(job, key, status, detail) {
	const stage = stageOf(job, key);
	if (!stage) return;
	stage.status = status;
	if (detail !== undefined) stage.detail = detail;
	if (status === "running") stage.at = Date.now();
	if (status !== "running" && stage.at) stage.ms = Date.now() - stage.at;
	job.updatedAt = nowIso();
}

/**
 * 协作方描述只保留面板需要的字段（服务对象不能进 state.json）。
 * 纯函数，hosttest 直接喂对象。
 */
export function compactCollaborator(provider) {
	if (!provider) return null;
	return {
		ok: provider.ok === true,
		state: String(provider.state || ""),
		name: String(provider.name || ""),
		version: String(provider.version || ""),
		label: String(provider.label || ""),
		reason: String(provider.reason || ""),
		fix: Array.isArray(provider.fix) ? provider.fix.slice(0, 3) : [],
		line: describeCollaboratorLine(provider),
		api: Number(provider.removal && provider.removal.api) || REMOVAL_API
	};
}

function compactDetected(detected) {
	if (!detected) return null;
	const manifest = (detected.payload && detected.payload.manifest) || {};
	const skill = detected.payload && detected.payload.meta ? detected.payload.meta : null;
	return {
		kind: detected.kind,
		installable: detected.installable,
		reason: detected.reason || null,
		root: detected.root,
		wrappers: detected.wrappers,
		notes: detected.notes,
		files: detected.tree ? detected.tree.files.length : 0,
		bytes: detected.tree ? detected.tree.bytes : 0,
		forbidden: (detected.forbidden || []).map((f) => f.rel).slice(0, 20),
		name: manifest.name || (skill && skill.name) || null,
		version: manifest.version || null,
		description: manifest.description || (skill && skill.description) || null,
		peerDependencies: manifest.peerDependencies || {},
		engines: manifest.engines || {},
		hasClient: Boolean(manifest.dsh && manifest.dsh.client),
		patchRel: detected.payload ? detected.payload.patchRel || null : null,
		skill: skill
			? { name: skill.name, description: skill.description, valid: skill.valid, reasons: skill.reasons }
			: null
	};
}

function compactPrecheck(pc) {
	if (!pc) return null;
	return {
		ok: pc.ok,
		blocked: pc.blocked,
		needsConfirm: pc.needsConfirm,
		needsAiReview: pc.needsAiReview,
		severity: pc.severity,
		reasons: pc.reasons,
		fixes: pc.fixes,
		compat: {
			verdict: pc.compat.verdict,
			via: pc.compat.via,
			runtimeVersion: pc.compat.runtimeVersion,
			requirements: pc.compat.requirements,
			checks: pc.compat.checks,
			node: pc.compat.node
		},
		trust: pc.trust,
		/* R31：直连安装（link，不走 pnpm）的判据结论 —— 面板据此显示「已经/可以直连」与按钮 */
		link: pc.link || null,
		/* R8：工具注册契约扫描（0.2.1 起漏 output = 插件失活） */
		contract: pc.contract || null,
		/* 已装版本对照（R5.1）：{ installed, version, relation }。面板用它把
		   「装上了」说成「升级 0.1.16 → 0.1.17」或「降级」。 */
		installed: pc.installed || null,
		/* R6：这次按哪一档审核（strict/normal/off），面板与工具都要能看到 */
		reviewLevel: pc.reviewLevel || "normal",
		/* 用途 vs 权限（R3）：面板要单独展示这一块，所以原样透传（丢掉大字段，避免 state.json 膨胀） */
		purpose: pc.purpose
			? {
				purpose: pc.purpose.purpose,
				verdict: pc.purpose.verdict,
				score: pc.purpose.score,
				summary: pc.purpose.summary,
				plain: pc.purpose.plain,
				findings: pc.purpose.findings,
				advice: pc.purpose.advice,
				present: pc.purpose.present,
				unexpected: pc.purpose.unexpected,
				tolerated: pc.purpose.tolerated,
				expected: pc.purpose.expected
			}
			: null,
		/* R27：换版本（先卸后装）与协作方状态 —— 面板据此渲染「会先卸载」/「需要插件目录」 */
		replacement: pc.replacement || null,
		collaborator: pc.collaborator ? compactCollaborator(pc.collaborator) : null,
		risks: {
			severity: pc.risks.severity,
			summary: pc.risks.summary,
			hits: pc.risks.hits.slice(0, 40),
			combos: pc.risks.combos,
			scripts: pc.risks.scripts,
			scanned: pc.risks.scanned,
			skipped: pc.risks.skipped.slice(0, 10)
		}
	};
}

/**
 * R31：把直连安装的计划压成能进 state.json 的形状（函数/service 一律不能进去）。
 */
function compactLinkPlan(plan) {
	if (!plan) return null;
	return {
		ok: plan.ok !== false,
		name: plan.name || null,
		sourceDir: plan.sourceDir || null,
		alreadyLinked: plan.alreadyLinked === true,
		entryLinked: plan.entryLinked === true,
		blocked: plan.blocked || null,
		changes: plan.changes || null,
		steps: Array.isArray(plan.steps) ? plan.steps : [],
		note: plan.note || ""
	};
}

/**
 * R26：回滚该做什么 —— 纯函数（真回滚要碰宿主，没法在 hosttest 里跑）。
 *
 * 四种模式：
 *   remove         全新安装（装之前它不在）→ 卸掉
 *   reinstall-npm  装之前就在的 npm 包 → 按旧版本号重装（**不是卸载**；同版本重装也走这里）
 *   reinstall-file 装之前就在的本地面包 → 先把快照里的旧 .tgz 写回原路径，再按原 `file:` 声明重装
 *   restore-only   link:/git 来源，或只知道旧声明、不知道旧版本 → 只还原声明（不卸也不重装）
 *
 * R26.1 修掉一条反向风险：**「装之前它就在」就不许 remove**。同版本重装（upgrade=false）
 * 以前会落到 remove —— 用户点「回滚」本意是回到装之前，而装之前它明明装着。
 * 只有「装之前版本与声明都不知道」才退回 remove（老任务、中断回填不全）。
 */
export function rollbackPlan(install) {
	const it = install || {};
	const prevSpec = it.previousSpec ? String(it.previousSpec) : "";
	const prevVersion = it.previousVersion ? String(it.previousVersion) : "";
	if (prevSpec && /^file:/i.test(prevSpec)) {
		/* 旧包在快照里才能真装回旧版；只有声明没有版本/旧包时，重装等于把新版又装一遍 —— 不做 */
		if (it.previousTarball || prevVersion) {
			return { mode: "reinstall-file", path: prevSpec.slice(5).trim(), version: prevVersion, tarball: it.previousTarball || null };
		}
		return { mode: "restore-only", spec: prevSpec, version: "" };
	}
	if (prevSpec && /^(link:|github:|git\+|https?:)/i.test(prevSpec)) {
		return { mode: "restore-only", spec: prevSpec, version: prevVersion };
	}
	if (prevVersion && it.bundleName) {
		/* 同版本重装（upgrade=false）也走重装：回滚 = 回到装之前，而装之前它就在 */
		return { mode: "reinstall-npm", spec: "npm:" + it.bundleName + "@" + prevVersion, version: prevVersion };
	}
	if (prevSpec && it.bundleName) {
		/* 知道旧声明但没有旧版本号：只还原声明，绝不卸载、也不猜版本 */
		return { mode: "restore-only", spec: prevSpec, version: "" };
	}
	return { mode: "remove" };
}

/**
 * R26.1：批量升级要先分档 —— 「跨大版本 / 0.x 小版本」不跟常规升级一起一键排队。
 *
 * 为什么：`0.3.0 → 0.4.1` 按 semver 可能就是破坏性变更（本机 dsh-ops 正是这种）。
 * 面板一贯的原则是「风险要人点头」，所以这些单独列出来，由 `includeRisky` 显式确认。
 *
 * @returns {{safe:Array, risky:Array}} 每项带 {name, registryName, from, to, gap, severe}
 */
export function splitUpgradeTargets(items) {
	const safe = [];
	const risky = [];
	for (const item of items || []) {
		if (!item || !item.installed || !item.checkable) continue;
		if (!item.update || item.update.relation !== "outdated" || !item.update.latestVersion) continue;
		const gap = item.update.gap || null;
		const entry = {
			name: item.name,
			registryName: item.registryName || item.name,
			from: item.localVersion || null,
			to: item.update.latestVersion,
			gap: gap && gap.text ? gap.text : "",
			severe: Boolean(gap && gap.severe)
		};
		(entry.severe ? risky : safe).push(entry);
	}
	return { safe, risky };
}

/**
 * R26.3：`noop` 遇上「目标是另一个版本」= 这次升级其实没有发生。
 *
 * 宿主 0.2.1-rc.2 的 `installBundle` 对**已在 profile 依赖里的包名**直接回
 * `already-installed`（原文：uninstall it before installing another version），
 * 一次 pnpm 都不跑。面板以前把它收成 ok+noop，面板显示「已完成」，版本却没变 —— 假成功。
 *
 * 注意：同版本重装（from === to）也是 noop，那是正常的，不算 stalled。
 */
export function upgradeStalled(input) {
	const it = input || {};
	if (!it.noop) return null;
	const from = it.previousVersion ? String(it.previousVersion) : "";
	const to = it.targetVersion ? String(it.targetVersion) : "";
	if (!from || !to || from === to) return null;
	return { from, to, reason: "host-refuses-replace" };
}

/**
 * R30：清历史的判据（纯函数）。
 *
 * 只清**终态**：`done` / `failed` / `cancelled` / `rolled-back` 以及任何不认识的终态。
 * 保留的是「还会有后续动作」的那三种：`queued` / `running` / `awaiting-confirm` ——
 * 清掉它们等于把正在跑的现场连同 `data/staging/<jobId>` 一起弄丢（`prune()` 的 liveDirs
 * 也是按同一份状态推出来的）。
 *
 * 判据放在这里、`clearHistory()` 与自检共用一份：两处各写一遍就是「面板说清三条、实际清四条」
 * 这类漂移的老来源。
 */
export function historyDropPlan(jobs) {
	const keep = new Set(["queued", "running", "awaiting-confirm"]);
	const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
	const dropped = list.filter((job) => !keep.has(job.status));
	const byStatus = {};
	for (const job of dropped) byStatus[job.status] = (byStatus[job.status] || 0) + 1;
	return { dropped, kept: list.length - dropped.length, byStatus };
}

export class Installer {
	constructor({ ctx, options = {} }) {
		this.ctx = ctx;
		this.options = options;
		this.root = dataDir();
		this.statePath = join(this.root, "state.json");
		this.jobs = [];
		this.activeId = null;
		this._running = null;
		/* R26：批量升级队列（内存态，宿主重启后不续跑 —— 免得一开机就在没人看着时装东西） */
		this._queue = [];
		this._integrations = null;
		this._integrationsAt = 0;
		/* R12：已装清单（本地读取，30 秒缓存 —— /state 每 2.5 秒轮询一次，别每次都读 40 个 package.json） */
		this._inventory = null;
		this._inventoryAt = 0;
		this._updates = null;
		this._updatesAt = 0;
		/* R14：已装 Skill（同样 30 秒缓存 —— 主进程每分钟才该扫一次 59 个 SKILL.md） */
		this._skills = null;
		this._skillsAt = 0;
		this._dismissed = new Set();
		this.warnings = [];
		this._reconciled = false;
		this.loaded = false;
		/* R27：卸载协作方（插件目录）的探测结果 —— 10 秒缓存，面板一行结论用它 */
		this._collaborator = null;
		this._collaboratorAt = 0;
	}

	dirs() {
		const root = this.root;
		return {
			root,
			staging: join(root, "staging"),
			snapshots: join(root, "snapshots"),
			logs: join(root, "logs")
		};
	}

	async init() {
		const { root, staging, snapshots, logs } = this.dirs();
		for (const dir of [root, staging, snapshots, logs]) await mkdir(dir, { recursive: true });
		/* R6：个性化设置。默认档 = R5.1 的现有行为，读不到 settings.json 也不会改变任何东西。 */
		this.settingsPath = join(root, "settings.json");
		this.settings = await loadSettings(this.settingsPath);
		try {
			const text = await readFile(this.statePath, "utf8");
			const data = JSON.parse(text);
			this.jobs = Array.isArray(data.jobs) ? data.jobs : [];
			this._dismissed = new Set(Array.isArray(data.dismissed) ? data.dismissed : []);
			/* 上次进程退出时还在跑的任务：标记为中断，别让面板永远转圈 */
			for (const job of this.jobs) {
				if (job.status === "running") {
					job.status = "failed";
					job.error = { code: "interrupted", message: "宿主进程在安装过程中退出/重启，这一步已中断", stage: null };
					for (const stage of job.stages || []) {
						if (stage.status === "running") stage.status = "fail";
					}
				}
			}
		} catch {
			this.jobs = [];
		}
		this.loaded = true;
		await this.prune();
		/* 启动时先扫一遍那个老雷：上次的 pnpm 可能把 dsh-tools 装进了 profile。 */
		await this.sweepLandmine("startup");
		/* R29：再记一次 profile 依赖签名 —— 「带外改动」（别的会话 / 手工脚本 / 官方插件管理器）
		   要有一个基线才看得出。失败只吞掉：记账不该挡住启动。 */
		await this.observeProfileState({ reason: "startup" }).catch(() => null);
		return this;
	}

	/**
	 * profile 的 package.json 里仍然被 `file:` 引用的 staging 子目录名。
	 * 早期版本把 .tgz 打进 staging（已改为 vendor/），那些旧任务目录一旦被
	 * prune 删掉，依赖就指向空气 —— 下一次 pnpm 操作必然失败。所以留着它们。
	 */
	async referencedStagingDirs() {
		const dir = profileDir();
		if (!dir) return new Set();
		try {
			const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
			return stagingKeepNames(pkg, this.jobs);
		} catch {
			/* 读不到就保守：不删任何东西 */
			return new Set(["*"]);
		}
	}

	/**
	 * R11：两条「会静默卡住安装」的环境事实，压成一行给 `install_hub_status`。
	 *   · 版本豁免：升级 DSH 之后旧记录失效 → 插件安静消失；
	 *   · 待批准安装脚本：残留在 profile 里 → 下一次装同一个依赖还卡在同一处。
	 * 只读、只提醒（修/批都要人点头，动作在面板里）。
	 */
	async environmentCaveats(options = {}) {
		const parts = [];
		const versions = await hostVersions();
		const runtime = options.runtimeVersion || versions.dshTools || versions.dsh || null;
		const ex = await readExemptions(options.profileDir ? { profileDir: options.profileDir } : { pluginManager: this.ctx.pluginManager });
		const summary = summarizeExemptions(ex.exemptions, runtime);
		if (summary.total === 0) {
			parts.push("版本豁免 0 条");
		} else if (summary.stale.length === 0) {
			parts.push("版本豁免 " + summary.total + " 条（全部有效）");
		} else {
			parts.push("版本豁免 " + summary.total + " 条（" + summary.stale.length + " 条对当前 DSH 已失效：" +
				summary.stale.slice(0, 3).map((entry) => entry.key).join("、") + "）");
		}
		if (ex.warnings && ex.warnings.length) parts.push("豁免记录有警告：" + ex.warnings.join("；").slice(0, 160));
		const policy = await readBuildPolicy(options.profileDir || profileDir());
		if (policy.ok && policy.pending.length > 0) {
			parts.push("待批准安装脚本 " + policy.pending.length + " 个（" + policy.pending.slice(0, 4).join("、") +
				"）—— 下次装同一个依赖还会卡住，在面板里批准");
		}
		return parts.join(" · ");
	}

	/**
	 * R29：profile 的「pnpm 世代」对账（**本地读，30 秒缓存**）。
	 *
	 * 与 `inventory` 分开缓存：这份要读 lockfile（可能几十万字节）+ 每个依赖的 package.json，
	 * 比清单更贵一点；而 `/state` 每 2.5 秒轮询，绝不能跟着它的节奏读。
	 */
	async pnpmState(force = false) {
		if (!force && this._pnpmState && Date.now() - this._pnpmStateAt < 30000) return this._pnpmState;
		const state = await inspectPnpmState({ profileDir: profileDir() });
		this._pnpmState = state;
		this._pnpmStateAt = Date.now();
		return state;
	}

	/** R29：一行摘要给工具（「lockfile 落后多少 / 哪几项对不上」）。 */
	async pnpmStateLine() {
		const state = await this.pnpmState().catch(() => null);
		if (!state) return null;
		return state.line || null;
	}

	/**
	 * R29：观察一次 profile 并落台账（`data/profilestate.json`）。
	 * `reason`：`startup` / `observe` / `job:<任务id>` —— 只有 `job:` 算「本面板干的」。
	 */
	async observeProfileState({ reason = "observe", jobId = null, force = false } = {}) {
		const result = await noteProfileState({
			profileDir: profileDir(),
			journalPath: join(this.dirs().root, JOURNAL_NAME),
			reason,
			jobId,
			force
		});
		if (result && result.ok && result.journal) this._profileJournal = result.journal;
		return result;
	}

	/** R29：任务收尾时记一次（等确认 / 运行中不记 —— 那时 profile 还没变完）。 */
	async noteJobProfile(job) {
		if (!job || !job.id) return null;
		if (job.status !== "done" && job.status !== "failed" && job.status !== "cancelled") return null;
		return this.observeProfileState({ reason: "job:" + job.id, jobId: job.id }).catch(() => null);
	}

	/** R29：最新一条「不能归因给本面板」的变更（读台账，不写）。 */
	async profileAttribution() {
		const journal = this._profileJournal || (await readJournal(join(this.dirs().root, JOURNAL_NAME)).catch(() => null));
		return readAttribution(journal || {}, {});
	}

	/** R29：一行「profile 被外部改过什么」给工具 —— 只在真有这条时返回。 */
	async profileChangeLine() {
		const attribution = await this.profileAttribution().catch(() => null);
		if (!attribution) return null;
		const total = (attribution.added || 0) + (attribution.removed || 0) + (attribution.changed || 0);
		if (total === 0) return null;
		const bits = [];
		if (attribution.added) bits.push("+" + attribution.added);
		if (attribution.removed) bits.push("−" + attribution.removed);
		if (attribution.changed) bits.push("~" + attribution.changed);
		const items = attribution.items || {};
		const samples = [].concat(items.changed || [], items.added || [], items.removed || []).slice(0, 3);
		return String(attribution.at || "").replace("T", " ").slice(0, 16) + " 前后 " + bits.join("/") +
			(samples.length ? "（" + samples.join("、") + "）" : "") + " —— 不是本面板做的";
	}

	/**
	 * R12：已装清单（**纯本地读，不联网**）。
	 *
	 * 30 秒缓存：`/state` 每 2.5 秒轮询一次，而这里要读 profile 的 package.json +
	 * 每个依赖的 `node_modules/<name>/package.json`（本机 44 个）。按需读没问题，
	 * 但不能跟着轮询节奏反复读。
	 */
	async inventory(force = false) {
		if (!force && this._inventory && Date.now() - this._inventoryAt < 30000) return this._inventory;
		const inv = await readInventory({ profileDir: profileDir() });
		this._inventory = inv;
		this._inventoryAt = Date.now();
		return inv;
	}

	/**
	 * R12：已装清单 + 「已装 vs registry 最新版」。**联网**，只在用户点「检查更新」时跑
	 * （见 lib/updates.js 里那三条约束：失败逐条隔离、30 分钟缓存、并发封顶）。
	 *
	 * 返回里 `items` 已经把 `update` 并进去了 —— 面板不需要自己 join 两份数据。
	 */
	async checkUpdates() {
		const inv = await this.inventory(true);
		const updates = await runUpdateCheck(inv.items);
		this._updates = updates;
		this._updatesAt = Date.now();
		return {
			ok: inv.ok,
			at: updates.at,
			/* 与 inventoryView() 的字段对齐：两条路径都要能显示「什么时候检查的」 */
			updatesAt: updates.at,
			reason: inv.reason || null,
			note: inv.note || null,
			profileDir: inv.profileDir || null,
			counts: inv.counts,
			problems: inv.problems,
			items: mergeUpdates(inv.items, updates),
			summary: updates.summary,
			skipped: updates.skipped
		};
	}

	/** R12：清单摘要（工具与面板共用同一句话，避免两套口径）。 */
	inventoryLine(inv) {
		return summarizeInventory((inv && inv.counts) || null);
	}

	/**
	 * R12：给面板/工具看的那一份 —— 把**最近一次检查更新的结果**并进去（30 分钟内有效）。
	 * 这样用户检查过后刷新面板/换个会话，仍然看得到「哪些能升级」，不需要重新打一轮 registry。
	 */
	async inventoryView() {
		const inv = await this.inventory();
		if (!this._updates || !this._updatesAt || Date.now() - this._updatesAt > 30 * 60 * 1000) return inv;
		return {
			...inv,
			items: mergeUpdates(inv.items, this._updates),
			summary: this._updates.summary,
			updatesAt: this._updates.at
		};
	}

	/** R12：更新摘要（同上）。 */
	updatesLine(summary) {
		return summarizeUpdates(summary || null);
	}

	/**
	 * R14：已装 Skill —— 「磁盘上有哪些、宿主认了哪些、为什么有的用不上」。
	 *
	 * 两个数据源缺一不可：只有磁盘 → 会把「宿主不认」说成「装了」；只有宿主 →
	 * 看不见备份目录、坏掉的 frontmatter、以及压根没落位的 SKILL.md。
	 *
	 * 30 秒缓存的原因同 inventory：面板会轮询 /state，而这里要读 59 个 SKILL.md。
	 */
	async skills(force = false) {
		if (!force && this._skills && Date.now() - this._skillsAt < 30000) return this._skills;
		const roots = skillRoots();
		const host = await this.hostSkillList();
		const items = await readSkillsOnDisk({ roots });
		const view = buildSkillView({
			roots,
			items,
			host: host.list,
			hostComplete: host.complete,
			hostError: host.error,
			panelInstalled: this.panelInstalledSkills()
		});
		this._skills = view;
		this._skillsAt = Date.now();
		return view;
	}

	/**
	 * R15：把技能根里的备份目录**移**到 `data/parked-skills/<时间戳>/`（移动，不删除）。
	 *
	 * 为什么要有它：面板已经能报「4 组重名（其中 4 个是备份残留）」，但没有入口时，
	 * 这条结论只能停在「你去手动处理」。移动是可逆的：落在本插件数据目录，随时能搬回，
	 * 而且那里不在任何技能根下 —— 宿主不会扫到。
	 *
	 * 为什么不删：删文件是人的决定。面板只做「移走 + 留下证据」，不做破坏性操作。
	 * 判据全在 `planSkillPark()`（纯函数）：只接受技能根下一层、且必须是备份形态的名字。
	 *
	 * @param {string} dirName 备份目录名（一层，不含路径）
	 * @param {{roots?: string[], parkedRoot?: string}} [options] 只给测试用（生产走真实技能根与本插件 data）
	 */
	async parkSkillBackup(dirName, options = {}) {
		const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : skillRoots();
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const parkedRoot = options.parkedRoot || join(this.root, "parked-skills");
		const planned = planSkillPark({ roots, dir: dirName, stamp, parkedRoot });
		if (!planned.ok) return planned;
		try {
			const info = await stat(planned.from);
			if (!info.isDirectory()) return { ok: false, reason: "不是目录：" + planned.from };
		} catch {
			return { ok: false, reason: "找不到这个目录（宿主可能已经重扫过）：" + planned.from };
		}
		try {
			await mkdir(planned.toDir, { recursive: true });
			await renameWithRetry(planned.from, planned.to);
		} catch (e) {
			return { ok: false, reason: "移不动（可能被占用）：" + String((e && e.message) || e) };
		}
		/* 让缓存失效，并把「移完之后的视图」直接回给面板（少一次往返） */
		this._skills = null;
		this._skillsAt = 0;
		const view = await this.skills(true).catch(() => null);
		await this.log("parked skill backup " + planned.dir + " -> " + planned.to).catch(() => {});
		return { ok: true, dir: planned.dir, from: planned.from, to: planned.to, skills: view };
	}

	/**
	 * R16：把「frontmatter 不是合法 YAML」的技能**就地修好**（先备份，再原子写，最后重扫）。
	 *
	 * 为什么放进插件：诊断（`yamlFrontmatterIssue`）与「移走备份」在面板上了，只有「改这一行」
	 * 还留在 `.tools/fix-skill-frontmatter.py` —— 换个会话就不存在了。现在它是一条确定性动作：
	 *   · 只修 `yamlIssue` 命中的顶格标量（未加引号且含 `: ` / ` #`），改成 `key: >` 块标量；
	 *   · 写前把原文备份到 `data/skill-fixes/<时间戳>/<目录>/SKILL.md`；
	 *   · 写用 tmp + rename（原子替换，宿主 watcher 不会读到半个文件）；
	 *   · 改写结果必须过 `rewriteSkillFrontmatter` 的三道自检（检测清零 / name 不变 / description 语义不变）。
	 * **不暴露给模型**（动用户文件的动作只能人按），与 park / 批准 / 授权同一类。
	 *
	 * @param {string} dirName 技能目录名（一层）
	 * @param {{roots?: string[], backupRoot?: string}} [options] 只给测试用
	 */
	async repairSkillFrontmatter(dirName, options = {}) {
		const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : skillRoots();
		const planned = planSkillFix({ roots, dir: dirName });
		if (!planned.ok) return planned;
		const text = await readFile(planned.file, "utf8").catch(() => null);
		if (text === null) return { ok: false, reason: "读不到 SKILL.md：" + planned.file };
		const meta = parseSkillFrontmatter(text);
		if (!meta.yamlIssue) return { ok: false, reason: "这个技能的 frontmatter 已经是合法 YAML（无需修）" };
		const rewrite = rewriteSkillFrontmatter(text);
		if (!rewrite.ok) return { ok: false, reason: rewrite.reason };
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const backupRoot = options.backupRoot || join(this.root, "skill-fixes");
		const backupDir = join(backupRoot, stamp, planned.dir);
		try {
			await mkdir(backupDir, { recursive: true });
			await writeFile(join(backupDir, "SKILL.md"), text, "utf8");
		} catch (e) {
			return { ok: false, reason: "备份失败（不敢改）：" + String((e && e.message) || e) };
		}
		const tmp = planned.file + ".dpi-tmp";
		try {
			await writeFile(tmp, rewrite.text, "utf8");
			await renameWithRetry(tmp, planned.file);
		} catch (e) {
			await rm(tmp, { force: true }).catch(() => {});
			return { ok: false, reason: "写入失败（原文已备份）：" + String((e && e.message) || e) };
		}
		this._skills = null;
		this._skillsAt = 0;
		const view = await this.skills(true).catch(() => null);
		await this.log("repaired skill frontmatter " + planned.dir + " (" + rewrite.changes.map((c) => c.key + ":" + c.code).join(",") + ") backup=" + backupDir).catch(() => {});
		return { ok: true, dir: planned.dir, changes: rewrite.changes, backup: backupDir, skills: view };
	}

	/**
	 * 宿主侧技能清单。
	 *
	 * ⚠️ `skills` **不在本插件的 inject 里**（inject 只有 tools / webServer），所以
	 *    `ctx.skills` 可能读不到 —— 按宿主契约，可选服务要用 `ctx.get("skills")`。
	 *    只写 `ctx.skills` 会得到一个永远为 undefined 的假结论（「这台主机没有技能服务」），
	 *    这种「读不到就当成不存在」正是最该避免的一类错误。
	 */
	async hostSkillList() {
		const ctx = this.ctx || {};
		let svc = null;
		let reason = "no-service";
		try {
			if (typeof ctx.get === "function") {
				const optional = ctx.get("skills");
				if (optional && typeof optional.list === "function") svc = optional;
				else if (optional) reason = "no-list-method";
			}
		} catch (e) {
			reason = "get-failed: " + String((e && e.message) || e);
		}
		if (!svc) {
			const direct = ctx.skills;
			if (direct && typeof direct.list === "function") svc = direct;
		}
		if (!svc) return { list: null, complete: null, error: reason };
		try {
			const list = await svc.list({});
			let complete = null;
			if (typeof svc.snapshot === "function") {
				const snap = await svc.snapshot({}).catch(() => null);
				if (snap && typeof snap.complete === "boolean") complete = snap.complete;
			}
			if (!Array.isArray(list)) return { list: null, complete, error: "list-not-array" };
			return { list, complete, error: null };
		} catch (e) {
			return { list: null, complete: null, error: String((e && e.message) || e) };
		}
	}

	/** 本面板装过的技能（来自任务历史）—— 只补一句来源，不参与判定。 */
	panelInstalledSkills() {
		const out = [];
		for (const job of this.jobs || []) {
			const install = job && job.install;
			if (!install || install.kind !== "skill" || !install.skillName) continue;
			out.push({ name: install.skillName, jobId: job.id, at: job.finishedAt || job.updatedAt || job.createdAt || null });
		}
		return out;
	}

	/** R14：技能摘要一行（工具与面板共用）。 */
	skillsLine(view) {
		return summarizeSkills(view && view.counts, { hostKnown: Boolean(view && view.host && view.host.available) });
	}

	/**
	 * R13：激活视图 —— 「我装的东西现在都在跑吗」。
	 *
	 * 判据全部来自宿主契约（`lib/activation.js`）：`listPlugins()` 的 `enabled`/`fiberPhase`
	 * 是**实测**，`lib/inject.js` 的静态扫描解释「为什么起不来」。两者合起来才回答得了
	 * 「装了怎么没反应」—— 这正是 R13 之前面板答不出的那个问题。
	 *
	 * @param {{inject?: boolean}} [options] inject=false 时不扫源码（快，够状态行用）
	 */
	async activation(options = {}) {
		const pm = this.ctx && this.ctx.pluginManager;
		const [plugins, inv] = await Promise.all([
			pm && typeof pm.listPlugins === "function" ? pm.listPlugins().catch(() => null) : null,
			this.inventory().catch(() => null)
		]);
		/* bundle 行来自 profile 清单（inventory 已经读过）；它比 listBundles() 更稳 ——
		   host 的 listBundles 在某些失败态下会少给条目。 */
		const bundles = (inv && Array.isArray(inv.items) ? inv.items.filter((item) => item && item.bundle) : []).map((item) => item.name);
		const scan = await scanActivation({
			profileDir: profileDir(),
			bundles,
			plugins: Array.isArray(plugins) ? plugins : null,
			inject: options.inject !== false
		});
		return {
			...scan,
			line: summarizeActivation(scan),
			findings: activationFindings(scan)
		};
	}

	/** R13：激活状态一行（状态工具用；不扫源码）。 */
	async activationLine() {
		try {
			const view = await this.activation({ inject: false });
			return summarizeActivation(view);
		} catch (e) {
			return "查不了（" + String((e && e.message) || e) + "）";
		}
	}

	async prune() {
		const { staging, snapshots } = this.dirs();
		const keep = await this.referencedStagingDirs();
		/* R11：**还在等确认的任务**，它的 `staging/<job.id>` 是「确认后继续」的唯一现场。
		   以前只按 24 小时清：一个「等待确认」的任务放一天多再点确认，解包现场已经没了，
		   用户看到的是「文件不在」—— 而他什么也没做错。现在按**任务是否还有后续动作**判：
		   非终态（queued / running / awaiting-confirm）一律不按时间清。 */
		const liveDirs = new Set(
			(this.jobs || [])
				.filter((job) => job && job.id && !["done", "failed", "rolled-back", "cancelled"].includes(job.status))
				.map((job) => job.id)
		);
		try {
			const entries = await import("node:fs/promises").then((m) => m.readdir(staging, { withFileTypes: true }));
			const cut = Date.now() - 24 * 60 * 60 * 1000;
			for (const entry of entries) {
				if (keep.has(entry.name) || keep.has("*") || liveDirs.has(entry.name)) continue;
				const full = join(staging, entry.name);
				try {
					const info = await stat(full);
					if (info.mtimeMs < cut) await rm(full, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
		await pruneSnapshots(snapshots, (this.settings && this.settings.snapshotKeep) || 40).catch(() => []);
	}

	/**
	 * 改设置（R6）。面板每改一项发一次补丁；返回整理后的完整设置。
	 * 写盘失败不抛 —— 设置写不进去不该让面板挂掉（内存里仍然生效）。
	 */
	async updateSettings(patch) {
		this.settings = mergeSettings(this.settings, patch);
		const saved = await saveSettings(this.settingsPath, this.settings);
		await this.log("settings " + JSON.stringify(this.settings) + " saved=" + saved);
		return this.settings;
	}

	/**
	 * 状态落盘。
	 *
	 * R9 修的一个真 bug（2026-10-22 实测撞出来的）：这里原来直接用固定的
	 * `state.json.tmp`，而 save() 会被**几条路同时调** —— 新任务的 execute()、
	 * action 响应里顺带跑的 snapshotState() → ensureReconciled()、以及人工动作。
	 * 两次 save 撞在同一个 tmp 上时，先完成的那次已经 rename 走了文件，后一次
	 * rename 报 `ENOENT: rename 'state.json.tmp' -> 'state.json'`，而那条错误会被
	 * execute() 的 catch 当成**安装失败**记在任务上（一个跟插件毫不相干的报错）。
	 * 修法三条，缺一不可：
	 *   ① **串行**：把并发的 save 排成一条队列（后一次看到的是最新内存态）；
	 *   ② **每次唯一 tmp 名**：HMR 重新 apply 会同时存在过两个 Installer 实例，
	 *      队列管不到另一个实例；
	 *   ③ **rename 撞 ENOENT 重试一次**：杀软/索引器偶尔短暂持有句柄。
	 */
	async save() {
		const run = () => this.writeStateFile();
		const next = (this._saveChain || Promise.resolve()).then(run, run);
		/* 队列本身不许把失败传下去（下一次 save 仍要能跑） */
		this._saveChain = next.then(() => undefined, () => undefined);
		return next;
	}

	async writeStateFile() {
		this.jobs = this.jobs.slice(0, 40);
		/* detectedFull 里带着整棵文件树（可能上万条路径）：只留在内存里给「确认后继续」用，
		   不落盘 —— 落盘会让 state.json 随包体积线性膨胀。 */
		const persisted = this.jobs.map((job) => {
			const { detectedFull, ...rest } = job;
			return rest;
		});
		const payload = JSON.stringify({ version: 1, jobs: persisted, dismissed: [...this._dismissed] }, null, 2);
		this._saveSeq = (this._saveSeq || 0) + 1;
		const tmp = this.statePath + "." + process.pid + "." + this._saveSeq + ".tmp";
		await writeFile(tmp, payload, "utf8");
		await renameWithRetry(tmp, this.statePath);
	}

	async log(line) {
		const file = join(this.dirs().logs, "install.log");
		try {
			await import("node:fs/promises").then((m) => m.appendFile(file, new Date().toISOString() + " " + line + "\n", "utf8"));
		} catch {
			/* ignore */
		}
	}

	/* ── 对外：状态 ─────────────────────────────────────────────────── */

	attention() {
		const jobs = this.jobs.filter((j) => !this._dismissed.has(j.id));
		const items = jobs.filter((j) => this.isAttention(j));
		const redDotOn = !this.settings || this.settings.redDot !== false;
		return {
			count: items.length,
			/* R6：红点可以关（设置里）。关掉只影响「看不看得见」，count/items 照常给 ——
			   面板会写成「N 条待处理（红点已关）」，工具也照样知道有事。 */
			dot: items.length > 0 && redDotOn,
			suppressed: items.length > 0 && !redDotOn,
			items: items.slice(0, 6).map((j) => ({
				id: j.id,
				status: j.status,
				title: j.title || (j.input && j.input.label) || j.id,
				reason: j.error
					? j.error.message
					: j.status === "awaiting-confirm"
						? "等你确认是否继续安装"
						: (j.diagnosis && j.diagnosis.findings && j.diagnosis.findings[0] && j.diagnosis.findings[0].title) || "需要看一眼"
			}))
		};
	}

	isAttention(job) {
		if (!ATTENTION_WORTHY.has(job.status)) {
			if (job.review && job.review.verdict === "malicious") return true;
			return false;
		}
		return true;
	}

	async snapshotState(extra = {}) {
		await this.ensureReconciled();
		const live = this.jobs.filter((j) => j.status === "running" || j.status === "awaiting-confirm");
		return {
			ok: true,
			at: nowIso(),
			attention: this.attention(),
			active: live.length > 0 ? this.compactJob(live[live.length - 1]) : null,
			jobs: this.jobs.slice(0, 12).map((j) => this.compactJob(j)),
			warnings: this.warnings || [],
			/* R6：面板要在同一份 state 里拿到设置，避免两套真值 */
			settings: this.settings || normalizeSettings({}),
			/* R26：批量升级队列（内存态，重启即空） */
			queue: this.queueView(),
			/* R27：换版本的卸载协作方（插件目录）—— 面板据此决定「升级」按钮可不可点 */
			collaborator: await this.collaboratorInfo(),
			host: await this.hostFacts(),
			...extra
		};
	}

	/**
	 * 上次进程在安装途中退出（本机实测：pnpm 写完 profile 之后宿主会重启），
	 * 重启后这里核对一次「其实装上了没有」，别把成功的安装永远显示成失败。
	 */
	async ensureReconciled() {
		if (this._reconciled) return;
		this._reconciled = true;
		const stuck = this.jobs.filter((j) => j.status === "failed" && j.error && j.error.code === "interrupted");
		if (stuck.length === 0) return;
		const pm = this.ctx.pluginManager;
		let bundles = null;
		try {
			bundles = pm && typeof pm.listBundles === "function" ? await pm.listBundles() : null;
		} catch {
			bundles = null;
		}
		let changed = false;
		for (const job of stuck) {
			const detected = job.detected || {};
			const name = detected.name;
			if (!name) continue;
			if (detected.kind === "bundle") {
				const found = Array.isArray(bundles) ? bundles.find((b) => b && (b.name === name || b.packageName === name)) : null;
				/* R27：换版本中断有三种现场，必须分开说 —— 以前一律「包名命中 = 装好了」，
				   而宿主对已存在的包名回 already-installed 是**正常返回**（R26.3 实证），
				   中断的升级会被回填成「已确认安装完成」，版本一个字都没变。 */
				const upgrade = job.upgrade || null;
				const wantVersion = detected.version || null;
				const installed = await installedPluginInfo(name).catch(() => null);
				const haveVersion = installed && installed.installed ? installed.version || null : null;
				if (!found) {
					/* ① 卸载成功、安装没开始（宿主在两步之间重启）→ 可以一键续跑 */
					if (upgrade && upgrade.phase === "removed" && upgrade.prepared && upgrade.prepared.spec) {
						upgrade.phase = "interrupted";
						upgrade.resumable = true;
						job.error = {
							code: "upgrade-interrupted",
							message: "宿主在「卸载旧版之后、安装新版之前」重启了 —— 这个插件现在是缺的",
							hint: "点「继续升级」装回 " + (upgrade.to || "新版") + "（包已备好，不用重新下载）",
							stage: "install"
						};
						setStage(job, "install", "fail", "卸载已生效，安装被宿主重启打断");
						changed = true;
					}
					continue;
				}
				/* ② 版本对不上 = 这次要的那一版没装上 */
				if (wantVersion && haveVersion && String(wantVersion) !== String(haveVersion)) {
					if (upgrade && String(upgrade.from || "") === String(haveVersion) && upgrade.prepared && upgrade.prepared.spec) {
						upgrade.phase = "interrupted";
						upgrade.resumable = true;
						job.error = {
							code: "upgrade-interrupted",
							message: "宿主在换版本途中重启：旧版 v" + haveVersion + " 还在，新版 v" + wantVersion + " 没装上",
							hint: "点「继续升级」装新版（包已备好）",
							stage: "replace"
						};
						setStage(job, "replace", "fail", "换版本被宿主重启打断，旧版还在");
					} else {
						job.error = {
							code: "upgrade-unverified",
							message: "宿主中途重启：清单里有 " + name + "，但版本是 v" + haveVersion + "，不是这次要的 v" + wantVersion,
							hint: "版本没变说明安装没完成 —— 重新提交一次，或看面板诊断",
							stage: "install"
						};
					}
					changed = true;
					continue;
				}
				job.status = "done";
				job.error = null;
				job.install = {
					...(job.install || {}),
					kind: "bundle",
					bundleName: name,
					/* R26：中断回填也要保留升级前的坐标 —— 否则这单的回滚会退化成「卸载」 */
					previousVersion: job.installedBefore ? job.installedBefore.version || null : null,
					previousSpec: job.installedBefore ? job.installedBefore.spec || null : null,
					previousTarball: job.vendorBackup || null,
					upgrade: Boolean(job.installedBefore && job.installedBefore.version && job.detected.version && job.installedBefore.version !== job.detected.version),
					ok: true,
					application: found.enabled === false ? "installed-disabled" : "applied",
					note: "宿主在这次安装中途重启；重启后插件清单里已经有它了（版本已核对）"
				};
				/* R27：两阶段换版本在安装途中被重启 → 版本已经核对过，收成 done */
				if (job.upgrade && (job.upgrade.phase === "removed" || job.upgrade.phase === "removing")) {
					job.upgrade.phase = "done";
					job.upgrade.doneAt = nowIso();
					job.upgrade.confirmedByRestart = true;
					job.notes = (job.notes || []).concat(["宿主在安装途中重启；重启后已核对版本 = " + (wantVersion || "?") + "，换版本算完成"]);
				}
				setStage(job, "install", "ok", "宿主中途重启，重启后已确认安装完成（版本 " + (haveVersion || "?") + "）");
				try {
					job.diagnosis = await diagnose({ pluginManager: pm, skills: this.ctx.skills, job });
					const v = job.diagnosis.verdict;
					await this.noteCatalogVerdict(job, job.diagnosis).catch(() => null);
					setStage(job, "diagnose", v === "ok" ? "ok" : v === "warn" ? "warn" : "fail",
						v === "ok" ? "一切正常" : (job.diagnosis.findings[0] && job.diagnosis.findings[0].title) || v);
					if (v === "error") {
						job.status = "failed";
						job.error = { code: "diagnose-error", message: (job.diagnosis.findings[0] && job.diagnosis.findings[0].title) || "诊断发现问题", hint: "可一键回滚" };
					}
				} catch {
					/* 诊断失败不影响「已安装」这个事实 */
				}
				changed = true;
			} else if (detected.kind === "skill") {
				const root = job.skillRoot || (await firstExistingDir(skillRoots()));
				const target = join(root, name);
				const exists = await stat(target).then((s) => s.isDirectory()).catch(() => false);
				if (!exists) continue;
				job.status = "done";
				job.error = null;
				job.install = { ...(job.install || {}), kind: "skill", skillName: name, skillDir: target, ok: true, note: "宿主中途重启，目录已在目标位置" };
				setStage(job, "install", "ok", "宿主中途重启，重启后目录已在目标位置");
				changed = true;
			}
		}
		if (changed) await this.save().catch(() => {});
	}

	/**
	 * 环境 + profile 体检（可选自动修复）。工具 install_hub_doctor 与面板「环境体检」都走这里。
	 * @param {{apply?: boolean, contract?: boolean}} [options] contract=false 可跳过已装插件的
	 *   output 契约扫描（每个第三方插件都要读文件，慢一点的机器上省几十毫秒到几秒）。
	 */
	async doctor({ apply = false, contract = true } = {}) {
		/* R6.1：装到一半时不许并发修 —— applyRepairs 会和 pnpm 抢同一批文件
		   （最坏的情况是在 pnpm 正写 @deepseek-ai/ 的那一刻去隔离它）。
		   只读体检（apply=false）不受影响，随时可跑。 */
		if (apply && this._running) {
			return {
				ok: false,
				busy: true,
				error: "已有一个安装任务在跑，等它结束（或先取消）再修",
				findings: [],
				actions: []
			};
		}
		const root = this.root;
		let advertisedUrl = null;
		try {
			const app = this.ctx.webApp;
			if (app && typeof app.getAdvertisedUrl === "function") advertisedUrl = app.getAdvertisedUrl();
		} catch {
			advertisedUrl = null;
		}
		const base = { profileDir: profileDir(), dataDir: root, advertisedUrl };
		const versions = await hostVersions().catch(() => ({}));
		const hostVersion = versions && typeof versions.dsh === "string" ? versions.dsh : null;
		const report = await inspectEnvironment(base);

		/* R8：把 profile 层的检查并进同一份体检（bundles 清单 / 已装插件的 output 契约 /
		   pnpm 钉子 / 最近一次崩溃日志）。一次调用说全，不用再去别的插件逐个查。
		   R13 再加两项：服务声明（inject）契约 + 「行开着但 fiberPhase 不是 active」（装了没激活）。 */
		const livePlugins = await (async () => {
			try {
				const pm = this.ctx.pluginManager;
				return pm && typeof pm.listPlugins === "function" ? await pm.listPlugins() : null;
			} catch {
				return null;
			}
		})();
		const profileHealth = await inspectProfile({
			profileDir: base.profileDir,
			hostVersion,
			dataDir: root,
			contract,
			plugins: livePlugins
		}).catch((e) => ({ findings: [], info: { error: String((e && e.message) || e) } }));
		report.findings = report.findings.concat(profileHealth.findings);
		report.info.profileHealth = profileHealth.info;
		/* R14：技能那一半也进体检 —— 「装了却用不上」本机真出现过，而它如果只藏在
		   面板的一张卡里，就等于只有打开面板的人才会知道。 */
		const skillView = await this.skills().catch(() => null);
		if (skillView) {
			report.findings = report.findings.concat(skillFindings(skillView));
			report.info.skills = skillView.counts;
		}
		/* R9：profile 里挂着的「待批准安装脚本」是跨任务残留 —— 不处理会挡住下一次装同一个依赖。
		   这里只报不说教：批准是信任决定，面板不替用户按（所以没有自动修复动作）。 */
		const buildPolicy = await readBuildPolicy(base.profileDir).catch(() => null);
		const buildFinding = pendingBuildFinding(buildPolicy);
		if (buildFinding) {
			report.findings.push(buildFinding);
			report.info.buildPolicy = { file: buildPolicy.file, pending: buildPolicy.pending, decided: buildPolicy.decided };
		}
		/* R31：pnpm 的供应链策略本身也可能是一个「装不上的原因」。
		   真实事故：trustPolicy: no-downgrade + 一个跟本次安装无关的传递依赖缺少可信发布者证据
		   → 整次安装被拒，而面板以前只能报「认不出失败原因」。
		   这里**只报不修**（放松策略是信任决定），但把「怎么只放开这一个」写清楚。 */
		const trustPolicy = await readPolicy(base.profileDir).catch(() => null);
		if (trustPolicy && trustPolicy.ok && trustPolicy.policy) {
			const recentTrust = (this.jobs || []).slice(0, 6).find((j) => j && j.install && j.install.failure && j.install.failure.kind === "trust-downgrade");
			report.info.trustPolicy = {
				policy: trustPolicy.policy,
				exclude: trustPolicy.exclude,
				ignoreAfter: trustPolicy.ignoreAfter,
				line: describePolicy(trustPolicy)
			};
			if (recentTrust) {
				const t = (recentTrust.install.failure && recentTrust.install.failure.trust) || null;
				report.findings.push({
					severity: "warn",
					title: "pnpm 的「可信度降级」策略挡过一次安装" + (t && t.entry ? "（被点名：" + t.entry + "）" : ""),
					detail: "最近一次受影响的任务：" + recentTrust.id + "。" + describePolicy(trustPolicy) +
						"。注意：被点名的那个包通常**不是**你要装的插件，而是别的插件的传递依赖 —— 换插件、重试都不会好。",
					plain: "大白话：这条策略保护你（防止一个包的旧版本被换成可疑的新版本），但它是一条「整次安装」的闸门 —— 一个包被拒，整棵树都不装。",
					fix: [
						{ text: t && t.entry ? "核对过那个包 → 面板的任务卡上点「豁免 " + t.entry + "」（写前备份、二次确认）" : "在任务卡上点「豁免这个版本」" },
						{ text: "不想放松策略：在 pnpm-workspace.yaml 的 overrides 里把它钉回有可信证据的旧版" },
						{ text: "本机目录插件：改用「直连安装（不走 pnpm）」，这条路完全不碰依赖树" }
					],
					action: t && t.entry ? { kind: "add-trust-exclude", entry: t.entry, label: "豁免 " + t.entry } : null
				});
			}
		}
		if (!apply) return report;
		const repaired = await applyRepairs({
			profileDir: profileDir(),
			dataDir: root,
			backupsRoot: join(root, "..", "..", ".tools", "backups"),
			findings: report.findings
		});
		const profileRepaired = await repairProfile({
			profileDir: base.profileDir,
			hostVersion,
			dataDir: root,
			findings: profileHealth.findings
		}).catch((e) => ({ actions: [{ kind: "profile", ok: false, error: String((e && e.message) || e) }] }));
		report.actions = repaired.actions.concat(profileRepaired.actions || []);
		const after = await inspectEnvironment(base);
		const afterProfile = await inspectProfile({
			profileDir: base.profileDir,
			hostVersion,
			dataDir: root,
			contract
		}).catch(() => ({ findings: [] }));
		report.findingsAfter = after.findings.concat(afterProfile.findings);
		if (report.actions.some((a) => a.ok && !a.skipped)) {
			this.warnings = (this.warnings || []).concat([{
				code: "doctor-repair",
				at: nowIso(),
				message: "环境体检修掉了 " + report.actions.filter((a) => a.ok && !a.skipped).length + " 项",
				origin: "doctor"
			}]).slice(-8);
		}
		return report;
	}

	/** pnpm 每次跑完都要查一次这个雷（见 lib/landmine.js）。 */
	async sweepLandmine(origin) {
		try {
			const result = await quarantineDshTools(profileDir(), join(this.root, "..", "..", ".tools", "backups"));
			if (result.moved) {
				this.warnings = (this.warnings || []).concat([{
					code: "dsh-tools-shadow",
					at: nowIso(),
					message: "pnpm 在 profile 里装了一份 @deepseek-ai/dsh-tools（会让下次启动插件批量加载失败），已挪到备份",
					from: result.from,
					to: result.to,
					origin
				}]).slice(-8);
				await this.log("landmine quarantined after " + origin + ": " + result.from + " -> " + result.to);
			}
			return result;
		} catch (e) {
			return { moved: false, error: String((e && e.message) || e) };
		}
	}

	async hostFacts() {
		const versions = await hostVersions();
		const build = await buildStamp().catch(() => null);
		return {
			profile: profileName(),
			profileDir: profileDir(),
			dsh: versions.dsh,
			dshTools: versions.dshTools,
			node: versions.node,
			/* R5.1：宿主侧代码不热重载 —— 这个标签是「跑的是哪一版」的唯一答案 */
			build: build ? build.label : null,
			buildDetail: build,
			skillRoots: skillRoots(),
			dataDir: this.root
		};
	}

	compactJob(job) {
		if (!job) return null;
		return {
			id: job.id,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			title: job.title,
			status: job.status,
			input: job.input ? { raw: job.input.raw, kind: job.input.kind, label: job.input.label } : null,
			stages: job.stages,
			detected: job.detected || null,
			precheck: job.precheck || null,
			install: job.install || null,
			/* R9：这条任务带着「已批准的构建脚本」时，面板要能显示出来（事后回看也知道批过什么） */
			buildApproval: job.buildApproval || null,
			notes: Array.isArray(job.notes) ? job.notes.slice(-6) : null,
			/* R27：换版本（两阶段）—— 面板要能显示「从 X 到 Y、卸载由谁做、中断后能不能续」 */
			replacement: job.replacement || null,
			collaborator: compactCollaborator(job.collaborator),
			upgrade: job.upgrade || null,
			snapshot: job.snapshot ? { id: job.snapshot.id, dir: job.snapshot.dir } : null,
			diagnosis: job.diagnosis || null,
			review: job.review || null,
			/* R6：这次是不是用户主动跳过审核（面板要显示出来，别让人以为是审过了） */
			reviewSkipped: Boolean(job.reviewSkipped),
			error: job.error || null,
			rollback: job.rollback || null,
			ack: this._dismissed.has(job.id) || !this.isAttention(job)
		};
	}

	jobById(id) {
		return this.jobs.find((j) => j.id === id) || null;
	}

	/* ── 对外：批量升级队列（R26）──────────────────────────────────── */

	/**
	 * 把「可升级的 npm 包」排进队列，串行安装。
	 *
	 * 只排队能自动升的那一类：npm 来源 + 已落地 + 有明确 latest。
	 * 本地包（file:）不排队 —— installPlugin 需要重新打包 payload，队列里拿不到；
	 * git/link 来源本来就不给「升级」按钮（同 spec 会被宿主判 already-installed）。
	 *
	 * R26.1：跨大版本 / 0.x 小版本（`gap.severe`）默认**不排**，单独回在 `needsAttention` 里；
	 * 用户在面板上二次确认后带 `includeRisky:true` 再来一次。
	 */
	async upgradeOutdated(options = {}) {
		/* R27：批量升级 = 一连串「先卸后装」。卸载方（插件目录）不在就没法开始 ——
		   现在就把原因说清楚，而不是排一队必然 already-installed 的无效任务。 */
		const collaborator = await this.collaboratorInfo(true);
		if (!collaborator || collaborator.ok !== true) {
			return {
				ok: false,
				code: "needs-collaborator",
				needsCollaborator: true,
				error: "批量升级需要「插件目录」卸载旧版，但它当前不可用" + (collaborator && collaborator.reason ? "：" + collaborator.reason : ""),
				collaborator,
				queued: [],
				skipped: [],
				needsAttention: [],
				queue: this.queueView()
			};
		}
		const cached = this._updates && this._updatesAt && Date.now() - this._updatesAt < 30 * 60 * 1000;
		let items = cached && this._inventory ? mergeUpdates(this._inventory.items, this._updates) : null;
		let fresh = false;
		if (!items) {
			const checked = await this.checkUpdates();
			items = checked.items;
			fresh = true;
		}
		const { safe, risky } = splitUpgradeTargets(items);
		const chosen = options.includeRisky ? safe.concat(risky) : safe;
		const queued = [];
		const skipped = [];
		for (const entry of chosen) {
			/* 这两个包不能由协作方卸自己（一个是本插件、一个是卸载方自己） */
			if (entry.name === SELF_PACKAGE) {
				skipped.push({ name: entry.name, reason: "「插件安装」不能换自己的版本（会把正在执行的自己卸掉）—— 用官方插件管理器" });
				continue;
			}
			if (entry.name === "dsh-plugin-catalog") {
				skipped.push({ name: entry.name, reason: "「插件目录」不能卸载自己 —— 用官方插件管理器升级它，再回来升别的" });
				continue;
			}
			const raw = "npm:" + entry.registryName + "@" + entry.to;
			/* 人已经对这个批量动作点过头（面板的确认框写明了"会先卸载再装"） */
			const res = this.enqueue(raw, entry.name, { replaceApproved: true });
			if (res.added) queued.push({ name: entry.name, raw, from: entry.from, to: entry.to });
			else skipped.push({ name: entry.name, reason: res.reason });
		}
		const started = await this._drainQueue();
		return {
			ok: true,
			queued,
			skipped,
			started,
			checked: fresh,
			queue: this.queueView(),
			/* 没被一起排队的「跨版本」条目：面板据此弹第二次确认 */
			needsAttention: options.includeRisky ? [] : risky
		};
	}

	/** 往队列里加一条（去重：同一个 spec 不排两次；已经在跑同一条也算占用）。 */
	enqueue(raw, name, opts = {}) {
		const text = String(raw || "").trim();
		if (!text) return { added: false, reason: "空输入" };
		if (!Array.isArray(this._queue)) this._queue = [];
		if ((this.jobs || []).some((j) => j.status === "running" && j.input && j.input.raw === text)) {
			return { added: false, reason: "已经在跑同一个" };
		}
		if (this._queue.some((item) => item.raw === text)) return { added: false, reason: "已经在队列里" };
		this._queue.push({ raw: text, name: name || null, addedAt: nowIso(), replaceApproved: opts.replaceApproved === true });
		return { added: true };
	}

	/** 面板要展示的队列（/state 每 2.5 秒取一次，只给摘要）。 */
	queueView() {
		const list = Array.isArray(this._queue) ? this._queue : [];
		return {
			count: list.length,
			items: list.slice(0, 20).map((item) => ({ name: item.name, raw: item.raw, addedAt: item.addedAt }))
		};
	}

	async clearQueue() {
		const count = Array.isArray(this._queue) ? this._queue.length : 0;
		this._queue = [];
		return { ok: true, cleared: count };
	}

	/**
	 * 队列是**内存态**：宿主重启后不续跑。理由和「等待确认不动手」一致 ——
	 * 批量安装是有后果的动作，不能变成一开机就在没人看着的时候自动跑。
	 * 正在等用户确认时也不往下走（一次只跑一单，否则两个 pnpm 会互相踩）。
	 */
	async _drainQueue() {
		if (this._running) return { started: false, reason: "busy" };
		if ((this.jobs || []).some((j) => j.status === "awaiting-confirm")) return { started: false, reason: "awaiting-confirm" };
		const list = Array.isArray(this._queue) ? this._queue : [];
		const next = list.shift();
		if (!next) return { started: false, reason: "empty" };
		const res = await this.submit(next.raw, { source: "upgrade-queue", replaceApproved: next.replaceApproved === true });
		if (!res || res.ok !== true) {
			await this.log("queue: 跳过 " + next.raw + "（" + ((res && (res.reason || res.message)) || "submit 失败") + "）");
			/* 一条坏 spec 不许把整条队列卡死：记日志，继续下一条 */
			return this._drainQueue();
		}
		return { started: true, jobId: res.job && res.job.id, raw: next.raw, remaining: list.length };
	}

	/* ── 对外：提交 ─────────────────────────────────────────────────── */

	/**
	 * @param {string} raw
	 * @param {object} [opts] {source: 'panel'|'tool'|'ai', path?: string, buildApproval?: string[], fromJob?: string}
	 */
	async submit(raw, opts = {}) {
		const text = String(raw ?? "").trim();
		if (!text) return { ok: false, reason: "empty", message: "输入是空的" };
		if (this._running) {
			return { ok: false, reason: "busy", message: "已经有一个安装任务在跑，等它结束（或先取消）" };
		}
		const desc = classifyInput(text);
		if (desc.kind === "empty" || desc.kind === "unrecognized") {
			return { ok: false, reason: "unrecognized", message: desc.label || "认不出这是什么" };
		}
		if (desc.kind === "netdisk") {
			return {
				ok: false,
				reason: "netdisk",
				message: "网盘链接不自动下载（登录态/风控都不是面板能处理的）。请手动下载后把文件拖进面板，或填写本机绝对路径。",
				provider: desc.provider
			};
		}
		if (desc.kind === "name") {
			const found = await this.search(desc.name);
			return { ok: false, reason: "name", message: "只给了名字，先搜索：", candidates: found };
		}
		if (desc.kind === "web-page" || desc.kind === "github-page" || desc.kind === "unknown-github-file") {
			return { ok: false, reason: "not-archive", message: desc.hint || "这个链接不是仓库/Release/压缩包直链" };
		}
		if (desc.kind === "local-path") {
			const info = await stat(desc.path).catch(() => null);
			if (!info) return { ok: false, reason: "not-found", message: "本机找不到这个路径：" + desc.path };
			if (!info.isDirectory() && !info.isFile()) return { ok: false, reason: "unsupported", message: "这个路径不是普通文件或目录" };
		}

		const job = {
			id: newJobId(),
			createdAt: nowIso(),
			updatedAt: nowIso(),
			status: "running",
			title: desc.label || text.slice(0, 80),
			input: { raw: text, kind: desc.kind, label: desc.label, desc, source: opts.source || "panel" },
			stages: freshStages(),
			detected: null,
			precheck: null,
			install: null,
			snapshot: null,
			diagnosis: null,
			review: null,
			error: null,
			rollback: null
		};
		/* R27：批量升级里人已经对「先卸后装」点过头 → 这一单不再停下来问一次。
		   单条「升级」不带这个标记：预检会强制停下来，确认卡会写清"会先卸载旧版"。 */
		if (opts.replaceApproved === true) job.replaceApproved = true;
		/* R9：批准过的构建脚本随新任务走（面板「允许并重试」用法） */
		const approved = (Array.isArray(opts.buildApproval) ? opts.buildApproval : []).map(String).filter(Boolean);
		if (approved.length > 0) {
			job.buildApproval = { names: approved, at: nowIso(), fromJob: opts.fromJob || null };
			job.notes = ["已批准安装脚本：" + approved.join("、") + "（宿主在装之前会写进 profile 的 allowBuilds）"];
		}
		this.jobs.unshift(job);
		this.activeId = job.id;
		await this.save();
		/* 不 await：面板立刻拿到 job 并开始轮询 */
		this._running = this.execute(job).finally(() => {
			this._running = null;
			/* R26：这一单真正结束（不是「等确认」）之后，队列里的下一单接着跑 */
			this._drainQueue().catch(() => {});
		});
		return { ok: true, job: this.compactJob(job) };
	}

	async search(query) {
		/* R3：从「npm + 一条 GitHub 查询」扩成多源（npm 两串 / GitHub 两串 / topic 发现），
		   并且每条命中都带 trust（官方/许可证/源码/红旗）与 popularity（下载量、stars、本机评分）。
		   R12：再补一条 `installed` —— 「这个我已经装了（v0.1.0）」。
		   没有它，搜索卡片看起来永远像「还没装」，用户会重复提交同一个包。 */
		const found = await searchAll(query, { limit: 12, sources: (this.settings && this.settings.sources) || null });
		const inv = await this.inventory().catch(() => null);
		/* R23：影子包警戒 —— 名字撞了官方 @deepseek-ai/* 的同名包（未加作用域或别的作者），
		   在卡片上直接标红，别让人把「看起来像官方」当成官方。判据只认本机真实存在的官方名。 */
		const official = await officialBasenames(profileDir()).catch(() => null);
		const items = annotateShadows(annotateInstalled(found.items.map((item) => ({
			source: item.source,
			name: item.name,
			version: item.version,
			description: item.description,
			stars: item.stars,
			downloads: item.downloads,
			updatedAt: item.updatedAt,
			spec: item.spec,
			url: item.url,
			/* R25：仓库地址要带出去 —— 面板要判「同名的是不是同一个来源」 */
			repoUrl: item.repoUrl || null,
			trust: item.trust,
			popularity: item.popularity,
			rankScore: item.rankScore
		})), inv), official);
		/* R25：搜的要是本机自己写的插件，六个源都不会有它 —— 别让人对着 6 条不相干的结果发呆 */
		return {
			items,
			localOnly: localOnlyHint(inv, query, items),
			providers: found.providers,
			errors: found.errors
		};
	}

	/* ── 对外：动作 ─────────────────────────────────────────────────── */

	async confirm(id) {
		const job = this.jobById(id);
		if (!job || job.status !== "awaiting-confirm") {
			return { ok: false, message: "这个任务不在等待确认状态" };
		}
		job.status = "running";
		setStage(job, "confirm", "ok", "用户确认继续");
		await this.save();
		this._running = this.afterConfirm(job).finally(() => {
			this._running = null;
			this._drainQueue().catch(() => {});
		});
		return { ok: true };
	}

	/**
	 * 跳过审核直接装（R6）。只在「等待确认」可用，且受设置 `skipReview` 控制。
	 *
	 * 语义（用户原话）：**按钮的本质是提供一个选择，而不是替用户做决定** ——
	 * 所以面板上先弹二次确认、把风险原文再摆一次；这里只负责执行与留痕：
	 * `job.reviewSkipped = true`、`job.review.status = "skipped"`、
	 * 阶段明细写「用户跳过审核，直接安装」，事后回看时一眼知道这次没审。
	 */
	async skipReview(id) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (this.settings && this.settings.skipReview === false) {
			return { ok: false, message: "设置在关闭了「跳过审核」按钮（设置 → 审核）" };
		}
		if (job.status !== "awaiting-confirm") {
			return { ok: false, message: "只有「等待确认」的任务可以跳过审核" };
		}
		job.reviewSkipped = true;
		job.review = {
			status: "skipped",
			verdict: "inconclusive",
			at: nowIso(),
			findings: [],
			note: "你选了「跳过审核，直接安装」—— 这次没有调用模型，也没有花 token",
			skipReason: "用户跳过审核"
		};
		setStage(job, "confirm", "ok", "用户跳过审核，直接安装");
		job.status = "running";
		await this.save();
		await this.log("skip-review " + job.id);
		this._running = this.afterConfirm(job).finally(() => {
			this._running = null;
			this._drainQueue().catch(() => {});
		});
		return { ok: true, skipped: "review", job: this.compactJob(job) };
	}

	async cancel(id) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (job.status === "awaiting-confirm") {
			job.status = "cancelled";
			setStage(job, "confirm", "skip", "用户取消");
			await rm(join(this.dirs().staging, job.id), { recursive: true, force: true }).catch(() => {});
			await this.save();
			/* 取消掉等确认的这一单之后，队列可以继续（它刚才被 awaiting-confirm 挡住） */
			this._drainQueue().catch(() => {});
			return { ok: true, cancelled: "awaiting-confirm" };
		}
		if (job.status === "running") {
			job.cancelRequested = true;
			/* 解包/下载这类循环靠 cancelRequested 尽快收手；已在 pnpm 里跑的那一步不强杀 */
			return { ok: true, cancelled: "requested" };
		}
		return { ok: false, message: "任务已经结束了" };
	}

	/**
	 * 重新跑一次安装后诊断。用于：诊断器自己修好了（比如重复 id 的判据变精确）、
	 * 用户手动改过 profile、或者单纯想再看一眼现在到底怎么样。
	 */
	/**
	 * R28：装完找「插件目录」核对一次 —— 它手里有 loadState / bundles / 依赖行，
	 * 能回答安装器自己答不了的那半句：「装上了，但会不会被加载」。
	 * ★ 可选能力：协作方旧 api（没有 inspect）或不在，就**安静跳过**，不影响任务结论。
	 */
	async crossCheckCatalog(job) {
		let provider = null;
		try {
			provider = pickRemovalProvider(this.ctx);
		} catch {
			provider = null;
		}
		if (!provider || provider.ok !== true) {
			job.catalogVerdict = { available: false, reason: provider && provider.reason ? provider.reason : "没有可用的「插件目录」" };
			return null;
		}
		if (!provider.features || provider.features.inspect !== true) {
			job.catalogVerdict = { available: false, degraded: true, reason: "「插件目录」是旧契约（api " + provider.api + "），装完核对跳过" };
			return null;
		}
		const name =
			(job.install && (job.install.bundleName || job.install.skillName)) ||
			(job.detected && job.detected.payload && job.detected.payload.manifest && job.detected.payload.manifest.name) ||
			"";
		if (!name) return null;
		try {
			const verdict = await provider.removal.inspect({ name });
			job.catalogVerdict = { available: true, name, ...verdict };
			return verdict;
		} catch (error) {
			job.catalogVerdict = { available: true, name, code: "inspect-threw", ok: false, text: String((error && error.message) || error) };
			return null;
		}
	}

	/** 把「插件目录」的判断并进诊断结论：装上了却不会被加载 = 必须说出来的 warn。 */
	async noteCatalogVerdict(job, diagnosis) {
		const verdict = await this.crossCheckCatalog(job);
		if (!verdict || verdict.ok === true || !Array.isArray(diagnosis && diagnosis.findings)) return verdict;
		const warnings = Array.isArray(verdict.warnings) ? verdict.warnings.map((item) => item.text).filter(Boolean) : [];
		diagnosis.findings.push({
			severity: "warn",
			title: "装上了，但「插件目录」判定它不会被加载",
			detail: verdict.text + (warnings.length ? "；" + warnings.slice(0, 3).join("；") : ""),
			plain: "大白话：文件进了 profile，但入口（dsh.profile.bundles）没写回 —— 重启后你在插件列表里看不到它。",
			fix: [{ text: "把 " + ((job.install && job.install.bundleName) || verdict.name || "这个包") + " 写回 dsh.profile.bundles（或在官方插件页点「启用」），再重启 DSH" }],
			action: null,
		});
		if (diagnosis.verdict === "ok") diagnosis.verdict = "warn";
		return verdict;
	}

	async rediagnose(id) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (!job.detected) return { ok: false, message: "这个任务还没有识别结果，没什么可诊断的" };
		setStage(job, "diagnose", "running", "重新诊断…");
		let diagnosis;
		try {
			diagnosis = await diagnose({ pluginManager: this.ctx.pluginManager, skills: this.ctx.skills, job });
		} catch (e) {
			setStage(job, "diagnose", "warn", "诊断失败");
			return { ok: false, message: String((e && e.message) || e) };
		}
		job.diagnosis = diagnosis;
		const v = diagnosis.verdict;
		await this.noteCatalogVerdict(job, diagnosis).catch(() => null);
		setStage(job, "diagnose", v === "ok" ? "ok" : v === "warn" ? "warn" : "fail",
			v === "ok" ? "一切正常" : (diagnosis.findings[0] && diagnosis.findings[0].title) || v);
		if (v !== "error" && job.error && job.error.code === "diagnose-error") job.error = null;
		await this.save();
		return { ok: true, job: this.compactJob(job) };
	}

	async ack(id) {		if (id) this._dismissed.add(id);
		else {
			for (const job of this.jobs) if (this.isAttention(job)) this._dismissed.add(job.id);
		}
		await this.save();
		return { ok: true, attention: this.attention() };
	}

	/**
	 * R30：清历史 —— 只清**终态**（done / failed / cancelled / rolled-back）。
	 *
	 * 为什么做成宿主方法而不是让人手改 `data/state.json`：`jobs` 活在内存里，手改文件会被
	 * 下一次 `save()` 原样写回（而且随时可能覆盖刚改好的那份）。判据也只有一处：
	 * 进行中 / 等待确认的一律保留 —— 清掉它们等于把正在跑的现场连同解包目录一起弄丢。
	 *
	 * 清掉的 id 同时进 `_dismissed`：否则残留的「待处理」还会因为老任务再冒一次红点。
	 */
	async clearHistory() {
		const plan = historyDropPlan(this.jobs);
		const dropped = plan.dropped;
		if (dropped.length === 0) return { ok: true, removed: 0, kept: this.jobs.length, at: nowIso() };
		const dropIds = new Set(dropped.map((job) => job.id));
		this.jobs = this.jobs.filter((job) => !dropIds.has(job.id));
		for (const job of dropped) this._dismissed.add(job.id);
		await this.save();
		/* 老任务的 staging 目录此时不再被 liveDirs 保护 —— 顺手清掉，别让 data/ 无限长 */
		await this.prune().catch(() => null);
		await this.log("clear-history removed " + dropped.length + " (kept " + this.jobs.length + ")");
		return {
			ok: true,
			removed: dropped.length,
			kept: this.jobs.length,
			byStatus: plan.byStatus,
			samples: dropped.slice(0, 5).map((job) => job.title || (job.input && job.input.raw) || job.id),
			at: nowIso()
		};
	}

	/**
	 * R9：批准「待决定的安装脚本」并重试安装。
	 *
	 * 语义与「跳过审核」同一条纪律：**按钮提供选择，不替用户决定** ——
	 * 面板上必须先摆出确切包名与风险原文、再经二次确认；这里只做两件确定性的事：
	 *  ① 用**当前** profile 的 allowBuilds（宿主写在 pnpm-workspace.yaml 里的哨兵）复核名单，
	 *     名单里没有的包直接拒绝 —— 不给用户「点一下顺手放大权限」的机会；
	 *  ② 开一条新任务带 `buildApproval` 重跑全流程（重新解包 → 重新预检 → 装）。
	 *     不原地续跑：旧任务的解包现场按设计已经清掉了，硬续会得到假的「文件都在」。
	 *
	 * 为什么不自己改 yaml：宿主在 `installBundle(spec, { approvedBuilds })` 里做这件事，
	 * 它会先写 allowBuilds=true、再跑 pnpm、名单过期时抛 stale-approval。我们只递意图。
	 */
	async approveBuilds(id, names) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (this._running) return { ok: false, message: "已经有安装任务在跑，等它结束（或先取消）再说" };
		const list = (Array.isArray(names) ? names : []).map(String).map((s) => s.trim()).filter(Boolean);
		if (list.length === 0) return { ok: false, message: "没给要允许的包名" };
		const policy = await readBuildPolicy(profileDir());
		if (!policy.ok) {
			return {
				ok: false,
				message: "读不到 profile 的 pnpm-workspace.yaml（" + (policy.error || "未知原因") +
					"）。先点「重新诊断」确认现状；profile 目录都读不到时，重启 DSH 再看一次。",
				policyMissing: true
			};
		}
		const pending = new Set(policy.pending);
		const stale = list.filter((name) => !pending.has(name));
		if (stale.length > 0) {
			return {
				ok: false,
				message: "这些包已经不在「待批准」列表里：" + stale.join("、") + "（可能已被处理或回滚过，点「重新诊断」看现状）",
				stale
			};
		}
		/* 上传进来的文件在 data/staging/uploads 下，可能已被清理 —— 先说实话，别让它变成一次
		   看不懂的「not-found」任务。两条「授权后重试」的路（安装脚本批准 / 版本豁免）共用它。 */
		const missing = await this.missingLocalInput(job);
		if (missing) return { ok: false, message: missing };
		job.install = Object.assign({}, job.install, {
			buildApproval: { at: nowIso(), names: list }
		});
		job.notes = (job.notes || []).concat(["你批准了这些包的安装脚本：" + list.join("、") + "（随后开了一条新任务重试）"]);
		await this.save();
		await this.log("approve-builds " + id + " " + list.join(","));
		const retry = await this.submit(job.input.raw, { source: "panel", buildApproval: list, fromJob: id });
		if (!retry.ok) {
			return { ok: false, message: "批准已记录，但重试没能提交：" + (retry.message || retry.reason || "未知原因") };
		}
		if (job.status === "failed") {
			/* 旧任务留痕但不继续占红点：新任务会自己决定结果 */
			job.notes = (job.notes || []).concat(["已由新任务重试：" + retry.job.id]);
			await this.save();
		}
		return { ok: true, approved: list, retry: retry.job };
	}

	/**
	 * 「授权后重试」两条路共用的前置检查：本地输入还在不在。
	 * @returns {Promise<string|null>} 不在时返回一句人话（直接显示给用户），在的话 null。
	 */
	async missingLocalInput(job) {
		if (!job || !job.input || job.input.kind !== "local-path") return null;
		const path = job.input.desc && job.input.desc.path ? job.input.desc.path : job.input.raw;
		const exists = await stat(path).then(() => true).catch(() => false);
		if (exists) return null;
		return "原来的文件已经不在原处了（临时区被清理过）。请重新拖一次文件装，再走一次授权。";
	}

	/**
	 * R10：给「版本不兼容」开**精确版本豁免**，然后开新任务重试。
	 *
	 * 纪律与 approve-builds 一致：目标由服务端从这条任务的预检结论里取
	 * （`exemptionTarget(job.precheck.compat)`）—— 客户端只能点「同意」，不能自带包名/版本，
	 * 所以这个动作不可能被用来「预先放宽一个本来兼容的包」。授权走宿主接口
	 * `pluginManager.setVersionExemption(...)`，记录由宿主写进 profile 的
	 * `compatibility.json`（留痕在宿主那份文件里，不是我们自己的状态）。
	 */
	async exemptVersion(id) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (this._running) return { ok: false, message: "已经有安装任务在跑，等它结束（或先取消）再说" };
		const compat = (job.precheck && job.precheck.compat) || {};
		const target = exemptionTarget(compat);
		if (!target) {
			if (compat.exempted) {
				return { ok: false, message: "这个版本已经开过豁免了（" + (compat.exemption && compat.exemption.key ? compat.exemption.key : "见 compatibility.json") + "），直接点重试安装就行", already: true };
			}
			return { ok: false, message: "这条任务不是卡在版本兼容上（当前判据：" + (compat.verdict || "没有预检结论") + "），开豁免解决不了它", wrongReason: true };
		}
		const missing = await this.missingLocalInput(job);
		if (missing) return { ok: false, message: missing };
		const granted = await grantExemption({ pluginManager: this.ctx.pluginManager, target, acceptRisk: true });
		if (!granted.ok) return { ok: false, message: granted.message, error: granted.error, target };
		job.install = Object.assign({}, job.install, {
			versionExemption: Object.assign({ at: nowIso() }, granted.granted, { verified: granted.verified !== false })
		});
		job.notes = (job.notes || []).concat(["你为 " + target.packageVersion + " 开了精确版本豁免（DSH " + target.runtimeVersion + "）" +
			(granted.verified === false ? "，但宿主回读没看到这条记录" : "，宿主已确认")]);
		await this.save();
		await this.log("exempt-version " + id + " " + target.packageVersion + " dsh=" + target.runtimeVersion);
		if (granted.verified === false) {
			return {
				ok: false,
				message: "宿主没有确认写入豁免记录（回读不到 " + target.packageVersion + "）。先点「重新诊断」看现状；如果 compatibility.json 被别的工具写坏了，需要人工修（宿主会拒绝改写坏文件）。",
				target,
				verified: false
			};
		}
		const retry = await this.submit(job.input.raw, { source: "panel", fromJob: id });
		if (!retry.ok) {
			return { ok: true, granted: granted.granted, verified: true, message: "豁免已写入，但重试没能提交：" + (retry.message || retry.reason || "未知原因") };
		}
		if (job.status === "failed") {
			job.notes = (job.notes || []).concat(["已由新任务重试：" + retry.job.id]);
			await this.save();
		}
		return { ok: true, granted: granted.granted, verified: true, retry: retry.job };
	}

	/**
	 * 回滚里「换回旧版」的前置卸载（R27）。与升级共用同一个协作方，但**不写 job.upgrade**
	 * —— 回滚是一次独立动作，不该覆盖升级现场（否则中断续跑会读到错的阶段）。
	 */
	async removeForRollback(job, name) {
		const provider = await describeRemovalProvider(this.ctx);
		if (!provider.ok) return { ok: false, code: "needs-collaborator", error: provider.reason || "卸载协作方不可用", fix: provider.fix || [] };
		const requestedBy = "rollback:" + ((job && job.id) || "?");
		let planned = null;
		try {
			planned = await provider.removal.plan({ name, purpose: "replace", requestedBy });
		} catch (error) {
			return { ok: false, code: "plan-threw", error: String((error && error.message) || error) };
		}
		if (!planned || planned.ok !== true || !planned.token) {
			const blockers = (planned && planned.blockers) || [];
			return { ok: false, code: "collaborator-blocked", error: (planned && (planned.error || planned.text)) || "计划被拒", blockers, fix: blockers.map((b) => ({ text: b.text })) };
		}
		let applied = null;
		try {
			applied = await provider.removal.apply({ token: planned.token, confirm: true, requestedBy });
		} catch (error) {
			return { ok: false, code: "apply-threw", error: String((error && error.message) || error) };
		}
		return applied && applied.ok
			? { ok: true, application: applied.application || "", from: applied.from || null }
			: { ok: false, code: (applied && applied.code) || "remove-failed", error: (applied && applied.error) || "卸载失败" };
	}

	async rollback(id) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (!job.snapshot || !job.snapshot.dir) return { ok: false, message: "这个任务没有快照，无法自动回滚" };
		const results = [];
		const install = job.install || {};
		if (install.skillName) {
			const restored = await restoreSkill(job.snapshot.dir, job.skillRoot || (await firstExistingDir(skillRoots())), install.skillName)
				.catch((e) => ({ restored: false, reason: String((e && e.message) || e) }));
			results.push({ step: "回滚技能 " + install.skillName, ...restored });
		}
		/* R26：**升级的回滚 = 装回旧版**，不是卸载。
		   以前无论升级还是全新安装都走 removeBundle，一次 0.6.24 → 0.6.33 的升级点「回滚」
		   会把插件整个删掉 —— 声明还原了，包里却没东西，宿主下次启动就少一个插件。 */
		const plan = install.bundleName ? rollbackPlan(install) : { mode: "none" };
		/* R31：直连安装的回滚。
		   · `link-already`：这次什么都没改 → 无需回滚（说清楚，别让人对着「回滚」按钮猜）；
		   · `link`：撤掉依赖行与清单项、删掉**指向这个目录的**链接，再还原 profile 三件套兜底。 */
		if (install.mode === "link" || install.mode === "link-already") {
			if (install.mode === "link") {
				const undone = await undoLinkInstall({
					profileDir: profileDir(),
					name: install.bundleName,
					sourceDir: (install.spec || "").replace(/^link:/i, "")
				}).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
				results.push({
					step: "撤掉直连安装 " + install.bundleName,
					ok: undone.ok === true,
					removed: undone.removed || [],
					...(undone.ok ? {} : { reason: undone.error || "撤销失败" })
				});
			} else {
				results.push({ step: "无需回滚", ok: true, note: "这次没有改动 profile（它本来就是直连安装的）" });
			}
			const files = await restoreProfileFiles(job.snapshot.dir, profileDir()).catch((e) => ({ changed: [], skipped: [String((e && e.message) || e)] }));
			results.push({ step: "还原 profile 三件套（兜底）", ...files });
			job.rollback = { done: true, at: nowIso(), plan: "link", results };
			if (job.error) {
				results.push({ step: "回滚前的错误（留痕）", was: job.error.code, message: job.error.message });
				job.error = null;
			}
			job.status = "rolled-back";
			setStage(job, "install", "skip", install.mode === "link" ? "已回滚（撤掉直连安装）" : "已回滚（本次没有改动）");
			job.diagnosis = null;
			await this.save();
			await this.log("rollback link " + id + " " + JSON.stringify(results).slice(0, 600));
			return { ok: true, rollback: job.rollback, job: this.compactJob(job) };
		}
		if (plan.mode === "reinstall-npm" || plan.mode === "reinstall-file") {
			let spec = plan.spec || plan.path || null;
			if (plan.mode === "reinstall-file") {
				const back = await restoreVendorTarball(plan.tarball).catch((e) => ({ restored: false, reason: String((e && e.message) || e) }));
				results.push({ step: "还原旧包 " + (plan.path ? basename(plan.path) : ""), ...back });
				spec = plan.path;
			}
			/* R27：换回旧版也是**换版本** —— 宿主按包名判已装，不先卸掉现在这版就只会回
			   already-installed（正常返回）。以前这里不看回执，一律记 ok，于是面板说
			   「已装回旧版 vX ✓」而 node_modules 里还是新版（独立审计的 P0-1）。 */
			const name = install.bundleName;
			const want = plan.version || null;
			const now = await installedPluginInfo(name).catch(() => null);
			const current = now && now.installed ? now.version || null : null;
			const needRemove = Boolean(current && want && String(current) !== String(want));
			let removal = null;
			if (needRemove) {
				removal = await this.removeForRollback(job, name);
				results.push({
					step: "先卸载现在的 v" + (current || "?") + "（换回 v" + (want || "?") + " 必须先卸）",
					ok: removal.ok === true,
					...(removal.ok ? { application: removal.application || "" } : { reason: removal.error || removal.code || "卸载失败", fix: removal.fix || [] })
				});
			}
			if (!spec) {
				results.push({ step: "装回旧版 " + name, ok: false, reason: "快照里没有旧包/旧版本号，装不回去" });
			} else if (needRemove && !(removal && removal.ok)) {
				results.push({ step: "装回旧版 " + name + (want ? " v" + want : ""), ok: false, reason: "旧版要先卸掉现在这版才能装（没有卸载就无法换版本）" });
			} else {
				try {
					const result = await installPlugin({
						pluginManager: this.ctx.pluginManager,
						detected: { payload: { manifest: { name, version: want } } },
						source: { type: plan.mode === "reinstall-npm" ? "npm" : "local" },
						prepared: { spec }
					});
					/* 判据只看 node_modules 里的**版本**：宿主回 applied 也可能是空转 */
					const after = await installedPluginInfo(name).catch(() => null);
					const got = after && after.installed ? after.version || null : null;
					const verified = want ? String(got) === String(want) : Boolean(result.ok || result.noop);
					results.push({
						step: "装回旧版 " + name + (want ? " v" + want : ""),
						ok: verified,
						spec,
						application: result.application || "",
						version: got,
						...(verified ? {} : { reason: result.failure ? result.failure.title || result.failure.plain || "安装失败" : "装完版本是 " + (got || "?") + "，不是 " + (want || "?") })
					});
				} catch (e) {
					results.push({ step: "装回旧版 " + name, ok: false, reason: String((e && e.message) || e) });
				}
			}
		} else if (plan.mode === "restore-only") {
			/* link:/git 来源不卸也不重装：那是人的开发目录/远端仓库，宿主要按声明自行重建 */
			results.push({
				step: "还原声明 " + install.bundleName,
				ok: true,
				note: "这个插件来自 " + (plan.spec || "").split(":")[0] + " 来源，回滚不卸载、也不重装（避免动到你的开发目录）；按需由宿主按声明重建"
			});
		} else if (install.bundleName) {
			try {
				const pm = this.ctx.pluginManager;
				if (pm && typeof pm.removeBundle === "function") {
					const res = await pm.removeBundle(install.bundleName);
					results.push({ step: "卸载插件 " + install.bundleName, ok: true, result: res && res.application ? res.application : "removed" });
				} else {
					results.push({ step: "卸载插件", ok: false, reason: "宿主插件管理不可用" });
				}
			} catch (e) {
				results.push({ step: "卸载插件", ok: false, reason: String((e && e.message) || e) });
			}
		}
		const files = await restoreProfileFiles(job.snapshot.dir, profileDir()).catch((e) => ({ changed: [], skipped: [String((e && e.message) || e)] }));
		results.push({ step: "还原 profile 三件套", ...files });
		if (install.bundleName) {
			/* 快照还原后，node_modules 里可能还留着指向测试目录的悬空链接 */
			const dangling = await removeDanglingLink(profileDir(), install.bundleName).catch(() => ({ removed: false }));
			if (dangling.removed) results.push({ step: "清掉悬空链接 " + install.bundleName, removed: true });
		}
		job.rollback = { done: true, at: nowIso(), plan: plan.mode, results };
		if (job.error) {
			/* 回滚之后那条错误不该继续占着红字：原样记进回滚结果里留痕 */
			results.push({ step: "回滚前的错误（留痕）", was: job.error.code, message: job.error.message });
			job.error = null;
		}
		job.status = "rolled-back";
		setStage(job, "install", "skip",
			plan.mode === "restore-only"
				? "已回滚（声明已还原）"
				: plan.mode === "reinstall-npm" || plan.mode === "reinstall-file"
					? "已回滚（装回旧版" + (install.previousVersion ? " v" + install.previousVersion : "") + "）"
					: "已回滚（卸载了这次装上的插件）");
		job.diagnosis = null;
		/* removeBundle 也走 pnpm：同样要扫一次那个雷 */
		const swept = await this.sweepLandmine("rollback:" + id);
		if (swept.moved) results.push({ step: "清理 @deepseek-ai/dsh-tools 覆盖", moved: true, to: swept.to });
		await this.save();
		await this.log("rollback " + id + " " + JSON.stringify(results).slice(0, 800));
		return { ok: true, rollback: job.rollback, job: this.compactJob(job) };
	}

	/* ── 主流程 ─────────────────────────────────────────────────────── */

	async execute(job) {
		const { staging } = this.dirs();
		const work = join(staging, job.id);
		try {
			const desc = job.input.desc;
			await this.checkCancel(job);

			/* ① 输入接入 */
			setStage(job, "input", "running");
			const plan = await this.planInput(desc, work, job);
			setStage(job, "input", "ok", plan.label);
			job.source = plan.source;
			await this.save();
			await this.checkCancel(job);

			/* ② 下载 */
			let archivePath = plan.localDir ? null : plan.localFile || null;
			if (plan.url) {
				setStage(job, "download", "running");
				const dl = await downloadToFile(plan.url, join(work, "dl"), {
					maxBytes: this.options.maxDownloadBytes || 256 * 1024 * 1024,
					timeoutMs: 120000
				});
				archivePath = dl.path;
				setStage(job, "download", "ok", fmtBytes(dl.bytes) + " · " + dl.fileName);
				job.archive = { file: dl.fileName, bytes: dl.bytes };
			} else if (archivePath) {
				const info = await stat(archivePath);
				setStage(job, "download", "skip", "本地文件，不下载（" + fmtBytes(info.size) + "）");
			} else {
				setStage(job, "download", "skip", "无需下载");
			}
			await this.save();
			await this.checkCancel(job);

			/* ③ 解包 */
			let extractRoot = plan.localDir || null;
			if (!extractRoot) {
				setStage(job, "unpack", "running");
				const buf = await readFile(archivePath);
				const sniff = sniffFormat(buf);
				job.format = { format: sniff.format, label: sniff.label };
				if (buf.length > (this.options.maxArchiveBytes || 200 * 1024 * 1024)) {
					throw new StageError("too-big", "压缩包过大（" + Math.round(buf.length / 1048576) + " MiB）");
				}
				if (sniff.family === "forbidden") {
					throw new StageError("executable", "这是一个可执行文件（" + sniff.label + "），面板不会运行它", "请下载源码/压缩包，或把安装包交给系统手动安装后只装 DSH 插件。");
				}
				if (sniff.family !== "archive") {
					throw new StageError("unsupported-format", "认不出这是压缩包（魔数：" + sniff.label + "）", UNSUPPORTED_HINT);
				}
				extractRoot = join(work, "x");
				const stats = await extractToDir(buf, sniff.format, extractRoot, {
					...DEFAULT_LIMITS,
					maxBytes: this.options.maxExtractBytes || DEFAULT_LIMITS.maxBytes,
					maxFiles: this.options.maxFiles || DEFAULT_LIMITS.maxFiles
				});
				setStage(job, "unpack", "ok", stats.files + " 个文件 / " + fmtBytes(stats.bytes) + " · " + sniff.label);
				job.extract = { files: stats.files, bytes: stats.bytes, format: sniff.format };
			} else {
				setStage(job, "unpack", "skip", "本地目录，直接读");
			}
			await this.save();
			await this.checkCancel(job);

			/* ④ 识别 */
			setStage(job, "detect", "running");
			const subdir = desc.kind === "github-repo" ? desc.subdir || null : null;
			const detected = await detectKind(extractRoot, { subdir });
			job.detectedFull = detected;
			job.detected = compactDetected(detected);
			job.title = job.detected.name ? job.detected.name + " · " + kindLabel(job.detected.kind) : job.title;
			setStage(job, "detect", "ok", kindLabel(job.detected.kind) + (job.detected.name ? "：" + job.detected.name : "") +
				(job.detected.version ? "@" + job.detected.version : ""));
			await this.save();
			await this.checkCancel(job);

			/* ④b 已装版本（R5.1）：同一个插件再提交时，要说清这是升级 / 降级 / 同版本重装。
			   以前一律报「装上了」，用户没法从面板上知道自己在往新版走还是往旧版走。 */
			const installed = job.detected.kind === "bundle"
				? await installedPluginInfo(job.detected.name).catch(() => null)
				: null;
			/* R26：升级前的版本与声明必须在**安装之前**记下来 —— 回滚要靠它「装回旧版」；
			   装完再读 node_modules 就只能读到新版本了。 */
			job.installedBefore = installed && installed.installed
				? { name: installed.name || job.detected.name, version: installed.version || null, spec: installed.spec || null }
				: null;

			/* ④b R31 直连安装判据：本机目录插件除了「重打成 .tgz 交给 pnpm」之外还有一条路 ——
			   建 junction + 写两行 profile 配置，pnpm 一次都不跑。判据纯函数在 lib/linkinstall.js。
			   这里只探一次 node_modules 里那一条的现状（不写盘）。 */
			let linkPlan = null;
			if (job.detected.kind === "bundle" && plan.localDir && job.detected.name) {
				const profilePkg = await readProfilePackage().catch(() => null);
				const entry = await probeEntry(profileDir(), job.detected.name).catch(() => null);
				/* 规范路径：probeEntry 的 target 是 realpath 结果，两边形式不一致就永远判「不是同一个」（见 linkinstall） */
				const canonical = await realpath(detected.root).catch(() => detected.root);
				linkPlan = planLinkInstall({
					name: job.detected.name,
					sourceDir: canonical,
					profileDir: profileDir(),
					manifest: (detected.payload && detected.payload.manifest) || null,
					deps: (profilePkg && profilePkg.dependencies) || {},
					bundles: (profilePkg && profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles) || [],
					entry
				});
			}
			job.link = compactLinkPlan(linkPlan);
			job.localDir = plan.localDir || null;
			await this.save();

			/* ④c 换版本判据（R27）：宿主 0.2.1 的 installBundle 对已存在的包名一律回
			   already-installed，**换版本只能先卸再装**。这里先把三件事算清楚：
			   要不要换、能不能换（自己 / link / git 一律拒）、由谁卸（协作方是否可用）。
			   判据是纯函数（lib/upgrade.js），预检、执行、回滚、中断续跑共用这一份。 */
			job.replacement = decideReplacement({
				detected: job.detected,
				installedBefore: job.installedBefore,
				targetVersion: job.detected.version,
				source: plan.source
			});
			if (job.replacement.needed && !job.replacement.blocked) {
				/* 只留结构（服务对象与函数不能进 state.json） */
				job.collaborator = compactCollaborator(await describeRemovalProvider(this.ctx));
			}
			await this.save();
			await this.checkCancel(job);

			/* ⑤ 安全预检 */
			setStage(job, "precheck", "running");
			const scan = await scanTree(detected.tree.files, { maxFiles: 600 });
			const scripts = collectScripts(detected.payload && detected.payload.manifest);
			const reputation = plan.source.type === "npm" && job.detected.name
				? await npmReputation(job.detected.name)
				: null;
			const pc = await precheck({
				detected,
				scan,
				scripts,
				source: plan.source,
				reputation,
				installed,
				settings: this.settings,
				/* R31：本机目录插件的两条路（.tgz / 直连）以及「它已经直连装了」这件事 */
				link: linkPlan,
				/* R27：换版本的「先卸后装」必须人点头（审核档位关掉也照旧）——
				   它不是风险提示，而是一个会让插件短暂消失的动作。 */
				replacement: job.replacement,
				collaborator: job.collaborator || null,
				replaceApproved: job.replaceApproved === true
			});
			job.precheck = compactPrecheck(pc);
			setStage(job, "precheck", pc.blocked ? "fail" : pc.needsConfirm ? "warn" : "ok",
				pc.blocked ? "阻断：" + firstReason(pc) : pc.needsConfirm ? "需要确认：" + pc.risks.summary : "通过 · " + pc.risks.summary);
			await this.save();

			if (pc.blocked) {
				throw new StageError("precheck-blocked", "安全预检阻断安装：" + firstReason(pc),
					(pc.fixes && pc.fixes[0] && pc.fixes[0].label) || "看面板里的「下一步」");
			}

			/* ④d R31：**它本来就是这个目录链着的** —— 不要再「装一遍」。
			   这是用户抱怨的原话（「总是要显示再安装一遍」）：以前这里会继续往下走，
			   要么被宿主回 already-installed（看着像装了个寂寞），要么触发一次 pnpm 重算
			   （在本机会被 trustPolicy 掐掉，于是变成「总是安装失败」）。
			   现在的行为：直接收成 done，并跑一次真诊断告诉他「它到底起没起来」。 */
			if (linkPlan && linkPlan.ok && linkPlan.alreadyLinked && linkPlan.entryLinked) {
				await this.settleAlreadyLinked(job, linkPlan);
				return;
			}

			if (pc.needsConfirm) {
				job.status = "awaiting-confirm";
				setStage(job, "confirm", "warn", "等待你确认");
				await this.save();
				return;
			}
			setStage(job, "confirm", "skip", "无需确认");
			await this.continueToInstall(job, detected, plan);
		} catch (e) {
			await this.fail(job, e);
		} finally {
			/* 等用户确认时**必须留着**解包现场：确认之后还要从这儿打包安装 */
			const waiting = job.status === "awaiting-confirm";
			const keep = waiting || (job.status === "failed" && this.options.keepFailedStaging === true);
			if (!keep) await rm(work, { recursive: true, force: true }).catch(() => {});
			/* R29：任务收尾记一次 profile 签名 —— 否则下一次观察会把「本面板刚装的东西」
			   误报成「外部改动」 */
			await this.noteJobProfile(job).catch(() => null);
		}
	}

	async afterConfirm(job) {
		const work = join(this.dirs().staging, job.id);
		try {
			const detected = job.detectedFull;
			if (!detected) throw new StageError("lost-state", "确认时找不到解包现场（宿主可能重启过）");
			const plan = { source: job.source };
			await this.continueToInstall(job, detected, plan);
		} catch (e) {
			await this.fail(job, e);
		} finally {
			await rm(work, { recursive: true, force: true }).catch(() => {});
			/* R29：同上 —— 确认之后走完的那一半也要记一次 */
			await this.noteJobProfile(job).catch(() => null);
		}
	}

	/* ── 换版本（R27）：两阶段 —— 准备新包 → 交给插件目录卸载 → 安装 → 失败装回 ── */

	/**
	 * 协作方状态（面板/工具的一行结论）。10 秒缓存：`/state` 每 2.5 秒轮询，
	 * 而探测要读宿主插件清单 —— 不能跟着轮询节奏读。
	 */
	async collaboratorInfo(force = false) {
		if (!force && this._collaborator && Date.now() - this._collaboratorAt < 10000) return this._collaborator;
		const provider = await describeRemovalProvider(this.ctx);
		this._collaborator = compactCollaborator(provider);
		this._collaboratorAt = Date.now();
		return this._collaborator;
	}

	/**
	 * 换版本的准备 + 卸载（顺序不可换）。
	 *
	 * ★ 先打包再卸载：打包可能失败（读盘/写盘/文件数上限），而**卸载之后就只剩这条路**。
	 *   先打包 = 失败时 profile 一点没变；先卸载 = 失败时插件已经没了。
	 * ★ 计划（plan）→ 执行（apply）两段：计划只读、带 token 与 5 分钟有效期；
	 *   执行前「插件目录」会再核一遍版本与依赖声明（stale-plan），防拿过期事实动手。
	 * ★ 每一步都落盘：宿主可能在卸载与安装之间重启，重启后 `ensureReconciled()` 靠
	 *   `job.upgrade.phase` 判断「要不要提示续跑」。
	 *
	 * @param {object} job
	 * @param {object} detected
	 * @param {object} plan  planInput 的结果（含 source）
	 */
	async prepareAndRemoveForReplace(job, detected, plan) {
		const rep = job.replacement;
		if (!rep || !rep.needed) return null;
		if (rep.blocked) {
			throw new StageError("replace-blocked", "换版本被拒：" + rep.blocked.text, (rep.blocked.fix && rep.blocked.fix[0] && rep.blocked.fix[0].text) || "看面板里的原因", {
				plain: rep.blocked.plain,
				fix: rep.blocked.fix,
				kind: rep.blocked.code
			});
		}
		const provider = await describeRemovalProvider(this.ctx);
		job.collaborator = compactCollaborator(provider);
		if (!provider.ok) {
			throw new StageError("needs-collaborator", "换版本需要「插件目录」卸载旧版，但它当前不可用", (provider.fix && provider.fix[0] && provider.fix[0].text) || "先装上/启用 dsh-plugin-catalog 再试", {
				plain: "大白话：宿主不接受「原地换版本」，必须先卸载再装。卸载这一步交给「插件目录」做（它知道谁依赖它、它现在会不会被加载）。" +
					(provider.reason ? "\n\n当前：" + provider.reason : ""),
				fix: provider.fix || [],
				kind: provider.state || "needs-collaborator"
			});
		}

		/* ① 新包先备好 */
		setStage(job, "replace", "running", "准备新包（失败就不动旧版）…");
		let prepared = null;
		try {
			if (plan && plan.source && plan.source.type === "npm" && plan.source.spec) {
				prepared = { type: "npm", spec: plan.source.spec, packed: null };
			} else {
				const packDir = join(this.root, "vendor");
				await mkdir(packDir, { recursive: true });
				const packed = await preparePluginTarball({ detected, packDir });
				prepared = { type: "file", spec: packed.spec, packed: packed.packed, name: packed.name, version: packed.version };
			}
		} catch (error) {
			throw new StageError("prepare-failed", "新包没准备好，所以**没有**卸载旧版：" + String((error && error.message) || error), "这次 profile 一点没变", {
				plain: "大白话：卸载是不可逆的一步，所以顺序是「先把新包备好 → 再卸旧版」。新包都没备好，就不卸。"
			});
		}
		job.upgrade = {
			needed: true,
			from: rep.from,
			to: rep.to,
			direction: rep.direction,
			kind: rep.kind,
			name: rep.name,
			phase: "prepared",
			prepared,
			collaborator: compactCollaborator(provider),
			at: nowIso()
		};
		await this.save();

		/* ② 出计划（只读） */
		setStage(job, "replace", "running", "请「插件目录」核对能不能卸载…");
		let planned = null;
		try {
			planned = await provider.removal.plan({ name: rep.name, purpose: "replace", requestedBy: job.id });
		} catch (error) {
			planned = { ok: false, error: String((error && error.message) || error), blockers: [] };
		}
		job.upgrade.removalPlan = planned && planned.ok
			? { ok: true, text: planned.text || "", warnings: (planned.warnings || []).slice(0, 8), blockers: [] }
			: { ok: false, text: (planned && (planned.error || planned.text)) || "出计划失败", blockers: ((planned && planned.blockers) || []).slice(0, 8) };
		await this.save();
		if (!planned || planned.ok !== true || !planned.token) {
			const blockers = (planned && planned.blockers) || [];
			throw new StageError("collaborator-blocked", "「插件目录」不允许卸载旧版：" + (job.upgrade.removalPlan.text || "未知原因"),
				(blockers[0] && blockers[0].text) || "看「插件目录」给出的原因", {
					plain: "大白话：对面在动手前先算了一遍「卸了会不会弄坏别人」。它说不允许，就一定不卸 —— 这一步没有任何东西被改动。",
					fix: blockers.map((b) => ({ text: b.text }))
				});
		}

		/* ③ 执行（带 token + confirm） */
		job.upgrade.phase = "removing";
		await this.save();
		setStage(job, "replace", "running", "正在卸载 " + rep.name + "@" + rep.from + "…");
		let removal = null;
		try {
			removal = await provider.removal.apply({ token: planned.token, confirm: true, requestedBy: job.id });
		} catch (error) {
			removal = { ok: false, code: "threw", error: String((error && error.message) || error) };
		}
		job.upgrade.removal = {
			ok: Boolean(removal && removal.ok),
			code: (removal && removal.code) || "",
			error: (removal && removal.error) || "",
			application: (removal && removal.application) || "",
			verified: (removal && removal.verified) || null,
			at: nowIso()
		};
		job.upgrade.phase = job.upgrade.removal.ok ? "removed" : "remove-failed";
		await this.save();
		if (!job.upgrade.removal.ok) {
			throw new StageError("remove-failed", "卸载旧版失败：" + (job.upgrade.removal.error || job.upgrade.removal.code || "未知原因"),
				"这次没有改动 profile（对面复核过依赖行还在）", {
					plain: "大白话：卸载没成功，所以安装也没有开始 —— 插件还在原来的版本上。看「插件目录」给的错误码。",
					kind: job.upgrade.removal.code
				});
		}
		setStage(job, "replace", "ok", "已卸载 " + rep.name + "@" + rep.from + "（依赖行已复核消失）");
		/* 清单变了：别让 30 秒缓存继续显示「已装旧版」 */
		this._inventoryAt = 0;
		await this.log("replace " + job.id + " " + rep.name + " " + rep.from + "->" + rep.to + " removed via " + (provider.name || "collaborator"));
		return removal;
	}

	/**
	 * 新版装失败时**把旧版装回去**（这一步只在本任务确实卸载过旧版时做）。
	 *
	 * ★ 判据不看宿主回执，看 `node_modules/<name>/package.json` 的**版本**：
	 *   宿主对已存在的包名回 already-installed 是"正常返回"，拿它当成功会写出
	 *   「已装回旧版 vX」而 profile 一字未改（R27 审计的 P0-1）。
	 */
	async restoreAfterFailedUpgrade(job, cause) {
		const upgrade = job.upgrade;
		if (!upgrade || upgrade.phase !== "removed") return null;
		const name = (job.detected && job.detected.name) || (job.installedBefore && job.installedBefore.name) || "";
		const target = restoreTarget({ name, installedBefore: job.installedBefore, vendorBackup: job.vendorBackup });
		if (!target.ok) {
			upgrade.restore = { ok: false, why: target.why, spec: target.spec, version: upgrade.from || null, at: nowIso() };
			setStage(job, "replace", "fail", "新版失败，旧版也装不回去：" + target.why);
			await this.save();
			return upgrade.restore;
		}
		setStage(job, "replace", "running", "新版没装上，正在装回 " + (upgrade.from || "旧版") + "…");
		let result = null;
		try {
			result = await installPlugin({
				pluginManager: this.ctx.pluginManager,
				detected: { payload: { manifest: { name, version: upgrade.from || null } } },
				source: { type: target.type === "npm" ? "npm" : "local" },
				prepared: { spec: target.spec }
			});
		} catch (error) {
			result = { ok: false, error: { message: String((error && error.message) || error) } };
		}
		const now = await installedPluginInfo(name).catch(() => null);
		const ok = Boolean(now && now.installed && (!upgrade.from || !now.version || String(now.version) === String(upgrade.from)));
		upgrade.restore = {
			ok,
			spec: target.spec,
			version: upgrade.from || null,
			current: (now && now.version) || null,
			why: target.why,
			application: (result && result.application) || "",
			error: result && result.error ? String(result.error.message || "") : (result && result.failure ? String(result.failure.title || "") : ""),
			cause: String((cause && (cause.message || cause.code)) || ""),
			at: nowIso()
		};
		setStage(job, "replace", ok ? "warn" : "fail", ok ? "已装回 " + (upgrade.from || "旧版") : "装回旧版也没成功（" + (upgrade.restore.error || "看诊断") + "）");
		await this.save();
		await this.log("restore " + job.id + " " + name + " -> " + target.spec + " ok=" + ok + " current=" + (upgrade.restore.current || "?"));
		return upgrade.restore;
	}

	/**
	 * 中断续跑：宿主在「卸载之后、安装之前」重启时，`ensureReconciled()` 把任务标成
	 * `upgrade-interrupted`（不自动装 —— 无人值守时装东西违背本插件的一贯纪律），
	 * 面板给一个按钮走这里。**只有这一种中断可以续**，其它中断仍按原样报失败。
	 */
	async resumeUpgrade(id) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		const upgrade = job.upgrade;
		if (!upgrade || upgrade.phase !== "interrupted" || !upgrade.prepared || !upgrade.prepared.spec) {
			return { ok: false, message: "这单没有可续的升级现场（只有「已卸载旧版、还没装新版」被中断时才能续）" };
		}
		if (this._running) return { ok: false, message: "已经有一个任务在跑，等它结束（或先取消）" };
		job.status = "running";
		job.error = null;
		setStage(job, "install", "running", "继续：安装 " + (upgrade.to || "新版") + "（上次中断在卸载之后）");
		await this.save();
		this._running = (async () => {
			let diagnosis = null;
			try {
				const result = await installPlugin({
					pluginManager: this.ctx.pluginManager,
					detected: { payload: { manifest: { name: (job.detected && job.detected.name) || upgrade.name, version: upgrade.to || null } } },
					source: { type: upgrade.prepared.type === "npm" ? "npm" : "local" },
					prepared: upgrade.prepared
				});
				const failure = result.failure || (result.error && result.error.failure) || null;
				const noop = Boolean(result.noop || (failure && failure.noop));
				job.install = {
					...(job.install || {}),
					kind: "bundle",
					bundleName: result.bundleName || upgrade.name || null,
					spec: result.spec,
					packed: result.packed || null,
					application: result.application,
					ok: Boolean(result.ok || noop),
					noop,
					result: result.result,
					failure,
					error: result.error || null,
					previousVersion: upgrade.from || null,
					previousSpec: (job.installedBefore && job.installedBefore.spec) || null,
					upgrade: true,
					resumed: true
				};
				if (!result.ok && !noop) {
					await this.restoreAfterFailedUpgrade(job, failure || result.error);
					throw new StageError("install-failed", (failure && failure.title) || (result.error && result.error.message) || "续跑安装失败",
						(failure && failure.hint) || "看面板里的详细输出", failure ? { plain: failure.plain, fix: failure.fix, kind: failure.kind } : null);
				}
				upgrade.phase = "done";
				upgrade.resumedAt = nowIso();
				setStage(job, "install", "ok", "已装回 " + (upgrade.to || "新版") + "（续跑）" + (noop ? " · 宿主说已装过、本次没改动" : ""));
				diagnosis = await diagnose({ pluginManager: this.ctx.pluginManager, skills: this.ctx.skills, job });
				job.diagnosis = diagnosis;
				await this.noteCatalogVerdict(job, diagnosis).catch(() => null);
				setStage(job, "diagnose", diagnosis.verdict === "ok" ? "ok" : diagnosis.verdict === "warn" ? "warn" : "fail",
					diagnosis.verdict === "ok" ? "一切正常" : (diagnosis.findings[0] && diagnosis.findings[0].title) || diagnosis.verdict);
				job.status = diagnosis.verdict === "error" ? "failed" : "done";
				if (diagnosis.verdict === "error") {
					job.error = { code: "diagnose-error", message: (diagnosis.findings[0] && diagnosis.findings[0].title) || "诊断发现问题", hint: "可一键回滚" };
				}
			} catch (error) {
				if (!(error && error.code === "install-failed")) {
					await this.restoreAfterFailedUpgrade(job, error).catch(() => null);
				}
				await this.fail(job, error);
			}
		})().finally(() => {
			this._running = null;
			this._drainQueue().catch(() => {});
		});
		return { ok: true, message: "已在后台继续安装 " + (upgrade.to || "新版"), job: this.compactJob(job) };
	}

	async continueToInstall(job, detected, plan) {
		await this.checkCancel(job);

		/* ⑥ 快照（安装前） */
		setStage(job, "snapshot", "running");
		const pm = this.ctx.pluginManager;
		const bundles = pm && typeof pm.listBundles === "function" ? await pm.listBundles().catch(() => []) : [];
		const plugins = pm && typeof pm.listPlugins === "function" ? await pm.listPlugins().catch(() => []) : [];
		const versions = await hostVersions();
		job.skillRoot = await firstExistingDir(skillRoots());
		const snap = await createSnapshot({
			root: this.dirs().snapshots,
			reason: (job.detected && job.detected.name) || job.id,
			profileDir: profileDir(),
			skillsRoot: job.skillRoot,
			bundles,
			plugins,
			versions
		});
		job.snapshot = { id: snap.id, dir: snap.dir, savedFiles: snap.meta.savedFiles, bundles: bundles.length, plugins: plugins.length, skills: snap.meta.skills.length };
		setStage(job, "snapshot", "ok", snap.id + "（插件 " + bundles.length + " / 行 " + plugins.length + " / 技能 " + snap.meta.skills.length + "）");
		/* R26：升级本地包之前，把**旧的那份 .tgz** 拷进快照 —— 装完它就不在磁盘上了
		   （重打包会写新文件名，或覆盖同名文件）；回滚要装回旧版只能靠这一份。 */
		job.vendorBackup = null;
		if (job.installedBefore && job.installedBefore.spec) {
			job.vendorBackup = await backupVendorTarball(snap.dir, job.installedBefore.spec).catch(() => null);
			if (job.vendorBackup) {
				job.notes = (job.notes || []).concat(["升级前的旧包已备份到快照：" + basename(job.vendorBackup.copy)]);
			}
		}
		await this.save();
		await this.checkCancel(job);

		/* ⑦b 换版本（R27）：**先打包、再让插件目录卸载旧版**，最后才安装。
		   顺序不可换 —— 打包失败时不卸；卸完之前不碰安装。 */
		if (job.replacement && job.replacement.needed) {
			await this.prepareAndRemoveForReplace(job, detected, plan);
			await this.checkCancel(job);
		}

		/* ⑦ 安装 */
		setStage(job, "install", "running", "正在交给插件管理器…");
		/* ⚠️ 先落盘：本机实测 pnpm 写完 profile 之后宿主可能重启，不先存的话
		   重启后这条任务会像「从没开始装」。ensureReconciled() 靠这个记录回填。 */
		await this.save();
		if (detected.kind === "bundle") {
			/* 打包产物放 vendor/（**持久**）：profile 里记的是 file: 指向它。
			   放进 staging/ 会被任务收尾清掉，留一个指向空气的依赖 —— 下一次
			   pnpm 操作就会 ENOENT 失败（本机实测过一次）。 */
			const packDir = join(this.root, "vendor");
			await mkdir(packDir, { recursive: true });
			/* R9：这次任务带着「用户批准过的构建脚本」就一起递进去 */
			const approvedBuilds = job.buildApproval && Array.isArray(job.buildApproval.names) ? job.buildApproval.names : null;
			/* R27：两阶段升级时新包在卸载**之前**就备好了（见 prepareAndRemoveForReplace） */
			const prepared = (job.upgrade && job.upgrade.prepared) || null;
			let result = null;
			try {
				result = await installPlugin({
					pluginManager: this.ctx.pluginManager,
					detected,
					source: plan.source,
					packDir,
					approvedBuilds,
					prepared
				});
			} catch (error) {
				/* 旧版已经卸掉的情况下，安装抛错必须尝试装回 —— 否则插件就这么没了 */
				await this.restoreAfterFailedUpgrade(job, error).catch(() => null);
				throw error;
			}
			const failure = result.failure || (result.error && result.error.failure) || null;
			/* R13：`already-installed` 是「已经装过、这次没改动」，不是故障 ——
			   收成 ok + 备注，然后照常跑诊断（用户真正想知道的是「它到底起没起来」）。 */
			const noop = Boolean(result.noop || (failure && failure.noop));
			job.install = {
				kind: "bundle",
				bundleName: result.bundleName || job.detected.name,
				spec: result.spec,
				packed: result.packed || null,
				application: result.application,
				ok: Boolean(result.ok || noop),
				noop,
				elapsedMs: result.elapsedMs,
				result: result.result,
				/* R9：待批准的安装脚本、宿主拒绝码、以及「为什么 + 下一步」都留在任务上，
				   面板据此渲染「允许并重试」卡片，事后回看也知道卡在哪一类。 */
				pendingBuilds: Array.isArray(result.pendingBuilds) ? result.pendingBuilds : (failure ? failure.pendingBuilds : []),
				approvedBuilds: Array.isArray(result.approvedBuilds) ? result.approvedBuilds : (approvedBuilds || []),
				incompatible: (result.error && result.error.incompatible) || (failure ? failure.incompatible : null),
				failure,
				error: result.error || null
			};
			/* R26：升级语义 —— 记下「从哪个版本来的、原来怎么声明的」。回滚据此装回旧版，
			   而不是把插件卸掉（那是全新安装的回滚方式）。 */
			if (job.installedBefore) {
				job.install.previousVersion = job.installedBefore.version || null;
				job.install.previousSpec = job.installedBefore.spec || null;
				job.install.previousTarball = job.vendorBackup || null;
				job.install.upgrade = Boolean(
					job.install.previousVersion &&
					job.detected.version &&
					job.install.previousVersion !== job.detected.version
				);
			}
			setStage(job, "install", result.ok || noop ? "ok" : "fail",
				result.ok || noop
					? (noop
						? "已经装过（依赖已在 profile 里），这次没有改动 —— 下面照常诊断"
						: ("已安装（" + (result.application || "applied") + "，" + Math.round((result.elapsedMs || 0) / 1000) + "s" +
							(result.packed ? "，重打包 " + result.packed.files + " 个文件" : "") +
							(approvedBuilds && approvedBuilds.length ? "，已批准 " + approvedBuilds.length + " 个包的安装脚本" : "") + "）"))
					: (failure && failure.title) || (result.error && result.error.message) || "安装失败");
			/* R26.3：目标版本与已装不同却回 noop = 假成功 —— 宿主拒绝原地换版本，必须报失败。
			   R27：正常情况下已经走「先卸后装」；走到这里说明协作卸载**没有真的生效**
			   （例如对面回 ok 但依赖行还在，而我们复核过 —— 不该发生），仍按失败报。 */
			const targetVersion = (job.precheck && job.precheck.installed && job.precheck.installed.target) ||
				(job.detected && job.detected.version) || null;
			const stalled = upgradeStalled({ noop, previousVersion: job.install.previousVersion, targetVersion });
			if (stalled) {
				job.install.stalled = stalled;
				const dropped = this._queue.length;
				this._queue = [];
				await this.log("upgrade stalled " + job.install.bundleName + " " + stalled.from + "->" + stalled.to + " (queue cleared: " + dropped + ")").catch(() => {});
				throw new StageError(
					"upgrade-stalled",
					"升级没有发生：宿主回 already-installed（" + stalled.from + " → " + stalled.to + "）",
					"宿主按包名判已装。这条任务本应先由「插件目录」卸载旧版 —— 看上面「⑦b 卸载旧版」那一步的结论",
					{
						plain: "大白话：宿主只看依赖行里有没有这个包名 —— 有就回「已经装过」，一次 pnpm 都不跑。面板本来会先请「插件目录」把旧版卸掉再装；这一步显然没有真的生效，profile 一点没变。",
						fix: [
							{ text: "先看「插件目录」是否可用（面板「已装插件」卡片顶部那一行）" },
							{ text: "还不行就用官方插件管理器卸载这个插件，再回面板装新版本" },
							{ text: "不想折腾：这条任务可以直接关掉 —— profile 实际没变，快照也在，不影响现状" }
						]
					}
				);
			}
			if (noop) {
				job.notes = (job.notes || []).concat(["宿主回执 already-installed：这份依赖已在 profile 里，本次没有改动；正在为它重新诊断"]);
			}
			if (!result.ok && !noop) {
				/* 旧版已卸 → 先把旧版装回去，再把失败抛出去（面板会同时显示"装回成功/失败"） */
				await this.restoreAfterFailedUpgrade(job, failure || result.error).catch(() => null);
				/* R31：失败带上「这一台机器上真能做的下一步」——
				   · 信任度降级 → 豁免那一个版本（面板会二次确认）；
				   · 本机目录插件 → 直连安装（完全绕开 pnpm）。 */
				const actions = [];
				if (failure && failure.action && failure.action.kind === "add-trust-exclude") actions.push(failure.action);
				if (job.link && job.link.ok && job.link.sourceDir) {
					actions.push({ kind: "link-install", label: "直连安装（不走 pnpm）", hint: "建链接 + 写两行 profile 配置，不重算依赖树" });
				}
				throw new StageError(
					"install-failed",
					(failure && failure.title) || (result.error && result.error.message) || "package manager 报告安装失败",
					(failure && failure.hint) || (result.result && result.result.nextStep) || "看面板里的详细输出与回滚按钮",
					failure ? { plain: failure.plain, fix: failure.fix, kind: failure.kind, actions } : (actions.length > 0 ? { actions } : null)
				);
			}
			/* 换版本成功：记一笔（宿主契约：替换已安装包要下次启动才加载新的一代代码） */
			if (job.upgrade && job.upgrade.phase === "removed") {
				job.upgrade.phase = "done";
				job.upgrade.doneAt = nowIso();
				job.notes = (job.notes || []).concat([
					"两阶段换版本完成：" + job.upgrade.from + " → " + job.upgrade.to +
					"（旧版由「插件目录」卸载并复核）。宿主契约：替换已安装包要下次启动才加载新代码。"
				]);
				await this.save();
			}
		} else if (detected.kind === "skill") {
			const result = await installSkill({ detected, snapshotDir: job.snapshot.dir });
			job.install = {
				kind: "skill",
				skillName: result.name,
				skillDir: result.dest,
				root: result.root,
				replaced: Boolean(result.replaced),
				ok: result.ok,
				error: result.error || null
			};
			setStage(job, "install", result.ok ? "ok" : "fail",
				result.ok ? ("已落位 " + result.dest + (result.replaced ? "（覆盖了同名技能，旧版已备份）" : "")) : (result.error && result.error.message) || "落位失败");
			if (!result.ok) throw new StageError("install-failed", (result.error && result.error.message) || "技能落位失败");
		} else {
			throw new StageError("not-installable", "识别结果不可安装：" + detected.kind);
		}
		await this.save();
		/* pnpm 刚刚跑过：把那份可能的 dsh-tools 覆盖扫掉（不然下次启动全灭） */
		const swept = await this.sweepLandmine("install:" + job.id);
		if (swept.moved) {
			job.notes = (job.notes || []).concat(["已清理 pnpm 埋下的 @deepseek-ai/dsh-tools 覆盖（挪到备份）"]);
			await this.save();
		}
		await this.checkCancel(job);

		await this.diagnoseAndClose(job);
	}

	/**
	 * ⑧⑨ 的收尾（诊断 → 状态 → 按需 AI 审查）。
	 *
	 * R31 把它抽出来，是因为「直连安装」与「它本来就是直连装着的」两条路都要用同一段收尾 ——
	 * 复制一份必然分化（本工程的老毛病：同一件事两套口径，最后总有一套过期）。
	 */
	async diagnoseAndClose(job) {
		/* ⑧ 诊断 */
		setStage(job, "diagnose", "running");
		let diagnosis = null;
		try {
			diagnosis = await diagnose({ pluginManager: this.ctx.pluginManager, skills: this.ctx.skills, job });
		} catch (e) {
			diagnosis = { verdict: "warn", findings: [{ severity: "warn", title: "诊断本身失败", detail: String((e && e.message) || e), action: null }], inventory: {} };
		}
		job.diagnosis = diagnosis;
		await this.noteCatalogVerdict(job, diagnosis).catch(() => null);
		setStage(job, "diagnose", diagnosis.verdict === "ok" ? "ok" : diagnosis.verdict === "warn" ? "warn" : "fail",
			diagnosis.verdict === "ok" ? "一切正常" : (diagnosis.findings[0] && diagnosis.findings[0].title) || diagnosis.verdict);
		job.status = diagnosis.verdict === "error" ? "failed" : "done";
		if (diagnosis.verdict === "error") {
			job.error = {
				code: "diagnose-error",
				message: (diagnosis.findings[0] && diagnosis.findings[0].title) || "安装后诊断发现问题",
				hint: (diagnosis.findings[0] && diagnosis.findings[0].action && diagnosis.findings[0].action.label) || "可一键回滚"
			};
		}
		await this.save();
		await this.log("done " + job.id + " kind=" + (job.detected && job.detected.kind) + " verdict=" + diagnosis.verdict);

		/* ⑨ 按需 AI 语义审查（异步，不阻塞）。R6：用户在设置里关掉审核、
		   或在确认卡上点了「跳过审核」，都不再花这笔 token。 */
		const reviewOff = (this.settings && this.settings.reviewLevel) === "off";
		if (job.precheck && job.precheck.needsAiReview && !job.reviewSkipped && !reviewOff) {
			job.review = { status: "pending", verdict: null, at: null, findings: [], error: null };
			await this.save();
			this.review(job.id).catch(() => {});
		} else if (job.reviewSkipped && !job.review) {
			job.review = {
				status: "skipped",
				verdict: "inconclusive",
				at: nowIso(),
				findings: [],
				note: "你选了「跳过审核，直接安装」—— 这次没有调用模型，也没有花 token",
				skipReason: "用户跳过审核"
			};
			await this.save();
		}
	}

	/**
	 * R31：「它本来就是直连安装着的」—— 不改 profile，直接给结论。
	 *
	 * 这是用户抱怨「总是要显示再安装一遍」的正面回答：同一个源码目录、profile 里已经
	 * `link:` 指向它、node_modules 里那条链接也在 —— 那就**没有任何东西需要装**。
	 * 这时候还说「装一遍」只有两种下场：宿主回 already-installed（看着像装了个寂寞），
	 * 或者真跑一次 pnpm 重算依赖树（本机会被 trustPolicy 掐掉 → 「总是安装失败」）。
	 */
	async settleAlreadyLinked(job, linkPlan) {
		const dir = linkPlan.sourceDir || (job.detected && job.detected.root) || "";
		setStage(job, "confirm", "skip", "无需确认：这次不改动 profile");
		setStage(job, "snapshot", "skip", "不改 profile，不需要快照");
		setStage(job, "install", "skip", "已经是直连安装（link: " + dir + "）—— 本次没有改动");
		job.install = {
			kind: "bundle",
			bundleName: linkPlan.name || (job.detected && job.detected.name) || null,
			mode: "link-already",
			spec: "link:" + dir,
			ok: true,
			changed: false,
			noop: true,
			application: null
		};
		job.notes = (job.notes || []).concat([
			"它已经是直连安装（link: " + dir + "），这次没有改动 profile —— 下面照常诊断，回答「它到底起没起来」"
		]);
		await this.save();
		await this.diagnoseAndClose(job);
	}

	/**
	 * R31：直连安装（link，不走 pnpm）。
	 *
	 * 只对本机目录插件有效：建 junction → 把 `dependencies[name]` 写成 `link:<目录>` →
	 * 加进 `dsh.profile.bundles`。**一次 pnpm 都不跑**，所以本机那条
	 * `trustPolicy: no-downgrade` 挡住整次安装的问题在这条路上不存在。
	 *
	 * 写盘前一定先做快照（回滚靠它把 profile 三件套还原），写盘后一定要复核
	 * （linkinstall.applyLinkInstall 内部已做：配置写进去了没有、通过链接读不读得到插件本身）。
	 *
	 * @param {string} id 任务 id
	 * @param {{reason?:string}} [opts]
	 */
	async linkInstall(id, opts = {}) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (this._running) return { ok: false, message: "已经有一个安装任务在跑，等它结束（或先取消）" };
		const detected = job.detected || null;
		if (!detected || detected.kind !== "bundle") return { ok: false, message: "这个任务不是可直连安装的插件包" };
		const sourceDir = (job.link && job.link.sourceDir) || detected.root || null;
		if (!sourceDir) return { ok: false, message: "不知道这个插件的源码目录（它可能不是本机目录提交的）" };
		const info = await stat(sourceDir).catch(() => null);
		if (!info || !info.isDirectory()) {
			return { ok: false, message: "源码目录已经不在了：" + sourceDir + "（本机目录提交的插件才支持直连安装）" };
		}
		const name = detected.name;
		if (!name) return { ok: false, message: "读不到包名，不敢写依赖行" };

		/* ① 快照：直连安装会改 profile 的 package.json —— 与 .tgz 那条路同等对待 */
		setStage(job, "snapshot", "running");
		const pm = this.ctx.pluginManager;
		const bundles = pm && typeof pm.listBundles === "function" ? await pm.listBundles().catch(() => []) : [];
		const plugins = pm && typeof pm.listPlugins === "function" ? await pm.listPlugins().catch(() => []) : [];
		const versions = await hostVersions();
		job.skillRoot = job.skillRoot || await firstExistingDir(skillRoots());
		const snap = await createSnapshot({
			root: this.dirs().snapshots,
			reason: name,
			profileDir: profileDir(),
			skillsRoot: job.skillRoot,
			bundles,
			plugins,
			versions
		});
		job.snapshot = { id: snap.id, dir: snap.dir, savedFiles: snap.meta.savedFiles, bundles: bundles.length, plugins: plugins.length, skills: snap.meta.skills.length };
		setStage(job, "snapshot", "ok", snap.id + "（插件 " + bundles.length + " / 行 " + plugins.length + " / 技能 " + snap.meta.skills.length + "）");
		await this.save();

		/* ② 真写盘（自己会把「该拒绝的」拒掉：真实目录 / 不是 bundle / 装它自己） */
		setStage(job, "install", "running", "直连安装（不走 pnpm）：建链接 + 写两行 profile 配置…");
		const manifest = await readFile(join(sourceDir, "package.json"), "utf8").then((text) => JSON.parse(text)).catch(() => null);
		const applied = await applyLinkInstall({
			profileDir: profileDir(),
			name,
			sourceDir,
			manifest,
			backupDir: join(snap.dir, "profile")
		});
		if (!applied.ok) {
			setStage(job, "install", "fail", (applied.blocked && applied.blocked.text) || applied.error || "直连安装失败");
			const blocked = applied.blocked || null;
			job.install = { kind: "bundle", bundleName: name, mode: "link", ok: false, changed: false, error: { code: blocked ? blocked.code : "link-install-failed", message: (blocked && blocked.text) || applied.error || "直连安装失败" } };
			await this.save();
			return {
				ok: false,
				message: (blocked && blocked.text) || applied.error || "直连安装失败",
				plain: blocked ? blocked.plain : "大白话：目录或 profile 的状态跟预期不一样，所以一处都没改（面板不会半改半留）。",
				fix: blocked ? blocked.fix : [{ text: "看那条红色的阶段说明；profile 没有被改动" }],
				job: this.compactJob(job)
			};
		}
		job.install = {
			kind: "bundle",
			bundleName: name,
			mode: "link",
			spec: "link:" + String(sourceDir).replace(/\\/g, "/"),
			ok: true,
			changed: applied.changed === true,
			application: applied.changed ? "link" : "unchanged",
			noop: applied.changed !== true,
			link: { changes: applied.changes, verified: applied.verified, backup: applied.backup || null }
		};
		setStage(job, "install", "ok",
			applied.changed
				? "直连安装完成（建链接 + 写依赖行 + 加清单；一次 pnpm 都没跑）→ 重启 DSH 后加载"
				: "已经是直连安装，这次没有改动");
		job.notes = (job.notes || []).concat([
			"直连安装：node_modules/" + name + " → " + sourceDir + "；依赖行 link:；已加进 dsh.profile.bundles" +
			"（宿主半边要重启 DSH 才加载新代码；client.js 改动刷新页面即可）"
		]);
		if (job.error) job.error = null;
		await this.save();
		await this.log("link-install " + id + " name=" + name + " changed=" + (applied.changed === true) + (opts.reason ? " reason=" + String(opts.reason).slice(0, 40) : ""));

		await this.diagnoseAndClose(job);
		return { ok: true, job: this.compactJob(job), install: job.install };
	}

	/**
	 * R31：给 pnpm 的 `trustPolicyExclude` 加一条（例如被 `ERR_PNPM_TRUST_DOWNGRADE` 点名的那个包）。
	 *
	 * 为什么由面板来做：这是「放松一条供应链策略」的决定，但它必须在**一次失败的现场**里做 ——
	 * 让用户自己去 profile 里找一个 YAML 文件、手写两行、还要担心写坏缩进，等于把风险转成手工错误。
	 * 所以：面板给按钮（二次确认）+ 写前备份 + 写后复核 + 只加你点名的那一条（不做通配）。
	 *
	 * @param {string[]} entries `name` 或 `name@version`
	 */
	async addTrustExclude(entries) {
		const list = (Array.isArray(entries) ? entries : [entries]).map((e) => String(e || "").trim()).filter(Boolean);
		if (list.length === 0) return { ok: false, message: "没有指定要豁免的包" };
		const before = await readPolicy(profileDir()).catch(() => null);
		if (!before || before.ok === false) return { ok: false, message: "读不到 profile 的 pnpm-workspace.yaml：" + ((before && before.error) || "未知原因") };
		if (!before.policy) {
			return { ok: false, message: "这个 profile 没有开 trustPolicy，不需要豁免（那就不是这次失败的原因）" };
		}
		const result = await writeExclude({
			profileDir: profileDir(),
			entries: list,
			backupDir: join(this.dirs().snapshots, "trustpolicy-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))
		});
		if (!result.ok) return { ok: false, message: result.error || "写入失败", result };
		const after = await readPolicy(profileDir()).catch(() => null);
		await this.log("trustPolicyExclude +" + (result.added || []).join(",") + " (" + result.mode + ")");
		return {
			ok: true,
			changed: result.changed === true,
			added: result.added || [],
			skipped: result.skipped || [],
			mode: result.mode,
			file: result.file,
			backup: result.backup,
			line: after ? describePolicy(after) : null,
			message: result.changed
				? "已写进 profile 的 pnpm-workspace.yaml（备份：" + (result.backup || "").split(/[\\/]/).pop() + "）—— 回面板点「重试」即可"
				: (result.reason || "没有改动（这几条已经在列表里）")
		};
	}

	async planInput(desc, work, job) {
		/* 本地路径 */
		if (desc.kind === "local-path") {
			const info = await stat(desc.path);
			if (info.isDirectory()) {
				return { label: "本地目录：" + desc.path, localDir: desc.path, source: { type: "local", spec: desc.path } };
			}
			return { label: "本地文件：" + basename(desc.path), localFile: desc.path, source: { type: "local", spec: desc.path } };
		}
		/* npm spec：先取 tarball 以便静态扫描 */
		if (desc.kind === "npm-spec") {
			try {
				const resolved = await resolveNpmSpec(desc.spec);
				return {
					label: "npm：" + resolved.name + "@" + resolved.version,
					url: resolved.tarball,
					source: { type: "npm", spec: resolved.name + "@" + resolved.version, name: resolved.name, version: resolved.version }
				};
			} catch (e) {
				job.notes = ["npm 元数据读取失败（" + String((e && e.message) || e).slice(0, 120) + "）：跳过静态扫描，直接交给插件管理器"];
				return { label: "npm：" + desc.spec + "（未预扫描）", source: { type: "npm", spec: desc.spec } };
			}
		}
		/* GitHub */
		if (desc.kind === "github-repo" || desc.kind === "github-release") {
			const resolved = await resolveGithub(desc);
			job.notes = resolved.notes || [];
			job.repo = resolved.meta || null;
			if (resolved.meta && resolved.meta.stars !== undefined) {
				job.title = (resolved.meta.fullName || desc.label) + "（★" + resolved.meta.stars + "）";
			}
			return {
				label: (resolved.meta && resolved.meta.fullName ? resolved.meta.fullName : desc.label) + " · " + (resolved.kind === "release-asset" ? "Release 资产" : "源码归档"),
				url: resolved.url,
				source: { type: "github", spec: "github:" + desc.owner + "/" + desc.repo, name: null, version: null }
			};
		}
		/* 直链 */
		if (desc.kind === "archive-url") {
			return { label: desc.label, url: desc.url, source: { type: "tarball", spec: desc.url } };
		}
		throw new StageError("unsupported-input", "不支持的输入类型：" + desc.kind);
	}

	async checkCancel(job) {
		if (job.cancelRequested) {
			job.status = "cancelled";
			await this.save();
			throw new StageError("cancelled", "已取消");
		}
	}

	async fail(job, error) {
		if (error && error.code === "cancelled") {
			job.status = "cancelled";
			await this.save();
			return;
		}
		const runningStage = (job.stages || []).find((s) => s.status === "running");
		if (runningStage) runningStage.status = "fail";
		job.status = "failed";
		job.error = {
			code: (error && error.code) || "error",
			message: String((error && error.message) || error),
			hint: (error && error.hint) || null,
			stage: runningStage ? runningStage.key : null,
			/* R9：错误自带的「大白话」与处置步骤（面板直接渲染，不用再靠客户端猜） */
			plain: (error && error.plain) || null,
			kind: (error && error.kind) || null,
			fix: Array.isArray(error && error.fix) ? error.fix : null,
			/* R31：可点的处置按钮（例如「豁免 <pkg>@<ver>」「直连安装」）——
			   只放「面板真能执行」的动作，别给假按钮 */
			actions: Array.isArray(error && error.actions) ? error.actions : null
		};
		await this.save().catch(() => {});
		await this.log("fail " + job.id + " " + job.error.code + " " + job.error.message.slice(0, 400));
		/* R29：失败的这一单也可能动过 profile（装了又卸 / 换版本卸完没装回）——
		   记一次签名，好让「带外改动」的归因不被它污染。 */
		await this.noteJobProfile(job).catch(() => null);
	}

	/* ── AI 语义审查（可注入，缺失时优雅降级）───────────────────────── */

	async review(id) {
		const job = this.jobById(id);
		if (!job) return { ok: false, message: "没有这个任务" };
		if (!this.options.reviewer) {
			job.review = { status: "unavailable", verdict: null, at: nowIso(), findings: [], error: "AI 审查通道未启用" };
			await this.save();
			return { ok: false, message: "AI 审查通道未启用", job: this.compactJob(job) };
		}
		try {
			const result = await this.options.reviewer(job);
			job.review = result;
		} catch (e) {
			job.review = { status: "failed", verdict: "inconclusive", at: nowIso(), findings: [], error: String((e && e.message) || e) };
		}
		if (job.review && job.review.verdict === "malicious") {
			job.status = "failed";
			job.error = {
				code: "ai-malicious",
				message: "AI 语义审查判定恶意：" + ((job.review.findings[0] && job.review.findings[0].title) || ""),
				hint: "一键回滚到安装前快照（面板里有按钮）"
			};
			job.rollbackNeeded = true;
		}
		await this.save();
		return { ok: true, job: this.compactJob(job) };
	}

	/* ── 生态集成检测（复用现成管理器，不重复造轮子）────────────────── */

	async integrations(force = false) {
		if (!force && this._integrations && Date.now() - this._integrationsAt < 60000) return this._integrations;
		const pm = this.ctx.pluginManager;
		const bundles = pm && typeof pm.listBundles === "function" ? await pm.listBundles().catch(() => []) : [];
		const plugins = pm && typeof pm.listPlugins === "function" ? await pm.listPlugins().catch(() => []) : [];
		/* bundle 名 + 插件行名都算：官方管理器常常作为 base bundle 里的一行出现 */
		const names = new Set();
		for (const b of bundles || []) if (b && (b.name || b.packageName)) names.add(b.name || b.packageName);
		for (const p of plugins || []) {
			if (!p) continue;
			for (const key of [p.moduleName, p.name, p.id]) if (key) names.add(key);
		}
		const known = [
			["dsh-plugin-desk", "插件管家（停用/启用/安全卸载）"],
			["@deepseek-ai/dsh-plugin-manager", "官方插件管理器（用它装/停/卸）"],
			["dsh-skill-manage", "Skill 管理"],
			["dsh-skills-manager", "Skill 管理"],
			["dsh-skill-toggles", "技能分组启停"],
			["dsh-remote-mobile", "移动端接入（Tailscale + 扫码配对）"],
			["dsh-mobile-xc", "移动端 UI 适配"],
			["dsh-zen-remote", "锁屏推送"],
			["dsh-doctor", "安装后体检"],
			["dsh-plugin-guard", "危险能力扫描"],
			["dsh-activity-bell", "角标通知"],
			["dsh-diag", "客户端诊断通道"]
		];
		const found = known.map(([name, label]) => {
			let installed = names.has(name);
			/* 官方管理器的真凭据是服务在不在，不是清单里有没有这个名字 */
			if (!installed && name === "@deepseek-ai/dsh-plugin-manager") installed = Boolean(pm);
			return { name, label, installed };
		});
		let remote = null;
		try {
			const app = this.ctx.webApp;
			const url = app && typeof app.getAdvertisedUrl === "function" ? app.getAdvertisedUrl() : null;
			if (url) remote = { url, lan: !/127\.0\.0\.1|localhost/.test(url) };
		} catch {
			remote = null;
		}
		this._integrations = { bundles: found, remote, checkedAt: nowIso() };
		this._integrationsAt = Date.now();
		return this._integrations;
	}
}

function kindLabel(kind) {
	switch (kind) {
		case "bundle": return "DSH 插件";
		case "skill": return "Skill";
		case "profile": return "profile（不可安装）";
		default: return "未识别内容";
	}
}

function firstReason(pc) {
	const block = (pc.reasons || []).find((r) => r.level === "block") || (pc.reasons || [])[0];
	return block ? block.text : "未知原因";
}

/**
 * 从 profile manifest 里挑出「仍然指向 staging 的 file: 依赖」，返回那些 staging
 * 子目录名。纯函数，单测直接喂对象。
 */
export function stagingRefsFromManifest(pkg) {
	const names = new Set();
	const deps = (pkg && pkg.dependencies) || {};
	for (const spec of Object.values(deps)) {
		const text = String(spec || "");
		if (!text.startsWith("file:")) continue;
		const m = /(?:^|[\\/])staging[\\/]([^\\/]+)/.exec(text);
		if (m) names.add(m[1]);
	}
	return names;
}

/** 还没跑完、仍然可能需要 staging 现场的状态。 */
const ACTIVE_JOB_STATES = new Set(["queued", "running", "awaiting-confirm"]);

/**
 * prune 时**必须留着**的 staging 顶层名字（R5.1）。两类：
 *   ① profile 的 `file:` 依赖仍指向的目录（原逻辑，别删掉否则下次 pnpm 必炸）；
 *   ② **还没跑完的任务**引用的目录 + 任务自己的 id 目录（新）。
 *
 * ② 以前漏了，代价是：拖进来的包落在 `staging/uploads/<ts>/`、解包现场在
 * `staging/<jobId>/`，两者都只有 24 小时 mtime 保护。用户停在「等待确认」跨夜、
 * 第二天重启后再点确认 → 源已经被 prune 删了 → lost-state，而面板只会说
 * 「找不到解包现场（宿主可能重启过）」，看不出真正原因是清缓存。
 *
 * 纯函数（不碰文件系统），单测直接喂对象。
 * @param {object} pkg profile 的 package.json
 * @param {Array} jobs 任务列表
 * @returns {Set<string>} staging 下的顶层目录名；含 "*" 表示「什么都别删」
 */
export function stagingKeepNames(pkg, jobs) {
	const keep = stagingRefsFromManifest(pkg);
	for (const job of jobs || []) {
		if (!job || !ACTIVE_JOB_STATES.has(job.status)) continue;
		if (job.id) keep.add(String(job.id));
		let text = "";
		try {
			text = JSON.stringify([job.input || {}, job.source || {}]);
		} catch {
			continue;
		}
		const re = /staging[\\/]+([^\\/"']+)/g;
		let m;
		while ((m = re.exec(text)) !== null) keep.add(m[1]);
	}
	return keep;
}

export { STAGES, StageError };
