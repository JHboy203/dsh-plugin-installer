/**
 * updates.js — 「已装的是不是最新版」（R12）。
 *
 * 只做一件事：把**可比对的那一类依赖**（npm 范围）拿去 registry 换一个 latest 版本号，
 * 然后用本机 semver 判 `outdated / current / ahead / unknown`。
 *
 * 三条硬约束（都来自踩过的坑）：
 *   ① **只在用户点了「检查更新」时发请求**。`/state` 每 2.5 秒轮询一次，把它绑上去等于
 *      每 2.5 秒打一轮 registry —— 那是最容易被限流、也最没必要的用法。
 *   ② **失败必须逐条隔离并如实回报**。一个包 404 / 超时 / 被墙，不能让它把整张表变成
 *      「全都查不到」；`failed` 里逐条写清楚，面板显示「3 个查不到（可重试）」。
 *   ③ **缓存 30 分钟、并发封顶 4**。同一个包在 TTL 内只打一次（`memoizeTtl` 自带
 *      in-flight 去重），并发太多会被 registry 当扫描器。
 *
 * 判据是「本地版本 vs latest」——注意 `^1.2.0` 这类范围**不代表**可以停在旧版：
 * 用户装的是某个具体版本，落后就是落后，与范围内外无关。
 */
import { memoizeTtl } from "./sources.js";
import { compareVersions, parseVersion, versionGap } from "./semver.js";

const TTL_MS = 30 * 60 * 1000;
const USER_AGENT = "dsh-plugin-installer (local panel; update check)";

/** `@scope/name` → `@scope/name`（逐段编码，保留斜杠分隔符，registry 两种写法都认）。 */
export function registryUrl(name) {
	const encoded = String(name || "")
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return "https://registry.npmjs.org/" + encoded + "/latest";
}

/**
 * 本地版本 vs 最新版的关系。
 * `unknown` = 有一边不是可解析的 semver（别猜）。
 * `ahead` = 本机比 registry 上更新（本地源码包/预发布常见，不是错）。
 */
export function relationOf(local, latest) {
	if (!parseVersion(local) || !parseVersion(latest)) return "unknown";
	const diff = compareVersions(String(latest), String(local));
	if (diff > 0) return "outdated";
	if (diff === 0) return "current";
	return "ahead";
}

async function npmLatestUncached(name) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(registryUrl(name), {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
			signal: controller.signal
		});
		if (res.status === 404) return { missing: true, version: null };
		if (!res.ok) throw new Error("HTTP " + res.status);
		const data = await res.json();
		return {
			version: typeof data.version === "string" ? data.version : null,
			deprecated: typeof data.deprecated === "string" ? data.deprecated : null
		};
	} finally {
		clearTimeout(timer);
	}
}

/* 30 分钟 TTL：同一个包重复点「检查更新」不会重复打 registry */
const latestCache = memoizeTtl(npmLatestUncached, TTL_MS, 128);

/** 测试与「强制刷新」用。 */
export function clearUpdateCache() {
	latestCache.clear();
}

/** 小并发池：默认 4 个同时跑，结果顺序不保证（调用方排序）。 */
async function pool(items, limit, worker) {
	const list = Array.from(items || []);
	const size = Math.max(1, Math.min(8, Number(limit) || 4));
	let cursor = 0;
	const runners = new Array(Math.min(size, list.length || 1)).fill(0).map(async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= list.length) return;
			await worker(list[index], index);
		}
	});
	await Promise.all(runners);
}

/**
 * 比对一批已装依赖。
 *
 * @param {Array} items `readInventory()` 的 items
 * @param {{concurrency?:number, limit?:number}} [options]
 * @returns {Promise<{ok:boolean, at:string, items:Array, summary:object, skipped:object}>}
 */
export async function checkUpdates(items, options = {}) {
	const at = new Date().toISOString();
	const all = Array.isArray(items) ? items : [];
	const targets = all.filter((item) => item && item.checkable && item.installed);
	const skipped = { notCheckable: 0, notInstalled: 0, noVersion: 0 };
	for (const item of all) {
		if (!item) continue;
		if (!item.checkable) skipped.notCheckable += 1;
		else if (!item.installed) skipped.notInstalled += 1;
		else if (!item.localVersion) skipped.noVersion += 1;
	}
	const usable = targets.filter((item) => item.localVersion);
	const updates = [];
	let cachedCount = 0;
	await pool(usable, options.concurrency || 4, async (item) => {
		const name = item.registryName || item.name;
		try {
			const { value, cached } = await latestCache.get(name, name);
			if (cached) cachedCount += 1;
			if (!value || value.missing) {
				updates.push({
					name: item.name, registryName: name, localVersion: item.localVersion,
					latestVersion: null, relation: "unknown", error: "registry 上没有这个包（404）"
				});
				return;
			}
			const relation = relationOf(item.localVersion, value.version);
			updates.push({
				name: item.name,
				registryName: name,
				range: item.range,
				localVersion: item.localVersion,
				latestVersion: value.version,
				relation,
				/* R26：只给「落后」的条目算跨度 —— 面板要把「8 个补丁」和「一个大版本」分开显示 */
				gap: relation === "outdated" ? versionGap(item.localVersion, value.version) : null,
				deprecated: value.deprecated || null,
				error: null
			});
		} catch (e) {
			updates.push({
				name: item.name, registryName: name, localVersion: item.localVersion,
				latestVersion: null, relation: "unknown",
				error: String((e && e.message) || e).slice(0, 120)
			});
		}
	});
	updates.sort((a, b) => {
		const rank = (u) => (u.relation === "outdated" ? 0 : u.error ? 2 : u.relation === "ahead" ? 3 : 1);
		const d = rank(a) - rank(b);
		return d !== 0 ? d : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	});
	const summary = {
		checked: updates.length,
		outdated: updates.filter((u) => u.relation === "outdated").length,
		current: updates.filter((u) => u.relation === "current").length,
		ahead: updates.filter((u) => u.relation === "ahead").length,
		failed: updates.filter((u) => u.error).length,
		deprecated: updates.filter((u) => u.deprecated).length,
		cached: cachedCount,
		at
	};
	return { ok: true, at, items: updates, summary, skipped };
}

/**
 * 把更新结果并回清单（面板只吃一份数据，不必自己 join）。
 *
 * ★ 版本对不上就**丢掉这条更新**：更新结果是「某个时刻的磁盘状态」算出来的，
 *   而装完/卸完之后清单已经变了，30 分钟的缓存还在。以前只按名字配，
 *   于是同一行会同时显示「v0.4.8」和「可升级 → 0.4.8」，「全部升级 N」也算它
 *   （R27 独立审计抓到的真缺陷）。没有 localVersion 的一侧不判 —— 不猜。
 *
 * @param {Array} items readInventory 的 items
 * @param {{items:Array}} updates checkUpdates 的结果
 */
export function mergeUpdates(items, updates) {
	const byName = new Map((updates && updates.items ? updates.items : []).map((u) => [u.name, u]));
	return (items || []).map((item) => {
		const found = byName.get(item.name) || null;
		const comparable = found && (!found.localVersion || !item.localVersion || String(found.localVersion) === String(item.localVersion));
		return { ...item, update: comparable ? found : null };
	});
}

/** 一行摘要（面板与工具共用同一句话）。 */
export function summarizeUpdates(summary) {
	if (!summary) return "还没检查更新";
	if (!summary.checked) return "没有可比对最新版的插件";
	const parts = ["可升级 " + summary.outdated];
	parts.push("最新 " + summary.current);
	if (summary.ahead) parts.push("比 registry 新 " + summary.ahead);
	if (summary.failed) parts.push("查不到 " + summary.failed);
	if (summary.deprecated) parts.push("已弃用 " + summary.deprecated);
	return parts.join(" · ");
}

/**
 * ISO 时间 → **本地** HH:MM。
 *
 * ⚠️ 别用 `iso.slice(11, 16)`：`toISOString()` 是 UTC，本机 UTC+8 时会把 02:36 显示成 18:36
 * （工具输出里真出现过 —— 对着一行「18:36 检查」去找 18:36 的日志是白费时间）。
 */
export function clockText(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
