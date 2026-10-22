/**
 * skills.js — 「我装了哪些 Skill、它们会不会真的被用上」（R14）。
 *
 * 为什么要有它：面板标题从第一版起就写着「插件 / Skill 安装」，但它只回答过插件那一半 ——
 * 装了哪些技能、哪些宿主根本没认、哪些名字撞车、哪些备份还躺在技能根里，全都没有入口。
 * 而本机真出现过「技能装了却从不被自动调用」，根因都是**装上了但宿主认不出它**：
 * frontmatter 的 name 丢失 / 不是 kebab-case / 被同名目录顶掉。
 *
 * 判据分三层，缺一层就会给出假结论：
 *   ① 磁盘事实：技能根下每个目录的 SKILL.md（name / description / 大小 / mtime）；
 *   ② 宿主事实：`ctx.skills.list()` 的 SkillSummary（name / source / invocation）；
 *   ③ 对账：**磁盘有而宿主没认** = 装上了却用不上 —— 这正是面板以前答不出的那件事。
 *
 * ⚠️ 本模块只读：不发网络请求、不写任何文件、不删备份（清理是人的决定）。
 * ⚠️ 不冒充加载器：条目来自磁盘，宿主清单只用来对账；读不到宿主清单时如实说
 *    「对账不了」，而不是把每个技能都标成「没被认」。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseSkillFrontmatter } from "./detect.js";

/** SKILL.md 只读前面这么多字节：frontmatter 在头部，正文再长也无关。 */
const DEFAULT_MAX_BYTES = 512 * 1024;

/** 备份目录的形态：`xxx.bak-20261017-1350` / `xxx.bak` / `xxx.bak.1`。 */
const BACKUP_RE = /\.bak(?:[.\-_]|$)/i;

/**
 * 目录名是不是一份备份（R14）。
 *
 * 为什么单独判：备份目录里通常也有 SKILL.md，而且 frontmatter 的 name 与正式那份**相同** ——
 * 于是它在「重名」这项里必然出现。不把它认出来，面板就会把 4 个备份说成「4 组重名」。
 */
export function skillBackupInfo(dirName) {
	const name = String(dirName || "");
	const at = name.search(BACKUP_RE);
	if (at <= 0) return { backup: false, backupOf: null };
	return { backup: true, backupOf: name.slice(0, at) };
}

/** 宿主给的 source → 人话（未知值原样透出，不吞）。 */
export function skillSourceLabel(source) {
	const map = {
		"user-dsh": "用户级（.$DSH/skills）",
		"user-agents": "用户级（agents）",
		"project-dsh": "项目级",
		"project-agents": "项目级（agents）",
		"custom": "自定义根",
		"bundled": "随宿主自带",
		"runtime": "运行时注册"
	};
	const key = String(source || "");
	return map[key] || key || null;
}

/**
 * 扫技能根，读每个目录的 SKILL.md（只读）。
 *
 * 根不存在 = 这个 profile 还没装过技能，**不是错误**：返回空表，由调用方决定怎么讲。
 *
 * @param {{roots?: string[], maxBytes?: number}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function readSkillsOnDisk(options = {}) {
	const roots = (Array.isArray(options.roots) ? options.roots : []).filter((root) => typeof root === "string" && root);
	const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
	const items = [];
	for (const root of roots) {
		let entries = [];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			const dirPath = join(root, entry.name);
			const filePath = join(dirPath, "SKILL.md");
			const item = {
				dir: entry.name,
				root,
				path: dirPath,
				file: filePath,
				hasFile: false,
				name: null,
				description: null,
				whenToUse: null,
				yamlIssue: null,
				valid: false,
				reasons: [],
				bytes: 0,
				mtime: null,
				...skillBackupInfo(entry.name)
			};
			try {
				const info = await stat(filePath);
				item.hasFile = info.isFile();
				item.bytes = info.size;
				item.mtime = info.mtime.toISOString();
			} catch {
				item.reasons.push("目录里没有 SKILL.md（宿主不会把它当成技能）");
			}
			if (item.hasFile) {
				try {
					const text = await readFile(filePath, "utf8");
					const meta = parseSkillFrontmatter(text.length > maxBytes ? text.slice(0, maxBytes) : text);
					item.name = meta.name || null;
					item.description = meta.description || null;
					item.whenToUse = meta.whenToUse || null;
					item.yamlIssue = meta.yamlIssue || null;
					item.valid = meta.valid === true;
					item.reasons = Array.isArray(meta.reasons) ? meta.reasons.slice() : [];
				} catch (e) {
					item.hasFile = false;
					item.reasons.push("读不了 SKILL.md：" + String((e && e.message) || e));
				}
			}
			items.push(item);
		}
	}
	items.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
	return items;
}

/**
 * 把「磁盘事实 + 宿主清单」对成一份可展示、可断言的视图（纯函数，方便单测）。
 *
 * @param {{roots?: string[], items?: Array<object>, host?: Array<object>|null, hostComplete?: boolean|null,
 *   hostError?: string|null, panelInstalled?: Array<{name?:string, jobId?:string, at?:string}>|null}} [options]
 * @returns {object}
 */
export function buildSkillView(options = {}) {
	const at = new Date().toISOString();
	const roots = (Array.isArray(options.roots) ? options.roots : []).filter(Boolean);
	const items = Array.isArray(options.items) ? options.items : [];
	const hostKnown = Array.isArray(options.host);
	const hostList = hostKnown ? options.host : [];
	const panelNames = new Map();
	for (const entry of Array.isArray(options.panelInstalled) ? options.panelInstalled : []) {
		const key = String((entry && entry.name) || "").toLowerCase();
		if (key) panelNames.set(key, entry);
	}

	/* 宿主清单按 name 建索引（技能名是 kebab-case；大小写不敏感只为了让脏数据也能对上） */
	const hostByName = new Map();
	for (const entry of hostList) {
		const key = String((entry && entry.name) || "").toLowerCase();
		if (!key) continue;
		if (!hostByName.has(key)) hostByName.set(key, entry);
	}

	const rows = items.map((item) => {
		const key = String(item.name || "").toLowerCase();
		const host = key ? hostByName.get(key) || null : null;
		const invocation = (host && host.invocation) || null;
		const panel = key ? panelNames.get(key) || null : null;
		return {
			...item,
			hostVisible: Boolean(host),
			source: host ? host.source || null : null,
			sourceLabel: host ? skillSourceLabel(host.source) : null,
			provider: host ? host.provider || null : null,
			/* 缺 invocation 时按「允许」算：这是宿主契约里的默认值方向，不能凭空造一个「不能调用」 */
			modelInvocable: host ? !(invocation && invocation.modelInvocable === false) : null,
			userInvocable: host ? !(invocation && invocation.userInvocable === false) : null,
			installedByPanel: Boolean(panel),
			panelJobId: panel ? panel.jobId || null : null,
			duplicate: false
		};
	});

	/* 重名：同一层里两个目录给出同一个 name —— 宿主只会用其中一份 */
	const groups = new Map();
	for (const row of rows) {
		if (!row.name) continue;
		const key = row.name.toLowerCase();
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(row);
	}
	const duplicates = [];
	for (const [name, list] of groups) {
		if (list.length < 2) continue;
		duplicates.push({ name, dirs: list.map((row) => row.dir), backups: list.filter((row) => row.backup).map((row) => row.dir) });
		for (const row of list) row.duplicate = true;
	}
	duplicates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const real = rows.filter((row) => !row.backup);
	const backups = rows.filter((row) => row.backup);
	const invalid = real.filter((row) => !row.hasFile || !row.valid);
	/* R14：「YAML 写坏了」与「宿主没认」是两种病 —— 一个能改好（改 frontmatter 写法），
	   一个要查加载顺序/优先级。混在一起说，人就只能重启试试。 */
	const yamlBroken = real.filter((row) => row.hasFile && row.yamlIssue);
	/* 「宿主没认」只在能对账时才算：读不到宿主清单 ≠ 每个技能都没被认 */
	const notVisible = hostKnown
		? real.filter((row) => row.hasFile && row.valid && !row.yamlIssue && !row.hostVisible)
		: [];
	const modelInvisible = hostKnown
		? rows.filter((row) => row.hostVisible && row.modelInvocable === false)
		: [];
	const onDisk = new Set(rows.map((row) => String(row.name || "").toLowerCase()).filter(Boolean));
	const hostOnly = hostKnown ? hostList.filter((entry) => entry && entry.name && !onDisk.has(String(entry.name).toLowerCase())) : [];

	const counts = {
		roots: roots.length,
		dirs: rows.length,
		skills: real.length,
		valid: real.filter((row) => row.hasFile && row.valid).length,
		backups: backups.length,
		hostTotal: hostKnown ? hostList.length : null,
		hostVisible: real.filter((row) => row.hostVisible).length,
		notVisible: notVisible.length,
		yamlBroken: yamlBroken.length,
		invalid: invalid.length,
		duplicates: duplicates.length,
		duplicateDirs: duplicates.reduce((sum, group) => sum + group.dirs.length, 0),
		modelInvisible: modelInvisible.length,
		hostOnly: hostOnly.length,
		byPanel: real.filter((row) => row.installedByPanel).length
	};

	const notes = [];
	if (!roots.length) notes.push("认不出技能根目录（DSH_HOME / profile 都不可用）");
	if (!hostKnown) {
		notes.push(options.hostError === "no-service"
			? "这台宿主的 Skill 服务不可用，没法对账「宿主认了哪些」"
			: "读不到宿主技能清单（" + (options.hostError || "原因不明") + "），只能列磁盘上的目录");
	}
	if (options.hostComplete === false) notes.push("宿主这次扫描没走完（complete=false），个别技能可能只是还没扫到");

	return {
		ok: roots.length > 0,
		at,
		roots,
		items: sortRows(rows),
		counts,
		duplicates,
		notVisible: notVisible.map((row) => ({ dir: row.dir, name: row.name })),
		yamlBroken: yamlBroken.map((row) => ({
			dir: row.dir,
			code: row.yamlIssue.code,
			message: row.yamlIssue.message,
			fix: row.yamlIssue.fix
		})),
		invalid: invalid.map((row) => ({ dir: row.dir, reasons: row.reasons })),
		modelInvisible: modelInvisible.map((row) => ({ dir: row.dir, name: row.name })),
		hostOnly: hostOnly.slice(0, 20).map((entry) => ({ name: entry.name, source: entry.source || null })),
		host: { available: hostKnown, total: hostKnown ? hostList.length : null, complete: options.hostComplete === true ? true : options.hostComplete === false ? false : null, error: options.hostError || null },
		summary: summarizeSkills(counts, { hostKnown }),
		notes
	};
}

/** 面板顺序：先「有问题」，再备份，最后正常；同档按目录名。 */
function sortRows(rows) {
	const rank = (row) => {
		if (row.hasFile && row.yamlIssue) return 0;
		if (!row.hasFile || !row.valid) return 1;
		if (row.hostVisible === false && !row.backup) return 2;
		if (row.duplicate) return 3;
		if (row.backup) return 4;
		if (row.modelInvocable === false) return 5;
		return 6;
	};
	return rows.slice().sort((a, b) => rank(a) - rank(b) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * 一行摘要（面板与工具共用同一句话 —— 两套口径是最容易出假结论的地方）。
 */
export function summarizeSkills(counts, options = {}) {
	if (!counts) return "读不到技能清单";
	if (!counts.roots) return "认不出技能根目录";
	const hostKnown = options.hostKnown !== false && counts.hostTotal !== null && counts.hostTotal !== undefined;
	const parts = [];
	parts.push(counts.skills + " 个技能");
	if (hostKnown) {
		parts.push("宿主认 " + counts.hostTotal + " 个");
		if (counts.notVisible) parts.push(counts.notVisible + " 个没被认");
	} else {
		parts.push("宿主清单读不到");
	}
	if (counts.yamlBroken) parts.push(counts.yamlBroken + " 个 frontmatter 写坏了（宿主读不了）");
	if (counts.backups) parts.push(counts.backups + " 个备份残留");
	if (counts.duplicates) parts.push(counts.duplicates + " 组重名");
	if (counts.invalid) parts.push(counts.invalid + " 个 SKILL.md 不完整");
	/* 只在真的发生时提 —— 否则这一行会变成没人读的墙 */
	if (counts.modelInvisible) parts.push(counts.modelInvisible + " 个不会自动调用");
	return parts.join(" · ");
}

/** 名字列表 → 「a、b、c 等 N 个」。 */
function joinNames(list, limit = 5) {
	const names = (list || []).map((item) => (typeof item === "string" ? item : item && (item.name || item.dir))).filter(Boolean);
	if (!names.length) return "";
	const head = names.slice(0, limit).join("、");
	return names.length > limit ? head + " 等 " + names.length + " 个" : head;
}

/**
 * 体检结论（doctor / 下次装完诊断都用它）。
 *
 * 每条都必须带 `plain`（大白话）与 `fix`（怎么办）—— 只报症状的结论是半成品。
 */
export function skillFindings(view) {
	const findings = [];
	const counts = (view && view.counts) || null;
	if (!counts || !view.ok) return findings;

	if (counts.yamlBroken > 0) {
		const first = (view.yamlBroken || [])[0];
		findings.push({
			severity: "error",
			code: "skill-yaml-invalid",
			title: counts.yamlBroken + " 个技能的 frontmatter 不是合法 YAML（宿主连 name 都读不出来，整条跳过）",
			detail: (view.yamlBroken || []).map((item) => item.dir + "：" + item.message).slice(0, 4).join(" · "),
			plain: "大白话：这些 SKILL.md 的 name 与 description 都写得好好的，但 frontmatter 里有个字符让 YAML 报错" +
				"（最常见是描述里出现「冒号 + 空格」，又没加引号）—— 于是宿主读不出 name，干脆把这个技能跳过。" +
				"表现不是「没装」，而是「装了却永远用不上」。",
			fix: [
				{ text: first ? first.fix : "把那行值改成块标量（`key: >` 再缩进两格写正文）或用引号包起来" },
				{ text: "改完点面板上的「刷新」（宿主会重扫技能目录），这一条应消失" }
			]
		});
	}
	if (counts.notVisible > 0) {
		findings.push({
			severity: "error",
			code: "skill-not-visible",
			title: counts.notVisible + " 个技能目录宿主没认（装了但用不上）",
			detail: "磁盘上有 SKILL.md 且 frontmatter 完整，但宿主清单里没有它们：" + joinNames(view.notVisible) +
				"（技能根 " + (view.roots[0] || "?") + "）",
			plain: "大白话：文件在技能目录里，宿主却不认为它是一个技能 —— 于是它永远不会被自动用上。" +
				"最常见的原因是 SKILL.md 顶部 frontmatter 的 name 丢了、不是小写连字符，或者同名技能里优先级更高的那份赢了。",
			fix: [
				{ text: "打开这些目录，确认 SKILL.md 第一段 frontmatter 同时有 name（小写连字符）与 description" },
				{ text: "改完不用重启：宿主会重扫技能目录，再点面板上的「刷新」" },
				{ text: "如果磁盘上有同名目录，先把备份/旧版挪出技能根（见下面「备份残留」那条）" }
			]
		});
	}
	if (counts.invalid > 0) {
		findings.push({
			severity: "warn",
			code: "skill-invalid-frontmatter",
			title: counts.invalid + " 个技能目录的 SKILL.md 不完整",
			detail: (view.invalid || []).map((item) => item.dir + "（" + (item.reasons || []).join("；") + "）").slice(0, 6).join(" · "),
			plain: "大白话：这些目录缺 SKILL.md，或文件头那段 frontmatter 少了 name / description。宿主不会把它当成技能。",
			fix: [
				{ text: "补一份 SKILL.md：开头写两条 `---` 夹住的 name 与 description" },
				{ text: "没在用的目录直接删掉，别让它留在技能根里误导下一次排查" }
			]
		});
	}
	if (counts.duplicates > 0) {
		findings.push({
			severity: "warn",
			code: "skill-duplicate-name",
			title: counts.duplicates + " 组技能重名（宿主只会用其中一份）",
			detail: (view.duplicates || []).map((group) => group.name + " ← " + group.dirs.join(" / ")).slice(0, 6).join(" · "),
			plain: "大白话：两份目录声明了同一个技能名，宿主只能挑一份生效 —— 你以为在用的那份不一定就是生效的那份。",
			fix: [
				{ text: "备份（名字里带 .bak）是历史遗留：确认新版没问题后把它挪出技能根或删掉" },
				{ text: "真要两份并存，就把其中一份的 frontmatter name 改掉（目录名也一起改）" }
			]
		});
	}
	if (counts.backups > 0) {
		findings.push({
			severity: "info",
			code: "skill-backup-leftover",
			title: counts.backups + " 个备份目录还留在技能根里",
			detail: (view.items || []).filter((row) => row.backup).map((row) => row.dir).slice(0, 8).join("、"),
			plain: "大白话：这些是覆盖安装时留下的旧副本。它们带着同样的技能名，会让「到底哪份在生效」变得说不清。",
			fix: [
				{ text: "在资源管理器里把它们移到技能根之外（面板不替你删文件）" },
				{ text: "要留证据就先压缩存档，别用 .bak 目录当存档" }
			]
		});
	}
	if (counts.modelInvisible > 0) {
		findings.push({
			severity: "info",
			code: "skill-model-invisible",
			title: counts.modelInvisible + " 个技能不会被模型自动调用",
			detail: "宿主把它们标成 modelInvocable=false：" + joinNames(view.modelInvisible),
			plain: "大白话：这些技能只能由你显式点名使用，模型不会自己挑到它们。这是宿主侧的设置，不是坏了。",
			fix: [
				{ text: "想让它自动生效：改宿主那边该技能的调用策略（invocation），不是在面板里改" },
				{ text: "不确定就先这样：需要时手动点名调用即可" }
			]
		});
	}
	return findings;
}
