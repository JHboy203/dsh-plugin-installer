/**
 * compat.js — 版本兼容性判定。
 *
 * 首选**官方实现**：从安装目录的 asar 里动态 import `@deepseek-ai/dsh-app-boot`，
 * 调它自己的 `evaluatePluginCompatibility()` —— 与宿主安装期用的是同一段逻辑，
 * 不会出现「面板说兼容、装到一半被插件管理器拒了」。
 *
 * 裸 import 一定失败（本插件是 link/junction 挂进 profile 的，向上找不到宿主包），
 * 所以照 dsh-screenshot 的三级兜底走：bare → profile/node_modules → app.asar。
 * 任何一级失败都只记录，最终降级到 lib/semver.js 的本地判定（并明确标注 via）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { satisfiesVersion } from "./semver.js";
import { hostVersions, profileDir } from "./hostinfo.js";

const PKG = "@deepseek-ai/dsh-app-boot";
const ENTRY = "lib/index.js";

let cache = null; // {mod, via} | {mod:null, via:'none', errors:[]}

function candidates() {
	const out = [{ label: "bare", spec: PKG, file: null }];
	const profile = profileDir();
	if (profile) {
		const file = join(profile, "node_modules", PKG, ENTRY);
		out.push({ label: "profile", spec: pathToFileURL(file).href, file });
	}
	const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
	if (resources) {
		out.push({ label: "asar", spec: pathToFileURL(join(resources, "app.asar", "dsh", "node_modules", PKG, ENTRY)).href, file: join(resources, "app.asar", "dsh", "node_modules", PKG, ENTRY) });
		out.push({ label: "app", spec: pathToFileURL(join(resources, "app", "node_modules", PKG, ENTRY)).href, file: join(resources, "app", "node_modules", PKG, ENTRY) });
	}
	if (process.env.DSH_INSTALL_ROOT) {
		const file = join(process.env.DSH_INSTALL_ROOT, "app.asar", "dsh", "node_modules", PKG, ENTRY);
		out.push({ label: "env-root", spec: pathToFileURL(file).href, file });
	}
	return out;
}

/** 只加载一次；失败也不缓存成永久失败超过 10 分钟（用户可能刚修好）。 */
export async function loadAppBoot(force = false) {
	if (!force && cache && (cache.mod || Date.now() - cache.at < 10 * 60 * 1000)) return cache;
	const errors = [];
	for (const candidate of candidates()) {
		if (candidate.file !== null && !existsSync(candidate.file)) {
			errors.push(candidate.label + ": 文件不存在");
			continue;
		}
		try {
			const mod = await import(candidate.spec);
			if (typeof mod.evaluatePluginCompatibility === "function") {
				cache = { mod, via: candidate.label, at: Date.now(), errors };
				return cache;
			}
			errors.push(candidate.label + ": 没有 evaluatePluginCompatibility");
		} catch (e) {
			errors.push(candidate.label + ": " + String((e && e.message) || e).slice(0, 160));
		}
	}
	cache = { mod: null, via: "none", at: Date.now(), errors };
	return cache;
}

/** 本地降级判定（规则对齐 app-boot 的文档：engines.dsh 独占，否则看 DSH 系 peer）。
 *  口径按宿主的宽容版本处理：预发布不算「不属于这个范围」（见 semver.satisfiesVersion 的说明）。 */
function localEvaluate(manifest, runtimeVersion) {
	const requirements = {};
	const opts = { includePrerelease: true };
	const engines = manifest && manifest.engines && typeof manifest.engines === "object" ? manifest.engines : {};
	if (typeof engines.dsh === "string") {
		if (!runtimeVersion || !satisfiesVersion(runtimeVersion, engines.dsh, opts).ok) requirements["engines.dsh"] = engines.dsh;
	} else {
		for (const [name, range] of Object.entries((manifest && manifest.peerDependencies) || {})) {
			if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
			if (typeof range !== "string" || range.startsWith("workspace:")) continue;
			if (!runtimeVersion || !satisfiesVersion(runtimeVersion, range, opts).ok) requirements[name] = range;
		}
	}
	return Object.keys(requirements).length > 0 ? { requirements } : undefined;
}

/** 降级路径也要认宿主已有的豁免记录 —— 否则「已授权的版本」在面板里仍被挡（本机实测死循环）。 */
function localExempted(manifest, exemptions, runtimeVersion) {
	if (!runtimeVersion || !exemptions || typeof exemptions !== "object") return false;
	const name = manifest && manifest.name ? String(manifest.name) : "";
	const version = manifest && manifest.version ? String(manifest.version) : "";
	if (!name || !version) return false;
	const versions = exemptions[name + "@" + version];
	return Array.isArray(versions) && versions.map(String).includes(String(runtimeVersion));
}

/**
 * @param {object} manifest 插件 package.json
 * @param {object} [options] {exemptions?: Record<string, string[]>, runtimeVersion?: string}
 *   `runtimeVersion` 由调用方**显式**给出时优先用 —— 因为在宿主进程之外（自检、CLI、探针）
 *   通常侦测不到版本（`hostVersions()` 全为 null），此时若还按 null 去比，会把所有声明
 *   版本范围的插件一律判成不兼容（本机实测：真值 3 个，误报 17 个）。
 * @returns {{ok:boolean, runtimeVersion:string|null, requirements:object|null, exempted:boolean, via:string, error?:string}}
 */
export async function evaluateCompat(manifest, options = {}) {
	const loaded = await loadAppBoot();
	const versions = await hostVersions();
	let runtimeVersion = options.runtimeVersion || versions.dshTools || versions.dsh || null;
	let via = loaded.mod ? "app-boot(" + loaded.via + ")" : "local-semver";
	let issue = null;
	let error = null;
	if (loaded.mod) {
		try {
			if (!runtimeVersion && typeof loaded.mod.getDshRuntimeVersion === "function") {
				runtimeVersion = loaded.mod.getDshRuntimeVersion();
			}
			issue = loaded.mod.evaluatePluginCompatibility(manifest, options.exemptions || {}, runtimeVersion || undefined);
		} catch (e) {
			error = String((e && e.message) || e);
			issue = localEvaluate(manifest, runtimeVersion);
			via = "local-semver(fallback)";
		}
	} else {
		error = loaded.errors && loaded.errors.length ? loaded.errors.join(" | ") : "app-boot 不可用";
		issue = localEvaluate(manifest, runtimeVersion);
	}
	if (!issue) return { ok: true, runtimeVersion, requirements: null, exempted: false, via, error };
	return {
		ok: false,
		runtimeVersion: issue.runtimeVersion || runtimeVersion,
		requirements: issue.requirements,
		/* 降级路径自己认记录；官方路径由 issue.exempted 给出 */
		exempted: Boolean(issue.exempted) || (!loaded.mod || via === "local-semver(fallback)") && localExempted(manifest, options.exemptions, runtimeVersion),
		name: issue.name || (manifest && manifest.name) || null,
		version: issue.version || (manifest && manifest.version) || null,
		via,
		error
	};
}
