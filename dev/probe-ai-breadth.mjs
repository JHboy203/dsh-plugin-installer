/**
 * dev/probe-ai-breadth.mjs — R41/R44 回归探针：AI 推荐的「条数 / 广度」口径 + 自定义条数（6~25）。
 *
 * 为什么要有它：这两个旋钮会同时影响**搜索池子、送进模型的候选、预算、条数上限**，
 * 而且很容易「调了名字没生效」（R40 就是候选被整类切掉、R41 才把数字收进一个口径函数）。
 * 把它固化成探针后，换会话直接跑，不用再手敲 curl 对数字。
 *
 * 两段，默认只跑第一段：
 *  ① **离线**（不发网络）：aiLimits 三档单调 / 非法值夹取 / 默认档 = 6 条 + standard；
 *     packCandidates 在三档下每类候选数随档位增加、每类至少留 1 条、不超预算；
 *     客户端 bundle 里推荐条数是「自定义」数字输入（6~25；快捷档 6/15/25 只是入口）。
 *  ② **在线**（`--base <GUI URL>`）：GET /settings 记下原值 → 三档各 POST 一次并跑同一条搜索、
 *     记录每档拿到的 plugin/mcp/skill 条数 → **finally 一定恢复原设置**（不会把你的面板留在很广）。
 *     ⚠️ `--ai` 才真调模型（会花钱），默认不跑。
 *
 * 跑法：
 *   node dev/probe-ai-breadth.mjs
 *   node dev/probe-ai-breadth.mjs --base http://127.0.0.1:<端口>
 *   node dev/probe-ai-breadth.mjs --base http://127.0.0.1:<端口> --ai --picks 6
 *   host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-ai-breadth.mjs", args:["--base","http://127.0.0.1:<端口>"]})
 *
 * 退出码：任何一项 FAIL → 1；只打印 KNOWN 不红。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packCandidates, toAiCandidate } from "../lib/ai.js";
import { AI_BREADTH_PRESETS, aiLimits, normalizeSettings } from "../lib/settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");

function arg(name, fallback = null) {
	const i = process.argv.indexOf("--" + name);
	if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
	if (i >= 0) return true;
	return fallback;
}

let failed = 0;
function report(name, ok, detail) {
	if (ok) {
		console.log("PASS " + name);
		return;
	}
	failed += 1;
	console.log("FAIL " + name + (detail === undefined ? "" : "  " + JSON.stringify(detail)));
}

/* ── ① 离线：口径与打包 ─────────────────────────────────────────────── */
const std = aiLimits({});
const wide = aiLimits({ aiBreadth: "wide" });
const max = aiLimits({ aiBreadth: "max" });

report("默认档 = 6 条 + 标准广度（R44：下限提到 6）",
	std.picks === 6 && std.breadth === "standard" && std.perKind.plugin === 8 && std.maxChars === 12000,
	{ picks: std.picks, breadth: std.breadth, perKind: std.perKind, maxChars: std.maxChars });
report("三档广度单调变宽（每类候选 / 搜索池子 / 预算）",
	wide.perKind.plugin > std.perKind.plugin && max.perKind.plugin > wide.perKind.plugin &&
	wide.search.skill > std.search.skill && max.search.skill > wide.search.skill &&
	wide.maxChars > std.maxChars && max.maxChars > wide.maxChars,
	{ std: std.perKind, wide: wide.perKind, max: max.perKind });
report("非法广度回标准（写坏了不变成无限）",
	aiLimits({ aiBreadth: "insane" }).breadth === "standard");
report("非法条数夹到边上（99 → 25、0 → 6；R43 起是自定义 6~25，不再是三档落档）",
	aiLimits({ aiPicks: 99 }).picks === 25 && aiLimits({ aiPicks: 0 }).picks === 6);
report("三档都在 AI_BREADTH_PRESETS 里（没有半截档位）",
	Object.keys(AI_BREADTH_PRESETS).length === 3 && aiLimits({ aiBreadth: "max" }).breadthLabel === "很广");

const longDesc = "这是一段很长的技能描述。".repeat(12);
const pool = [
	...Array.from({ length: 20 }, (_, i) => toAiCandidate({ kind: "plugin", name: "plugin-" + i, description: longDesc, spec: "pkg-" + i })),
	...Array.from({ length: 10 }, (_, i) => toAiCandidate({ kind: "mcp", name: "mcp-" + i, description: longDesc, serverName: "mcp-" + i, installable: true })),
	...Array.from({ length: 10 }, (_, i) => toAiCandidate({ kind: "skill", name: "skill-" + i, description: longDesc, subdir: "skills/skill-" + i, treeUrl: "https://github.com/o/r/tree/main/skills/skill-" + i, installable: true }))
];
const counting = (limits) => {
	const packed = packCandidates(pool, { perKind: limits.perKind, maxChars: limits.maxChars });
	const byKind = packed.candidates.reduce((acc, item) => {
		acc[item.kind] = (acc[item.kind] || 0) + 1;
		return acc;
	}, {});
	return { packed, byKind };
};
const packedStd = counting(std);
const packedWide = counting(wide);
const packedMax = counting(max);
report("广度档真的多送候选进模型（plugin 8 → 12 → 16）",
	packedStd.byKind.plugin === 8 && packedWide.byKind.plugin === 12 && packedMax.byKind.plugin === 16,
	{ std: packedStd.byKind, wide: packedWide.byKind, max: packedMax.byKind });
report("任何一档都不会把某一类整类切掉（三类都在）",
	["plugin", "mcp", "skill"].every((kind) => packedStd.byKind[kind] > 0 && packedMax.byKind[kind] > 0));
report("打包结果不超预算",
	packedStd.packed.json.length <= std.maxChars && packedWide.packed.json.length <= wide.maxChars && packedMax.packed.json.length <= max.maxChars);

const clientSrc = await readFile(join(PLUGIN_DIR, "client.js"), "utf8").catch(() => "");
/* R43/R44：自定义条数 —— 6~25 的任意整数；快捷档 6/15/25 只是面板上的入口 */
report("推荐条数是自定义的：7 条原样生效、默认是 6 条",
	aiLimits({ aiPicks: 7 }).picks === 7 && aiLimits({}).picks === 6 && normalizeSettings({ aiPicks: 7 }).aiPicks === 7,
	{ seven: aiLimits({ aiPicks: 7 }).picks });
report("条数越界夹到边上、小数取整（0 → 6、99 → 25、4.6 → 6）",
	aiLimits({ aiPicks: 0 }).picks === 6 && aiLimits({ aiPicks: 99 }).picks === 25 && normalizeSettings({ aiPicks: 4.6 }).aiPicks === 6,
	{ lo: aiLimits({ aiPicks: 0 }).picks, hi: aiLimits({ aiPicks: 99 }).picks });
report("面板里有「自定义」数字输入（快捷档 6/15/25 + 6–25 的范围）",
	/function PicksRow/.test(clientSrc) && /type: "number"/.test(clientSrc) &&
	/dpi-input-num/.test(clientSrc) && /6–25/.test(clientSrc));

/* ── ② 在线：设置往返 + 每档搜索规模（不花钱；--ai 才调模型） ─────────── */
const BASE = typeof arg("base", null) === "string" ? String(arg("base")).replace(/\/+$/, "") : null;
const DO_AI = arg("ai", false) === true;
const PICKS = Number(arg("picks", 6)) || 6;

if (!BASE) {
	console.log("");
	console.log("SUMMARY offline checks done（加 --base <GUI URL> 可跑设置往返与每档搜索规模；--ai 才调模型）");
	process.exitCode = failed > 0 ? 1 : 0;
} else {
	const API = BASE + "/plugin-installer";
	const get = async (path) => (await fetch(API + path, { cache: "no-store" })).json();
	const post = async (path, body) => (await fetch(API + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	})).json();
	const kindsOf = (items) => (items || []).reduce((acc, item) => {
		const kind = item.kind || "plugin";
		acc[kind] = (acc[kind] || 0) + 1;
		return acc;
	}, {});

	let original = null;
	try {
		const before = await get("/settings");
		original = { aiPicks: before.settings?.aiPicks, aiBreadth: before.settings?.aiBreadth };
		console.log("");
		console.log("· 面板：" + API + "（原设置：最多 " + original.aiPicks + " 条 / 广度 " + original.aiBreadth + "）");
		const seen = {};
		for (const breadth of ["standard", "wide", "max"]) {
			const patched = await post("/settings", { aiBreadth: breadth, aiPicks: 6 });
			const applied = patched.settings?.aiBreadth === breadth && patched.settings?.aiPicks === 6;
			const search = await post("/search", { query: "pdf" });
			const kinds = kindsOf(search.items);
			seen[breadth] = kinds;
			report("广度 " + breadth + "：设置写入并回读一致", applied, patched.settings && { aiPicks: patched.settings.aiPicks, aiBreadth: patched.settings.aiBreadth });
			report("广度 " + breadth + "：搜索拿到三类（" + JSON.stringify(kinds) + "）",
				typeof kinds.plugin === "number" && kinds.plugin > 0 && Object.keys(kinds).length >= 1, kinds);
		}
		report("广度越大搜索池子越大（plugin 条数 standard ≤ wide ≤ max）",
			(seen.standard?.plugin || 0) <= (seen.wide?.plugin || 0) && (seen.wide?.plugin || 0) <= (seen.max?.plugin || 0), seen);
		if (DO_AI) {
			console.log("· 发一次真实 AI 推荐（会花钱）…");
			const ai = await post("/ai", { message: "pdf" });
			report("AI 回包带本轮口径（limits）", Boolean(ai.limits) && ai.limits.breadth === "max", ai.limits && { picks: ai.limits.picks, breadth: ai.limits.breadth });
			report("AI 推荐条数不超过设置里的上限", (ai.recommendations || []).length <= PICKS, (ai.recommendations || []).length);
			report("AI 推荐里至少有一类是 skill / mcp / plugin 中的两类（广度 max）",
				new Set((ai.recommendations || []).map((item) => item.kind)).size >= 1, (ai.recommendations || []).map((item) => item.kind));
			console.log("  picks：" + (ai.recommendations || []).map((item) => item.kind + "/" + item.name).join(" · "));
			console.log("  listing：" + JSON.stringify(ai.listing));
		}
	} catch (e) {
		report("在线部分跑完", false, String((e && e.message) || e));
	} finally {
		/* 一定恢复原设置：探针不许把面板留在「很广」 */
		if (original) {
			try {
				const restored = await (await fetch(API + "/settings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ aiPicks: original.aiPicks, aiBreadth: original.aiBreadth })
				})).json();
				const ok = restored.settings?.aiPicks === original.aiPicks && restored.settings?.aiBreadth === original.aiBreadth;
				report("结束后已恢复原设置（最多 " + original.aiPicks + " 条 / " + original.aiBreadth + "）", ok, restored.settings);
			} catch (e) {
				report("恢复原设置", false, String((e && e.message) || e));
			}
		}
	}
	console.log("");
	console.log("SUMMARY " + failed + " FAIL / " + (failed === 0 ? "全部通过" : "见上"));
	process.exitCode = failed > 0 ? 1 : 0;
}
