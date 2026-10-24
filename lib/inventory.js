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
			/* R25：来源指纹 —— 搜索卡上「同名但不同来源」只能靠它对账 */
			repoKey: repoKey((local && local.repository) || null),
			repoUrl: (local && local.repository && (typeof local.repository === "string" ? local.repository : local.repository.url)) || null,
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

/**
 * 把一个仓库地址归一成 `host/owner/repo`（R25）。
 *
 * 为什么要它：搜索卡上的「已装」以前只按**包名**匹配。可这个 profile 里 47 个依赖有 24 个是
 * `link:` 的**本机目录**（自己写的插件），它们的名字和 npm 上的某个包可能撞车 ——
 * 卡片写着「已装 v0.1.0」，用户会以为讲的是同一个包，点安装就把本机那份换掉了。
 * 判据只能落到「来源」上，而来源的唯一可比字段是 `repository`。
 *
 * 认得的写法（真机都出现过）：`git+https://github.com/o/r.git`、`https://github.com/o/r`、
 * `github:o/r`、`git@github.com:o/r.git`、裸的 `o/r`、以及 `{ url }` 对象。
 * `…/tree/<branch>/<subdir>` 这类**子目录**只取前两段（同一个仓库不算不同来源）。
 *
 * @returns {string|null} 小写 `github.com/o/r`；认不出返回 null（**不猜**）
 */
export function repoKey(input) {
	let text = "";
	if (typeof input === "string") text = input;
	else if (input && typeof input === "object" && typeof input.url === "string") text = input.url;
	else if (input && typeof input === "object" && typeof input.repository === "string") text = input.repository;
	text = String(text || "").trim();
	if (!text) return null;
	/* scp 形式：git@github.com:owner/repo.git */
	const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(text);
	if (scp) return finishRepoKey(scp[1], scp[2]);
	/* 短前缀：github:owner/repo / gh:owner/repo */
	const short = /^(?:github|gh|gitlab|bitbucket):(.+)$/i.exec(text);
	if (short) return finishRepoKey(null, short[1]);
	text = text.replace(/^git\+/i, "");
	if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(text)) return finishRepoKey(null, text);
	let url = null;
	try {
		url = new URL(text.replace(/^git:\/\//i, "https://"));
	} catch {
		return null;
	}
	return finishRepoKey(url.host, url.pathname);
}

function finishRepoKey(host, pathPart) {
	const clean = String(pathPart || "")
		.replace(/\.git$/i, "")
		.split("/")
		.map((seg) => seg.trim())
		.filter(Boolean);
	if (clean.length < 2) return null;
	const owner = clean[0].toLowerCase();
	const repo = clean[1].toLowerCase();
	if (!owner || !repo) return null;
	const hostName = String(host || "github.com").toLowerCase().replace(/^www\./, "");
	return hostName + "/" + owner + "/" + repo;
}

/**
 * 搜索结果里这条「同名」的和本机已装的那份，是不是**同一个来源**（R25）。
 *
 * | 本机来源 | 判定 |
 * |---|---|
 * | `link:` 本机目录 | **一定不同**（本机目录 vs registry）→ error：装它会把你本机那份换掉 |
 * | `github:` / 其它 git | 仓库对得上才算同 |
 * | `file:` 本面板的 .tgz | 仓库对得上才算同；否则只说「可能不是同一份打包」 |
 * | npm 范围 | 两边 `repository` 都已知才判；有一边未知 → `unknown`（不猜，也不标红） |
 *
 * @param {{kind:string, kindLabel?:string, spec:string, localVersion?:string|null, repoKey?:string|null}} known
 * @param {{name?:string, repoUrl?:string, url?:string, source?:string}} candidate
 * @returns {{source:"same"|"different"|"unknown", tone:"error"|"warn"|"ok", text:string|null}}
 */
export function compareInstalledSource(known, candidate) {
	if (!known) return { source: "unknown", tone: "ok", text: null };
	const cand = repoKey((candidate && (candidate.repoUrl || candidate.url)) || "");
	const candLabel = cand || "（没给仓库地址）";
	const mineLabel = known.repoKey || known.spec || "?";
	const via = (candidate && candidate.source) || "这次搜到的这条";
	if (known.kind === "link") {
		return {
			source: "different",
			tone: "error",
			text: "同名但来源不同：本机这份是**本机目录**（" + known.spec + "），这条来自 " + via +
				" —— 装它会把本机那份换掉，别把「已装」当成同一个包"
		};
	}
	if (known.kind === "git") {
		if (cand && known.repoKey && cand === known.repoKey) return { source: "same", tone: "ok", text: null };
		return {
			source: "different",
			tone: "warn",
			text: "同名但来源不同：本机这份来自 Git 仓库（" + known.spec + "），这条来自 " + via +
				"（" + candLabel + "）—— 不是同一份来源"
		};
	}
	if (known.kind === "tarball") {
		if (cand && known.repoKey && cand === known.repoKey) return { source: "same", tone: "ok", text: null };
		return {
			source: cand && known.repoKey ? "different" : "unknown",
			tone: "warn",
			text: "同名：本机这份是本面板打的 .tgz（" + known.spec + "），这条来自 " + via +
				" —— 只有当初就是从它打的包对得上，装之前确认"
		};
	}
	/* npm 范围：两边都知道仓库才判；一边未知就别猜 */
	if (!known.repoKey || !cand) return { source: "unknown", tone: "ok", text: null };
	if (known.repoKey === cand) return { source: "same", tone: "ok", text: null };
	return {
		source: "different",
		tone: "warn",
		text: "同名但仓库不同：本机这份声明 " + mineLabel + "，这条声明 " + cand +
			" —— 同名不同仓库，装之前确认要哪一个"
	};
}

/** 只保留「值得看一眼」的行（面板默认折叠时用）。 */
export function inventoryHighlights(items, limit = 6) {
	return (items || [])
		.filter((item) => (item.update && item.update.relation === "outdated") || !item.installed || (item.update && item.update.error))
		.slice(0, Math.max(1, limit));
}

/**
 * 名字 → 本机已装那份的**来源档案**（大小写不敏感；没装的不进表）。
 *
 * R25 起值不再是版本号字符串，而是 `{version, kind, kindLabel, spec, repoKey, repoUrl}` ——
 * 因为「已装」这个判断必须能回答「装的是**哪一个**」：本机目录 / npm / .tgz / Git 是四种来源，
 * 同名不等于同一个包。
 */
export function installedIndex(inventory) {
	const map = new Map();
	for (const item of (inventory && inventory.items) || []) {
		if (!item || !item.installed) continue;
		map.set(String(item.name).toLowerCase(), {
			version: item.localVersion || null,
			kind: item.kind || "npm",
			kindLabel: item.kindLabel || "",
			spec: item.spec || "",
			repoKey: item.repoKey || null,
			repoUrl: item.repoUrl || null
		});
	}
	return map;
}

/**
 * 给搜索结果补「已装」标记（R12），并在 R25 补上**来源对账**。
 *
 * 为什么要有这一条：搜索卡片看起来永远像「还没装」，于是人会重复提交同一个包；
 * 而「已装 v0.1.0」与「没装」在决策上是两件事（后者直接装，前者要想清楚是不是升级）。
 * 只按**包名精确匹配**——名字对不上就是没装，不猜。
 *
 * R25 补的一层：名字对上了，**来源**未必对得上。本机 24 个依赖是 `link:` 本机目录
 * （自己写的插件），它们的名字和 npm 上的包撞车时，卡片写「已装」会让人以为是同一个包，
 * 点安装就把本机那份换掉 —— 所以这里给出 `installedSource`（same/different/unknown）
 * 并在 different 时往 `trust.flags` 里塞一条红旗。
 */
export function annotateInstalled(items, inventory) {
	const index = installedIndex(inventory);
	return (items || []).map((item) => {
		const key = String((item && item.name) || "").toLowerCase();
		const known = index.get(key) || null;
		if (!known) return { ...item, installed: null, installedKnown: false };
		const verdict = compareInstalledSource(known, item);
		const out = {
			...item,
			installed: known.version,
			installedKnown: true,
			installedKind: known.kind,
			installedKindLabel: known.kindLabel,
			installedSpec: known.spec,
			installedSource: verdict.source
		};
		if (verdict.source === "different" && verdict.text) {
			const trust = item.trust && typeof item.trust === "object" ? item.trust : { level: "unknown", badges: [], flags: [], score: null };
			out.trust = {
				...trust,
				flags: [...(Array.isArray(trust.flags) ? trust.flags : []), { id: "name-collision", tone: verdict.tone, text: verdict.text }]
			};
		}
		return out;
	});
}

/**
 * 「你搜的这个名字，其实是你本机装的插件」（R25）。
 *
 * 真实场景：搜 `dsh-screenshot`（本机目录装的自己写的插件）→ npm / GitHub 都没这个名字，
 * 于是结果里全是 6 个**毫不相干**的官方包，而工具输出一个字都不解释。人会以为搜索坏了。
 * 判据只要两件事：查询词精确等于某个已装依赖名，且这次结果里没有一条同名。
 *
 * @returns {{name:string,version:string|null,kind:string,kindLabel:string,spec:string,text:string}|null}
 */
export function localOnlyHint(inventory, query, items) {
	const q = String(query || "").trim().toLowerCase();
	if (!q) return null;
	const exact = (items || []).some((item) => String((item && item.name) || "").toLowerCase() === q);
	if (exact) return null;
	const hit = ((inventory && inventory.items) || []).find((item) => item && String(item.name).toLowerCase() === q && item.installed);
	if (!hit) return null;
	const where = hit.kind === "link" ? "本机目录装的（link:），不会出现在 npm / GitHub 的检索结果里"
		: hit.kind === "tarball" ? "本面板打的 .tgz 装的，不会出现在这些源里"
		: "已装，但这次检索没返回同名条目（可能是源暂时不可用，或它已下架）";
	return {
		name: hit.name,
		version: hit.localVersion || null,
		kind: hit.kind,
		kindLabel: hit.kindLabel,
		spec: hit.spec,
		text: "「" + hit.name + "」是本机已装的插件（" + hit.kindLabel + "），" + where
	};
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
