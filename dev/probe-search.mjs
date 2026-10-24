/**
 * probe-search.mjs — 不进宿主，用**本机真实 profile** 算官方包名，并演示「影子包」标注（R23）。
 *
 * 用途：改了 `officialBasenames` / `annotateShadows` 的判据后，先在这里看真实官方名与示例结果，
 * 别等重启后在面板上猜。默认**不联网**；想看真实搜索结果就带 `DSH_PROBE_SEARCH="<查询>"`。
 *
 * 用法：host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-search.mjs",
 *        env:{DSH_PROBE_SEARCH:"dsh-base"}})
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { profileDir } from "../lib/hostinfo.js";
import { officialBasenames, annotateShadows } from "../lib/inventory.js";
import { searchAll } from "../lib/sources.js";

/* 在宿主外跑时 `profileDir()` 可能拿不到（依赖宿主注入的环境变量）；
   这里按「插件目录 → 上三级工作区 → .dsh/profiles/desktop」兜一次，别让探针静默等于空集合。 */
function profileForProbe() {
	const fromHost = profileDir();
	if (fromHost) return fromHost;
	const guess = join(process.cwd(), "..", "..", ".dsh", "profiles", "desktop");
	return existsSync(join(guess, "package.json")) ? guess : null;
}

const profile = profileForProbe();
const official = await officialBasenames(profile);
console.log("profile:", profile || "(认不出 —— 结果是空集合，不能用来判断误报)");
console.log("official basenames (" + official.size + "):", [...official].sort().join(", ") || "(空)");

const samples = ["dsh-base", "@deepseek-ai/dsh-base", "@someone/dsh-base", "dsh-unrelated"];
const demo = annotateShadows(samples.map((name) => ({ name, trust: { level: "community", badges: [], flags: [], score: 40 } })), official);
for (const item of demo) {
	console.log("  -", item.name, "=>", item.shadowOf ? "SHADOW of " + item.shadowOf + " (score " + item.trust.score + ")" : "ok (score " + item.trust.score + ")");
}

const q = process.env.DSH_PROBE_SEARCH;
if (q) {
	const found = await searchAll(q, { limit: 8 });
	const annotated = annotateShadows(found.items, official);
	console.log("search:", q, "· items:", annotated.length, "· cached:", Boolean(found.cached));
	for (const item of annotated) {
		const flags = ((item.trust && item.trust.flags) || []).map((f) => f.id).join(",");
		console.log("  *", item.name, item.version || "", "| flags:", flags || "-", "| score:", item.trust && item.trust.score);
	}
}
