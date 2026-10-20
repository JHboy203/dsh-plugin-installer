/**
 * landmine.js — profile 里那份「不该存在的 @deepseek-ai/dsh-tools」。
 *
 * 本机已复发四次的坑：任何一次走 pnpm 的安装/卸载都可能把 dsh-tools 装进
 * profile，而插件是按**路径**算模块标识的 —— 于是同一个包出现两个实例、
 * 两个 Symbol，下次启动插件批量加载失败（`reading 'prepare'` 或
 * `does not provide an export named 'CallId'`）。
 *
 * pnpm 的 overrides 只管版本号对不对，**不阻止它被装进来**；`autoInstallPeers: false`
 * 也挡不住 `link:` 本地包。所以唯一可靠的动作是：**每次 pnpm 之后检查一次，
 * 发现有就挪进备份目录**（与 .tools/dsh_doctor.py --fix 同一套处置）。
 *
 * 这件事必须在**重启之前**做完；启动后再修已经晚了（那一轮已经加载失败）。
 */
import { cp, mkdir, readdir, rename, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";

const PKG = "@deepseek-ai";
const TARGET = "dsh-tools";

export async function checkDshToolsShadow(profileDir) {
	if (!profileDir) return { present: false, reason: "没有 profile 目录" };
	const dir = join(profileDir, "node_modules", PKG, TARGET);
	let info = null;
	try {
		info = await stat(dir);
	} catch {
		return { present: false };
	}
	if (!info.isDirectory()) return { present: false };
	let version = null;
	try {
		const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
		version = pkg.version || null;
	} catch {
		version = null;
	}
	return { present: true, path: dir, version };
}

/**
 * 把那份副本挪走（rename，跨卷失败退回复制+删除）。
 * @returns {{moved:boolean, from?:string, to?:string, error?:string}}
 */
export async function quarantineDshTools(profileDir, backupsRoot) {
	const found = await checkDshToolsShadow(profileDir);
	if (!found.present) return { moved: false };
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const to = join(backupsRoot || join(profileDir, "..", "..", "..", ".tools", "backups"), "dsh-tools-stale-" + stamp);
	try {
		await mkdir(join(to, ".."), { recursive: true });
		try {
			await rename(found.path, to);
		} catch {
			await cp(found.path, to, { recursive: true, force: true });
			await rm(found.path, { recursive: true, force: true });
		}
		return { moved: true, from: found.path, to, version: found.version };
	} catch (e) {
		return { moved: false, from: found.path, error: String((e && e.message) || e) };
	}
}

/**
 * 回滚时清掉 installBundle 留下的悬空链接。
 * 只在「package.json 已不再声明它」且「node_modules 里那条是符号链接」时删，
 * 避免误删别的包真需要的目录。
 */
export async function removeDanglingLink(profileDir, name) {
	if (!profileDir || !name) return { removed: false };
	let declared = false;
	try {
		const pkg = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		declared = Boolean(pkg.dependencies && pkg.dependencies[name]);
	} catch {
		declared = true; /* 读不到就保守：不动 */
	}
	if (declared) return { removed: false, reason: "package.json 仍声明它" };
	const link = join(profileDir, "node_modules", name);
	let info = null;
	try {
		info = await import("node:fs/promises").then((m) => m.lstat(link));
	} catch {
		return { removed: false, reason: "没有残留链接" };
	}
	if (!info.isSymbolicLink()) return { removed: false, reason: "不是符号链接，不删" };
	try {
		await rm(link, { force: true });
		return { removed: true, path: link };
	} catch (e) {
		return { removed: false, error: String((e && e.message) || e) };
	}
}

/** 只读：node_modules 顶层有哪些 link: 装的包（支持时展示用）。 */
export async function listLinkedPackages(profileDir) {
	try {
		const dir = join(profileDir, "node_modules");
		const entries = await readdir(dir, { withFileTypes: true });
		const out = [];
		for (const entry of entries) {
			if (!entry.isSymbolicLink()) continue;
			out.push(entry.name);
		}
		return out;
	} catch {
		return [];
	}
}
