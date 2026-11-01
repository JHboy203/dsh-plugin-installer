/**
 * models.js — 面板「自选模型」用的模型目录（R48）。
 *
 * 宿主只给了两件事：`ctx.llm.listProviders()`（谁注册了适配器）与
 * `ctx.llm.listModels(provider)`（那个适配器能说出哪些模型）。面板要的是
 * 「让我挑一个」，于是这里把它们拼成一张可渲染的表。三条边界必须如实回话：
 *
 *   1. **没有 llm 服务**（旧宿主 / 被裁过的 profile）→ `ok:false` + 原因，
 *      不是「没有模型」；
 *   2. **某个 provider 抛错或超时** → 只标它自己 `ok:false`，其它照常列；
 *      一个死掉的中继不该让整张表变成空的；
 *   3. **一个都没列出来** → 仍然是 `ok:true`，`count:0` + 每个 provider 的原因；
 *      说实话「问不出来」，而不是编一个看起来对的默认值。
 *
 * 只读：不注册适配器、不写配置、不花 token。`listModels` 可能走网络，
 * 所以每个 provider 都有硬超时，并由调用方（`/models` 路由）做 5 分钟缓存。
 */

/** 单个 provider 的模型发现上限与超时（防止某个适配器把面板拖住）。 */
export const MODELS_DISCOVERY_TIMEOUT_MS = 5000;
export const MODELS_MAX_PROVIDERS = 20;
export const MODELS_MAX_PER_PROVIDER = 200;

function withTimeout(promise, ms, label) {
	let timer = null;
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(label + " 超时（" + ms + "ms）")), ms);
		})
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function textOf(value, max) {
	const text = value === undefined || value === null ? "" : String(value);
	return text.trim().slice(0, max);
}

function shapeModel(providerId, providerName, raw) {
	const id = textOf(raw && (raw.id || raw.model), 160);
	if (!id) return null;
	return {
		provider: providerId,
		providerName,
		id,
		name: textOf(raw && raw.name, 160) || id,
		description: raw && raw.description ? textOf(raw.description, 200) : null
	};
}

/**
 * 读一次模型目录。
 * @returns {Promise<{ok:boolean, at:string, error:string|null, providers:Array, models:Array, count:number}>}
 */
export async function listLlmModels(ctx, options = {}) {
	const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : MODELS_DISCOVERY_TIMEOUT_MS;
	const maxProviders = Number(options.maxProviders) > 0 ? Number(options.maxProviders) : MODELS_MAX_PROVIDERS;
	const maxPerProvider = Number(options.maxPerProvider) > 0 ? Number(options.maxPerProvider) : MODELS_MAX_PER_PROVIDER;
	const at = new Date().toISOString();
	const llm = ctx && ctx.llm;
	if (!llm || typeof llm.stream !== "function") {
		return { ok: false, at, error: "宿主没有 llm 服务（或这个版本没启用）", providers: [], models: [], count: 0 };
	}
	if (typeof llm.listModels !== "function") {
		return { ok: false, at, error: "宿主这个版本不提供模型目录（llm.listModels 不存在）", providers: [], models: [], count: 0 };
	}
	let declared = [];
	try {
		declared = typeof llm.listProviders === "function" ? llm.listProviders() : [];
	} catch (e) {
		return { ok: false, at, error: "读 provider 列表失败：" + textOf((e && e.message) || e, 300), providers: [], models: [], count: 0 };
	}
	const source = (Array.isArray(declared) ? declared : [])
		.map((item) => {
			const id = textOf(item && (item.id || item.provider), 120);
			if (!id) return null;
			return { id, name: textOf(item && item.name, 120) || id };
		})
		.filter(Boolean)
		.slice(0, maxProviders);

	const providers = await Promise.all(source.map(async (provider) => {
		try {
			const listed = await withTimeout(llm.listModels(provider.id), timeoutMs, provider.id);
			const models = (Array.isArray(listed) ? listed : [])
				.slice(0, maxPerProvider)
				.map((raw) => shapeModel(provider.id, provider.name, raw))
				.filter(Boolean);
			return { id: provider.id, name: provider.name, ok: true, error: null, models };
		} catch (e) {
			/* 一个 provider 失败只标它自己：别的适配器照常能选 */
			return { id: provider.id, name: provider.name, ok: false, error: textOf((e && e.message) || e, 300) || "列模型失败", models: [] };
		}
	}));

	const models = providers.flatMap((provider) => provider.models);
	return { ok: true, at, error: null, providers, models, count: models.length };
}

/**
 * 一行摘要（工具输出 / 自检用）。
 */
export function describeModelCatalog(catalog) {
	const rows = catalog && Array.isArray(catalog.providers) ? catalog.providers : [];
	if (!catalog || catalog.ok === false) return "模型目录读不到：" + ((catalog && catalog.error) || "未知原因");
	const bad = rows.filter((p) => !p.ok);
	const okCount = rows.filter((p) => p.ok).length;
	return "模型 " + (catalog.count || 0) + " 个 · " + okCount + " 个 provider 可用" +
		(bad.length ? " · " + bad.length + " 个读不到（" + bad.map((p) => p.id).join("、") + "）" : "");
}
