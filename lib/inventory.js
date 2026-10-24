/**
 * inventory.js — 「我装了哪些插件、哪些能升级」（R12）。
 *
 * 为什么要有它：面板以前只会**装**。想知道「哪些落后了」得自己记得名字、搜一次、再提交一次，
 * 而面板从头到尾没回答过这个问题 —— 于是一个「装/升级面板」在升级这件事上等于没有入口。
 *
 * 判据（全部确定性、可单测，不联网）：profile 的 `package.json` 里每条依赖按声明形态分成四类，
 * 它们的「能不能升级」完全不同，混在一起讲就会把人带沟里：
 *
 *   · `npm` 范围（`^1.2.0` / `1.2.3` / `npm:real-name@^1`）—— **只有这一类**有「registry 上的新版本」；
 *   · `link:` 是**本机源码目录**（改了立刻生效），不是「落后」，也没有新版本可比；
 *   · `file:` 是**本面板重打包的 .tgz**（在 `data/vendor/`），升级要重新提交一份新包；
 *   · `github:` / git 地址：版本在仓库 manifest 里、不在 registry 上 —— 猜出来的「新版本」比不报更糟。
 *
 * ⚠️ `@deepseek-ai/*` 一律标成「宿主自带、不参与升级」：从 npm 装第二份会遮蔽宿主
 *    （就是 dsh-tools 那个雷的同类问题），所以哪怕声明成 npm 范围也不许当「可升级」。
 *
 * 这一层**只读文件系统**；联网比对在 `lib/updates.js`，面板按需点「检查更新」才发请求。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { profileDir as defaultProfileDir } from "./hostinfo.js";

/** 宿主自带的包：绝不参与「从 npm 升级」（第二份会遮蔽宿主）。 */
const HOST_SCOPE = /^@deepseek-ai\//;

/** 与 profile 的 package.json 里出现的四类声明形态对齐。 */
const DEP_KINDS = ["npm", "link", "tarball", "git", "workspace", "unknown"];

async function readJson(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * `npm:real-name@^1.0.0` → `{ name: "real-name", range: "^1.0.0" }`。
 * 别用 `lastIndexOf("@")` 直接切：`@scope/name` 也以 `@` 开头，
 * 先剥别名前缀再按「最后一个 @」切才安全（纯函数）。
 */
export function npmAliasTarget(text) {
	const raw = String(text ?? "").trim();
	const body = raw.startsWith("npm:") ? raw.slice(4) : raw;
	const at = body.lastIndexOf("@");
	if (at > 0) return { name: body.slice(0, at), range: body.slice(at + 1) || "latest" };
	return { name: body, range: "latest" };
}

/**
 * 一条依赖声明的形态。
 * @returns {{kind:string, label:string, checkable:boolean, registryName:string|null, range:string|null, why:string}}
 */
export function classifyDepSpec(spec, depName = "") {
	const text = String(spec ?? "").trim();
	const name = String(depName || "").trim();
	if (!text) {
		return { kind: "unknown", label: "没写版本", checkable: false, registryName: null, range: null,
			why: "profile 里没声明版本范围，没法比对" };
	}
	if (text.startsWith("link:")) {
		return { kind: "link", label: "本机目录", checkable: false, registryName: null, range: null,
			why: "link: 指向本机源码目录 —— 改了就生效，没有「新版本」这回事" };
	}
	if (text.startsWith("file:")) {
		return { kind: "tarball", label: "本面板装的 .tgz", checkable: false, registryName: null, range: null,
			why: "file: 指向本面板重打包的 .tgz（data/vendor）；升级要重新提交一份新包" };
	}
	if (/^(workspace:|portal:|patch:)/i.test(text)) {
		return { kind: "workspace", label: "工作区/补丁", checkable: false, registryName: null, range: null,
			why: "workspace / portal / patch 是本地工作区依赖，不参与 registry 比对" };
	}
	if (/^(github:|gh:|git\+|git:|bitbucket:|gitlab:|https?:\/\/[^\s]*\.git|https?:\/\/(github|gitlab|bitbucket)\.)/i.test(text)) {
		return { kind: "git", label: "Git 仓库", checkable: false, registryName: null, range: null,
			why: "来自 Git 仓库：版本在仓库 manifest 里，不在 registry 上；要更新请重新提交仓库链接或新的包" };
	}
	if (text.startsWith("npm:")) {
		const target = npmAliasTarget(text);
		return { kind: "npm", label: "npm（别名）", checkable: true, registryName: target.name, range: target.range,
			why: "npm: 别名依赖，可以去 registry 比对最新版" };
	}
	return { kind: "npm", label: "npm", checkable: true, registryName: name || text, range: text,
		why: "来自 npm registry，可以比对最新版" };
}

/**
 * 读 profile 的依赖清单（纯本地，不发网络请求）。
 *
 * @param {{profileDir?: string|null}} [options]
 * @returns {Promise<{ok:boolean, at:string, profileDir:string|null, items:Array, counts:object,
 *   problems:Array, note?:string, reason?:string}>}
 */
export async function readInventory(options = {}) {
	const at = new Date().toISOString();
	const dir = options.profileDir === undefined ? defaultProfileDir() : options.profileDir;
	if (!dir) {
		return {
			ok: false, reason: "no-profile", at, profileDir: null,
			items: [], counts: emptyCounts(), problems: [],
			note: "认不出 profile 目录（DSH_PROFILE_DIR 未设置、宿主 cwd 也不是 profiles/<name>）"
		};
	}
	const pkg = await readJson(join(dir, "package.json"));
	if (!pkg) {
		return {
			ok: false, reason: "no-profile-package", at, profileDir: dir,
			items: [], counts: emptyCounts(), problems: [],
			note: "读不到 " + join(dir, "package.json")
		};
	}
	const deps = (pkg && pkg.dependencies) || {};
	const bundles = new Set((((pkg.dsh || {}).profile || {}).bundles || []).map(String));
	const items = [];
	for (const [name, spec] of Object.entries(deps)) {
		const cls = classifyDepSpec(spec, name);
		const local = await readJson(join(dir, "node_modules", name, "package.json"));
		const hostScoped = HOST_SCOPE.test(name);
		items.push({
			name,
			spec: String(spec),
			kind: cls.kind,
			kindLabel: cls.label,
			why: cls.why,
			registryName: cls.registryName,
			range: cls.range,
			/* 宿主自带的一律不许「从 npm 升级」，哪怕它声明成 npm 范围 */
			checkable: Boolean(cls.checkable) && !hostScoped,
			hostScoped,
			installed: Boolean(local),
			localVersion: (local && local.version) || null,
			bundle: bundles.has(name)
		});
	}
	items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const counts = countOf(items);
	const problems = items
		.filter((item) => !item.installed)
		.map((item) => ({
			name: item.name,
			code: "declared-not-installed",
			text: "声明了这个依赖，但 node_modules 里读不到它 —— 清单与实物对不上（install_hub_doctor 会细查）"
		}));
	return { ok: true, at, profileDir: dir, items, counts, problems };
}

function emptyCounts() {
	const byKind = {};
	for (const kind of DEP_KINDS) byKind[kind] = 0;
	return { total: 0, bundle: 0, byKind, checkable: 0, hostScoped: 0, missing: 0 };
}

function countOf(items) {
	const byKind = {};
	for (const kind of DEP_KINDS) byKind[kind] = 0;
	let checkable = 0;
	let hostScoped = 0;
	let missing = 0;
	let bundle = 0;
	for (const item of items) {
		if (byKind[item.kind] === undefined) byKind[item.kind] = 0;
		byKind[item.kind] += 1;
		/* 「可比对」= 形态允许 + 真的落地了（声明了却不在磁盘上的，没有本地版本可比） */
		if (item.checkable && item.installed) checkable += 1;
		if (item.hostScoped) hostScoped += 1;
		if (!item.installed) missing += 1;
		if (item.bundle) bundle += 1;
	}
	return { total: items.length, bundle, byKind, checkable, hostScoped, missing };
}

/** 一行摘要（面板与工具共用同一句话，避免两套口径）。 */
export function summarizeInventory(counts) {
	if (!counts) return "读不到已装清单";
	if (!counts.total) return "0 个依赖（这个 profile 还没装东西）";
	const byKind = counts.byKind || {};
	const parts = [];
	parts.push(counts.total + " 个依赖");
	if (counts.bundle) parts.push(counts.bundle + " 个在 bundle 行里");
	const kinds = [];
	if (byKind.npm) kinds.push("npm " + byKind.npm);
	if (byKind.link) kinds.push("本机目录 " + byKind.link);
	if (byKind.tarball) kinds.push(".tgz " + byKind.tarball);
	if (byKind.git) kinds.push("Git " + byKind.git);
	if (byKind.workspace) kinds.push("工作区 " + byKind.workspace);
	if (kinds.length) parts.push(kinds.join(" / "));
	if (counts.checkable) parts.push("可比对最新版 " + counts.checkable);
	if (counts.hostScoped) parts.push("宿主自带 " + counts.hostScoped + "（不参与升级）");
	return parts.join(" · ");
}

/** 只保留「值得看一眼」的行（面板默认折叠时用）。 */
export function inventoryHighlights(items, limit = 6) {
	return (items || [])
		.filter((item) => (item.update && item.update.relation === "outdated") || !item.installed || (item.update && item.update.error))
		.slice(0, Math.max(1, limit));
}

/** 名字 → 本机已装版本 的索引（大小写不敏感；没装的不进表）。 */
export function installedIndex(inventory) {
	const map = new Map();
	for (const item of (inventory && inventory.items) || []) {
		if (item && item.installed) map.set(String(item.name).toLowerCase(), item.localVersion || null);
	}
	return map;
}

/**
 * 给搜索结果补「已装」标记（R12）。
 *
 * 为什么要有这一条：搜索卡片看起来永远像「还没装」，于是人会重复提交同一个包；
 * 而「已装 v0.1.0」与「没装」在决策上是两件事（后者直接装，前者要想清楚是不是升级）。
 * 只按**包名精确匹配**——名字对不上就是没装，不猜。
 */
export function annotateInstalled(items, inventory) {
	const index = installedIndex(inventory);
	return (items || []).map((item) => {
		const key = String((item && item.name) || "").toLowerCase();
		const known = index.has(key);
		return { ...item, installed: known ? index.get(key) : null, installedKnown: known };
	});
}

/**
 * 官方（`@deepseek-ai/*`）包名里**不带作用域的那一半**（R23）。
 *
 * 为什么要它：搜索里会出现「未加作用域的同名包」——例如官方是 `@deepseek-ai/dsh-base`，
 * 而 npm 上另有 `dsh-base`（别人发的）。两者在结果卡片上看起来几乎一样，装错了就是另一份代码。
 * 判据只认本机事实：profile 的 dependencies / bundles / `node_modules/@deepseek-ai` 目录里
 * 真实存在的名字。不凭「名字像官方」猜。
 *
 * @param {string|null} dir profile 目录
 * @returns {Promise<Set<string>>} 小写 basename 集合（如 `dsh-base`、`dsh-tools`）
 */
export async function officialBasenames(dir) {
	const set = new Set();
	const add = (name) => {
		const m = /^@deepseek-ai\/(.+)$/i.exec(String(name || "").trim());
		if (m) set.add(m[1].toLowerCase());
	};
	const target = dir === undefined ? defaultProfileDir() : dir;
	if (!target) return set;
	const pkg = await readJson(join(target, "package.json"));
	if (pkg) {
		for (const name of Object.keys(pkg.dependencies || {})) add(name);
		const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
		for (const name of bundles) add(name);
	}
	try {
		const entries = await readdir(join(target, "node_modules", "@deepseek-ai"), { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() || entry.isSymbolicLink()) set.add(entry.name.toLowerCase());
		}
	} catch {
		/* 没装官方包（或读不到）时 just 空集合 */
	}
	return set;
}

/**
 * 给搜索结果补「影子包」警戒（R23）：名字撞了官方包、但全名不是官方那个。
 *
 * 只做**确定性**判断（本机真实存在的官方名），并且对官方包自己绝不误报。
 * 影子包的分数再降 20（只是排序信号，不影响其它红旗）。
 */
export function annotateShadows(items, official) {
	if (!official || official.size === 0) return items || [];
	return (items || []).map((item) => {
		const full = String((item && item.name) || "").toLowerCase();
		if (!full) return item;
		const slash = full.indexOf("/");
		const scoped = full.startsWith("@") && slash > 0;
		const scope = scoped ? full.slice(1, slash) : "";
		const base = scoped ? full.slice(slash + 1) : full;
		if (!official.has(base)) return item;
		if (scope === "deepseek-ai") return item;
		const officialName = "@deepseek-ai/" + base;
		const text = scoped
			? "名字是 " + base + "，但作用域是 @" + scope + "；官方那份是 " + officialName + " —— 不是同一个包，装之前确认"
			: "未加作用域的同名包；官方那份是 " + officialName + " —— 这条不是它，装之前确认要哪一个";
		const trust = item.trust || { level: "community", badges: [], flags: [], score: 40 };
		const flags = Array.isArray(trust.flags) ? trust.flags.slice() : [];
		if (!flags.some((f) => f && f.id === "official-shadow")) flags.push({ id: "official-shadow", tone: "error", text });
		const score = Math.max(0, Math.min(100, (typeof trust.score === "number" ? trust.score : 40) - 20));
		return { ...item, shadowOf: officialName, trust: { ...trust, flags, score } };
	});
}
