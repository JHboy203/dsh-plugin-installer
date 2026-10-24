/**
 * inject.js — 插件「服务声明」的静态扫描。
 *
 * 为什么需要它（2026-10-22 本机实证）：`dsh-imgops` 装进 profile 了、bundle 行也勾上了，
 * 但宿主启动时只报一行警告就把它丢了：
 *
 *   dsh: warning: 1 entry did not activate
 *   imgops (dsh-imgops): Error: cannot get property "tools" without inject
 *
 * 根因是插件入口里 `apply(ctx)` 用了 `ctx.tools.register(...)`，却**没有**写
 * `export const inject = ["tools"]`。Cordis 的规矩是：没在 inject 里声明的服务
 * 不许取 —— 取了就抛，整个插件起不来（它的工具/命令一个都不会出现）。
 *
 * 这类错误最坏的形态是「静默」：安装回执可能只有一行 warning，面板看不出区别，
 * 用户以为装好了、只是「怎么没有那个工具」。
 *
 * 判据（静态近似，宁可少报）：只看**入口函数的参数**上的属性访问 ——
 * `apply(ctx)` / `apply(scope)` / `exports.apply = function (app)` 里的那个名字，
 * 取 `ctx.foo` 这种属性，排除 Cordis Context 自带的成员（effect/on/get/logger…），
 * 剩下的都是**服务**。服务必须在 inject 里声明过（数组 / {required,optional} / 字符串都行）。
 *
 * 扫不到的情况也单列（`dynamic`）：入口是动态拼出来的（`ctx.plugin(SomeClass)`、
 * `apply` 由 builder 生成）时，静态看不出来 —— 真正的判据永远是宿主启动日志里的
 * `did not activate`。
 *
 * 已知边界（五条，都是踩出来的）：
 *   ① `dev/` 要跳过 —— 测试夹具里放着一堆 inject 写法的**字符串**，会被当成真声明；
 *   ② 正文（注释 + 字符串内容）在扫**用法**前会被抹成空白：`dsh-our-free-model` 的 JSDoc、
 *      `dsh-web-search-pro` 的界面文案里都有 `ctx.web` / `ctx.interval`，那是文字不是代码
 *      （R13 的体检第一版就因此报了 4 个假阳性）；
 *   ③ 声明侧仍无法区分「字符串里引用的声明」与真声明（声明本身就是字符串）——
 *      所以本模块的文案一律用 `[那个服务名]` 这种占位写法，别写成能解析的数组字面量。
 *   ④ **客户端 bundle 不参与宿主扫描**（R26.2）：`client.js` 的 `inject: ['slots','layout']`
 *      是 web 平台的声明，和宿主 `export const inject` 是两回事。以前把两者合在一起算，
 *      结果是（a）客户端声明把宿主漏声明遮掉、（b）修法建议里混进 slots/layout 这种宿主用不到的条目。
 *      本机 `dsh-plugin-botwatch` 就因此被误报「缺 interval」。
 *   ⑤ 服务方法不等于服务（R26.2）：`ctx.interval()` / `ctx.sleep()` 是 **timer 服务**提供的方法，
 *      要声明的是 `timer`。以前按属性名报成 `interval`，修法会让人写出一个不存在的服务名。
 *
 * @module dsh-plugin-installer/inject
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 扫描时跳过的目录（依赖、产物、测试夹具都不算插件自己的入口）。
 *  `dev` 也要跳：本仓库的 `dev/hosttest.mjs` 里放着一堆 inject 写法的**字符串夹具**，
 *  扫进来会被当成真声明，把违规遮掉（R13 自查时实测）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".cache", "test", "tests", "fixtures", "dev", "__pycache__"]);

/** R26.2：web 平台专属 bundle —— 它的 `inject` 与宿主无关，别合进来（见文件头边界④）。 */
const CLIENT_BUNDLE = /^client\.(?:m?js|cjs)$/i;

/** R26.2：timer 服务的方法名 —— 要声明的是 `timer`，不是方法名（见文件头边界⑤）。 */
const TIMER_METHODS = new Set(["interval", "sleep"]);

/**
 * Cordis Context 自带的成员：取它们**不需要** inject。
 * 这张表只装「确定不是服务」的成员 —— 认不出来的一律当服务，因为 Cordis 对
 * 未声明的属性访问就是抛错，判宽了只是多报一条，判窄了会漏掉真故障。
 */
const CORE_MEMBERS = new Set([
	/* 生命周期 / 事件 */
	"effect", "on", "off", "emit", "parallel", "bail", "waterfall", "serial",
	/* 服务存取 */
	"get", "set", "provide", "inject", "plugin", "loader", "logger", "fiber",
	"scope", "root", "registry", "reflect", "extend", "accessor", "alias",
	/* 元信息 */
	"name", "config", "options", "meta",
	/* 启停 */
	"start", "stop", "dispose", "restart", "update", "await",
	/* 定时器（Context 自带，不是服务） */
	"setTimeout", "setInterval", "clearTimeout", "clearInterval", "throttle", "debounce",
	/* Promise 形状 / 其它内建 */
	"then", "catch", "finally", "toJSON", "toString", "constructor"
]);

/** 入口函数：ESM / CJS / 箭头函数三种写法。 */
const APPLY_PATTERNS = [
	/(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+apply\s*\(([^)]*)\)/,
	/(?:^|\n)[ \t]*(?:module\.)?exports\.apply\s*=\s*(?:async\s+)?(?:function\s+\w*\s*)?\(([^)]*)\)/,
	/(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+apply\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/,
	/(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+apply\s*=\s*(?:async\s+)?function\s*\w*\s*\(([^)]*)\)/
];

/**
 * inject 的两种写法：
 *   · 模块级赋值 —— `export const inject = [...]` / `exports.inject = ...`
 *   · 对象字段   —— 客户端 bundle 常见的 `const exports = { apply, inject: ["slots"] }`
 * 值统一由 readLiteral 读（数组 / {required,optional} / 字符串）。
 */
const INJECT_DECL = /\b(?:exports\s*\.\s*|module\s*\.\s*exports\s*\.\s*)?inject\s*[:=]/;

function escapeRe(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 合法的服务名：标识符形状、长度合理。别把注释里的示例片段当声明。 */
function isServiceName(name) {
	return /^[A-Za-z_$][\w$]*$/.test(name) && name.length <= 40;
}

/** 跳过一段字符串字面量，返回它的结束下标（含引号）。 */
function skipString(text, at) {
	const quote = text[at];
	for (let i = at + 1; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === quote) return i;
		/* 模板串里的 ${...}：跳过配对的花括号，避免把里面的引号当成结束 */
		if (quote === "`" && ch === "$" && text[i + 1] === "{") {
			const close = matchBrace(text, i + 1);
			i = close;
		}
	}
	return text.length;
}

/** 从 `{` 开始配对到对应的 `}`，跳过字符串与注释。返回 `}` 的下标。 */
function matchBrace(text, openIdx) {
	let depth = 0;
	for (let i = openIdx; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(text, i);
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			const nl = text.indexOf("\n", i);
			if (nl < 0) return text.length;
			i = nl;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end < 0) return text.length;
			i = end + 1;
			continue;
		}
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return text.length;
}

/**
 * 取 `apply(...)` 的函数体文本。
 * 为什么要按函数体切：同一个文件里 `ctx` 这个名字经常被别的代码复用
 * （dsh-screenshot 的 canvas 里就有一堆 `ctx.fillRect`）—— 不切就会把它们全当成服务。
 * @returns {{start:number,end:number,approx:boolean}|null}
 */
function bodyAfter(text, matchedIndex) {
	const openParen = text.indexOf("(", matchedIndex);
	if (openParen < 0) return null;
	let depth = 0;
	let closeParen = -1;
	for (let i = openParen; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(text, i);
			continue;
		}
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) {
				closeParen = i;
				break;
			}
		}
	}
	if (closeParen < 0) return null;
	let i = closeParen + 1;
	while (i < text.length && /\s/.test(text[i])) i += 1;
	if (text.startsWith("=>", i)) {
		i += 2;
		while (i < text.length && /\s/.test(text[i])) i += 1;
	}
	if (text[i] === "{") {
		const end = matchBrace(text, i);
		return { start: i + 1, end, approx: false };
	}
	/* 表达式体：扫到下一个顶层换行 + `}` / `export` / 文件尾为止（近似） */
	const stop = text.slice(i).search(/\n(?:export|const|let|var|function|class)\b/);
	return { start: i, end: stop < 0 ? text.length : i + stop, approx: true };
}

/** 从 `=` 后面读一个字面量（数组 / 对象 / 字符串），读不到就返回空串。 */
function readLiteral(text, from) {
	let i = from;
	while (i < text.length && /\s/.test(text[i])) i += 1;
	const ch = text[i];
	if (ch === "[" || ch === "{") {
		const close = ch === "[" ? "]" : "}";
		let depth = 0;
		for (let j = i; j < text.length && j - i < 2000; j += 1) {
			if (text[j] === ch) depth += 1;
			else if (text[j] === close) {
				depth -= 1;
				if (depth === 0) return text.slice(i, j + 1);
			}
		}
		return text.slice(i, i + 2000);
	}
	if (ch === "'" || ch === '"' || ch === "`") {
		for (let j = i + 1; j < text.length && j - i < 400; j += 1) {
			if (text[j] === ch) return text.slice(i, j + 1);
		}
	}
	return "";
}

/**
 * 从一份源码里取出 inject 声明的服务名。
 * 支持 `export const inject = ['a','b']`、`= { required: [...], optional: [...] }`、`= 'a'`。
 */
/** 把注释换成空白（保留换行与长度），免得文档里的示例被当成真声明。 */
function stripComments(text) {
	return sanitize(text, false);
}

/**
 * 把注释与**字符串内容**都换成空白（保留长度 → 行号不乱）。
 *
 * 为什么正文也要抹：真实误报全是这么来的 ——
 *   · `dsh-our-free-model` 的 JSDoc 里写着「`ctx.interval` is a mixin…」；
 *   · `dsh-web-search-pro` 的界面文案里有「注册为 ctx.web Provider」。
 * 静态扫描分不清「代码里取服务」与「文档/文案里提到服务」，那就先把正文抹掉再扫。
 */
function stripNonCode(text) {
	return sanitize(text, true);
}

function sanitize(text, blankStrings) {
	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = skipString(text, i);
			const body = text.slice(i + 1, end);
			const keep = blankStrings ? body.replace(/[^\n]/g, " ") : body;
			out += ch + keep + (text[end] === ch ? ch : "");
			i = end;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			const nl = text.indexOf("\n", i);
			const end = nl < 0 ? text.length : nl;
			out += " ".repeat(end - i);
			i = end - 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end < 0 ? text.length : end + 2;
			out += text.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop - 1;
			continue;
		}
		out += ch;
	}
	return out;
}

/** 按顶层逗号切分（忽略括号/引号里的逗号）。 */
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = skipString(text, i);
			current += text.slice(i, end + 1);
			i = end;
			continue;
		}
		if (ch === "[" || ch === "{" || ch === "(") depth += 1;
		else if (ch === "]" || ch === "}" || ch === ")") depth -= 1;
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

function unquote(part) {
	const match = /^['"]([^'"]+)['"]$/.exec(String(part || "").trim());
	return match ? match[1] : null;
}

/**
 * 解析 inject 的字面量。只认「服务名」的形状：
 *   `['tools']` / `'tools'` / `{ required: ['tools'], optional: ['skills'] }`
 * 其它键（比如面板 health 里那个 `inject: { pluginManager: Boolean(...) }`）一律不算声明 ——
 * 否则同一个文件里随便一段 JSON 都能把违规遮掉。
 */
function parseInjectLiteral(literal) {
	const all = [];
	const optional = [];
	const text = String(literal || "").trim();
	if (!text) return { all, optional };
	if (text[0] === "'" || text[0] === '"') {
		const name = unquote(text);
		if (name && isServiceName(name)) all.push(name);
		return { all, optional };
	}
	const inner = text.slice(1, -1);
	if (text[0] === "[") {
		for (const part of splitTopLevel(inner)) {
			const name = unquote(part);
			if (name && isServiceName(name)) all.push(name);
		}
		return { all, optional };
	}
	/* 对象：只读 required / optional 两个数组字段 */
	for (const part of splitTopLevel(inner)) {
		const match = /^\s*(?:['"]?)([A-Za-z_$][\w$]*)(?:['"]?)\s*:\s*([\s\S]*)$/.exec(part);
		if (!match) continue;
		const key = match[1];
		if (key !== "required" && key !== "optional") continue;
		const value = match[2].trim();
		if (value[0] !== "[") continue;
		for (const item of splitTopLevel(value.slice(1, -1))) {
			const name = unquote(item);
			if (!name || !isServiceName(name)) continue;
			all.push(name);
			if (key === "optional") optional.push(name);
		}
	}
	return { all, optional };
}

function readDeclared(text) {
	const declared = new Set();
	const optional = new Set();
	const clean = stripComments(text);
	const re = new RegExp(INJECT_DECL.source, "g");
	let match;
	while ((match = re.exec(clean)) !== null) {
		const literal = readLiteral(clean, match.index + match[0].length);
		if (!literal) continue;
		const parsed = parseInjectLiteral(literal);
		for (const name of parsed.all) declared.add(name);
		for (const name of parsed.optional) optional.add(name);
	}
	return { declared, optional };
}

/** 从 `apply(ctx, config)` 的参数串里取第一个标识符。 */
function firstParam(paramsText) {
	const first = String(paramsText || "").split(",")[0] || "";
	const match = /[A-Za-z_$][\w$]*/.exec(first);
	return match ? match[0] : null;
}

/**
 * 扫一个包目录，找「用了服务但 inject 没声明」的地方。
 *
 * @param {string} root 包根目录（解包现场或 node_modules 里的安装目录）
 * @param {{maxFiles?: number}} [options] maxFiles 默认 400
 * @returns {Promise<{
 *   root: string, files: number, entries: number, dynamic: number, truncated: boolean,
 *   declared: string[], optional: string[],
 *   used: Array<{service: string, file: string, line: number}>,
 *   violations: Array<{service: string, file: string, line: number, count: number}>,
 *   entryFiles: string[]
 * }>}
 */
export async function scanInject(root, options = {}) {
	const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 400;
	const result = {
		root,
		files: 0,
		entries: 0,
		dynamic: 0,
		truncated: false,
		declared: [],
		optional: [],
		used: [],
		violations: [],
		entryFiles: []
	};
	if (!root) return result;

	const declared = new Set();
	const optional = new Set();
	const used = [];

	const walk = async (dir, depth) => {
		if (depth > 6 || result.files >= maxFiles) {
			if (result.files >= maxFiles) result.truncated = true;
			return;
		}
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (result.files >= maxFiles) {
				result.truncated = true;
				return;
			}
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
				continue;
			}
			if (!/\.(m?js|cjs)$/.test(entry.name)) continue;
			/* R26.2：客户端 bundle 的 inject 是 web 平台的，不参与宿主服务扫描 */
			if (CLIENT_BUNDLE.test(entry.name)) continue;
			let text;
			try {
				text = await readFile(full, "utf8");
			} catch {
				continue;
			}
			result.files += 1;

			/* ① 声明（可能在入口文件，也可能在单独的 inject.js 里被 import） */
			const decl = readDeclared(text);
			for (const name of decl.declared) declared.add(name);
			for (const name of decl.optional) optional.add(name);

			/* ② 入口函数：参数名 + **函数体范围**（body 外的同名变量不算，见 bodyAfter 注释）
			   这里起都只看 `clean`（注释与字符串内容已抹成空白，长度不变 → 行号仍准）。 */
			const clean = stripNonCode(text);
			const entries = [];
			for (const pattern of APPLY_PATTERNS) {
				const match = pattern.exec(clean);
				if (!match) continue;
				const param = firstParam(match[1]);
				if (!param) continue;
				const body = bodyAfter(clean, match.index);
				if (!body) continue;
				if (entries.some((e) => e.param === param && e.body.start === body.start)) continue;
				entries.push({ param, body });
			}
			if (entries.length === 0) continue;
			result.entries += 1;
			result.entryFiles.push(full);
			if (entries.some((e) => e.body.approx)) result.dynamic += 1;

			/* ③ 函数体里、参数上的属性访问 = 服务访问 */
			for (const entry of entries) {
				const scope = clean.slice(entry.body.start, entry.body.end);
				const lineOf = (localIndex) => clean.slice(0, entry.body.start + localIndex).split("\n").length;
				const push = (service, localIndex) => {
					if (!service) return;
					/* R26.2：timer 的方法映射回服务名 —— 修法要写 `timer`，不能写 `interval` */
					const name = TIMER_METHODS.has(service) ? "timer" : service;
					if (!isServiceName(name) || CORE_MEMBERS.has(name)) return;
					used.push({ service: name, file: full, line: lineOf(localIndex) });
				};
				const escaped = escapeRe(entry.param);
				const propRe = new RegExp("\\b" + escaped + "\\s*\\.\\s*([A-Za-z_$][\\w$]*)", "g");
				let match;
				while ((match = propRe.exec(scope)) !== null) push(match[1], match.index);
				/* `ctx['tools']` 这种 */
				const indexRe = new RegExp("\\b" + escaped + "\\s*\\[\\s*['\"]([A-Za-z_$][\\w$]*)['\"]\\s*\\]", "g");
				while ((match = indexRe.exec(scope)) !== null) push(match[1], match.index);
				/* `const { tools, skills } = ctx` */
				const destrRe = new RegExp("(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*" + escaped + "\\b", "g");
				while ((match = destrRe.exec(scope)) !== null) {
					for (const name of String(match[1] || "").split(",")) {
						const clean = name.split(":")[0].trim();
						if (/^[A-Za-z_$][\w$]*$/.test(clean)) push(clean, match.index);
					}
				}
			}
		}
	};

	await walk(root, 0);

	result.declared = [...declared].sort();
	result.optional = [...optional].sort();
	/* 去重：同一个服务的多处访问合并成一条（count 记次数，line 记第一次） */
	const byService = new Map();
	for (const item of used) {
		const hit = byService.get(item.service);
		if (hit) hit.count += 1;
		else byService.set(item.service, { ...item, count: 1 });
	}
	result.used = [...byService.values()].sort((a, b) => a.service.localeCompare(b.service));
	result.violations = result.used.filter((item) => !declared.has(item.service));
	/* 入口是空的但包里出现过 ctx.plugin / apply 关键字：动态生成，静态看不出来 */
	if (result.entries === 0) {
		result.dynamic = 1;
	}
	return result;
}

/**
 * 一句话结论（工具输出与面板共用）。
 * @param {Awaited<ReturnType<typeof scanInject>>} scan
 * @returns {string}
 */
export function describeInjectScan(scan) {
	if (!scan || !Array.isArray(scan.violations)) return "未扫描";
	if (scan.violations.length === 0) {
		if (scan.entries === 0) return "服务声明：没找到申请入口（可能是动态入口），静态判不了，看启动日志";
		return "服务声明：入口用到的服务都声明了 inject" + (scan.declared.length ? "（" + scan.declared.join("、") + "）" : "（没用服务）");
	}
	const names = scan.violations.slice(0, 6).map((v) => v.service).join("、");
	const more = scan.violations.length > 6 ? " 等 " + scan.violations.length + " 个" : "";
	return "服务声明：**" + scan.violations.length + " 个服务没写进 inject**（" + names + more + "）—— 装上去激活会失败";
}

/**
 * 给作者/用户的修法：一行可直接粘的 inject 声明。
 * @param {string[]} services
 * @param {string[]} [already] 包里已有的 inject 声明（有就提示追加）
 * @returns {string}
 */
export function injectFixLine(services, already = []) {
	const list = (Array.isArray(services) ? services : []).filter(Boolean);
	if (list.length === 0) return "";
	const merged = [...new Set([...(Array.isArray(already) ? already : []), ...list])];
	const literal = merged.map((s) => "'" + s + "'").join(", ");
	if (Array.isArray(already) && already.length > 0) {
		return "在入口文件现有的 inject 里补上：" + list.join("、") + " → export const inject = [" + literal + "]";
	}
	return "在入口文件（apply 所在的那个）顶部加一行：export const inject = [" + literal + "]";
}

/**
 * 从宿主那句 `cannot get property "tools" without inject` 里取出服务名。
 * @param {string} text
 * @returns {string[]}
 */
export function servicesFromHostError(text) {
	const out = new Set();
	const re = /cannot get property "([^"]+)" without inject/g;
	let match;
	while ((match = re.exec(String(text || ""))) !== null) out.add(match[1]);
	return [...out];
}
