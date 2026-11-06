/**
 * skillpatch.js — R49：把「你改过的技能」导出成一份 patch。
 *
 * 为什么要有它（B 站评论原话，三条反馈之一）：
 *   「『改过不覆盖』得配 patch 导出，否则永远吃不到上游更新。」
 *
 * 现状的坑：本面板对 Skill 的保护是**两选一** ——
 *   · 检测到本地改过 → 拒绝重装（`locally-edited`），用户保住了改动，却永远停在旧版；
 *   · 强行确认 → 覆盖，改动没了（快照里有一份，但那是给"整单回滚"用的，不是给"带着改动升级"用的）。
 *
 * 正确做法是补第三条路：**覆盖之前先把「你的改动 vs 上游新版」导成一份 diff**，
 * 用户装完新版之后可以照它把改动重放回去。所以这里的判据是：
 *   beforeDir = 现在磁盘上的（可能被改过的）技能目录
 *   afterDir  = 这次要装进去的上游目录（解包现场，还在）
 *
 * 三条纪律：
 *  ① 纯函数 + 文件系统两段分开：diff 计算（`diffLines` / `diffSkillDirs`）不做 IO，
 *    便于自检直接喂字符串；写盘只在 `writeSkillPatch`。
 *  ② 一切失败都**不影响安装**：导出是"顺手给的证据"，不能因为它写不进去就把一次安装判失败。
 *  ③ 二进制 / 超大文件如实标注跳过，不假装导出了（不许编造 diff）。
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 上限：技能目录一般几十个文件，超过就当异常情况处理（不静默截断，如实报 skipped）。 */
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINES = 4000;
/** LCS 表的最大格数；超了退化成「整文件替换」，避免在坏输入上卡死。 */
const MAX_CELLS = 2_000_000;

const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "__pycache__"]);

/** 递归列出目录里的普通文件（相对路径，稳定排序）。读不到就当空目录。 */
export async function listTree(root, rel = "", out = []) {
	let entries = [];
	try {
		entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
	} catch {
		return out;
	}
	const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of sorted) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const next = rel ? rel + "/" + entry.name : entry.name;
		if (entry.isDirectory()) await listTree(root, next, out);
		else if (entry.isFile()) out.push(next);
	}
	return out;
}

function looksBinary(buf) {
	const limit = Math.min(buf.length, 4096);
	for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true;
	return false;
}

/**
 * 行级 LCS → 统一 diff 的正文（不含 --- / +++ 头）。
 * `whole:true` 时退化成「整文件删掉再整文件加上」（输入太大，保可用不保精细）。
 */
export function diffLines(beforeText, afterText) {
	const a = String(beforeText ?? "").split(/\r?\n/);
	const b = String(afterText ?? "").split(/\r?\n/);
	const rows = [];
	if (a.length * b.length > MAX_CELLS || a.length > MAX_LINES || b.length > MAX_LINES) {
		for (const line of a) rows.push({ op: "-", line });
		for (const line of b) rows.push({ op: "+", line });
		return { rows, added: b.length, removed: a.length, whole: true };
	}
	/* 经典 LCS 表；技能文件都很小，够用。 */
	const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	let added = 0;
	let removed = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			rows.push({ op: " ", line: a[i] });
			i += 1;
			j += 1;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			rows.push({ op: "-", line: a[i] });
			removed += 1;
			i += 1;
		} else {
			rows.push({ op: "+", line: b[j] });
			added += 1;
			j += 1;
		}
	}
	while (i < a.length) {
		rows.push({ op: "-", line: a[i] });
		removed += 1;
		i += 1;
	}
	while (j < b.length) {
		rows.push({ op: "+", line: b[j] });
		added += 1;
		j += 1;
	}
	return { rows, added, removed, whole: false };
}

function countLines(text) {
	const rows = String(text ?? "").split(/\r?\n/);
	return rows.length && rows[rows.length - 1] === "" ? rows.length - 1 : rows.length;
}

/** 一个文件变成一个 unified diff 片段（整文件一个 hunk：够人读、也够 `patch` / `git apply` 吃）。 */
export function filePatch(rel, beforeText, afterText) {
	const diff = diffLines(beforeText, afterText);
	if (!diff.added && !diff.removed) return null;
	const lines = ["--- a/" + rel, "+++ b/" + rel];
	lines.push("@@ -1," + countLines(beforeText) + " +1," + countLines(afterText) + " @@");
	for (const row of diff.rows) lines.push(row.op + row.line);
	return { text: lines.join("\n") + "\n", added: diff.added, removed: diff.removed };
}

/**
 * 比较两个目录，产出 `{files, text, added, removed, skipped}`。
 * 只读；任何单个文件读不出来都进 `skipped`，不影响其它文件。
 */
export async function diffSkillDirs(beforeDir, afterDir) {
	const before = await listTree(beforeDir);
	const after = await listTree(afterDir);
	const union = Array.from(new Set([...before, ...after])).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
	const files = [];
	const chunks = [];
	const skipped = [];
	let added = 0;
	let removed = 0;
	for (const rel of union) {
		if (files.length >= MAX_FILES) {
			skipped.push(rel + "（文件数超过 " + MAX_FILES + "，其余未导出）");
			break;
		}
		let beforeBuf = null;
		let afterBuf = null;
		try {
			const info = await stat(join(beforeDir, rel)).catch(() => null);
			if (info && info.isFile()) {
				if (info.size > MAX_FILE_BYTES) {
					skipped.push(rel + "（超过 " + Math.round(MAX_FILE_BYTES / 1024) + " KB）");
					continue;
				}
				beforeBuf = await readFile(join(beforeDir, rel));
			}
		} catch {
			beforeBuf = null;
		}
		try {
			const info = await stat(join(afterDir, rel)).catch(() => null);
			if (info && info.isFile()) {
				if (info.size > MAX_FILE_BYTES) {
					skipped.push(rel + "（超过 " + Math.round(MAX_FILE_BYTES / 1024) + " KB）");
					continue;
				}
				afterBuf = await readFile(join(afterDir, rel));
			}
		} catch {
			afterBuf = null;
		}
		const beforeBinary = beforeBuf ? looksBinary(beforeBuf) : false;
		const afterBinary = afterBuf ? looksBinary(afterBuf) : false;
		if (beforeBinary || afterBinary) {
			const status = beforeBuf && afterBuf ? "modified" : beforeBuf ? "removed" : "added";
			files.push({ path: rel, status, binary: true, added: 0, removed: 0 });
			chunks.push("# 二进制文件（不导正文）：" + rel + " · " + status + "\n");
			continue;
		}
		const beforeText = beforeBuf ? beforeBuf.toString("utf8") : "";
		const afterText = afterBuf ? afterBuf.toString("utf8") : "";
		const one = filePatch(rel, beforeText, afterText);
		if (!one) continue;
		const status = !beforeBuf ? "added" : !afterBuf ? "removed" : "modified";
		files.push({ path: rel, status, binary: false, added: one.added, removed: one.removed });
		added += one.added;
		removed += one.removed;
		chunks.push(one.text);
	}
	const header = [
		"# dsh-plugin-installer · 本地改动导出",
		"# 这是「你的版本」与「上游版本」的差异：+ 是你加的，- 是你删的。",
		"# 用法：先按来源重装（= 换成上游新版），再照这份 diff 把你的改动重放回去：",
		"#   · 有 git：git apply --reject <这份文件> 然后处理 .rej",
		"#   · 没 git：用任何 diff 工具对一下，或直接把 + 行照抄回对应文件",
		""
	].join("\n");
	return { files, text: header + chunks.join("\n"), added, removed, skipped };
}

function safeStamp(at) {
	return String(at || new Date().toISOString()).replace(/[:.]/g, "-").slice(0, 19);
}

function safeName(name) {
	return String(name || "skill").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 80) || "skill";
}

/**
 * 把差异写成 `<outDir>/<name>-<时间>.diff`。
 * 没有任何差异时**不写空文件**（返回 `empty:true`）——空 patch 会让人以为"有改动"。
 */
export async function writeSkillPatch({ beforeDir, afterDir, name, outDir, at } = {}) {
	if (!beforeDir || !afterDir || !outDir) return { ok: false, reason: "缺目录" };
	const diff = await diffSkillDirs(beforeDir, afterDir);
	if (!diff.files.length) return { ok: true, empty: true, files: [], added: 0, removed: 0, skipped: diff.skipped, text: "" };
	await mkdir(outDir, { recursive: true });
	const path = join(outDir, safeName(name) + "-" + safeStamp(at) + ".diff");
	await writeFile(path, diff.text, "utf8");
	return {
		ok: true,
		empty: false,
		path,
		files: diff.files,
		added: diff.added,
		removed: diff.removed,
		skipped: diff.skipped
	};
}

/** 一句话摘要（面板 / 工具共用；没导出时给 null，别编）。 */
export function describePatch(patch) {
	if (!patch) return null;
	if (patch.empty) return "与上游没有差异，不需要导出";
	if (!patch.ok) return "导出失败：" + (patch.reason || "未知原因");
	const files = Array.isArray(patch.files) ? patch.files.length : 0;
	const skipped = Array.isArray(patch.skipped) ? patch.skipped.length : 0;
	return "已导出本地改动：" + files + " 个文件（+" + (patch.added || 0) + " / -" + (patch.removed || 0) + " 行）" +
		(skipped ? "，另有 " + skipped + " 个文件未导出" : "") + " → " + patch.path;
}
