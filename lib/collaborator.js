/**
 * collaborator.js — 「换版本时由谁卸载旧版」的**可选**协作方探测。
 *
 * 背景（R27，2026-10-26）：宿主 0.2.1 的 `installBundle` 按**包名**判已装，
 * 对已存在的包名一律回 `already-installed`（原文：*uninstall it before installing another version*），
 * 官方面板自己的「更新」也是**先 removeBundle 再装**。所以真升级只有一条路：两阶段。
 *
 * 但「卸载」这件事不该由安装器自己动手 —— 判据（谁依赖它、它现在会不被会被加载、
 * 它是 link 还是 npm）在「插件目录」（dsh-plugin-catalog）手里。于是这里只做一件事：
 * **看看对面在不在、能力对不对得上**；在就走它，不在就明确降级。
 *
 * 两条独立性（缺一条就会变成硬依赖）：
 *   ① 本模块只依赖 `ctx.get("pluginCatalog")` 这个**可选**服务；取不到不是错误，
 *      返回 `{ok:false, state:"missing"}`，调用方据此拒绝升级而**不影响**安装/回滚/诊断。
 *   ② 对面只提供 `removal.plan/apply`（判据 + 执行），装与换版本仍归本插件。
 *
 * @module dsh-plugin-installer/collaborator
 */

/** 跨插件契约版本：对面 `removal.api` 小于它就视为不兼容（字段不保证）。 */
export const REMOVAL_API = 1;

/** 提供卸载能力的服务名（目前只有插件目录；留着数组是为了将来有第二个实现时不改调用点）。 */
export const REMOVAL_SERVICES = ["pluginCatalog"];

function readService(ctx, key) {
	if (!ctx) return undefined;
	try {
		if (typeof ctx.get === "function") {
			const found = ctx.get(key);
			if (found) return found;
		}
	} catch {
		/* 没注入不算错 */
	}
	try {
		return ctx[key];
	} catch {
		return undefined;
	}
}

/** 从 ctx 里挑出可用的协作方（同步、纯读取）。 */
export function pickRemovalProvider(ctx) {
	for (const key of REMOVAL_SERVICES) {
		const svc = readService(ctx, key);
		if (!svc) continue;
		const removal = svc.removal;
		const name = String(svc.name || key);
		const version = String(svc.version || "");
		if (!removal || typeof removal !== "object") {
			return { ok: false, state: "no-removal", service: svc, name, version, reason: "「" + name + "」没有提供卸载能力（需要插件目录 0.31.0+）" };
		}
		const api = Number(removal.api) || 0;
		if (api < REMOVAL_API) {
			return { ok: false, state: "unsupported", service: svc, name, version, reason: "「" + name + "」的卸载契约是 api " + api + "，本插件要 " + REMOVAL_API + "（升级插件目录）" };
		}
		if (typeof removal.plan !== "function" || typeof removal.apply !== "function") {
			return { ok: false, state: "no-removal", service: svc, name, version, reason: "「" + name + "」的卸载能力缺 plan/apply" };
		}
		return { ok: true, state: "available", service: svc, removal, name, version, label: labelOf(name, version) };
	}
	return null;
}

function labelOf(name, version) {
	return "「插件目录」" + (version ? " v" + version : "") + (name && name !== "dsh-plugin-catalog" ? "（" + name + "）" : "");
}

/**
 * 面向面板/预检的完整描述：可用 / 没装 / 装了没起来 / 旧版没这个能力。
 *
 * ★ 「已装"≠"可用"」这条在本机反复出现（装了但 fiberPhase 不是 active），所以这里
 *   把宿主的 `listPlugins()` 事实也用上：能说清"为什么不可用"，而不是只报"不可用"。
 *
 * @param {object} ctx  Installer 的 faces（含 pluginManager 可选访问器）
 * @returns {Promise<object>}
 */
export async function describeRemovalProvider(ctx) {
	const picked = pickRemovalProvider(ctx);
	if (picked) return picked;
	const pm = readService(ctx, "pluginManager");
	let rows = null;
	if (pm && typeof pm.listPlugins === "function") {
		try {
			rows = await pm.listPlugins();
		} catch {
			rows = null;
		}
	}
	const found = Array.isArray(rows)
		? rows.find((row) => row && /dsh-plugin-catalog/.test(String(row.moduleName || row.name || row.entryId || "")))
		: null;
	if (!found) {
		return {
			ok: false,
			state: "missing",
			name: "dsh-plugin-catalog",
			version: "",
			reason: "没装「插件目录」（dsh-plugin-catalog）—— 换版本需要它来卸载旧版并复核依赖行",
			fix: [
				{ text: "在面板「已装插件」搜 dsh-plugin-catalog 装上；或在官方插件管理器里启用它" },
				{ text: "暂时不想装：这个升级先别做（现在硬装只会被宿主回 already-installed）" }
			]
		};
	}
	const label = "「插件目录」";
	const enabled = found.enabled !== false;
	const phase = found.fiberPhase || "";
	if (!enabled) {
		return { ok: false, state: "disabled", name: "dsh-plugin-catalog", version: "", label, hostRow: { enabled, fiberPhase: phase }, reason: label + "装了但处于停用状态（enabled=false），服务没有注册", fix: [{ text: "在官方插件页把它启用（或重启 DSH）后再试" }] };
	}
	if (phase && phase !== "active") {
		return { ok: false, state: "installed-not-active", name: "dsh-plugin-catalog", version: "", label, hostRow: { enabled, fiberPhase: phase }, reason: label + "在清单里，但 fiberPhase=" + phase + "（没激活），服务取不到", fix: [{ text: "看「已装插件」里它的诊断，或重启 DSH 后再试" }] };
	}
	return {
		ok: false,
		state: "no-service",
		name: "dsh-plugin-catalog",
		version: "",
		label,
		hostRow: { enabled, fiberPhase: phase },
		reason: label + "装着的这一版没有提供卸载能力（需要 0.31.0+），或它的 apply 还没跑完",
		fix: [{ text: "把插件目录升级到 0.31.0+（它自己那一版请用官方插件管理器升级）" }]
	};
}

/**
 * 面板/工具用的一行摘要（不联网、不读盘）。
 * `ok` 时写「插件目录 v0.31.0」；不可用时写原因，且**不**写"升级可用"的暗示。
 */
export function describeCollaboratorLine(provider) {
	const p = provider || {};
	if (p.ok) return "卸载协作：" + labelOf(p.name, p.version) + "可用";
	return "卸载协作：不可用 —— " + (p.reason || "未知原因");
}
