/**
 * exemptions.js — 宿主「精确版本豁免」：读、判、授。
 *
 * 这一块以前是**真空白**：面板会在版本不兼容时把人指向一条 CLI
 * （`dsh plugin allow-version … --accept-risk`），而那条命令要求先**完全退出 DSH**；
 * 更糟的是我们判定兼容性时**没读**宿主已有的豁免记录 —— 于是用户按别的入口开过豁免、
 * 回来在面板装，照样被红牌挡住，形成死循环。
 *
 * 事实（全部来自宿主源码 app-boot / plugin-manager，不是猜）：
 *  · 记录文件：profile 根目录的 `compatibility.json`（`PROFILE_COMPATIBILITY_FILENAME`），
 *    形如 `{ "<pkg>@<version>": ["<dsh 版本>", ...] }`；独立元数据，不进 manifest、不进 patch。
 *  · 宿主读取：`readProfileCompatibility(dir)` → `{ exemptions, warnings, rewritable }`；
 *    文件读坏时 warnings 非空且 `rewritable=false` —— 宿主**拒绝改写**（要求人工修），
 *    所以我们的授权动作必须把这条原样翻出来，而不是留一句看不懂的报错。
 *  · 宿主授权：`setProfileVersionExemption(dir, pkg@ver, runtime, true, acceptRisk)` ——
 *    授予必须 `acceptRisk=true`，且 runtime 必须**等于当前运行版本**（否则抛
 *    "Cannot approve DSH X: this application runs DSH Y"）。插件管理器上的
 *    `setVersionExemption(pkgVersion, runtimeVersion, enabled, acceptRisk)` 还会重载插件。
 *  · 判定：`evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)` ——
 *    **只有把 exemptions 传进去**，已授权的插件才会返回 `exempted`；不传 = 一律当没开过。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { profileDir as resolveProfileDir } from "./hostinfo.js";

export const EXEMPTIONS_FILENAME = "compatibility.json";

/** `<pkg>@<version>`：按**最后一个** @ 切，作用域包（@scope/name）也切得对。 */
export function exemptionKey(name, version) {
	if (!name || !version) return null;
	return String(name) + "@" + String(version);
}

export function parseExemptionKey(key) {
	const text = String(key || "");
	const at = text.lastIndexOf("@");
	if (at <= 0) return { name: text, version: null };
	return { name: text.slice(0, at), version: text.slice(at + 1) };
}

function normalizeExemptions(raw) {
	const out = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [key, value] of Object.entries(raw)) {
		if (!Array.isArray(value)) continue;
		const versions = value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
		if (versions.length) out[key] = versions;
	}
	return out;
}

/**
 * 读当前 profile 的豁免记录。
 *
 * 优先问宿主（`pm.listVersionExemptions()` —— 它做的正是宿主自己那份解析，含 warnings），
 * 拿不到再自己读文件（工具/自检在宿主外跑时就这样）。两条路都给 `source`，
 * 面板与体检要能说清「这条结论是从哪来的」。
 *
 * @returns {Promise<{ok:boolean, exemptions:object, warnings:string[], source:"host"|"file"|"none", error?:string, path:string|null}>}
 */
export async function readExemptions(options = {}) {
	const dir = options.profileDir || resolveProfileDir();
	const path = dir ? join(dir, EXEMPTIONS_FILENAME) : null;
	const pm = options.pluginManager || null;
	if (pm && typeof pm.listVersionExemptions === "function") {
		try {
			const result = await pm.listVersionExemptions();
			const exemptions = normalizeExemptions(result && result.exemptions);
			const warnings = Array.isArray(result && result.warnings) ? result.warnings.filter(Boolean).map(String) : [];
			return { ok: true, exemptions, warnings, source: "host", path };
		} catch (e) {
			/* 宿主拒绝（例如文件读坏）也继续读文件，把真相拿到手 */
			if (!path) return { ok: false, exemptions: {}, warnings: [], source: "none", error: String((e && e.message) || e), path: null };
		}
	}
	if (!path) return { ok: false, exemptions: {}, warnings: [], source: "none", error: "profile 目录未知", path: null };
	try {
		const text = await readFile(path, "utf8");
		const parsed = JSON.parse(text);
		return { ok: true, exemptions: normalizeExemptions(parsed), warnings: [], source: "file", path };
	} catch (e) {
		if (e && e.code === "ENOENT") {
			/* 没有这个文件 = 这条 profile 还从没开过豁免，不是错误 */
			return { ok: true, exemptions: {}, warnings: [], source: "file", path, missing: true };
		}
		return { ok: false, exemptions: {}, warnings: [], source: "file", error: String((e && e.message) || e), path };
	}
}

/**
 * 这条 `pkg@version` 在当前运行版本上是不是已授权。
 * @returns {{key:string|null, runtimes:string[], granted:boolean, forOtherRuntimes:boolean}}
 */
export function lookupExemption(exemptions, name, version, runtimeVersion) {
	const key = exemptionKey(name, version);
	const runtimes = (key && exemptions && exemptions[key]) || [];
	const granted = Boolean(runtimeVersion && runtimes.includes(runtimeVersion));
	return { key, runtimes: [...runtimes], granted, forOtherRuntimes: runtimes.length > 0 && !granted };
}

/**
 * 汇总：总数、以及**宿主升级后失效**的记录（记录里的 runtime 不含当前版本）。
 * 失效记录不是错误 —— 但那正是「升级完 DSH、插件又不动了」的常见原因，值得点名。
 */
export function summarizeExemptions(exemptions, runtimeVersion) {
	const keys = Object.keys(exemptions || {});
	const stale = [];
	for (const key of keys) {
		const runtimes = exemptions[key] || [];
		if (!runtimeVersion || !runtimes.includes(runtimeVersion)) stale.push({ key, runtimes: [...runtimes] });
	}
	return { total: keys.length, keys, stale, active: keys.length - stale.length, runtimeVersion: runtimeVersion || null };
}

/**
 * 从「预检的兼容结论」推出可授权的精确目标。
 *
 * 只有**真的被判不兼容、且还没豁免**时才给目标 —— 这样授权动作就不可能被用来
 * 「预先放宽」一个本来兼容的包（判据只有一处，就在这里的 verdict 上）。
 *
 * @returns {null | {packageVersion:string, name:string, version:string, runtimeVersion:string, requirements:object}}
 */
export function exemptionTarget(compat) {
	if (!compat || typeof compat !== "object") return null;
	if (compat.verdict !== "mismatch") return null;
	if (compat.exempted) return null;
	const name = compat.name || null;
	const version = compat.version || null;
	const runtimeVersion = compat.runtimeVersion || null;
	const requirements = compat.requirements || null;
	if (!name || !version || !runtimeVersion) return null;
	if (!requirements || Object.keys(requirements).length === 0) return null;
	return { packageVersion: exemptionKey(name, version), name, version, runtimeVersion, requirements };
}

/** 风险原文：面板要逐字展示，不能只写「有风险」。措辞与宿主自己的报错保持一致。 */
export function exemptionRiskText(target) {
	if (!target) return "";
	const req = Object.entries(target.requirements || {}).map(([name, range]) => name + " 要求 " + range).join("；");
	return "这个版本声明不接受本机 DSH " + target.runtimeVersion + "（" + req + "）。" +
		"强行放行等于让作者写的代码在一个它没声明支持的环境里跑，可能崩溃或损坏数据。";
}

/**
 * 授权（走宿主接口，宿主自己写 `compatibility.json` 并重载插件 —— 留痕在宿主那份记录里）。
 *
 * @param {{pluginManager:object, target:object, acceptRisk:boolean}} input
 * @returns {Promise<{ok:boolean, granted?:object, verified?:boolean, message?:string, error?:string}>}
 */
export async function grantExemption(input) {
	const pm = input && input.pluginManager;
	const target = input && input.target;
	if (!target) return { ok: false, message: "这条任务没有可授权的版本目标（不是卡在版本兼容上）" };
	if (input.acceptRisk !== true) return { ok: false, message: "授权必须由人明确确认风险（acceptRisk 没置位，宿主也会拒绝）" };
	if (!pm || typeof pm.setVersionExemption !== "function") {
		return { ok: false, message: "宿主没提供版本豁免接口（pluginManager.setVersionExemption 不可用），只能用 CLI：dsh plugin allow-version …（要先退出 DSH）" };
	}
	try {
		await pm.setVersionExemption(target.packageVersion, target.runtimeVersion, true, true);
	} catch (e) {
		return { ok: false, message: "宿主拒绝了这次授权：" + String((e && e.message) || e), error: String((e && e.message) || e) };
	}
	const after = await readExemptions({ pluginManager: pm });
	const verdict = lookupExemption(after.exemptions, target.name, target.version, target.runtimeVersion);
	return {
		ok: true,
		granted: {
			packageVersion: target.packageVersion,
			runtimeVersion: target.runtimeVersion,
			requirements: target.requirements
		},
		verified: verdict.granted,
		exemptions: after.exemptions,
		source: after.source
	};
}
