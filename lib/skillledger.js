/**
 * skillledger.js — Skill 的来源台账（R38）。
 *
 * 为什么要有它：Skill 不是 registry 包，没有统一的版本号。想知道「这个技能有没有更新」，
 * 唯一可靠的办法是**在安装时记下它是从哪个仓库、哪个 commit、仓库里的哪个目录装的**，
 * 之后拿这三个坐标去问来源仓库「这个目录现在最新的 commit 是哪个」。
 *
 * 三条纪律（和 MCP 台账一致）：
 *  ① 只在**安装成功之后**写；写不进去只记 note，绝不让一次成功的安装变失败；
 *  ② 写盘用 tmp + rename（原子），读不到 / 坏文件一律当空台账，不抛；
 *  ③ 台账是**事实**不是判断 —— 没有记录就是「无法判断」，不许编造「最新」。
 *
 * 还多一条针对 Skill 的：记录安装时的**目录指纹**（所有文件排序后哈希）。
 * 用户/模型会在使用过程中就地改技能；有了指纹才能分清
 * 「来源有新提交」与「本地也改过」—— 后者重新安装会覆盖掉用户的改动。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SKILL_LEDGER_VERSION = 1;

/** 台账键：技能目录名小写（安装时落位目录 = 技能名）。 */
export function skillLedgerKey(dir) {
	return String(dir || "").trim().toLowerCase();
}

/**
 * 读台账。返回 `{version, items}`；任何异常都退化成空台账。
 * 键统一小写 —— 手工改过文件、大小写不一致时也能对上。
 */
export async function readSkillLedger(file) {
	if (!file) return { version: SKILL_LEDGER_VERSION, items: {} };
	try {
		const data = JSON.parse(await readFile(file, "utf8"));
		if (data && typeof data === "object" && data.items && typeof data.items === "object") {
			const items = {};
			for (const [key, value] of Object.entries(data.items)) {
				if (value && typeof value === "object") items[skillLedgerKey(key)] = value;
			}
			return { version: SKILL_LEDGER_VERSION, items };
		}
	} catch {
		/* 读不到 / 坏文件 → 空台账 */
	}
	return { version: SKILL_LEDGER_VERSION, items: {} };
}

/** 记一笔 Skill 来源（原子写；同一目录覆盖旧记录）。 */
export async function recordSkillSource(file, entry) {
	const key = entry && skillLedgerKey(entry.dir || entry.skill);
	if (!file || !key) return { ok: false, reason: "缺 dir / ledger 路径" };
	const current = await readSkillLedger(file);
	const items = { ...current.items, [key]: { ...entry, dir: entry.dir || entry.skill, at: entry.at || new Date().toISOString() } };
	await mkdir(dirname(file), { recursive: true });
	const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
	await writeFile(tmp, JSON.stringify({ version: SKILL_LEDGER_VERSION, items }, null, 2) + "\n", "utf8");
	await rename(tmp, file);
	return { ok: true, file, item: items[key] };
}

/** 删一笔（技能被删/搬走后清理；不做自动 GC，只给显式入口用）。 */
export async function forgetSkillSource(file, dir) {
	const key = skillLedgerKey(dir);
	const current = await readSkillLedger(file);
	if (!current.items[key]) return { ok: true, removed: false };
	const items = { ...current.items };
	delete items[key];
	await mkdir(dirname(file), { recursive: true });
	const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
	await writeFile(tmp, JSON.stringify({ version: SKILL_LEDGER_VERSION, items }, null, 2) + "\n", "utf8");
	await rename(tmp, file);
	return { ok: true, removed: true };
}

/**
 * 技能目录指纹：递归所有普通文件（跳过 .git），按相对路径排序后
 * 把「相对路径 + 字节数 + 内容」逐条喂给 sha256。
 *
 * 为什么要整目录而不是只哈希 SKILL.md：用户/模型改写脚本、示例、参考文件
 * 同样会让「重新安装」覆盖掉本地成果。只盯入口文件会漏掉大部分改动。
 */
export async function hashSkillDir(dir) {
	const files = [];
	async function walk(current, rel) {
		let entries = [];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const relPath = rel ? rel + "/" + entry.name : entry.name;
			const path = join(current, entry.name);
			if (entry.isDirectory()) await walk(path, relPath);
			else if (entry.isFile()) files.push([relPath, path]);
		}
	}
	await walk(dir, "");
	files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const hash = createHash("sha256");
	for (const [rel, path] of files) {
		let buf;
		try {
			buf = await readFile(path);
		} catch {
			continue;
		}
		hash.update(rel);
		hash.update("\0");
		hash.update(String(buf.length));
		hash.update("\0");
		hash.update(buf);
	}
	return hash.digest("hex");
}

/** 来源归一化：只留能用于比对的字段，外部传进来的杂项不落台账。 */
export function normalizeSkillSource(source) {
	const raw = source && typeof source === "object" ? source : {};
	const type = ["github", "local", "tarball", "npm", "unknown"].includes(raw.type) ? raw.type : "unknown";
	const out = {
		type,
		/* github 的两种下载形态：source-archive（可重装）/ release-asset（地址会变，不自动重装） */
		kind: raw.kind ? String(raw.kind).slice(0, 40) : null,
		spec: String(raw.spec || "").slice(0, 500) || null,
		owner: type === "github" ? String(raw.owner || "").slice(0, 120) || null : null,
		repo: type === "github" ? String(raw.repo || "").slice(0, 120) || null : null,
		ref: type === "github" ? String(raw.ref || "").slice(0, 200) || null : null,
		commit: type === "github" ? String(raw.commit || "").slice(0, 40) || null : null,
		/* null = 当时没记路径（不能拿仓库根顶替）；"" = 技能就在仓库根 */
		path: type === "github"
			? (raw.path === undefined || raw.path === null ? null : String(raw.path).replace(/^\/+|\/+$/g, "").slice(0, 400))
			: null,
		version: raw.version ? String(raw.version).slice(0, 80) : null,
		url: raw.url ? String(raw.url).slice(0, 800) : null
	};
	return out;
}

/**
 * 组装一条台账记录（纯函数，便于自测）。
 * @param {{skill?:string, dir:string, root?:string, source:object, digest?:string, jobId?:string, at?:string}} input
 */
export function buildSkillLedgerEntry(input) {
	const raw = input && typeof input === "object" ? input : {};
	const dir = String(raw.dir || raw.skill || "").trim();
	if (!dir) return null;
	const source = normalizeSkillSource(raw.source);
	return {
		dir,
		skill: String(raw.skill || dir).trim() || dir,
		root: raw.root ? String(raw.root) : null,
		source,
		digest: raw.digest ? String(raw.digest) : null,
		jobId: raw.jobId ? String(raw.jobId) : null,
		at: raw.at || new Date().toISOString()
	};
}

/** 台账记录翻成一句人话（面板 / 工具共用）。 */
export function describeSkillSource(entry) {
	const source = entry && entry.source;
	if (!source) return null;
	if (source.type === "github") {
		const repo = source.owner && source.repo ? source.owner + "/" + source.repo : source.spec || "GitHub";
		const short = source.commit ? source.commit.slice(0, 8) : null;
		const where = source.path ? " · " + source.path : "";
		return "GitHub " + repo + (short ? " @" + short : "") + where;
	}
	if (source.type === "local") return "本机目录" + (source.spec ? "：" + source.spec : "");
	if (source.type === "tarball") return "压缩包直链" + (source.spec ? "：" + source.spec : "");
	if (source.type === "npm") return "npm" + (source.spec ? "：" + source.spec : "");
	return "来源未知";
}

/**
 * R38：Skill 更新检查。
 *
 * 只有当台账里有 **GitHub 坐标 + commit** 时才联网比；其余一律如实 `unknown`：
 *  · 本地目录 / 压缩包 / npm 来源 → 没有可比的远端；
 *  · 旧记录没记 commit → 不知道当时装的是哪一版，不能拿「最新」冒充；
 *  · 没有台账（存量 58 个技能）→ 根本不进这张表，由调用方在摘要里报「无来源记录」。
 *
 * `fetchPathCommits` 可注入（测试不联网）；它应返回 `{sha, date, message}` 或抛错。
 */
export async function checkSkillUpdates({ items, ledger, digests, fetchPathCommits, at = new Date().toISOString() } = {}) {
	const rows = (Array.isArray(items) ? items : []).filter((row) => row && !row.backup);
	const byKey = ledger && ledger.items ? ledger.items : {};
	const digestOf = digests && typeof digests === "object" ? digests : {};
	const entries = [];
	for (const row of rows) {
		const key = skillLedgerKey(row.dir);
		const record = key ? byKey[key] : null;
		if (!record) continue;
		const source = record.source || {};
		const base = {
			dir: row.dir,
			name: row.name || row.dir,
			sourceLabel: describeSkillSource(record),
			installedAt: record.at || null,
			localCommit: source.commit || null,
			latestCommit: null,
			relation: "unknown",
			locallyEdited: Boolean(record.digest && digestOf[row.dir] && record.digest !== digestOf[row.dir]),
			error: null,
			reason: ""
		};
		if (source.type !== "github") {
			entries.push({ ...base, reason: "来源不是 GitHub 仓库（" + (describeSkillSource(record) || "未知") + "），没有可比的远端" });
			continue;
		}
		if (!source.owner || !source.repo) {
			entries.push({ ...base, reason: "台账里没有仓库坐标（当时没记 owner/repo）" });
			continue;
		}
		if (!source.commit) {
			entries.push({ ...base, reason: "台账里没记 commit（当时没取到），无法判断装的是哪一版" });
			continue;
		}
		if (source.path === null) {
			entries.push({ ...base, reason: "台账里没记技能在仓库里的路径，无法只比这个目录" });
			continue;
		}
		try {
			/* ref 是分支/标签时一并传（查同一个分支上的路径）；40 位 sha 不能传 ——
			   那会把「装的那一刻」当成比较基准，永远等于自己。 */
			const ref = source.ref && !/^[0-9a-f]{40}$/i.test(source.ref) ? source.ref : null;
			const latest = await fetchPathCommits(source.owner, source.repo, source.path || "", ref);
			const sha = latest && latest.sha ? String(latest.sha) : "";
			if (!sha) throw new Error("来源仓库没有返回 commit");
			entries.push({
				...base,
				latestCommit: sha,
				relation: sha === source.commit ? "current" : "outdated",
				error: null
			});
		} catch (e) {
			entries.push({ ...base, error: String((e && e.message) || e).slice(0, 160), reason: "查不到来源仓库的最新 commit" });
		}
	}
	const tracked = entries.length;
	const untracked = rows.length - tracked;
	const summary = {
		at,
		skills: rows.length,
		tracked,
		untracked,
		checked: entries.filter((entry) => entry.sourceLabel && entry.relation !== "unknown").length,
		current: entries.filter((entry) => entry.relation === "current").length,
		outdated: entries.filter((entry) => entry.relation === "outdated").length,
		unknown: entries.filter((entry) => entry.relation === "unknown").length,
		locallyEdited: entries.filter((entry) => entry.locallyEdited).length
	};
	return { at, summary, items: entries };
}

/** 台账里这条技能能不能重装（能不能重装 = 有没有完整的 GitHub 坐标）。 */
export function planSkillReinstall(entry) {
	const source = entry && entry.source;
	if (!source || source.type !== "github") {
		return { ok: false, reason: "no-source", message: "这个技能不是从 GitHub 仓库装的（来源：" + (describeSkillSource(entry) || "未知") + "），没有可重装的来源" };
	}
	if (!source.owner || !source.repo) {
		return { ok: false, reason: "no-repo", message: "台账里没有仓库坐标，无法重装" };
	}
	if (source.kind && source.kind !== "source-archive") {
		return { ok: false, reason: "asset-source", message: "这个技能是从 Release 资产装的（地址会随版本变），不自动重装；想更新就重新下载同一个 Release 再装" };
	}
	if (source.path === null) {
		return { ok: false, reason: "no-path", message: "台账里没记技能在仓库里的路径，重装可能会装错技能" };
	}
	return {
		ok: true,
		owner: source.owner,
		repo: source.repo,
		ref: source.ref || null,
		subdir: source.path || null,
		skill: entry.skill || entry.dir || null
	};
}
