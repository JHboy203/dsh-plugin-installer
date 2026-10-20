/**
 * detect.js — 确定性识别：这是插件（bundle）、profile、Skill，还是未知内容。
 *
 * 严格短路顺序（不靠模型猜）：
 *   ① package.json 且含 dsh.bundle   → bundle
 *   ② package.json 且含 dsh.profile  → profile（拒绝安装）
 *   ③ 有 SKILL.md（根目录或一层包装内）→ skill
 *   ④ 都不是                        → unknown；若含可执行/安装器 → pending_manual_review
 *
 * GitHub 的 zip 通常套一层 `<repo>-<branch>/`，npm 的 tgz 套一层 `package/`，
 * 所以先做「单子目录塌缩」再判定；同时把「一层包装内」也作为候选根。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const FORBIDDEN_EXT = new Set([
	".exe", ".msi", ".msix", ".dmg", ".pkg", ".deb", ".rpm", ".appimage",
	".scr", ".com", ".lnk", ".reg", ".vbs", ".vbe", ".wsf", ".hta",
	".bat", ".cmd", ".ps1", ".psm1", ".jar", ".apk"
]);

const MANIFEST_MAX = 2 * 1024 * 1024;
const SKILL_MAX = 512 * 1024;

export async function readTextIfExists(file, maxBytes = MANIFEST_MAX) {
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > maxBytes) return null;
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

export async function readJsonIfExists(file, maxBytes = MANIFEST_MAX) {
	const text = await readTextIfExists(file, maxBytes);
	if (text === null) return null;
	try {
		const data = JSON.parse(text);
		return data && typeof data === "object" && !Array.isArray(data) ? data : null;
	} catch {
		return { __parseError: true };
	}
}

/** 列目录，忽略 node_modules/.git（不该出现在包里，出现也只是噪音）。 */
async function listDir(dir) {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.name !== "node_modules" && e.name !== ".git");
	} catch {
		return [];
	}
}

export async function walkTree(root, limits = { maxFiles: 20000, maxBytes: 256 * 1024 * 1024 }) {
	const files = [];
	let bytes = 0;
	let truncated = false;
	const stack = [{ dir: root, rel: "", depth: 0 }];
	while (stack.length > 0) {
		const { dir, rel, depth } = stack.pop();
		const entries = await listDir(dir);
		for (const entry of entries) {
			const childRel = rel ? rel + "/" + entry.name : entry.name;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < 16) stack.push({ dir: full, rel: childRel, depth: depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			let size = 0;
			try {
				size = (await stat(full)).size;
			} catch {
				continue;
			}
			bytes += size;
			files.push({ rel: childRel, path: full, size });
			if (files.length > limits.maxFiles || bytes > limits.maxBytes) {
				truncated = true;
				stack.length = 0;
				break;
			}
		}
	}
	return { files, bytes, truncated };
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（只取标量，够用即可）。
 * @returns {{present: boolean, name?: string, description?: string, whenToUse?: string, valid: boolean, reasons: string[], raw: string}}
 */
export function parseSkillFrontmatter(text) {
	const out = { present: false, valid: false, reasons: [], raw: "" };
	const source = String(text ?? "");
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
	if (!m) {
		out.reasons.push("SKILL.md 缺少 YAML frontmatter（`---` 开头）");
		return out;
	}
	out.present = true;
	out.raw = m[1];
	const fields = {};
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		let value = kv[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[kv[1]] = value;
	}
	out.name = fields.name;
	out.description = fields.description;
	out.whenToUse = fields.whenToUse;
	if (!out.name) out.reasons.push("frontmatter 缺少 `name`");
	else if (!/^[a-z0-9][a-z0-9-]*$/.test(out.name)) out.reasons.push("`name` 必须是 kebab-case（小写字母/数字/连字符）");
	if (!out.description) out.reasons.push("frontmatter 缺少 `description`");
	out.valid = out.reasons.length === 0;
	return out;
}

async function collapseSingleDirs(root, maxLevels = 3) {
	let current = root;
	const wrappers = [];
	for (let i = 0; i < maxLevels; i += 1) {
		const entries = await listDir(current);
		const dirs = entries.filter((e) => e.isDirectory());
		const files = entries.filter((e) => e.isFile());
		if (files.length === 0 && dirs.length === 1) {
			wrappers.push(dirs[0].name);
			current = join(current, dirs[0].name);
			continue;
		}
		break;
	}
	return { root: current, wrappers };
}

function describePackage(pkg) {
	if (!pkg || pkg.__parseError) return null;
	return {
		name: typeof pkg.name === "string" ? pkg.name : null,
		version: typeof pkg.version === "string" ? pkg.version : null,
		description: typeof pkg.description === "string" ? pkg.description : null,
		scripts: pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {},
		dependencies: pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {},
		peerDependencies: pkg.peerDependencies && typeof pkg.peerDependencies === "object" ? pkg.peerDependencies : {},
		engines: pkg.engines && typeof pkg.engines === "object" ? pkg.engines : {},
		dsh: pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : null,
		hasBundle: Boolean(pkg.dsh && typeof pkg.dsh === "object" && pkg.dsh.bundle),
		hasProfile: Boolean(pkg.dsh && typeof pkg.dsh === "object" && pkg.dsh.profile)
	};
}

/**
 * @param {string} extractRoot 解包出来的目录
 * @param {object} [options] {subdir?: string}
 */
export async function detectKind(extractRoot, options = {}) {
	const notes = [];
	let base = extractRoot;
	if (options.subdir) {
		base = join(extractRoot, options.subdir);
		notes.push("按链接里的子目录定位到 `" + options.subdir + "`");
	}
	const collapsed = await collapseSingleDirs(base);
	if (collapsed.wrappers.length > 0) {
		notes.push("剥掉包装目录：" + collapsed.wrappers.join(" / "));
	}
	const root = collapsed.root;
	const candidates = [root];
	for (const entry of await listDir(root)) {
		if (entry.isDirectory()) candidates.push(join(root, entry.name));
	}

	let bundle = null;
	let profile = null;
	let skill = null;
	const seen = [];

	for (const dir of candidates) {
		const pkgPath = join(dir, "package.json");
		const pkg = await readJsonIfExists(pkgPath);
		if (pkg) {
			const info = describePackage(pkg);
			seen.push({ dir, kind: info && info.hasBundle ? "bundle" : info && info.hasProfile ? "profile" : "package", name: info && info.name });
			if (info && info.hasBundle && !bundle) {
				const patchRel = info.dsh.bundle && typeof info.dsh.bundle === "object" ? info.dsh.bundle.patch : null;
				const patchPath = patchRel ? join(dir, String(patchRel)) : null;
				const patchText = patchPath ? await readTextIfExists(patchPath) : null;
				bundle = {
					dir,
					manifestPath: pkgPath,
					manifest: info,
					patchRel,
					patchPath,
					patchText,
					validPatch: Boolean(patchText)
				};
			}
			if (info && info.hasProfile && !profile) {
				profile = { dir, manifestPath: pkgPath, manifest: info };
			}
		}
		const skillPath = join(dir, "SKILL.md");
		const skillText = await readTextIfExists(skillPath, SKILL_MAX);
		if (skillText !== null && !skill) {
			const meta = parseSkillFrontmatter(skillText);
			skill = { dir, entryPath: skillPath, meta, dirName: basename(dir) };
			seen.push({ dir, kind: "skill", name: meta.name });
		}
	}

	const tree = await walkTree(root);
	const forbidden = tree.files
		.filter((f) => FORBIDDEN_EXT.has(("." + f.rel.split(".").pop()).toLowerCase()))
		.map((f) => ({ rel: f.rel, path: f.path, ext: "." + f.rel.split(".").pop().toLowerCase() }));

	const baseResult = {
		root,
		wrappers: collapsed.wrappers,
		notes,
		seen,
		tree,
		forbidden
	};

	if (bundle) {
		return {
			...baseResult,
			kind: "bundle",
			payload: bundle,
			installable: Boolean(bundle.patchText),
			reason: bundle.patchText ? null : "package.json 声明了 dsh.bundle，但 patch 文件不存在或读不到"
		};
	}
	if (profile) {
		return {
			...baseResult,
			kind: "profile",
			payload: profile,
			installable: false,
			reason: "这是 profile 清单（dsh.profile），不是可安装包"
		};
	}
	if (skill) {
		return {
			...baseResult,
			kind: "skill",
			payload: skill,
			installable: skill.meta.valid,
			reason: skill.meta.valid ? null : "SKILL.md 不合法：" + skill.meta.reasons.join("；")
		};
	}
	return {
		...baseResult,
		kind: "unknown",
		payload: null,
		installable: false,
		reason: forbidden.length > 0
			? "未识别内容，且含可执行文件/系统安装器（" + forbidden.slice(0, 3).map((f) => f.rel).join("、") + "），不执行，转人工确认"
			: "未识别内容：既没有 dsh.bundle，也没有 SKILL.md"
	};
}
