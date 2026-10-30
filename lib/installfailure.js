/**
 * installfailure.js — 「装不上」时到底哪里坏了、下一步点哪儿（R9）。
 *
 * 为什么需要它：pnpm 失败时只吐一段英文输出，宿主把它原样当 Error 抛上来
 * （`throw new Error(run.output)`），管理层的拒绝更狠 —— `new ManagementFailure("incompatible-version")`
 * 的 message 就是那个码本身。面板以前把这段原文贴进红字：用户看得见「失败了」，
 * 看不见「为什么、然后呢」。这一轮把那两块补齐。
 *
 * 三类事实来源全部来自**宿主契约**（不猜、不自造判据）：
 *  ① pnpm 失败分类：次序与正则照抄宿主 dsh-plugin-manager 的 `LOG_KINDS`
 *     （build-blocked / not-found / no-matching-version / disk-full / permission /
 *      integrity / unknown / network），另补 timeout 与 pnpm-missing 两条宿主同语义的判断；
 *  ② 管理拒绝码：`ManagementFailure.code`（incompatible-version / already-installed /
 *     ambiguous-install / not-bundle / invalid-spec / stale-approval / …）；
 *  ③ 安装脚本待批准：pnpm 拒绝执行构建脚本时，宿主机把包名以哨兵值
 *     `"set this to true or false"` 写进 **profile 的 pnpm-workspace.yaml → allowBuilds**；
 *     用户明确批准后再装时，通过 `installBundle(spec, { approvedBuilds })` 交给宿主。
 *
 * 只做纯判断与文案，不写盘、不 spawn —— 所以 hosttest / audit 可以直接调它。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { injectFixLine, servicesFromHostError } from "./inject.js";

/** 宿主给「还没决定的构建脚本」留的哨兵值（照抄 dsh-plugin-manager 的 UNDECIDED_BUILD）。 */
export const UNDECIDED_BUILD = "set this to true or false";

/** pnpm 在非交互运行里点名它跳过了哪些构建脚本。 */
const IGNORED_BUILDS = /\bIgnored build scripts: (.+)/;

/**
 * pnpm 11 的供应链信任策略拒绝（`trustPolicy: no-downgrade`）。
 *
 * 原文长这样（2026-10-28 真实输出）：
 *   [ERR_PNPM_TRUST_DOWNGRADE] High-risk trust downgrade for "chromium-bidi@157.0.8090-0" (possible package takeover)
 *   This error happened while installing the dependencies of dsh-vision-router@3.1.0
 *    at puppeteer-core@25.16.0
 *   Trust checks are based solely on publish date, not semver. …
 *
 * 为什么值得单独拎出来：被点名的包**常常跟你要装的插件毫无关系**（它是别的插件的传递依赖）。
 * 面板以前把这种失败归到 `unknown`，用户只能看到「认不出原因」——这次真正的原因。
 */
const TRUST_DOWNGRADE_FOR = /TRUST_DOWNGRADE\][^\n]*?for\s+"([^"@]+(?:@[^"]+)?)"/i;
const TRUST_CHAIN = /installing the dependencies of\s+([^\s@]+@[^\s]+)\s*\n?\s*at\s+([^\s@]+@[^\s]+)/i;

/** @returns {{package:string, version:string|null, entry:string, root:string|null, via:string|null}|null} */
export function parseTrustDowngrade(output) {
	const text = String(output || "");
	if (!/ERR_PNPM_TRUST_DOWNGRADE/i.test(text)) return null;
	const raw = TRUST_DOWNGRADE_FOR.exec(text)?.[1] || "";
	const chain = TRUST_CHAIN.exec(text);
	const at = raw.startsWith("@") ? raw.indexOf("@", 1) : raw.indexOf("@");
	const name = at === -1 ? raw : raw.slice(0, at);
	const version = at === -1 ? null : raw.slice(at + 1);
	if (!name) {
		return { package: "", version, entry: "", root: chain ? chain[1] : null, via: chain ? chain[2] : null };
	}
	/* 豁免条目默认精确到版本（范围越小越好）；拿不到版本就只豁免这个包 */
	return {
		package: name,
		version,
		entry: version ? name + "@" + version : name,
		root: chain ? chain[1] : null,
		via: chain ? chain[2] : null
	};
}

/**
 * 宿主的分诊表：次序有意义（先具体后笼统），与 dsh-plugin-manager 一致。
 * 改这张表等于改判据 —— 要同步改那里的 LOG_KINDS，否则同一个失败两边说法不同。
 */
const LOG_KINDS = [
	["build-blocked", /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/],
	["trust-downgrade", /ERR_PNPM_TRUST_DOWNGRADE/],
	/* R35：宿主给 pnpm 传了 `minimumReleaseAge`（太新的版本不自动装）。策略触发会有 6 条
	   「resolution-policy violations」，而宿主这条调用路径**没接 pnpm 要求的回调** →
	   pnpm 直接抛这个码。2026-10-30 实测：升级 @liustack/modsearch 时**连卸载旧版都失败**。
	   这不是要装的那个插件的问题，也不是本面板的判据 —— 但面板必须说清楚，否则人只会看到
	   一段 pnpm 内部报错 + 一句「卸载旧版失败：✓ Lockfile passes…」（那行是**成功**信息，误导）。 */
	["resolution-policy", /ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED|handleResolutionPolicyViolations/],
	["not-found", /ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - GET/],
	["no-matching-version", /ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version/],
	["disk-full", /\bENOSPC\b|no space left on device/i],
	["permission", /\bEACCES\b|\bEPERM\b|permission denied/i],
	["integrity", /ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|\bEINTEGRITY\b/],
	["unknown", /The requested URL returned error: 40[134]\b/],
	["network", /\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|\bFETCH_ERROR\b|socket hang up|Could not resolve host|unable to access/]
];

/** pnpm 输出里点名的「跳过了这些包的构建脚本」。 */
export function ignoredBuildNames(output) {
	const reported = IGNORED_BUILDS.exec(String(output || ""))?.[1];
	if (reported === undefined) return [];
	const names = reported
		.split(/[,\n]/)
		.map((part) => part.trim().replace(/^["']|["']$/g, ""))
		.filter((name) => name !== "" && !/^\+/.test(name));
	/* pnpm 会写成 "a, b" 或 "a b"；名字里不会有空格，遇到空格再切一次 */
	return [...new Set(names.flatMap((name) => (/\s/.test(name) ? name.split(/\s+/) : [name])).filter(Boolean))];
}

function unquote(value) {
	const text = String(value || "").trim();
	if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith("\"") && text.endsWith("\"")))) {
		return text.slice(1, -1);
	}
	return text;
}

function noteValue(name, rawValue, pending, decided) {
	const value = unquote(rawValue).trim();
	if (value === UNDECIDED_BUILD) pending.push(name);
	else if (/^true$/i.test(value)) decided[name] = true;
	else if (/^false$/i.test(value)) decided[name] = false;
	else if (/^["']/.test(rawValue.trim())) decided[name] = value;
	/* 其它（空值、注释残留）既不待批准也不决定 —— 保持沉默，不编 */
}

/**
 * 读 pnpm-workspace.yaml 的 allowBuilds 块。
 *
 * 不引入 YAML 依赖：这个块只有两级、每行一条 `name: true|false|"<哨兵>"`，
 * 行扫描足够，而且**读坏不炸** —— 面板不该因为一个手改的缩进而整块失联。
 *
 * @param {string} text 文件原文
 * @returns {{pending: string[], decided: Record<string, boolean>, malformed: boolean}}
 */
export function parseAllowBuilds(text) {
	const pending = [];
	const decided = {};
	let malformed = false;
	const lines = String(text || "").split(/\r?\n/);
	let inBlock = false;
	let blockIndent = -1;
	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		const trimmed = line.trim();
		if (!inBlock) {
			const opened = /^(\s*)allowBuilds\s*:\s*(.*)$/.exec(line);
			if (!opened) continue;
			inBlock = true;
			blockIndent = opened[1].length;
			const inline = opened[2].trim();
			/* 一行写法 allowBuilds: {a: true, b: false} —— 认，但不强求 */
			if (inline.startsWith("{")) {
				for (const pair of inline.replace(/^\{|\}$/g, "").split(",")) {
					const [key, ...rest] = pair.split(":");
					if (!key || rest.length === 0) continue;
					noteValue(unquote(key), rest.join(":"), pending, decided);
				}
			}
			continue;
		}
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;
		if (indent <= blockIndent) {
			inBlock = false;
			continue;
		}
		const entry = /^([^:#]+?):(.*)$/.exec(trimmed);
		if (!entry) {
			malformed = true;
			continue;
		}
		noteValue(unquote(entry[1]), entry[2], pending, decided);
	}
	return { pending: [...new Set(pending)], decided, malformed };
}

/**
 * 从 profile 里读「哪些包的安装脚本还在等决定」。
 * 宿主把这份记录写在 profile 的 pnpm-workspace.yaml（它是撤销安装时要还原的三件套之一）。
 *
 * @param {string|null} profileDirPath
 * @returns {Promise<{ok:boolean, file:string|null, pending:string[], decided:object, error?:string}>}
 */
export async function readBuildPolicy(profileDirPath) {
	if (!profileDirPath) return { ok: false, file: null, pending: [], decided: {}, error: "读不到 profile 目录" };
	const file = join(profileDirPath, "pnpm-workspace.yaml");
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		return { ok: false, file, pending: [], decided: {}, error: String((e && e.message) || e) };
	}
	const parsed = parseAllowBuilds(text);
	return { ok: true, file, pending: parsed.pending, decided: parsed.decided, malformed: parsed.malformed };
}

/**
 * pnpm 这次失败属于哪一类（次序照抄宿主，命中即返回）。
 * @param {{output?:string, timedOut?:boolean, errno?:string|null}} facts
 */
export function classifyPnpmFailure(facts = {}) {
	const output = String(facts.output || "");
	if (facts.timedOut === true) return "timeout";
	if (facts.errno === "ENOENT") return "pnpm-missing";
	for (const [kind, pattern] of LOG_KINDS) if (pattern.test(output)) return kind;
	return "unknown";
}

/**
 * 从一段 pnpm 输出里挑出**真正该给人看的那一行**（R35）。
 *
 * 为什么需要：`Job.upgrade.removal.error` 存的是 pnpm 的**整段输出**，而面板以前把它整段
 * 塞进「卸载旧版失败：」后面 —— 于是红点上出现的是
 * `卸载旧版失败：✓ Lockfile passes supply-chain policies (verified 54m ago)`
 * 那句**成功**信息，真正的原因（`[ERR_PNPM_…]`）被埋在中间，人和模型都不知道该看哪。
 *
 * 判据（确定性）：优先 `ERR_PNPM_` / `Error:` / `✖` 开头的行；否则取最后一个非空行；
 * 都没有才退回整段的第一行。永远截到 300 字。
 *
 * @returns {{kind:string, line:string|null, title:string|null, plain:string|null, hint:string|null, fix:Array}}
 */
export function explainPnpmOutput(output) {
	const text = String(output || "");
	const kind = classifyPnpmFailure({ output: text });
	const info = KIND_TEXT[kind] || KIND_TEXT.unknown || null;
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !/^Progress:/i.test(line) && !line.startsWith("✓"));
	const pick =
		lines.find((line) => /ERR_PNPM_|^Error:|^✖|^× /.test(line)) ||
		lines[lines.length - 1] ||
		null;
	return {
		kind,
		line: pick ? (pick.length > 300 ? pick.slice(0, 297) + "…" : pick) : null,
		title: info ? info.title : null,
		plain: info ? info.plain : null,
		hint: info ? info.hint || null : null,
		fix: info && Array.isArray(info.fix) ? info.fix : []
	};
}

const KIND_TEXT = {
	"resolution-policy": {
		title: "pnpm 的供应链策略（minimumReleaseAge）挡住了 —— 跟你装的这个插件无关",
		plain: "大白话：DSH 让 pnpm 装东西时带了条保护策略 ——「太新发布的版本先别自动装，等一等」。这次一解析依赖树就有 6 个版本还在这个窗口里，而宿主调 pnpm 的这条路径没接上策略回调，pnpm 于是直接报错收工。**跟你要装的那个插件本身无关，旧版也没被动过。**",
		hint: "最稳的是等一段时间再点升级；急着用就在 profile 里为那几个包加豁免（本机已有先例）",
		fix: [
			{ text: "等：这条策略就是「让新发布的版本先放一放」，过一阵子再点升级，通常自己就好了" },
			{ text: "急着要：把被挡住的 包@版本 加进 profile 的 pnpm-workspace.yaml → minimumReleaseAgeExclude（本机已有 dsh-ops@0.3.0、dsh-ffmpeg@0.7.3 两条先例）；改前先备份" },
			{ text: "不想动策略：就先不升级 —— 旧版本还在、能正常用（这次失败发生在「卸载旧版」之前，profile 一个字没改）" },
			{ text: "想查是哪几个版本被挡住：这条报错 pnpm 没有点名（它本该在回调里报），只能在装了受信任 pnpm 的终端里跑 pnpm install 看它列清单" }
		]
	},
	"build-blocked": {
		title: "pnpm 没有执行这些包的安装脚本（所以这次没装成）",
		plain: "大白话：这个插件要跑一段「安装时脚本」才能用（常见是编译原生模块、下载平台二进制）。宿主为了安全不让包自己随便跑脚本，于是 pnpm 直接失败了 —— 磁盘上什么都没装。",
		hint: "看一眼下面的包名：如果不是你认识的、或脚本内容看不懂，就别批准",
		fix: [
			{ text: "确认包名与脚本内容（面板会列出要跑脚本的包；来源不明的不要批）" },
			{ text: "确认无误 → 点「允许这些包跑安装脚本并重试」（会先把批准写进 profile，再重装）" },
			{ text: "不想给权限 → 换一个不需要构建脚本的版本，或者干脆不装" }
		]
	},
	"not-found": {
		title: "registry 上找不到这个包（404）",
		plain: "大白话：pnpm 去 npm 问「有这个包吗」，对方答「没有」。多半是名字拼错、版本号不存在，或者它其实在私有 registry 上。",
		hint: "先用面板搜索同一个功能，确认包名；私有包要先把 registry 配进 profile",
		fix: [
			{ text: "回面板搜索这个名字，看确切的包名（大小写、scope 都要对）" },
			{ text: "私有包：确认 profile 里的 .npmrc / registry 配置指向了能读到它的源" },
			{ text: "链接来自别人的安装命令 → 确认包还在（作者删包/改名都常见）" }
		]
	},
	"no-matching-version": {
		title: "这个版本号拿不到（被删了，或被 profile 的发布时间策略挡住）",
		plain: "大白话：包在，但你要的那一版问不到。要么那个版本已被作者撤回，要么它太新 —— profile 里配了「不装太新的版本」这类策略（minimumReleaseAge）。",
		hint: "去掉版本号装最新可用版，或者换一个早就发布过的版本",
		fix: [
			{ text: "把输入里的 @版本号 去掉，重装（让 npm 自己挑最新可用版）" },
			{ text: "确实要那个版本：等它过了发布时间策略的窗口，或在 profile 的 pnpm-workspace.yaml 里为这个包加 minimumReleaseAgeExclude" },
			{ text: "都不行：去 npm 页面看一眼它实际有哪些版本" }
		]
	},
	"trust-downgrade": {
		title: "pnpm 的供应链策略挡住了一次「可信度降级」（ERR_PNPM_TRUST_DOWNGRADE）",
		plain: "大白话：profile 里开了 trustPolicy: no-downgrade —— 同一个包，老版本有「可信发布者」证据、新版本没有，pnpm 就认为这可能是被人接管了包，于是**拒绝整次安装**。\n" +
			"注意：被点名的那个包通常**不是你要装的插件**，而是别的插件链上的传递依赖 —— 你要装的东西一点问题都没有，是这台机器上的策略把整次安装掐了。",
		hint: "先确认被点名的那个包是什么、为什么会被拉进来；核对过再决定「豁免这一个版本」还是「先钉住旧版」",
		fix: [
			{ text: "看清被点名的包与版本（下面「原始输出」第二行会写它是谁的依赖）" },
			{ text: "核对过、确认只是版本更新导致的证据缺失 → 点「豁免这个版本」（会写进 profile 的 trustPolicyExclude，面板二次确认）" },
			{ text: "不想放松策略 → 把那条依赖钉回有可信证据的旧版（在 pnpm-workspace.yaml 的 overrides 里），或先卸载拉它进来的那个插件" },
			{ text: "你要装的是本机目录里的插件 → 改用「直连安装（不走 pnpm）」，这条路完全不碰依赖树" }
		]
	},
	"disk-full": {
		title: "磁盘满了（ENOSPC）",
		plain: "大白话：不是插件的问题，是本机这块盘写不下了 —— pnpm 解包到一半没地方放。",
		hint: "先腾出空间（profile 所在盘），再点「重试」",
		fix: [
			{ text: "看一眼 C 盘/工作区所在盘的剩余空间（面板的体检卡里也有）" },
			{ text: "清掉 data/staging 与旧的 snapshots（设置里能调快照保留数）" },
			{ text: "空间回来之后点「重试」" }
		]
	},
	"permission": {
		title: "写文件被拒绝（EACCES / EPERM）",
		plain: "大白话：pnpm 想改 profile 里的文件，被系统挡住了。最常见的原因是那个文件正被占用（DSH 自己、杀软、或另一个终端），其次是目录权限。",
		hint: "先确认没有第二个终端/程序在动 profile，再重试",
		fix: [
			{ text: "关掉其它正在跑 pnpm / dsh plugin 的窗口（一次只能有一个在写 profile）" },
			{ text: "杀软把 profile 目录锁住时：把 profile 加进白名单，或临时关掉实时扫描再试" },
			{ text: "还不行：重启 DSH 后再装（占用它的句柄会跟着消失）" }
		]
	},
	integrity: {
		title: "下载下来的包和 registry 给的校验值对不上（EINTEGRITY）",
		plain: "大白话：文件在传输路上坏了，或者本地缓存里存的是旧/坏的那份。装是肯定不能装的 —— 校验对不上就说明字节不对。",
		hint: "清掉 pnpm 本地缓存再重试，别绕过校验",
		fix: [
			{ text: "在终端跑一次 pnpm store prune（清本地 store 里的坏份）" },
			{ text: "回来点「重试」；还报就换网络（代理/镜像有时会改写响应）" },
			{ text: "连续两次都在同一个包上失败：这个包的发布可能本身有问题，换版本" }
		]
	},
	network: {
		title: "连不上 registry / 下载中断",
		plain: "大白话：pnpm 根本没拿到包 —— 网络层面就断了（DNS 解析不了、连接被重置、镜像超时）。跟插件本身没关系。",
		hint: "先确认能打开 npmjs 或你配的镜像，再重试",
		fix: [
			{ text: "浏览器打开 registry 地址，确认这台机器现在能访问它" },
			{ text: "用了代理/镜像：确认 profile 的 .npmrc 里的地址是对的（大包常被镜像截断）" },
			{ text: "网络修好后点「重试」" }
		]
	},
	timeout: {
		title: "等 pnpm 超时了",
		plain: "大白话：不是失败，是没等到 —— 包很大或网慢时 pnpm 还没跑完就被掐了。",
		hint: "网络状况好的时候重试一次",
		fix: [
			{ text: "点「重试」；大包（几十 MB 以上）第一次常常要跑久一点" },
			{ text: "反复超时：换一个体积小的等价插件，或先用 npm 手动装好再指路径" }
		]
	},
	"pnpm-missing": {
		title: "本机找不到 pnpm 可执行文件",
		plain: "大白话：宿主要用 pnpm 装东西，但它在 PATH 里没找到 pnpm —— 环境问题，换多少个插件都一样失败。",
		hint: "确认 pnpm 装着、并且 DSH 启动时的 PATH 里有它（装完要重启 DSH 才会带上新 PATH）",
		fix: [
			{ text: "在终端跑 pnpm -v，确认有输出" },
			{ text: "刚装完 pnpm：重启 DSH（进程环境变量不会热更新）" },
			{ text: "用 corepack 管理的 pnpm：确认 corepack enable 过" }
		]
	},
	unknown: {
		title: "pnpm 报错了，但这段输出里没有能认出的失败原因",
		plain: "大白话：装是失败了，可这段原文里没有 404 / 网络 / 权限 / 磁盘这些特征，判断不了是哪一类。下面把原始输出留全，别丢。",
		hint: "把「原始输出」整段复制给 AI，或先点「重新诊断」看 profile 现在的状态",
		fix: [
			{ text: "展开下面的原始输出，找第一个 ERR_PNPM_* 或 error 开头的行" },
			{ text: "先点「重新诊断」：有时上一次的残留已经修好了" },
			{ text: "把那段贴给 AI 时，带上「本机 DSH 版本 + 这次装的插件名」这两条" }
		]
	}
};

/** 宿主 ManagementFailure 的拒绝码 → 人话 + 下一步。 */
const CODE_TEXT = {
	"incompatible-version": {
		title: "插件声明的 DSH 版本不接受当前宿主，安装被拒",
		plain: "大白话：这份插件写明了「我支持哪几版 DSH」，你现在跑的版本不在里面 —— 宿主直接拒绝，磁盘上什么都没改。这不是网络问题，重试一百次也一样。",
		hint: "要么换一个匹配当前 DSH 的版本，要么接受风险去官方页面给它授权版本豁免",
		fix: [
			{ text: "去插件仓库/Release 找一版支持当前 DSH 的（看 package.json 的 engines.dsh 与 peerDependencies）" },
			{ text: "确实要用这一版：Settings → Plugins 里对 系统版本 给这个包授权豁免（会写明风险：可能崩溃、损坏数据）" },
			{ text: "不要为了装插件去降级 DSH —— 宿主降级的代价比少一个插件大得多" }
		]
	},
	"already-installed": {
		title: "这个包已经在 profile 的依赖里了（本次没有改动）",
		plain: "大白话：宿主判「装过没有」看的是依赖行里那串 spec，**不看文件内容**。所以同一个 spec 再装一次，它会直接回「已装」—— pnpm 一次都不跑。面板从 R13 起把版本号写进 vendor 包名（pkg-<名字>-<版本>.tgz），所以**真换了版本就是新 spec**，会正常替换；仍出现这条，说明这次提交的版本与已装的一致。",
		hint: "想升级：把插件版本号改高再提交；只想看现状：点「重新诊断」",
		fix: [
			{ text: "点「重新诊断」：看它现在到底在不在、起没起来（含 fiberPhase 判据）" },
			{ text: "要换版本：改 package.json 的 version 再提交（面板会把新版本写进包名，宿主才会替换）" },
			{ text: "怀疑上次装坏了：用「回滚到安装前」收干净再重装" }
		]
	},
	"ambiguous-install": {
		title: "装完之后依赖里多出来不止一个包，分不清这次装的是哪个",
		plain: "大白话：宿主用「装前/装后的依赖差异」判断装进来的是谁。这次差异不是恰好一个，它就不敢认 —— 于是拒绝收尾。",
		hint: "看一眼回执里的 dependencies 差异；实在分不清就回滚后单独装一次",
		fix: [
			{ text: "展开「插件管理器回执」，看 dependencies 里多了哪些名字" },
			{ text: "回滚这次，然后一次只装一个插件（别在同一个 profile 里同时跑两处安装）" },
			{ text: "仍然莫名多包：检查 profile 的 package.json 是不是被别的工具同时改过" }
		]
	},
	"not-bundle": {
		title: "它不是 DSH 插件包（没有 dsh.bundle 声明）",
		plain: "大白话：这个包能装进 node_modules，但它没声明自己是 DSH 插件，所以宿主不会去加载它 —— 装了也不会有任何界面/工具出现。",
		hint: "它可能是普通 npm 库或一个 Skill；Skill 请用「技能」那条路装",
		fix: [
			{ text: "确认来源：插件仓库的 README 一般会写「这一步之后 Settings → Plugins 里勾上」" },
			{ text: "如果是 Skill（有 SKILL.md）：改用技能安装那一条路（面板会自动识别）" },
			{ text: "如果它是给人手动跑的 CLI：那就不该用插件面板装" }
		]
	},
	"invalid-spec": {
		title: "这段内容不是合法的包名 / 路径参数",
		plain: "大白话：传给包管理器的参数不合法（空、或以 - 开头）—— 多半是输入被截断或带了奇怪的前缀。",
		hint: "重新粘一次完整链接或包名",
		fix: [
			{ text: "检查输入有没有被截断（长链接常被聊天软件折行）" },
			{ text: "包名不要带引号、不要在开头加 -" }
		]
	},
	"stale-approval": {
		title: "你要批准的包已经不在「待批准」列表里了",
		plain: "大白话：批准动作要落在一条仍然有效的待办上。这条已经不在了 —— 多半别的操作先处理掉了，或者那次记录已被回滚。",
		hint: "点「重新诊断」看现在真实状态，再决定要不要重装",
		fix: [
			{ text: "点「重新诊断」，确认这次安装现在的实际结果" },
			{ text: "面板设置里再点一次「允许并重试」（会重新读 pending 列表）" },
			{ text: "手改过 pnpm-workspace.yaml：确认 allowBuilds 里还有那几条待决项" }
		]
	},
	"management-required": {
		title: "这个包属于插件管理器本身，不能从这里装 / 卸",
		plain: "大白话：宿主把管理器自己（以及它的依赖）标成了「只读」—— 动它会把管理能力本身搞坏，所以直接拒绝。",
		hint: "它不是普通插件，别在这里装/卸/换版本",
		fix: [
			{ text: "确认你确实想装的是这个包（管理器相关包名很像普通插件）" },
			{ text: "管理器自身升级：走 DSH 升级，不要在 profile 里单独换" }
		]
	},
	"stop-profile": {
		title: "要先停掉 profile 才能做这一步",
		plain: "大白话：宿主认为还有进程在用那份包，所以现在不让改。",
		hint: "重启 DSH 后再装",
		fix: [
			{ text: "关掉 DSH（含托盘）再打开" },
			{ text: "回来点「重试」" }
		]
	},
	"bundle-in-use": {
		title: "这个 bundle 正被运行中的进程使用",
		plain: "大白话：它已经加载进当前 DSH 进程了，边跑边换文件会出问题，宿主因此拒绝。",
		hint: "重启 DSH 之后再装新版本",
		fix: [
			{ text: "先重启 DSH（不是刷新页面）" },
			{ text: "再回来装；装完还要再重启一次才生效" }
		]
	},
	"not-removable": {
		title: "宿主不允许卸载这个包",
		plain: "大白话：它是内置/必需的，清单里没有「卸载」这个选项。",
		hint: "可以停用它，但不能卸载",
		fix: [
			{ text: "在插件页把它停用（而不是卸载）" },
			{ text: "如果它坏了：跑「一键体检修复」，别硬删" }
		]
	},
	unaddressable: {
		title: "宿主认不出这个插件行",
		plain: "大白话：这一行在清单里没有可定位的 id，宿主没法对它做操作。",
		hint: "重启后再看一次；仍如此就检查 profile 的 cordis.patch.yml 有没有手改坏的行",
		fix: [
			{ text: "重启 DSH 后点「重新诊断」" },
			{ text: "打开 profile 的 cordis.patch.yml，看有没有缺 id 或重复 id 的行" }
		]
	}
};

/**
 * 把一次失败翻译成「为什么 + 下一步」。
 *
 * @param {object} input
 * @param {string} [input.code]        ManagementFailure 的 code（宿主拒绝时才有）
 * @param {string} [input.message]     原始错误文本（pnpm 输出或 code 本身）
 * @param {string} [input.output]      pnpm 原始输出（给了就用它做分诊）
 * @param {string} [input.errno]       spawn 的 errno（ENOENT → 没装 pnpm）
 * @param {boolean} [input.timedOut]
 * @param {Array} [input.incompatible] 宿主 incompatible-version 带出的包信息
 * @param {string[]} [input.pendingBuilds] 已知的待批准包名（宿主或 profile 给的）
 * @returns {{code:string|null, kind:string, title:string, plain:string, hint:string,
 *            fix:Array<{text:string}>, pendingBuilds:string[], canApproveBuilds:boolean,
 *            incompatible:Array, raw:string}}
 */
export function describeInstallFailure(input = {}) {
	const code = input.code ? String(input.code) : null;
	const message = String(input.message || "");
	const output = String(input.output || message || "");
	const incompatible = Array.isArray(input.incompatible) ? input.incompatible : [];
	const given = (Array.isArray(input.pendingBuilds) ? input.pendingBuilds : []).map(String).filter(Boolean);
	let kind = classifyPnpmFailure({ output, timedOut: input.timedOut, errno: input.errno });

	/* 宿主拒绝码优先于 pnpm 分诊：拒绝对应的 message 就是那个码，不可能是 pnpm 输出 */
	const byCode = code && CODE_TEXT[code] ? code : null;
	if (byCode) kind = "management:" + byCode;

	let pending = given.length > 0 ? given : ignoredBuildNames(output);
	/* 管理拒绝但输出里没点名：用 profile 里现成的待批准名单兜底 */
	if (pending.length === 0 && (byCode === null || byCode === "stale-approval")) {
		pending = (Array.isArray(input.policyPending) ? input.policyPending : []).map(String).filter(Boolean);
	}
	/* 有明确的待批准包名，就是 build-blocked —— 哪怕输出里没写出那句英文 */
	if (pending.length > 0 && !byCode) kind = "build-blocked";
	const canApproveBuilds = pending.length > 0 && pending.every((name) => !/[*?]/.test(name));

	/* R13：**激活失败**是另一类故障，别和 pnpm 失败混为一谈。
	   实证（2026-10-21 dsh-imgops）：pnpm exit 0、包已写进 profile，宿主在 apply 阶段抛
	   `cannot get property "tools" without inject` —— 面板当时说「package manager 报告安装失败」，
	   完全指错了方向（重装一百次也不会好，要改的是插件入口的一行声明）。 */
	const diagnostic = String(input.diagnostic || "");
	const activationBroken = /did not activate|without inject/i.test(diagnostic);

	let text = byCode ? CODE_TEXT[byCode] : KIND_TEXT[kind] || KIND_TEXT.unknown;
	if (activationBroken) {
		const services = servicesFromHostError(diagnostic);
		const guess = services.length > 0
			? injectFixLine(services, [])
			: "在 apply 所在的那个文件顶部加 export const inject = ['<服务名>']，把 apply 里用到的服务都列上";
		kind = "activation-failed";
		text = {
			title: "插件装上了，但没激活：" + (services.length > 0 ? "少了 inject 声明（" + services.join("、") + "）" : "启动时抛错"),
			plain: "大白话：包已经写进 profile、清单里也认得它 —— 但宿主**启动这一行**的时候失败了，所以它的工具/命令/界面一个都不会出现。\n" +
				"宿主原话：" + diagnostic.slice(0, 600) + "\n" +
				"最常见的原因就差一行声明：代码里用了某个 ctx.服务，可入口文件没写 export const inject = [那个服务名]（Cordis 不许取没声明的服务）。",
			hint: "这不是安装失败，是插件自己要改一行；重装一百次也一样",
			fix: [
				{ text: guess },
				{ text: "改完重新打包安装（或让作者发新版），重启 DSH 后点「重新诊断」确认这条消失" },
				{ text: "不想改代码：先「回滚到安装前」把它卸掉，别让它每次启动都报 warning" }
			]
		};
	}
	if (kind === "build-blocked" && canApproveBuilds) {
		text = {
			title: "这些包的安装脚本要你点头才跑：" + pending.join("、"),
			plain: "大白话：它们装的时候要跑一段脚本（常常是编译原生模块、下平台二进制）。宿主不让包自己偷偷跑，所以这次装到一半停了 —— 你批准之后才会真正装成。",
			hint: "不认识的包名不要批；批准等于让它在本机执行作者写的脚本",
			fix: [
				{ text: "看清楚要跑脚本的包名与来源（不确定就先去 npm 页面看它是什么）" },
				{ text: "确认无误 → 点「允许这些包跑安装脚本并重试」" },
				{ text: "不想给这个权限 → 换一个不需要构建脚本的版本，或者不装" }
			]
		};
	}
	if (pending.length > 0 && !canApproveBuilds) {
		text = {
			title: "安装脚本待批准，但里面有通配符，面板不能逐条批准",
			plain: "大白话：pnpm 只允许对具体的包名做批准，通配规则（含 * 或 ?）没法单独点头，所以这条路得人工处理。",
			hint: "去 profile 的 pnpm-workspace.yaml 把那条通配改成具体包名，再回来重试",
			fix: [
				{ text: "打开 profile 的 pnpm-workspace.yaml，找到 allowBuilds 里的通配项" },
				{ text: "改成具体包名（列表就在下面）配 true/false" },
				{ text: "回来点「重试」" }
			]
		};
	}
	if (byCode === "incompatible-version" && incompatible.length > 0) {
		const parts = incompatible.map((item) => {
			const req = item && item.requirements ? Object.entries(item.requirements).map(([k, v]) => k + " " + v).join("；") : "";
			return (item && item.name ? item.name + (item.version ? "@" + item.version : "") : "?") + (req ? "（要求 " + req + "）" : "");
		});
		text = {
			...text,
			title: "宿主拒绝：" + parts.join("、") + " 不接受当前 DSH 版本",
			plain: text.plain + "（具体不满足的是 " + parts.join("、") + "）"
		};
	}
	/* R31：信任度降级。把「是哪个包、它又是被谁拉进来的」写进标题与大白话 ——
	   这条失败最常见的误解是「我要装的插件有问题」，而它十有八九是别的插件的传递依赖。 */
	const trust = parseTrustDowngrade(output);
	let trustAction = null;
	if (kind === "trust-downgrade" && trust) {
		const who = trust.package ? trust.package + (trust.version ? "@" + trust.version : "") : "某个包";
		const chain = trust.root && trust.via ? "（它是 " + trust.root + " → " + trust.via + " 的传递依赖）" : "";
		const target = input.targetName ? "「" + String(input.targetName) + "」" : "你要装的东西";
		text = {
			title: "pnpm 供应链策略拒绝了 " + who + " 的新版本 —— 整次安装被掐，跟" + target + "本身无关",
			plain: "大白话：profile 里开了 trustPolicy: no-downgrade。同一个包，旧版本有「可信发布者」证据、" +
				"新版本没有，pnpm 就当成可能被人接管，于是**拒绝整次安装**（一个包被拒，整棵树都不装）。\n" +
				"被点名的是 " + who + chain + " —— 不是" + target + "。\n" +
				"所以换插件、重试一百次都不会好：要动的是这条策略的豁免名单，或者把那个依赖钉回旧版。",
			hint: "先确认 " + who + " 是什么、为什么会被拉进来；核对过再豁免这一个版本",
			fix: [
				{ text: "核对 " + who + "：它应当只是版本更新导致的「可信证据缺失」，不是真的被人接管" },
				{ text: "核对无误 → 点「豁免这个版本」（面板会把下面这行写进 profile 的 pnpm-workspace.yaml，写前备份、二次确认）：" },
				{ text: "    trustPolicyExclude:", command: null },
				{ text: "      - " + (trust.entry || who), command: null },
				{ text: "不想放松策略 → 在 pnpm-workspace.yaml 的 overrides 里把 " + (trust.package || "它") + " 钉回有可信证据的旧版，或先卸载拉它进来的插件" },
				{ text: "要装的是本机目录里的插件 → 改用「直连安装（不走 pnpm）」：不重算依赖树，这条路根本不会碰到它" }
			]
		};
		trustAction = { kind: "add-trust-exclude", entry: trust.entry || who, package: trust.package || null, version: trust.version || null, label: "豁免 " + (trust.entry || who) };
	}
	/* 码认不出、pnpm 也认不出：保留原文，但至少给一句人话 */
	return {
		code,
		kind,
		title: text.title,
		plain: text.plain,
		hint: text.hint,
		fix: text.fix,
		pendingBuilds: pending,
		canApproveBuilds,
		incompatible,
		/* R13：`already-installed` 不是故障 —— 宿主只是说「它在依赖里了，这次没改动」。
		   面板据此把任务收成 done（并照常跑诊断），而不是让用户对着红色「安装失败」猜。 */
		noop: byCode === "already-installed",
		diagnostic: diagnostic || null,
		/* R31：信任度降级的结构化信息（哪个包、哪个版本、被谁拉进来、该写哪条豁免） */
		trust,
		/* 面板可以直接渲染成按钮的动作（目前只有「豁免这个版本」一种） */
		action: trustAction,
		raw: output.slice(0, 4000)
	};
}

/**
 * 体检用：profile 里还挂着待批准的构建脚本时给一条 finding。
 * 这是**跨任务**的残留 —— 上一次装失败留下的，不处理会挡住下一次装同一个依赖。
 */
export function pendingBuildFinding(policy) {
	const pending = (policy && Array.isArray(policy.pending) ? policy.pending : []).filter(Boolean);
	if (pending.length === 0) return null;
	const decided = (policy && policy.decided) || {};
	const decidedCount = Object.keys(decided).length;
	return {
		severity: "warn",
		title: pending.length + " 个包的安装脚本还在等你决定（profile 的 allowBuilds）",
		detail: "pnpm-workspace.yaml → allowBuilds 里这些键的值还是哨兵串（\"" + UNDECIDED_BUILD + "\"）：" +
			pending.join("、") + (decidedCount > 0 ? "。另有 " + decidedCount + " 条已经决定过（true/false）" : ""),
		plain: "大白话：这不会让 DSH 坏掉，但下次装「依赖这些包」的插件时会再失败一次 —— 因为它们的安装脚本还是「不知道跑不跑」。",
		fix: [
			{ text: "确定要给权限：在面板里装那个插件时点「允许这些包跑安装脚本并重试」" },
			{ text: "确定不给：把 pnpm-workspace.yaml 里这几条改成 false（跳过构建脚本）" },
			{ text: "不确定：先留着 —— 只有装相关插件时才会被这条挡住" }
		],
		action: null,
		codes: { pending, decided }
	};
}

export const __test = { KIND_TEXT, CODE_TEXT, LOG_KINDS };
