/**
 * probe-live.mjs — 打**运行中的宿主**的插件路由，确认「磁盘这一版到底在不在跑」。
 *
 * 为什么要它：这个插件反复踩「磁盘改了、运行中的还是旧版」。状态工具会给指纹，
 * 但判据只能靠行为：新字段回不回话。这里一次打完 /state /health /skills，把判据标记打出来。
 *
 * 用法：host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-live.mjs", args:["3021"]})
 * 端口会随重启变化（看 GUI URL 或 install_hub_status 最后一行）。
 */
const port = process.argv[2] || process.env.DSH_GUI_PORT || "";
if (!port) {
	console.log("用法: node dev/probe-live.mjs <GUI端口>");
	process.exit(2);
}
const base = "http://127.0.0.1:" + port + "/plugin-installer";
async function get(path) {
	const res = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
	return { status: res.status, json: await res.json().catch(() => null) };
}

	try {
	const state = await get("/state");
	const health = await get("/health");
	const skills = await get("/skills");
	console.log("HTTP:", state.status, health.status, skills.status);

	const s = state.json || {};
	console.log("build:", s.build || (s.host && s.host.build) || "(无)");
	const code = (health.json && health.json.code) || {};
	console.log("code:", JSON.stringify({ fresh: code.fresh, at: code.at, appliedAt: code.appliedAt, disk: code.disk }));
	console.log("health:", JSON.stringify({
		build: health.json && health.json.build,
		profileDir: health.json && health.json.profileDir,
		landmine: health.json && health.json.landmine && health.json.landmine.present,
		clientReport: Boolean(health.json && health.json.clientReport)
	}));

	const sk = (skills.json && (skills.json.skills || skills.json)) || {};
	const counts = sk.counts || {};
	console.log("skills:", JSON.stringify({ dirs: counts.dirs, valid: counts.valid, yamlBroken: counts.yamlBroken }));
	for (const row of (sk.items || []).filter((x) => x.yamlIssue).slice(0, 6)) {
		console.log("  !", row.dir, row.yamlIssue.code, "fixable=" + row.yamlIssue.fixable);
	}
	const broken = (sk.items || []).filter((x) => x.yamlIssue);
	const anyFixableField = broken.length > 0 && broken.every((x) => x.yamlIssue.fixable !== undefined);
	console.log("markers: R21 fixable 字段=" + (broken.length === 0 ? "（无坏技能，从数据判别不了）" : String(anyFixableField)));

	/* 可选：真打一次搜索，看 R23 的 shadowOf 有没有回话（会联网，默认不做）。 */
	const q = process.env.DSH_PROBE_LIVE_SEARCH;
	if (q) {
		const res = await fetch(base + "/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: q }),
			signal: AbortSignal.timeout(25000)
		});
		const d = await res.json().catch(() => null);
		const items = (d && d.items) || [];
		console.log("search:", q, "· HTTP", res.status, "· items:", items.length);
		for (const it of items.filter((x) => x.shadowOf).slice(0, 5)) console.log("  SHADOW", it.name, "->", it.shadowOf);
		console.log("markers: R23 shadowOf 字段=" + items.some((x) => x.shadowOf !== undefined));
	}
} catch (e) {
	console.log("FAIL 连不上运行中的宿主（端口 " + port + "）：" + String((e && e.message) || e));
	console.log("提示：端口看 GUI URL 或 install_hub_status 最后一行；旧端口在重启后无效。");
	process.exit(2);
}
