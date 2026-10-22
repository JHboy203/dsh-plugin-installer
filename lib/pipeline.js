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
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { classifyInput } from "./urls.js";
import { DEFAULT_LIMITS, UNSUPPORTED_HINT, extractToDir, sniffFormat } from "./formats.js";
import { detectKind } from "./detect.js";
import { installScripts as collectScripts, scanTree } from "./scan.js";
import { npmReputation, precheck } from "./precheck.js";
import { downloadToFile, resolveGithub, resolveNpmSpec } from "./download.js";
import { searchAll } from "./sources.js";
import { createSnapshot, pruneSnapshots, readSnapshotMeta, restoreProfileFiles, restoreSkill } from "./snapshot.js";
import { diagnose, installPlugin, installSkill } from "./install.js";
import { quarantineDshTools, removeDanglingLink } from "./landmine.js";
import { applyRepairs, inspectEnvironment } from "./repair.js";
import { inspectProfile, repairProfile } from "./profilehealth.js";
import { pendingBuildFinding, readBuildPolicy } from "./installfailure.js";
import { exemptionTarget, grantExemption, readExemptions, summarizeExemptions } from "./exemptions.js";
import { buildStamp, dataDir, firstExistingDir, hostVersions, installedPluginInfo, profileDir, profileName, skillRoots } from "./hostinfo.js";
import { readInventory, summarizeInventory, annotateInstalled } from "./inventory.js";
import { buildSkillView, planSkillPark, readSkillsOnDisk, skillFindings, summarizeSkills } from "./skills.js";
import { activationFindings, scanActivation, summarizeActivation } from "./activation.js";
import { checkUpdates as runUpdateCheck, mergeUpdates, summarizeUpdates } from "./updates.js";
import { mergeSettings, loadSettings, normalizeSettings, saveSettings } from "./settings.js";

const STAGES = [
	{ key: "input", label: "① 输入接入" },
	{ key: "download", label: "② 下载" },
	{ key: "unpack", label: "③ 解包与格式探测" },
	{ key: "detect", label: "④ 识别与分类" },
	{ key: "precheck", label: "⑤ 安全预检" },
	{ key: "confirm", label: "⑥ 等待确认" },
	{ key: "snapshot", label: "⑦ 安装前快照" },
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
		   走到 job.error，面板不用再猜该显示什么。 */
		if (extra && typeof extra === "object") {
			if (extra.plain) this.plain = String(extra.plain);
			if (Array.isArray(extra.fix)) this.fix = extra.fix;
			if (extra.kind) this.kind = String(extra.kind);
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

export class Installer {
	constructor({ ctx, options = {} }) {
		this.ctx = ctx;
		this.options = options;
		this.root = dataDir();
		this.statePath = join(this.root, "state.json");
		this.jobs = [];
		this.activeId = null;
		this._running = null;
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
				if (!found) continue;
				job.status = "done";
				job.error = null;
				job.install = {
					...(job.install || {}),
					kind: "bundle",
					bundleName: name,
					ok: true,
					application: found.enabled === false ? "installed-disabled" : "applied",
					note: "宿主在这次安装中途重启；重启后插件清单里已经有它了"
				};
				setStage(job, "install", "ok", "宿主中途重启，重启后已确认安装完成");
				try {
					job.diagnosis = await diagnose({ pluginManager: pm, skills: this.ctx.skills, job });
					const v = job.diagnosis.verdict;
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
		return {
			items: annotateInstalled(found.items.map((item) => ({
				source: item.source,
				name: item.name,
				version: item.version,
				description: item.description,
				stars: item.stars,
				downloads: item.downloads,
				updatedAt: item.updatedAt,
				spec: item.spec,
				url: item.url,
				trust: item.trust,
				popularity: item.popularity,
				rankScore: item.rankScore
			})), inv),
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
		if (install.bundleName) {
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
		job.rollback = { done: true, at: nowIso(), results };
		if (job.error) {
			/* 回滚之后那条错误不该继续占着红字：原样记进回滚结果里留痕 */
			results.push({ step: "回滚前的错误（留痕）", was: job.error.code, message: job.error.message });
			job.error = null;
		}
		job.status = "rolled-back";
		setStage(job, "install", "skip", "已回滚");
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
				settings: this.settings
			});
			job.precheck = compactPrecheck(pc);
			setStage(job, "precheck", pc.blocked ? "fail" : pc.needsConfirm ? "warn" : "ok",
				pc.blocked ? "阻断：" + firstReason(pc) : pc.needsConfirm ? "需要确认：" + pc.risks.summary : "通过 · " + pc.risks.summary);
			await this.save();

			if (pc.blocked) {
				throw new StageError("precheck-blocked", "安全预检阻断安装：" + firstReason(pc),
					(pc.fixes && pc.fixes[0] && pc.fixes[0].label) || "看面板里的「下一步」");
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
		}
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
		await this.save();
		await this.checkCancel(job);

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
			const result = await installPlugin({
				pluginManager: this.ctx.pluginManager,
				detected,
				source: plan.source,
				packDir,
				approvedBuilds
			});
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
			setStage(job, "install", result.ok || noop ? "ok" : "fail",
				result.ok || noop
					? (noop
						? "已经装过（依赖已在 profile 里），这次没有改动 —— 下面照常诊断"
						: ("已安装（" + (result.application || "applied") + "，" + Math.round((result.elapsedMs || 0) / 1000) + "s" +
							(result.packed ? "，重打包 " + result.packed.files + " 个文件" : "") +
							(approvedBuilds && approvedBuilds.length ? "，已批准 " + approvedBuilds.length + " 个包的安装脚本" : "") + "）"))
					: (failure && failure.title) || (result.error && result.error.message) || "安装失败");
			if (noop) {
				job.notes = (job.notes || []).concat(["宿主回执 already-installed：这份依赖已在 profile 里，本次没有改动；正在为它重新诊断"]);
			}
			if (!result.ok && !noop) {
				throw new StageError(
					"install-failed",
					(failure && failure.title) || (result.error && result.error.message) || "package manager 报告安装失败",
					(failure && failure.hint) || (result.result && result.result.nextStep) || "看面板里的详细输出与回滚按钮",
					failure ? { plain: failure.plain, fix: failure.fix, kind: failure.kind } : null
				);
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

		/* ⑧ 诊断 */
		setStage(job, "diagnose", "running");
		let diagnosis = null;
		try {
			diagnosis = await diagnose({ pluginManager: this.ctx.pluginManager, skills: this.ctx.skills, job });
		} catch (e) {
			diagnosis = { verdict: "warn", findings: [{ severity: "warn", title: "诊断本身失败", detail: String((e && e.message) || e), action: null }], inventory: {} };
		}
		job.diagnosis = diagnosis;
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
			fix: Array.isArray(error && error.fix) ? error.fix : null
		};
		await this.save().catch(() => {});
		await this.log("fail " + job.id + " " + job.error.code + " " + job.error.message.slice(0, 400));
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
