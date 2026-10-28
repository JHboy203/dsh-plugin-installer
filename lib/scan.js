/**
 * scan.js — 静态危险能力扫描（确定性、零 token）。
 *
 * 目的不是「判善恶」，而是**把可疑点摆到用户面前并触发按需 AI 审查**。
 * 13 类能力识别对齐 dsh-plugin-guard 的做法：子进程 / eval / vm / shell /
 * 文件读写 / 网络外联 / 混淆 / 环境变量 / 原生模块 / 安装脚本 / 动态加载 /
 * 提示注入。每条命中都带文件、行号、脱敏后的片段。
 */
import { readFile } from "node:fs/promises";

const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i;
/* R33：Python 以前**既不算代码也不算文本** —— 于是整套 Python 项目一个字都不扫，
   摘要却照样说「未发现危险能力特征」。真样本 Tideglass.zip（8 个 .py）只扫到 1 个
   requirements.txt。现在 .py 有自己的规则集（复用既有 kind，只有「连数据库」是新的）。 */
const PY_EXT = /\.(py|pyw)$/i;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml)$/i;
/** 所有「源码」扩展名 —— 用来算**扫描覆盖**：没扫到的源码要让摘要说出来（只报不装懂）。 */
const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyw|rs|go|java|kt|cs|rb|php|lua|swift|scala)$/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist\/.*\.map)(\/|$)/i;
/**
 * 构建产物 / 第三方打包文件（R33，调研报告 §3④）。命中仍然会被列出来，
 * 但**严重度降一档**并注明「这是构建产物」—— 否则 `prettier` 自带的语法解析器
 * 会被跟「手写的 eval」放在同一档，判别力就没了。
 */
const BUILD_ARTIFACT = /(^|\/)(dist|build|vendor|output)\/|\.min\.(?:js|css)$|\.bundle\.js$|\.chunk\.js$/i;
const DOWNGRADE = { high: "medium", medium: "low", low: "low" };

export const RISK_KIND_LABELS = {
	"child-process": "启动子进程",
	eval: "eval 动态求值",
	"new-function": "new Function 动态代码",
	vm: "vm 虚拟机执行",
	shell: "调用系统 shell / PowerShell",
	"fs-write": "写/删文件",
	"fs-read": "读文件",
	network: "网络请求",
	obfuscation: "代码混淆/编码载荷",
	"env-access": "读取环境变量",
	native: "原生模块 / node-gyp",
	"install-script": "安装期脚本（pre/postinstall）",
	"dynamic-load": "动态 import / require 变量",
	"prompt-injection": "文档里的提示注入痕迹",
	/* R33：只有 Python 规则会产出这一类 —— 它回答的正是「这东西要连哪个库」。 */
	"db-connect": "连接数据库"
};

const RULES = [
	{ kind: "child-process", severity: "medium", why: "启动子进程", re: /\b(?:require\s*\(\s*["']child_process["']|from\s+["']node:child_process["']|spawnSync\s*\(|execFileSync\s*\(|execSync\s*\(|child_process\.(?:exec|spawn))/g },
	{ kind: "eval", severity: "high", why: "eval 动态求值", re: /(^|[^.\w])eval\s*\(/g },
	{ kind: "new-function", severity: "high", why: "new Function 动态代码", re: /\bnew\s+Function\s*\(/g },
	{ kind: "vm", severity: "high", why: "vm 虚拟机执行", re: /(?:node:vm|require\s*\(\s*["']vm["'])/g },
	{ kind: "shell", severity: "medium", why: "调用系统 shell / PowerShell", re: /\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd\.exe|Start-Process|\/bin\/sh|\/bin\/bash)\b/gi },
	{ kind: "fs-write", severity: "medium", why: "写/删文件", re: /\b(?:writeFile|appendFile|rmSync|rm\s*\(|unlinkSync|rmdirSync|renameSync|createWriteStream)\b/g },
	{ kind: "fs-read", severity: "low", why: "读文件", re: /\b(?:readFile|readdirSync|createReadStream|readFileSync)\b/g },
	{ kind: "network", severity: "medium", why: "网络请求", re: /(?:https?\.request|https?\.get|fetch\s*\(|net\.connect|dns\.(?:lookup|resolve)|new\s+WebSocket)/g },
	/* ⚠️ 2026-10-20 R4 收紧两条规则（实测误报换来的）：
	   · obfuscation：以前 `Buffer.from(x,"base64")` / `atob(y)` 就命中 —— 但 bundle 里
	     协议解码、图片、JWT 全是这个形状，25 MB 的包里一次就误报 17 条。现在只认
	     **长字面量载荷**（≥80 个 base64 字符直接写在调用里）与真正的混淆特征（_0x / 长 hex 转义）。
	   · native：以前 `\.node["']` 会把 i18n 里的 `'egress.node'` 当成原生模块。现在要求
	     `.node` 出现在 require(...)/import(...) 的字符串里，或 node-gyp / bindings。 */
	{ kind: "obfuscation", severity: "high", why: "长 base64 字面量或 _0x/hex 混淆特征", re: /(?:(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{80,}["']|\\x[0-9a-fA-F]{2}\\x[0-9a-fA-F]{2}\\x[0-9a-fA-F]{2}|_0x[0-9a-f]{4,})/g },
	{ kind: "env-access", severity: "low", why: "读取 process.env", re: /\bprocess\.env\b/g },
	{ kind: "native", severity: "medium", why: "原生模块 .node / node-gyp / bindings", re: /(?:(?:require|import)\s*\(\s*["'][^"']*\.node["']|node-gyp|bindings\s*\()/g },
	{ kind: "dynamic-load", severity: "medium", why: "import()/require() 的路径是变量", re: /(?:import\s*\(\s*[^"'`)]|require\s*\(\s*[^"'`)]|require\s*\(\s*`)/g }
];

/* ── Python 规则（R33）──────────────────────────────────────────────────────
   设计约束：**只复用既有 kind**，唯一的例外是 `db-connect` —— 因为
   「它要连 MongoDB」正是人看一个 Python 项目时最想知道的信息，塞进 `network`
   会被读成「它在发网络请求」，答案就错了一半。
   规则只对 `.py` 生效，所以对 JS 插件零影响（不会凭空多出命中）。 */
export const PY_RULES = [
	{ kind: "child-process", severity: "medium", why: "启动子进程 / 调系统命令", re: /\b(?:subprocess\.(?:run|Popen|call|check_call|check_output|getoutput)|os\.(?:system|popen|spawn\w*|execv\w*|execl\w*)|pty\.spawn|multiprocessing\.Process)\s*\(/g },
	{ kind: "shell", severity: "medium", why: "subprocess 带 shell=True（命令走 shell 解析）", re: /\bshell\s*=\s*True\b/g },
	{ kind: "eval", severity: "high", why: "eval/exec 动态执行", re: /(^|[^.\w])(?:eval|exec)\s*\(/g },
	{ kind: "db-connect", severity: "medium", why: "连接数据库", re: /\b(?:MongoClient|pymongo\.MongoClient|psycopg2?\.connect|asyncpg\.connect|pymysql\.connect|mysql\.connector\.connect|sqlite3\.connect|redis\.Redis|create_engine)\s*\(/g },
	{ kind: "network", severity: "medium", why: "网络请求", re: /\b(?:requests\.(?:get|post|put|patch|delete|head|Session|request)|urllib\.request\.urlopen|urlopen|httpx\.(?:get|post|Client)|aiohttp\.ClientSession|http\.client\.HTTPS?Connection|socket\.socket)\s*\(/g },
	{ kind: "fs-write", severity: "medium", why: "写/删文件", re: /\b(?:shutil\.(?:rmtree|copy|move)|os\.(?:remove|unlink|rename|rmdir|makedirs)|Path\([^)]*\)\.(?:write_text|write_bytes|unlink))\s*\(/g },
	{ kind: "env-access", severity: "low", why: "读取环境变量", re: /\b(?:os\.environ|os\.getenv|dotenv\.load_dotenv)\b/g },
	{ kind: "dynamic-load", severity: "medium", why: "反序列化（pickle/marshal）—— 能执行任意代码", re: /\b(?:pickle\.loads|marshal\.loads)\s*\(/g },
	{ kind: "obfuscation", severity: "high", why: "长 base64 载荷解码", re: /\b(?:base64\.b64decode|codecs\.decode)\s*\(\s*["'][A-Za-z0-9+/=]{80,}/g }
];

const SECRET_PATTERNS = [
	/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	/(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{8,}["']/gi
];

export function redact(text) {
	let out = String(text ?? "");
	for (const re of SECRET_PATTERNS) {
		out = out.replace(re, (match) => {
			const head = /^([A-Za-z_-]{3,12}\s*[:=])/.exec(match);
			return head ? head[1] + " ***REDACTED***" : "***REDACTED***";
		});
	}
	return out;
}

function lineIndex(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
	return (offset) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
}

function excerptAt(text, offset, radius = 90) {
	const beg = Math.max(0, offset - radius);
	const end = Math.min(text.length, offset + radius);
	return redact(text.slice(beg, end).replace(/\s+/g, " ").trim());
}

/* 提示注入判据（R33 分两档）。
   为什么分档：**SKILL.md 本身就是一段写给模型看的指令**，它里面出现
   「你现在是一个…」「忽略上面的默认做法，按下面走」是它的正常工作方式。
   调研实测 `anthropics/skills` 因此被判 6 个文件命中、还触发一次 AI 审查 ——
   对一个「说明书 + 模板」的仓库，这是过度反应。
   所以：**SKILL.md 只认强句式**（伪造 system/instruction 标签、让人执行 shell 命令）；
   弱句式（"ignore previous instructions" / "you are now a" 这类祈使句）只在
   README 等非技能正文里才算可疑 —— 那些文件没有「当指令写」的理由。 */
const INJECTION_STRONG = [
	/(?:^|\n)\s*(?:system|assistant)\s*[:：]/i,
	/<\s*\/?\s*(?:system|instructions?)\s*>/i,
	/执行(?:以下|下面)命令[：:]/,
	/请(?:立即)?(?:运行|执行)\s*(?:curl|powershell|bash|cmd)/
];
const INJECTION_WEAK = [
	/ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior)\s+instructions?/i,
	/disregard\s+(?:all\s+)?(?:previous|above|prior)\s+instructions?/i,
	/you\s+are\s+now\s+(?:a|an|the)\s+/i,
	/忽略(?:以上|之前|前面|上述)(?:的)?(?:所有)?(?:指令|指示|要求)/,
	/不要(?:再)?(?:遵守|理会)(?:系统|以上|之前)的?(?:提示|指令)/
];
const INJECTION_PATTERNS = [...INJECTION_STRONG, ...INJECTION_WEAK];

/**
 * @param {string} text
 * @param {{tier?:'all'|'strong'}} [options] `strong` 只认强句式（SKILL.md 用）
 */
export function detectPromptInjection(text, options = {}) {
	const patterns = options.tier === "strong" ? INJECTION_STRONG : INJECTION_PATTERNS;
	const hits = [];
	let m;
	for (const re of patterns) {
		re.lastIndex = 0;
		while ((m = re.exec(text)) !== null) {
			hits.push({
				pattern: String(re).slice(0, 60),
				strong: INJECTION_STRONG.includes(re),
				excerpt: redact(text.slice(Math.max(0, m.index - 60), m.index + 100).replace(/\s+/g, " "))
			});
			if (hits.length >= 8) return hits;
		}
	}
	return hits;
}

/**
 * @param {{rel:string,path:string,size:number}[]} files
 * @param {object} [options] {maxFiles, maxFileBytes, maxHitsPerKind}
 * @returns {{severity, hits, combos, counts, density, scanned, skipped, coverage, summary}}
 */
export async function scanTree(files, options = {}) {
	const opts = { maxFiles: 600, maxFileBytes: 512 * 1024, maxHitsPerKind: 5, maxTotal: 80, ...options };
	const hits = [];
	const scanned = [];
	const skipped = [];
	/* counts = **样本**命中数（受 maxHitsPerKind 截断，只说明「看过几条」）；
	   density = **跨文件**精确计数（这类能力在几个文件里出现过）。两者别混用。 */
	const counts = Object.create(null);
	const density = Object.create(null);

	const candidates = files
		.filter((f) => !SKIP_PATH.test(f.rel))
		.sort((a, b) => a.size - b.size);

	for (const file of candidates) {
		if (scanned.length >= opts.maxFiles || hits.length >= opts.maxTotal) {
			skipped.push({ rel: file.rel, reason: "扫描上限" });
			continue;
		}
		const artifact = BUILD_ARTIFACT.test(file.rel);
		if (file.size > opts.maxFileBytes) {
			/* R33：构建产物被跳过时要说清是哪一类 —— 只写「文件过大」会让人以为漏扫了源码 */
			skipped.push({
				rel: file.rel,
				reason: (artifact ? "构建产物 / 打包文件" : "文件") + "过大（" + Math.round(file.size / 1024) + " KiB），未扫"
			});
			continue;
		}
		const isCode = CODE_EXT.test(file.rel);
		const isPy = PY_EXT.test(file.rel);
		const isText = TEXT_EXT.test(file.rel);
		if (!isCode && !isPy && !isText) continue;
		let text;
		try {
			text = await readFile(file.path, "utf8");
		} catch {
			skipped.push({ rel: file.rel, reason: "读取失败" });
			continue;
		}
		scanned.push(file.rel);
		const lineOf = lineIndex(text);
		/* 这个文件里出现过哪些类别 —— 循环结束后每个类别给 density +1（精确、不截断）。 */
		const kindsHere = new Set();

		/* R33：JS 走 RULES，Python 走 PY_RULES —— 两套正则互不串味
		   （把 JS 规则套到 .py 上会凭空造出命中，反过来也一样）。 */
		const rules = isCode ? RULES : isPy ? PY_RULES : null;
		if (rules) {
			for (const rule of rules) {
				rule.re.lastIndex = 0;
				let m;
				while ((m = rule.re.exec(text)) !== null) {
					/* ⚠️ R5：**不要**拿 counts 当「密度」用。counts 被 maxHitsPerKind 截断，
					   实测 dsh-our-free-model 的 counts 显示 5，真实是 74 个文件都在发网络请求 ——
					   一条 fetch 和满仓库 fetch，在面板上长得一模一样。 */
					kindsHere.add(rule.kind);
					counts[rule.kind] = (counts[rule.kind] || 0) + 1;
					if ((counts[rule.kind] || 0) > opts.maxHitsPerKind) break;
					hits.push({
						kind: rule.kind,
						label: RISK_KIND_LABELS[rule.kind],
						/* 构建产物命中的严重度降一档：它仍然是命中（不隐藏），但不该跟手写代码同权重 */
						severity: artifact ? DOWNGRADE[rule.severity] || rule.severity : rule.severity,
						/* why：这条命中**凭什么是命中**。R4 加的 —— 没有它，误报和真事在面板上长得一样。 */
						why: (rule.why || null) && artifact ? rule.why + "（构建产物 / 打包文件，严重度已降一档）" : rule.why || null,
						buildArtifact: artifact || undefined,
						file: file.rel,
						line: lineOf(m.index),
						excerpt: excerptAt(text, m.index)
					});
					if (hits.length >= opts.maxTotal) break;
				}
				if (hits.length >= opts.maxTotal) break;
			}
		}
		/* 提示注入：SKILL.md 只认强句式（技能正文本来就是指令），README 认全部 */
		const isSkillDoc = /(^|\/)SKILL\.md$/i.test(file.rel);
		if (isSkillDoc || /(^|\/)README\.md$/i.test(file.rel)) {
			const found = detectPromptInjection(text, { tier: isSkillDoc ? "strong" : "all" });
			for (const item of found) {
				kindsHere.add("prompt-injection");
				hits.push({
					kind: "prompt-injection",
					label: RISK_KIND_LABELS["prompt-injection"],
					severity: "high",
					file: file.rel,
					line: 1,
					excerpt: item.excerpt
				});
			}
		}

		/* 跨文件分布：一个文件算一次。注意 maxTotal 触顶后本文件剩余的规则不再扫描，
		   所以 density 是**下界**（只会少不会多）—— 方向是安全的。 */
		for (const kind of kindsHere) density[kind] = (density[kind] || 0) + 1;
	}

	// 组合信号：单看都不致命，凑一起就是「安装期外联执行」。
	const kinds = new Set(hits.map((h) => h.kind));
	const combos = [];
	if (kinds.has("install-script") && (kinds.has("network") || kinds.has("obfuscation"))) {
		combos.push({
			kind: "install-script+network",
			label: "安装脚本 + 网络/混淆",
			severity: "high",
			detail: "postinstall 里有网络请求或编码载荷：这是供应链投毒最典型的位置"
		});
	}
	if (kinds.has("child-process") && kinds.has("network")) {
		combos.push({
			kind: "child-process+network",
			label: "子进程 + 网络",
			severity: "high",
			detail: "能下载并执行：把它当成「你在本机替它跑任意命令」来评估"
		});
	}
	if (kinds.has("native")) {
		combos.push({
			kind: "native-module",
			label: "原生模块",
			severity: "medium",
			detail: "含 .node / node-gyp：二进制不在静态审查范围内，只能靠来源可信"
		});
	}
	/* 打包产物特征（R5）：把依赖 / 前端 bundle 一起提交的仓库，会让同一类命中铺满几十个文件。
	   这种数据人不可能逐条看，也不该像以前那样只显示「×5」。折成一条，并指明该看什么。
	   severity 用 low：它本身不是风险，只是「命中清单要换个读法」。 */
	const denseKinds = Object.entries(density)
		.filter(([, n]) => n >= 10)
		.sort((a, b) => b[1] - a[1]);
	const denseFiles = denseKinds.reduce((sum, [, n]) => sum + n, 0);
	if (scanned.length >= 20 && denseKinds.length >= 3 && denseFiles >= 40) {
		combos.push({
			kind: "bundle-payload",
			label: "打包产物特征",
			severity: "low",
			detail:
				"同类能力散布在很多文件里（" +
				denseKinds.slice(0, 6).map(([kind, n]) => (RISK_KIND_LABELS[kind] || kind) + " " + n + " 个文件").join("、") +
				"）：这是把依赖/bundle 一起提交的仓库，逐条命中意义有限 —— 重点看发布者可信度、安装期脚本，以及它到底要联网/执行什么"
		});
	}

	let severity = "none";
	const order = ["low", "medium", "high"];
	for (const item of [...hits, ...combos]) {
		if (order.indexOf(item.severity) > order.indexOf(severity)) severity = item.severity;
	}

	/* R33：**扫描覆盖**。以前「没有命中」被一律念成「未发现危险能力特征」——
	   可真样本 Tideglass（8 个 .py）一个字都没扫，摘要照样是这句话。
	   这就是 R29 那条纪律的复发：**读不到 ≠ 通过**。所以把「有没有扫到源码」算出来。
	   ⚠️ 构建产物（`*.min.js` / `dist/`）**不算进分母**：它不是源码，跳过它是刻意的，
	   算进去只会让「没扫全」这句话自己变成噪音。 */
	const scannedSet = new Set(scanned);
	const sourceFiles = candidates.filter((f) => SOURCE_EXT.test(f.rel) && !BUILD_ARTIFACT.test(f.rel));
	const unscannedSource = sourceFiles.filter((f) => !scannedSet.has(f.rel)).map((f) => f.rel);
	const coverage = {
		sourceFiles: sourceFiles.length,
		scannedSource: sourceFiles.length - unscannedSource.length,
		unscannedCount: unscannedSource.length,
		unscanned: unscannedSource.slice(0, 8),
		complete: unscannedSource.length === 0
	};

	return {
		severity,
		hits,
		combos,
		counts,
		density,
		scanned,
		skipped,
		coverage,
		summary: summarize(hits, combos, density, coverage)
	};
}

/**
 * 一行摘要。**用 density（跨文件精确数），不用被截断的 hits** ——
 * 否则「1 个文件有 fetch」和「74 个文件都有 fetch」显示成同一句话。
 *
 * R33：没有命中时**不能说「未发现危险能力特征」**，除非真的把源码扫完了。
 */
function summarize(hits, combos, density, coverage = null) {
	const byKind = new Map();
	for (const h of hits) byKind.set(h.kind, (byKind.get(h.kind) || 0) + 1);
	const hasDensity = density && Object.keys(density).length > 0;
	const entries = hasDensity ? Object.entries(density).sort((a, b) => b[1] - a[1]) : [...byKind.entries()];
	const unit = hasDensity ? " 个文件" : " 条样本";
	const parts = entries.map(([kind, n]) => (RISK_KIND_LABELS[kind] || kind) + "(" + n + unit + ")");
	if (combos.length > 0) parts.push("组合信号×" + combos.length);
	if (parts.length > 0) return parts.join("、");
	if (coverage && !coverage.complete && coverage.sourceFiles > 0) {
		return (
			"没有扫出危险特征 —— 但源码没扫全（" +
			coverage.scannedSource + "/" + coverage.sourceFiles + " 个源文件，未扫 " +
			coverage.unscannedCount + " 个）"
		);
	}
	return "未发现危险能力特征";
}

/** package.json 的安装期脚本，单独抽出来（它们不在代码扫描范围内）。 */
export function installScripts(manifest) {
	const scripts = (manifest && manifest.scripts) || {};
	const names = ["preinstall", "install", "postinstall", "prepare", "prepublishOnly"];
	const out = [];
	for (const name of names) {
		if (typeof scripts[name] === "string" && scripts[name].trim() !== "") {
			out.push({ name, command: redact(scripts[name]).slice(0, 400) });
		}
	}
	return out;
}
