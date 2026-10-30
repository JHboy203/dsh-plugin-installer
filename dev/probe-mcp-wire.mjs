/**
 * dev/probe-mcp-wire.mjs — R36 接线探针（只读）：
 *   ① 真的跑一次 Installer.search（npm/GitHub/MCP Registry），确认 MCP 候选被并进 items；
 *   ② 用假 llm 跑一次面板 AI，确认 MCP 候选的 kind / installPath / requiredEnv 没在 AI 这一层丢掉。
 *
 * 不写盘、不装东西；会联网（npm / GitHub / MCP Registry）。
 */
import { Installer } from "../lib/pipeline.js";
import { runPanelAi } from "../lib/ai.js";

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) {
		passed += 1;
		console.log("PASS " + name);
	} else {
		failed += 1;
		console.log("FAIL " + name + (detail !== undefined ? " :: " + JSON.stringify(detail) : ""));
	}
}

/* ① 真 search：用一个最小假 installer 只提供 search 依赖的三样 */
const fake = {
	settings: { sources: { npm: true, github: true, hub: false } },
	inventory: async () => ({ ok: true, counts: { total: 0 }, items: [], problems: [] }),
	mcpView: async () => ({ ok: true, items: [], counts: { total: 0 } })
};
const found = await Installer.prototype.search.call(fake, "time");
ok("search：有 items", Array.isArray(found.items) && found.items.length > 0, found.items.length);
const mcpItems = found.items.filter((item) => item.kind === "mcp");
ok("search：并入了 MCP 候选", mcpItems.length > 0, mcpItems.length);
ok("search：MCP 候选带 installPath", mcpItems.every((item) => item.installPath), mcpItems.map((item) => item.installPath));
ok("search：providers 里有 mcp-registry", found.providers.some((provider) => provider.id === "mcp-registry"), found.providers.map((p) => p.id));
ok("search：mcp 摘要带安装数", found.mcp && found.mcp.count === mcpItems.length, found.mcp);
ok("search：插件候选仍带 repoUrl 字段键", found.items.some((item) => item.kind !== "mcp" && "repoUrl" in item), found.items[0]);

/* ② 假 LLM：确认 AI 层保留 MCP 字段 */
const candidate = {
	kind: "mcp",
	source: "mcp-registry",
	name: "ai.b77/time",
	displayName: "time",
	version: "1.0.0",
	description: "time server",
	spec: "mcp:ai.b77/time@1.0.0",
	serverName: "time",
	transport: "streamable-http",
	installPath: "https://time.b77.ai/mcp",
	installable: true,
	requiredEnv: [],
	blockedReason: "",
	trust: { level: "registry", badges: [], flags: [] },
	popularity: null,
	rankScore: 58
};
const plugin = {
	kind: "plugin",
	source: "npm",
	name: "dsh-example",
	version: "1.0.0",
	description: "plugin",
	spec: "dsh-example@1.0.0",
	installable: null,
	requiredEnv: [],
	trust: { level: "community", badges: [], flags: [] },
	popularity: null,
	rankScore: 50
};
const fakeInstaller = {
	async search() {
		return { items: [candidate, plugin], localOnly: null, providers: [], errors: [], mcp: { count: 1, installable: 1, error: null } };
	}
};
const fakeCtx = {
	llm: {
		async *stream() {
			yield { type: "text-delta", text: JSON.stringify({ reply: "可以装这个时间服务", picks: [{ name: "ai.b77/time", why: "远程、无需密钥" }], searchSuggestions: [] }) };
		}
	},
	agentDefaultModel: { currentSelection: () => ({ provider: "fake", model: "fake" }) }
};
const ai = await runPanelAi({ ctx: fakeCtx, installer: fakeInstaller, message: "时间" });
ok("AI：返回了推荐", ai.ok && Array.isArray(ai.recommendations) && ai.recommendations.length === 1, ai);
const pick = ai.recommendations && ai.recommendations[0];
ok("AI：保留 kind=mcp", pick && pick.kind === "mcp", pick && pick.kind);
ok("AI：保留 installPath", pick && pick.installPath === "https://time.b77.ai/mcp", pick && pick.installPath);
ok("AI：保留 serverName / transport", pick && pick.serverName === "time" && pick.transport === "streamable-http", pick);
ok("AI：requiredEnv 是数组", pick && Array.isArray(pick.requiredEnv), pick && pick.requiredEnv);

console.log("\nSUMMARY " + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
