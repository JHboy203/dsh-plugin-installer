/**
 * profilehealth.js — profile 层面的「装完会不会起不来」体检与修复。
 *
 * 与 repair.js 的分工：
 *   - `repair.js` 管**安装环境**（dsh-tools 覆盖、悬空 file: 依赖、vendor、trustPolicy、git）；
 *   - 本文件管**profile 配置与已装插件**（bundles 与实物是否对得上、已装插件是否满足 0.2.1 的
 *     工具注册契约、pnpm 版本钉子是否随宿主升级过期、最近一次崩溃日志说了什么）。
 *
 * 为什么要并进「插件安装」面板：2026-10-18 的现场是——装完/升级完，桌面端起不来，
 * 真正的元凶（两个自写插件漏声明 `output`）只写在 **恢复对话框点第三键之后**才落盘的
 * crash 日志里；而恢复按钮又会把 `dsh.profile.bundles` 裁到 2 项，于是看起来像"插件全废了"。
 * 这三件事现在一次体检就能说清，`apply:true` 还能把可修的两项修掉。
 *
 * @module dsh-plugin-installer/profilehealth
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanToolContract, describeContractScan } from "./contract.js";
import { activationFindings, scanActivation, summarizeActivation } from "./activation.js";
import { classifyBundle, findBundleRev, parseBundleRevs, resolveClientArtifact } from "./clientrev.js";
import { evaluateCompat } from "./compat.js";
import { exemptionKey, readExemptions, summarizeExemptions } from "./exemptions.js";
import { classifyDepSpec } from "./inventory.js";
import { JOURNAL_NAME, attributionFinding, driftFinding, inspectPnpmState, readAttribution, readJournal } from "./profilestate.js";

/** 崩溃日志默认位置（桌面端把启动失败写在这里）。 */
const DEFAULT_CRASH_DIR = process.env.APPDATA
	? join(process.env.APPDATA, "@deepseek-ai", "dsh-desktop", "logs")
	: null;

/** 只保留最近这么久的崩溃日志当"新问题"报（更老的只写一行 info）。 */
const CRASH_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * 崩溃日志有两类，桌面端分开写：
 *   - `crash-*-host.log`：宿主启动失败（起不来 / 弹恢复对话框）；
 *   - `crash-*-web-boot.log`：宿主起来了，但 web 界面的入口没激活（面板缺块）。
 * 两类都得看 —— 2026-10-23 的现场就是：最新的三份全是 web-boot，而这里只认 host，
 * 于是体检报的是 5.6 小时前那次，最近一次（8 分钟前）完全没被看见。
 */
const CRASH_KINDS = [
	{ kind: "host", re: /^crash-.*-host\.log$/ },
	{ kind: "web-boot", re: /^crash-.*-web-boot\.log$/ }
];

/**
 * 已知签名：日志原文里能认出的一句话 → 「是什么 / 怎么办」。
 * 只收本机真踩过、且原文可判定的；认不出的走通用兜底，不硬猜。
 * 为什么要这张表：host 崩溃最常见的那类（登录态 cookie）**不点名任何插件**，
 * 旧文案却无条件写「日志点名了这些插件」，把人往删插件上带。
 */
const CRASH_SIGNATURES = [
	{
		re: /desktop welcome: web authentication failed/i,
		kind: "host",
		name: "登录态 cookie 堆积（dsh-auth-*）",
		plain: "大白话：DSH 启动时判定桌面欢迎页的登录态失效了。本机踩过：Electron 的 cookie 罐里堆了太多过期的 dsh-auth-*，攒多了就会这样 —— 不是插件坏了。",
		fix: [
			{ text: "完全退出 DSH（含托盘）再启动一次；能进就别动插件" },
			{ text: "还不行再跑 dsh_boot_guard({ apply:true }) 清 dsh-auth-* cookie（写前备份，要求 DSH 已退出）" },
			{ text: "不要用恢复对话框的「禁用第三方插件」—— 它会把 bundles 裁到 2 项，看起来像插件全没了" }
		]
	},
	{
		re: /does not provide an export named 'CallId'/i,
		kind: "host",
		name: "陈旧 @deepseek-ai/dsh-tools 覆盖",
		plain: "大白话：profile 里混进了旧版 dsh-tools，插件按就近解析命中它，而宿主核心只导出 ToolCallId —— 于是这批插件一起加载失败。",
		fix: [
			{ text: "doctor 的 apply 会把它挪进备份；也可手动确认 node_modules/@deepseek-ai/ 下没有 dsh-tools" },
			{ text: "装本地插件用 node .tools/dsh-plugin-install.cjs，别跑 pnpm（pnpm 会再埋一份）" }
		]
	},
	{
		re: /must declare output/i,
		kind: "host",
		name: "插件工具漏声明 output",
		plain: "大白话：某个插件的工具定义少了宿主 0.2.1 起必需的 output { schema, render }，注册时抛错，整次启动被它拖住。",
		fix: [{ text: "按上面点名的插件补 output，或先从 bundles 摘掉它" }]
	},
	{
		re: /Cannot read propert(?:y|ies) of undefined \(reading 'prepare'\)/i,
		kind: "host",
		name: "插件在服务就绪前访问 host（'prepare'）",
		plain: "大白话：某个插件在宿主服务还没准备好时就去用了它 —— 启动时直接报 reading 'prepare'，DSH 可能起不来、或那个插件失活。",
		fix: [
			{ text: "先禁用最近装/更新过的插件（面板「已装插件」或 profile 的 bundles），重启验证" },
			{ text: "确认是哪个插件后报给作者：apply 里要用 ctx.get(...) 取服务并判空，不能直接调用" }
		]
	},
	{
		re: /value is not lossless JSON/i,
		kind: "host",
		name: "工具返回值不是无损 JSON",
		plain: "大白话：某个插件工具返回了 undefined / 函数 / 循环引用这类 JSON 表达不了的值，宿主拒收 —— 不是数据坏了，是返回值不合法。",
		fix: [
			{ text: "看日志里点名的是哪个工具，禁用对应插件或让作者改成返回纯数据" },
			{ text: "临时绕过：面板「已装插件」里停掉该插件，重启" }
		]
	}
];

/** web-boot 失败里认不出具体包时的通用处置。
 *  R24 改写：原来的「在面板「已装插件」里重装」是个**假按钮** —— 那张清单只在
 *  「有新版」时才给按钮，同版本重装改不了那份字节（R19 的判据：处置必须落到真能做的事上）。 */
const WEB_BOOT_FIX = [
	{ text: "换掉那份 client 包：npm 来源要**升级到新版**（真有新版时，发现卡上会出现「检查更新并升级」按钮）；本机目录（link:）来源要回那个目录重新构建 client.js —— client 包损坏是这类失败最常见的原因" },
	{ text: "只想先恢复界面：在 profile 的 bundles 里禁用该插件，重启后其它面板照常" },
	{ text: "看真实报错：日志里「renderer console」那一段的第一条错误（或开发者工具 Console）" }
];

/** web-boot 失败里针对「客户端包加载失败」的处置。 */
const WEB_BOOT_BUNDLE_FIX = [
	{ text: "换掉这个插件的 client 包：npm 来源升级到新版（同版本重装不会改变字节）；本机目录（link:）来源重新构建它的 client.js（构建产物缺失/损坏就是这类失败）" },
	{ text: "日志里写着 skipped after an earlier failure 的那几条不是独立故障，修第一个 import failed 的包就行" },
	{ text: "只想先恢复界面：在 profile 的 bundles 里禁用该插件，重启后其它面板照常" }
];

function round1(n) {
	return Math.round(Number(n || 0) * 10) / 10;
}

/**
 * 本进程的启动时刻。用来判断一份崩溃日志到底是「这次启动」的还是「上一次启动」留下的 ——
 * 2026-10-23 的现场：19:03 有一份 web-boot 失败日志，21:02 重启却没再产生新日志，
 * 面板却仍把它当 error 指挥人「重装 dsh-web-research」。重装一个已经正常的插件是无用功，
 * 所以判据要带上「之后有没有再失败」。
 */
const PROCESS_STARTED_AT = Date.now() - Math.round((typeof process !== "undefined" && typeof process.uptime === "function" ? process.uptime() : 0) * 1000);

/** 本地 HH:MM:SS（日志里只要时刻）。 */
function clockOf(ms) {
	const d = new Date(Number(ms) || Date.now());
	const pad = (n) => String(n).padStart(2, "0");
	return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

/** 「今天只要时刻，其它日子带上月日」—— 崩溃日志可能躺了几天，光写 13:23 会让人以为是今天。 */
function momentOf(ms) {
	const t = Number(ms) || 0;
	if (!t) return "时间未知";
	const d = new Date(t);
	const now = new Date();
	const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
	const pad = (n) => String(n).padStart(2, "0");
	return sameDay ? clockOf(t) : pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + clockOf(t);
}

/**
 * 「日志里失败的那份 client 包，现在还在不在」翻成一句人话（R24）。
 *
 * 为什么不能只说「可能已自愈」：宿主的 rev 是**确定性**的（mtime/ctime/size 的哈希），
 * 日志又把出错的 rev 抄了下来，两边一比就能分三种情况，处置完全不同：
 *   · 同一份字节 → 重启不改任何东西，必须真修（升级/重建）；
 *   · 字节已经变了 → 那份已经不在磁盘上，重启一次就能用上；
 *   · 日志没抄 rev → 只能说「失败之后有没有改过」，不许断言好坏。
 */
function describeBundleState(verdict, current) {
	const v = verdict || {};
	if (v.state === "same") {
		return "日志里那份还在（rev " + v.rev + "，" + momentOf(v.artifactAt) + " 那份）—— 重启会再遇到同一个错误";
	}
	if (v.state === "rebuilt") {
		return "日志里那份已经不在了：rev " + v.loggedRev + " → 现在 " + v.rev + "（" + momentOf(v.artifactAt) + " 重建/覆盖）";
	}
	const why = current && current.ok === false
		? "读不到现在的 client 包（" + (current.note || current.reason || "原因不明") + "）"
		: null;
	if (why) return why;
	if (v.movedAfterLog) {
		return "日志没抄它的 rev；但这份包在失败之后又构建过（" + momentOf(v.artifactAt) + "），已经不是当时那份";
	}
	return "日志没抄它的 rev（import failed 那类只写进渲染进程 console）；这份包自 " + momentOf(v.artifactAt) + " 之后没再改过 —— 只能说这次启动没再失败";
}

/**
 * 点名插件的来源（link: / file: / git / npm），把处置写成「这一步」而不是「你去重装吧」。
 * 2026-10-24 现场：`dsh-web-research` 是 `link:` 的本机目录，面板「已装插件」里根本没有
 * 「升级/重装」入口 —— 泛泛说「重装点名的插件」等于让用户找一个不存在的按钮。
 * 判据复用 inventory.classifyDepSpec（同一份正则，不在这里再写一套）。
 *
 * @returns {{kind:string, spec:string, text:string}|null}
 */
function describePluginSource(manifest, plugin) {
	const deps = (manifest && manifest.dependencies) || {};
	const spec = String(deps[plugin] || "");
	if (!spec) return null;
	const kind = classifyDepSpec(spec, plugin);
	let text = null;
	if (kind.kind === "link") {
		const dir = spec.slice("link:".length);
		text = plugin + " 来自本机目录 " + dir + "（link:）—— 面板没有能替你重建的动作；去那个目录重新构建 client.js（先看它的 package.json scripts），再刷新界面";
	} else if (kind.kind === "tarball") {
		text = plugin + " 是本面板装进来的 .tgz（" + spec + "）—— 重新提交一份新包，或先回滚到安装前的快照";
	} else if (kind.kind === "git") {
		text = plugin + " 来自 Git 仓库（" + spec + "）—— 重新提交同一个仓库会拉最新提交；若宿主回 already-installed，先回滚到安装前再装";
	} else if (kind.kind === "npm") {
		text = plugin + " 来自 npm（" + spec + "）—— 要换掉这份字节得升级到新版（面板「已装插件」里只有「有新版」的项才有升级按钮）；同版本重装不会改变字节";
	} else {
		return null;
	}
	return { kind: kind.kind, spec, text };
}

/** host 日志：`  <插件>` + `  Package: …` + 一行错误。 */
function parseHostFailures(text) {
	const failed = [];
	const lines = String(text || "").split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const head = /^ {2}([a-z0-9@/_.-]+)$/.exec(lines[i]);
		if (head && /^ {2}Package:\s*/.test(lines[i + 1] || "")) {
			const pkg = String(lines[i + 1]).trim().slice("Package:".length).trim();
			const error = String(lines[i + 2] || "").trim();
			if (error && !failed.some((f) => f.plugin === head[1])) failed.push({ plugin: head[1], package: pkg, error });
			i += 2;
		}
	}
	return failed;
}

/** 把 `plugins/??scope/pkg/client.js&rev=abc` 收拾成能看的 `scope/pkg/client.js`。 */
function cleanBundlePath(path) {
	return String(path || "")
		.replace(/^plugins\/\?\?/, "")
		.replace(/&rev=[0-9a-f]+$/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * web-boot 的错误行可能很长：一次链式失败会把几十个 bundle 全列进来。
 * 面板要的是「哪个包没起来」，所以只留可判定的那一段。
 */
function shortenWebBootError(raw) {
	const text = String(raw || "").replace(/\s+/g, " ").trim();
	const bundle = /bundle script ([^\s]+?) failed to load/.exec(text);
	if (bundle) return "client 包加载失败（" + cleanBundlePath(bundle[1]) + "）";
	if (/could not load/i.test(text)) return "client 包加载失败（依赖的 bundle 先失败，这条是被跳过的）";
	if (/see console/i.test(text)) return "import 失败（具体异常只写在渲染进程 console 里）";
	return text.length > 160 ? text.slice(0, 157) + "…" : text;
}

/** web-boot 日志：`插件名: import failed…` 每条一个入口。 */
function parseWebBootEntries(text) {
	const failed = [];
	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.trim();
		const m = /^([a-z0-9][a-z0-9@/_.-]*):\s*(import failed.*)$/i.exec(line);
		if (!m) continue;
		if (failed.some((f) => f.plugin === m[1])) continue;
		failed.push({ plugin: m[1], package: null, error: shortenWebBootError(m[2]) });
	}
	return failed;
}

/** renderer console 段里真正的 JS 异常（`import failed` 那种复述不算）。 */
function rendererExceptions(text) {
	const source = String(text || "");
	const idx = source.indexOf("--- renderer console");
	if (idx < 0) return [];
	const out = [];
	for (const raw of source.slice(idx).split(/\r?\n/)) {
		const line = raw.trim();
		if (!/(ReferenceError|TypeError|SyntaxError|RangeError|Cannot read|is not defined)/.test(line)) continue;
		const clean = line.replace(/^dsh-app:\/\/\S+?:\d+\s+/, "").trim();
		if (!clean || out.includes(clean)) continue;
		out.push(clean.length > 240 ? clean.slice(0, 237) + "…" : clean);
		if (out.length >= 3) break;
	}
	return out;
}

function matchCrashSignature(text, kind) {
	for (const sig of CRASH_SIGNATURES) {
		if (kind && sig.kind !== kind) continue;
		if (sig.re.test(String(text || ""))) return sig;
	}
	return null;
}

/** 快照里保留的文件。 */
const PROFILE_FILES = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"];

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function readText(path) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function readJson(path) {
	const text = await readText(path);
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** 从 meta.json 或 package.json 里取 bundles 列表（两种快照形状都认）。 */
function readBundlesOf(meta, pkg) {
	if (meta && Array.isArray(meta.bundles)) return meta.bundles;
	const list = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
	return Array.isArray(list) ? list : [];
}

/** 时间戳目录名（本地时间，秒级）。 */
function stamplike() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/** node_modules 里某个包的目录。 */
function packageDir(profileDir, name) {
	return join(profileDir, "node_modules", ...name.split("/"));
}

/**
 * 这个依赖是不是「可安装的 DSH 插件包」：manifest 里有 `dsh.bundle`（或 `dsh.profile`）。
 * 用于区分 `@dsh-ops/bash-win32-x64` 这类原生 helper。
 */
async function isPluginPackage(profileDir, name) {
	const manifest = await readJson(join(packageDir(profileDir, name), "package.json"));
	if (!manifest) return false;
	return Boolean(manifest.dsh && (manifest.dsh.bundle || manifest.dsh.profile));
}

/**
 * 读最近一次启动失败日志（只读头部，不整份读）。
 *
 * 认两类：`crash-*-host.log`（宿主启动失败）与 `crash-*-web-boot.log`（web 入口没激活），
 * 取**最新那份**；另一类若也在 24h 内，作为 `sibling` 带出来 —— 不能因为新的那份是
 * web-boot，就把几小时前的宿主崩溃吞掉。
 */
export async function readNewestCrash(crashDir) {
	const dir = crashDir === undefined ? DEFAULT_CRASH_DIR : crashDir;
	if (!dir) return null;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const kind = CRASH_KINDS.find((k) => k.re.test(entry.name));
		if (!kind) continue;
		const path = join(dir, entry.name);
		let info;
		try {
			info = await stat(path);
		} catch {
			continue;
		}
		candidates.push({ path, mtimeMs: info.mtimeMs, kind: kind.kind });
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const newest = candidates[0];
	const text = (await readText(newest.path)) || "";
	const now = Date.now();
	const failed = newest.kind === "web-boot" ? parseWebBootEntries(text) : parseHostFailures(text);
	const summaryMatch = newest.kind === "web-boot"
		? /(web boot: [^\n]*)/.exec(text)
		: /(dsh: startup failed:[^\n]*)/.exec(text);
	const appMatch = /^app:\s*(.+)$/m.exec(text);
	const sourceMatch = /^source:\s*(.+)$/m.exec(text);
	const timeMatch = /^time:\s*(.+)$/m.exec(text);
	/* R24：日志头里的 `time:` 是**失败时刻**（比文件 mtime 准：写入可能晚一拍）。
	   web-boot 日志还会把出错 bundle 的 rev 抄下来，用它比「现在磁盘上那份」是不是同一份。 */
	const atMs = timeMatch ? Date.parse(String(timeMatch[1]).trim()) : NaN;
	const signature = matchCrashSignature(text, newest.kind);
	const consoleLines = rendererExceptions(text);
	const sibling = candidates.find((c) => c.kind !== newest.kind && now - c.mtimeMs <= CRASH_FRESH_MS) || null;
	return {
		path: newest.path,
		kind: newest.kind,
		source: sourceMatch ? sourceMatch[1].trim() : null,
		at: new Date(newest.mtimeMs).toISOString(),
		atMs: Number.isFinite(atMs) ? atMs : newest.mtimeMs,
		ageMs: now - newest.mtimeMs,
		app: appMatch ? appMatch[1].trim() : null,
		summary: summaryMatch ? String(summaryMatch[1]).trim() : null,
		failed,
		revs: newest.kind === "web-boot" ? parseBundleRevs(text) : {},
		console: consoleLines,
		signature: signature ? { name: signature.name, plain: signature.plain, fix: signature.fix } : null,
		sibling: sibling ? { kind: sibling.kind, path: sibling.path, ageHours: round1((now - sibling.mtimeMs) / 3600000) } : null
	};
}

/**
 * profile 体检。findings 与 repair.js 同形（code/severity/title/detail/plain/fix[]/fixable），
 * 面板与工具不需要区分来源。
 *
 * @param {{profileDir: string, hostVersion?: string|null, dataDir?: string, crashDir?: string|null, contract?: boolean, processStartedAt?: number}} input
 * @returns {Promise<{at: string, findings: Array<object>, info: object}>}
 */
export async function inspectProfile(input) {
	const { profileDir, hostVersion = null, dataDir = null, crashDir = undefined, processStartedAt = PROCESS_STARTED_AT } = input || {};
	const findings = [];
	const info = {
		profileDir,
		bundles: 0,
		thirdParty: 0,
		disabledDeps: [],
		bundlesTruncated: false,
		contract: null,
		pnpmOverride: null,
		crash: null,
		snapshots: []
	};
	if (!profileDir) {
		info.error = "读不到 profile 目录（宿主 cwd 不是 profile？）";
		return { at: new Date().toISOString(), findings, info };
	}

	const manifest = await readJson(join(profileDir, "package.json"));
	const bundles = Array.isArray(manifest && manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
		? manifest.dsh.profile.bundles.filter((name) => typeof name === "string")
		: [];
	const deps = Object.keys((manifest && manifest.dependencies) || {});
	info.bundles = bundles.length;
	info.deps = deps.length;

	/* ① 装了但没启用的依赖（只报 DSH 插件包，原生 helper 不算） */
	const disabled = [];
	const pluginDeps = [];
	for (const name of deps) {
		if (bundles.includes(name)) continue;
		if (await isPluginPackage(profileDir, name)) disabled.push(name);
	}
	for (const name of deps) {
		if (name.startsWith("@deepseek-ai/")) continue;
		if (await isPluginPackage(profileDir, name)) pluginDeps.push(name);
	}
	info.disabledDeps = disabled;
	info.pluginDeps = pluginDeps.length;
	info.thirdParty = bundles.filter((name) => typeof name === "string" && !name.startsWith("@deepseek-ai/")).length;

	/* ② bundles 被「禁用第三方插件」按钮裁掉了？
	   sanitizeProfile() 会把 bundles 裁到只剩 dsh-base + dsh-web-app。 */
	if (manifest && pluginDeps.length > 0 && bundles.length <= 2) {
		info.bundlesTruncated = true;
		findings.push({
			code: "bundles-truncated",
			severity: "error",
			title: "profile 的 dsh.profile.bundles 只剩 " + bundles.length + " 项，但装了 " + pluginDeps.length + " 个插件",
			detail: "这是恢复对话框「Disable third-party plugins…」的后果：它把 patch 改名成 .bak-<时间戳>，并把 bundles 裁到基础两项。插件文件与 dependencies 都还在，恢复只需写回 bundles 与 patch。",
			plain: "大白话：插件并没有被删掉，只是「清单」被划掉了。把清单写回去、再重启，插件就都回来了。",
			fix: [
				{ text: "点「一键修复」：它会先从最近一次完整快照写回 bundles（写前再存一份当前状态）" },
				{ text: "如果快照里也有 cordis.patch.yml，一并写回 —— 然后在面板里重启 DSH" }
			],
			fixable: true
		});
	}

	/* ③ bundles 里列了、目录却不在 */
	const missing = [];
	for (const name of bundles) {
		if (name.startsWith("@deepseek-ai/")) continue;
		if (!(await exists(packageDir(profileDir, name)))) missing.push(name);
	}
	if (missing.length > 0) {
		findings.push({
			code: "bundle-missing",
			severity: "error",
			title: "bundles 里有 " + missing.length + " 个插件目录不存在",
			detail: missing.join("、") + " —— 宿主会跳过它们（skippedBundles），这些插件等于没装。",
			plain: "大白话：清单上写着这个插件，但文件已经不在了。要么重装它，要么从清单里去掉。",
			fix: [{ text: "在面板里对它们重新安装一次" }, { text: "不再需要的话，用 dsh-plugin-install.cjs uninstall <name> 从清单移除" }],
			fixable: false
		});
	}

	/* ④ 版本兼容：DSH 升级后，声明范围不接受新宿主的插件会被**跳过**（skippedBundles）——
	   它们不会报错，只是安静地消失（工具就没了）。用宿主同一套判据（app-boot 官方评估器）
	   提前点名，并给出三条处置：更新 / 精确版本豁免 / 从清单摘掉。
	   R10 更正：必须把宿主**已有**的豁免记录传进评估器，否则「已经开过豁免的插件」也会被
	   报成「会被跳过」—— 本机实测就是这么误报了三只（browser / billion-context / web-search-pro，
	   三者都在 compatibility.json 里，而且它们的工具当时全都好用）。 */
	const ex = await readExemptions({ profileDir });
	const exSummary = summarizeExemptions(ex.exemptions, hostVersion);
	const incompatible = [];
	const exempted = [];
	for (const name of bundles) {
		if (typeof name !== "string" || name.startsWith("@deepseek-ai/")) continue;
		const dir = packageDir(profileDir, name);
		const manifest = await readJson(join(dir, "package.json"));
		if (!manifest) continue;
		const verdict = await evaluateCompat(manifest, { exemptions: ex.exemptions, runtimeVersion: hostVersion || undefined }).catch(() => null);
		if (verdict && verdict.ok === false) {
			if (verdict.exempted) {
				const key = exemptionKey(manifest.name || name, manifest.version);
				exempted.push({ plugin: name, version: manifest.version || null, exemption: key, runtimes: (ex.exemptions[key] || []).slice() });
			} else {
				incompatible.push({ plugin: name, version: manifest.version || null, requirements: verdict.requirements || null });
			}
		}
	}
	info.incompatible = incompatible;
	info.exempted = exempted;
	info.exemptions = exSummary;
	if (exempted.length > 0) {
		findings.push({
			code: "bundle-incompatible-exempted",
			severity: "info",
			title: exempted.length + " 个插件的版本声明不接受宿主，但已开过精确版本豁免（不会被跳过）",
			detail: exempted.map((entry) => "  · " + entry.plugin + "@" + (entry.version || "?") + " → " + entry.exemption + "（" + entry.runtimes.join(" / ") + "）").join("\n") +
				"\n豁免记录来自 profile 的 " + (ex.path || "compatibility.json") + "。它们照常加载，所以这条只是知情提示。",
			plain: "大白话：这几个插件声明的兼容范围确实不含当前 DSH，但之前已经有人（或你自己）给它们的**这个精确版本**开过豁免，所以宿主照常加载、工具也在。",
			fix: [{ text: "不用处理；升级插件后豁免记录会自然失效，那条记录可以留着（不影响判定）" }],
			fixable: false
		});
	}
	if (exSummary.stale.length > 0) {
		findings.push({
			code: "exemption-stale",
			severity: "warn",
			title: exSummary.stale.length + " 条版本豁免对当前 DSH 已失效（多半是升级后留下的）",
			detail: exSummary.stale.map((entry) => "  · " + entry.key + " → 只对 " + entry.runtimes.join(" / ") + " 生效").join("\n") +
				"\n当前运行版本是 " + (hostVersion || "未知") + "。宿主只认**精确版本**：升级后旧记录不再生效，插件会回到「被跳过」状态。",
			plain: "大白话：这几条豁免是给旧版 DSH 开的。升级之后宿主不再认它们，对应的插件会重新变成「不兼容、被跳过」。要接着用就重新授权一次（记录会多一条，旧的留着无害）。",
			fix: [
				{ text: "在面板里对受影响的插件重新授权一次精确版本（对已装插件：设置 → 插件里的「版本豁免」）" },
				{ text: "或者退出 DSH 后跑 dsh plugin allow-version <包>@<版本> --dsh-version " + (hostVersion || "<宿主版本>") + " --accept-risk" }
			],
			fixable: false
		});
	}
	if (incompatible.length > 0) {
		const detail = incompatible.slice(0, 6).map((entry) => {
			const req = entry.requirements ? Object.entries(entry.requirements).map(([dep, range]) => dep + " " + range).join("；") : "";
			return "  · " + entry.plugin + (entry.version ? "@" + entry.version : "") + (req ? " —— " + req : "");
		}).join("\n");
		findings.push({
			code: "bundle-incompatible",
			severity: "error",
			title: incompatible.length + " 个插件的版本声明不接受宿主 " + (hostVersion || "当前版本") + "，启动时会被跳过",
			detail: detail + "\n判据：engines.dsh 独占，否则看 DSH 系 peerDependencies 范围；这里与宿主 skip 用的是同一套（app-boot 官方评估器），并且**已把 " + (exSummary.total) + " 条已有豁免纳入判定**（所以这条列表里不含已豁免的）。被判跳过时宿主只在 stderr 打一行并继续启动，所以从界面上看就是「插件和它的工具都消失了」。",
			plain: "大白话：这几个插件声明的兼容上限还停在旧版 DSH，所以宿主干脆不加载它们 —— 不报错，就是安静地消失。三条路：等作者发新版、给这个精确版本开豁免（有风险）、或者先从清单里摘掉。",
			fix: [
				{ text: "先更新：面板里对它们重新搜索/安装一次，看有没有声明接受新宿主的新版本" },
				{ text: "要硬用：在设置 → 插件里给这个精确版本开豁免（面板对「装到一半被挡」的任务也提供同一个授权按钮）" },
				{ text: "不确定就别开豁免：先从 dsh.profile.bundles 摘掉，避免每次启动都刷警告" }
			],
			fixable: false
		});
	}

	/* ④c 激活体检（R13）：缺 inject 的（静态）+ 行开着但没激活的（fiberPhase 实测）。
	   事实与文案都来自 `lib/activation.js` —— 同一套判据还要给安装后诊断、面板激活视图用，
	   三处各写一遍就是判据漂移。 */
	const activation = await scanActivation({
		profileDir,
		bundles,
		plugins: Array.isArray(input && input.plugins) ? input.plugins : null,
		inject: true,
		maxFiles: 120
	});
	info.inject = { scanned: activation.rows.filter((row) => row.inject).length, violations: activation.missingInject.length };
	info.inactive = activation.inactive.map((row) => ({
		moduleName: row.name,
		entryId: row.entryId,
		fiberPhase: row.fiberPhase
	}));
	info.activation = { active: activation.active, total: activation.total, line: summarizeActivation(activation) };
	for (const finding of activationFindings(activation)) findings.push(finding);

	/* ④b 已装插件的工具注册契约（0.2.1 起漏 output = 下次启动整片挂） */
	if (input && input.contract !== false) {
		const violations = [];
		let scanned = 0;
		let dynamic = 0;
		for (const name of bundles) {
			if (typeof name !== "string" || name.startsWith("@deepseek-ai/")) continue;
			const dir = packageDir(profileDir, name);
			if (!(await exists(dir))) continue;
			const scan = await scanToolContract(dir, { maxFiles: 120 });
			scanned += 1;
			dynamic += scan.dynamic;
			for (const violation of scan.violations) violations.push({ plugin: name, ...violation });
		}
		info.contract = { scanned, violations: violations.length, dynamic };
		if (violations.length > 0) {
			const byPlugin = new Map();
			for (const violation of violations) {
				const list = byPlugin.get(violation.plugin) || [];
				list.push(violation.tool);
				byPlugin.set(violation.plugin, list);
			}
			const detail = Array.from(byPlugin.entries())
				.slice(0, 6)
				.map(([plugin, tools]) => "  · " + plugin + "：" + tools.slice(0, 6).join("、") + (tools.length > 6 ? " 等 " + tools.length + " 个" : ""))
				.join("\n");
			findings.push({
				code: "tool-contract",
				severity: "error",
				title: violations.length + " 个工具定义漏声明 output，会让插件在下次启动时失活",
				detail: detail + "\n判据：DSH 0.2.1-rc.2 的 ctx.tools.register() 要求 output { schema, render }；漏了不是静默降级，而是抛 TypeError 让整个插件激活失败，required 插件失活还会连累整次启动。",
				plain: "大白话：这些插件的工具定义少了宿主现在必需的一段声明。装上去，下次启动 DSH 会起不来（而且会弹恢复对话框）。要么让作者补，要么先别启用。",
				fix: [
					{ text: "让插件作者按 output: { schema, render } 补上（模板见 skill dsh-selfrepair 陷阱⑤）" },
					{ text: "暂时用不了就先从 bundles 里摘掉这一个插件，别让整次启动被它拖住" }
				],
				fixable: false
			});
		}
	}

	/* ⑤ pnpm 版本钉子（DSH 升级后必过期；钉错会让 pnpm 装回宿主以外的 copies） */
	const workspaceYaml = await readText(join(profileDir, "pnpm-workspace.yaml"));
	if (workspaceYaml !== null) {
		const match = /overrides\s*:\s*\n(?:[ \t]+.*\n)*?[ \t]+['"]?@deepseek-ai\/dsh-tools['"]?\s*:\s*([^\s#]+)/.exec(workspaceYaml);
		const pinned = match ? match[1].replace(/["']/g, "") : null;
		info.pnpmOverride = pinned;
		if (pinned && hostVersion && pinned !== hostVersion) {
			findings.push({
				code: "pnpm-override-drift",
				severity: "warn",
				title: "pnpm-workspace.yaml 的 dsh-tools 钉子过期：钉 " + pinned + "，宿主 " + hostVersion,
				detail: "DSH 每次升级宿主版本都会变。钉子不过期不会当场坏，但一旦 pnpm 被触发，它会把钉子版本当成「应该装的版本」。",
				plain: "大白话：profile 里记着「别装这个内部包的别的版本，就装 X」。DSH 已经升到 Y 了，这个标记还没跟上。修一下就好，不用重装。",
				fix: [{ text: "点「一键修复」：把 overrides 里的 dsh-tools 改成宿主当前版本" }],
				fixable: true
			});
		}
	}

	/* ⑤b R29：profile 的「pnpm 世代」还说得通吗 —— package.json × pnpm-lock.yaml × node_modules 三方对账。
	   以前这块**一条判据都没有**（只有快照会顺手把 lockfile 存起来），于是「lockfile 落后 20 项」
	   这种状态面板一个字都不说，而它正好卡在宿主的两条 pnpm 路径上：正常安装走 `pnpm add`
	   （重算整棵树），安装出 warning 后的自动修复走 `pnpm install --frozen-lockfile`（必炸）。
	   判据全部在 lib/profilestate.js（纯函数），面板、工具、体检共用同一份结论。 */
	const pnpmState = await inspectPnpmState({ profileDir, manifest }).catch((e) => ({
		readable: false,
		ok: false,
		reasons: ["对账时抛错：" + String((e && e.message) || e)]
	}));
	info.pnpmState = {
		readable: pnpmState.readable === true,
		ok: pnpmState.ok === true,
		line: pnpmState.line || null,
		counts: pnpmState.counts || null,
		pnpmAt: pnpmState.pnpmAt || null,
		lagDays: pnpmState.lagDays ?? null,
		lockfileVersion: pnpmState.lockfileVersion || null,
		nodeLinker: pnpmState.nodeLinker || null,
		packageManager: pnpmState.packageManager || null
	};
	const pnpmFinding = driftFinding(pnpmState);
	if (pnpmFinding) findings.push(pnpmFinding);

	/* ⑤c R29：profile 被「本面板之外」的东西改过吗 —— 只读台账，不写（体检必须只读）。
	   台账由 lib/pipeline.js 在「宿主启动 / 本面板任务收尾 / 人点状态」三个时机落盘；
	   这里只负责把最新那条**不能归因给本面板**的变更说出来。 */
	if (dataDir) {
		const journal = await readJournal(join(dataDir, JOURNAL_NAME)).catch(() => null);
		const attribution = readAttribution(journal || {}, {});
		info.attribution = attribution;
		const attributionNotice = attributionFinding(attribution);
		if (attributionNotice) findings.push(attributionNotice);
	}

	/* ⑥ 最近一次启动失败：宿主崩溃（*-host.log）或 web 入口没激活（*-web-boot.log）。
	   判据带「是不是这次启动」：日志早于本进程启动 = 上一次启动留下的，只算留痕（warn）。 */
	const crash = await readNewestCrash(crashDir);
	if (crash) {
		const stale = Date.now() - crash.ageMs < processStartedAt;
		info.crash = {
			kind: crash.kind,
			stale,
			at: crash.at,
			ageHours: round1(crash.ageMs / 3600000),
			app: crash.app,
			failed: crash.failed,
			console: crash.console,
			signature: crash.signature ? { name: crash.signature.name } : null,
			sibling: crash.sibling
		};
		if (crash.ageMs <= CRASH_FRESH_MS) {
			const siblingLine = crash.sibling
				? (crash.sibling.kind === "web-boot"
					? "另：" + crash.sibling.ageHours + "h 前还有一次前端入口没激活（" + crash.sibling.path + "）"
					: "另：" + crash.sibling.ageHours + "h 前还有一次宿主启动失败（" + crash.sibling.path + "）")
				: null;
			const consoleLines = (crash.console || []).map((line) => "  ! " + line);
			const tail = (crash.signature ? ["已知签名：" + crash.signature.name] : [])
				.concat(["日志：" + crash.path])
				.concat(siblingLine ? [siblingLine] : []);

			if (crash.kind === "web-boot") {
				const named = crash.failed;
				const who = named.map((f) => f.plugin).join("、");
				/* R24：把「日志里失败的那份 client 包」和「现在磁盘上那份」对一遍。
				   宿主的 rev 是 (mtime, ctime, size) 的哈希，日志把出错 URL 原样抄了下来，
				   所以这件事是**确定性**的，不是猜「大概已自愈」。 */
				const loggedAt = crash.atMs || (Date.now() - crash.ageMs);
				const bundles = [];
				for (const f of named.slice(0, 6)) {
					let current = null;
					try {
						current = await resolveClientArtifact(profileDir, f.plugin);
					} catch (e) {
						current = { ok: false, reason: "probe-failed", note: String((e && e.message) || e) };
					}
					const verdict = classifyBundle({ loggedRev: findBundleRev(crash.revs, f.plugin), loggedAt, current });
					bundles.push({
						plugin: f.plugin,
						state: verdict.state,
						rev: verdict.rev || null,
						loggedRev: verdict.loggedRev || null,
						artifactAt: verdict.artifactAt ? new Date(verdict.artifactAt).toISOString() : null,
						line: describeBundleState(verdict, current)
					});
				}
				if (bundles.length > 0) info.crash.bundles = bundles;
				const stillBroken = bundles.filter((b) => b.state === "same");
				const rebuilt = bundles.filter((b) => b.state === "rebuilt");
				const allRebuilt = bundles.length > 0 && rebuilt.length === bundles.length;
				const staleLine = stale
					? "本次启动（" + clockOf(processStartedAt) + "）之后没有新的失败日志"
						+ (allRebuilt ? "；而且日志里那份 client 包已经被换掉了（见上）。" : " —— 这条可能已自愈；那块面板还在就不用管。")
					: null;
				const detail = (crash.summary ? [crash.summary] : [])
					.concat(named.map((f) => {
						const b = bundles.find((x) => x.plugin === f.plugin);
						return "  · " + f.plugin + "：" + f.error + (b ? "\n      " + b.line : "");
					}))
					.concat(consoleLines)
					.concat(staleLine ? [staleLine] : [])
					.concat(tail);
				const bundleFailed = named.some((f) => /client 包加载失败/.test(f.error));
				const baseFix = crash.signature ? crash.signature.fix : (bundleFailed ? WEB_BOOT_BUNDLE_FIX : WEB_BOOT_FIX);
				const sourceFix = named
					.map((f) => describePluginSource(manifest, f.plugin))
					.filter(Boolean)
					.slice(0, 2)
					.map((s) => ({ text: s.text }));
				const fixList = (stillBroken.length > 0
					? [{ text: "点名的 client 包和日志里那份逐字相同（rev 没变）—— 重启不会改变任何东西，必须换掉那份文件：升级它（npm 来源会给出按钮），或让作者给新版本" }]
					: allRebuilt
						? [{ text: "日志里那份 client 包已经不在了（现在磁盘上是另一份）—— 重启一次就能用上；重启后面板在就不用再做别的" }]
						: (stale ? [{ text: "先确认那块面板现在在不在；在就什么都不用做（这条只是留痕）" }] : []))
					.concat(sourceFix, baseFix);
				/* 只有 npm 来源才给动作：`link:` 的本机目录重装无意义、`file:` 的 .tgz 同一份字节、
				   Git 来源同一 spec 会被宿主判 already-installed —— 给了都是假按钮。 */
				const actions = [];
				if (stillBroken.length > 0 || !stale) {
					for (const f of named.slice(0, 3)) {
						if (/^@deepseek-ai\//.test(f.plugin)) continue;
						const src = describePluginSource(manifest, f.plugin);
						if (!src || src.kind !== "npm") continue;
						actions.push({
							kind: "upgrade-npm",
							plugin: f.plugin,
							label: "检查更新并升级 " + f.plugin,
							hint: "先查 npm 上有没有新版：有就升级（这才是真修法）；没有会直接告诉你"
						});
					}
				}
				findings.push({
					code: "web-boot-recent",
					severity: stillBroken.length > 0 ? "error" : (stale ? "warn" : "error"),
					title: (stillBroken.length > 0
						? "前端入口没激活，且失败的那份字节还在"
						: stale ? "上一次启动有前端入口没激活" : "最近 " + info.crash.ageHours + " 小时内有前端入口没激活")
						+ (named.length > 0 ? "（" + who + "）" : "")
						+ (allRebuilt ? "（那份已重建）" : ""),
					detail: detail.join("\n"),
					plain: stillBroken.length > 0
						? "大白话：日志里失败的那个前端包，现在磁盘上还是同一份（宿主给文件算的指纹没变）—— 重启只是再错一次。要换掉那份文件：能升级就升级，不能就等作者修，或者先把这个插件停掉。"
						: allRebuilt
							? "大白话：上次/这次启动有入口没加载成功，但那份前端包之后已经被重新构建过（现在是另一份文件了）。重启一次让它生效就行，不用重装。"
							: stale
								? "大白话：上一次启动时网页界面有入口没加载成功，但这次启动之后没有再出现 —— 很可能当时撞上了刚写完或缓存未更新的包，现在已自愈。先看一眼那块面板在不在：在就不用管，不在再按下面处置。"
								: (crash.signature
									? crash.signature.plain
									: "大白话：DSH 起来了，但网页界面里有入口没加载成功 —— 表现是那个面板整块不见（不是恢复对话框那种）。正常重启不会自己好，要修的是那个插件的客户端包。"),
					fix: fixList,
					actions,
					fixable: false
				});
			} else {
				const named = crash.failed;
				const staleLine = stale ? "本次启动（" + clockOf(processStartedAt) + "）已正常 —— 这份日志来自上一次启动。" : null;
				const detail = (crash.summary ? [crash.summary] : [])
					.concat(named.length > 0
						? named.map((f) => "  · " + f.plugin + (f.package ? "（" + f.package + "）" : "") + "：" + f.error)
						: ["  · 日志里没有点名失败插件"])
					.concat(consoleLines)
					.concat(staleLine ? [staleLine] : [])
					.concat(tail);
				findings.push({
					code: "crash-recent",
					severity: stale ? "warn" : "error",
					title: (stale ? "上一次启动失败" : "最近 " + info.crash.ageHours + " 小时内有启动失败") + "（" + (crash.app || "未知版本") + "）" + (crash.signature ? "：" + crash.signature.name : ""),
					detail: detail.join("\n"),
					plain: named.length > 0
						? (stale
							? "大白话：上一次启动 DSH 没起来，日志点名了这些插件；不过之后已经正常启动过。这些插件如果还在用，建议先修掉；反复出现就必须修。"
							: "大白话：上次 DSH 没起来，日志点名了这些插件。修掉它们再重启，不然还会再弹一次恢复对话框。")
						: (crash.signature
							? crash.signature.plain
							: "大白话：上次 DSH 没起来，但日志里没点名具体插件 —— 多半不是某个插件，而是登录态/环境或宿主自身。先看日志第一条错误再动手，别急着删插件。"),
					fix: named.length > 0
						? [{ text: "按上面点名的插件逐个修（output / 版本兼容），或用「插件安装」面板回滚到安装前" }]
						: (crash.signature
							? crash.signature.fix
							: [
								{ text: "打开日志（路径在上面）看第一条错误，按它处理" },
								{ text: "反复出现且无插件可归因时，用「插件安装」面板回滚到上次安装前" }
							]),
					fixable: false
				});
			}
		}
	}

	/* ⑦ 快照清单（restore 的数据源） */
	info.snapshots = await listSnapshots(dataDir, { profileDir });
	return { at: new Date().toISOString(), findings, info };
}

/**
 * 存一份 profile 三件套快照。
 * @param {{profileDir: string, dataDir: string, reason?: string, manifest?: object}} input
 */
export async function snapshotProfile(input) {
	const { profileDir, dataDir, reason = "manual", manifest = null } = input || {};
	if (!profileDir || !dataDir) return { ok: false, error: "缺 profileDir 或 dataDir" };
	const id = "profile-" + stamplike();
	const dir = join(dataDir, "snapshots", id);
	await mkdir(dir, { recursive: true });
	const files = [];
	for (const name of PROFILE_FILES) {
		const text = await readText(join(profileDir, name));
		if (text === null) continue;
		await writeFile(join(dir, name), text, "utf8");
		files.push(name);
	}
	const pkg = manifest || (await readJson(join(profileDir, "package.json")));
	const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
	await writeFile(join(dir, "meta.json"), JSON.stringify({
		id,
		at: new Date().toISOString(),
		reason,
		profileDir,
		files,
		bundles
	}, null, 2), "utf8");
	return { ok: files.length > 0, id, dir, files, bundles: bundles.length };
}

/**
 * 可能的快照根目录：本插件自己的 `data/snapshots`，以及工作区惯例的
 * `<工作区>/.tools/backups`（`dsh_profile_config`、手工备份、`profile-pkg-*` 都落那儿）。
 * profileDir 形如 `<工作区>/.dsh/profiles/<name>`，所以往上三层就是工作区。
 * @param {string|null} dataDir
 * @param {string|null} profileDir
 * @returns {string[]}
 */
function snapshotRoots(dataDir, profileDir) {
	const roots = [];
	if (dataDir) roots.push(join(dataDir, "snapshots"));
	const parts = String(profileDir || "").split(/[\\/]/);
	const dshIndex = parts.lastIndexOf(".dsh");
	if (dshIndex > 0) {
		roots.push(join(parts.slice(0, dshIndex).join("\\"), ".tools", "backups"));
	}
	return roots;
}

/**
 * 列出快照（新的在前）。
 *
 * 认三种命名：本插件写的 `profile-<时间戳>`、`dsh_profile_config` 写的
 * `dsh-profile-*`、工作区惯例的 `profile-pkg-*`（只有 package.json）。
 *
 * @param {string|null} dataDir
 * @param {{profileDir?: string|null}} [options] 给了 profileDir 才会去扫 `.tools/backups`
 */
export async function listSnapshots(dataDir, options = {}) {
	const roots = snapshotRoots(dataDir, options.profileDir);
	const out = [];
	for (const root of roots) {
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!/^(profile-|dsh-profile-|profile-pkg-)/.test(entry.name)) continue;
			const dir = join(root, entry.name);
			const meta = await readJson(join(dir, "meta.json"));
			// profile-pkg-* 没有 meta，bundles 从它自己的 package.json 里读
			let bundles = meta && Array.isArray(meta.bundles) ? meta.bundles : null;
			if (bundles === null) {
				const pkg = await readJson(join(dir, "package.json"));
				const list = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : null;
				bundles = list;
			}
			out.push({
				id: entry.name,
				dir,
				at: meta && meta.at ? meta.at : null,
				reason: meta && meta.reason ? meta.reason : (entry.name.startsWith("profile-pkg-") ? "legacy-package-backup" : null),
				bundles: Array.isArray(bundles) ? bundles.length : null
			});
		}
	}
	out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
	return out.slice(0, 12);
}

/**
 * 修复 profile 层可自动修的两项：
 *   - `bundles-truncated` → 从最近一份"bundles 更多"的快照写回（写前自动再快照一次）
 *   - `pnpm-override-drift` → 把 overrides 里的钉改成宿主版本
 *
 * @param {{profileDir: string, hostVersion?: string|null, dataDir: string, findings: Array<object>}} input
 * @returns {Promise<{actions: Array<{kind: string, ok: boolean, skipped?: string, error?: string, detail?: string}>}>}
 */
export async function repairProfile(input) {
	const { profileDir, hostVersion = null, dataDir } = input || {};
	const findings = Array.isArray(input && input.findings) ? input.findings : [];
	const actions = [];
	if (!profileDir) return { actions: [{ kind: "profile", ok: false, error: "读不到 profile 目录" }] };

	const needsBundles = findings.some((f) => f.code === "bundles-truncated");
	const needsPin = findings.some((f) => f.code === "pnpm-override-drift");

	if (!needsBundles && !needsPin) {
		return { actions: [{ kind: "profile", ok: true, skipped: "没有可自动修的 profile 项" }] };
	}

	// 写前先存一份（唯一的"后悔药"）
	const pre = await snapshotProfile({ profileDir, dataDir, reason: "pre-repair" }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
	if (pre.ok) actions.push({ kind: "snapshot", ok: true, detail: pre.dir });

	if (needsBundles) {
		try {
			const current = await readJson(join(profileDir, "package.json"));
			const currentBundles = current && current.dsh && current.dsh.profile && Array.isArray(current.dsh.profile.bundles)
				? current.dsh.profile.bundles
				: [];
			const snapshots = await listSnapshots(dataDir, { profileDir });
			let chosen = null;
			for (const snapshot of snapshots) {
				if (snapshot.reason === "pre-repair") continue;
				const bundles = readBundlesOf(await readJson(join(snapshot.dir, "meta.json")), await readJson(join(snapshot.dir, "package.json")));
				if (bundles.length > currentBundles.length) {
					chosen = { dir: snapshot.dir, bundles };
					break;
				}
			}
			if (!chosen) {
				actions.push({
					kind: "restore-bundles",
					ok: false,
					skipped: "没有比当前更完整的快照 —— 本插件 data/snapshots 与 <工作区>/.tools/backups 都找过了"
				});
			} else {
				current.dsh = current.dsh || {};
				current.dsh.profile = current.dsh.profile || {};
				current.dsh.profile.bundles = chosen.bundles;
				await writeFile(join(profileDir, "package.json"), JSON.stringify(current, null, 2) + "\n", "utf8");
				// patch 被换成小文件时一并写回（sanitizeProfile 的另一半）
				const currentPatch = await readText(join(profileDir, "cordis.patch.yml"));
				const snapshotPatch = await readText(join(chosen.dir, "cordis.patch.yml"));
				let patchNote = "";
				if (snapshotPatch && (!currentPatch || currentPatch.split(/\r?\n/).length < 20)) {
					await writeFile(join(profileDir, "cordis.patch.yml"), snapshotPatch, "utf8");
					patchNote = " + cordis.patch.yml";
				}
				actions.push({
					kind: "restore-bundles",
					ok: true,
					detail: currentBundles.length + " → " + chosen.bundles.length + " 项（快照 " + chosen.dir + "）" + patchNote
				});
			}
		} catch (e) {
			actions.push({ kind: "restore-bundles", ok: false, error: String((e && e.message) || e) });
		}
	}

	if (needsPin) {
		try {
			const path = join(profileDir, "pnpm-workspace.yaml");
			const text = await readText(path);
			if (text === null) {
				actions.push({ kind: "sync-pnpm-override", ok: false, error: "读不到 pnpm-workspace.yaml" });
			} else {
				const next = text.replace(
					/(['"]?@deepseek-ai\/dsh-tools['"]?\s*:\s*)([^\s#]+)/,
					(_m, head) => head + hostVersion
				);
				if (next === text) {
					actions.push({ kind: "sync-pnpm-override", ok: false, skipped: "没匹配到 overrides 里的 dsh-tools 行" });
				} else {
					await writeFile(path, next, "utf8");
					actions.push({ kind: "sync-pnpm-override", ok: true, detail: "→ " + hostVersion });
				}
			}
		} catch (e) {
			actions.push({ kind: "sync-pnpm-override", ok: false, error: String((e && e.message) || e) });
		}
	}

	return { actions };
}

/**
 * 一行说清最近一次启动失败是哪一类、点了谁（install_hub_status / doctor 抬头用）。
 * 带 `stale` 时说明「这是上一次启动留下的」—— 本次启动之后没有再失败。
 *
 * R24：web-boot 还会按 client 包的 rev 对一遍账，于是这一行能给出确定结论：
 *   · 「同一份字节」= 重启不会好；
 *   · 「字节已重建」= 那份已经换掉了，重启一次就能用上。
 *
 * @param {object|null} crash inspectProfile 的 info.crash
 * @returns {string}
 */
export function describeCrash(crash) {
	if (!crash) return "未见过启动失败日志";
	const age = (crash.ageHours === undefined ? "?" : crash.ageHours) + "h 前";
	const lead = crash.stale ? "上次启动 · " : "最近";
	const bundles = Array.isArray(crash.bundles) ? crash.bundles : [];
	const stillBroken = bundles.filter((b) => b && b.state === "same");
	const rebuilt = bundles.filter((b) => b && b.state === "rebuilt");
	const allRebuilt = bundles.length > 0 && rebuilt.length === bundles.length;
	if (crash.kind === "web-boot") {
		const list = Array.isArray(crash.failed) ? crash.failed : [];
		const who = list.map((f) => f.plugin).slice(0, 2).join("、");
		const verdict = stillBroken.length > 0
			? " · 失败那份字节还在（重启不会好）"
			: allRebuilt
				? " · 那份字节已重建（重启即可）"
				: (crash.stale ? " · 本次未复现" : "");
		return lead + "前端入口没激活 " + age + (list.length > 0 ? "（" + list.length + " 个" + (who ? "：" + who : "") + "）" : "") + verdict;
	}
	const named = Array.isArray(crash.failed) ? crash.failed.length : 0;
	return lead + "崩溃 " + age + (named > 0 ? "（" + named + " 个插件）" : "") + (crash.signature ? "：" + crash.signature.name : "") + (crash.stale ? " · 之后已正常启动" : "");
}

/**
 * 一行摘要（install_hub_status / 面板抬头用）。
 * @param {object} info inspectProfile 的 info
 */
export function summarizeHealth(info) {
	if (!info) return "未体检";
	if (info.error) return info.error;
	const parts = [];
	parts.push("bundles " + info.bundles);
	if (info.bundlesTruncated) parts.push("**清单被裁**");
	if (info.contract && info.contract.violations > 0) parts.push(info.contract.violations + " 个工具缺 output");
	if (info.activation && info.activation.line) parts.push(info.activation.line);
	if (info.crash) parts.push(describeCrash(info.crash));
	if (info.disabledDeps && info.disabledDeps.length > 0) parts.push(info.disabledDeps.length + " 个装了未启用");
	return parts.join(" · ");
}
