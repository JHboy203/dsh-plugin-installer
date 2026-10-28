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
import { basename, join, relative } from "node:path";

import { classifyForeign } from "./foreign.js";

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
 * 解析 frontmatter 里的标量字段（R14：支持 `>` / `|` 折叠块标量）。
 *
 * 为什么必须支持块标量：本机 11 个技能的 description 写成 `description: >` 再缩进换行
 * （中文长句折行），旧实现只认单行，于是把指示符 `>` 本身当成了描述 —— 面板上显示一个
 * 「>」，用途推断也拿它去和能力比对。**读到了但读错**比读不到更难发现，所以这里按 YAML
 * 的三种形态处理：指示符块标量（> / |，含 +- 修饰）、缩进续行（折行）、单行标量。
 *
 * 只取标量：frontmatter 里出现列表 / 嵌套对象时按原文收进字符串（本工程用不到它们的语义）。
 *
 * @param {string} block frontmatter 两个 `---` 之间的正文
 * @returns {Record<string, string>}
 */
export function parseFrontmatterFields(block) {
	const lines = String(block ?? "").split(/\r?\n/);
	const fields = {};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		const key = kv[1];
		const rest = kv[2].trim();
		/* 紧随其后的缩进行属于这个值；空行允许夹在中间（YAML 里就是段落分隔） */
		const body = [];
		let j = i + 1;
		for (; j < lines.length; j += 1) {
			const next = lines[j];
			if (!next.trim()) {
				body.push("");
				continue;
			}
			if (/^\s/.test(next)) {
				body.push(next);
				continue;
			}
			break;
		}
		i = j - 1;
		/* 公共缩进 = 第一层缩进，按它剥掉，避免把中文段首的空白带进描述 */
		const indents = body.filter((line2) => line2.trim()).map((line2) => (/^\s*/.exec(line2) || [""])[0].length);
		const base = indents.length ? Math.min(...indents) : 0;
		const stripped = body.map((line2) => (line2.trim() ? line2.slice(base) : ""));
		const indicator = /^([>|])[+-]?$/.exec(rest);
		let value;
		if (indicator) value = indicator[1] === ">" ? foldLines(stripped) : stripped.join("\n");
		else if (stripped.some((line2) => line2.trim())) value = (rest ? rest + " " : "") + foldLines(stripped);
		else value = rest;
		const clean = unquote(String(value).trim());
		/* 同一个键写两遍是作者的错，但不能因此把先读到的那个值丢掉 */
		if (!(key in fields) || !fields[key]) fields[key] = clean;
	}
	return fields;
}

/** YAML 折叠：连续非空行用空格接起来，空行折成换行（保留段落感）。 */
function foldLines(lines) {
	let out = "";
	let blanks = 0;
	for (const line of lines) {
		if (!line.trim()) {
			blanks += 1;
			continue;
		}
		if (out) out += blanks > 0 ? "\n".repeat(blanks) : " ";
		out += line.trim();
		blanks = 0;
	}
	return out;
}

function unquote(text) {
	if (text.length > 1) {
		const first = text[0];
		const last = text[text.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
	}
	return text;
}

/**
 * frontmatter 里的 YAML「硬错误」—— 它们让**整个 frontmatter 解析失败**，表现是
 * 「这个技能不存在」：宿主跳过它，面板 R13 的诊断只会说「目录清单里读不到」。
 * 本机实测（2026-10-22，PyYAML 复核）：3 个技能就是这种状态，它们的 name/description 都写得好好的，
 * 只是 description 里有一个 `: `（冒号+空格）没加引号 —— YAML 认为那是新字段的开头。
 *
 * R21 又补了三类「同样会整段解析失败、但以前完全没看见」的：
 *   · **Tab 缩进** —— YAML 的缩进只认空格（js-yaml 直接抛错）；
 *   · **重复键** —— 同一个 mapping 不允许定义两次（duplicated mapping key）；
 *   · **引号没闭合** —— 值以引号开头却不以同一个引号结尾，后面全被当成字符串。
 *
 * 判据（只针对 plain 标量；块标量 `>`/`|` 与带引号的值不受影响）：
 *   · `: ` → 会被当成 mapping 的分隔符；
 *   · ` #` → 会被当成注释，后面的描述直接丢。
 *
 * `fixable` 决定面板给不给「修成块标量…」入口：R16 的改写只处理 `: ` / ` #` 两种，
 * 其余三类只能手工改 —— 给一个按下去也不会好的按钮，比不给更糟。
 *
 * @param {string} block 两个 `---` 之间的正文
 * @returns {{code:string, kind:string, fixable:boolean, key:string|null, line:number, message:string, fix:string}|null}
 */
export function yamlFrontmatterIssue(block) {
	const lines = String(block ?? "").split(/\r?\n/);
	const seen = new Map();
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const indent = /^[ \t]*/.exec(line)[0];
		/* R21 ① Tab 缩进：只认「行首就是 Tab」。缩进用空格、内容里带 Tab（块标量正文）是合法的，
		   判宽了会把正常技能报成坏的 —— 宁漏不误。 */
		if (indent.startsWith("\t")) {
			return {
				code: "tab-indent",
				kind: "tab-indent",
				fixable: false,
				key: null,
				line: i + 1,
				message: "第 " + (i + 1) + " 行的缩进里有 Tab —— YAML 的缩进只认空格，整个 frontmatter 会解析失败",
				fix: "把缩进里的 Tab 换成两个空格（编辑器里先打开「显示空白字符」，再整段替换）"
			};
		}
		const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		const key = kv[1];
		const value = kv[2].trim();
		/* R21 ② 重复键 */
		if (seen.has(key)) {
			return {
				code: "duplicate-key",
				kind: "duplicate-key",
				fixable: false,
				key,
				line: i + 1,
				message: "`" + key + "` 定义了两次（第一次在第 " + seen.get(key) + " 行）—— YAML 不允许重复键，整个 frontmatter 解析失败",
				fix: "删掉多余的那一行，或者把两处内容合并成一条"
			};
		}
		seen.set(key, i + 1);
		if (!value) continue;
		const first = value[0];
		/* 块标量：正文在缩进行里，冒号/井号都不再特殊 */
		if (first === ">" || first === "|") continue;
		/* R21 ③ 引号没闭合：值的后半段再没有同一个引号。
		   `"abc" # 注释` 是合法的（闭合引号 + 注释），所以判据是「完全没有第二个引号」而不是「结尾不是引号」。 */
		if (first === '"' || first === "'") {
			if (value.indexOf(first, 1) < 0) {
				return {
					code: "unclosed-quote",
					kind: "unclosed-quote",
					fixable: false,
					key,
					line: i + 1,
					message: "`" + key + "` 的值以 " + first + " 开头却没有闭合 —— 后面的内容全被当成字符串，YAML 解析失败",
					fix: "补上结尾的 " + first + "；值里本来就有同名引号时，改成块标量（`" + key + ": >`）更省事"
				};
			}
			continue;
		}
		if (value.includes(": ")) {
			return {
				code: "colon-space",
				kind: "block-scalar",
				fixable: true,
				key,
				line: i + 1,
				message: "`" + key + "` 的值里有「冒号 + 空格」（" + value.slice(Math.max(0, value.indexOf(": ") - 12), value.indexOf(": ") + 14) +
					"…），YAML 会把它当成新字段的开头，整个 frontmatter 解析失败",
				fix: "把这一行改成块标量（`" + key + ": >` 然后缩进两格写正文），或用双引号把整段包起来（里面的双引号改成单引号）"
			};
		}
		if (value.includes(" #")) {
			return {
				code: "hash-comment",
				kind: "block-scalar",
				fixable: true,
				key,
				line: i + 1,
				message: "`" + key + "` 的值里有「空格 + #」，YAML 会把它当成注释，后面的内容被截掉",
				fix: "把 # 前面的空格去掉，或用引号包住整段值"
			};
		}
	}
	return null;
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（只取标量，够用即可）。
 * @returns {{present: boolean, name?: string, description?: string, whenToUse?: string, fields?: object,
 *   yamlIssue?: object|null, valid: boolean, reasons: string[], raw: string}}
 */
export function parseSkillFrontmatter(text) {
	const out = { present: false, valid: false, reasons: [], raw: "", yamlIssue: null };
	const source = String(text ?? "").replace(/^\uFEFF/, "");
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
	if (!m) {
		out.reasons.push("SKILL.md 缺少 YAML frontmatter（`---` 开头）");
		return out;
	}
	out.present = true;
	out.raw = m[1];
	const fields = parseFrontmatterFields(m[1]);
	out.name = fields.name;
	out.description = fields.description;
	out.whenToUse = fields.whenToUse;
	out.fields = fields;
	out.yamlIssue = yamlFrontmatterIssue(m[1]);
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
	/* R32：候选目录里读到的 package.json（非 DSH 资产分类要用） */
	const packages = [];
	const seen = [];
	/* R32：SKILL.md 以前只取**第一个**（`!skill` 守卫）—— 多技能仓库（实测 anthropics/skills 有几十个）
	   于是被当成「一个技能」静默装其中一个，且不告诉用户装的是哪个。现在全部记下来，
	   由 precheck 把「这次装的是哪个 / 一共几个」说清楚。 */
	const skillAll = [];

	for (const dir of candidates) {
		const pkgPath = join(dir, "package.json");
		const pkg = await readJsonIfExists(pkgPath);
		if (pkg) {
			const info = describePackage(pkg);
			seen.push({ dir, kind: info && info.hasBundle ? "bundle" : info && info.hasProfile ? "profile" : "package", name: info && info.name });
			packages.push({ dir, manifest: pkg });
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
		if (skillText !== null) {
			const meta = parseSkillFrontmatter(skillText);
			skillAll.push({ dir, entryPath: skillPath, meta, dirName: basename(dir) });
			seen.push({ dir, kind: "skill", name: meta.name });
			if (!skill) skill = { dir, entryPath: skillPath, meta, dirName: basename(dir) };
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
		forbidden,
		/* R32：仓库里所有 SKILL.md（含名字），precheck 据此提示「多技能仓库只装一个」 */
		skills: skillAll.map((item) => ({ name: item.meta.name || item.dirName, rel: relative(root, item.entryPath), dir: item.dir })),
		skillCount: skillAll.length
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
	/* R32：unknown 不等于「什么都不认识」。先按 manifest/文件特征认出它属于哪个生态，
	   把「未识别内容」升级成「这是 X，它不能这么装，正确用法在下面」。**放行条件不变**：
	   unknown 依然阻断（下面 installable 仍是 false）。 */
	const rootManifest = await readJsonIfExists(join(root, "manifest.json"));
	const foreign = classifyForeign({
		packages,
		files: tree.files.map((f) => f.rel),
		rootManifest,
		skillPaths: skillAll.map((item) => item.entryPath)
	});
	return {
		...baseResult,
		kind: "unknown",
		payload: null,
		installable: false,
		foreign,
		reason: foreign
			? "未识别为 DSH 插件 —— 它看起来是「" + foreign.label + "」，不能这样装"
			: forbidden.length > 0
				? "未识别内容，且含可执行文件/系统安装器（" + forbidden.slice(0, 3).map((f) => f.rel).join("、") + "），不执行，转人工确认"
				: "未识别内容：既没有 dsh.bundle，也没有 SKILL.md"
	};
}
