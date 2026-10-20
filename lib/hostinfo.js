/**
 * hostinfo.js — 宿主事实：版本、profile 路径、技能根目录。
 *
 * 为什么不用 `import()` 去拿 dsh-app-boot 的兼容性评估：本插件是以
 * `link:` 方式装进 profile 的，裸 import `@deepseek-ai/*` 会走 Node 的
 * 就近解析，落到 profile/node_modules —— 那里没有（也不该有）宿主包。
 * 所以版本从**文件系统事实**读，范围判定用自己的 semver（lib/semver.js）。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

export function dataDir() {
	return process.env.DSH_INSTALLER_DIR || join(PLUGIN_DIR, "data");
}

export function profileDir() {
	const fromEnv = process.env.DSH_PROFILE_DIR;
	if (fromEnv) return fromEnv;
	/* 宿主 cwd 通常就是 profile 目录（见 dsh-client-plugin-ops 坑 14），
	   但它也可能被别的东西改过，所以只当兜底。 */
	const cwd = process.cwd();
	if (/profiles[\\/][^\\/]+$/.test(cwd)) return cwd;
	return null;
}

export function profileName() {
	if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
	const dir = profileDir();
	return dir ? dir.split(/[\\/]/).pop() : "desktop";
}

export function dshHome() {
	if (process.env.DSH_HOME) return process.env.DSH_HOME;
	const dir = profileDir();
	if (dir && /[\\/]profiles[\\/][^\\/]+$/.test(dir)) return resolve(dir, "..", "..");
	return join(homedir(), ".dsh");
}

/**
 * 技能根目录（按 skill-filesystem 的 rank：项目 100 / custom 300 / user 400）。
 * 安装优先落到 user（`$DSH_HOME/skills`），因为它是「用户级」语义，且本机
 * 已在 customSkillDirs 里显式列了同一个目录。
 */
export function skillRoots() {
	const home = dshHome();
	const list = [];
	if (process.env.DSH_SKILLS_DIR) list.push(process.env.DSH_SKILLS_DIR);
	list.push(join(home, "skills"));
	const proj = join(home, "..", ".dsh", "skills");
	if (resolve(proj) !== resolve(join(home, "skills"))) list.push(resolve(proj));
	return [...new Set(list)];
}

async function readJson(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

function resourcesPath() {
	// Electron 主进程有 process.resourcesPath；打包后就是 <install>/resources
	if (process.resourcesPath) return process.resourcesPath;
	const exe = process.execPath || "";
	if (/[\\/]resources[\\/]/i.test(exe)) return dirname(dirname(exe));
	if (/\.exe$/i.test(exe)) return join(dirname(exe), "resources");
	return null;
}

let cachedVersions = null;

/**
 * @returns {{dsh: string|null, dshTools: string|null, node: string, sources: string[]}}
 */
export async function hostVersions(force = false) {
	if (cachedVersions && !force) return cachedVersions;
	const sources = [];
	let dsh = process.env.DSH_VERSION || null;
	let dshTools = null;
	const res = resourcesPath();
	const roots = [];
	if (res) roots.push(res);
	if (process.env.DSH_INSTALL_ROOT) roots.push(process.env.DSH_INSTALL_ROOT);
	for (const root of roots) {
		if (!dsh) {
			const pkg = await readJson(join(root, "app.asar", "package.json"));
			if (pkg && pkg.version) {
				dsh = String(pkg.version);
				sources.push(join(root, "app.asar", "package.json"));
			} else {
				const appPkg = await readJson(join(root, "app", "package.json"));
				if (appPkg && appPkg.version) {
					dsh = String(appPkg.version);
					sources.push(join(root, "app", "package.json"));
				}
			}
		}
		const toolsPkg = await readJson(join(root, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "package.json"));
		if (toolsPkg && toolsPkg.version) {
			dshTools = String(toolsPkg.version);
			sources.push("dsh-tools@" + dshTools);
		}
	}
	cachedVersions = { dsh, dshTools, node: process.versions.node, sources };
	return cachedVersions;
}

export async function readProfileFile(name) {
	const dir = profileDir();
	if (!dir) return null;
	try {
		return await readFile(join(dir, name), "utf8");
	} catch {
		return null;
	}
}

/** profile 的 pnpm-workspace.yaml 里有没有 `trustPolicy: no-downgrade`。 */
export async function pnpmTrustPolicy() {
	const text = await readProfileFile("pnpm-workspace.yaml");
	if (text === null) return { known: false, policy: null };
	const m = /^trustPolicy\s*:\s*(\S+)/m.exec(text);
	return { known: true, policy: m ? m[1].replace(/["']/g, "") : null };
}

export async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function firstExistingDir(candidates) {
	for (const dir of candidates) {
		try {
			if ((await stat(dir)).isDirectory()) return dir;
		} catch {
			/* next */
		}
	}
	return candidates[0] || null;
}

/** 已安装的 skill 目录名（用于快照/回滚）。 */
export async function listSkillDirs(root) {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name);
	} catch {
		return [];
	}
}

let cachedBuild = null;

/**
 * 构建标记（R5.1）。
 *
 * 为什么需要它：宿主侧代码**不热重载**，而 `/health` 以前把 `build` 写死成 `"p2-pack"`、
 * client 侧连个 build 号都没有 —— 「我现在跑的是哪一版代码」在面板上无法回答，只能靠重启猜。
 * 这里用 package.json 版本 + **源码文件里最新的 mtime** 生成可读标签：
 * 只要改了 index.js / client.js / lib/*.js 中的任何一个，标签就会变。
 *
 * @returns {Promise<{label:string, version:string, newestFile:string|null, files:number, at:string|null}>}
 */
export async function buildStamp(force = false) {
	if (cachedBuild && !force) return cachedBuild;
	const pkg = await readJson(join(PLUGIN_DIR, "package.json"));
	const version = (pkg && pkg.version) || "0.0.0";
	const candidates = ["index.js", "client.js"];
	try {
		for (const name of await readdir(join(PLUGIN_DIR, "lib"))) {
			if (name.endsWith(".js")) candidates.push(join("lib", name));
		}
	} catch {
		/* 没有 lib 目录也照常工作 */
	}
	let newest = 0;
	let newestFile = null;
	for (const rel of candidates) {
		try {
			const info = await stat(join(PLUGIN_DIR, rel));
			if (info.mtimeMs > newest) {
				newest = info.mtimeMs;
				newestFile = rel;
			}
		} catch {
			/* 缺文件不算错 */
		}
	}
	const pad = (n) => String(n).padStart(2, "0");
	const date = newest > 0 ? new Date(newest) : new Date();
	const stamp =
		date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
		" " + pad(date.getHours()) + ":" + pad(date.getMinutes());
	cachedBuild = {
		label: version + " · " + stamp,
		version,
		newestFile,
		files: candidates.length,
		at: newest > 0 ? new Date(newest).toISOString() : null
	};
	return cachedBuild;
}

/**
 * 已安装插件的版本（R5.1）。用于把「同一个插件再提交一次」说成
 * 升级 / 降级 / 同版本重装，而不是一律「装上了」。
 *
 * 只看 `profile/node_modules/<name>/package.json` —— 那是 installBundle 真正落地的位置。
 * @returns {Promise<{installed:boolean, version:string|null, name:string|null}>}
 */
export async function installedPluginInfo(name) {
	const dir = profileDir();
	if (!dir || !name) return { installed: false, version: null, name: null };
	const pkg = await readJson(join(dir, "node_modules", String(name), "package.json"));
	if (!pkg) return { installed: false, version: null, name: null };
	return { installed: true, version: pkg.version || null, name: pkg.name || String(name) };
}
