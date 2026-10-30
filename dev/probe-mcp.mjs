/**
 * dev/probe-mcp.mjs — R36 的 MCP 判据离线自检（纯函数 + 临时目录真写）。
 *
 * 运行（宿主进程里跑，才能写临时目录）：
 *   host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/probe-mcp.mjs" })
 *
 * 它覆盖四件事：
 *   ① 组合文件的最小解析（quoted name / config / args / env keys / disabled）；
 *   ② Registry 服务器 → 安装参数（npm / pypi / remote / 必需环境变量）；
 *   ③ 追加条目的文本形状（空 `[]` 与已有条目的两种起点）；
 *   ④ 真写一份 profile：条目落地、备份在、重复 serverName 被拒、写后复核。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	MCP_CLIENT_PACKAGE,
	addMcpToProfile,
	appendMcpEntryText,
	buildMcpView,
	candidateFromServer,
	checkMcpUpdates,
	chooseMcpInstall,
	deriveServerName,
	loadedServerNames,
	mcpEntriesOf,
	parseCompositionEntries,
	parseNpmSpecFromArgs,
	readMcpLedger
} from "../lib/mcp.js";

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

/* ① 组合文件解析 */
const sample = [
	"# comment",
	"- id: mcp-alpha",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: alpha",
	"    transport: stdio",
	"    command: npx",
	"    args:",
	"      - '-y'",
	"      - '@modelcontextprotocol/server-filesystem'",
	"    env:",
	"      TOKEN: !!js process.env.TOKEN",
	"    headers:",
	"      Authorization: '<secret>'",
	"- id: other",
	"  name: dsh-x",
	"  disabled: true"
].join("\n");
const parsed = parseCompositionEntries(sample, { file: "cordis.patch.yml" });
ok("解析：两个顶层条目", parsed.length === 2, parsed.length);
const alpha = parsed[0];
ok("解析：id / name 去引号", alpha.id === "mcp-alpha" && alpha.name === MCP_CLIENT_PACKAGE, { id: alpha.id, name: alpha.name });
ok("解析：serverName / transport / command", alpha.config.serverName === "alpha" && alpha.config.transport === "stdio" && alpha.config.command === "npx", alpha.config);
ok("解析：args 块列表", JSON.stringify(alpha.config.args) === JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem"]), alpha.config.args);
ok("解析：env / headers 只留键名", JSON.stringify(alpha.config.envKeys) === JSON.stringify(["TOKEN"]) && JSON.stringify(alpha.config.headerKeys) === JSON.stringify(["Authorization"]), { env: alpha.config.envKeys, h: alpha.config.headerKeys });
ok("解析：disabled 布尔", parsed[1].disabled === true && parsed[1].disabledRaw === "true", { d: parsed[1].disabled, raw: parsed[1].disabledRaw });

const inline = parseCompositionEntries("- id: mcp-b\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: b\n    transport: stdio\n    command: node\n    args: ['-y', '@x/y']");
ok("解析：args 行内列表", JSON.stringify(inline[0].config.args) === JSON.stringify(["-y", "@x/y"]), inline[0].config.args);
ok("mcpEntriesOf：只取 dsh-mcp-client", mcpEntriesOf(parsed).length === 1, mcpEntriesOf(parsed).length);

/* ② 视图 / 冲突 / running */
const dup = parseCompositionEntries(
	"- id: mcp-a1\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: same\n    transport: stdio\n    command: npx\n" +
	"- id: mcp-a2\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: same\n    transport: streamable-http\n    url: 'https://x/mcp'\n"
);
const view = buildMcpView({ entries: dup, loaded: new Set(["same"]), files: ["f"], notes: [] });
ok("视图：serverName 重了 → problems", view.counts.problems === 2 && view.items[0].problems.some((p) => p.code === "duplicate-server-name"), view.counts);
ok("视图：loaded 集合让 running = true", view.items.every((item) => item.running) && view.counts.running === 2, view.counts);

/* ③ Registry 数据 → 安装参数 */
const npmServer = {
	name: "com.example/filesystem",
	version: "1.0.0",
	description: "x",
	repository: { url: "https://github.com/x/y" },
	packages: [{ registryType: "npm", identifier: "@mcp/fs", runtimeHint: "npx", runtimeArguments: [{ type: "positional", value: "-y" }], environmentVariables: [] }]
};
const npmChoice = chooseMcpInstall(npmServer, "filesystem");
ok("安装：npm → npx -y <pkg>", npmChoice.ok === true && npmChoice.command === "npx" && npmChoice.installPath === "npx -y @mcp/fs", npmChoice);

const envChoice = chooseMcpInstall({
	name: "com.example/x",
	version: "1.0.0",
	packages: [{ registryType: "npm", identifier: "x-mcp", environmentVariables: [{ name: "API_KEY", isRequired: true }, { name: "OPTIONAL" }] }]
}, "x");
ok("安装：必需环境变量 → 拒绝并点名", envChoice.ok === false && envChoice.reason.includes("API_KEY") && envChoice.requiredEnv.length === 1, envChoice);

const httpChoice = chooseMcpInstall({
	name: "ai.example/time",
	version: "1.0.0",
	remotes: [{ type: "streamable-http", url: "https://time.example/mcp", headers: [] }]
}, "time");
ok("安装：streamable-http → url", httpChoice.ok === true && httpChoice.transport === "streamable-http" && httpChoice.installPath === "https://time.example/mcp", httpChoice);

const headerChoice = chooseMcpInstall({
	name: "ai.example/auth",
	version: "1.0.0",
	remotes: [{ type: "streamable-http", url: "https://auth.example/mcp", headers: [{ name: "Authorization", isRequired: true }] }]
}, "auth");
ok("安装：必需 header → 拒绝", headerChoice.ok === false && headerChoice.requiredHeaders.includes("Authorization"), headerChoice);

const candidate = candidateFromServer(npmServer, new Set());
ok("候选：kind/spec/serverName", candidate.kind === "mcp" && candidate.spec.startsWith("mcp:com.example/filesystem@") && candidate.serverName === "filesystem", candidate);
ok("候选：带安装路径与组合片段", candidate.installable === true && candidate.installPath.includes("npx") && candidate.configYaml.includes("serverName: filesystem"), candidate.installPath);

/* ④ serverName 推导 */
ok("serverName：取最后一段", deriveServerName("ai.b77/time") === "time");
ok("serverName：冲突加后缀", deriveServerName("ai.b77/time", new Set(["time"])) === "time-2");
ok("serverName：非法字符归一", /^[A-Za-z0-9_-]+$/.test(deriveServerName("a b/c d")), deriveServerName("a b/c d"));
ok("serverName：长度 <= 32", deriveServerName("x".repeat(80)).length <= 32);

/* ⑤ 追加文本 */
const appendedEmpty = appendMcpEntryText("[]\n", { id: "mcp-a", serverName: "a", transport: "stdio", command: "npx", args: ["-y", "p"] });
ok("追加：空 [] 变成条目", appendedEmpty.ok && !appendedEmpty.text.trim().startsWith("[]") && appendedEmpty.text.includes("- id: mcp-a"), appendedEmpty.text.slice(0, 60));
const baseText = "# header\n- id: mcp-old\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: old\n";
const appended = appendMcpEntryText(baseText, { id: "mcp-new", serverName: "new", transport: "streamable-http", url: "https://new/mcp" });
ok("追加：保留原条目", appended.ok && appended.text.includes("mcp-old") && appended.text.includes("mcp-new"), appended.text);

/* ⑥ 真写一份 profile（临时目录） */
const root = await mkdtemp(join(tmpdir(), "dpi-mcp-"));
try {
	const profile = join(root, "profile");
	const backups = join(root, "backups");
	const ledgerFile = join(root, "ledger.json");
	await mkdir(profile, { recursive: true });
	await writeFile(join(profile, "cordis.patch.yml"), "# empty\n[]\n", "utf8");
	const added = await addMcpToProfile({
		profileDir: profile,
		backupDir: backups,
		ledgerPath: ledgerFile,
		candidate: {
			...candidate,
			serverName: "fs",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@mcp/fs"],
			installable: true,
			installPath: "npx -y @mcp/fs"
		}
	});
	ok("真写：ok + 行号 + 备份", added.ok === true && added.line > 0 && Boolean(added.backup) && existsSync(added.backup), added);
	const text = await readFile(join(profile, "cordis.patch.yml"), "utf8");
	const after = parseCompositionEntries(text, { file: "cordis.patch.yml" });
	ok("真写：文件里出现 dsh-mcp-client 条目", after.some((entry) => entry.name === MCP_CLIENT_PACKAGE && entry.config.serverName === "fs"), after.length);
	ok("真写：原文被备份", (await readFile(added.backup, "utf8")).includes("[]"));
	const ledgerAfter = await readMcpLedger(ledgerFile);
	ok("真写：来源台账记了 registryName + version", ledgerAfter.items.fs && ledgerAfter.items.fs.registryName === "com.example/filesystem" && ledgerAfter.items.fs.version === "1.0.0", ledgerAfter);
	const again = await addMcpToProfile({
		profileDir: profile,
		backupDir: backups,
		candidate: { ...candidate, serverName: "fs", transport: "stdio", command: "npx", args: ["-y", "@mcp/fs"], installable: true }
	});
	ok("真写：重复 serverName 被拒", again.ok === false && /已经配过|已经有 id/.test(again.reason), again.reason);
	const blocked = await addMcpToProfile({
		profileDir: profile,
		backupDir: backups,
		candidate: { ...candidate, serverName: "no", installable: false, blockedReason: "需要 TOKEN" }
	});
	ok("真写：不可自动装 → 拒绝", blocked.ok === false && blocked.reason.includes("TOKEN"), blocked.reason);
} finally {
	await rm(root, { recursive: true, force: true }).catch(() => {});
}

/* ⑦ 运行中的 serverName */
const loaded = loadedServerNames({
	schemas: () => [
		{ name: "mcp__alpha__read" },
		{ name: "mcp__alpha__write" },
		{ name: "mcp__beta-2__search" },
		{ name: "install_hub_status" }
	]
});
ok("loadedServerNames：从工具名回收", loaded.has("alpha") && loaded.has("beta-2") && loaded.size === 2, [...loaded]);
ok("loadedServerNames：读不到服务不抛", loadedServerNames(null).size === 0);

/* ⑧ R36：更新检查 —— 锁版本 / 来源台账 / 无法判断 */
ok("npm 规格：未锁版本", JSON.stringify(parseNpmSpecFromArgs("npx", ["-y", "@mcp/fs"])) === JSON.stringify({ name: "@mcp/fs", version: null }), parseNpmSpecFromArgs("npx", ["-y", "@mcp/fs"]));
ok("npm 规格：锁了版本", JSON.stringify(parseNpmSpecFromArgs("npx", ["-y", "@mcp/fs@1.2.3"])) === JSON.stringify({ name: "@mcp/fs", version: "1.2.3" }), parseNpmSpecFromArgs("npx", ["-y", "@mcp/fs@1.2.3"]));
ok("npm 规格：pnpm dlx 也认", JSON.stringify(parseNpmSpecFromArgs("pnpm", ["dlx", "@mcp/fs@1.0.0"])) === JSON.stringify({ name: "@mcp/fs", version: "1.0.0" }), parseNpmSpecFromArgs("pnpm", ["dlx", "@mcp/fs@1.0.0"]));
ok("npm 规格：路径不当成包名", parseNpmSpecFromArgs("npx", ["D:/x/server.mjs"]) === null);
ok("npm 规格：node 脚本不认", parseNpmSpecFromArgs("node", ["D:/x/server.mjs"]) === null);

const ledger = {
	items: {
		a: { registryName: "ai/a", version: "1.0.0" },
		e: { registryName: "ai/e", version: "2.0.0" }
	}
};
const fakeFetch = async (name) => {
	if (name === "ai/a") return { items: [{ registryName: "ai/a", version: "1.1.0" }] };
	if (name === "ai/e") return { error: "network down" };
	return { items: [] };
};
const fakeNpm = async (name) => (name === "@mcp/b" ? { version: "1.2.0" } : { version: "1.0.0" });
const updateView = await checkMcpUpdates({
	ledger,
	items: [
		{ serverName: "a", transport: "stdio", command: "npx", args: ["-y", "@mcp/a"] },
		{ serverName: "b", transport: "stdio", command: "npx", args: ["-y", "@mcp/b@1.0.0"] },
		{ serverName: "c", transport: "stdio", command: "npx", args: ["-y", "@mcp/c"] },
		{ serverName: "d", transport: "streamable-http", url: "https://d/mcp" },
		{ serverName: "e", transport: "stdio", command: "npx", args: ["-y", "@mcp/e"] }
	],
	fetchRegistry: fakeFetch,
	npmLatestFn: fakeNpm
});
ok("更新：台账 → Registry 比对出可升级", updateView.items.find((x) => x.serverName === "a").relation === "outdated" && updateView.items.find((x) => x.serverName === "a").latestVersion === "1.1.0", updateView.items.find((x) => x.serverName === "a"));
ok("更新：锁版本 npx → npm 比对出可升级", updateView.items.find((x) => x.serverName === "b").relation === "outdated" && updateView.items.find((x) => x.serverName === "b").latestVersion === "1.2.0", updateView.items.find((x) => x.serverName === "b"));
ok("更新：未锁 npx → unknown + 原因", updateView.items.find((x) => x.serverName === "c").relation === "unknown" && /未锁版本/.test(updateView.items.find((x) => x.serverName === "c").reason));
ok("更新：远程端点 → unknown + 原因", updateView.items.find((x) => x.serverName === "d").relation === "unknown" && /远程端点/.test(updateView.items.find((x) => x.serverName === "d").reason));
ok("更新：Registry 失败 → 逐条 failed，不拖垮别的", updateView.items.find((x) => x.serverName === "e").error && updateView.summary.failed === 1 && updateView.summary.outdated === 2, updateView.summary);
ok("更新：摘要把「无法判断」单独计数", updateView.summary.undetectable === 2, updateView.summary);
ok("台账：读不到 → 空台账", JSON.stringify(await readMcpLedger(join(root || tmpdir(), "no-such-ledger.json"))) === JSON.stringify({ version: 1, items: {} }));

console.log("\nSUMMARY " + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
