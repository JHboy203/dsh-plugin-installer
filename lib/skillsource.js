/**
 * skillsource.js — R40：Skill 的确定性搜索源。
 *
 * 背景（2026-10-31，用户问「AI 搜索是不是只有插件的推荐，没有 skill 以及 mcp 的推荐」）：
 * 实测两件事 ——
 *   ① **MCP 有源但看不见**：`search()` 确实并了官方 MCP Registry（R36），但 `runPanelAi` 把候选
 *      `JSON.stringify(...).slice(0, 9000)`，16 个候选共 13,386 字 → 后面 4 个 MCP 候选**整类被切掉**，
 *      模型从头到尾没看见它们（所以在面板上永远只推荐插件）。
 *   ② **Skill 根本没有源**：`lib/sources.js` 六个源全是插件（npm / GitHub repo / 商店），
 *      `runPanelAi` 也只把候选分成 plugin / mcp 两类。技能连候选都进不来。
 *
 * 这一份补的是 ②：Skill 不是 registry 包，没有「包名 + 版本」可搜；但它有更硬的坐标 ——
 * **仓库里的一个目录 + SKILL.md**。所以「搜 Skill」= 在已知的技能仓库里列出每个子目录的 SKILL.md，
 * 读 frontmatter，按查询词打分，产出可直接提交的 **tree URL**（面板现有的安装入口就认它）。
 *
 * 三条自我约束：
 *   1. **不编造**：读不到 SKILL.md / frontmatter 不合法就标 installable=false 并写明理由，
 *      不猜它是好技能。
 *   2. **不烧 GitHub API 配额**：清单与正文都走 jsDelivr（`data.jsdelivr.com` / `cdn.jsdelivr.net`）。
 *      未认证的 api.github.com 只有 60 次/小时，安装流水线要用它。
 *   3. **失败要说出来**：技能库读不到时 provider 记 ok=false + error，面板如实显示「没查到」，
 *      而不是安静地少一类结果。
 *
 * ⚠️ 为什么不用 raw.githubusercontent.com、也不是随便挑一个 jsDelivr 域名：
 * 2026-10-31 在**宿主进程**里实测 —— raw 直接 fetch failed；`cdn.jsdelivr.net` 与
 * `fastly.jsdelivr.net` 在没命中边缘缓存时会 **302 到 raw**，于是同样失败；
 * 只有 `gcore.jsdelivr.net` 直接 200 吐正文。所以镜像链是 gcore → cdn（见 SKILL_TEXT_MIRRORS）。
 * 这条不是域名写错，是这台机器的实际情况；换网络环境时按同一套方法重测一遍即可。
 */
import { parseSkillFrontmatter } from "./detect.js";

/** 已接入的技能仓库。以后要加仓库就往这里加一条（id 唯一、ref 默认 main）。 */
export const SKILL_SOURCES = [
	{
		id: "anthropics-skills",
		owner: "anthropics",
		repo: "skills",
		ref: "main",
		label: "GitHub · 官方技能库 anthropics/skills",
		/* 候选卡上那个 tag 用短名（完整 label 留给 provider 行） */
		shortLabel: "GitHub · 官方技能库"
	}
];

const CACHE_MS = 10 * 60 * 1000;
const CACHE_ERROR_MS = 2 * 60 * 1000;
const cache = new Map();

/**
 * 中文口语 → 英文关键词。
 *
 * 为什么需要：官方技能库的 name / description 是英文（pdf / docx / canvas-design…），
 * 用户输入常是中文（「做个 PPT」「表格」）。这只是**查询扩展**，不是翻译服务 ——
 * 命中的候选照样由模型从候选里挑，不改变「不许编造」的纪律。
 */
const ZH_ALIASES = [
	{ words: ["文档", "公文", "报告", "写作"], terms: ["doc", "document", "docx", "report", "writing"] },
	{ words: ["表格", "电子表格", "报表", "excel"], terms: ["spreadsheet", "xlsx", "excel", "sheet"] },
	{ words: ["幻灯", "演示", "ppt", "汇报"], terms: ["slide", "pptx", "presentation", "deck"] },
	{ words: ["pdf"], terms: ["pdf"] },
	{ words: ["前端", "界面", "网页"], terms: ["frontend", "design", "ui", "web"] },
	{ words: ["设计", "配色", "品牌", "视觉"], terms: ["design", "brand", "identity", "color", "art"] },
	{ words: ["画", "图", "海报", "插画"], terms: ["canvas", "art", "design", "image", "chart"] },
	{ words: ["邮件", "沟通", "通报", "公告"], terms: ["comms", "communication", "email", "internal"] },
	{ words: ["协作", "起草", "润色", "改稿"], terms: ["co-author", "doc", "writing"] },
	{ words: ["mcp", "服务器"], terms: ["mcp"] },
	{ words: ["技能", "skill"], terms: ["skill"] }
];

function tokensOf(query) {
	const q = String(query || "").toLowerCase().trim();
	const tokens = new Set();
	for (const part of q.split(/[\s,，、/;；]+/)) {
		const token = part.trim();
		if (token.length >= 2) tokens.add(token);
	}
	for (const alias of ZH_ALIASES) {
		if (alias.words.some((word) => q.includes(word))) {
			for (const term of alias.terms) tokens.add(term);
		}
	}
	return [...tokens];
}

/**
 * 查询与一个技能的相关度（纯函数，0 = 不相关）。
 * 名称命中比描述命中重得多 —— 否则「design」会把一半技能都拉进来。
 */
export function scoreSkill(query, skill) {
	const items = skill && typeof skill === "object" ? skill : {};
	const name = String(items.name || "").toLowerCase();
	const dir = String(items.subdir || "").split("/").filter(Boolean).pop()?.toLowerCase() || "";
	const description = String(items.description || "").toLowerCase();
	const tokens = tokensOf(query);
	if (tokens.length === 0) return 0;
	let score = 0;
	for (const token of tokens) {
		if (name === token || dir === token) score += 60;
		else if (name.includes(token) || dir.includes(token)) score += 30;
		if (description.includes(token)) score += 12;
	}
	/* 中文原文直接命中（技能描述偶尔有中文）也算分 */
	const raw = String(query || "").trim().toLowerCase();
	if (raw.length >= 2 && (name.includes(raw) || description.includes(raw))) score += 20;
	return score;
}

/**
 * 一条技能记录 → 面板/Skill 搜索候选（纯函数）。
 *
 * `treeUrl` 是**关键字段**：面板现有的安装入口认 GitHub tree 链接，提交它就等于
 * 「装这个仓库的这个子目录」—— 不需要新增 `/submit` 参数，也不会误装同仓库的别的技能。
 */
export function buildSkillCandidate({ owner, repo, ref, subdir, text, sourceLabel } = {}) {
	const path = String(subdir || "").replace(/^\/+|\/+$/g, "");
	const dirName = path.split("/").filter(Boolean).pop() || "";
	const meta = parseSkillFrontmatter(String(text || ""));
	const name = meta.name || dirName;
	const refValue = ref || "main";
	const treeUrl = owner && repo && path
		? "https://github.com/" + owner + "/" + repo + "/tree/" + refValue + "/" + path
		: null;
	return {
		kind: "skill",
		name,
		displayName: meta.name || name,
		description: meta.description || "",
		source: sourceLabel || "GitHub · 技能库",
		/* 技能没有版本号：把「仓库 + 目录 + 分支」当坐标 */
		version: null,
		owner: owner || null,
		repo: repo || null,
		ref: refValue,
		subdir: path,
		spec: owner && repo ? "github:" + owner + "/" + repo : null,
		treeUrl,
		/* 装它的方式与插件不同：目录 + SKILL.md，落位到技能根 */
		installMethod: "skill-dir",
		installable: meta.valid === true,
		blockedReason: meta.valid ? null : "SKILL.md 不合法：" + ((meta.reasons || []).join("；") || "未知原因"),
		stars: null,
		downloads: null,
		score: 0
	};
}

async function fetchWithTimeout(url, { accept = "text/plain,*/*", timeoutMs = 8000 } = {}) {
	const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
		? AbortSignal.timeout(timeoutMs)
		: undefined;
	const res = await fetch(url, { headers: { "user-agent": "dsh-plugin-installer", accept }, ...(signal ? { signal } : {}) });
	if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
	return res;
}

/**
 * 限并发执行。
 *
 * 为什么必须限：2026-10-31 真机实测 —— 16 个 SKILL.md 一次性并发，**宿主进程里只成功 7 个**
 * （其余 9 个卡到 15s 超时；同一段代码在裸 node 里 15/16 成功）。这不像是 jsDelivr 的限制，
 * 更像宿主网络栈对同一域名的并发连接更紧。限到 4 并发 + 单次 8s + 重试一次之后就稳定了。
 */
async function mapLimit(items, limit, fn) {
	const list = Array.isArray(items) ? items : [];
	const results = new Array(list.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length || 1)) }, async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= list.length) return;
			results[index] = await fn(list[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function withRetry(fn, attempts = 2, delayMs = 400) {
	let lastError = null;
	for (let i = 0; i < attempts; i += 1) {
		try {
			return await fn();
		} catch (e) {
			lastError = e;
			if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
		}
	}
	throw lastError;
}

async function defaultListing(source) {
	const url = "https://data.jsdelivr.com/v1/packages/gh/" + source.owner + "/" + source.repo + "@" + (source.ref || "main") + "?structure=flat";
	const res = await fetchWithTimeout(url, { accept: "application/json" });
	const data = await res.json();
	return (Array.isArray(data && data.files) ? data.files : [])
		.map((file) => (typeof file === "string" ? file : String((file && file.name) || "")))
		.filter(Boolean);
}

/**
 * SKILL.md 的镜像链（按顺序试）。
 *
 * 2026-10-31 本机实测（在 **宿主进程** 里，不是沙箱）：
 *   · `raw.githubusercontent.com` → fetch failed（连不通）；
 *   · `cdn.jsdelivr.net` / `fastly.jsdelivr.net` → **302 到 raw**（未命中边缘缓存时），于是也跟着失败；
 *   · `gcore.jsdelivr.net` → 200，直接吐正文（命中的是 Content-Delivery 边缘，不跳 raw）。
 * 所以顺序固定为 gcore → cdn（后者在命中缓存时也能用，命中不了就等它失败，有超时兜底）。
 */
const SKILL_TEXT_MIRRORS = [
	(source, subdir) => "https://gcore.jsdelivr.net/gh/" + source.owner + "/" + source.repo + "@" + (source.ref || "main") + "/" + subdir + "/SKILL.md",
	(source, subdir) => "https://cdn.jsdelivr.net/gh/" + source.owner + "/" + source.repo + "@" + (source.ref || "main") + "/" + subdir + "/SKILL.md"
];

async function defaultSkillText(source, subdir) {
	let lastError = null;
	for (const toUrl of SKILL_TEXT_MIRRORS) {
		try {
			const res = await fetchWithTimeout(toUrl(source, subdir), { timeoutMs: 6000 });
			const text = await res.text();
			if (text) return text;
			lastError = new Error("空响应：" + toUrl(source, subdir));
		} catch (e) {
			lastError = e;
		}
	}
	throw lastError || new Error("SKILL.md 取不到：" + subdir);
}

/**
 * 读一个技能仓库的「技能清单」（带缓存；失败也缓存，但只缓存 2 分钟，避免每次点都等 30 秒）。
 * 可注入 `fetchListing` / `fetchSkillText` —— hosttest 用假源，不联网。
 */
export async function loadSkillLibrary(source, options = {}) {
	const now = Date.now();
	const hit = cache.get(source.id);
	/* 失败 / 只读回一部分时只缓存 2 分钟 —— 别让一次网络抖动把「少了一半技能」钉住 10 分钟 */
	const ttl = hit && (hit.error || hit.partial) ? CACHE_ERROR_MS : (options.cacheMs || CACHE_MS);
	if (!options.fresh && hit && now - hit.at < ttl) return hit;
	const fetchListing = typeof options.fetchListing === "function" ? options.fetchListing : defaultListing;
	const fetchSkillText = typeof options.fetchSkillText === "function" ? options.fetchSkillText : defaultSkillText;
	const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 4;
	const attempts = Number(options.attempts) > 0 ? Number(options.attempts) : 2;
	try {
		const files = await fetchListing(source);
		const paths = files
			.filter((file) => /^\/skills\/[^/]+\/SKILL\.md$/.test(file))
			.slice(0, Number(options.maxSkills) > 0 ? Number(options.maxSkills) : 40);
		const results = await mapLimit(paths, concurrency, async (file) => {
			const subdir = file.replace(/^\/+/, "").replace(/\/SKILL\.md$/, "");
			try {
				const text = await withRetry(() => fetchSkillText(source, subdir), attempts);
				return {
					ok: true,
					skill: buildSkillCandidate({ owner: source.owner, repo: source.repo, ref: source.ref, subdir, text, sourceLabel: source.shortLabel || source.label })
				};
			} catch (e) {
				return { ok: false, subdir, error: String((e && e.message) || e) };
			}
		});
		const skills = results.filter((item) => item && item.ok).map((item) => item.skill);
		const failed = results.filter((item) => item && !item.ok).map((item) => ({ subdir: item.subdir, error: item.error }));
		const value = { at: now, skills, failed, partial: failed.length > 0, error: null };
		cache.set(source.id, value);
		return value;
	} catch (e) {
		const value = { at: now, skills: [], failed: [], partial: false, error: String((e && e.message) || e) };
		cache.set(source.id, value);
		return value;
	}
}

/** 清缓存（自检 / 探针用）。 */
export function clearSkillSourceCache() {
	cache.clear();
}

/**
 * 搜技能。返回 `{items, providers, count, error}`；providers 的 `ok/error` 会原样进搜索结果，
 * 面板据此说「技能库没读到」而不是假装「没有技能」。
 */
export async function searchSkills(query, options = {}) {
	const q = String(query || "").trim();
	const limit = Math.max(1, Math.min(20, Number(options.limit) || 6));
	const sources = Array.isArray(options.sources) && options.sources.length > 0 ? options.sources : SKILL_SOURCES;
	const providers = [];
	const matched = [];
	for (const source of sources) {
		const library = await loadSkillLibrary(source, options);
		providers.push({
			id: source.id,
			label: source.label,
			kind: "skill",
			ok: !library.error,
			error: library.error || null,
			count: library.skills.length,
			/* 部分失败要说出来（面板/自检能看到「16 个里读到 15 个」），但不算整类失败 */
			failed: Array.isArray(library.failed) ? library.failed.length : 0,
			partial: Boolean(library.partial)
		});
		if (library.error) continue;
		for (const skill of library.skills) {
			const score = scoreSkill(q, skill);
			/* 空查询 = 列出全部；有关键词时只要相关的（不能把无关技能塞给模型） */
			if (q && score <= 0) continue;
			matched.push({ ...skill, score });
		}
	}
	matched.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
	return {
		items: matched.slice(0, limit),
		providers,
		count: matched.length,
		error: providers.length > 0 && providers.every((provider) => !provider.ok)
			? (providers[0] && providers[0].error) || "技能库读取失败"
			: null
	};
}
