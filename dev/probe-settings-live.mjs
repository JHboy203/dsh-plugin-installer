/**
 * dev/probe-settings-live.mjs — R47：设置里「自定义来源 + 网页开关」的**真机往返**探针。
 *
 * 为什么单独一条：`probe-custom-sources` 验的是纯函数与假 fetch，`probe-ai-breadth` 验的是条数/广度；
 * 但「设置里加了来源、宿主真的存下来了、网页开关真的能开」这三件事只有打真接口才能证明。
 * 而且 —— 探针改过的设置**必须恢复**，否则换会话的人会看到一堆"探针来源"。
 *
 * 两段：
 *  ① 离线（不联网）：默认值 / 归一化后的键；
 *  ② 在线（`--base <GUI URL>`）：GET 记原值 → POST 加一条 github 来源 → POST 开网页开关 →
 *     POST /sources/assist 试一次「规则能认的输入」（不花 token）→ **finally 恢复**。
 *
 * 跑法：
 *   node dev/probe-settings-live.mjs
 *   node dev/probe-settings-live.mjs --base http://127.0.0.1:<端口>
 *   host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-settings-live.mjs", args:["--base","http://127.0.0.1:<端口>"]})
 */
import { DEFAULTS, normalizeSettings } from "../lib/settings.js";

let failed = 0;
function report(name, ok, detail) {
	if (ok) {
		console.log("PASS " + name);
		return;
	}
	failed += 1;
	console.log("FAIL " + name + (detail === undefined ? "" : "  " + JSON.stringify(detail)));
}

/* ── ① 离线：默认值与归一化 ─────────────────────────────────────────── */
const defaults = normalizeSettings({});
report("默认：自定义来源为空、网页解析关闭",
	defaults.customSources.length === 0 && defaults.allowWebSources === false,
	{ customSources: defaults.customSources, allowWebSources: defaults.allowWebSources });
const normalized = normalizeSettings({
	customSources: [
		{ type: "github", target: "https://github.com/topics/dsh-plugin", label: "probe" },
		{ type: "ftp", target: "ftp://nope" }
	],
	allowWebSources: true
});
report("归一化：合法来源留下、非法类型丢掉、网页开关保留",
	normalized.customSources.length === 1 && normalized.customSources[0].target === "topic:dsh-plugin" &&
	normalized.allowWebSources === true, normalized.customSources);
report("设置里有这两个键（不然面板存了也不会生效）",
	"customSources" in DEFAULTS && "allowWebSources" in DEFAULTS);

/* ── ② 在线：真接口往返 ─────────────────────────────────────────────── */
const arg = (name, fallback = null) => {
	const i = process.argv.indexOf("--" + name);
	if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
	return fallback;
};
const BASE = typeof arg("base") === "string" ? String(arg("base")).replace(/\/+$/, "") : null;
const PROBE_TARGET = "topic:dsh-plugin-probe";

if (!BASE) {
	console.log("");
	console.log("SUMMARY offline checks done（加 --base <GUI URL> 可跑真机设置往返；finally 一定恢复）");
	process.exitCode = failed > 0 ? 1 : 0;
} else {
	const API = BASE + "/plugin-installer";
	const get = async (path) => (await fetch(API + path, { cache: "no-store" })).json();
	const post = async (path, body) => (await fetch(API + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	})).json();

	let original = null;
	try {
		const before = await get("/settings");
		original = {
			aiPicks: before.settings?.aiPicks,
			aiBreadth: before.settings?.aiBreadth,
			customSources: before.settings?.customSources || [],
			allowWebSources: before.settings?.allowWebSources === true
		};
		console.log("");
		console.log("· 面板：" + API + "（原设置：自定义 " + original.customSources.length + " 条 / 网页 " + (original.allowWebSources ? "开" : "关") + "）");

		/* 1) 加一条来源：读回必须看得到（type/target 原样） */
		const added = await post("/settings", {
			customSources: [...original.customSources, { type: "github", target: PROBE_TARGET, label: "probe-source", note: "probe" }]
		});
		const found = (added.settings?.customSources || []).find((s) => s.target === PROBE_TARGET);
		report("加一条自定义来源：宿主存下并可回读", Boolean(found) && found.type === "github", found || added.settings?.customSources);

		/* 2) 网页开关 */
		const webOn = await post("/settings", { allowWebSources: true });
		report("网页解析开关：开到 true 能回读", webOn.settings?.allowWebSources === true, webOn.settings?.allowWebSources);

		/* 3) AI 辅助接口（规则能认的输入 → 不调模型、不花钱） */
		const assist = await post("/sources/assist", { input: "https://github.com/topics/dsh-plugin" });
		report("/sources/assist 只出提案（github → topic:dsh-plugin）",
			assist.ok === true && assist.via === "rules" && assist.proposal?.type === "github" &&
			assist.proposal?.target === "topic:dsh-plugin", assist);
	} catch (e) {
		report("在线部分跑完", false, String((e && e.message) || e));
	} finally {
		/* 一定恢复：探针不许把「probe-source」或网页开关留在你的设置里 */
		if (original) {
			try {
				const restored = await post("/settings", {
					aiPicks: original.aiPicks,
					aiBreadth: original.aiBreadth,
					customSources: original.customSources,
					allowWebSources: original.allowWebSources
				});
				const sameSources = JSON.stringify(restored.settings?.customSources || []) === JSON.stringify(original.customSources);
				const ok = restored.settings?.allowWebSources === original.allowWebSources &&
					restored.settings?.aiPicks === original.aiPicks && sameSources;
				report("结束后已恢复原设置（来源 / 网页开关 / 条数）", ok, {
					customSources: restored.settings?.customSources,
					allowWebSources: restored.settings?.allowWebSources,
					aiPicks: restored.settings?.aiPicks
				});
			} catch (e) {
				report("恢复原设置", false, String((e && e.message) || e));
			}
		}
	}
	console.log("");
	console.log("SUMMARY " + failed + " FAIL / " + (failed === 0 ? "全部通过" : "见上"));
	process.exitCode = failed > 0 ? 1 : 0;
}
