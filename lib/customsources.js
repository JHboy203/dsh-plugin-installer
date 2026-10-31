/**
 * customsources.js — 「用户自己加的搜索来源」（R45）。
 *
 * 为什么要有它（用户原话）：
 *   「需要可以自己添加搜索来源……新人不懂得怎么添加正确的网址，需要『AI 辅助添加』按钮，
 *    结果交由用户确认；可以预设几个可添加的选项，并贴上说明：不保证插件代码/来源的安全、
 *    可信度与功能之类的，只是提供可选渠道，需要用户自行甄别。」
 *
 * 四种类型（由窄到宽，宽的都是「用户自己承担」）：
 *   · npm     —— 一个 npm 兼容 registry 的**基地址**（npmmirror / 私有 verdaccio 等）。
 *   · github  —— 一条 GitHub 仓库搜索表达式（`topic:dsh-plugin` / `org:deepseek-ai` / `repo:o/r`）。
 *   · json    —— 一个返回候选列表的 JSON 地址（数组，或 `{items:[...]}`；字段见 shapeJsonCandidate）。
 *   · web     —— 任意网页地址：抓正文交给模型提取候选。**默认关闭**（allowWebSources=false），
 *                因为它最慢、最容易变、每次搜索都可能花 token。
 *
 * 三条硬边界（别松）：
 *   1. 只 fetch http(s)、且拒绝本机/内网地址（自定义来源不该变成 SSRF 入口）。
 *   2. **不因为来源写了什么就信什么**：自定义来源的命中一律带「自定义来源 · 未验证」警告，
 *      可信度徽章只来自确定性数据（npm 包元数据 / GitHub 仓库元数据），不来自描述文本。
 *   3. 面板**不背书**：免责声明写在设置里，搜索结果卡上也标一条。
 */
import { fetchJson } from "./download.js";
import { ghSearch, judgeTrust, shapeGithub, shapeNpm } from "./sources.js";

export const CUSTOM_SOURCE_TYPES = ["npm", "github", "json", "web"];
export const CUSTOM_SOURCE_TYPE_LABELS = {
	npm: "npm registry",
	github: "GitHub 查询",
	json: "JSON 索引",
	web: "网页（AI 解析）"
};
export const CUSTOM_SOURCES_MAX = 8;
export const CUSTOM_SOURCE_TARGET_MAX = 500;
export const CUSTOM_SOURCE_LABEL_MAX = 40;
/** 网页解析的抓取上限与缓存（防止一次搜索把页面和 token 都吃光）。 */
export const WEB_FETCH_MAX_BYTES = 300 * 1024;
export const WEB_PAGE_TEXT_MAX = 8000;
export const WEB_TTL_MS = 30 * 60 * 1000;

export const CUSTOM_SOURCE_DISCLAIMER =
	"自定义来源只是「多一个可选渠道」：面板不保证其中的插件代码、来源、可信度或功能，也不会为它背书；" +
	"装不装、用不用请自行甄别。安装前的静态扫描与预检照常执行，但它们只能发现问题特征，不能证明安全。";

/* ── URL 安全 ─────────────────────────────────────────────────────────── */

const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\./,
	/^0\.0\.0\.0$/,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
	/^\[?::1\]?$/,
	/^\[?fc00:/i,
	/^\[?fe80:/i,
	/\.local$/i,
	/\.internal$/i
];

/**
 * 自定义来源只允许公网 http(s)。返回 null 表示可以抓，否则返回一句人话原因。
 * 注意：这**不是**泛化的 SSRF 防护（DNS 重绑定挡不住），但足以挡住「手滑填了 127.0.0.1」。
 */
export function checkSourceUrl(raw) {
	let url;
	try {
		url = new URL(String(raw || "").trim());
	} catch {
		return "不是合法网址（要 http:// 或 https:// 开头）";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "只支持 http / https";
	if (url.username || url.password) return "网址里不要带用户名密码";
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!host) return "网址缺少主机名";
	if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) return "不允许本机 / 内网地址（" + host + "）";
	return null;
}

/** 规范化 registry 基地址：去掉末尾斜杠；路径保留（私有 registry 常带前缀）。 */
export function normalizeRegistryBase(raw) {
	const text = String(raw || "").trim();
	if (!text) return null;
	const bad = checkSourceUrl(text);
	if (bad) return null;
	return text.replace(/\/+$/, "");
}

/**
 * GitHub 查询：把「网址形态」折成 GitHub 搜索表达式；已经是 `topic:` / `org:` / `repo:` 就原样。
 * 认得的网址：
 *   https://github.com/topics/<topic>      → topic:<topic>
 *   https://github.com/orgs/<org>          → org:<org>
 *   https://github.com/<owner>             → org:<owner>（用户主页也按 org 搜，宁可多不可少）
 *   https://github.com/<owner>/<repo>      → repo:<owner>/<repo>
 *   https://github.com/search?q=<q>        → <q>
 */
export function githubQueryFromTarget(raw) {
	const text = String(raw || "").trim();
	if (!text) return null;
	if (/^(topic|org|repo|user|language):\S+/i.test(text)) return text;
	let url = null;
	try {
		url = new URL(text);
	} catch {
		return text; // 不是网址：当成搜索词
	}
	const host = url.hostname.replace(/^www\./i, "").toLowerCase();
	if (host !== "github.com") return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] === "topics" && parts[1]) return "topic:" + decodeURIComponent(parts[1]);
	if (parts[0] === "orgs" && parts[1]) return "org:" + decodeURIComponent(parts[1]);
	if (parts[0] === "search") return url.searchParams.get("q") || null;
	if (parts.length === 1) return "org:" + decodeURIComponent(parts[0]);
	if (parts.length >= 2) return "repo:" + decodeURIComponent(parts[0]) + "/" + decodeURIComponent(parts[1]);
	return null;
}

/* ── 设置里的来源条目：校验 / 归一化 / 去重 ─────────────────────────────── */

let sourceSeq = 0;
function nextSourceId() {
	sourceSeq = (sourceSeq + 1) % 100000;
	return "src" + Date.now().toString(36) + sourceSeq.toString(36);
}

/**
 * 把任意输入整理成一条合法来源；不合法返回 null（调用方负责丢掉）。
 * 不在这里 fetch 校验 —— 保存来源不该因为对方暂时 502 就失败。
 */
export function normalizeCustomSource(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const type = String(raw.type || "").trim().toLowerCase();
	if (!CUSTOM_SOURCE_TYPES.includes(type)) return null;
	let target = String(raw.target || "").trim().slice(0, CUSTOM_SOURCE_TARGET_MAX);
	if (!target) return null;
	if (type === "npm") {
		const base = normalizeRegistryBase(target);
		if (!base) return null;
		target = base;
	} else if (type === "github") {
		const query = githubQueryFromTarget(target);
		if (!query) return null;
		target = query.slice(0, CUSTOM_SOURCE_TARGET_MAX);
	} else {
		if (checkSourceUrl(target)) return null;
	}
	const label = String(raw.label || "").trim().slice(0, CUSTOM_SOURCE_LABEL_MAX) || target.slice(0, CUSTOM_SOURCE_LABEL_MAX);
	const note = String(raw.note || "").trim().slice(0, 200);
	return {
		id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 60) : nextSourceId(),
		label,
		type,
		target,
		note,
		enabled: raw.enabled !== false
	};
}

/** 数组归一化：丢坏的、按 type+target 去重（后写的覆盖先写的）、最多 CUSTOM_SOURCES_MAX 条。 */
export function normalizeCustomSources(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	const seen = new Map();
	for (const item of raw) {
		const norm = normalizeCustomSource(item);
		if (!norm) continue;
		const key = norm.type + "|" + norm.target.toLowerCase();
		if (seen.has(key)) {
			const idx = seen.get(key);
			out[idx] = { ...out[idx], ...norm, id: out[idx].id };
			continue;
		}
		if (out.length >= CUSTOM_SOURCES_MAX) continue;
		seen.set(key, out.length);
		out.push(norm);
	}
	return out;
}

/** 面板与日志用的一行说明。 */
export function describeCustomSource(source) {
	if (!source) return "";
	return (source.label || source.target) + " · " + (CUSTOM_SOURCE_TYPE_LABELS[source.type] || source.type) +
		(source.enabled === false ? "（停用）" : "");
}

/* ── JSON 索引 → 统一候选形状 ──────────────────────────────────────────── */

export function shapeJsonCandidate(item, source) {
	if (!item || typeof item !== "object") return null;
	const name = String(item.name || item.package || item.title || "").trim();
	if (!name) return null;
	const url = typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : null;
	const repoUrl = typeof item.repoUrl === "string" && /^https?:\/\//i.test(item.repoUrl) ? item.repoUrl : null;
	const spec = String(item.spec || item.install || (url && /github\.com/i.test(url) ? url : name)).trim();
	const trust = judgeTrust({
		name,
		owner: item.owner,
		license: item.license || null,
		repoUrl: repoUrl || (url && /github\.com/i.test(url) ? url : null),
		updatedAt: item.updatedAt || null,
		stars: typeof item.stars === "number" ? item.stars : null
	});
	trust.badges = [{ id: "custom-source", label: "自定义来源", tone: "info", why: CUSTOM_SOURCE_DISCLAIMER }, ...(trust.badges || [])];
	trust.flags = [
		...(trust.flags || []),
		{ id: "custom-unverified", tone: "warn", text: "来自自定义来源（" + (source.label || "未命名") + "）—— 面板未验证其安全性与可用性" }
	];
	const popularity = { downloads: typeof item.downloads === "number" ? item.downloads : null, stars: item.stars || null, score: null };
	return {
		source: "custom-" + source.type,
		customSource: { id: source.id, label: source.label, type: source.type },
		name,
		version: item.version || null,
		description: String(item.description || "").slice(0, 400),
		spec,
		url: url || repoUrl || null,
		repoUrl: repoUrl || (url && /github\.com/i.test(url) ? url : null),
		updatedAt: item.updatedAt || null,
		stars: typeof item.stars === "number" ? item.stars : null,
		downloads: popularity.downloads,
		trust,
		popularity,
		rankScore: Math.max(10, trust.score * 0.5 + 10)
	};
}

/** 查询词匹配（JSON 索引通常是「整份清单」，得在本地按关键词筛）。 */
export function matchesQuery(item, query) {
	const q = String(query || "").trim().toLowerCase();
	if (!q) return true;
	const text = (String(item.name || "") + " " + String(item.description || "") + " " +
		String(item.spec || "") + " " + String(item.url || "")).toLowerCase();
	return q.split(/\s+/).filter(Boolean).every((token) => text.includes(token));
}

/* ── 抓取工具（可注入，便于离线自检） ──────────────────────────────────── */

async function realFetchText(url, { maxBytes = WEB_FETCH_MAX_BYTES, timeoutMs = 12000 } = {}) {
	const res = await fetch(url, {
		redirect: "follow",
		headers: { "user-agent": "dsh-plugin-installer/自定义来源 (+local)" },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) throw new Error("HTTP " + res.status);
	const buf = await res.arrayBuffer();
	const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
	return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

/** 极简 HTML → 正文：去掉 script/style/标签/常见实体。不引依赖，够用就行。 */
export function htmlToText(html) {
	return String(html || "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, WEB_PAGE_TEXT_MAX);
}

/* ── 搜索 ─────────────────────────────────────────────────────────────── */

/**
 * 跑一批自定义来源。任何一条失败只标记它自己，不影响别的来源与内置源。
 *
 * @param {string} query
 * @param {Array} sources 已归一化的条目
 * @param {object} options
 *   · limit       每个来源最多取几条（默认 6）
 *   · allowWeb    是否允许 web 类型（默认 false）
 *   · fetchJson   可注入（测试）
 *   · fetchText   可注入（测试 / web）
 *   · parseWeb    async (source, query, pageText) => [{name,url,description}]；没有就跳过 web
 * @returns {Promise<{items:Array, providers:Array, errors:string[]}>}
 */
export async function searchCustomSources(query, sources, options = {}) {
	const list = Array.isArray(sources) ? sources : [];
	const limit = Math.max(1, Math.min(20, options.limit || 6));
	const allowWeb = options.allowWeb === true;
	const fetchJsonImpl = options.fetchJson || fetchJson;
	const fetchTextImpl = options.fetchText || realFetchText;
	const items = [];
	const providers = [];
	const errors = [];
	if (list.length === 0) return { items, providers, errors };

	for (const source of list) {
		const provider = {
			id: "custom-" + source.id,
			label: source.label + "（自定义 · " + (CUSTOM_SOURCE_TYPE_LABELS[source.type] || source.type) + "）",
			kind: "custom",
			customType: source.type,
			ok: true,
			count: 0,
			error: null
		};
		if (source.enabled === false) {
			provider.ok = false;
			provider.error = "已停用";
			providers.push(provider);
			continue;
		}
		/* 网页来源默认关闭：这是**配置状态**，不是失败 —— 只标在那个 provider 上，不写进 errors
		   （否则每次搜索都会多一条「错误」，看起来像坏了）。 */
		if (source.type === "web" && !allowWeb) {
			provider.ok = false;
			provider.error = "网页来源默认关闭（设置里打开「允许 AI 解析任意网页」后才生效）";
			providers.push(provider);
			continue;
		}
		const push = (rows) => {
			for (const row of rows) {
				if (!row.name) continue;
				items.push(row);
				provider.count += 1;
			}
		};
		try {
			if (source.type === "npm") {
				const base = normalizeRegistryBase(source.target);
				if (!base) throw new Error("registry 地址不合法");
				const url = base + "/-/v1/search?text=" + encodeURIComponent(query) + "&size=" + limit;
				const data = await fetchJsonImpl(url, { timeoutMs: 12000 });
				const rows = (Array.isArray(data.objects) ? data.objects : []).map((it) => shapeNpm(it)).filter((it) => it.name);
				push(rows.map((it) => withCustomMark(it, source)));
			} else if (source.type === "github") {
				const expression = String(source.target || "").trim();
				if (!expression) throw new Error("GitHub 查询为空");
				const q = query ? expression + " " + query : expression;
				const rows = await ghSearch(q, limit);
				push(rows.map((it) => withCustomMark(shapeGithub(it, "custom-github"), source)));
			} else if (source.type === "json") {
				const bad = checkSourceUrl(source.target);
				if (bad) throw new Error(bad);
				const data = await fetchJsonImpl(source.target, { timeoutMs: 12000 });
				const rows = Array.isArray(data) ? data : Array.isArray(data && data.items) ? data.items : null;
				if (!rows) throw new Error("JSON 索引要是数组，或 { items: [ ... ] }");
				const shaped = rows.map((it) => shapeJsonCandidate(it, source)).filter(Boolean);
				push(shaped.filter((it) => matchesQuery(it, query)).slice(0, limit));
			} else if (source.type === "web") {
				if (typeof options.parseWeb !== "function") throw new Error("当前没有可用的网页解析器");
				const bad = checkSourceUrl(source.target);
				if (bad) throw new Error(bad);
				const html = await fetchTextImpl(source.target, { maxBytes: WEB_FETCH_MAX_BYTES });
				const text = htmlToText(html);
				const rows = await options.parseWeb(source, query, text);
				const shaped = (Array.isArray(rows) ? rows : []).map((it) => shapeJsonCandidate(it, source)).filter(Boolean);
				push(shaped.slice(0, limit));
			} else {
				throw new Error("未知来源类型：" + source.type);
			}
		} catch (e) {
			provider.ok = false;
			provider.error = String((e && e.message) || e);
			errors.push(provider.label + "：" + provider.error);
		}
		providers.push(provider);
	}
	return { items, providers, errors };
}

/** 给内置形状（npm/GitHub）打上「自定义来源」的水印：徽章 + 警告，不改可信度本身。 */
function withCustomMark(item, source) {
	const trust = item.trust || { level: "unknown", badges: [], flags: [], score: 30 };
	return {
		...item,
		customSource: { id: source.id, label: source.label, type: source.type },
		trust: {
			...trust,
			badges: [{ id: "custom-source", label: "自定义来源", tone: "info", why: CUSTOM_SOURCE_DISCLAIMER }, ...(trust.badges || [])],
			flags: [
				...(trust.flags || []),
				{ id: "custom-unverified", tone: "warn", text: "来自自定义来源（" + source.label + "）—— 面板未验证其安全性与可用性" }
			]
		}
	};
}
