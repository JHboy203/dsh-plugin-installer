/**
 * activation.js — 「装上了 ≠ 起来了」的单一判据源（R13 固化）。
 *
 * 为什么单独成模块：同一件事现在有三个地方要看 ——
 *   · 安装后诊断（`install.js`）：这次装的那一个起来没有；
 *   · 环境体检（`profilehealth.js`）：**所有**已装插件里谁没起来、谁缺 inject；
 *   · 面板/工具的激活视图（`pipeline.activation()` + `GET /plugin-installer/activation`）：
 *     一键回答「我装的东西现在都在跑吗」。
 * 三处各写一遍 = 判据漂移。所以：`scanActivation()` 取事实、`activationFindings()` 出文案、
 * `summarizeActivation()` 出一句话，三处都只调这里。
 *
 * 事实来自宿主契约，不猜：
 *   · `pluginManager.listPlugins()` 的行形状是 `{ entryId, moduleName, enabled, fiberPhase, readOnlyReason }`，
 *     **`entryId` 带 `include:` 前缀**（`include:imgops`）—— R13 之前按 `p.entryId === rowId` 比，
 *     永远匹配不上，那一整段判断从 R1 起就没生效过；
 *   · `enabled === true && fiberPhase !== "active"` = 名单上勾着，但宿主没拉起它；
 *   · 静态侧的 `lib/inject.js` 解释「为什么起不来」（最常见：漏 `inject` 声明）。
 *
 * ⚠️ inject 扫描要读每个包的源码，别把它放进高频路径（`/state` 轮询、`install_hub_status`）。
 *    高频路径用 `{ inject: false }`，只做 fiberPhase 判定（纯内存）。
 *
 * @module dsh-plugin-installer/activation
 */

import { join } from "node:path";

import { injectFixLine, scanInject } from "./inject.js";

/** 官方包不参与「你装的插件」视图（它们随 DSH 发布、也不该被逐个扫源码）。 */
function isOfficial(name) {
	return typeof name !== "string" || name.startsWith("@deepseek-ai/");
}

function bundleName(bundle) {
	if (typeof bundle === "string") return bundle;
	return bundle && (bundle.name || bundle.packageName) ? String(bundle.name || bundle.packageName) : null;
}

/**
 * 收集激活事实。
 *
 * @param {{profileDir?: string|null, bundles?: Array<string|object>, plugins?: Array|null,
 *   inject?: boolean, maxBundles?: number, maxFiles?: number}} input
 * @returns {Promise<{
 *   at: string, injectScanned: boolean, bundles: number, rows: Array, total: number|null,
 *   active: number, inactive: Array, missingInject: Array, truncated: boolean, errors: string[]
 * }>}
 */
export async function scanActivation(input = {}) {
	const profileDir = input.profileDir || null;
	const bundles = (Array.isArray(input.bundles) ? input.bundles : []).map(bundleName).filter(Boolean);
	const plugins = Array.isArray(input.plugins) ? input.plugins : null;
	const withInject = input.inject !== false;
	const maxBundles = Number.isFinite(input.maxBundles) ? input.maxBundles : 80;
	const maxFiles = Number.isFinite(input.maxFiles) ? input.maxFiles : 120;

	const result = {
		at: new Date().toISOString(),
		injectScanned: Boolean(withInject && profileDir),
		bundles: 0,
		rows: [],
		total: plugins ? plugins.length : null,
		active: 0,
		inactive: [],
		missingInject: [],
		truncated: false,
		errors: []
	};
	if (!plugins) {
		result.errors.push("宿主不提供 listPlugins()：判不了激活状态");
		return result;
	}

	/* ① 直接看**行**：enabled 但 fiberPhase 不是 active = 名单上勾着、宿主没拉起来。
	   这里不按 bundle 过滤 —— 一行起不来就是起不来，别因为它在别的 bundle 里就漏掉。 */
	const dead = plugins.filter((p) => p && p.enabled === true && p.fiberPhase !== "active");
	result.active = plugins.filter((p) => p && p.enabled === true && p.fiberPhase === "active").length;
	result.inactive = dead.map((p) => ({
		name: String(p.moduleName || p.entryId || "?"),
		entryId: p.entryId || null,
		fiberPhase: p.fiberPhase === undefined ? null : p.fiberPhase
	}));

	/* ② 每个第三方 bundle 一行摘要（面板/状态工具要「装了的东西」视角） */
	let count = 0;
	for (const name of bundles) {
		if (isOfficial(name)) continue;
		if (count >= maxBundles) {
			result.truncated = true;
			break;
		}
		count += 1;
		const rowsOf = plugins.filter((p) => p && (
			String(p.moduleName || "") === name ||
			String(p.entryId || "") === name ||
			String(p.entryId || "") === "include:" + name
		));
		const inactiveHere = rowsOf.filter((p) => p.enabled === true && p.fiberPhase !== "active");
		result.rows.push({
			name,
			rows: rowsOf.length,
			active: rowsOf.length > 0 && inactiveHere.length === 0,
			inject: null
		});

		/* ③ 静态侧：为什么起不来（只有显式要求时才扫源码） */
		if (withInject && profileDir) {
			const dir = join(profileDir, "node_modules", ...name.split("/"));
			const scan = await scanInject(dir, { maxFiles }).catch(() => null);
			if (scan && scan.files > 0) {
				result.rows[result.rows.length - 1].inject = {
					declared: scan.declared,
					violations: scan.violations.map((v) => v.service)
				};
				if (scan.violations.length > 0) {
					result.missingInject.push({
						name,
						services: scan.violations.map((v) => v.service),
						declared: scan.declared,
						file: scan.violations[0].file,
						line: scan.violations[0].line
					});
				}
			}
		}
	}
	result.bundles = result.rows.length;
	return result;
}

/**
 * 把事实翻成体检用的 findings（code 固定，面板/工具/脚本可以按 code 判）。
 * @param {Awaited<ReturnType<typeof scanActivation>>} result
 * @returns {Array<object>}
 */
export function activationFindings(result) {
	const findings = [];
	if (!result) return findings;

	if (result.missingInject.length > 0) {
		const detail = result.missingInject
			.slice(0, 6)
			.map((item) => "  · " + item.name + "：缺 " + item.services.join("、") + "（" + injectFixLine(item.services, item.declared) + "）")
			.join("\n");
		findings.push({
			code: "inject-contract",
			severity: "error",
			title: result.missingInject.length + " 个插件用了没声明的服务，激活时会失败",
			detail: detail + "\n判据：Cordis 不许取没在 inject 里声明的服务，取了就抛 cannot get property \"X\" without inject，整个插件激活失败（工具/命令/界面一个都不出现）。静态扫描是近似判据（动态入口扫不到），实际以启动日志为准。",
			plain: "大白话：这些插件的入口用了宿主的服务，却没在文件顶部声明要用它 —— 宿主一启动就抛错，插件整个起不来。补一行 export const inject = [...] 就好。",
			fix: [
				{ text: "让作者补 inject 声明（每条的修法都写在上面）" },
				{ text: "自己改也行：在 apply 所在的那个文件顶部加一行" },
				{ text: "改完重新装一次，再重启；确认这条消失" }
			],
			fixable: false
		});
	}

	if (result.inactive.length > 0) {
		const names = result.inactive.slice(0, 6).map((p) => p.name).join("、");
		findings.push({
			code: "plugin-inactive",
			severity: "error",
			title: result.inactive.length + " 个插件行开着但没激活：" + names + (result.inactive.length > 6 ? " 等" : ""),
			detail: result.inactive
				.slice(0, 8)
				.map((p) => "  · " + p.name + "（" + (p.entryId || "?") + "）fiberPhase=" + JSON.stringify(p.fiberPhase))
				.join("\n") +
				"\n判据：listPlugins() 的行形状 {entryId, moduleName, enabled, fiberPhase}；enabled=true 且 fiberPhase 不是 \"active\" 就是「名单上勾着，但宿主没拉起它」。entryId 带 include: 前缀，别拿 rowId 直接比。",
			plain: "大白话：这些插件的文件在、开关也开着，但宿主启动它们的那一步失败了 —— 所以它们的功能一个都不会出现。最常见的原因是漏 inject 声明（见上一条）。",
			fix: [
				{ text: "先看有没有「缺 inject」那条：有就先补声明，那通常就是同一个原因" },
				{ text: "看 DSH 启动日志里这些行后面的报错（`did not activate` 之后的原文）" },
				{ text: "修好、重新装、重启之后再跑一次体检确认这条消失" }
			],
			fixable: false
		});
	}
	return findings;
}

/**
 * 一句话结论（状态工具、面板、验收脚本共用）。
 * @param {Awaited<ReturnType<typeof scanActivation>>} result
 * @returns {string}
 */
export function summarizeActivation(result) {
	if (!result) return "未检查";
	if (Array.isArray(result.errors) && result.errors.length > 0 && result.total === null) {
		return "查不了（" + result.errors[0] + "）";
	}
	const people = Number.isFinite(result.total) ? result.total : result.bundles;
	if (!people) return "没有插件行";
	const parts = [result.active + " 行在跑" + (Number.isFinite(result.total) ? " / 共 " + result.total + " 行" : "")];
	if (result.inactive.length > 0) {
		parts.push("**" + result.inactive.length + " 行没激活**（" + result.inactive.slice(0, 4).map((p) => p.name).join("、") + (result.inactive.length > 4 ? " 等" : "") + "）");
	}
	if (result.missingInject.length > 0) parts.push(result.missingInject.length + " 个缺 inject");
	if (result.truncated) parts.push("只看了前 " + result.bundles + " 个 bundle");
	return parts.join(" · ");
}
