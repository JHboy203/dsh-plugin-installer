/**
 * dev/probe-mcp-live.mjs — R36 真机只读探针：真实 profile + 真实 MCP Registry。
 *
 * 不做任何写入：只解析 profile 的两份组合文件，再查一次 Registry，
 * 回答「解析没炸 / 现在有几台 / 搜出来的能不能装 / 解析出来的命令长什么样」。
 */
import { readMcpView, resolveMcpCandidate, searchMcpRegistry } from "../lib/mcp.js";

const profile = process.env.DSH_PROFILE_DIR || "D:/信息库/AI工作区/.dsh/profiles/desktop";

const view = await readMcpView({ profileDir: profile, loadedServers: new Set() });
console.log("view.ok =", view.ok);
console.log("files =", view.files.join(" | "));
console.log("counts =", JSON.stringify(view.counts));
console.log("notes =", JSON.stringify(view.notes));
for (const item of view.items.slice(0, 10)) {
	console.log("item:", item.serverName, "|", item.transport, "|", item.state, "|", item.file + ":" + item.line, "|", (item.problems || []).map((p) => p.code).join(","));
}

const search = await searchMcpRegistry("time", { limit: 3, fresh: true });
console.log("search.error =", search.error);
for (const item of search.items) {
	console.log("cand:", item.registryName, "|", item.version, "|", item.transport, "|", item.installable, "|", item.installPath, "|", item.blockedReason || "");
}

const one = await resolveMcpCandidate("ai.b77/time");
console.log("resolve ai.b77/time =", one.ok, one.ok ? one.candidate.installPath : one.reason);
