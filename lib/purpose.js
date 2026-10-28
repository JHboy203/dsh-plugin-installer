/**
 * purpose.js — 「按用途判断权限是否合理」（确定性，零 token）。
 *
 * 用户的诉求（2026-10-20 R3）：
 *   「能够根据插件与 skill 的用途，判断代码权限是否合理」
 *
 * 做法分两步，都不猜「善恶」，只回答「这份代码要的东西，跟它声称要做的事匹配吗」：
 *   ① **推断用途**：名字 / 描述 / README / SKILL.md frontmatter / 结构特征（有 client.js、
 *      有 ps/*.ps1、声明了 dsh.client/bundle）→ 归到一个用途档（界面、网络、媒体、运维、数据、Skill）。
 *   ② **对账能力**：把静态扫描识别出的能力（子进程、shell、网络、文件写、eval、混淆…）
 *      分成「这个用途正常需要 / 勉强说得过去 / 说不通」三类，给出结论与一句人话解释。
 *
 * 关键设计（都是刻意选的）：
 *   · **用途认不出来就不判**（verdict:"unknown"）。硬判会冤枉「混合型」插件，也会变成噪音。
 *   · **Skill 是最硬的一条**：它本质是说明文档，**不该带可执行文件**。带 .js/.ps1/.exe 直接 error。
 *   · **eval / vm / 混淆**在任何用途里都算「说不通」，因为没有任何 DSH 插件需要它们。
 *   · 结论分三档：ok（匹配）/ warn（略超范围）/ error（明显不符）。**只影响「要不要停下来问你」，不阻断安装。**
 */
import { RISK_KIND_LABELS } from "./scan.js";

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

/** 用途档。expected = 这个用途本来就该有的能力；tolerated = 勉强能解释；其余 = 说不通。 */
export const PURPOSES = {
	ui: {
		label: "界面 / 交互增强",
		keywords: [
			"侧栏", "sidebar", "主题", "theme", "字号", "字体", "typography", "面板", "panel", "折叠", "collapse",
			"markdown", "按钮", "button", "快捷键", "hotkey", "菜单", "menu", "通知", "toast",
			"样式", "css", "布局", "layout", "图标", "icon", "配色", "动画", "animation", "标签页", "tab"
		],
		/* R31：**界面档必须有客户端代码**（client.js 或 dsh.client 声明）。理由见 inferPurpose 里的注释：
		   宿主工具插件的描述里也常出现「面板/渲染/图标」这类词，只按关键词判会把它们判成界面档，
		   然后给一条「界面插件不该起子进程」的吓人结论 —— 用户自己写的工具插件就这样被误判过。 */
		requiresClient: true,
		expected: ["fs-read", "env-access"],
		tolerated: ["dynamic-load"]
	},
	tool: {
		label: "宿主工具 / 自动化（不在界面上）",
		keywords: [
			"工具", "tool", "宿主", "自动化", "cli", "命令", "脚本", "渲染", "playwright", "批量", "采集", "抓取",
			"导出", "巡检", "selfcheck", "selftest"
		],
		expected: ["fs-read", "fs-write", "child-process", "shell", "network", "env-access", "dynamic-load"],
		tolerated: ["native"]
	},
	net: {
		label: "网络 / 桥接 / 模型接入",
		keywords: [
			"api", "桥", "bridge", "代理", "proxy", "同步", "sync", "webhook", "搜索", "search", "联网",
			"远程", "remote", "隧道", "tunnel", "转发", "模型", "model-provider", "openai-compatible",
			"llm", "provider", "接入", "网关", "gateway", "下载", "download"
		],
		expected: ["network", "fs-read"],
		tolerated: ["env-access", "child-process", "fs-write"]
	},
	media: {
		label: "媒体 / 截图 / 识别",
		keywords: [
			"截图", "screenshot", "ocr", "录屏", "视频", "video", "ffmpeg", "音频", "audio", "图片", "image",
			"长截图", "字幕", "subtitle", "压缩", "转码", "encode", "裁剪", "cut"
		],
		expected: ["child-process", "shell", "fs-read", "fs-write"],
		tolerated: ["network", "env-access", "native"]
	},
	sysops: {
		label: "系统运维 / 体检 / 清理",
		keywords: [
			"体检", "清理", "备份", "backup", "health", "doctor", "磁盘", "disk", "注册表", "registry",
			"服务", "service", "计划任务", "scheduled", "卸载", "卸载器", "安装器", "installer", "venv",
			"进程", "process", "保活", "keepalive", "迁移", "migrate"
		],
		expected: ["child-process", "shell", "fs-read", "fs-write", "env-access"],
		tolerated: ["network", "native"]
	},
	data: {
		label: "数据处理 / 数据库 / 解析",
		keywords: [
			"数据库", "database", "sqlite", "leveldb", "解析", "parse", "统计", "stats", "提取", "extract",
			"导入", "import", "导出", "export", "报表", "report", "索引", "index", "存档", "world"
		],
		expected: ["fs-read", "fs-write"],
		tolerated: ["network", "child-process", "env-access"]
	},
	skill: {
		label: "Skill（说明 / 流程，不含执行代码）",
		skillOnly: true,
		expected: [],
		tolerated: []
	},
	unknown: { label: "用途未识别（不判）", unknown: true, expected: [], tolerated: [] }
};

const CODE_FILE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|ps1|psm1|bat|cmd|sh|py|exe|dll|node)$/i;

function lower(value) {
	return String(value || "").toLowerCase();
}

/**
 * 推断用途。
 * @param {{detected:object, scan:object, files?:Array}} input
 * @returns {{id:string, label:string, confidence:'high'|'medium'|'low', signals:string[]}}
 */
export function inferPurpose(input = {}) {
	const detected = input.detected || {};
	const payload = detected.payload || {};
	const manifest = payload.manifest || {};
	const meta = payload.meta || {};
	const scan = input.scan || {};
	const files = (input.files || scan.scanned || []).map((f) => f.rel || f);
	const signals = [];
	const text = lower(
		[
			detected.name,
			detected.description,
			manifest.name,
			manifest.description,
			manifest.keywords ? [].concat(manifest.keywords).join(" ") : "",
			meta.name,
			meta.description
		].join(" ")
	);

	/* Skill 直接定档：它按设计就该是纯说明。 */
	if (detected.kind === "skill") {
		const code = files.filter((rel) => CODE_FILE.test(String(rel)));
		signals.push("识别为 Skill（SKILL.md）");
		if (code.length > 0) signals.push("但目录里有可执行文件：" + code.slice(0, 4).join("、"));
		return { id: "skill", label: PURPOSES.skill.label, confidence: "high", signals, codeFiles: code };
	}

	/* 结构特征：比关键词硬。 */
	const scores = Object.create(null);
	const bump = (id, n, why) => {
		scores[id] = (scores[id] || 0) + n;
		if (why) signals.push(why);
	};
	const hasClientFile = files.some((rel) => /(^|\/)client\.js$/i.test(String(rel)));
	const declaresClient = Boolean(manifest.dsh && manifest.dsh.client);
	/* 「有客户端代码」是界面档的**必要证据**（R31）。宿主工具插件的描述里也常有
	   「面板 / 渲染 / 图标」这些词 —— 只按关键词判，就会把「跑 Playwright 渲染视频帧」
	   判成「界面增强」，然后告诉用户「界面插件不该起子进程」。本机真实踩过一次。 */
	const clientEvidence = hasClientFile || declaresClient;
	if (clientEvidence) bump("ui", 2, hasClientFile ? "含 client.js" : "声明了 dsh.client");
	if (files.some((rel) => /\.ps1$/i.test(String(rel)))) bump("sysops", 1, "含 .ps1 脚本（要 shell 才跑得动）");
	/* 声明 dsh.bundle = 它是**宿主插件**，跟「界面」无关（旧判据在这里给界面加过分，是误判来源之一） */
	if (manifest.dsh && manifest.dsh.bundle && !clientEvidence) {
		bump("tool", 2, "声明了 dsh.bundle 且没有客户端代码 → 宿主工具插件");
	}
	/* 注册了工具 = 它就是给人/给模型用的工具插件（静态契约扫描的结论，比描述可靠） */
	const toolDefs = Number((input.contract && input.contract.definitions) || 0);
	if (toolDefs > 0 && !clientEvidence) bump("tool", 2, "入口里注册了 " + toolDefs + " 个工具");
	if (/model-provider|openai-compatible|provider/.test(text)) bump("net", 2, "描述里提到 provider / 模型接入");

	/* 关键词命中：出现在名字/描述里权重更高。
	   R31：界面档要求客户端代码 —— 没有客户端代码时，界面关键词**不参与打分**
	   （但要留痕，否则「为什么没判成界面」会变成新的谜）。 */
	for (const [id, def] of Object.entries(PURPOSES)) {
		if (def.skillOnly || def.unknown) continue;
		let hits = 0;
		for (const kw of def.keywords || []) {
			if (text.includes(kw)) hits += 1;
		}
		if (hits === 0) continue;
		if (def.requiresClient && !clientEvidence) {
			signals.push("描述里有 " + hits + " 个界面关键词，但没有 client.js / dsh.client —— 不算界面档");
			continue;
		}
		bump(id, Math.min(4, hits), hits > 1 ? def.label + "：命中 " + hits + " 个关键词" : null);
	}

	let best = "unknown";
	let bestScore = 0;
	for (const [id, score] of Object.entries(scores)) {
		if (score > bestScore) {
			best = id;
			bestScore = score;
		}
	}
	if (best === "unknown") {
		return { id: "unknown", label: PURPOSES.unknown.label, confidence: "low", signals: ["名字/描述/结构里没有能定用途的信号"] };
	}
	const confidence = bestScore >= 3 ? "high" : bestScore >= 2 ? "medium" : "low";
	return { id: best, label: PURPOSES[best].label, confidence, signals };
}

/**
 * 对账：用途 vs 实际能力。
 * @returns {{purpose:object, present:string[], unexpected:Array, tolerated:Array, verdict:'ok'|'warn'|'error'|'unknown',
 *            score:number, summary:string, plain:string, findings:Array, advice:Array}}
 */
export function judgePurpose({ detected, scan, scripts, files, contract } = {}) {
	/* 文件清单可能来自调用方（pipeline 传 extract 结果），也可能只有 scan.scanned —— 两者都认，
	   否则「Skill 里带 .ps1」这条最硬的判据会静默失效（实测踩过：verdict 停在 ok）。 */
	const fileList = (files || (scan && scan.scanned) || []).map((f) => f.rel || f);
	const purpose = inferPurpose({ detected, scan, files: fileList, contract });
	const def = PURPOSES[purpose.id] || PURPOSES.unknown;
	const hits = (scan && scan.hits) || [];
	const scriptList = scripts || [];

	const present = new Set();
	const severityOf = Object.create(null);
	for (const hit of hits) {
		if (!hit || !hit.kind) continue;
		present.add(hit.kind);
		const w = SEVERITY_WEIGHT[hit.severity] || 1;
		severityOf[hit.kind] = Math.max(severityOf[hit.kind] || 0, w);
	}
	for (const s of scriptList) {
		present.add("install-script");
		severityOf["install-script"] = Math.max(severityOf["install-script"] || 0, 2);
	}

	const expected = new Set(def.expected || []);
	const tolerated = new Set(def.tolerated || []);
	/* 任何用途都不该出现的能力：eval / vm / new Function / 混淆。
	   没有 DSH 插件需要它们 —— 所以它们不是「越界」，而是「说不通」。
	   ⚠️ 标记要放进下面这个统一循环里；单独再补一轮只会漏（第一版就是这么漏的：eval 已经在
	   unexpected 里，补轮用 `!some(...)` 跳过，于是 never 标记永远没打上，判成 warn）。 */
	const NEVER = new Set(["eval", "vm", "obfuscation", "new-function"]);
	const unexpected = [];
	const toleratedList = [];

	for (const kind of present) {
		if (expected.has(kind)) continue;
		const label = RISK_KIND_LABELS[kind] || kind;
		if (tolerated.has(kind)) {
			toleratedList.push({ kind, label });
			continue;
		}
		unexpected.push({ kind, label, weight: severityOf[kind] || 1, never: NEVER.has(kind) });
	}
	unexpected.sort((a, b) => b.weight - a.weight);

	let score = unexpected.reduce((sum, u) => sum + u.weight, 0);

	/* eval / vm / 混淆 / new Function：**任何**用途里都算「明显不符」。
	   单独抬到 error 阈值以上 —— 否则单条 eval（权重 3）会被判成「略超范围」，那太宽松了。 */
	if (unexpected.some((u) => u.never)) score = Math.max(score, 4);

	/* Skill 里带可执行文件：这是最硬的一条，直接算「明显不符」。 */
	const skillCodeFiles = purpose.id === "skill" ? fileList.filter((rel) => CODE_FILE.test(String(rel))) : [];
	if (skillCodeFiles.length > 0) score = Math.max(score + 3, 4);

	let verdict = "ok";
	if (def.unknown) verdict = "unknown";
	else if (score >= 4) verdict = "error";
	else if (score >= 1) verdict = "warn";

	const findings = [];
	for (const u of unexpected.slice(0, 6)) {
		/* 带上「几个文件里都有」：一条命中和铺满整个 bundle 是两件事，
		   面板以前一律显示「×5」，看的人分不出规模（R5）。 */
		const spread = typeof ((scan && scan.density) || {})[u.kind] === "number" ? scan.density[u.kind] : 0;
		findings.push({
			kind: u.kind,
			text: "「" + def.label + "」要「" + u.label + "」这个能力，说不通" + (spread >= 2 ? "（" + spread + " 个文件里都有）" : ""),
			detail: u.never
				? "没有任何 DSH 插件需要它：正常插件不会 eval / 跑 vm / 做代码混淆。"
				: "如果它确实在做别的事，那说明它不只是「" + def.label + "」—— 先看它到底要干什么再决定。"
		});
	}
	if (skillCodeFiles.length > 0) {
		findings.push({
			kind: "skill-code",
			text: "Skill 里带可执行文件：" + skillCodeFiles.slice(0, 4).join("、"),
			detail: "Skill 本质是给模型看的说明文档，不需要执行代码。带 .ps1/.exe 的 Skill 要格外小心 —— 它可能只是个投放器。"
		});
	}

	const summary =
		verdict === "ok"
			? "用途「" + def.label + "」与它要的能力匹配"
			: verdict === "unknown"
				? "用途认不出来，未做合理性判断（只列能力清单）"
				: "用途「" + def.label + "」与它要的能力不符：" + unexpected.map((u) => u.label).join("、");

	const plain =
		verdict === "ok"
			? "大白话：它说自己是干这个的，要的东西也正是干这个要用的 —— 没多要。"
			: verdict === "unknown"
				? "大白话：看不出它是干什么的，所以没法判断「多要了没有」。下面列了它实际能碰的东西，自己扫一眼。"
				: verdict === "error"
					? "大白话：它说自己是「" + def.label + "」，却要动" + unexpected.map((u) => u.label).join("、") + " —— 这些不是「" + def.label + "」该有的。除非你能解释清楚它为什么要这些，否则别装。"
					: "大白话：它比「" + def.label + "」该有的多要了" + unexpected.map((u) => u.label).join("、") + "。可能是正当需求，也可能越界，看一眼再决定。";

	const advice =
		verdict === "ok"
			? ["可以装。装完如果要更稳，跑一次「AI 语义审查」看它拿这些能力在干什么。"]
			: verdict === "unknown"
				? ["先看描述/README 确认它是干什么的；面板的静态扫描列表里能看它碰到哪些 API。"]
				: [
					"先看下面列出的命中位置（文件:行 + 片段），确认这些调用是不是它的核心功能",
					"解释不通就别装；已经装了就用「回滚到安装前」",
					"如果只是「顺带用了」，可以问作者能不能去掉，或换一个用途更专一的实现"
				];

	/* 打包产物：命中会铺满几十个文件，这种包「逐条看」是徒劳的 —— 给一条换读法的建议。 */
	const bundled = ((scan && scan.combos) || []).some((c) => c && c.kind === "bundle-payload");
	if (bundled) {
		advice.push("这是把依赖/bundle 一起提交的仓库：命中多不代表恶意，按「发布者可信度 + 安装期脚本 + 它要联网/执行什么」来判断，别逐条数命中");
	}

	return {
		purpose,
		present: [...present],
		unexpected,
		tolerated: toleratedList,
		expected: [...expected],
		verdict,
		score,
		summary,
		plain,
		findings,
		advice
	};
}

/** 面板用的一行摘要（工具输出也用它）。 */
export function purposeLine(judgement) {
	if (!judgement) return "";
	const v = judgement.verdict === "ok" ? "匹配" : judgement.verdict === "warn" ? "略超范围" : judgement.verdict === "error" ? "明显不符" : "未判";
	return "用途「" + judgement.purpose.label + "」· 权限" + v + " · " + judgement.summary;
}
