/**
 * sources.js — 「从哪儿搜」+ 「这条东西可不可信 / 有多出名」（确定性，零 token）。
 *
 * 背景（2026-10-20 R3，用户要求）：
 *   以前只有两个源：npm registry 的全文搜索 + GitHub 的 `<query> dsh` 仓库搜索，
 *   而且结果里**只有名字、描述、stars**。用户要的是：
 *     ① 搜得更广；② 标出安全性（官方/有许可证/有源码/是否可疑）；③ 标出知名度（下载量、stars、评分）。
 *
 * 这里承担 ① 与 ②③ 的**确定性**部分：
 *   · 多源并发：npm（两个查询串）+ GitHub 仓库（两串）+ GitHub topic（发现用）；
 *   · 每命中都算出 `trust`（等级 + 徽章 + 红旗）与 `popularity`（原始数 + 0~100 归一）；
 *   · 最后给一个 `rank` 综合排序分。
 *
 * ⚠️ 三条自我约束：
 *   1. **不编造数字**：没有下载量就写 null，不拿 stars 假装下载量。
 *   2. **「评分」是我们算的**，名字里就写清楚（rankScore），别让人误以为是市场评分。
 *   3. **红旗是提示，不是判决**：刷星、新仓库、无许可证只影响展示与排序，是否安装由人决定。
 */
import { fetchJson, githubToken } from "./download.js";

export const PROVIDERS = [
	{ id: "npm-dsh", label: "npm · 插件关键词", kind: "npm" },
	{ id: "npm-any", label: "npm · 全量搜索", kind: "npm" },
	{ id: "gh-repo", label: "GitHub · 仓库搜索", kind: "github" },
	{ id: "gh-deepseek", label: "GitHub · deepseek harness", kind: "github" },
	{ id: "gh-topic", label: "GitHub · topic 发现", kind: "github" },
	{ id: "dsh-hub", label: "dsh-hub.cc · 商店目录（评分 / 安装量 / 收录审核）", kind: "hub" }
];

const PERMISSIVE = new Set(["mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc", "0bsd", "unlicense", "cc0-1.0"]);

function days(iso) {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return null;
	return Math.round((Date.now() - t) / 86400000);
}

/**
 * log10 归一：1e6 次下载 → 100；1e4 星 → 100；1e3 次真安装 → 100。
 * 三种数字量纲不同，**按优先级挑一个**，不混算（混算会让「有安装量」的条目被星数稀释）。
 */
export function normalizePopularity({ downloads, stars, installs } = {}) {
	if (typeof downloads === "number" && downloads > 0) {
		return Math.max(0, Math.min(100, Math.round((Math.log10(downloads) / 6) * 100)));
	}
	if (typeof installs === "number" && installs > 0) {
		return Math.max(0, Math.min(100, Math.round((Math.log10(installs + 1) / 3) * 100)));
	}
	if (typeof stars === "number" && stars > 0) {
		return Math.max(0, Math.min(100, Math.round((Math.log10(stars + 1) / 4) * 100)));
	}
	return null;
}

/**
 * 可信度判定。输入是**已经拿到的**结构化事实（npm 搜索项或 GitHub repo），不做网络请求。
 * @returns {{level:'official'|'source-claimed'|'community'|'unknown', badges:Array, flags:Array, score:number}}
 */
export function judgeTrust(input = {}) {
	const badges = [];
	const flags = [];
	const name = String(input.name || "");
	const owner = String(input.owner || "").toLowerCase();
	const pkgScope = name.startsWith("@") ? name.slice(1, name.indexOf("/")) : "";
	const license = (input.license || "").toString().toLowerCase();
	const createdDays = days(input.createdAt);
	const pushedDays = days(input.updatedAt);
	const stars = typeof input.stars === "number" ? input.stars : null;
	const forks = typeof input.forks === "number" ? input.forks : null;
	const subscribers = typeof input.subscribers === "number" ? input.subscribers : null;
	const archived = input.archived === true;
	const hasRepo = Boolean(input.repoUrl || (input.links && input.links.repository));

	let level = "community";

	/* ① 官方：npm 作用域或 GitHub 组织是 deepseek-ai。这是最强的确定性信号。 */
	if (owner === "deepseek-ai" || pkgScope === "deepseek-ai") {
		level = "official";
		badges.push({ id: "official", label: "官方", tone: "ok", why: "来自 deepseek-ai 作用域/组织" });
	}

	/* ② 许可证：有宽松许可证 → 可按需修改/分发；无 → 红旗。 */
	if (license) {
		const permissive = PERMISSIVE.has(license);
		badges.push({
			id: "license",
			label: (input.license || "").toUpperCase(),
			tone: permissive ? "ok" : "warn",
			why: permissive ? "宽松许可证（可改可分发）" : "非宽松许可证，分发/二次开发前先读条款"
		});
	} else if (input.licenseKnown !== false) {
		flags.push({ id: "no-license", tone: "warn", text: "没有许可证：默认保留所有权利，严格说不能改也不能再分发" });
	}

	/* ③ 源码可见：有仓库才谈得上「能审计」。 */
	if (hasRepo) {
		badges.push({ id: "repo", label: "有源码", tone: "ok", why: "给了仓库地址，可以自己审" });
	} else {
		flags.push({ id: "no-repo", tone: "warn", text: "没有仓库地址：装的这份东西你没法审计" });
	}

	/* ④ 维护活性。 */
	if (pushedDays !== null) {
		if (pushedDays <= 45) badges.push({ id: "active", label: "近期更新", tone: "ok", why: pushedDays + " 天前有推送" });
		else if (pushedDays > 365) flags.push({ id: "stale", tone: "warn", text: "一年多没更新（" + pushedDays + " 天）：可能已不兼容当前宿主" });
	} else if (createdDays !== null && createdDays <= 30) {
		flags.push({ id: "new", tone: "warn", text: "仓库只有 " + createdDays + " 天，还没经过时间检验" });
	}

	/* ⑤ 归档 / 停更。 */
	if (archived) flags.push({ id: "archived", tone: "error", text: "仓库已归档：作者明确表示不再维护" });

	/* ⑥ 刷星信号（本机实测过一条：27k 星 / 17 关注者）。
	      判据故意保守：只在高星且关注者比例极低时提示，避免冤枉真热门项目。 */
	if (stars !== null && stars >= 500) {
		if (subscribers !== null && subscribers > 0 && stars / subscribers > 100) {
			flags.push({
				id: "star-anomaly",
				tone: "error",
				text: "星数与关注者比例异常（★" + stars + " / 关注 " + subscribers + "）：常见于刷星或买量，别把星数当口碑"
			});
		} else if (forks !== null && stars > 0 && forks / stars < 0.01) {
			flags.push({
				id: "fork-anomaly",
				tone: "warn",
				text: "星多但几乎没人 fork（★" + stars + " / fork " + forks + "）：真实使用量的信号偏弱"
			});
		}
	}

	/* ⑥b **年轻但星极多**：搜索接口不返回 subscribers，光靠「星/关注者」抓不到刷量；
	      但「建库不到 4 个月就上万星」是另一条便宜且有效的判据
	      （实测：某仓库 26 天 2.8 万星，搜索接口上看不出任何异常）。 */
	if (createdDays !== null && createdDays <= 120 && stars !== null && stars >= 5000) {
		flags.push({
			id: "young-hype",
			tone: "warn",
			text: "仓库才 " + createdDays + " 天就有 ★" + stars + "：可能是真爆款，也可能是刷量 —— 别把星数当口碑"
		});
	}

	/* 综合分：官方 > 有源码+许可证+活跃 > 只有名字。红旗直接扣分。 */
	let score = 40;	if (level === "official") score = 95;
	else {
		if (hasRepo) score += 15;
		if (license && PERMISSIVE.has(license)) score += 15;
		if (pushedDays !== null && pushedDays <= 90) score += 10;
		if (typeof input.downloads === "number" && input.downloads > 1000) score += 10;
	}
	for (const flag of flags) score -= flag.tone === "error" ? 25 : 10;
	score = Math.max(0, Math.min(100, score));

	return { level, badges, flags, score };
}

/** npm 命中 → 统一形状。 */
export function shapeNpm(item, extra = {}) {
	const name = (item.package && item.package.name) || item.name || "";
	const version = (item.package && item.package.version) || item.version || null;
	const links = (item.package && item.package.links) || item.links || {};
	const updated = (item.package && item.package.date) || item.updated || null;
	const downloads = typeof extra.downloads === "number" ? extra.downloads : null;
	const trust = judgeTrust({
		name,
		license: extra.license || null,
		repoUrl: links.repository || null,
		links,
		updatedAt: updated,
		downloads
	});
	const popularity = {
		downloads,
		stars: null,
		score: normalizePopularity({ downloads })
	};
	return {
		source: "npm",
		name,
		version,
		description: (item.package && item.package.description) || item.description || "",
		spec: name + (version ? "@" + version : ""),
		url: links.npm || links.homepage || null,
		/* R25：把仓库地址带出去 —— 搜索卡要能对账「同名的是不是同一个来源」 */
		repoUrl: links.repository || null,
		updatedAt: updated,
		stars: null,
		downloads,
		trust,
		popularity,
		rankScore: (trust.score * 0.6 + (popularity.score === null ? 30 : popularity.score) * 0.4)
	};
}

/** GitHub repo → 统一形状。 */
export function shapeGithub(r, source = "github") {
	const name = r.full_name || r.name || "";
	const trust = judgeTrust({
		name,
		owner: (r.owner && r.owner.login) || String(name).split("/")[0],
		license: (r.license && (r.license.spdx_id || r.license.key)) || null,
		repoUrl: r.html_url || null,
		createdAt: r.created_at || null,
		updatedAt: r.pushed_at || r.updated_at || null,
		stars: r.stargazers_count,
		forks: r.forks_count,
		subscribers: r.subscribers_count,
		archived: r.archived
	});
	const popularity = { downloads: null, stars: r.stargazers_count || 0, score: normalizePopularity({ stars: r.stargazers_count }) };
	return {
		source,
		name,
		version: null,
		description: r.description || "",
		spec: name,
		url: r.html_url || null,
		repoUrl: r.html_url || null,
		updatedAt: r.pushed_at || null,
		stars: r.stargazers_count || 0,
		downloads: null,
		topics: Array.isArray(r.topics) ? r.topics : [],
		trust,
		popularity,
		rankScore: trust.score * 0.6 + (popularity.score === null ? 30 : popularity.score) * 0.4
	};
}

/**
 * dsh-hub.cc 商店条目 → 统一形状。
 *
 * 这个目录比 npm/GitHub 多给三样**别人没有的东西**，正好对应用户问的「知名度」：
 *   `ratingAverage` / `ratingCount`（用户评分）、`confirmedInstallCount`（真装过几次）、
 *   `installability`（是否被目录审过可装）。它**不**给许可证 —— 所以传 `licenseKnown:false`，
 *   免得把「不知道」渲染成「没有许可证」的红旗。
 */
export function shapeHub(r = {}) {
	const name = r.fullName || (r.owner && r.name ? r.owner + "/" + r.name : r.name) || "";
	const repoUrl = r.repositoryUrl || (name ? "https://github.com/" + name : null);
	const trust = judgeTrust({
		name,
		owner: r.owner,
		repoUrl,
		updatedAt: r.pushedAt || null,
		stars: typeof r.stars === "number" ? r.stars : null,
		forks: typeof r.forks === "number" ? r.forks : null,
		licenseKnown: false
	});
	if (r.installability) {
		trust.badges.push({
			id: "store",
			label: r.installability === "verified" ? "商店收录" : "商店收录（待核）",
			tone: r.installability === "verified" ? "ok" : "warn",
			why: "dsh-hub 目录 installability=" + r.installability
		});
	}
	if (typeof r.ratingAverage === "number" && r.ratingAverage > 0) {
		trust.badges.push({
			id: "rating",
			label: "评分 " + r.ratingAverage.toFixed(1) + "(" + (r.ratingCount || 0) + ")",
			tone: r.ratingAverage >= 4 ? "ok" : "warn",
			why: "dsh-hub 用户评分（样本 " + (r.ratingCount || 0) + " 条，样本少时别当真）"
		});
	}
	if (r.confirmedInstallCount > 0) {
		/* 商店还给了 commentCount / installIntentCount：都是「有人真的动过它」的弱信号，
		   写进 why 里比只给一个数字有用（安装量可能是自己点的，评论就很难刷）。 */
		const extra = [];
		if (typeof r.commentCount === "number" && r.commentCount > 0) extra.push("评论 " + r.commentCount);
		if (typeof r.installIntentCount === "number" && r.installIntentCount > 0) extra.push("点过安装 " + r.installIntentCount);
		trust.badges.push({
			id: "installs",
			label: "装过 " + r.confirmedInstallCount,
			tone: "ok",
			why: "商店统计的「确认安装」次数，比 stars 更接近真实使用量" + (extra.length ? "（" + extra.join("、") + "）" : "")
		});
	}
	/* 商店的分类（界面 / 网络 / 运维…）是人工标注的用途线索，比名字猜用途可靠。 */
	if (r.category && r.category !== "其他") {
		trust.badges.push({ id: "category", label: "分类 · " + r.category, tone: "info", why: "dsh-hub 商店的人工分类" });
	}
	if (r.ratingCount === 0) {
		trust.badges.push({ id: "no-rating", label: "暂无评分", tone: "info", why: "商店里还没有人评分" });
	}
	trust.score = Math.max(0, Math.min(100, trust.score + (r.installability === "verified" ? 10 : 0) + (r.ratingAverage >= 4 ? 5 : 0)));
	const popularity = {
		downloads: null,
		stars: typeof r.stars === "number" ? r.stars : 0,
		installs: typeof r.confirmedInstallCount === "number" ? r.confirmedInstallCount : 0,
		score: normalizePopularity({ installs: r.confirmedInstallCount, stars: r.stars })
	};
	/* 商店收录本身是信号：给它一个下限分 + 小幅加权，否则「0 安装但被收录」的条目会被
	   stars 排序直接挤到看不见（实测：搜「主题」时商店 4 条一条都进不了前 8）。 */
	const popScore = popularity.score === null ? 18 : Math.max(popularity.score, 18);
	return {
		source: "dsh-hub",
		name,
		version: null,
		description: r.description || "",
		spec: r.repositoryUrl || (name ? "github:" + name : name),
		url: repoUrl,
		repoUrl,
		updatedAt: r.pushedAt || null,
		stars: popularity.stars,
		downloads: null,
		installs: popularity.installs,
		rating: typeof r.ratingAverage === "number" ? { average: r.ratingAverage, count: r.ratingCount || 0 } : null,
		category: r.category || null,
		topics: Array.isArray(r.topics) ? r.topics : [],
		trust,
		popularity: { ...popularity, score: popScore },
		rankScore: trust.score * 0.6 + popScore * 0.4 + 6
	};
}

/* ── 具体请求 ───────────────────────────────────────────────────────────── */

async function npmSearch(text, limit) {
	const url = "https://registry.npmjs.org/-/v1/search?text=" + encodeURIComponent(text) + "&size=" + limit;
	const data = await fetchJson(url, { timeoutMs: 12000 });
	return Array.isArray(data.objects) ? data.objects : [];
}

async function ghSearch(q, limit) {
	const url = "https://api.github.com/search/repositories?q=" + encodeURIComponent(q) + "&sort=stars&order=desc&per_page=" + limit;
	const data = await fetchJson(url, { token: githubToken(), timeoutMs: 12000 });
	return Array.isArray(data.items) ? data.items : [];
}

/** dsh-hub.cc 的目录 API（2026-10-20 实测：`/api/v1/plugins?q=&limit=&offset=`，total 1.6 万条）。 */
async function hubSearch(q, limit) {
	const url = "https://dsh-hub.cc/api/v1/plugins?q=" + encodeURIComponent(q) + "&limit=" + limit;
	const data = await fetchJson(url, { timeoutMs: 12000 });
	return Array.isArray(data.items) ? data.items : [];
}

/** npm 下载量（last-week）。失败一律 null —— 宁可没有数字，也不编。 */
async function npmDownloadsUncached(name) {
	try {
		const key = name.replace("/", "%2f").replace("@", "%40");
		const data = await fetchJson("https://api.npmjs.org/downloads/point/last-week/" + key, { timeoutMs: 6000 });
		return typeof data.downloads === "number" ? data.downloads : null;
	} catch {
		return null;
	}
}

/* ── 缓存（R5）─────────────────────────────────────────────────────────────
 * 为什么必须要有：一次搜索固定发 6 个源请求 + 最多 10 个 npm 下载量请求，
 * 而 **GitHub 搜索 API 未认证只有 10 次/分**（一次搜索就用掉 3 次）→ 一分钟内
 * 第 4 次搜索必然 429。面板搜索框与「AI 推荐」都打这条，同一个查询重复搜没有理由重发。
 * 实测本机 DSH_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN 全都没设，所以这条一定会撞上。
 */
const SEARCH_TTL_MS = 5 * 60 * 1000;
const DOWNLOADS_TTL_MS = 30 * 60 * 1000;

/**
 * 极小的 TTL 记忆化。三条语义（别改）：
 *   ① 同一 key 在 TTL 内只跑一次；② 并发同 key 共享同一次调用（in-flight 去重）；
 *   ③ **抛错不缓存** —— 否则一次网络抖动会把失败钉住整个 TTL。
 */
export function memoizeTtl(fn, ttlMs, maxEntries = 32) {
	const store = new Map();
	const run = (key, args) => {
		const pending = (async () => fn(...args))();
		store.set(key, { at: Date.now(), pending });
		return pending.then(
			(value) => {
				store.set(key, { at: Date.now(), value });
				if (store.size > maxEntries) {
					const oldest = store.keys().next().value;
					if (oldest !== key) store.delete(oldest);
				}
				return { value, cached: false };
			},
			(error) => {
				store.delete(key);
				throw error;
			}
		);
	};
	return {
		async get(key, ...args) {
			const hit = store.get(key);
			if (hit && Date.now() - hit.at < ttlMs) {
				const value = hit.pending ? await hit.pending : hit.value;
				return { value, cached: true };
			}
			return run(key, args);
		},
		clear() {
			store.clear();
		},
		size() {
			return store.size;
		}
	};
}

const downloadsCache = memoizeTtl(npmDownloadsUncached, DOWNLOADS_TTL_MS, 64);

async function npmDownloads(name) {
	const { value } = await downloadsCache.get(name, name);
	return value;
}

/** 测试与「强制刷新」用：清掉搜索/下载量缓存。 */
export function clearSourceCaches() {
	searchCache.clear();
	downloadsCache.clear();
}

const searchCache = memoizeTtl(searchAllFresh, SEARCH_TTL_MS, 24);

/**
 * 多源搜索。任何单个源失败都不影响其它源；`providers` 里会写清楚哪个源挂了、为什么。
 * 返回值里的 `cached:true` 表示这次没发网络请求（5 分钟内的同一查询）。
 * @returns {Promise<{items:Array, providers:Array, errors:string[], cached?:boolean}>}
 */
export async function searchAll(query, options = {}) {
	const q = String(query || "").trim();
	if (!q) return { items: [], providers: [], errors: ["空查询"], cached: false };
	const limit = Math.max(3, Math.min(20, options.limit || 12));
	/* R6：设置里可以关掉某些源（省请求 / 避开限流）。至少要留一个 —— 全关会看起来像坏了，
	   settings.js 已经在归一化时兜住，这里再兜一次。 */
	const enabled = { npm: true, github: true, hub: true, ...(options.sources || {}) };
	if (!enabled.npm && !enabled.github && !enabled.hub) {
		return { items: [], providers: [], errors: ["搜索源被全部关闭（面板 设置 → 搜索来源）"], cached: false };
	}
	const flag = (enabled.npm ? "1" : "0") + (enabled.github ? "1" : "0") + (enabled.hub ? "1" : "0");
	const key = q.toLowerCase() + "|" + limit + "|" + flag;
	const { value, cached } = await searchCache.get(key, q, limit, enabled);
	return { ...value, cached };
}

async function searchAllFresh(q, limit, enabled = { npm: true, github: true, hub: true }) {
	const per = Math.max(4, Math.ceil(limit / 2));

	const all = [
		{ id: "npm-dsh", group: "npm", run: () => npmSearch(q + " dsh", per) },
		{ id: "npm-any", group: "npm", run: () => npmSearch(q, per) },
		{ id: "gh-repo", group: "github", run: () => ghSearch(q + " dsh", per) },
		{ id: "gh-deepseek", group: "github", run: () => ghSearch(q + " deepseek harness", Math.max(3, Math.ceil(per / 2))) },
		{ id: "gh-topic", group: "github", run: () => ghSearch("topic:dsh-plugin " + q, Math.max(3, Math.ceil(per / 2))) },
		/* 商店有 1.6 万条、带评分与安装量，取 6 条等于把它的排序当圣旨。
		   多取一倍（上限 20）再让本机 rankScore 重排，能捞到更贴合查询的条目。 */
		{ id: "dsh-hub", group: "hub", run: () => hubSearch(q, Math.min(20, per * 2)) }
	];
	const jobs = all.filter((job) => enabled[job.group] !== false);

	const results = await Promise.all(
		jobs.map(async (job) => {
			try {
				const rows = await job.run();
				return { id: job.id, ok: true, rows };
			} catch (e) {
				return { id: job.id, ok: false, error: String((e && e.message) || e), code: e && e.code, rows: [] };
			}
		})
	);

	/* npm 去重后补下载量（最多 10 个，避免把接口打爆） */
	const npmRows = new Map();
	for (const r of results.filter((x) => x.id.startsWith("npm"))) {
		for (const row of r.rows) {
			const name = row.package && row.package.name;
			if (name && !npmRows.has(name)) npmRows.set(name, row);
		}
	}
	const npmNames = [...npmRows.keys()].slice(0, 10);
	const downloadMap = new Map();
	await Promise.all(
		npmNames.map(async (name) => {
			downloadMap.set(name, await npmDownloads(name));
		})
	);

	const items = [];
	const seen = new Map();
	for (const r of results) {
		if (!r.ok) continue;
		const isNpm = r.id.startsWith("npm");
		const isHub = r.id === "dsh-hub";
		for (const row of r.rows) {
			const shaped = isHub
				? shapeHub(row)
				: isNpm
					? shapeNpm(row, { downloads: downloadMap.get(row.package && row.package.name) ?? null })
					: shapeGithub(row, r.id === "gh-topic" ? "github-topic" : "github");
			if (!shaped.name) continue;
			/* 去重键：npm 用包名，GitHub / 商店用 fullName（不区分大小写）。
			   商店条目与 GitHub 条目会撞上同一个仓库 —— 谁先来谁占位，顺序按 jobs 声明（商店在前？不，在最后）。
			   所以这里优先保留**商店条目**：它多带评分与安装量。 */
			const key = shaped.source === "npm" ? "npm:" + shaped.name.toLowerCase() : "gh:" + shaped.name.toLowerCase();
			const existing = seen.get(key);
			if (existing) {
				if (shaped.source === "dsh-hub" && existing.source !== "dsh-hub") {
					const idx = items.indexOf(existing);
					if (idx >= 0) items[idx] = shaped;
					seen.set(key, shaped);
				}
				continue;
			}
			/* 相关度闸门：description/name 里没有 dsh/deepseek/harness 的泛 JS 包会污染结果。
			   topic 发现与商店目录豁免 —— 前者本身就是「dsh 相关」信号，后者是人工收录的 dsh 目录。 */
			const text = (shaped.name + " " + shaped.description).toLowerCase();
			if (shaped.source !== "github-topic" && shaped.source !== "dsh-hub" && !/dsh|deepseek|harness/.test(text)) continue;
			seen.set(key, shaped);
			items.push(shaped);
		}
	}

	items.sort((a, b) => b.rankScore - a.rankScore || (b.stars || 0) - (a.stars || 0));

	const errors = results.filter((r) => !r.ok).map((r) => r.id + ": " + r.error);
	/* 撞限流时给一句能照做的：本机实测三个 token 环境变量都没设，默认就是未认证配额。 */
	if (results.some((r) => !r.ok && (r.code === "rate-limited" || /HTTP 42[39]/.test(String(r.error || ""))))) {
		errors.push(
			"GitHub 搜索用未认证配额（10 次/分，一次搜索用 3 次）：设 DSH_GITHUB_TOKEN 可提到 30 次/分；" +
			"同一查询 5 分钟内走缓存，不必重搜"
		);
	}

	return {
		items: items.slice(0, limit),
		providers: results.map((r) => ({ id: r.id, ok: r.ok, count: r.rows.length, error: r.ok ? null : r.error })),
		errors
	};
}

/** 人读的一句话：给工具输出与面板共用。 */
export function trustLine(item) {
	const t = (item && item.trust) || {};
	const bits = [];
	if (t.level === "official") bits.push("官方");
	for (const b of t.badges || []) if (b.id !== "official") bits.push(b.label);
	const pop = (item && item.popularity) || {};
	if (typeof pop.downloads === "number") bits.push("周下载 " + pop.downloads);
	else if (typeof item.stars === "number" && item.stars > 0) bits.push("★" + item.stars);
	if (typeof item.rankScore === "number") bits.push("本机评分 " + Math.round(item.rankScore));
	const flags = (t.flags || []).map((f) => f.text);
	return { badges: bits, flags };
}
