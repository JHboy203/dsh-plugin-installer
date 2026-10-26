/**
 * R29：profile 的「pnpm 世代」对账 + 外部改动归因。
 *
 * ## 为什么需要它（2026-10-26 夜的真实现场）
 *
 * 面板能回答「我这次装了什么」，但回答不了两个更基本的问题：
 *   ① **这个 profile 的 pnpm 状态还说得通吗？** 实测当晚：`package.json` 45 个依赖、
 *      `pnpm-lock.yaml` 只有 35 条（9 处 specifier 对不上、16 个 link: 依赖在 lockfile 里
 *      出现 0 次、6 个已卸载的还留着），而 `.modules.yaml` 的 `prunedAt` 停在 10-21。
 *      面板对此**一个字都不说**：doctor 只报「上次启动失败」与「技能不会自动调用」。
 *      后果不是洁癖：宿主的正常安装路径是 `pnpm add <spec>`（会一次性重算整棵树），
 *      而安装**出现 warning 时**的修复路径是 `pnpm install --frozen-lockfile`
 *      （profile 原本有 lockfile 就带这个旗标）—— 在上面那个状态下它必然 OUTDATED_LOCKFILE。
 *   ② **profile 是被谁改的？** 那 7 个包是 20:13 被**原地解包覆盖**升上去的
 *      （包内文件 mtime 一半 10-14、一半 20:13，`node_modules/.pnpm` 里没有条目，
 *      任务账本里也没有对应任务）。本机同时有三条改 profile 的路：本面板、别的会话、
 *      `.tools/dsh-plugin-install.cjs` / `dsh_plugin_update` 这类手工工具。
 *
 * ## 三条纪律
 *
 * 1. **读不到 ≠ 通过**：lockfile / `.modules.yaml` 任意一个读不懂就给 `readable:false`，
 *    文案直说「判不了」，不许当成「没问题」。
 * 2. **判据只写在这里**：分类复用 `inventory.classifyDepSpec`（link / file / git / npm 的
 *    口径与「已装清单」「升级」完全同一份），面板、工具、体检共用本模块的结论。
 * 3. **只报不修**：本插件**永不自己跑 pnpm**（本机为这条踩过三次雷，见 skill 约束 1/5）。
 *    所以这里没有任何修复动作，只有「下一步该怎么做」的文字 + 一条能复制的人跑命令。
 *
 * ## 纯函数边界
 *
 * `parseLockfile` / `parseModulesManifest` / `compareProfile` / `judgePnpmState` /
 * `signatureOf` / `diffSignatures` / `appendEvent` / `readAttribution` 全部不碰 fs，
 * 由 `dev/hosttest.mjs` 直接喂夹具（真锁文件片段 + 合成签名），不需要真 profile。
 * fs 只有四个入口：`inspectPnpmState` / `signatureFromDisk` / `readJournal` / `noteProfileState`。
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { classifyDepSpec } from "./inventory.js";

export const LOCKFILE_NAME = "pnpm-lock.yaml";
export const MODULES_NAME = ".modules.yaml";
export const JOURNAL_NAME = "profilestate.json";
export const JOURNAL_VERSION = 1;
/** 事件最多留这么多条：这是一份「最近发生了什么」的台账，不是审计日志。 */
export const MAX_EVENTS = 30;
/** 没有变化时，至少隔这么久才重写一次 seenAt（避免每次状态查询都写盘）。 */
const TOUCH_MS = 10 * 60 * 1000;

/* ────────────────────────── ① 解析（零依赖，读不懂就 ok:false） ────────────────────────── */

function unquote(text) {
	const trimmed = String(text ?? "").trim();
	if (trimmed.length >= 2) {
		const head = trimmed[0];
		const tail = trimmed[trimmed.length - 1];
		if ((head === "'" && tail === "'") || (head === '"' && tail === '"')) return trimmed.slice(1, -1);
	}
	return trimmed;
}

function indentOf(line) {
	return line.length - line.trimStart().length;
}

/**
 * 解析 `pnpm-lock.yaml` 的 `importers` 段（只认根 importer `.`）。
 *
 * 行扫描而不是引 YAML 库：这个插件从 R9 起对 `allowBuilds` 就是同一个手法（`lib/installfailure.js`），
 * 理由是「零依赖 + 读坏不炸 + 只取自己要的两列」。认不出来的时候给 `ok:false`，
 * 绝不把「没读到」当成「对得上」。
 *
 * 支持：`lockfileVersion: 9.x`（importers 段）、dependencies / devDependencies / optionalDependencies。
 * 不支持：v6 及更早的顶层 `specifiers:` 形态（会给 ok:false 并说明），以及 `excludeLinksFromLockfile: true`
 * 之外的其它裁剪规则。
 */
export function parseLockfile(text) {
	const out = {
		ok: false,
		lockfileVersion: null,
		excludeLinks: false,
		deps: {},
		error: null
	};
	const raw = String(text ?? "");
	if (!raw.trim()) {
		out.error = "lockfile 是空的";
		return out;
	}
	const versionMatch = /^lockfileVersion:\s*['"]?([0-9.]+)['"]?/m.exec(raw);
	if (versionMatch) out.lockfileVersion = versionMatch[1];
	out.excludeLinks = /excludeLinksFromLockfile:\s*true/.test(raw);

	let section = null;
	let importer = null;
	let block = null;
	let current = null;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const indent = indentOf(line);
		if (indent === 0) {
			const top = /^([A-Za-z][\w-]*):/.exec(trimmed);
			section = top ? top[1] : null;
			importer = null;
			block = null;
			current = null;
			continue;
		}
		if (section !== "importers") continue;
		if (indent === 2) {
			importer = unquote(trimmed.replace(/:\s*$/, ""));
			block = null;
			current = null;
			continue;
		}
		if (importer !== ".") continue;
		if (indent === 4) {
			block = unquote(trimmed.replace(/:\s*$/, ""));
			current = null;
			continue;
		}
		if (block !== "dependencies" && block !== "devDependencies" && block !== "optionalDependencies") continue;
		if (indent === 6) {
			const name = unquote(trimmed.replace(/:\s*$/, ""));
			if (!name) continue;
			current = name;
			if (!out.deps[name]) out.deps[name] = { specifier: null, version: null };
			continue;
		}
		if (indent === 8 && current) {
			const field = /^(specifier|version):\s*(.+)$/.exec(trimmed);
			if (field) out.deps[current][field[1]] = unquote(field[2]);
		}
	}

	const names = Object.keys(out.deps);
	if (!versionMatch) out.error = "读不到 lockfileVersion（这不像 pnpm 的 lockfile）";
	else if (names.length === 0) out.error = "importers 段里没有根 importer 的依赖（lockfileVersion " + out.lockfileVersion + "，只认 v9 形态）";
	else out.ok = true;
	return out;
}

/**
 * 去掉版本号后面的 peer 后缀：`1.2.3(@a@1)(@b@2)` → `1.2.3`。
 * 先按第一个 `(` 截断就够 —— 嵌套的 peer 组（`x(@y(1)(2))`）也一并被截掉。
 */
export function baseVersion(value) {
	const text = String(value ?? "").trim();
	if (!text) return null;
	const head = text.split("(")[0].trim();
	if (!head) return null;
	if (/^(link|file|workspace|portal|patch):/i.test(head)) return null;
	return head;
}

/**
 * `.modules.yaml` 里 `hoistedLocations` 的键：`@scope/name@1.2.3(@peer@4)` → `{name, version}`。
 * 认不出返回 null（不猜）。
 */
export function splitHoistedKey(key) {
	const text = String(key ?? "").trim();
	if (!text) return null;
	const head = text.split("(")[0].trim();
	const at = head.lastIndexOf("@");
	if (at <= 0) return { name: head, version: null };
	return { name: head.slice(0, at), version: baseVersion(head.slice(at + 1)) };
}

/**
 * 解析 `node_modules/.modules.yaml`（pnpm 实际写的是 JSON 兼容形态，本机实测可以直接 JSON.parse）。
 * 它比 lockfile mtime 更能说明「上一次 pnpm 真的重建 node_modules 是哪一刻」—— `prunedAt`。
 */
export function parseModulesManifest(text) {
	const out = {
		ok: false,
		nodeLinker: null,
		layoutVersion: null,
		packageManager: null,
		prunedAt: null,
		prunedAtMs: null,
		pendingBuilds: [],
		allowBuilds: {},
		hoisted: {},
		error: null
	};
	const raw = String(text ?? "");
	if (!raw.trim()) {
		out.error = "node_modules/" + MODULES_NAME + " 是空的";
		return out;
	}
	let data = null;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		out.error = "读不懂 " + MODULES_NAME + "（不是 JSON 形态）：" + String((e && e.message) || e).slice(0, 80);
		return out;
	}
	out.nodeLinker = typeof data.nodeLinker === "string" ? data.nodeLinker : null;
	out.layoutVersion = data.layoutVersion ?? null;
	out.packageManager = typeof data.packageManager === "string" ? data.packageManager : null;
	out.pendingBuilds = Array.isArray(data.pendingBuilds) ? data.pendingBuilds.slice() : [];
	out.allowBuilds = data.allowBuilds && typeof data.allowBuilds === "object" ? data.allowBuilds : {};
	const pruned = typeof data.prunedAt === "string" ? Date.parse(data.prunedAt) : NaN;
	if (Number.isFinite(pruned)) {
		out.prunedAtMs = pruned;
		out.prunedAt = new Date(pruned).toISOString();
	}
	for (const key of Object.keys(data.hoistedLocations || {})) {
		const parsed = splitHoistedKey(key);
		if (!parsed || !parsed.version) continue;
		out.hoisted[parsed.name] = parsed.version;
	}
	out.ok = true;
	return out;
}

/* ────────────────────────── ② 对账（纯函数） ────────────────────────── */

/**
 * 三方对账：`package.json` 声明 × lockfile 记录 × `node_modules` 实际版本。
 *
 * 判据全部复用 `classifyDepSpec` —— 这里的 `kind` 与「已装清单」「升级」看到的是同一个词，
 * 否则会出现「清单说它是 link:，对账说它是 npm」这种两套口径。
 *
 * `excludeLinks` 来自 lockfile 自己的 `excludeLinksFromLockfile`：那一项为 true 时，
 * link: 依赖本来就不会写进 lockfile，缺失不算漂移（先量设置再判，别把口径钉死）。
 */
export function compareProfile({ declared = {}, locked = {}, installed = {}, excludeLinks = false } = {}) {
	const specMismatch = [];
	const missingInLock = [];
	const extraInLock = [];
	const versionMismatch = [];
	const names = Object.keys(declared);

	for (const name of names) {
		const spec = String(declared[name] ?? "");
		const info = classifyDepSpec(spec, name);
		const entry = locked[name] || null;
		if (!entry) {
			/* 「没写进 lockfile」对 link: 有三种解释：pnpm 更新（自愈）、excludeLinks、
			   或者从来没跑过 pnpm。前两种是正常的，所以按设置与 kind 分开数。 */
			const tolerated = excludeLinks && info.kind === "link";
			if (!tolerated) missingInLock.push({ name, spec, kind: info.kind, label: info.label });
			continue;
		}
		const lockSpec = String(entry.specifier ?? "");
		if (lockSpec !== spec) {
			specMismatch.push({ name, kind: info.kind, locked: lockSpec || null, declared: spec });
		}
		if (info.kind === "npm") {
			const want = baseVersion(entry.version);
			const have = baseVersion(installed[name]);
			if (want && have && want !== have) {
				versionMismatch.push({ name, lockedVersion: want, installedVersion: have });
			}
		}
	}
	for (const name of Object.keys(locked)) {
		if (!(name in declared)) {
			extraInLock.push({
				name,
				specifier: locked[name].specifier ?? null,
				version: locked[name].version ?? null
			});
		}
	}

	const missingLinks = missingInLock.filter((entry) => entry.kind === "link");
	const missingNpm = missingInLock.filter((entry) => entry.kind !== "link");
	return {
		ok: specMismatch.length === 0 && missingInLock.length === 0 && extraInLock.length === 0 && versionMismatch.length === 0,
		specMismatch,
		missingInLock,
		missingLinks,
		missingNpm,
		extraInLock,
		versionMismatch,
		counts: {
			declared: names.length,
			locked: Object.keys(locked).length,
			specMismatch: specMismatch.length,
			missingInLock: missingInLock.length,
			missingLinks: missingLinks.length,
			missingNpm: missingNpm.length,
			extraInLock: extraInLock.length,
			versionMismatch: versionMismatch.length
		}
	};
}

function daysBetween(now, thenMs) {
	if (!Number.isFinite(thenMs)) return null;
	return Math.round(((now - thenMs) / 86400000) * 10) / 10;
}

/**
 * 把「解析结果 + 对账结果」压成一句话 + 一份判据明细（面板 / 工具 / 体检共用）。
 * `readable:false` 的含义是**判不了**，不是「没问题」。
 */
export function judgePnpmState({ declared = {}, installed = {}, lock = null, modules = null, generation = {}, now = Date.now() } = {}) {
	const locked = (lock && lock.deps) || {};
	const cmp = compareProfile({ declared, locked, installed, excludeLinks: Boolean(lock && lock.excludeLinks) });
	const readable = Boolean(lock && lock.ok) && Boolean(modules && modules.ok);
	const reasons = [];
	if (!lock) reasons.push("没有 " + LOCKFILE_NAME);
	else if (!lock.ok) reasons.push(lock.error || "读不懂 " + LOCKFILE_NAME);
	if (!modules) reasons.push("没有 node_modules/" + MODULES_NAME);
	else if (!modules.ok) reasons.push(modules.error || "读不懂 " + MODULES_NAME);

	const lastPnpmMs = Math.max(
		Number.isFinite(generation.lockfileAt) ? generation.lockfileAt : -1,
		Number.isFinite(generation.modulesAt) ? generation.modulesAt : -1
	);
	const pnpmAt = lastPnpmMs >= 0 ? new Date(lastPnpmMs).toISOString() : (modules && modules.prunedAt) || null;
	const lagDays = Number.isFinite(generation.packageJsonAt) && lastPnpmMs >= 0
		? Math.max(0, Math.round(((generation.packageJsonAt - lastPnpmMs) / 86400000) * 10) / 10)
		: null;

	const state = {
		readable,
		ok: readable && cmp.ok,
		reasons,
		lockfileVersion: lock ? lock.lockfileVersion : null,
		excludeLinks: Boolean(lock && lock.excludeLinks),
		nodeLinker: modules ? modules.nodeLinker : null,
		packageManager: modules ? modules.packageManager : null,
		lockfileAt: Number.isFinite(generation.lockfileAt) ? new Date(generation.lockfileAt).toISOString() : null,
		modulesAt: Number.isFinite(generation.modulesAt) ? new Date(generation.modulesAt).toISOString() : null,
		packageJsonAt: Number.isFinite(generation.packageJsonAt) ? new Date(generation.packageJsonAt).toISOString() : null,
		pnpmAt,
		ageDays: daysBetween(now, lastPnpmMs),
		lagDays,
		counts: cmp.counts,
		specMismatch: cmp.specMismatch,
		missingInLock: cmp.missingInLock,
		extraInLock: cmp.extraInLock,
		versionMismatch: cmp.versionMismatch
	};
	state.line = describeDrift(state).line;
	return state;
}

/** 一行摘要（工具与面板共用）：说清「落后多少」与「哪几项对不上」。 */
export function describeDrift(state) {
	if (!state) return { line: "未检查", plain: "" };
	if (state.readable !== true) {
		return {
			line: "判不了：" + (state.reasons || []).join("；"),
			plain: "大白话：这份 profile 的锁文件或 node_modules 安装记录有一个读不到，所以「pnpm 世界是否还对得上」没法判断 —— 这不是「没问题」。"
		};
	}
	if (state.ok === true) {
		return {
			line: "对得上（" + state.counts.declared + " 个依赖 · lockfile 与 " + MODULES_NAME + " 都读到了 · 上一次 pnpm " + ageText(state) + "）",
			plain: "大白话：package.json、锁文件、node_modules 三方一致 —— 下一次 pnpm 不会因为「对不上」而失败。"
		};
	}
	const parts = [];
	if (state.counts.specMismatch > 0) parts.push(state.counts.specMismatch + " 处版本对不上");
	if (state.counts.missingInLock > 0) {
		parts.push(state.counts.missingInLock + " 个依赖没记录" +
			(state.counts.missingLinks > 0 ? "（其中 " + state.counts.missingLinks + " 个本机 link:）" : ""));
	}
	if (state.counts.extraInLock > 0) parts.push(state.counts.extraInLock + " 个已卸的还留着");
	if (state.counts.versionMismatch > 0) parts.push(state.counts.versionMismatch + " 个锁的版本与实际装的不一致");
	const lead = state.ageDays === null ? "lockfile 与 pnpm 世代对不上" :
		(pnpmAtText(state) + (state.lagDays !== null && state.lagDays > 0 ? "，而 package.json 比它新 " + state.lagDays + " 天" : ""));
	return {
		line: lead + "：" + (parts.length ? parts.join(" · ") : "有漂移"),
		plain: "大白话：package.json 说「装这些版本」，锁文件记的还是另一个世代的东西（有的版本没跟上、有的包已经卸了还留着）。现在插件照样能用，但下一次走 pnpm 的安装会重算整棵树；而安装出问题后的自动修复路径带 --frozen-lockfile，在这种状态下必然失败。"
	};
}

function ageText(state) {
	if (state.ageDays === null) return "未知";
	if (state.ageDays <= 0) return "今天";
	return state.ageDays + " 天前";
}

function pnpmAtText(state) {
	if (!state.pnpmAt) return "lockfile 与 pnpm 世代对不上";
	const at = new Date(state.pnpmAt);
	const pad = (n) => String(n).padStart(2, "0");
	return "上一次 pnpm 是 " + (pad(at.getMonth() + 1)) + "-" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
}

/* ────────────────────────── ③ 发现（finding，形状与修复/体检同源） ────────────────────────── */

/**
 * 体检里的一条发现。`ok` 时不返回；
 * **读不到要单独成条**（`pnpm-generation-unreadable`）—— 静默返回 null 就等于把
 * 「我不知道」伪装成「没问题」，这正是本项目反复踩的那一类失效。
 */
export function driftFinding(state) {
	if (!state) return null;
	if (state.readable !== true) {
		return {
			code: "pnpm-generation-unreadable",
			severity: "warn",
			title: "判不了 profile 的 pnpm 世代：" + (state.reasons || []).join("；"),
			detail: "判据需要 profile 根目录的 " + LOCKFILE_NAME + " 与 node_modules/" + MODULES_NAME +
				"。读不到时本插件**不会**说「一致」—— 那只是没检查，不是没问题。",
			plain: "大白话：这两份记录缺一个，就没法比较「声明要装的」「锁文件记着的」「实际装上的」三方是否一致。可能只是刚装完 DSH 还没装过插件，也可能是文件被删了。",
			fix: [
				{ text: "如果 profile 从来没跑过 pnpm（纯手工装插件），这属于正常：忽略即可" },
				{ text: "否则在 profile 目录跑一次 `pnpm install` 让两份记录重建，再重启 DSH" }
			],
			fixable: false
		};
	}
	if (state.ok === true) return null;
	const c = state.counts;
	const detail = [];
	if (state.specMismatch.length) {
		detail.push("· 版本对不上（lockfile → package.json）：" + state.specMismatch.slice(0, 6)
			.map((e) => e.name + " " + (e.locked || "?") + " → " + e.declared).join("；") +
			(state.specMismatch.length > 6 ? " 等 " + state.specMismatch.length + " 处" : ""));
	}
	if (state.missingInLock.length) {
		detail.push("· 声明了但 lockfile 里没有：" + state.missingInLock.slice(0, 6).map((e) => e.name + "（" + e.label + "）").join("、") +
			(state.missingInLock.length > 6 ? " 等 " + state.missingInLock.length + " 个" : ""));
	}
	if (state.extraInLock.length) {
		detail.push("· lockfile 里还留着已卸载的：" + state.extraInLock.slice(0, 6).map((e) => e.name).join("、") +
			(state.extraInLock.length > 6 ? " 等 " + state.extraInLock.length + " 个" : ""));
	}
	if (state.versionMismatch.length) {
		detail.push("· 锁的版本与实际装的不一致：" + state.versionMismatch.slice(0, 6)
			.map((e) => e.name + " 锁 " + e.lockedVersion + " / 装 " + e.installedVersion).join("；"));
	}
	detail.push("");
	detail.push("世代：package.json " + (state.packageJsonAt || "?") + " · lockfile " + (state.lockfileAt || "?") +
		" · node_modules 重建于 " + (state.modulesAt || "?") + (state.packageManager ? "（" + state.packageManager + "）" : ""));
	detail.push("为什么要紧：宿主正常安装走 `pnpm add <spec>` → 它会按 package.json 重算整棵树（含 " +
		(c.missingLinks || 0) + " 个 link: 目录）；而安装出现 warning 后的自动修复走 `pnpm install --frozen-lockfile`" +
		"（profile 原本有 lockfile 就带这个旗标）→ 在上面这个状态下必然报 OUTDATED_LOCKFILE。");
	detail.push("为什么不自愈：`pnpm` 只有在**它自己跑的时候**才会重写 lockfile 与 .modules.yaml。" +
		"本机实测（2026-10-26 22:2x）：10-25 13:53 之后 profile 至少变过 4 次（含 20:13 那一批 7 个包、22:16 的 botwatch 0.26.0），" +
		"而 lockfile 与 .modules.yaml 的 mtime 一次都没动 —— 说明这些变更是带外工具直接改 package.json + 覆盖 node_modules 做的。" +
		"所以漂移会一直累积，直到**某次真的走 pnpm**（本面板的安装就是那条路）才被一次性对账。");
	return {
		code: "pnpm-generation-drift",
		severity: "warn",
		title: "profile 的 pnpm 世代落后：" + [c.specMismatch ? c.specMismatch + " 处版本对不上" : null,
			c.missingInLock ? c.missingInLock + " 个依赖没记录" : null,
			c.extraInLock ? c.extraInLock + " 个已卸的还留着" : null,
			c.versionMismatch ? c.versionMismatch + " 个版本不一致" : null].filter(Boolean).join("，"),
		detail: detail.join("\n") +
			"\n判据：lockfile 的 importers 段（只认根 importer）逐条比 specifier；npm 来源再比「锁的版本 vs node_modules 里实际那份」。",
		plain: "大白话：package.json 说「装这些版本」，但锁文件记的是另一个世代 —— 有的版本没跟上，有的包早就卸了还留着。插件现在照样跑，因为宿主直接读 node_modules；可**下一次走 pnpm 的安装会把整棵树重算一遍**，而安装出问题后的自动修复带 --frozen-lockfile，在这个状态下会直接失败。",
		fix: [
			{ text: "不着急就不动：下一次**从本面板**安装会走 `pnpm add`，它会按 package.json 重算整棵树并重写 lockfile（那之后就对上了）。代价是那一跑要对账整棵树（含 " + (c.missingLinks || 0) + " 个 link: 目录），而本机历史上 pnpm 建链接掉过 EPERM" },
			{ text: "想先修干净：在 profile 目录手动跑一次 `pnpm install`（**不要**加 --frozen-lockfile），它会重算 lockfile 与 node_modules/.modules.yaml；跑完重启一次 DSH" },
			{ text: "本插件不会替你跑——「永不自跑 pnpm」是写死的纪律（那一步可能埋下 dsh-tools 覆盖，见 install_hub_doctor）" }
		],
		fixable: false
	};
}

/* ────────────────────────── ④ 归因（签名 / 差分 / 台账） ────────────────────────── */

/** 依赖清单的稳定签名：名字排序后把 {spec, kind, version} 串起来取 sha1 前 16 位。 */
export function signatureOf({ declared = {}, installed = {} } = {}) {
	const deps = {};
	for (const name of Object.keys(declared).sort()) {
		const info = classifyDepSpec(declared[name], name);
		deps[name] = {
			spec: String(declared[name] ?? ""),
			kind: info.kind,
			version: installed[name] ? String(installed[name]) : null
		};
	}
	const hash = createHash("sha1").update(JSON.stringify(deps)).digest("hex").slice(0, 16);
	return { hash, deps };
}

/** 两份签名之间的差：谁新增、谁移除、谁改了（spec 或版本）。 */
export function diffSignatures(prev, next) {
	const before = (prev && prev.deps) || {};
	const after = (next && next.deps) || {};
	const added = [];
	const removed = [];
	const changed = [];
	for (const name of Object.keys(after)) {
		if (!(name in before)) {
			added.push({ name, spec: after[name].spec, version: after[name].version, kind: after[name].kind });
			continue;
		}
		const a = before[name];
		const b = after[name];
		if (a.spec !== b.spec || a.version !== b.version) {
			changed.push({
				name,
				fromSpec: a.spec,
				toSpec: b.spec,
				fromVersion: a.version,
				toVersion: b.version,
				kind: b.kind
			});
		}
	}
	for (const name of Object.keys(before)) {
		if (!(name in after)) {
			removed.push({ name, spec: before[name].spec, version: before[name].version, kind: before[name].kind });
		}
	}
	return { added, removed, changed, empty: added.length + removed.length + changed.length === 0 };
}

/**
 * 追加一条事件（纯函数）。`reason` 的语义只有两种：
 *   · `job:<任务id>` —— 本面板干的（装 / 换版本 / 回滚 / 修）；
 *   · 其它（`startup` / `observe` / `manual`）—— 观察到的，**不能归因给本面板**。
 * 归因是这条纪律的全部意义：别的会话、手工脚本、官方插件管理器改 profile 时，
 * 面板的任务历史里是空的，只有这份台账能说明「它变过」。
 */
export function appendEvent(journal, diff, meta = {}) {
	const at = meta.at || new Date().toISOString();
	const events = Array.isArray(journal && journal.events) ? journal.events.slice() : [];
	const event = {
		at,
		reason: String(meta.reason || "observe"),
		jobId: meta.jobId || null,
		added: diff.added.length,
		removed: diff.removed.length,
		changed: diff.changed.length,
		items: {
			added: diff.added.slice(0, 12).map((e) => e.name),
			removed: diff.removed.slice(0, 12).map((e) => e.name),
			changed: diff.changed.slice(0, 12).map((e) => e.name + " " + (e.fromVersion || e.fromSpec) + "→" + (e.toVersion || e.toSpec))
		}
	};
	events.push(event);
	return {
		version: JOURNAL_VERSION,
		seenAt: at,
		signature: meta.signature || (journal && journal.signature) || null,
		events: events.slice(-MAX_EVENTS)
	};
}

/** 最新的「不是本面板干的」那条事件 —— 有就是本次要提醒的东西。 */
export function readAttribution(journal, { now = Date.now() } = {}) {
	const events = Array.isArray(journal && journal.events) ? journal.events : [];
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (!event || String(event.reason || "").startsWith("job:")) continue;
		const at = Date.parse(event.at);
		return {
			at: event.at,
			reason: event.reason,
			ageHours: Number.isFinite(at) ? Math.round(((now - at) / 3600000) * 10) / 10 : null,
			added: event.added || 0,
			removed: event.removed || 0,
			changed: event.changed || 0,
			items: event.items || { added: [], removed: [], changed: [] }
		};
	}
	return null;
}

/** 归因发现（info：只要用户知道「这次不是面板干的」）。 */
export function attributionFinding(attribution) {
	if (!attribution) return null;
	const total = (attribution.added || 0) + (attribution.removed || 0) + (attribution.changed || 0);
	if (total === 0) return null;
	const parts = [];
	if (attribution.added) parts.push("新增 " + attribution.added + "（" + (attribution.items.added || []).join("、") + "）");
	if (attribution.removed) parts.push("移除 " + attribution.removed + "（" + (attribution.items.removed || []).join("、") + "）");
	if (attribution.changed) parts.push("改版本 " + attribution.changed + "（" + (attribution.items.changed || []).join("、") + "）");
	return {
		code: "profile-changed-outside",
		severity: "info",
		title: "profile 依赖在 " + attribution.at.replace("T", " ").slice(0, 16) + " 前后变过 " + total + " 项，不是本面板做的",
		detail: "· " + parts.join("\n· ") +
			"\n本面板的任务历史里没有对应任务 —— 也就是说这次改动来自别的会话、手工工具（.tools/dsh-plugin-install.cjs / dsh_plugin_update 之类）或官方插件管理器。" +
			"这份台账只记「变过什么」，不记「谁按的」。",
		plain: "大白话：有人动过 profile 的依赖清单，但不是在「插件安装」面板里动的手。所以你在面板历史里找不到这次改动 —— 它现在是这个面板的盲区，这条就是为了把它照亮一点。",
		fix: [
			{ text: "认得出这次改动（自己装的 / 另一个会话干的）就不用管" },
			{ text: "认不出就按名字核一遍：面板「已装插件」里能看到每个依赖的来源与版本，逐条对一下" }
		],
		fixable: false
	};
}

/* ────────────────────────── ⑤ fs 边界（四个入口） ────────────────────────── */

async function readTextSafe(file) {
	try {
		const text = await readFile(file, "utf8");
		const info = await stat(file);
		return { exists: true, text, mtimeMs: info.mtimeMs };
	} catch (e) {
		return { exists: false, text: null, mtimeMs: null, error: String((e && e.message) || e) };
	}
}

async function readInstalledVersions(profileDir, names) {
	const out = {};
	await Promise.all(names.map(async (name) => {
		try {
			const text = await readFile(join(profileDir, "node_modules", ...name.split("/"), "package.json"), "utf8");
			const manifest = JSON.parse(text);
			if (manifest && typeof manifest.version === "string") out[name] = manifest.version;
		} catch {
			/* 装没装上是另一条判据（inventory 的 problems）；这里只填版本 */
		}
	}));
	return out;
}

/**
 * 读一遍 profile 的 pnpm 世代并给出结论。**只读**。
 * 返回 `judgePnpmState()` 的形状，外加 `installed`（便于归因签名复用同一次读盘）。
 */
export async function inspectPnpmState({ profileDir, manifest = null, now = Date.now() } = {}) {
	if (!profileDir) {
		return judgePnpmState({ now, lock: { ok: false, error: "读不到 profile 目录" }, modules: null });
	}
	let pkg = manifest;
	let pkgAt = null;
	if (!pkg) {
		const read = await readTextSafe(join(profileDir, "package.json"));
		if (read.exists) {
			pkgAt = read.mtimeMs;
			try {
				pkg = JSON.parse(read.text);
			} catch {
				pkg = null;
			}
		}
	}
	if (!pkg) {
		return judgePnpmState({ now, lock: { ok: false, error: "读不到 profile 的 package.json" }, modules: null });
	}
	if (pkgAt === null) {
		const read = await readTextSafe(join(profileDir, "package.json"));
		pkgAt = read.mtimeMs;
	}
	const declared = { ...(pkg.dependencies || {}) };
	const lockRead = await readTextSafe(join(profileDir, LOCKFILE_NAME));
	const modulesRead = await readTextSafe(join(profileDir, "node_modules", MODULES_NAME));
	const lock = lockRead.exists ? parseLockfile(lockRead.text) : { ok: false, deps: {}, error: "没有 " + LOCKFILE_NAME };
	const modules = modulesRead.exists ? parseModulesManifest(modulesRead.text) : { ok: false, error: "没有 node_modules/" + MODULES_NAME };
	const installed = await readInstalledVersions(profileDir, Object.keys(declared));
	const state = judgePnpmState({
		declared,
		installed,
		lock,
		modules,
		generation: {
			lockfileAt: lockRead.mtimeMs,
			modulesAt: modulesRead.mtimeMs,
			packageJsonAt: pkgAt
		},
		now
	});
	state.installed = installed;
	state.declared = declared;
	return state;
}

/** 从磁盘取一份签名（归因用；与 `inspectPnpmState` 同一次读盘也可，但这里允许单独调用）。 */
export async function signatureFromDisk({ profileDir, manifest = null } = {}) {
	if (!profileDir) return { hash: null, deps: {}, error: "读不到 profile 目录" };
	let pkg = manifest;
	if (!pkg) {
		const read = await readTextSafe(join(profileDir, "package.json"));
		if (!read.exists) return { hash: null, deps: {}, error: "读不到 package.json" };
		try {
			pkg = JSON.parse(read.text);
		} catch {
			return { hash: null, deps: {}, error: "package.json 不是合法 JSON" };
		}
	}
	const declared = { ...(pkg.dependencies || {}) };
	const installed = await readInstalledVersions(profileDir, Object.keys(declared));
	return signatureOf({ declared, installed });
}

export async function readJournal(file) {
	try {
		const data = JSON.parse(await readFile(file, "utf8"));
		return {
			version: data.version || JOURNAL_VERSION,
			seenAt: data.seenAt || null,
			signature: data.signature || null,
			events: Array.isArray(data.events) ? data.events : []
		};
	} catch {
		return { version: JOURNAL_VERSION, seenAt: null, signature: null, events: [] };
	}
}

/* 唯一 tmp 名 + 重试改名：R9 那条教训（固定 tmp 名会被并发 rename 抢走，
   Windows 上两个 rename 撞同一目标报的是 EPERM 而不是 ENOENT）。settings.json 同一处理。 */
let journalSeq = 0;

async function renameWithRetry(from, to, attempts = 4) {
	let lastError = null;
	for (let i = 0; i < attempts; i += 1) {
		try {
			await rename(from, to);
			return true;
		} catch (e) {
			lastError = e;
			await new Promise((resolve) => setTimeout(resolve, 40 * (i + 1)));
		}
	}
	throw lastError;
}

export async function writeJournal(file, data) {
	await mkdir(dirname(file), { recursive: true });
	journalSeq += 1;
	const tmp = file + "." + process.pid + "." + journalSeq + ".tmp";
	await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	await renameWithRetry(tmp, file);
	return file;
}

/**
 * 观察一次 profile 并落台账。
 *
 * `reason`：`startup`（宿主启动）/ `observe`（人点状态或体检）/ `job:<id>`（本面板自己的任务收尾）。
 * 只有真的**变了**才追加事件；没变时最多每 `TOUCH_MS` 更新一次 `seenAt`。
 * 任何失败都吞掉并返回 `{ok:false}` —— 记账不该把安装或体检带下去。
 */
export async function noteProfileState({ profileDir, journalPath, reason = "observe", jobId = null, manifest = null, force = false } = {}) {
	if (!profileDir || !journalPath) return { ok: false, error: "缺少 profileDir 或 journalPath" };
	try {
		const signature = await signatureFromDisk({ profileDir, manifest });
		if (!signature || !signature.hash) return { ok: false, error: signature && signature.error ? signature.error : "取不到签名" };
		const journal = await readJournal(journalPath);
		const prev = journal.signature && journal.signature.deps ? journal.signature : null;
		const diff = diffSignatures(prev, signature);
		const at = new Date().toISOString();
		let next = journal;
		let recorded = null;
		if (!prev) {
			/* 第一次观察：**只落基线，不记事件**。记一条「0 变化」的事件会让归因永远停在
			   那条噪声上，把更早的真实外部改动挡在后面（`readAttribution` 取的是最新那条非 job 事件）。 */
			next = {
				version: JOURNAL_VERSION,
				seenAt: at,
				signature: { hash: signature.hash, deps: signature.deps },
				events: journal.events
			};
			await writeJournal(journalPath, next);
		} else if (diff.empty === false) {
			next = appendEvent(journal, diff, {
				at,
				reason,
				jobId,
				signature: { hash: signature.hash, deps: signature.deps }
			});
			recorded = diff;
			await writeJournal(journalPath, next);
		} else if (force || !journal.seenAt || (Date.now() - Date.parse(journal.seenAt)) > TOUCH_MS) {
			next = { ...journal, version: JOURNAL_VERSION, seenAt: at, signature: { hash: signature.hash, deps: signature.deps } };
			await writeJournal(journalPath, next);
		}
		return { ok: true, recorded: recorded && !recorded.empty ? recorded : null, journal: next, signature };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}
