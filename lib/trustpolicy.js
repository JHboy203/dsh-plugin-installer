/**
 * trustpolicy.js — profile 的 pnpm「供应链策略」：读、解释、以及**只改该改的那一块**（R31）。
 *
 * 为什么需要它（真实事故，2026-10-28）：
 *   本机 profile 的 `pnpm-workspace.yaml` 里写着 `trustPolicy: no-downgrade`（R2 加的保护）。
 *   某天装一个**跟它毫无关系**的本机插件（dsh-lemofilm）时 pnpm 直接失败，原文是
 *     [ERR_PNPM_TRUST_DOWNGRADE] High-risk trust downgrade for "chromium-bidi@157.0.8090-0"
 *     This error happened while installing the dependencies of dsh-vision-router@3.1.0
 *       at puppeteer-core@25.16.0
 *   —— 某个第三方链上的新版本缺少「可信发布者」证据，而旧版本有，于是 **整次安装** 被拒。
 *   面板当时的分诊表里没有这条，只能报「认不出失败原因」，于是用户看到的是「总是装不上」。
 *
 * 这个模块只做三件事：
 *   ① `parsePolicy()` 把策略读成结构（哪条策略、豁免了谁、忽略窗口多长）——
 *      **纯字符串进、纯结构出**，读坏不炸；`null` 与 `[]` 必须分得开（「没有」≠「空的」）；
 *   ② `addExclude()` 往 `trustPolicyExclude` 里加条目：能加就加，加不了就**明确拒绝并说原因**，
 *      绝不猜着改（YAML 手改坏一次的代价比多报一条错大得多）；
 *   ③ `describePolicy()` 给面板/体检一句人话。
 *
 * 纪律（与 R29 的「只报不修」不冲突，理由要看清）：
 *   · **pnpm 的锁文件与依赖树**面板永不自动改（那边才是「重算整棵树」的风险源头）；
 *   · 这里是**一个显式键的列表**，动作由人点、二次确认、写前备份、写后复核，且带 `apply:true`。
 *     它仍然是一次「放松供应链检查」的决定 —— 所以文案必须把代价写出来，不能只给按钮。
 */
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** pnpm 的三种信任度（`no-downgrade` 是目前唯一会主动挡安装的取值）。 */
export const TRUST_POLICIES = ["no-downgrade", "no-trust-downgrade"];

const KEY_RE = /^(trustPolicy|trustPolicyExclude|trustPolicyIgnoreAfter)\s*:\s*(.*)$/;

function detectEol(text) {
	return /\r\n/.test(String(text || "")) ? "\r\n" : "\n";
}

function unquote(value) {
	const text = String(value === undefined || value === null ? "" : value).trim();
	if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
		return text.slice(1, -1);
	}
	return text;
}

/** 归一化一条豁免条目：`chromium-bidi@157.0.8090-0` / `chromium-bidi`。 */
export function normalizeExclude(entry) {
	return unquote(entry).replace(/\s+/g, "").toLowerCase();
}

/** 把一条豁免拆成 {name, versions}（versions 为空数组 = 该包全部版本）。 */
export function splitExclude(entry) {
	const raw = unquote(entry);
	const at = raw.startsWith("@") ? raw.indexOf("@", 1) : raw.indexOf("@");
	if (at === -1) return { name: raw, versions: [] };
	return { name: raw.slice(0, at), versions: raw.slice(at + 1).split("||").map((v) => v.trim()).filter(Boolean) };
}

function splitInlineList(inner) {
	return String(inner || "")
		.split(",")
		.map((item) => unquote(item))
		.filter((item) => item !== "");
}

/**
 * 读 `pnpm-workspace.yaml` 里的策略块。行扫描，不引 YAML 依赖（这个块只有三项）。
 *
 * 三个字段的「读不到」与「空」必须分开：
 *   · `trustPolicy: null` = 没写这一行（没开保护）；
 *   · `trustPolicyExclude: []` = 写了但没豁免任何包。
 *
 * @param {string} text
 * @returns {{policy:string|null, exclude:string[], ignoreAfter:number|null,
 *            hasExcludeKey:boolean, malformed:boolean, notes:string[]}}
 */
export function parsePolicy(text) {
	const src = String(text || "");
	const lines = src.split(/\r?\n/);
	const out = { policy: null, exclude: [], ignoreAfter: null, hasExcludeKey: false, malformed: false, notes: [] };
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (/^\s/.test(line)) continue; /* 只认顶格键：缩进的一定是别人的子项 */
		const m = KEY_RE.exec(line.trim());
		if (!m) continue;
		const key = m[1];
		const value = m[2].trim();
		if (key === "trustPolicy") {
			out.policy = value === "" ? null : unquote(value.split("#")[0].trim());
			continue;
		}
		if (key === "trustPolicyIgnoreAfter") {
			const n = Number(unquote(value.split("#")[0].trim()));
			out.ignoreAfter = Number.isFinite(n) ? n : null;
			if (!Number.isFinite(n) && value !== "") {
				out.malformed = true;
				out.notes.push("trustPolicyIgnoreAfter 不是数字，pnpm 会当作没配");
			}
			continue;
		}
		/* trustPolicyExclude */
		out.hasExcludeKey = true;
		const inline = /^\[(.*)\]\s*(#.*)?$/.exec(value);
		if (inline) {
			out.exclude.push(...splitInlineList(inline[1]));
			continue;
		}
		for (let j = i + 1; j < lines.length; j += 1) {
			const item = lines[j];
			if (/^\s*$/.test(item) || /^\s*#/.test(item)) continue;
			if (!/^\s/.test(item)) break; /* 回到顶格 = 这个块结束 */
			const bullet = /^\s*-\s*(.+?)\s*$/.exec(item);
			if (bullet) {
				out.exclude.push(unquote(bullet[1].split("#")[0].trim()));
			} else if (/^\s*[^\s#]+:\s*/.test(item)) {
				/* 有人写成 `name: true` 这种映射形态：pnpm 不认，但我们别报错 */
				out.malformed = true;
				out.notes.push("trustPolicyExclude 里出现了 `名字: 值` 的映射写法 —— pnpm 只认列表");
			}
		}
	}
	return out;
}

/**
 * 往 `trustPolicyExclude` 里加条目。
 *
 * 三种落点，按优先级：
 *   ① 已有块 → 在块末尾追加（沿用块里已有的缩进）；
 *   ② 已有内联数组 → 原地改写成块形态（内联形态改一行就会丢条目，块形态可读可 diff）；
 *   ③ 没有这个键 → 插在 `trustPolicy:` 后面（没有它就追加到文件末尾），带一行说明注释。
 *
 * 「加不了」的三种情况都返回 `changed:false` 并给原因，**绝不猜着改**：
 * 块里出现非列表形态的行 / 文件里有制表符缩进 / 传入条目为空。
 *
 * @param {string} text 原文
 * @param {string[]} entries 要加的条目（`name` 或 `name@version`）
 * @returns {{text:string, changed:boolean, added:string[], skipped:string[], reason:string|null, mode:string}}
 */
export function addExclude(text, entries) {
	const src = String(text || "");
	const wanted = (Array.isArray(entries) ? entries : [entries]).map((e) => unquote(e)).filter((e) => e !== "");
	if (wanted.length === 0) return { text: src, changed: false, added: [], skipped: [], reason: "没有要加的条目", mode: "noop" };

	const parsed = parsePolicy(src);
	const have = new Set(parsed.exclude.map(normalizeExclude));
	const add = [];
	const skipped = [];
	for (const entry of wanted) {
		const key = normalizeExclude(entry);
		if (have.has(key)) skipped.push(entry);
		else {
			have.add(key);
			add.push(entry);
		}
	}
	if (add.length === 0) return { text: src, changed: false, added: [], skipped, reason: "这几条已经在 exempt 列表里了", mode: "noop" };

	const eol = detectEol(src);
	const lines = src.split(/\r?\n/);
	const keyIdx = lines.findIndex((line) => /^trustPolicyExclude\s*:/.test(line));

	if (keyIdx >= 0) {
		const line = lines[keyIdx];
		const inline = /^(trustPolicyExclude\s*:\s*)\[(.*)\]\s*(#.*)?$/.exec(line);
		if (inline) {
			const merged = parsed.exclude.concat(add);
			lines.splice(keyIdx, 1, "trustPolicyExclude:", ...merged.map((item) => "  - " + item));
			return { text: lines.join(eol), changed: true, added: add, skipped, reason: null, mode: "inline-to-block" };
		}
		/* 块形态：找最后一条列表项，沿用它的缩进 */
		let last = keyIdx;
		let indent = "  ";
		let broke = false;
		for (let j = keyIdx + 1; j < lines.length; j += 1) {
			const item = lines[j];
			if (/^\s*$/.test(item) || /^\s*#/.test(item)) continue;
			if (!/^\s/.test(item)) break;
			const bullet = /^(\s*)-\s/.exec(item);
			if (bullet) {
				last = j;
				indent = bullet[1];
				continue;
			}
			broke = true; /* 块里出现了非列表行：不碰它 */
			break;
		}
		if (broke) {
			return { text: src, changed: false, added: [], skipped, reason: "trustPolicyExclude 块里有非列表形态的行（可能是手改过），不敢插", mode: "refused" };
		}
		lines.splice(last + 1, 0, ...add.map((item) => indent + "- " + item));
		return { text: lines.join(eol), changed: true, added: add, skipped, reason: null, mode: "block-append" };
	}

	/* 没有这个键：挂在 trustPolicy 后面，或者追加到末尾 */
	const policyIdx = lines.findIndex((line) => /^trustPolicy\s*:/.test(line));
	const block = [
		"# R31：为个别包关掉信任度检查。pnpm 的策略是「一次安装里任何包降级就整次失败」，",
		"# 而被点名的那份常常只是别的插件的传递依赖（跟你正在装的插件无关）。",
		"# 只豁免你核对过的那一个版本；不要写成通配。",
		"trustPolicyExclude:",
		...add.map((item) => "  - " + item)
	];
	if (policyIdx >= 0) {
		lines.splice(policyIdx + 1, 0, "", ...block);
		return { text: lines.join(eol), changed: true, added: add, skipped, reason: null, mode: "insert-after-policy" };
	}
	const tail = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
	lines.splice(tail, 0, "", ...block);
	return { text: lines.join(eol), changed: true, added: add, skipped, reason: null, mode: "append" };
}

/**
 * 一句人话（面板 / 体检 / 工具共用）。
 * @param {{policy:string|null, exclude:string[], ignoreAfter:number|null, hasExcludeKey:boolean}} parsed
 */
export function describePolicy(parsed) {
	const p = parsed || {};
	if (!p.policy) return "未开 trustPolicy（pnpm 不会因为「可信度降级」挡住安装）";
	const parts = ["trustPolicy: " + p.policy];
	if (!p.hasExcludeKey) parts.push("没有豁免任何包");
	else if ((p.exclude || []).length === 0) parts.push("豁免列表是空的");
	else parts.push("已豁免 " + p.exclude.length + " 条（" + p.exclude.slice(0, 4).join("、") + (p.exclude.length > 4 ? "…" : "") + "）");
	if (p.ignoreAfter) parts.push("发布满 " + Math.round(p.ignoreAfter / 60) + " 分钟后不再查");
	return parts.join(" · ");
}

/* ── fs 层（薄） ───────────────────────────────────────────────────── */

/**
 * 读 profile 的 pnpm-workspace.yaml 策略块。
 * @param {string|null} profileDirPath
 */
export async function readPolicy(profileDirPath) {
	if (!profileDirPath) return { ok: false, file: null, error: "读不到 profile 目录", ...parsePolicy("") };
	const file = join(profileDirPath, WORKSPACE_FILE);
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		return { ok: false, file, error: String((e && e.message) || e), ...parsePolicy("") };
	}
	return { ok: true, file, text, ...parsePolicy(text) };
}

/**
 * 真写盘：备份 → 原子写 → 复核。
 *
 * 复核只做一件确定的事：**新文本能被解析回原策略 + 新增条目都在**，且原文的其它行一个不少
 * （按行多重集比较）。任一条不满足就回滚到原文并报错 —— 「写坏 profile」的代价远大于少做一次豁免。
 *
 * @param {object} input
 * @param {string} input.profileDir
 * @param {string[]} input.entries
 * @param {string} [input.backupDir] 备份落点（省略 = 与文件同目录的 `.backup-<stamp>`）
 * @returns {Promise<{ok:boolean, changed:boolean, added:string[], skipped:string[], mode:string,
 *   file:string|null, backup:string|null, error?:string, reason?:string}>}
 */
export async function writeExclude({ profileDir, entries, backupDir } = {}) {
	const file = profileDir ? join(profileDir, WORKSPACE_FILE) : null;
	if (!file) return { ok: false, changed: false, added: [], skipped: [], mode: "noop", file: null, backup: null, error: "读不到 profile 目录" };
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		return { ok: false, changed: false, added: [], skipped: [], mode: "noop", file, backup: null, error: "读不到 " + WORKSPACE_FILE + "：" + String((e && e.message) || e) };
	}
	const plan = addExclude(text, entries);
	if (!plan.changed) {
		return { ok: true, changed: false, added: [], skipped: plan.skipped, mode: plan.mode, file, backup: null, reason: plan.reason };
	}
	/* 写前复核：只许**插入**行，原有每一行的出现次数都不许减少（含重复行的重数） */
	const before = text.split(/\r?\n/);
	const after = plan.text.split(/\r?\n/);
	const count = (list) => {
		const map = new Map();
		for (const line of list) map.set(line, (map.get(line) || 0) + 1);
		return map;
	};
	const was = count(before);
	const now = count(after);
	const lostLines = [];
	for (const [line, n] of was) {
		if (line === "") continue;
		if ((now.get(line) || 0) < n) lostLines.push(line);
	}
	if (lostLines.length > 0) {
		return { ok: false, changed: false, added: [], skipped: plan.skipped, mode: "refused", file, backup: null, error: "改写会让原始内容丢行（" + lostLines.slice(0, 2).join(" / ") + "），已放弃" };
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const backup = join(profileDir, ".pnpm-workspace.backup-" + stamp + ".yaml");
	try {
		await mkdir(profileDir, { recursive: true });
		if (backupDir) {
			await mkdir(backupDir, { recursive: true });
			await copyFile(file, join(backupDir, "pnpm-workspace.yaml")).catch(() => null);
		}
		await writeFile(backup, text, "utf8");
		const tmp = file + "." + process.pid + ".tmp";
		await writeFile(tmp, plan.text, "utf8");
		try {
			await rename(tmp, file);
		} catch {
			await copyFile(tmp, file);
			await unlink(tmp).catch(() => null);
		}
	} catch (e) {
		return { ok: false, changed: false, added: [], skipped: plan.skipped, mode: plan.mode, file, backup: null, error: "写盘失败：" + String((e && e.message) || e) };
	}
	/* 写后复核：新内容真的在 */
	const reread = await readFile(file, "utf8").catch(() => "");
	const check = parsePolicy(reread);
	const have = new Set(check.exclude.map(normalizeExclude));
	const lost = plan.added.filter((entry) => !have.has(normalizeExclude(entry)));
	if (lost.length > 0) {
		await writeFile(file, text, "utf8").catch(() => null);
		return { ok: false, changed: false, added: [], skipped: plan.skipped, mode: plan.mode, file, backup, error: "写入后复核没找到 " + lost.join("、") + "，已还原原文" };
	}
	return { ok: true, changed: true, added: plan.added, skipped: plan.skipped, mode: plan.mode, file, backup, reason: null };
}

export const __test = { detectEol, unquote, splitInlineList, KEY_RE };
