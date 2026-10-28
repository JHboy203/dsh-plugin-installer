/**
 * linkinstall.js — 「本机目录插件」的**免 pnpm 直连安装**（R31）。
 *
 * 为什么需要它（真实事故，2026-10-28）：
 *   用户自己写的插件在 `DSH-Plugin/dsh-xxx` 里，拖进面板 → 面板重打成 .tgz →
 *   `pluginManager.installBundle(file:…)` → **pnpm 重算整棵依赖树** → 这一步在本机
 *   被 profile 的 `trustPolicy: no-downgrade` 挡住（诱因是别的插件的传递依赖），
 *   于是「自己写的插件」永远装不上，报错还指向一个跟它无关的包。
 *
 *   而本机 46 个依赖里有 28 个本来就是 `link:` —— 它们当初是用
 *   `.tools/dsh-plugin-install.cjs` 装的：**建 junction + 改两行 profile 配置**，
 *   `pnpm` 一次都不跑。这条路对「自己的源码目录」天然更合适：
 *   改了代码就是新版，不用每轮重新打包、也不碰依赖树。
 *
 * 三件事固定在这里（纯判据在前、fs 在后，自检可以只喂对象）：
 *   ① 一条依赖声明是不是 link、指向哪儿、是不是**同一个目录**（`classifyEntry`）；
 *   ② 这次直连安装要改哪几处、有没有拦路的东西（`planLinkInstall`，纯函数）；
 *   ③ 真写盘：备份 → junction → 改 package.json（原子写）→ **回读复核**（`applyLinkInstall`）。
 *
 * 边界（写死，别放宽）：
 *   · 只在 `node_modules/<name>` **不存在或是链接** 时动手；**是真目录一律不动**（那是 pnpm 的地盘）；
 *   · 不改 `pnpm-lock.yaml`、不跑 pnpm（这正是它存在的理由）；
 *   · 写完必须能通过链接读到插件自己的 package.json，且版本号一致 —— 否则回滚。
 */
import { copyFile, lstat, mkdir, readFile, realpath, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** 面板自己的包名：直连安装自己会让「卸载/替换」变成拆自己的台。 */
export const SELF_PACKAGE = "dsh-plugin-installer";

/** 路径归一（比较用）：统一斜杠、去尾斜杠、剥掉 Windows 的 `\\?\` 前缀、不区分大小写。
 *
 * ⚠️ 那个前缀不是装饰：Windows 上 `readlink()` 读**目录联接（junction）** 返回的是
 * `\\?\C:\...` 形态，而 profile 里的 `link:` 声明是普通路径。不剥掉就永远判「不是同一个目录」——
 * 后果有两个，都很隐蔽：① 已经直连装着的插件会被判成「链到别处」→ 每次都想重建链接；
 * ② 回滚时不认这条链接 → 留下一个没人管的联接（本机实测踩到）。
 */
export function normalizePath(input) {
	let text = String(input || "").trim().replace(/\\/g, "/");
	if (/^\/\/\?\/|^\/\/\.\//.test(text)) text = text.slice(4);
	text = text.replace(/\/+$/, "");
	return process.platform === "win32" ? text.toLowerCase() : text;
}

/** 两个路径是不是同一个目录（大小写、斜杠、尾斜杠都抹平）。 */
export function samePath(a, b) {
	const left = normalizePath(a);
	const right = normalizePath(b);
	return left !== "" && left === right;
}

/**
 * 解析一条依赖声明：`link:` 指向哪个目录（相对路径按 profile 目录解析）。
 * @param {string|null} spec
 * @param {string|null} [profileDir]
 * @returns {{kind:"link"|"other"|"none", dir:string|null, relative:boolean}}
 */
export function parseLinkSpec(spec, profileDir) {
	const text = String(spec || "").trim();
	if (text === "") return { kind: "none", dir: null, relative: false };
	if (!/^link:/i.test(text)) return { kind: "other", dir: null, relative: false };
	const raw = text.slice(5).trim();
	if (raw === "") return { kind: "link", dir: null, relative: false };
	const relative = !isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw);
	const dir = relative && profileDir ? resolve(profileDir, raw) : resolve(raw);
	return { kind: "link", dir, relative };
}

/**
 * 现在 profile 里这个包算什么状态。
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string|null} [input.depSpec] profile package.json 里的 dependencies[name]
 * @param {string|null} [input.profileDir]
 * @param {string|null} [input.sourceDir] 候选源码目录
 * @returns {{kind:"link"|"other"|"none", dir:string|null, sameTarget:boolean, spec:string|null}}
 */
export function classifyEntry({ name, depSpec, profileDir, sourceDir } = {}) {
	const spec = typeof depSpec === "string" ? depSpec : null;
	const parsed = parseLinkSpec(spec, profileDir);
	if (parsed.kind !== "link") return { kind: parsed.kind, dir: parsed.dir, sameTarget: false, spec };
	return {
		kind: "link",
		dir: parsed.dir,
		sameTarget: Boolean(sourceDir && parsed.dir && samePath(parsed.dir, sourceDir)),
		spec
	};
}

/**
 * 这次直连安装要做什么、能不能做（**纯函数**，不碰盘）。
 *
 * @param {object} input
 * @param {string} input.name                 包里声明的名字
 * @param {string} input.sourceDir            源码目录（绝对路径）
 * @param {string|null} [input.profileDir]
 * @param {object} [input.manifest]           源码目录里的 package.json 内容
 * @param {object} [input.deps]               profile 的 dependencies
 * @param {string[]} [input.bundles]          profile 的 dsh.profile.bundles
 * @param {{exists:boolean, isLink:boolean, target:string|null, isDirectory:boolean}|null} [input.entry]
 *        node_modules/<name> 的现状（fs 层探，纯层只吃结论）
 * @returns {{ok:boolean, name:string, sourceDir:string, blocked:object|null,
 *   alreadyLinked:boolean, entryLinked:boolean, changes:{dependency:boolean, bundle:boolean, link:boolean, replaceEntry:boolean},
 *   steps:string[], note:string}}
 */
export function planLinkInstall(input = {}) {
	const name = String(input.name || "").trim();
	const sourceDir = String(input.sourceDir || "").trim();
	const profileDir = input.profileDir ? String(input.profileDir) : null;
	const manifest = input.manifest || null;
	const deps = input.deps && typeof input.deps === "object" ? input.deps : {};
	const bundles = Array.isArray(input.bundles) ? input.bundles : [];
	const entry = input.entry || null;
	const base = {
		ok: false,
		name,
		sourceDir,
		blocked: null,
		alreadyLinked: false,
		entryLinked: false,
		changes: { dependency: false, bundle: false, link: false, replaceEntry: false },
		steps: [],
		note: ""
	};
	const block = (code, text, plain, fix) => ({ ...base, blocked: { code, text, plain, fix: fix || [] } });

	if (!name) return block("no-name", "不知道这个插件的包名", "大白话：读不到 package.json 的 name，就不敢往 profile 里写依赖行。", [{ text: "确认源码目录里有 package.json，且写了 name" }]);
	if (!sourceDir) return block("no-source", "不知道源码目录在哪", "大白话：直连安装要把 node_modules 里那条链接指向一个真实目录。", [{ text: "用「本机路径」重新提交那个插件目录" }]);
	if (name === SELF_PACKAGE) {
		return block(
			"self-package",
			"不能在这里直连安装「插件安装」自己",
			"大白话：装的是它自己，改到一半面板就没了（依赖行与链接都指向正在跑的那份代码）。",
			[{ text: "它本来就是 link: 装着的；要换版本用官方插件管理器" }]
		);
	}
	if (manifest && !(manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch)) {
		return block(
			"not-bundle",
			"它的 package.json 没有声明 dsh.bundle.patch",
			"大白话：没有这一行，profile 里就算列了它也不会被挂载 —— 装了等于没装。",
			[{ text: "在 package.json 里补 dsh.bundle.patch（指向 cordis.patch.yml），再回来装" }]
		);
	}
	if (entry && entry.exists && !entry.isLink) {
		if (entry.isDirectory === false) {
			return block(
				"occupied-file",
				"node_modules/" + name + " 已经被一个文件占着",
				"大白话：这个位置上不是链接、也不是目录，是一个文件 —— 直连安装没法把它变成链接。",
				[{ text: "先确认那是什么文件（可能是手误放的），处理掉再回来装" }]
			);
		}
		return block(
			"real-directory",
			"node_modules/" + name + " 是一份**真实目录**（pnpm 装的），不是链接",
			"大白话：直连安装要把这条换成链接，但那份是 pnpm 的地盘 —— 直接删它等于绕过包管理器改依赖树。",
			[
				{ text: "先卸载那一份：官方插件管理器 / 「插件目录」的卸载，或回滚到装它之前" },
				{ text: "确认 node_modules 里没有它了，再回来点直连安装" },
				{ text: "必须两份并存：把源码目录换个包名（package.json 的 name）" }
			]
		);
	}

	const known = classifyEntry({ name, depSpec: deps[name], profileDir, sourceDir });
	const entryLinked = Boolean(entry && entry.exists && entry.isLink && entry.target && samePath(entry.target, sourceDir));
	const changes = {
		dependency: !(known.kind === "link" && known.sameTarget),
		bundle: !bundles.includes(name),
		link: !entryLinked,
		replaceEntry: Boolean(entry && entry.exists && entry.isLink && !entryLinked)
	};
	const steps = [];
	if (changes.replaceEntry) steps.push("node_modules/" + name + " 现在指向别处 → 改成指向这个目录");
	else if (changes.link) steps.push("建链接 node_modules/" + name + " → " + sourceDir);
	if (changes.dependency) steps.push("依赖声明 → link:" + sourceDir.replace(/\\/g, "/"));
	if (changes.bundle) steps.push("加进 dsh.profile.bundles（否则 profile 不会挂载它）");

	return {
		...base,
		ok: true,
		alreadyLinked: known.kind === "link" && known.sameTarget,
		entryLinked,
		changes,
		steps,
		note: changes.dependency || changes.bundle || changes.replaceEntry || changes.link ? "" : "已经是直连安装，profile 不需要改动"
	};
}

/* ── fs 层 ────────────────────────────────────────────────────────── */

/** 探 node_modules/<name>（不抛错）。
 *
 * ⚠️ **Windows 的目录联接（junction）不能用 lstat 认。** 实测（Node 24.21 / Windows 11）：
 *    · `lstat(junction).isSymbolicLink()` 是 **false**，`isDirectory()` 却是 true；
 *    · `readlink(junction)` 直接抛 **EINVAL**。
 *   所以「这是不是一条链接」只能靠 **realpath**：链接会被解析到目标，普通目录解析后还是自己。
 *   这个坑很贵 —— 只按 lstat 判的话：① 本机 28 个 pnpm 建的 junction 全被当成「真实目录」
 *   （直连安装会拒绝去做「已经做过」的事）；② 回滚时那条链接删不掉，留下一个没人管的联接。
 */
export async function probeEntry(profileDir, name) {
	const path = join(String(profileDir || ""), "node_modules", String(name));
	const info = await lstat(path).catch(() => null);
	if (!info) return { exists: false, isLink: false, target: null, isDirectory: false, path };
	const real = await realpath(path).catch(() => null);
	const isLink = Boolean(real && normalizePath(real) !== normalizePath(path));
	return { exists: true, isLink, target: real, isDirectory: info.isDirectory(), path };
}

/**
 * 删掉一条「链接/联接」。**不能用 unlink**：Windows 上对 junction 调 `unlink` 报 EPERM。
 * `rmdir` 对 junction 有效，而且**不会**动到目标目录（实测）。
 */
async function removeEntry(path) {
	try {
		await unlink(path);
		return "unlink";
	} catch (e) {
		if (!e || !["EPERM", "EISDIR", "ERR_FS_EISDIR", "EACCES"].includes(e.code)) throw e;
		await rmdir(path);
		return "rmdir";
	}
}

function stampNow() {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function readJsonSafe(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 真写盘。顺序固定：**先把该拒绝的都拒掉 → 再备份 → 再建链接 → 最后改配置**。
 * 配置最后改，是因为「配置说 link 但链接没建」比「链接在但配置没写」更糟：
 * 前者会被 pnpm 当成坏依赖，后者只是没生效（面板会明确说没生效）。
 *
 * @returns {Promise<{ok:boolean, changed:boolean, blocked:object|null, file:string|null, backup:string|null,
 *   changes:object, verified:object, plan:object|null, error?:string}>}
 */
export async function applyLinkInstall({ profileDir, name, sourceDir, manifest, backupDir, dryRun = false } = {}) {
	const dir = profileDir ? String(profileDir) : null;
	if (!dir) return { ok: false, changed: false, blocked: null, file: null, backup: null, changes: {}, verified: {}, plan: null, error: "读不到 profile 目录" };
	const pkgPath = join(dir, "package.json");
	const pkg = await readJsonSafe(pkgPath);
	if (!pkg) return { ok: false, changed: false, blocked: null, file: pkgPath, backup: null, changes: {}, verified: {}, plan: null, error: "读不到 profile 的 package.json（或不是合法 JSON）" };
	const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
	const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
	const entry = await probeEntry(dir, name);
	/* 把源码目录换成**规范路径**：realpath 会把 junction / 8.3 短名 / 大小写都抹平，
	   这样「同一条链接」的比较才稳定（probeEntry 返回的 target 就是规范路径）。 */
	const canonical = await realpath(String(sourceDir || "")).catch(() => String(sourceDir || ""));
	const plan = planLinkInstall({ name, sourceDir: canonical, profileDir: dir, manifest, deps, bundles, entry });
	if (!plan.ok) return { ok: false, changed: false, blocked: plan.blocked, file: pkgPath, backup: null, changes: {}, verified: {}, plan, error: plan.blocked ? plan.blocked.text : "计划被拒" };
	if (!plan.changes.link && !plan.changes.replaceEntry && !plan.changes.dependency && !plan.changes.bundle) {
		return { ok: true, changed: false, blocked: null, file: pkgPath, backup: null, changes: plan.changes, verified: { already: true }, plan };
	}
	if (dryRun) return { ok: true, changed: false, blocked: null, file: pkgPath, backup: null, changes: plan.changes, verified: {}, plan, error: null };

	/* ① 备份（在 profile 目录里留一份带时间戳的，另有 backupDir 时再拷一份） */
	const backup = join(dir, ".package.json.backup-" + stampNow());
	try {
		await copyFile(pkgPath, backup);
		if (backupDir) {
			await mkdir(backupDir, { recursive: true });
			await copyFile(pkgPath, join(backupDir, "package.json")).catch(() => null);
		}
	} catch (e) {
		return { ok: false, changed: false, blocked: null, file: pkgPath, backup: null, changes: {}, verified: {}, plan, error: "备份失败（不敢继续）：" + String((e && e.message) || e) };
	}

	/* ② 建/换链接 */
	const linkPath = join(dir, "node_modules", name);
	try {
		await mkdir(join(dir, "node_modules"), { recursive: true });
		if (plan.changes.link) {
			/* 只有「不存在」或「是一条指向别处的链接」才走到这里；真实目录在 plan 里已经被拒。
			   ⚠️ 删旧链接必须走 removeEntry：Windows 上对 junction 调 unlink 是 EPERM。 */
			if (entry.exists && entry.isLink) await removeEntry(linkPath).catch(() => null);
			await symlink(canonical, linkPath, process.platform === "win32" ? "junction" : "dir");
		}
	} catch (e) {
		return { ok: false, changed: false, blocked: null, file: pkgPath, backup, changes: {}, verified: {}, plan, error: "建链接失败：" + String((e && e.message) || e) };
	}

	/* ③ 改配置（原子写） */
	const next = {
		...pkg,
		dependencies: { ...deps, [name]: "link:" + String(canonical).replace(/\\/g, "/") },
		dsh: {
			...(pkg.dsh || {}),
			profile: {
				...((pkg.dsh && pkg.dsh.profile) || {}),
				bundles: bundles.includes(name) ? bundles.slice() : bundles.concat([name])
			}
		}
	};
	let wrote = false;
	try {
		const tmp = pkgPath + "." + process.pid + ".link.tmp";
		await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
		try {
			await rename(tmp, pkgPath);
			wrote = true;
		} catch {
			await copyFile(tmp, pkgPath);
			await unlink(tmp).catch(() => null);
			wrote = true;
		}
	} catch (e) {
		/* 配置没写成：把刚建的链接收回去，别留一个「链接在、配置没写」的半截状态 */
		if (plan.changes.link || plan.changes.replaceEntry) await removeEntry(linkPath).catch(() => null);
		return { ok: false, changed: false, blocked: null, file: pkgPath, backup, changes: {}, verified: {}, plan, error: "写 profile 配置失败（已收回链接）：" + String((e && e.message) || e) };
	}

	/* ④ 回读复核：配置真的写了 + 通过链接真的读得到插件自己 */
	const after = await readJsonSafe(pkgPath);
	const depOk = Boolean(after && after.dependencies && String(after.dependencies[name] || "").toLowerCase().startsWith("link:"));
	const bundleOk = Boolean(after && after.dsh && after.dsh.profile && Array.isArray(after.dsh.profile.bundles) && after.dsh.profile.bundles.includes(name));
	const throughLink = await readJsonSafe(join(linkPath, "package.json"));
	const linkOk = Boolean(throughLink && throughLink.name === name);
	const verified = { dependency: depOk, bundle: bundleOk, link: linkOk, version: throughLink ? throughLink.version || null : null, wrote };
	if (!depOk || !bundleOk || !linkOk) {
		await copyFile(backup, pkgPath).catch(() => null);
		if (plan.changes.link || plan.changes.replaceEntry) await removeEntry(linkPath).catch(() => null);
		return { ok: false, changed: false, blocked: null, file: pkgPath, backup, changes: plan.changes, verified, plan, error: "写后复核没过（依赖行/清单/链接至少一项不对），已还原" };
	}
	return { ok: true, changed: true, blocked: null, file: pkgPath, backup, changes: plan.changes, verified, plan, error: null };
}

/**
 * 撤掉一次直连安装（回滚用）。
 * 只做两件事：把依赖行与清单项去掉、把**指向这个目录的**链接删掉。
 * 不碰别人的链接、不碰真实目录。
 */
export async function undoLinkInstall({ profileDir, name, sourceDir } = {}) {
	const dir = profileDir ? String(profileDir) : null;
	if (!dir) return { ok: false, error: "读不到 profile 目录" };
	const pkgPath = join(dir, "package.json");
	const pkg = await readJsonSafe(pkgPath);
	if (!pkg) return { ok: false, error: "读不到 profile 的 package.json" };
	const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? { ...pkg.dependencies } : {};
	const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : [];
	const entry = await probeEntry(dir, name);
	const linkedToSource = Boolean(entry.exists && entry.isLink && entry.target && samePath(entry.target, sourceDir));
	const removed = [];
	if (Object.prototype.hasOwnProperty.call(deps, name)) {
		delete deps[name];
		removed.push("dependency");
	}
	const idx = bundles.indexOf(name);
	if (idx >= 0) {
		bundles.splice(idx, 1);
		removed.push("bundle");
	}
	const next = {
		...pkg,
		dependencies: deps,
		dsh: { ...(pkg.dsh || {}), profile: { ...((pkg.dsh && pkg.dsh.profile) || {}), bundles } }
	};
	try {
		const tmp = pkgPath + "." + process.pid + ".undo.tmp";
		await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
		try {
			await rename(tmp, pkgPath);
		} catch {
			await copyFile(tmp, pkgPath);
			await unlink(tmp).catch(() => null);
		}
		if (linkedToSource) {
			/* 同样是 removeEntry：junction 用 unlink 会 EPERM */
			await removeEntry(entry.path).catch(() => null);
			removed.push("link");
		}
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e), removed };
	}
	return { ok: true, removed, linkedToSource };
}

export const __test = { normalizePath, samePath, parseLinkSpec, classifyEntry, planLinkInstall };
