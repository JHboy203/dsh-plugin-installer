#!/usr/bin/env node
/**
 * dev/probe-pnpmstate.mjs — 「profile 的 pnpm 世代还说得通吗」在**真 profile** 上的离线探针（R29）。
 *
 *   node DSH-Plugin/dsh-plugin-installer/dev/probe-pnpmstate.mjs [--profile <目录>] [--journal <台账路径>]
 *
 * 为什么要有它：R29 把「package.json × pnpm-lock.yaml × node_modules」的三方对账做进了插件，
 * 但 `hosttest` 用的是**构造的夹具**（几行 lockfile / 一份假 .modules.yaml）。真机上到底是
 * 「全对得上」还是「落后 20 项」，换个会话的人看不见，只能重跑一遍实验。这个探针把那次实验
 * 固化下来，一条命令回答五个问题：
 *
 *   ① 世代：package.json / lockfile / node_modules 各自的 mtime，以及 `.modules.yaml` 的
 *      `prunedAt` —— 「上一次 pnpm 真的重建 node_modules」是哪一刻（比 mtime 硬）
 *   ② 规模：声明几个依赖、lockfile 记了几个、几处版本对不上、几个没记录、几个已卸还留着
 *   ③ 样本：逐条点名前几项（谁从什么变成什么）
 *   ④ 结论：`judgePnpmState` 的一句话，以及体检会怎么报（`driftFinding` 的标题/等级/前两步处置）
 *   ⑤ 归因：台账（`data/profilestate.json`）里最新一条**不是本面板干的**变更
 *
 * **只读**：不写任何文件、不跑 pnpm、不碰宿主。判据与插件共用 `lib/profilestate.js`（同一份代码）。
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import {
	JOURNAL_NAME,
	driftFinding,
	inspectPnpmState,
	readAttribution,
	readJournal,
	signatureFromDisk
} from "../lib/profilestate.js";
import { dataDir, profileDir as hostProfileDir } from "../lib/hostinfo.js";

const args = process.argv.slice(2);
const argOf = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : null;
};

function clock(iso) {
	if (!iso) return "?";
	const at = new Date(iso);
	if (!Number.isFinite(at.getTime())) return String(iso);
	const pad = (n) => String(n).padStart(2, "0");
	return at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate()) +
		" " + pad(at.getHours()) + ":" + pad(at.getMinutes());
}

function line(label, value) {
	console.log("  " + String(label).padEnd(14) + value);
}

function sections(rows, limit = 6) {
	for (const row of rows.slice(0, limit)) console.log("    · " + row);
	if (rows.length > limit) console.log("    · …还有 " + (rows.length - limit) + " 条");
}

async function pickProfile(dir) {
	const direct = join(dir, "package.json");
	try {
		await readFile(direct, "utf8");
		return dir;
	} catch {
		/* 可能给到的是 profiles 的根：往下找一个像 profile 的子目录 */
	}
	for (const name of ["desktop", "default"]) {
		const candidate = join(dir, name);
		try {
			await readFile(join(candidate, "package.json"), "utf8");
			return candidate;
		} catch {
			/* 继续 */
		}
	}
	const entries = await readFile(join(dir, "..", "..", "package.json"), "utf8").then(() => null).catch(() => null);
	void entries;
	return null;
}

async function main() {
	console.log("dsh-plugin-installer · profile pnpm 世代探针（R29）");
	const explicit = argOf("--profile");
	const fromHost = hostProfileDir();
	const base = explicit || fromHost || join(process.cwd(), ".dsh", "profiles", "desktop");
	const profile = await pickProfile(base);
	if (!profile) {
		console.log("✗ 找不到 profile（没有 package.json）：" + base);
		console.log("  用法：node dev/probe-pnpmstate.mjs --profile <profile 目录>");
		process.exitCode = 1;
		return;
	}
	console.log("· profile：" + profile);

	const state = await inspectPnpmState({ profileDir: profile });
	const finding = driftFinding(state);

	/* ① 世代 */
	console.log("\n① 世代");
	line("package.json", clock(state.packageJsonAt));
	line("lockfile", clock(state.lockfileAt) + "（mtime）");
	line("node_modules", clock(state.modulesAt) + "（.modules.yaml mtime）");
	line("上一次 pnpm", clock(state.pnpmAt) + (state.ageDays === null ? "" : " · " + state.ageDays + " 天前"));
	line("落后", state.lagDays === null ? "判不了" : state.lagDays + " 天（package.json 比 pnpm 世代新）");
	line("布局", (state.nodeLinker || "?") + (state.packageManager ? " · " + state.packageManager : "") +
		(state.lockfileVersion ? " · lockfileVersion " + state.lockfileVersion : ""));
	line("excludeLinks", state.excludeLinks ? "true（link 缺失属正常）" : "false（link 缺失算漂移）");

	/* ② 规模 */
	const counts = state.counts || {};
	console.log("\n② 规模");
	line("声明 / 记录", (counts.declared ?? "?") + " / " + (counts.locked ?? "?"));
	line("版本对不上", String(counts.specMismatch ?? "?"));
	line("没记录", (counts.missingInLock ?? "?") + "（其中 link: " + (counts.missingLinks ?? "?") + "）");
	line("已卸还留着", String(counts.extraInLock ?? "?"));
	line("版本不一致", String(counts.versionMismatch ?? "?"));

	/* ③ 样本 */
	console.log("\n③ 样本");
	if (state.specMismatch && state.specMismatch.length) {
		console.log("  版本对不上：");
		sections(state.specMismatch.map((e) => e.name + "  " + (e.locked || "?") + " → " + e.declared));
	}
	if (state.missingInLock && state.missingInLock.length) {
		console.log("  声明了但 lockfile 没有：");
		sections(state.missingInLock.map((e) => e.name + "（" + e.label + "）"));
	}
	if (state.extraInLock && state.extraInLock.length) {
		console.log("  lockfile 里还留着已卸的：");
		sections(state.extraInLock.map((e) => e.name + "（记着 " + (e.specifier || "?") + "）"));
	}
	if (state.versionMismatch && state.versionMismatch.length) {
		console.log("  锁的版本 vs 实际装的：");
		sections(state.versionMismatch.map((e) => e.name + "  锁 " + e.lockedVersion + " / 装 " + e.installedVersion));
	}
	if (!state.specMismatch?.length && !state.missingInLock?.length && !state.extraInLock?.length && !state.versionMismatch?.length) {
		console.log("    （没有样本：三方一致，或者两份记录里有读不到的 —— 见④）");
	}

	/* ④ 结论 */
	console.log("\n④ 结论");
	console.log("  " + (state.line || "?"));
	if (!state.readable) console.log("  ⚠ 判不了（readable:false）：" + (state.reasons || []).join("；"));
	if (finding) {
		console.log("  体检会报：[" + finding.severity + "] " + finding.title);
		for (const step of (finding.fix || []).slice(0, 2)) console.log("    → " + step.text);
	} else {
		console.log("  体检不会报（对得上 / 没有可报项）");
	}

	/* ⑤ 归因 */
	const journalPath = argOf("--journal") || (dataDir() ? join(dataDir(), JOURNAL_NAME) : null);
	console.log("\n⑤ 归因台账");
	if (!journalPath) {
		console.log("  （拿不到 data 目录，跳过；可用 --journal 指定）");
	} else {
		const journal = await readJournal(journalPath);
		const attribution = readAttribution(journal, { now: Date.now() });
		console.log("  · 台账：" + journalPath);
		console.log("  · 事件 " + journal.events.length + " 条 · 最后观察 " + clock(journal.seenAt));
		if (!attribution) {
			console.log("  · 没有「不是本面板做的」变更（要么没变过，要么都是本面板干的）");
		} else {
			console.log("  · 最新一条带外变更：" + clock(attribution.at) + "（" + attribution.ageHours + "h 前）" +
				" +" + attribution.added + " / −" + attribution.removed + " / ~" + attribution.changed);
			for (const item of (attribution.items.changed || []).slice(0, 4)) console.log("    · 改版本 " + item);
			for (const item of (attribution.items.added || []).slice(0, 4)) console.log("    · 新增 " + item);
			for (const item of (attribution.items.removed || []).slice(0, 4)) console.log("    · 移除 " + item);
		}
	}

	/* 尾巴：当前签名（下次再跑就能看出「这期间变过没有」） */
	const signature = await signatureFromDisk({ profileDir: profile });
	console.log("\n· 当前签名：" + (signature.hash || "?") + "（" + Object.keys(signature.deps || {}).length + " 个依赖）");
	console.log("· 只读探针：没写任何文件、没跑 pnpm。判据与插件同源（lib/profilestate.js）。");
}

await main();
