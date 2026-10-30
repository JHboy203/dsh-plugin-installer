/**
 * mcp.js — MCP 服务器的「已装清单」+「从 Registry 装一台」（R36）。
 *
 * 为什么 MCP 不能当成普通插件装：
 *   DSH 的 MCP 由官方包 `@deepseek-ai/dsh-mcp-client` 实现，**每台服务器就是
 *   profile 组合文件（cordis.patch.yml）里的一条条目**：
 *
 *     - id: mcp-filesystem
 *       name: '@deepseek-ai/dsh-mcp-client'
 *       config:
 *         serverName: filesystem
 *         transport: stdio
 *         command: npx
 *         args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/docs']
 *
 *   它不在 `dsh.profile.bundles` 里，所以「已装插件」永远看不见它；工具名是
 *   `mcp__<serverName>__<tool>`，归属只能按名字前缀判。
 *
 * 本模块分两半：
 *   · **纯函数**：解析组合文本、推导安装参数、生 YAML 片段、合并已装视图。
 *     探针可以对着合成文本断言，不碰盘、不联网。
 *   · **IO**：读 profile 的两份组合文件；调官方 MCP Registry；写回（备份 + 原子写 + 写后复核）。
 *
 * ★ 安全：`env` / `headers` 的**值永不进视图**，只留键名。面板会被截图、发给人看。
 * ★ 不信任客户端：真正写入用的 command/args/url 一律由**服务端重新查 Registry**得到，
 *   面板带上来的只是「名字 + 版本」。
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fetchJson } from "./download.js";
import { compareVersions, versionGap } from "./semver.js";
import { npmLatest, relationOf } from "./updates.js";

/** 官方 MCP 客户端包：每台服务器都是它的一条配置条目。 */
export const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";

/** 支持的传输方式（README 的字段表：stdio / streamable-http）。 */
export const MCP_TRANSPORTS = Object.freeze(["stdio", "streamable-http"]);

/** serverName 的合法形状（README：`[A-Za-z0-9_-]{1,32}`，作用域内唯一）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 空态模板：本机一台 MCP 都没有时，面板直接给能抄的一段。 */
export const MCP_TEMPLATE = [
	"# 追加到 <profile>/cordis.patch.yml（改完要重启 DSH）。",
	"# 下面是一台「官方 MCP Registry」上的远程服务器，不需要任何密钥：",
	"- id: mcp-time",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: time",
	"    transport: streamable-http",
	"    url: 'https://time.b77.ai/mcp'",
	"",
	"# 本地 stdio 服务器（需要 npx）：",
	"- id: mcp-filesystem",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: filesystem",
	"    transport: stdio",
	"    command: npx",
	"    args:",
	"      - '-y'",
	"      - '@modelcontextprotocol/server-filesystem'",
	"      - 'D:/your-workspace'",
].join("\n");

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0/servers";
const SEARCH_TTL_MS = 5 * 60 * 1000;

function nowIso() {
	return new Date().toISOString();
}

function unquote(raw) {
	const text = String(raw ?? "").trim();
	if (text.length >= 2) {
		const first = text[0];
		const last = text[text.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
			const inner = text.slice(1, -1);
			return first === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
	}
	return text;
}

/** 行内流式列表 `['a', 'b']`。 */
function parseInlineList(raw) {
	const text = String(raw || "").trim();
	if (!text.startsWith("[") || !text.endsWith("]")) return null;
	const inner = text.slice(1, -1).trim();
	if (inner === "") return [];
	return inner
		.split(",")
		.map((part) => unquote(part.trim()))
		.filter((part) => part !== "");
}

function indentOf(line) {
	return line.length - line.replace(/^\s*/, "").length;
}

/** 去掉行尾注释（只处理 ` #`，且引号外的）。 */
function stripComment(raw) {
	const text = String(raw ?? "");
	let quote = null;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\" && quote === '"') {
				i += 1;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
	}
	return text;
}

function splitKeyValue(line) {
	const text = stripComment(line);
	const idx = text.indexOf(":");
	if (idx < 0) return null;
	return { key: text.slice(0, idx).trim(), value: text.slice(idx + 1) };
}

/**
 * 解析组合文件里的**顶层条目**（只到 `config:` 下一层）。
 *
 * 这是刻意的最小解析器：不引 YAML 依赖，也不求值 `!!js`。
 * 返回值只覆盖本插件要说清楚的那几件事。
 *
 * @param {string|null} text
 * @param {{file?:string}} [options]
 */
export function parseCompositionEntries(text, options = {}) {
	const file = typeof options.file === "string" ? options.file : "";
	const lines = String(text ?? "").split(/\r?\n/);
	const entries = [];
	let cur = null;
	let configKey = null;
	let configList = null;
	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i];
		if (/^-\s+/.test(raw)) {
			cur = {
				id: "",
				name: "",
				disabled: false,
				disabledRaw: "",
				hasName: false,
				hasConfig: false,
				config: {
					serverName: "",
					transport: "",
					command: "",
					cwd: "",
					url: "",
					args: [],
					envKeys: [],
					headerKeys: [],
					otherKeys: [],
				},
				file,
				line: i + 1,
			};
			entries.push(cur);
			configKey = null;
			configList = null;
			const kv = splitKeyValue(raw.replace(/^-\s+/, ""));
			if (kv) applyEntryKey(cur, kv.key, kv.value);
			continue;
		}
		if (!cur) continue;
		const indent = indentOf(raw);
		if (indent === 0) {
			configKey = null;
			configList = null;
			continue;
		}
		const kv = splitKeyValue(raw);
		if (indent === 2) {
			configKey = null;
			configList = null;
			if (!kv) continue;
			if (kv.key === "config") {
				cur.hasConfig = true;
				continue;
			}
			applyEntryKey(cur, kv.key, kv.value);
			continue;
		}
		if (!cur.hasConfig) continue;
		if (indent === 4) {
			if (!kv) continue;
			configKey = kv.key;
			const value = kv.value.trim();
			if ((configKey === "args" || configKey === "env" || configKey === "headers") && value === "") {
				configList = configKey;
				continue;
			}
			configList = null;
			applyConfigKey(cur, configKey, value);
			continue;
		}
		if (indent >= 6 && configList) {
			const trimmed = raw.trim();
			if (configList === "args" && /^-\s+/.test(trimmed)) {
				const value = unquote(trimmed.replace(/^-\s+/, ""));
				if (value !== "") cur.config.args.push(value);
				continue;
			}
			if ((configList === "env" || configList === "headers") && kv) {
				const key = unquote(kv.key);
				if (key && !(configList === "env" ? cur.config.envKeys : cur.config.headerKeys).includes(key)) {
					(configList === "env" ? cur.config.envKeys : cur.config.headerKeys).push(key);
				}
			}
		}
	}
	return entries;
}

function applyEntryKey(entry, key, rawValue) {
	const value = unquote(rawValue);
	if (key === "id") entry.id = value;
	else if (key === "name") {
		entry.hasName = true;
		if (value !== "" && !entry.name) entry.name = value;
	} else if (key === "disabled") {
		entry.disabledRaw = String(rawValue || "").trim();
		entry.disabled = /^true$/i.test(value);
	}
}

function applyConfigKey(entry, key, rawValue) {
	const config = entry.config;
	const value = unquote(rawValue);
	if (key === "serverName") config.serverName = value;
	else if (key === "transport") config.transport = value;
	else if (key === "command") config.command = value;
	else if (key === "cwd") config.cwd = value;
	else if (key === "url") config.url = value;
	else if (key === "args") {
		const inline = parseInlineList(rawValue);
		if (inline) config.args = inline;
	} else if (key !== "env" && key !== "headers") {
		if (!config.otherKeys.includes(key)) config.otherKeys.push(key);
	}
}

/** 只把 MCP 客户端条目挑出来。 */
export function mcpEntriesOf(entries) {
	return (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.name === MCP_CLIENT_PACKAGE);
}

/** 从工具名里回收「已经在跑的 serverName」（`mcp__<server>__<tool>`）。 */
export function loadedServerNames(tools) {
	const names = new Set();
	try {
		const list = tools && typeof tools.schemas === "function" ? tools.schemas() : [];
		for (const schema of Array.isArray(list) ? list : []) {
			const name = String((schema && schema.name) || "");
			if (!name.startsWith("mcp__")) continue;
			const rest = name.slice(5);
			const idx = rest.indexOf("__");
			const server = idx >= 0 ? rest.slice(0, idx) : rest;
			if (server) names.add(server);
		}
	} catch {
		/* 工具服务读不到不算错 —— 列表照常出，只是 running 判不出来 */
	}
	return names;
}

function problemsOf(entry, duplicateNames) {
	const problems = [];
	const config = entry.config || {};
	if (!config.serverName) problems.push({ code: "missing-server-name", text: "缺 serverName：工具名没有 namespace，宿主不会注册" });
	else if (!SERVER_NAME_RE.test(config.serverName)) {
		problems.push({ code: "bad-server-name", text: "serverName 只允许 A-Z a-z 0-9 _ -，1~32 个字符：" + config.serverName });
	}
	if (!config.transport) problems.push({ code: "missing-transport", text: "缺 transport（stdio / streamable-http）" });
	else if (!MCP_TRANSPORTS.includes(config.transport)) {
		problems.push({ code: "bad-transport", text: "不支持的 transport：" + config.transport });
	}
	if (config.transport === "stdio" && !config.command) problems.push({ code: "missing-command", text: "stdio 缺 command" });
	if (config.transport === "streamable-http" && !config.url) problems.push({ code: "missing-url", text: "streamable-http 缺 url" });
	if (config.serverName && duplicateNames && duplicateNames.get(config.serverName) > 1) {
		problems.push({ code: "duplicate-server-name", text: "serverName 重了：" + config.serverName + "（工具名会互相覆盖）" });
	}
	return problems;
}

function itemOfEntry(entry, loaded, duplicateNames) {
	const config = entry.config || {};
	const serverName = config.serverName || "";
	const problems = problemsOf(entry, duplicateNames);
	const running = Boolean(serverName) && loaded.has(serverName);
	return {
		id: entry.id || "",
		serverName,
		transport: config.transport || "",
		command: config.command || "",
		args: Array.isArray(config.args) ? config.args : [],
		url: config.url || "",
		cwd: config.cwd || "",
		envKeys: config.envKeys || [],
		headerKeys: config.headerKeys || [],
		disabled: Boolean(entry.disabled),
		disabledRaw: entry.disabledRaw || "",
		running,
		state: entry.disabled ? "off" : running ? "running" : "configured",
		problems,
		file: entry.file || "",
		line: entry.line || 0,
	};
}

/**
 * 把条目合并成面板视图。纯函数，测试直接喂合成条目。
 * @param {{entries:Array, loaded?:Set<string>, files?:string[], notes?:string[]}} input
 */
export function buildMcpView({ entries, loaded, files, notes } = {}) {
	const mcp = mcpEntriesOf(entries);
	const duplicateNames = new Map();
	for (const entry of mcp) {
		const name = entry.config && entry.config.serverName;
		if (!name) continue;
		duplicateNames.set(name, (duplicateNames.get(name) || 0) + 1);
	}
	const loadedSet = loaded instanceof Set ? loaded : new Set(Array.isArray(loaded) ? loaded : []);
	const items = mcp.map((entry) => itemOfEntry(entry, loadedSet, duplicateNames));
	const counts = {
		total: items.length,
		running: items.filter((item) => item.running).length,
		configured: items.filter((item) => item.state === "configured").length,
		disabled: items.filter((item) => item.disabled).length,
		problems: items.filter((item) => item.problems.length > 0).length
	};
	return {
		ok: true,
		items,
		counts,
		files: Array.isArray(files) ? files : [],
		notes: Array.isArray(notes) ? notes : [],
		template: MCP_TEMPLATE,
		at: nowIso()
	};
}

/** 读 profile 的两份组合文件并出视图。只读，不联网。 */
export async function readMcpView({ profileDir, loadedServers } = {}) {
	if (!profileDir) {
		return { ok: false, error: "读不到 profile 目录（DSH_PROFILE_DIR 未设置）", items: [], counts: { total: 0, running: 0, configured: 0, disabled: 0, problems: 0 }, files: [], notes: [], template: MCP_TEMPLATE };
	}
	const files = [join(profileDir, "cordis.yml"), join(profileDir, "cordis.patch.yml")];
	const entries = [];
	const notes = [];
	for (const file of files) {
		let text = null;
		try {
			text = await readFile(file, "utf8");
		} catch (e) {
			if (e && e.code !== "ENOENT") notes.push("读不到 " + file + "：" + String((e && e.message) || e));
			continue;
		}
		try {
			entries.push(...parseCompositionEntries(text, { file }));
		} catch (e) {
			notes.push("解析失败 " + file + "：" + String((e && e.message) || e));
		}
	}
	/* 同 id 后者胜（patch 层覆盖根层） */
	const byId = new Map();
	for (const entry of entries) {
		if (!entry.id) {
			byId.set("__line-" + entry.file + "-" + entry.line, entry);
			continue;
		}
		byId.set(entry.id, entry);
	}
	const merged = [...byId.values()];
	const loaded = loadedServers instanceof Set ? loadedServers : new Set(Array.isArray(loadedServers) ? loadedServers : []);
	return buildMcpView({ entries: merged, loaded, files, notes });
}

/** 把 registry 名字变成合法且尽量短的 serverName。 */
export function deriveServerName(registryName, used) {
	const text = String(registryName || "").trim();
	const last = text.split("/").pop() || text;
	const base = last
		.split(".")[0]
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
		.slice(0, 32) || "mcp";
	const taken = used instanceof Set ? used : new Set(Array.isArray(used) ? used : []);
	if (!taken.has(base)) return base;
	for (let i = 2; i < 100; i += 1) {
		const suffix = "-" + i;
		const next = base.slice(0, 32 - suffix.length) + suffix;
		if (!taken.has(next)) return next;
	}
	return base.slice(0, 28) + "-" + Date.now().toString(36).slice(-3);
}

/** runtimeArguments → argv（只支持 positional / named；带必填变量的拒绝自动装）。 */
function runtimeArgsOf(pkg) {
	const out = [];
	const missing = [];
	for (const arg of Array.isArray(pkg && pkg.runtimeArguments) ? pkg.runtimeArguments : []) {
		if (!arg || typeof arg !== "object") continue;
		if (arg.variables && typeof arg.variables === "object") {
			const required = Object.entries(arg.variables).filter(([, value]) => value && value.isRequired);
			if (required.length > 0) {
				missing.push(arg.name || arg.type || "argument");
				continue;
			}
			continue;
		}
		const value = arg.value === undefined || arg.value === null ? "" : String(arg.value);
		if (arg.type === "named") {
			if (arg.name) out.push(String(arg.name));
			if (value) out.push(value);
		} else if (value) out.push(value);
	}
	return { args: out, missing };
}

function indentBlock(lines, spaces) {
	const pad = " ".repeat(spaces);
	return lines.map((line) => (line ? pad + line : line));
}

function yamlString(value) {
	const text = String(value ?? "");
	return "'" + text.replace(/'/g, "''") + "'";
}

/** 生成一段能直接追加的组合条目（含注释；`!!js` 只出现在「需要你自己填」的片段里）。 */
export function buildMcpBlock(entry) {
	const lines = [];
	lines.push("# ── MCP：" + (entry.registryName || entry.serverName) + "（dsh-plugin-installer " + (entry.addedAt || nowIso()) + "）──");
	lines.push("- id: " + entry.id);
	lines.push("  name: '" + MCP_CLIENT_PACKAGE + "'");
	lines.push("  config:");
	lines.push("    serverName: " + entry.serverName);
	lines.push("    transport: " + entry.transport);
	if (entry.transport === "stdio") {
		lines.push("    command: " + yamlString(entry.command));
		if (entry.args && entry.args.length > 0) {
			lines.push("    args:");
			for (const arg of entry.args) lines.push("      - " + yamlString(arg));
		}
	} else {
		lines.push("    url: " + yamlString(entry.url));
	}
	return lines.join("\n");
}

/**
 * 把一段条目追加到组合文本。纯函数：不写盘。
 * @returns {{ok:boolean, text?:string, reason?:string}}
 */
export function appendMcpEntryText(text, entry) {
	const source = String(text ?? "");
	const block = buildMcpBlock(entry);
	if (source.trim() === "" || /^\s*\[\s*\]\s*$/.test(source.trim())) {
		return { ok: true, text: block + "\n" };
	}
	const trailing = source.endsWith("\n") ? source : source + "\n";
	const sep = trailing.endsWith("\n\n") ? "" : "\n";
	return { ok: true, text: trailing + sep + block + "\n" };
}

/** 选一台服务器怎么装；返回的配置只由 registry 数据决定。 */
export function chooseMcpInstall(server, serverName) {
	const name = String((server && server.name) || "");
	const packages = Array.isArray(server && server.packages) ? server.packages : [];
	const remotes = Array.isArray(server && server.remotes) ? server.remotes : [];
	const npm = packages.find((pkg) => pkg && pkg.registryType === "npm");
	const pypi = packages.find((pkg) => pkg && pkg.registryType === "pypi");
	const pkg = npm || pypi;
	if (pkg) {
		const type = pkg.registryType;
		const runtime = runtimeArgsOf(pkg);
		const hint = String(pkg.runtimeHint || "");
		if (type === "npm" && !/^(npx|bunx|pnpm)$/.test(hint || "npx")) {
			return { ok: false, reason: "这个 npm 包声明了不认识的运行时：" + (hint || "?") };
		}
		if (type === "pypi" && hint && !/^(uvx|uv)$/.test(hint)) {
			return { ok: false, reason: "这个 PyPI 包声明了不认识的运行时：" + hint };
		}
		const command = hint || (type === "npm" ? "npx" : "uvx");
		const args = [...runtime.args, String(pkg.identifier || "")].filter(Boolean);
		if (!args.length) return { ok: false, reason: "registry 没给包名" };
		if (!hint && type === "npm") args.unshift("-y");
		const requiredEnv = (Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : [])
			.filter((env) => env && env.isRequired)
			.map((env) => String(env.name || ""))
			.filter(Boolean);
		const transport = (pkg.transport && pkg.transport.type) || "stdio";
		if (transport !== "stdio") {
			return { ok: false, reason: "registry 把这个包标成 " + transport + "：面板只自动装 stdio 包或 streamable-http 远程" };
		}
		if (runtime.missing.length > 0) {
			return {
				ok: false,
				reason: "启动参数需要你先填：" + runtime.missing.join("、"),
				transport,
				command,
				args
			};
		}
		const installPath = [command, ...args].join(" ");
		return {
			ok: requiredEnv.length === 0,
			reason: requiredEnv.length ? "需要先设置环境变量：" + requiredEnv.join("、") : "",
			transport,
			command,
			args,
			requiredEnv,
			requiredHeaders: [],
			installPath,
			configYaml: blockForCandidate({ name, serverName, transport, command, args, requiredEnv })
		};
	}
	const remote = remotes.find((item) => item && item.type === "streamable-http") || remotes[0];
	if (!remote) return { ok: false, reason: "registry 里没有可用的包或远程端点" };
	if (remote.type !== "streamable-http") {
		return { ok: false, reason: "远程端点是 " + (remote.type || "?") + "，面板只支持 streamable-http" };
	}
	if (!remote.url) return { ok: false, reason: "远程端点缺 url" };
	const requiredHeaders = (Array.isArray(remote.headers) ? remote.headers : [])
		.filter((header) => header && header.isRequired)
		.map((header) => String(header.name || ""))
		.filter(Boolean);
	return {
		ok: requiredHeaders.length === 0,
		reason: requiredHeaders.length ? "需要先设置请求头：" + requiredHeaders.join("、") : "",
		transport: "streamable-http",
		url: String(remote.url),
		requiredEnv: [],
		requiredHeaders,
		installPath: String(remote.url),
		configYaml: blockForCandidate({ name, serverName, transport: "streamable-http", url: String(remote.url), requiredHeaders })
	};
}

function blockForCandidate(input) {
	const lines = [
		"- id: mcp-" + input.serverName,
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    serverName: " + input.serverName,
		"    transport: " + input.transport,
	];
	if (input.transport === "stdio") {
		lines.push("    command: " + yamlString(input.command || "npx"));
		lines.push("    args:");
		for (const arg of input.args || []) lines.push("      - " + yamlString(arg));
	} else {
		lines.push("    url: " + yamlString(input.url || ""));
	}
	const envKeys = Array.isArray(input.requiredEnv) ? input.requiredEnv : [];
	const headerKeys = Array.isArray(input.requiredHeaders) ? input.requiredHeaders : [];
	if (envKeys.length > 0) {
		lines.push("    # 这些值不会自动填：把下面换成你的值，或用 !!js 读环境变量。");
		lines.push("    env:");
		for (const key of envKeys) lines.push("      " + key + ": '<required>'");
	}
	if (headerKeys.length > 0) {
		lines.push("    # 这些值不会自动填：把下面换成你的值，或用 !!js 读环境变量。");
		lines.push("    headers:");
		for (const key of headerKeys) lines.push("      " + key + ": '<required>'");
	}
	return lines.join("\n");
}

/** 一台 registry 服务器 → 面板/AI 能用的候选。 */
export function candidateFromServer(server, used = new Set()) {
	const registryName = String((server && server.name) || "").trim();
	const serverName = deriveServerName(registryName, used);
	const chosen = chooseMcpInstall(server, serverName);
	const requiredEnv = Array.isArray(chosen.requiredEnv) ? chosen.requiredEnv : [];
	const requiredHeaders = Array.isArray(chosen.requiredHeaders) ? chosen.requiredHeaders : [];
	const repository = (server && server.repository && server.repository.url) || (server && server.websiteUrl) || "";
	const flags = [];
	if (!chosen.ok) flags.push({ id: "needs-config", tone: "warn", text: chosen.reason });
	if (!repository) flags.push({ id: "no-repo", tone: "warn", text: "registry 没给仓库地址：装之前没法自己审" });
	return {
		kind: "mcp",
		source: "mcp-registry",
		sourceLabel: "官方 MCP Registry",
		registryName,
		name: registryName,
		displayName: registryName.split("/").pop() || registryName,
		version: String((server && server.version) || ""),
		description: String((server && server.description) || ""),
		url: repository,
		spec: "mcp:" + registryName + ((server && server.version) ? "@" + server.version : ""),
		serverName,
		transport: chosen.transport || "stdio",
		command: chosen.command || "",
		args: Array.isArray(chosen.args) ? chosen.args : [],
		remoteUrl: chosen.url || "",
		installPath: chosen.installPath || chosen.url || "",
		requiredEnv,
		requiredHeaders,
		installable: Boolean(chosen.ok && registryName),
		blockedReason: chosen.ok ? "" : chosen.reason || "registry 没给可自动安装的配置",
		configYaml: chosen.configYaml || "",
		trust: {
			level: "registry",
			badges: [
				{ id: "mcp-registry", label: "官方 MCP Registry", tone: "ok", why: "来自 registry.modelcontextprotocol.io" },
				...(repository ? [{ id: "repo", label: "有源码", tone: "ok", why: "给了仓库地址" }] : [])
			],
			flags
		},
		popularity: null,
		rankScore: 58
	};
}

async function fetchRegistry(params) {
	const url = REGISTRY_BASE + "?" + params.toString();
	const data = await fetchJson(url, { timeoutMs: 12000, headers: { accept: "application/json" } });
	return Array.isArray(data && data.servers) ? data.servers : [];
}

const searchCache = new Map();

/** 官方 MCP Registry 搜索（5 分钟缓存；失败不缓存）。 */
export async function searchMcpRegistry(query, options = {}) {
	const q = String(query || "").trim();
	if (!q) return { items: [], error: null };
	const limit = Math.max(1, Math.min(20, options.limit || 4));
	const key = q.toLowerCase() + "|" + limit;
	const hit = searchCache.get(key);
	if (!options.fresh && hit && Date.now() - hit.at < SEARCH_TTL_MS) return { ...hit.value, cached: true };
	try {
		const params = new URLSearchParams({ search: q, limit: String(Math.min(20, limit * 3)) });
		const rows = await fetchRegistry(params);
		const byName = new Map();
		for (const row of rows) {
			const server = row && row.server;
			if (!server || !server.name) continue;
			const prev = byName.get(server.name);
			let newer = !prev;
			if (prev) {
				try {
					newer = compareVersions(server.version || "", prev.version || "") > 0;
				} catch {
					/* 非 semver 的版本号：保留先出现的那条，不让一条脏数据把整个搜索打挂 */
					newer = false;
				}
			}
			if (newer) byName.set(server.name, server);
		}
		const used = new Set();
		const items = [];
		for (const server of [...byName.values()].slice(0, limit)) {
			const candidate = candidateFromServer(server, used);
			if (candidate.serverName) used.add(candidate.serverName);
			items.push(candidate);
		}
		const value = { items, error: null };
		searchCache.set(key, { at: Date.now(), value });
		return { ...value, cached: false };
	} catch (e) {
		return { items: [], error: String((e && e.message) || e) || "MCP Registry 不可达" };
	}
}

/** 按「名字 [@版本]」重新查 Registry（写入前唯一可信的来源）。 */
export async function resolveMcpCandidate(input) {
	let spec = String(input || "").trim().replace(/^mcp:/i, "");
	if (!spec) return { ok: false, reason: "缺 MCP 名字" };
	let version = "";
	const at = spec.lastIndexOf("@");
	if (at > 0) {
		const maybe = spec.slice(at + 1);
		if (/^\d/.test(maybe)) {
			version = maybe;
			spec = spec.slice(0, at);
		}
	}
	const search = await searchMcpRegistry(spec, { limit: 12, fresh: true });
	if (search.error) return { ok: false, reason: "MCP Registry 查不到：" + search.error };
	const rows = [];
	for (const item of search.items) {
		if (String(item.registryName || "").toLowerCase() !== spec.toLowerCase()) continue;
		rows.push(item);
	}
	if (rows.length === 0) return { ok: false, reason: "MCP Registry 里没有叫「" + spec + "」的服务器（名字要逐字对上）" };
	let chosen = rows[0];
	if (version) {
		const exact = rows.find((item) => item.version === version);
		if (!exact) return { ok: false, reason: "「" + spec + "」没有版本 " + version + "（registry 上是 " + rows.map((r) => r.version).join(" / ") + "）" };
		chosen = exact;
	}
	if (!chosen.installable) return { ok: false, reason: chosen.blockedReason || "这台服务器不能自动装（缺参数/环境变量）", candidate: chosen };
	return { ok: true, candidate: chosen };
}

/**
 * R36：从 stdio 命令里找一个 npm 包名（可带锁定版本）。
 *
 * `npx -y @scope/pkg` → `{name:"@scope/pkg", version:null}`（每次启动取最新，没有可比的版本）
 * `npx -y @scope/pkg@1.2.3` → `{name:"@scope/pkg", version:"1.2.3"}`（能比）
 * 路径 / URL / 纯参数一律跳过 —— 别把 `D:/x.js` 当成包名。
 */
export function parseNpmSpecFromArgs(command, args) {
	const cmd = String(command || "").trim().toLowerCase();
	if (!/^(npx|bunx|pnpm|yarn)$/.test(cmd)) return null;
	const list = Array.isArray(args) ? args : [];
	for (const raw of list) {
		const text = String(raw || "").trim();
		if (!text || text.startsWith("-")) continue;
		if (/^(dlx|exec)$/i.test(text)) continue;
		if (/^[./\\]/.test(text) || /^[a-z]+:/i.test(text)) continue;
		const at = text.lastIndexOf("@");
		let name = text;
		let version = null;
		if (at > 0) {
			const maybe = text.slice(at + 1);
			if (/^\d/.test(maybe)) {
				name = text.slice(0, at);
				version = maybe;
			}
		}
		if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) continue;
		return { name, version };
	}
	return null;
}

/** 读 MCP 来源台账；不存在 / 坏 JSON 一律当空台账（不抛）。 */
export async function readMcpLedger(file) {
	if (!file) return { version: 1, items: {} };
	try {
		const data = JSON.parse(await readFile(file, "utf8"));
		if (data && typeof data === "object" && data.items && typeof data.items === "object") {
			return { version: 1, items: { ...data.items } };
		}
	} catch {
		/* 读不到 / 坏文件 → 空台账 */
	}
	return { version: 1, items: {} };
}

/** 记一笔 MCP 来源（原子写；同一 serverName 覆盖旧记录）。 */
export async function recordMcpSource(file, entry) {
	if (!file || !entry || !entry.serverName) return { ok: false, reason: "缺 serverName / ledger 路径" };
	const current = await readMcpLedger(file);
	const items = { ...current.items, [entry.serverName]: { ...entry, at: entry.at || nowIso() } };
	await mkdir(dirname(file), { recursive: true });
	const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
	await writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2) + "\n", "utf8");
	await rename(tmp, file);
	return { ok: true, file, item: items[entry.serverName] };
}

/**
 * R36：MCP 更新检查。
 *
 * 三条来源，按可信度从高到低：
 *   ① **来源台账**（面板装的那台）：`registryName + version` 都在，查官方 Registry 的最新版；
 *   ② **锁了版本的 npx 包**：`@scope/pkg@1.2.3` 这种，查 npm latest；
 *   ③ 其余（`npx` 未锁版本 / 远程 URL / 手工条目）→ `unknown`，并写明为什么无法判断。
 *
 * `fetchRegistry` / `npmLatestFn` 可注入，测试不联网。
 */
export async function checkMcpUpdates({ items, ledger, fetchRegistry = searchMcpRegistry, npmLatestFn = npmLatest, at = nowIso() } = {}) {
	const list = Array.isArray(items) ? items : [];
	const byName = ledger && ledger.items ? ledger.items : {};
	const entries = [];
	for (const item of list) {
		const base = {
			serverName: item.serverName || item.id || "",
			transport: item.transport || "",
			disabled: Boolean(item.disabled),
			running: Boolean(item.running)
		};
		const source = base.serverName ? byName[base.serverName] : null;
		if (source && source.registryName) {
			if (!source.version) {
				entries.push({ ...base, kind: "registry", relation: "unknown", localVersion: null, latestVersion: null, reason: "台账里没记版本（当时没有可比对）" });
				continue;
			}
			try {
				const result = await fetchRegistry(source.registryName, { limit: 12, fresh: true });
				if (result && result.error) throw new Error(result.error);
				const exact = (result && result.items ? result.items : []).find((candidate) => candidate.registryName === source.registryName);
				if (!exact) throw new Error("Registry 里找不到 " + source.registryName);
				const relation = relationOf(source.version, exact.version);
				entries.push({
					...base,
					kind: "registry",
					registryName: source.registryName,
					localVersion: source.version,
					latestVersion: exact.version,
					relation,
					gap: relation === "outdated" ? versionGap(source.version, exact.version) : null,
					error: null
				});
			} catch (e) {
				entries.push({ ...base, kind: "registry", registryName: source.registryName, localVersion: source.version, latestVersion: null, relation: "unknown", error: String((e && e.message) || e).slice(0, 160) });
			}
			continue;
		}
		const npm = parseNpmSpecFromArgs(item.command, item.args);
		if (npm && npm.version) {
			try {
				const latest = await npmLatestFn(npm.name);
				if (latest && latest.missing) throw new Error("npm 上没有这个包");
				const relation = relationOf(npm.version, latest && latest.version);
				entries.push({
					...base,
					kind: "npm",
					registryName: npm.name,
					localVersion: npm.version,
					latestVersion: latest && latest.version,
					relation,
					gap: relation === "outdated" ? versionGap(npm.version, latest && latest.version) : null,
					deprecated: (latest && latest.deprecated) || null,
					error: null
				});
			} catch (e) {
				entries.push({ ...base, kind: "npm", registryName: npm.name, localVersion: npm.version, latestVersion: null, relation: "unknown", error: String((e && e.message) || e).slice(0, 160) });
			}
			continue;
		}
		if (npm && !npm.version) {
			entries.push({ ...base, kind: "npm", registryName: npm.name, relation: "unknown", localVersion: null, latestVersion: null, reason: "npx 未锁版本，每次启动都会取最新 —— 没有可比的本地版本" });
			continue;
		}
		entries.push({
			...base,
			kind: item.transport === "streamable-http" ? "remote" : "unknown",
			relation: "unknown",
			localVersion: null,
			latestVersion: null,
			reason: item.transport === "streamable-http" ? "远程端点没有版本号，无法与本地配置比对" : "不是 npm 包、也没有来源台账，无法判断新版本"
		});
	}
	entries.sort((a, b) => {
		const rank = (u) => (u.relation === "outdated" ? 0 : u.error ? 2 : u.relation === "current" ? 1 : 3);
		const d = rank(a) - rank(b);
		return d !== 0 ? d : (a.serverName < b.serverName ? -1 : a.serverName > b.serverName ? 1 : 0);
	});
	const summary = {
		checked: entries.length,
		outdated: entries.filter((e) => e.relation === "outdated").length,
		current: entries.filter((e) => e.relation === "current").length,
		ahead: entries.filter((e) => e.relation === "ahead").length,
		undetectable: entries.filter((e) => !e.error && e.relation === "unknown").length,
		failed: entries.filter((e) => e.error).length,
		at
	};
	return { ok: true, at, items: entries, summary };
}

/**
 * 把一台 MCP 服务器写进 profile 的 `cordis.patch.yml`。
 *
 * 五条纪律：
 *   ① 只接受**已经由服务端从 Registry 重新解析**过的候选（command/args/url 不来自客户端）；
 *   ② 写前备份到本插件 data 目录；写用 tmp + rename；
 *   ③ 写前检查 id / serverName 冲突；
 *   ④ 写后**重新解析整份文件**，确认条目在、serverName 唯一；
 *   ⑤ 任何一步失败都把原文放回去（不留半个文件）。
 */
export async function addMcpToProfile({ profileDir, backupDir, candidate, ledgerPath, now } = {}) {
	if (!profileDir) return { ok: false, reason: "读不到 profile 目录（DSH_PROFILE_DIR 未设置）" };
	if (!candidate || !candidate.serverName || !candidate.transport) return { ok: false, reason: "候选缺 serverName / transport" };
	if (!SERVER_NAME_RE.test(candidate.serverName)) return { ok: false, reason: "serverName 不合法：" + candidate.serverName };
	if (!MCP_TRANSPORTS.includes(candidate.transport)) return { ok: false, reason: "不支持的 transport：" + candidate.transport };
	if (!candidate.installable) return { ok: false, reason: candidate.blockedReason || "这台服务器不能自动装（缺参数/环境变量）" };
	const file = join(profileDir, "cordis.patch.yml");
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		if (!e || e.code !== "ENOENT") return { ok: false, reason: "读不到组合文件：" + String((e && e.message) || e) };
		text = "# Your patch layer for this dsh profile, applied after every bundle layer.\n";
	}
	const before = parseCompositionEntries(text, { file });
	for (const entry of before) {
		if (entry.id === "mcp-" + candidate.serverName) return { ok: false, reason: "组合文件里已经有 id=mcp-" + candidate.serverName + "（" + file + ":" + entry.line + "）" };
		if (entry.name === MCP_CLIENT_PACKAGE && entry.config && entry.config.serverName === candidate.serverName) {
			return { ok: false, reason: "已经配过 serverName=" + candidate.serverName + "（" + file + ":" + entry.line + "）" };
		}
	}
	const entry = {
		id: "mcp-" + candidate.serverName,
		serverName: candidate.serverName,
		registryName: candidate.registryName || candidate.name || "",
		transport: candidate.transport,
		command: candidate.command || "",
		args: candidate.args || [],
		url: candidate.remoteUrl || candidate.url || "",
		addedAt: now || nowIso()
	};
	if (entry.transport === "stdio" && !entry.command) return { ok: false, reason: "stdio 缺 command" };
	if (entry.transport === "streamable-http" && !entry.url) return { ok: false, reason: "streamable-http 缺 url" };
	/* registry 的字段是外部数据：带换行的命令/参数会写坏 YAML（单引号标量会把换行折叠成空格） */
	const weird = [entry.command, entry.url, ...entry.args].find((value) => /[\r\n]/.test(String(value || "")));
	if (weird) return { ok: false, reason: "registry 给的命令/参数里有换行，拒绝写入：" + JSON.stringify(String(weird).slice(0, 80)) };
	const appended = appendMcpEntryText(text, entry);
	if (!appended.ok) return appended;
	const stamp = (now || nowIso()).replace(/[:.]/g, "-").slice(0, 19);
	const backup = backupDir ? join(backupDir, "cordis.patch.yml." + stamp + ".bak") : null;
	if (backup) {
		try {
			await mkdir(backupDir, { recursive: true });
			await copyFile(file, backup).catch(async (e) => {
				if (e && e.code === "ENOENT") await writeFile(backup, "", "utf8");
				else throw e;
			});
		} catch (e) {
			return { ok: false, reason: "备份失败（不敢改）：" + String((e && e.message) || e) };
		}
	}
	const tmp = file + ".dpi-mcp-" + process.pid + "-" + Date.now();
	try {
		await writeFile(tmp, appended.text, "utf8");
		await rename(tmp, file);
	} catch (e) {
		try {
			const { rm } = await import("node:fs/promises");
			await rm(tmp, { force: true });
		} catch {
			/* ignore */
		}
		return { ok: false, reason: "写入失败（原文未动）：" + String((e && e.message) || e) };
	}
	/* 写后复核：整份重新解析 */
	let after = [];
	try {
		after = parseCompositionEntries(await readFile(file, "utf8"), { file });
	} catch (e) {
		after = [];
	}
	const mine = after.find((item) => item.id === entry.id && item.name === MCP_CLIENT_PACKAGE);
	const sameName = after.filter((item) => item.name === MCP_CLIENT_PACKAGE && item.config && item.config.serverName === entry.serverName);
	if (!mine || sameName.length !== 1) {
		if (backup) await copyFile(backup, file).catch(() => {});
		return { ok: false, reason: "写后复核不通过（已尝试还原）：" + (!mine ? "找不到新条目" : "serverName 重了 " + sameName.length + " 次") };
	}
	const installPath = candidate.installPath || (entry.transport === "stdio" ? [entry.command, ...entry.args].join(" ") : entry.url);
	/* 来源台账：给「检查更新」留一条可比对的 registryName + version（写失败不影响已落地的配置） */
	let ledger = null;
	if (ledgerPath && (candidate.registryName || candidate.name)) {
		ledger = await recordMcpSource(ledgerPath, {
			serverName: entry.serverName,
			registryName: candidate.registryName || candidate.name,
			version: candidate.version || null,
			transport: entry.transport,
			installPath,
			at: now || nowIso()
		}).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
	}
	return {
		ok: true,
		added: {
			id: entry.id,
			serverName: entry.serverName,
			transport: entry.transport,
			installPath,
			file,
			line: mine.line
		},
		file,
		line: mine.line,
		backup,
		ledger,
		restartRequired: true,
		note: "已写入组合文件；要重启 DSH 才会加载这台 MCP（patch 层不热更）"
	};
}
