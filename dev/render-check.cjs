/**
 * dev/render-check.cjs — 面板诊断卡的**无头渲染**自检。
 *
 * 为什么需要它：`hosttest.mjs` 只能证明数据与静态契约；而「怎么解决 / 大白话解释」这条链路的
 * 真 bug（组件没定义、props 名写错、hook 顺序错）只在**渲染那一刻**才炸。这里用一个 60 行的
 * 微型 React 真的把 DiagnosisCard 渲染出来，然后在返回的元素树上断言。
 *
 *   node DSH-Plugin/dsh-plugin-installer/dev/render-check.cjs
 *
 * 不需要 DSH、不需要浏览器、不重启。函数组件会被真的调用一次（带独立的 hook frame），
 * 所以 FindingsList / PlainToggle / FixSteps / Copyable 都在覆盖范围内。
 */
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "client.js");

let captured = null;
global.window = {
	__ModuleLoader__: {
		load(spec) {
			captured = spec;
		}
	},
	innerWidth: 1280,
	innerHeight: 800,
	addEventListener() {},
	removeEventListener() {}
};
const ls = {};
global.localStorage = {
	getItem: (k) => (k in ls ? ls[k] : null),
	setItem: (k, v) => {
		ls[k] = String(v);
	},
	removeItem: (k) => {
		delete ls[k];
	}
};
const fakeEl = () => ({
	style: {},
	appendChild() {},
	removeChild() {},
	remove() {},
	select() {},
	setAttribute() {},
	focus() {}
});
global.document = {
	createElement: fakeEl,
	body: { appendChild() {}, removeChild() {} },
	head: { appendChild() {} },
	documentElement: { style: { setProperty() {} } },
	execCommand: () => false,
	addEventListener() {},
	removeEventListener() {}
};

let hooks = [];
let hookIndex = 0;
let frameStack = [[]];
function resetHooks() {
	frameStack = [[]];
	hooks = frameStack[0];
	hookIndex = 0;
}
function pushFrame() {
	frameStack.push([]);
	hooks = frameStack[frameStack.length - 1];
	hookIndex = 0;
}
function popFrame() {
	frameStack.pop();
	hooks = frameStack[frameStack.length - 1];
	hookIndex = 0;
}
const flatten = (arr) =>
	arr.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);

const React = {
	Fragment: Symbol("Fragment"),
	createElement(type, props, ...children) {
		const p = Object.assign({}, props || {});
		const kids = flatten(children);
		// 真 React 会把 children 塞进 props.children；这里必须一致，否则 Copyable 之类
		// 拿 props.children 的组件在测试里会渲染成空。
		if (kids.length > 0) p.children = kids.length === 1 ? kids[0] : kids;
		return { type, props: p, children: kids };
	},
	useState(init) {
		const i = hookIndex++;
		if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
		return [hooks[i], (v) => { hooks[i] = v; }];
	},
	useEffect() {
		const i = hookIndex++;
		hooks[i] = hooks[i] || null;
	},
	useRef(v) {
		const i = hookIndex++;
		if (!(i in hooks)) hooks[i] = { current: v };
		return hooks[i];
	},
	useCallback(fn) {
		const i = hookIndex++;
		hooks[i] = fn;
		return fn;
	},
	useReducer(reducer, init) {
		const i = hookIndex++;
		if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
		return [hooks[i], () => {}];
	},
	useMemo(fn) {
		const i = hookIndex++;
		if (!(i in hooks)) hooks[i] = fn();
		return hooks[i];
	}
};

const code = fs.readFileSync(target, "utf8");
// eslint-disable-next-line no-new-func
new Function("window", "document", "localStorage", "require", "setTimeout", "clearTimeout", code)(
	global.window,
	global.document,
	global.localStorage,
	() => React,
	setTimeout,
	clearTimeout
);
if (!captured) {
	console.log("FAIL: client.js did not call __ModuleLoader__.load");
	process.exit(1);
}
const mod = captured.factory(() => React);
const t = mod && mod.__test;
if (!t || typeof t.DiagnosisCard !== "function") {
	console.log("FAIL: __test.DiagnosisCard missing");
	process.exit(1);
}

function textOf(node, acc) {
	const out = acc || [];
	if (node === null || node === undefined || node === false || node === true) return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) textOf(child, out);
		return out;
	}
	// 函数组件要真的调用一次 —— DiagnosisCard 把「怎么解决」交给 FindingsList / PlainToggle 渲染，
	// 不调用它们的话这条链路的 bug 根本看不见。
	if (node && typeof node.type === "function") {
		pushFrame();
		let rendered = null;
		try {
			rendered = node.type(node.props || {});
		} finally {
			popFrame();
		}
		textOf(rendered, out);
		return out;
	}
	if (node && node.children) for (const child of node.children) textOf(child, out);
	return out;
}

/**
 * 断言条数的**预期值**。改断言就必须同步这里 —— 以及 audit.mjs 的
 * EXPECTED_RENDER_ASSERTIONS 和两份文档里的数字。
 *
 * 为什么需要它：源码里 `check(` 出现 100 多次，但一部分在 `else` / `catch` 兜底分支里
 * 正常不执行，所以**数源码不等于数断言**（实测 103 处、只跑 80 条）。真正的判据只能是
 * 「这次实际跑了几条」，所以由脚本自己报总数、并由自己比对。
 */
const EXPECTED_TOTAL = 262;

let failed = 0;
let passed = 0;
function check(name, condition, extra) {
	if (condition) {
		passed += 1;
		console.log("PASS " + name);
	} else {
		failed += 1;
		console.log("FAIL " + name + (extra ? "  " + JSON.stringify(extra) : ""));
	}
}

const diagNew = {
	verdict: "error",
	plain: "这次没能正常用起来。下面每条都写了怎么解决。",
	findings: [
		{
			severity: "error",
			title: "包文件缺失",
			detail: "依赖声明在，但包目录读不到。",
			plain: "大白话：名单上有它，可磁盘上找不到那份文件。",
			fix: [{ text: "点「回滚到安装前」" }, { text: "重新装一次", command: "tailscale serve status" }],
			action: { kind: "rollback", label: "回滚", command: null }
		}
	]
};

resetHooks();
try {
	const joined = textOf(t.DiagnosisCard({ diagnosis: diagNew })).join(" | ");
	check("渲染出诊断标题", joined.includes("安装后诊断"));
	check("默认显示大白话结论", joined.includes("这次没能正常用起来"));
	check("每条发现都有「怎么解决」", joined.includes("怎么解决"));
	check("步骤文字被渲染", joined.includes("点「回滚到安装前」"));
	check("步骤里的命令可复制", joined.includes("tailscale serve status"));
	check("有「大白话解释」开关", joined.includes("大白话解释"));
} catch (e) {
	check("新格式渲染不抛异常", false, String((e && e.message) || e));
}

/* R24：发现卡上的可点动作（finding.actions）—— 「检查更新并升级」这类按钮。
   判据只看渲染：按钮文字要出来、要是主按钮（不是幽灵按钮）、没有动作时不许留空容器。 */
resetHooks();
try {
	const diagAction = {
		verdict: "error",
		findings: [
			{
				severity: "error",
				title: "前端入口没激活，且失败的那份字节还在",
				detail: "dsh-x：日志里那份还在（rev abcdefabcdef）—— 重启会再遇到同一个错误",
				plain: "大白话：重启只是再错一次。",
				fix: [{ text: "rev 没变 = 重启没用" }],
				actions: [{ kind: "upgrade-npm", plugin: "dsh-x", label: "检查更新并升级 dsh-x", hint: "先查 npm 上有没有新版" }]
			}
		]
	};
	const elAction = t.DiagnosisCard({ diagnosis: diagAction });
	const joinedAction = textOf(elAction).join(" | ");
	check("发现卡渲染动作按钮文字", joinedAction.includes("检查更新并升级 dsh-x"));
	const actionButtons = findNodes(elAction, (p) => typeof p.className === "string" && p.className.includes("dpi-btn-primary") && typeof p.onClick === "function");
	check("动作按钮是主按钮且真的可点", actionButtons.length === 1, actionButtons.length);
	const noAction = textOf(t.DiagnosisCard({
		diagnosis: { verdict: "error", findings: [{ severity: "error", title: "没问题可点", detail: "d", fix: [{ text: "x" }] }] }
	})).join(" | ");
	check("没有 actions 时不留空按钮", !noAction.includes("检查更新"));
} catch (e) {
	check("动作按钮渲染不抛异常", false, String((e && e.message) || e));
}

resetHooks();
try {
	const diagOld = {
		verdict: "warn",
		findings: [
			{ severity: "warn", title: "旧发现", detail: "老格式的 detail", action: { kind: "fix", label: "看诊断", command: "dsh doctor" } }
		]
	};
	const joinedOld = textOf(t.DiagnosisCard({ diagnosis: diagOld })).join(" | ");
	check("老格式仍显示 detail", joinedOld.includes("老格式的 detail"));
	check("老格式退回到 action 命令", joinedOld.includes("dsh doctor"));
	check("老格式不显示大白话开关", !joinedOld.includes("大白话解释"));
	check("老格式也有大白话结论兜底", joinedOld.includes("大白话"));
} catch (e) {
	check("老格式渲染不抛异常", false, String((e && e.message) || e));
}

resetHooks();
try {
	const joinedOk = textOf(t.DiagnosisCard({ diagnosis: { verdict: "ok", findings: [] } })).join(" | ");
	check("ok 时给大白话结论", joinedOk.includes("装好了"));
	check("ok 且无发现时说明没有发现问题", joinedOk.includes("没有发现问题"));
} catch (e) {
	check("ok 渲染不抛异常", false, String((e && e.message) || e));
}

/* 预检卡里的「用途 vs 权限」（R3）：新加的一块，必须确认真的渲染出来 */
if (typeof t.PrecheckCard === "function") {
	resetHooks();
	const pc = {
		blocked: false,
		needsConfirm: true,
		compat: { verdict: "ok", runtimeVersion: "0.2.1-rc.2", via: "app-boot(asar)" },
		reasons: [{ level: "warn", text: "静态扫描发现高危能力信号", detail: "5 类" }],
		risks: { summary: "5 类能力共 20 处", hits: [], combos: [] },
		fixes: [],
		trust: { notes: ["pnpm trustPolicy = no-downgrade ✓"] },
		purpose: {
			purpose: { id: "ui", label: "界面 / 交互增强", confidence: "high", signals: [] },
			verdict: "error",
			score: 5,
			summary: "用途「界面 / 交互增强」与它要的能力不符：网络请求、启动子进程",
			plain: "大白话：它说自己是做界面的，却要联网和起子进程。",
			findings: [{ kind: "network", text: "「界面 / 交互增强」要「网络请求」这个能力，说不通", detail: "界面插件不需要联网" }],
			advice: ["先看命中位置", "解释不通就别装"],
			present: ["network", "child-process", "fs-read"],
			unexpected: [{ kind: "network", label: "网络请求" }],
			tolerated: [],
			expected: ["fs-read"]
		}
	};
	try {
		const joinedPc = textOf(t.PrecheckCard({ precheck: pc })).join(" | ");
		check("预检卡渲染「用途 vs 权限」", joinedPc.includes("用途 vs 权限"));
		check("预检卡显示用途档", joinedPc.includes("界面 / 交互增强"));
		check("预检卡显示不匹配结论", joinedPc.includes("明显不符"));
		check("预检卡显示大白话", joinedPc.includes("它说自己是做界面的"));
		check("预检卡列出实际能力", joinedPc.includes("它实际用到的能力"));
		check("预检卡给出建议", joinedPc.includes("先看命中位置"));
	} catch (e) {
		check("预检卡渲染不抛异常", false, String((e && e.message) || e));
	}
} else {
	check("__test 暴露了 PrecheckCard", false);
}

/* 「AI 审查被跳过」这一态（R4）：花钱 / 省钱的结论必须在面板上看得见 */
if (typeof t.ReviewCard === "function") {
	resetHooks();
	try {
		const joinedSkip = textOf(t.ReviewCard({
			review: { status: "skipped", verdict: "inconclusive", skipReason: "只有低/中危的常规能力（network、fs-read），模型看不出更多东西", estTokens: { saved: 2650 } }
		})).join(" | ");
		check("审查卡显示「已跳过」", joinedSkip.includes("已跳过"));
		check("审查卡写出跳过原因", joinedSkip.includes("常规能力"));
		check("审查卡写出省了多少 token", joinedSkip.includes("2650"));
	} catch (e) {
		check("审查卡（跳过态）渲染不抛异常", false, String((e && e.message) || e));
	}
	resetHooks();
	try {
		const joinedDone = textOf(t.ReviewCard({
			review: { status: "done", verdict: "suspicious", model: "deepseek-flash", findings: [{ title: "联网+子进程", why: "界面插件不需要" }], estTokens: { total: 2610 } }
		})).join(" | ");
		check("审查卡显示花了多少 token", joinedDone.includes("2610"));
	} catch (e) {
		check("审查卡（完成态）渲染不抛异常", false, String((e && e.message) || e));
	}
} else {
	check("__test 暴露了 ReviewCard", false);
}

/* ── R6：设置面板 / 跳过审核按钮 ───────────────────────────────────── */
function attrsOf(node, acc) {
	const out = acc || { classes: [], aria: [] };
	if (node === null || node === undefined || node === false || node === true) return out;
	if (typeof node === "string" || typeof node === "number") return out;
	if (Array.isArray(node)) {
		for (const child of node) attrsOf(child, out);
		return out;
	}
	if (node && typeof node.type === "function") {
		pushFrame();
		let rendered = null;
		try {
			rendered = node.type(node.props || {});
		} finally {
			popFrame();
		}
		attrsOf(rendered, out);
		return out;
	}
	if (node && node.props) {
		if (typeof node.props.className === "string") out.classes.push(node.props.className);
		if (node.props["aria-checked"] !== undefined) out.aria.push(String(node.props["aria-checked"]));
	}
	if (node && node.children) for (const child of node.children) attrsOf(child, out);
	return out;
}

/** 找出满足条件的节点（用来确认「哪个分段被选中了」）。 */
function findNodes(node, pred, acc) {
	const out = acc || [];
	if (node === null || node === undefined || node === false || node === true) return out;
	if (Array.isArray(node)) {
		for (const child of node) findNodes(child, pred, out);
		return out;
	}
	if (typeof node === "string" || typeof node === "number") return out;
	if (node && typeof node.type === "function") {
		pushFrame();
		let rendered = null;
		try {
			rendered = node.type(node.props || {});
		} finally {
			popFrame();
		}
		findNodes(rendered, pred, out);
		return out;
	}
	if (node && node.props && pred(node.props, node)) out.push(node);
	if (node && node.children) for (const child of node.children) findNodes(child, pred, out);
	return out;
}

if (typeof t.SettingsModal === "function") {
	const savedData = t.store.data;
	t.store.data = null;
	resetHooks();
	try {
		const el = t.SettingsModal({});
		const joinedSet = textOf(el).join(" | ");
		const attrs = attrsOf(el);
		check("设置面板渲染标题", joinedSet.includes("设置"));
		check("设置面板标明默认范围（条数 6–25 / 其余默认档不变）", joinedSet.includes("设置只影响推荐与提醒，不放松安装判据"));
		check("设置面板三种提醒都在", joinedSet.includes("侧边栏红点") && joinedSet.includes("声音提醒") && joinedSet.includes("桌面弹窗"));
		check("设置面板审核三档齐全", joinedSet.includes("严格") && joinedSet.includes("普通") && joinedSet.includes("关闭"));
		check("设置面板注明普通 = 标准强度", joinedSet.includes("一直以来的标准强度"));
		check("设置面板有「跳过审核」开关", joinedSet.includes("允许「跳过审核」按钮"));
		check("设置面板有界面与性能项", joinedSet.includes("状态轮询间隔") && joinedSet.includes("历史显示条数") && joinedSet.includes("快照保留份数"));
		check("设置面板有搜索来源项", joinedSet.includes("搜索来源"));
		/* R41：AI 推荐的条数与广度必须在设置面板里看得见、选得到 */
		check("设置面板有 AI 推荐区（条数 + 广度）", joinedSet.includes("AI 推荐") && joinedSet.includes("推荐条数") && joinedSet.includes("推荐广度"));
		check("设置面板标明默认档 = 6 条 / 标准广度", joinedSet.includes("6 条（默认）") && joinedSet.includes("标准"));
		check("设置面板有「很广」档可选（用户要查看更多）", joinedSet.includes("很广"));
		/* R43/R44：推荐条数是「自定义」的 —— 快捷档 6/15/25 仍在，另有一个 6~25 的数字输入（默认 6） */
		const pickInputs = findNodes(el, (p) => typeof p.className === "string" && p.className.includes("dpi-input-num"));
		check("R43 设置：推荐条数有「自定义」数字输入",
			joinedSet.includes("自定义") && joinedSet.includes("条（6–25）") && pickInputs.length >= 1, pickInputs.length);
		check("R43 设置：数字输入默认 6、范围 6–25",
			String(pickInputs[0] && pickInputs[0].props.value) === "6" && String(pickInputs[0] && pickInputs[0].props.max) === "25",
			pickInputs[0] && pickInputs[0].props);
		check("R43 设置：6/15/25 快捷档仍在（6 条标默认）",
			joinedSet.includes("6 条（默认）") && joinedSet.includes("15 条") && joinedSet.includes("25 条"));
		check("设置面板默认渲染出开关", attrs.classes.filter((c) => c.includes("dpi-switch")).length >= 3, attrs.classes);
		check("设置面板默认档：开着的开关不止一个", attrs.aria.filter((a) => a === "true").length >= 2, attrs.aria);
		/* R45：自定义搜索来源 —— 免责声明是产品要求；AI 辅助添加必须先出「待确认」再保存 */
		check("R45 设置：有自定义来源区与免责声明",
			joinedSet.includes("自定义来源") && joinedSet.includes("不保证其中的插件代码") &&
			joinedSet.includes("自行甄别"), joinedSet.slice(0, 200));
		check("R45 设置：有 AI 辅助添加 / 预设 / 网页解析开关（默认关）",
			joinedSet.includes("AI 辅助添加") && joinedSet.includes("npmmirror") &&
			joinedSet.includes("允许 AI 解析任意网页") && joinedSet.includes("默认关"));
	} catch (e) {
		check("设置面板渲染不抛异常", false, String((e && e.message) || e));
	}

	/* 换成「声音开 + 审核严格 + 红点关」再渲染：选中态必须跟着设置走 */
	t.store.data = { settings: { sound: true, reviewLevel: "strict", redDot: false } };
	resetHooks();
	try {
		const el2 = t.SettingsModal({});
		const onSegs = findNodes(el2, (p) => typeof p.className === "string" && p.className.includes("dpi-seg-btn") && p.className.includes("is-on"));
		const onText = onSegs.map((b) => textOf(b.children).join("")).join("|");
		check("设置面板：严格档显示为选中", onText.includes("严格"), onText);
		const offSwitch = findNodes(el2, (p) => typeof p.className === "string" && p.className.includes("dpi-switch") && !p.className.includes("is-on") && p["aria-checked"] === "false");
		check("设置面板：关掉的开关有未选中态", offSwitch.length >= 1, offSwitch.length);
	} catch (e) {
		check("设置面板（非默认档）渲染不抛异常", false, String((e && e.message) || e));
	}
	t.store.data = savedData;
} else {
	check("__test 暴露了 SettingsModal", false);
}

if (typeof t.SkipReviewButton === "function") {
	const savedData = t.store.data;
	t.store.data = null;
	resetHooks();
	try {
		const el3 = t.SkipReviewButton({ job: { precheck: { needsAiReview: true } }, busy: null, act: () => {} });
		check("跳过审核按钮：默认出现", textOf(el3).join(" ").includes("跳过审核，直接安装"));
	} catch (e) {
		check("跳过审核按钮渲染不抛异常", false, String((e && e.message) || e));
	}

	/* 模拟「已经点了一下」→ 展开二次确认（hook 0 预置为 true 即可） */
	resetHooks();
	hooks[0] = true;
	try {
		const asking = t.SkipReviewButton({ job: { precheck: { needsAiReview: true } }, busy: null, act: () => {} });
		const askingText = textOf(asking).join(" | ");
		check("跳过审核要二次确认", askingText.includes("确认跳过审核？"));
		check("二次确认写明不花 token", askingText.includes("不花那笔 token"));
		check("二次确认有「再想想」", askingText.includes("再想想"));
		check("二次确认有「我确认跳过」", askingText.includes("我确认跳过"));
		check("二次确认写明风险提示仍然有效", askingText.includes("风险提示仍然全部有效"));
	} catch (e) {
		check("跳过审核（二次确认态）渲染不抛异常", false, String((e && e.message) || e));
	}

	t.store.data = { settings: { skipReview: false } };
	resetHooks();
	const el4 = t.SkipReviewButton({ job: { precheck: { needsAiReview: true } }, busy: null, act: () => {} });
	check("设置在关掉「跳过审核」时按钮不出现", el4 === null || el4 === undefined || el4 === false);

	t.store.data = null;
	resetHooks();
	const el5 = t.SkipReviewButton({ job: { precheck: { needsAiReview: false } }, busy: null, act: () => {} });
	check("这次本来就不审的任务没有这个按钮", el5 === null || el5 === undefined || el5 === false);
	t.store.data = savedData;
} else {
	check("__test 暴露了 SkipReviewButton", false);
}

/* R9：安装脚本待批准卡 —— 没待批准必须不出现；有则列名、写风险、二次确认后才发请求 */
if (typeof t.BuildApprovalCard === "function") {
	const savedData = t.store.data;
	t.store.data = null;
	resetHooks();
	const empty = t.BuildApprovalCard({ job: { install: { pendingBuilds: [] } }, busy: null, act: () => {} });
	check("批准卡：没有待批准就不出现", empty === null || empty === undefined || empty === false);

	const job = {
		id: "job-test",
		install: {
			ok: false,
			pendingBuilds: ["esbuild", "sharp"],
			failure: { plain: "大白话：这些包要跑安装脚本。" }
		}
	};
	resetHooks();
	let el;
	try {
		el = t.BuildApprovalCard({ job, busy: null, act: () => {} });
	} catch (e) {
		check("批准卡渲染不抛异常", false, String((e && e.message) || e));
	}
	if (el) {
		const text = textOf(el).join(" | ");
		check("批准卡：点名要批准的包", text.includes("esbuild") && text.includes("sharp"), text.slice(0, 120));
		check("批准卡：说明是安装脚本待批准", text.includes("安装脚本待批准"), text.slice(0, 120));
		check("批准卡：给出「允许并重试」按钮", text.includes("允许这些包跑安装脚本并重试"));
		check("批准卡：默认不展开二次确认", !text.includes("我确认允许"));
	}

	/* 点了一下 → 二次确认态（hook 0 预置 true） */
	resetHooks();
	hooks[0] = true;
	let asking;
	try {
		asking = t.BuildApprovalCard({ job, busy: null, act: () => {} });
	} catch (e) {
		check("批准卡（二次确认态）渲染不抛异常", false, String((e && e.message) || e));
	}
	if (asking) {
		const text = textOf(asking).join(" | ");
		check("批准卡：二次确认写明后果", text.includes("跑安装脚本") && text.includes("我确认允许"), text.slice(0, 160));
		check("批准卡：有「再想想」", text.includes("再想想"));
		/* 真的按下「我确认允许」时，请求必须带 action + names（后端据此复核 pending） */
		const btn = findNodes(asking, (p) => p && typeof p.onClick === "function" && p.className && String(p.className).includes("dpi-btn-primary"));
		check("批准卡：确认按钮接了 onClick", btn.length >= 1, btn.length);
	}
	t.store.data = savedData;
} else {
	check("__test 暴露了 BuildApprovalCard", false);
}

/* R10：版本不兼容卡 —— 非 mismatch 不出现；mismatch 要点名「包@版本 + 当前 DSH」、
   写清风险、二次确认后才发请求；已豁免的版本不再劝人授权。 */
if (typeof t.CompatExemptCard === "function") {
	const savedData = t.store.data;
	t.store.data = null;

	const okJob = { id: "job-ok", precheck: { compat: { verdict: "ok", exempted: false } } };
	resetHooks();
	check("兼容卡：兼容时不出现", t.CompatExemptCard({ job: okJob, busy: null, act: () => {} }) == null);

	const exemptJob = { id: "job-ex", precheck: { compat: { verdict: "exempted", exempted: true, name: "x", version: "1.0.0", runtimeVersion: "0.2.1-rc.2" } } };
	resetHooks();
	check("兼容卡：已豁免的版本不出现（不再劝一次）", t.CompatExemptCard({ job: exemptJob, busy: null, act: () => {} }) == null);

	const blocked = {
		id: "job-c",
		precheck: {
			compat: {
				verdict: "mismatch",
				exempted: false,
				name: "@anweat/dsh-browser",
				version: "0.2.1",
				runtimeVersion: "0.2.1-rc.2",
				requirements: { "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2 <0.2.1-0" }
			}
		}
	};
	resetHooks();
	let el;
	try {
		el = t.CompatExemptCard({ job: blocked, busy: null, act: () => {} });
	} catch (e) {
		check("兼容卡渲染不抛异常", false, String((e && e.message) || e));
	}
	if (el) {
		const text = textOf(el).join(" | ");
		check("兼容卡：点名包@版本", text.includes("@anweat/dsh-browser@0.2.1"), text.slice(0, 120));
		check("兼容卡：写出当前宿主版本与被跳过的事实", text.includes("0.2.1-rc.2") && text.includes("跳过"));
		check("兼容卡：把不满足的范围原样列出", text.includes("@deepseek-ai/dsh-tools") && text.includes(">=0.2.0-rc.2"));
		check("兼容卡：默认不展开二次确认", !text.includes("我确认风险"));
	}

	resetHooks();
	hooks[0] = true;
	let asking;
	try {
		asking = t.CompatExemptCard({ job: blocked, busy: null, act: () => {} });
	} catch (e) {
		check("兼容卡（二次确认态）渲染不抛异常", false, String((e && e.message) || e));
	}
	if (asking) {
		const text = textOf(asking).join(" | ");
		check("兼容卡：二次确认说清「可能崩溃或损坏数据」", text.includes("可能崩溃或损坏数据"), text.slice(0, 160));
		check("兼容卡：说明豁免只对精确版本生效", text.includes("compatibility.json") && text.includes("精确版本"));
		check("兼容卡：有「再想想」", text.includes("再想想"));
		const btn = findNodes(asking, (p) => p && typeof p.onClick === "function" && p.className && String(p.className).includes("dpi-btn-primary"));
		check("兼容卡：确认按钮接了 onClick", btn.length >= 1, btn.length);
	}

	/* 旧豁免对当前版本失效 —— 要明确告诉人「重新授权一次即可」，别让人以为已经好了 */
	const stale = {
		id: "job-stale",
		precheck: {
			compat: {
				verdict: "mismatch",
				exempted: false,
				name: "pkg-x",
				version: "2.0.0",
				runtimeVersion: "0.2.1-rc.2",
				requirements: { "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.2.1-0" },
				exemption: { key: "pkg-x@2.0.0", granted: false, runtimes: ["0.2.1-rc.1"], forOtherRuntimes: true }
			}
		}
	};
	resetHooks();
	const staleEl = t.CompatExemptCard({ job: stale, busy: null, act: () => {} });
	const staleText = staleEl ? textOf(staleEl).join(" | ") : "";
	check("兼容卡：旧豁免失效时点名旧版本并说「重新授权」", staleText.includes("0.2.1-rc.1") && staleText.includes("重新授权"), staleText.slice(0, 160));
	t.store.data = savedData;
} else {
	check("__test 暴露了 CompatExemptCard", false);
}

/* R27：换版本卡（先卸后装）—— 面板必须能说清「为什么必须卸、由谁卸、中断了能不能续」 */
if (typeof t.UpgradeCard === "function") {
	const upgradeJob = {
		id: "job-up",
		replacement: { needed: true, direction: "upgrade", from: "0.5.0", to: "0.6.0", name: "dsh-ffmpeg", kind: "npm", blocked: null },
		collaborator: { ok: true, label: "「插件目录」 v0.31.0" },
		upgrade: {
			phase: "interrupted",
			resumable: true,
			prepared: { type: "npm", spec: "npm:dsh-ffmpeg@0.6.0" },
			from: "0.5.0",
			to: "0.6.0",
			removal: { ok: true, application: "applied" },
			removalPlan: { ok: true, warnings: [{ code: "loaded", text: "它现在**会被加载**（bundle）" }] }
		},
		stages: [],
		error: { code: "upgrade-interrupted", message: "宿主在卸载之后重启了", hint: "点继续升级" }
	};
	resetHooks();
	let upgradeText = "";
	try {
		upgradeText = textOf(t.UpgradeCard({ job: upgradeJob, busy: null, act: () => {} })).join(" | ");
		check("换版本卡：标题写明「先卸后装」", upgradeText.includes("先卸后装"), upgradeText.slice(0, 120));
		check("换版本卡：给出 从 → 到", upgradeText.includes("0.5.0") && upgradeText.includes("0.6.0"), upgradeText.slice(0, 160));
		check("换版本卡：点名卸载由「插件目录」执行", upgradeText.includes("插件目录"), upgradeText.slice(0, 240));
		check("换版本卡：说明装失败会装回旧版", upgradeText.includes("装回旧版"), upgradeText.slice(0, 300));
		check("换版本卡：中断后可一键续跑", upgradeText.includes("继续升级"), upgradeText.slice(0, 400));
		check("换版本卡：把卸载前的提醒摊开", upgradeText.includes("会被加载"), upgradeText.slice(0, 500));
	} catch (e) {
		check("换版本卡：渲染不抛异常", false, String((e && e.message) || e));
	}
	/* 两个「不许换」的口径：自己换自己 / 缺协作方 —— 都不能只灰按钮 */
	resetHooks();
	let blockedText = "";
	try {
		blockedText = textOf(t.UpgradeCard({
			job: {
				id: "job-block",
				replacement: { needed: true, direction: "upgrade", from: "0.1.0", to: "0.2.0", name: "dsh-plugin-installer", kind: "npm", blocked: { code: "self-replace", text: "不能由面板换「插件安装」自己的版本", plain: "大白话", fix: [{ text: "用官方插件管理器升级" }] } },
				upgrade: null,
				stages: []
			},
			busy: null,
			act: () => {}
		})).join(" | ");
		check("换版本卡：被拒时点名原因", blockedText.includes("不能由面板换"), blockedText.slice(0, 160));
		check("换版本卡：被拒时给处置步骤", blockedText.includes("官方插件管理器"), blockedText.slice(0, 300));
		check("换版本卡：被拒时不给续跑按钮", !blockedText.includes("继续升级"), blockedText.slice(0, 300));
	} catch (e) {
		check("换版本卡：被拒态渲染不抛异常", false, String((e && e.message) || e));
	}
} else {
	check("__test 暴露了 UpgradeCard", false);
}

/* R12：已装清单 —— 折叠态只说规模、展开态才逐条列；「能不能升级」必须在这一层就说清来源 */
if (typeof t.Inventory === "function") {
	const savedLocal = t.store.local;
	const invFixture = {
		ok: true,
		counts: { total: 3, bundle: 2, byKind: { npm: 2, link: 1 }, checkable: 1, hostScoped: 0, missing: 1 },
		problems: [{ name: "dsh-missing", code: "declared-not-installed" }],
		summary: { checked: 2, outdated: 1, current: 1, ahead: 0, failed: 0, deprecated: 0, cached: 0, at: "2026-10-22T02:00:00.000Z" },
		updatesAt: "2026-10-22T02:00:00.000Z",
		items: [
			{
				name: "dsh-ffmpeg", spec: "^0.5.0", kind: "npm", kindLabel: "npm",
				why: "来自 npm registry，可以比对最新版", checkable: true, bundle: true,
				installed: true, localVersion: "0.5.0",
				update: { relation: "outdated", localVersion: "0.5.0", latestVersion: "0.6.0", error: null, deprecated: null, gap: { text: "跨 1 个小版本", severe: false } }
			},
			{
				name: "dsh-local", spec: "link:D:/x/dsh-local", kind: "link", kindLabel: "本机目录",
				why: "link: 指向本机源码目录 —— 改了就生效，没有「新版本」这回事", checkable: false,
				bundle: false, installed: true, localVersion: "0.1.0", update: null
			},
			{
				name: "dsh-missing", spec: "^0.2.0", kind: "npm", kindLabel: "npm",
				why: "来自 npm registry，可以比对最新版", checkable: true, bundle: false,
				installed: false, localVersion: null, update: null
			}
		]
	};

	/* ① 折叠态（默认）：只说规模，不把 44 行铺开。
	   R27：换版本要「插件目录」配合卸载 —— 这一组夹具默认给一个可用的协作方，
	   没有它的话「升级到 X」按设计不会出现（下面另有一组不可用的对照）。 */
	const savedDataC = t.store.data;
	const collabOkFixture = {
		ok: true, state: "available", name: "dsh-plugin-catalog", version: "0.31.0",
		label: "「插件目录」 v0.31.0", reason: "", fix: [], line: "「插件目录」 v0.31.0 可用"
	};
	t.store.data = Object.assign({}, savedDataC || {}, { collaborator: collabOkFixture });
	t.store.local = { inventory: invFixture };
	resetHooks();
	let collapsed = "";
	try {
		collapsed = textOf(t.Inventory({})).join(" | ");
		check("已装清单：标题是「已装插件」", collapsed.includes("已装插件"), collapsed.slice(0, 80));
		check("已装清单：折叠态报规模", collapsed.includes("3 个依赖") && collapsed.includes("2 个在 bundle 行里"), collapsed.slice(0, 120));
		check("已装清单：折叠态不铺开逐条", !collapsed.includes("dsh-ffmpeg"));
		check("已装清单：检查更新已移出（R36 单独入口），卡里不再重复", !collapsed.includes("检查更新"));
		check("已装清单：有「展开」入口", collapsed.includes("展开"));
		check("已装清单：折叠态提示「声明了但没落地」", collapsed.includes("声明了但没落地"), collapsed.slice(0, 200));
		check("已装清单：检查过就说可升级几个", collapsed.includes("可升级 1 个"), collapsed.slice(0, 200));
	} catch (e) {
		check("已装清单：折叠态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ② 展开态：hook 2 = 展开开关（hook 0/1 是 useStore 的 reducer/effect） */
	resetHooks();
	hooks[2] = true;
	let expanded = "";
	try {
		expanded = textOf(t.Inventory({})).join(" | ");
		check("已装清单：展开后列出包名与版本", expanded.includes("dsh-ffmpeg") && expanded.includes("v0.5.0"), expanded.slice(0, 200));
		check("已装清单：可升级行给出目标版本", expanded.includes("可升级 → 0.6.0"));
		check("已装清单：可升级行有「升级到」按钮", expanded.includes("升级到 0.6.0"));
		check("已装清单：标出来源（本机目录）", expanded.includes("本机目录"));
		check("已装清单：不比对的行说清为什么", expanded.includes("改了就生效"), expanded.slice(0, 300));
		check("已装清单：跨度写明跨几个版本（R26）", expanded.includes("跨 1 个小版本"), expanded.slice(0, 400));
		check("已装清单：没落地的行被点名", expanded.includes("声明了但没落地") && expanded.includes("dsh-missing"));
		check("已装清单：收起入口", expanded.includes("收起"));
		/* R27：升级不再是「原地换版本」，面板要说清先卸载 */
		check("已装清单：升级说明「先卸载旧版」（R27）", expanded.includes("先卸载旧版"), expanded.slice(0, 400));
		check("已装清单：点名卸载由「插件目录」执行（R27）", expanded.includes("插件目录"), expanded.slice(0, 400));
	} catch (e) {
		check("已装清单：展开态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ②c R27：协作方不可用时，升级入口要**消失并说清原因**（而不是点下去必失败） */
	t.store.data = Object.assign({}, savedDataC || {}, {
		collaborator: { ok: false, state: "missing", name: "dsh-plugin-catalog", version: "", label: "", reason: "没装「插件目录」（dsh-plugin-catalog）", fix: [{ text: "在面板里搜 dsh-plugin-catalog 装上" }], line: "卸载协作：不可用 —— 没装「插件目录」" }
	});
	t.store.local = { inventory: invFixture };
	resetHooks();
	hooks[2] = true;
	let noCollab = "";
	try {
		noCollab = textOf(t.Inventory({})).join(" | ");
		check("已装清单：协作方不可用时不画「升级到」按钮（R27）", !noCollab.includes("升级到 0.6.0"), noCollab.slice(0, 300));
		check("已装清单：协作方不可用时说清原因（R27）", noCollab.includes("没装「插件目录」"), noCollab.slice(0, 400));
		check("已装清单：协作方不可用时给下一步（R27）", noCollab.includes("搜 dsh-plugin-catalog"), noCollab.slice(0, 500));
	} catch (e) {
		check("已装清单：不可用态渲染不抛异常", false, String((e && e.message) || e));
	}
	t.store.data = savedDataC;

	/* ②b R26：批量升级队列与 80 条折叠提示 */
	const savedDataQ = t.store.data;
	t.store.data = Object.assign({}, savedDataQ || {}, { queue: { count: 2, items: [{ name: "dsh-a" }, { name: "dsh-b" }] } });
	t.store.local = { inventory: invFixture };
	resetHooks();
	const queueText = textOf(t.Inventory({})).join(" | ");
	check("已装清单：队列显示待装数量（R26）", queueText.includes("队列：2 个待装"), queueText.slice(0, 300));
	t.store.data = savedDataQ;
	const manyItems = Array.from({ length: 81 }, (_, i) => ({
		name: "dsh-many-" + i, spec: "^1.0.0", kind: "npm", kindLabel: "npm", why: "来自 npm",
		checkable: false, installed: true, localVersion: "1.0.0", update: null
	}));
	t.store.local = { inventory: { ...invFixture, items: manyItems, counts: { ...invFixture.counts, total: 81 } } };
	resetHooks();
	hooks[2] = true;
	const manyText = textOf(t.Inventory({})).join(" | ");
	check("已装清单：超过 80 条说明被折叠（R26）", manyText.includes("只显示前 80 个"), manyText.slice(0, 240));

	/* ③ 没检查过 / 读不到 / 空 profile 三种兜底态 */
	t.store.local = { inventory: { ...invFixture, summary: null, updatesAt: null } };
	resetHooks();
	const noSummary = textOf(t.Inventory({})).join(" | ");
	check("已装清单：没检查过时说明「还没比对过最新版」", noSummary.includes("还没比对过最新版"), noSummary.slice(0, 200));
	check("已装清单：说明哪些来源不参与比对", noSummary.includes("不参与"), noSummary.slice(0, 240));

	t.store.local = { inventory: { ok: false, error: "宿主还没重启：已装清单是新代码" } };
	resetHooks();
	const errored = textOf(t.Inventory({})).join(" | ");
	check("已装清单：读不到时把原因说出来", errored.includes("读不到：宿主还没重启"), errored.slice(0, 160));
	check("已装清单：读不到时有「重试」", errored.includes("重试"));

	t.store.local = { inventory: { ok: true, counts: { total: 0, bundle: 0, byKind: {}, checkable: 0, hostScoped: 0, missing: 0 }, items: [], problems: [] } };
	resetHooks();
	hooks[2] = true;
	const empty = textOf(t.Inventory({})).join(" | ");
	check("已装清单：空 profile 有兜底文案", empty.includes("没有依赖声明"), empty.slice(0, 160));

	t.store.local = savedLocal;
} else {
	check("__test 暴露了 Inventory", false);
}

/* R14：已装 Skill —— 折叠态报规模、展开态逐条；「宿主没认 / 备份 / 不会自动调用」三种标签
   必须真的渲染出来，否则这一整块就是「数据算了但没人看得见」。 */
if (typeof t.Skills === "function") {
	const savedSkillsLocal = t.store.local;
	const skillItem = (over) => Object.assign({
		hasFile: true, valid: true, hostVisible: true, backup: false, modelInvocable: true,
		bytes: 1024, reasons: [], duplicate: false, sourceLabel: "用户级（.$DSH/skills）"
	}, over);
	const skillsFixture = {
		ok: true,
		at: "2026-10-22T05:00:00.000Z",
		roots: ["D:/x/.dsh/skills"],
		counts: {
			roots: 1, dirs: 5, skills: 4, valid: 3, backups: 1, hostTotal: 3, hostVisible: 1,
			notVisible: 1, yamlBroken: 1, invalid: 1, duplicates: 1, duplicateDirs: 2, modelInvisible: 1, hostOnly: 0, byPanel: 1,
			tracked: 1, untracked: 3, locallyEdited: 1, updatable: 1
		},
		summary: "4 个技能 · 宿主认 3 个 · 1 个没被认 · 1 个 frontmatter 写坏了（宿主读不了） · 1 个备份残留 · 1 组重名 · 1 个不会自动调用",
		notes: [],
		items: [
			skillItem({ dir: "beta", name: "beta", hostVisible: false, modelInvocable: null, description: "宿主没认的技能" }),
			skillItem({ dir: "gamma", name: null, hasFile: false, valid: false, hostVisible: false, modelInvocable: null,
				description: null, bytes: 0, sourceLabel: null, reasons: ["目录里没有 SKILL.md（宿主不会把它当成技能）"] }),
			skillItem({ dir: "theta", name: "theta", hostVisible: false, modelInvocable: null, description: "写坏的描述",
				yamlIssue: { code: "colon-space", key: "description", line: 3, message: "`description` 的值里有「冒号 + 空格」", fix: "改成块标量（`description: >`）" } }),
			skillItem({ dir: "alpha.bak-1", name: "alpha", backup: true, backupOf: "alpha", duplicate: true,
				description: "旧副本", bytes: 2048 }),
			skillItem({ dir: "delta", name: "delta", modelInvocable: false, sourceLabel: "自定义根", description: "折叠描述",
			tracked: true, ledgerSource: "GitHub a/b @abc12345 · skills/delta", locallyEdited: true,
			update: { dir: "delta", relation: "outdated", localCommit: "aaaaaaaaaaaaaaaa", latestCommit: "bbbbbbbbbbbbbbbb", reason: "", error: null } })
		],
		host: { available: true, total: 3, complete: true, error: null },
		duplicates: [{ name: "alpha", dirs: ["alpha", "alpha.bak-1"], backups: ["alpha.bak-1"] }],
		notVisible: [{ dir: "beta", name: "beta" }],
		yamlBroken: [{ dir: "theta", code: "colon-space", message: "`description` 的值里有「冒号 + 空格」", fix: "改成块标量（`description: >`）" }],
		invalid: [{ dir: "gamma", reasons: ["目录里没有 SKILL.md（宿主不会把它当成技能）"] }],
		modelInvisible: [{ dir: "delta", name: "delta" }],
		hostOnly: []
	};

	/* ① 折叠态 */
	t.store.local = { skills: skillsFixture };
	resetHooks();
	let skillCollapsed = "";
	try {
		skillCollapsed = textOf(t.Skills({})).join(" | ");
		check("已装 Skill：标题是「已装 Skill」", skillCollapsed.includes("已装 Skill"), skillCollapsed.slice(0, 80));
		check("已装 Skill：折叠态报「几个技能 / 宿主认几个」", skillCollapsed.includes("4 个技能") && skillCollapsed.includes("宿主认 3 个"), skillCollapsed.slice(0, 160));
		check("已装 Skill：摘要说清没被认 / YAML 写坏 / 备份 / 重名", skillCollapsed.includes("1 个没被认") && skillCollapsed.includes("frontmatter 写坏了") && skillCollapsed.includes("1 个备份残留") && skillCollapsed.includes("1 组重名"), skillCollapsed.slice(0, 280));
		check("已装 Skill：没被认时给红色告警行", skillCollapsed.includes("个技能宿主没认"), skillCollapsed.slice(0, 260));
		check("已装 Skill：YAML 写坏时给另一条红色告警（查不出根因就没法修）", skillCollapsed.includes("不是合法 YAML"), skillCollapsed.slice(0, 300));
		check("已装 Skill：折叠态不铺开逐条", !skillCollapsed.includes("旧副本"));
		check("已装 Skill：有「刷新」与「展开」入口", skillCollapsed.includes("刷新") && skillCollapsed.includes("展开"));

		/* R26：磁盘之外的那批（插件包内置 / 宿主自带）要说清「这里删不掉」 */
		t.store.local = { skills: {
			...skillsFixture,
			counts: { ...skillsFixture.counts, hostOnly: 2 },
			hostOnly: [{ name: "builtin-a", source: "dsh-base" }, { name: "builtin-b", source: null }],
			summary: skillsFixture.summary + " · 2 个来自插件包/内置（不在技能根）"
		} };
		resetHooks();
		const hostOnlyText = textOf(t.Skills({})).join(" | ");
		check("已装 Skill：说明还有几个来自插件包/内置（R26）", hostOnlyText.includes("来自插件包/内置"), hostOnlyText.slice(0, 400));
		check("已装 Skill：点名其中几个（R26）", hostOnlyText.includes("builtin-a"), hostOnlyText.slice(0, 500));
		t.store.local = { skills: skillsFixture };
		resetHooks();
		/* R38：0 个有来源记录时不许说「都跟来源一致」（本机 58 个存量技能就是这个状态） */
		t.store.local = { skills: { ...skillsFixture, updates: {
			at: "2026-10-30T00:00:00.000Z",
			summary: { skills: 4, tracked: 0, untracked: 4, checked: 0, current: 0, outdated: 0, unknown: 0, locallyEdited: 0 },
			items: []
		} } };
		resetHooks();
		const zeroLedgerText = textOf(t.Skills({})).join(" | ");
		check("R38 Skill：0 个有来源记录时不说「都跟来源一致」",
			zeroLedgerText.includes("没有可比的来源") && !zeroLedgerText.includes("都跟来源一致"),
			zeroLedgerText.slice(0, 600));
		t.store.local = { skills: skillsFixture };
		resetHooks();
	} catch (e) {
		check("已装 Skill：折叠态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ② 展开态（hook 2 = 展开开关） */
	resetHooks();
	hooks[2] = true;
	let skillExpanded = "";
	try {
		skillExpanded = textOf(t.Skills({})).join(" | ");
		check("已装 Skill：展开后列出目录", skillExpanded.includes("alpha.bak-1"), skillExpanded.slice(0, 200));
		check("已装 Skill：备份行标「备份残留」", skillExpanded.includes("备份残留"));
		check("已装 Skill：备份行有「移出技能根…」入口（R15）", skillExpanded.includes("移出技能根…"), skillExpanded.slice(0, 300));
		check("已装 Skill：YAML 写坏的行被点名并给改法", skillExpanded.includes("frontmatter 写坏了") && skillExpanded.includes("改法："), skillExpanded.slice(0, 400));
		check("已装 Skill：YAML 写坏的行有「修成块标量…」入口（R16）", skillExpanded.includes("修成块标量…"), skillExpanded.slice(0, 400));
		check("已装 Skill：宿主没认的行被点名", skillExpanded.includes("beta") && skillExpanded.includes("宿主没认"));
		check("已装 Skill：不会自动调用单独标出", skillExpanded.includes("不会自动调用"));
		check("已装 Skill：缺 SKILL.md 的行说清原因", skillExpanded.includes("没有 SKILL.md"));
		check("已装 Skill：描述真的渲染出来（不是只给名字）", skillExpanded.includes("折叠描述") && skillExpanded.includes("宿主没认的技能"));
		check("已装 Skill：来源翻成人话", skillExpanded.includes("用户级"));
		check("R38 Skill：标出安装时记下的来源（GitHub + commit）", skillExpanded.includes("GitHub a/b @abc12345"), skillExpanded.slice(0, 500));
		check("R38 Skill：本地改过单独标出（重装会覆盖）", skillExpanded.includes("本地改过"));
		check("R38 Skill：可升级行给来源最新 commit 与「按来源更新」入口", skillExpanded.includes("可升级 → bbbbbbb") && skillExpanded.includes("按来源更新…"), skillExpanded.slice(0, 700));
		check("已装 Skill：展开后能收起", skillExpanded.includes("收起"));
	} catch (e) {
		check("已装 Skill：展开态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ②b 二次确认态（hook 3 = 待确认的备份目录名）：动手之前必须说清「移到哪、不删除」 */
	resetHooks();
	hooks[2] = true;
	hooks[3] = "alpha.bak-1";
	let skillConfirm = "";
	try {
		skillConfirm = textOf(t.Skills({})).join(" | ");
		check("已装 Skill：移出前有二次确认", skillConfirm.includes("我确认移出"), skillConfirm.slice(0, 400));
		check("已装 Skill：确认时说清「不删除、能搬回」与落点", skillConfirm.includes("不删除") && skillConfirm.includes("parked-skills"), skillConfirm.slice(0, 400));
		check("已装 Skill：确认态可取消", skillConfirm.includes("取消"));
	} catch (e) {
		check("已装 Skill：确认态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ②c 修复确认态（hook 4 = 待确认修的目录名）：动用户文件前必须说清「先备份原文、不删内容」 */
	resetHooks();
	hooks[2] = true;
	hooks[4] = "theta";
	let skillFixConfirm = "";
	try {
		skillFixConfirm = textOf(t.Skills({})).join(" | ");
		check("已装 Skill：修 frontmatter 前有二次确认", skillFixConfirm.includes("我确认修复"), skillFixConfirm.slice(0, 400));
		check("已装 Skill：确认时说清「先备份原文、不删内容」", skillFixConfirm.includes("先备份原文") && skillFixConfirm.includes("不删任何内容"), skillFixConfirm.slice(0, 400));
	} catch (e) {
		check("已装 Skill：修复确认态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ②c2 R38：按来源重装（两段式；本地改过时把「会覆盖」说清；宿主再判一次后要第二次确认） */
	resetHooks();
	hooks[2] = true;
	hooks[5] = { dir: "delta" };
	let skillReinstall = "";
	try {
		skillReinstall = textOf(t.Skills({})).join(" | ");
		check("R38 Skill：重装前有二次确认", skillReinstall.includes("我确认重装"), skillReinstall.slice(0, 600));
		check("R38 Skill：确认时说明会覆盖、本地改过、快照有旧版",
			skillReinstall.includes("会重新下载来源仓库") && skillReinstall.includes("本地改过") && skillReinstall.includes("装前快照"),
			skillReinstall.slice(0, 800));
		check("R38 Skill：确认态可取消", skillReinstall.includes("取消"));
	} catch (e) {
		check("R38 Skill：重装确认态渲染不抛异常", false, String((e && e.message) || e));
	}

	resetHooks();
	hooks[2] = true;
	hooks[5] = { dir: "delta", force: true };
	let skillReinstallForce = "";
	try {
		skillReinstallForce = textOf(t.Skills({})).join(" | ");
		check("R38 Skill：宿主判本地改过后要第二次确认（我确认覆盖）",
			skillReinstallForce.includes("我确认覆盖") && skillReinstallForce.includes("面板打开后又改过"),
			skillReinstallForce.slice(0, 800));
	} catch (e) {
		check("R38 Skill：覆盖确认态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ②d R21：不可自动改写的 YAML 错误（Tab 缩进 / 重复键 / 引号没闭合）——
	   只给「改法」，**不给**「修成块标量…」按钮（按了也不会好，比不给更糟） */
	t.store.local = {
		skills: {
			...skillsFixture,
			items: [skillItem({ dir: "iota", name: "iota", hostVisible: false, modelInvocable: null, description: null,
				yamlIssue: { code: "tab-indent", kind: "tab-indent", fixable: false, key: null, line: 3,
					message: "第 3 行的缩进里有 Tab", fix: "把缩进里的 Tab 换成两个空格" } })],
			counts: { ...skillsFixture.counts, dirs: 1, skills: 1, valid: 0, backups: 0, yamlBroken: 1, invalid: 0,
				duplicates: 0, duplicateDirs: 0, notVisible: 1, hostVisible: 0, modelInvisible: 0, byPanel: 0 },
			yamlBroken: [{ dir: "iota", code: "tab-indent", message: "第 3 行的缩进里有 Tab", fix: "把缩进里的 Tab 换成两个空格" }],
			duplicates: [], notVisible: [{ dir: "iota", name: "iota" }], invalid: [], modelInvisible: [],
			summary: "1 个技能 · 宿主认 0 个 · 1 个 frontmatter 写坏了（宿主读不了）"
		}
	};
	resetHooks();
	hooks[2] = true;
	let skillNonFix = "";
	try {
		skillNonFix = textOf(t.Skills({})).join(" | ");
		check("已装 Skill：不可自动改写的 YAML 错误也给改法", skillNonFix.includes("把缩进里的 Tab 换成两个空格"), skillNonFix.slice(0, 400));
		check("已装 Skill：不可自动改写的问题不显示「修成块标量…」", !skillNonFix.includes("修成块标量…"), skillNonFix.slice(0, 400));
	} catch (e) {
		check("已装 Skill：不可改写态渲染不抛异常", false, String((e && e.message) || e));
	}

	/* ③ 读不到 / 空 / 宿主对账不了 三种兜底 */
	t.store.local = { skills: { ok: false, error: "宿主还没重启：技能清单是新代码" } };
	resetHooks();
	const skillErr = textOf(t.Skills({})).join(" | ");
	check("已装 Skill：读不到时把原因说出来", skillErr.includes("读不到：宿主还没重启"), skillErr.slice(0, 160));
	check("已装 Skill：读不到时有「重试」", skillErr.includes("重试"));

	t.store.local = { skills: { ...skillsFixture, counts: { roots: 1, dirs: 0, skills: 0, valid: 0, backups: 0, hostTotal: 0, hostVisible: 0, notVisible: 0, invalid: 0, duplicates: 0, duplicateDirs: 0, modelInvisible: 0, hostOnly: 0, byPanel: 0 }, items: [], duplicates: [], notVisible: [], invalid: [], modelInvisible: [], summary: "0 个技能 · 宿主认 0 个" } };
	resetHooks();
	hooks[2] = true;
	const skillEmpty = textOf(t.Skills({})).join(" | ");
	check("已装 Skill：空技能根有兜底文案", skillEmpty.includes("还没有技能"), skillEmpty.slice(0, 200));

	t.store.local = { skills: { ...skillsFixture, host: { available: false, total: null, complete: null, error: "no-service" }, notes: ["这台宿主的 Skill 服务不可用，没法对账「宿主认了哪些」"], summary: "3 个技能 · 宿主清单读不到", counts: { ...skillsFixture.counts, notVisible: 0, hostTotal: null, hostVisible: 0 } } };
	resetHooks();
	const skillBlind = textOf(t.Skills({})).join(" | ");
	check("已装 Skill：对账不了时如实说（不当成「全都没被认」）", skillBlind.includes("Skill 服务不可用"), skillBlind.slice(0, 260));
	check("已装 Skill：对账不了时标题不写「宿主认 N 个」", skillBlind.includes("宿主认 ?"), skillBlind.slice(0, 120));

	t.store.local = savedSkillsLocal;
} else {
	check("__test 暴露了 Skills", false);
}

/* ── R25：搜索卡上的「已装」要分来源 ─────────────────────────────────────
 * 本机 24 个依赖是 link: 的本机目录（自己写的插件）。只按名字显示「已装」，
 * 同名 npm 包会被当成同一个包 —— 点安装就把本机那份换掉。这里钉两件事：
 *  ① chip 必须带来源形态（「已装 v0.4.0 · 本机目录」），不是只有版本号；
 *  ② 「同名但来源不同」的红旗、「你搜的是本机插件」的提示必须真的画出来。 */
if (typeof t.AiBox === "function") {
	const savedAiLocal = t.store.local;
	t.store.local = Object.assign({}, savedAiLocal, {
		aiBusy: false,
		ai: {
			reply: "搜索：dsh-imgops（6 条）",
			searchOnly: true,
			localOnly: { name: "dsh-imgops", version: "0.4.0", kind: "link", kindLabel: "本机目录", spec: "link:D:/ws/DSH-Plugin/dsh-imgops",
				text: "「dsh-imgops」是本机已装的插件（本机目录），本机目录装的（link:），不会出现在 npm / GitHub 的检索结果里" },
			recommendations: [
				{
					name: "dsh-imgops", source: "npm", spec: "dsh-imgops@0.4.0", version: "0.4.0", why: "同名但不同来源",
					installedKnown: true, installed: "0.4.0", installedKindLabel: "本机目录",
					installedSpec: "link:D:/ws/DSH-Plugin/dsh-imgops", installedSource: "different",
					trust: { level: "community", badges: [], flags: [{ id: "name-collision", tone: "error",
						text: "同名但来源不同：本机这份是本机目录（link:…），这条来自 npm —— 装它会把本机那份换掉" }], score: 40 }
				},
				{
					name: "dsh-never", source: "npm", spec: "dsh-never@1.0.0", version: "1.0.0", why: "没装过",
					installed: null, installedKnown: false,
					trust: { level: "community", badges: [], flags: [], score: 60 }
				}
			]
		}
	});
	resetHooks();
	const aiText = textOf(t.AiBox({})).join(" | ");
	check("搜索卡：已装标记带来源形态（本机目录）", aiText.includes("已装 v0.4.0 · 本机目录"), aiText.slice(0, 300));
	check("搜索卡：同名不同来源的红旗画出来", aiText.includes("同名但来源不同：本机这份是本机目录"), aiText.slice(0, 400));
	check("搜索卡：搜的是本机插件时有一句解释", aiText.includes("本机已装的插件（本机目录）"), aiText.slice(0, 300));
	t.store.local = Object.assign({}, savedAiLocal, { aiBusy: false, ai: { reply: "搜索：x（2 条）", searchOnly: true, localOnly: null, recommendations: [] } });
	resetHooks();
	const aiPlain = textOf(t.AiBox({})).join(" | ");
	check("搜索卡：没有这条提示时不画空容器", !aiPlain.includes("本机已装的插件"), aiPlain.slice(0, 200));
	t.store.local = savedAiLocal;
} else {
	check("__test 暴露了 AiBox", false);
}

/* ── R20：窄屏结构契约（360×658）───────────────────────────────────────────
 * 真机/离屏实测过（主面板 360、设置面板 360×634、已装 Skill 展开 55 行）都是 0 溢出，
 * 但那次是「量出来的」，代码一改就没人再量。这里把它钉成文本契约：
 * 宽度必须流体、必须有 760px 媒体查询、不许出现 >320px 的固定宽度。 */
const cssStart = code.indexOf("const CSS = `");
const cssEnd = cssStart >= 0 ? code.indexOf("\n`;", cssStart) : -1;
const cssText = cssStart >= 0 && cssEnd > cssStart ? code.slice(cssStart + 12, cssEnd) : "";
check("窄屏：能提取到插件的 CSS（提取失败则这组检查全失效）", cssText.length > 5000, cssText.length);
const mediaIdx = cssText.search(/@media\s*\(max-width:\s*760px\)/);
check("窄屏：有 760px 媒体查询（窄屏要靠它收边距/堆叠标题）", mediaIdx >= 0);
check("窄屏：媒体查询里收紧了面板内边距", mediaIdx >= 0 && /\.dpi-panel\{[^}]*padding/.test(cssText.slice(mediaIdx)));
check("窄屏：设置面板宽度流体 + 内部可滚动 + 有高度上限",
	/\.dpi-settings\{[^}]*width:\s*(?:min\(|100%)/.test(cssText) &&
	/\.dpi-settings\{[^}]*overflow:\s*auto/.test(cssText) &&
	/\.dpi-settings\{[^}]*max-height:/.test(cssText));
check("窄屏：没有超过 320px 的固定宽度（360 宽下必溢出）",
	!/\.dpi-[\w-]+\{[^}]*\bwidth:\s*(?:3[3-9]\d|[4-9]\d\d|\d{4,})px/.test(cssText));

/* R36：清单下拉必须把 header 抬成层叠上下文，否则会被后面的卡片盖住。
   真机 Playwright 夹具见 dev/fixtures/stacking/index.html（old=1 复现，new 修复后）。 */
check("R36 层叠：header 有 position + z-index（下拉不被卡片盖住）",
	/\.dpi-header\{[^}]*position:relative[^}]*z-index:\s*30/.test(cssText), cssText.match(/\.dpi-header\{[^}]*\}/)?.[0]);
check("R36 层叠：菜单 z-index 高于 header 的 30",
	/\.dpi-menu\{[^}]*z-index:\s*(?:[3-9]\d|\d{3,})/.test(cssText), cssText.match(/\.dpi-menu\{[^}]*\}/)?.[0]);

/* ── R30：界面打磨（两行历史 / 状态胶囊 / 空态 / 展开边界 / 自绘图标）──────────────
   这一组钉的是「公开之前的观感契约」：它们不改变任何判据，但改坏了用户第一眼就看得出来，
   而静态审计与行为自检都不管这一层。 */
if (typeof t.History === "function") {
	const savedData = t.store.data;
	const savedLocal = t.store.local;
	const jobFixture = {
		id: "job-r30-1",
		status: "failed",
		title: "dsh-ffmpeg · DSH 插件",
		createdAt: "2026-10-26T08:25:03.000Z",
		updatedAt: "2026-10-26T08:25:09.000Z",
		detected: { version: "0.5.1", kind: "bundle" },
		installedBefore: { version: "0.5.0" },
		error: { code: "upgrade-stalled", message: "升级没有发生：宿主拒绝原地换版本（0.5.0 → 0.5.1）" },
		stages: []
	};

	t.store.data = { jobs: [jobFixture], active: null, host: {} };
	t.store.local = savedLocal;
	resetHooks();
	const histTree = t.History({});
	const histText = textOf(histTree).join(" ");
	const pills = findNodes(histTree, (props) => typeof props.className === "string" && props.className.indexOf("dpi-status") === 0);
	check("R30 历史：状态是一颗粒（不是 7px 裸点，失败一眼认得出）",
		pills.length === 1 && /is-failed/.test(pills[0].props.className || ""),
		{ count: pills.length, classes: pills.map((node) => node.props.className) });
	check("R30 历史：第二行同时给版本跨度与失败原因",
		/0\.5\.0 → 0\.5\.1/.test(histText) && /宿主拒绝原地换版本/.test(histText));
	check("R30 历史：展开箭头是自绘 SVG（不是 ▸ 字符冒充图标）",
		findNodes(histTree, (props) => Boolean(props && props.viewBox === "0 0 24 24")).length >= 1);
	check("R30 历史：次要行单行省略（nowrap + ellipsis，行高才不会忽高忽低）",
		/\.dpi-hist-meta\{[^}]*white-space:nowrap/.test(cssText) && /\.dpi-hist-meta\{[^}]*text-overflow:ellipsis/.test(cssText));

	/* 空态：公开之后第一次打开看到的就是这里 */
	t.store.data = { jobs: [], active: null, host: {} };
	resetHooks();
	const emptyTree = t.History({});
	check("R30 空态：一条记录都没有时给「怎么开始」而不是一片空白",
		/还没有安装记录/.test(textOf(emptyTree).join(" ")) &&
		findNodes(emptyTree, (props) => typeof props.className === "string" && props.className.indexOf("dpi-empty") === 0).length === 1);

	/* 展开态：hooks[2] 是上一段 useStore + useState 之后的 openId */
	t.store.data = { jobs: [jobFixture], active: null, host: {} };
	resetHooks();
	hooks[2] = jobFixture.id;
	const openTree = t.History({});
	check("R30 历史：展开内容包在 .dpi-hist-detail 里（有边界，不铺在卡片底色上）",
		findNodes(openTree, (props) => typeof props.className === "string" && props.className.indexOf("dpi-hist-detail") === 0).length === 1);
	check("R30 历史：展开时不再把标题重复一遍（hideHead 传进详情）",
		findNodes(openTree, (props) => typeof props.className === "string" && props.className === "dpi-job-head").length === 0);

	/* 清历史（R30）：有历史才有「清理」，而且是两段式（第一下只是变成「确认清理？」） */
	const clearButtons = (tree) => findNodes(tree, (props) =>
		typeof props.className === "string" && props.className.indexOf("dpi-btn") >= 0 &&
		typeof props.children === "string" && /清理/.test(props.children));
	const listTree = (() => {
		t.store.data = { jobs: [jobFixture], active: null, host: {} };
		resetHooks();
		return t.History({});
	})();
	check("R30 清历史：有历史时头部有「清理」按钮", clearButtons(listTree).length === 1);
	const confirmTree = (() => {
		t.store.data = { jobs: [jobFixture], active: null, host: {} };
		resetHooks();
		hooks[3] = true; /* openId / confirmClear 之后的二次确认态 */
		return t.History({});
	})();
	check("R30 清历史：第一下只把按钮变成「确认清理？」（不直接清）",
		clearButtons(confirmTree).some((node) => /确认清理/.test(node.props.children)) &&
		/dpi-btn-confirm/.test(String((clearButtons(confirmTree)[0] || { props: {} }).props.className || "")));
	check("R30 清历史：一条记录都没有时不出现「清理」（没有可清的东西）",
		clearButtons(emptyTree).length === 0);

	t.store.data = savedData;
	t.store.local = savedLocal;
} else {
	check("__test 暴露了 History", false);
}

/* 头部品牌块与图标集 */
check("R30 头部：有版本胶囊 .dpi-ver，且号取自 host.build（公开后第一件要能回答「我装的是哪一版」）",
	/className: "dpi-ver"/.test(code) && /String\(host\.build\)\.split/.test(code) && /\.dpi-ver\{/.test(cssText));
check("R30 图标：自绘 SVG 图标集（同一套描边 1.7，不用 unicode 冒充）",
	typeof t.Glyph === "function" && /function Glyph/.test(code) && /strokeWidth: 1\.7/.test(code));

/* R31：直连安装卡 —— 已经直连装着的**不出按钮**（那正是「总要再装一遍」的另一半）；
   能直连时给按钮 + 二次确认；被拒绝时只解释、不给假按钮。 */
if (typeof t.LinkInstallCard === "function") {
	const savedData = t.store.data;
	t.store.data = null;

	const already = {
		id: "job-a",
		status: "done",
		detected: { kind: "bundle", name: "dsh-x" },
		link: { ok: true, alreadyLinked: true, entryLinked: true, name: "dsh-x", sourceDir: "D:/plug/x", steps: [] }
	};
	resetHooks();
	check("R31 直连卡：已经直连装着时不出现（不再劝人装一遍）", t.LinkInstallCard({ job: already, busy: null, act: () => {} }) == null);

	const fresh = {
		id: "job-b",
		status: "failed",
		detected: { kind: "bundle", name: "dsh-lemofilm" },
		link: { ok: true, alreadyLinked: false, entryLinked: false, name: "dsh-lemofilm", sourceDir: "D:/plug/lemofilm", steps: ["建链接", "依赖声明 → link:…"] }
	};
	resetHooks();
	const freshEl = t.LinkInstallCard({ job: fresh, busy: null, act: () => {} });
	const freshText = freshEl ? textOf(freshEl).join(" | ") : "";
	check("R31 直连卡：给出「直连安装（不走 pnpm）」按钮", freshText.includes("直连安装（不走 pnpm）"), freshText.slice(0, 120));
	check("R31 直连卡：写明这条路不碰依赖树", /不重算依赖树|不跑 pnpm/.test(freshText), freshText.slice(0, 160));
	check("R31 直连卡：默认不展开二次确认", !freshText.includes("我确认直连安装"));
	check("R31 直连卡：把要做的几处改动列出来", freshText.includes("建链接"), freshText.slice(0, 200));

	resetHooks();
	hooks[0] = true;
	const askingEl = t.LinkInstallCard({ job: fresh, busy: null, act: () => {} });
	const askingText = askingEl ? textOf(askingEl).join(" | ") : "";
	check("R31 直连卡：二次确认写明会改 profile 与「要重启才生效」",
		askingText.includes("我确认直连安装") && /重启/.test(askingText) && /package\.json/.test(askingText), askingText.slice(0, 220));
	check("R31 直连卡：二次确认有「再想想」", askingText.includes("再想想"));

	const blocked = {
		id: "job-c",
		status: "failed",
		detected: { kind: "bundle", name: "dsh-y" },
		link: { ok: false, blocked: { code: "real-directory", text: "node_modules/dsh-y 是一份真实目录", plain: "大白话：那是 pnpm 的地盘。", fix: [{ text: "先卸载那一份" }] } }
	};
	resetHooks();
	const blockedEl = t.LinkInstallCard({ job: blocked, busy: null, act: () => {} });
	const blockedText = blockedEl ? textOf(blockedEl).join(" | ") : "";
	check("R31 直连卡：被拒绝时只解释、不给按钮",
		blockedText.includes("直连安装被拒") && !blockedText.includes("直连安装（不走 pnpm）"), blockedText.slice(0, 160));

	resetHooks();
	check("R31 直连卡：没有 link 判据时什么都不渲染", t.LinkInstallCard({ job: { id: "j", detected: { kind: "skill" } }, busy: null, act: () => {} }) == null);
	t.store.data = savedData;
} else {
	check("__test 暴露了 LinkInstallCard", false);
}

/* R31：pnpm 信任策略豁免卡 —— 只在 trust-downgrade 时出现；按钮文案点名那个包与版本。 */
if (typeof t.TrustExemptCard === "function") {
	const savedData = t.store.data;
	t.store.data = null;

	const plainJob = { id: "job-1", install: { failure: { kind: "unknown" } } };
	resetHooks();
	check("R31 信任卡：不是 trust-downgrade 就不出现", t.TrustExemptCard({ job: plainJob, busy: null, act: () => {} }) == null);

	const trustJob = {
		id: "job-2",
		install: {
			failure: {
				kind: "trust-downgrade",
				trust: { package: "chromium-bidi", version: "157.0.8090-0", entry: "chromium-bidi@157.0.8090-0", root: "dsh-vision-router@3.1.0", via: "puppeteer-core@25.16.0" },
				action: { kind: "add-trust-exclude", entry: "chromium-bidi@157.0.8090-0" }
			}
		}
	};
	resetHooks();
	const trustEl = t.TrustExemptCard({ job: trustJob, busy: null, act: () => {} });
	const trustText = trustEl ? textOf(trustEl).join(" | ") : "";
	check("R31 信任卡：点名被挡的包与版本", trustText.includes("chromium-bidi@157.0.8090-0"), trustText.slice(0, 140));
	check("R31 信任卡：说清「跟你要装的插件无关」", /无关/.test(trustText), trustText.slice(0, 160));
	check("R31 信任卡：写出是谁把它拉进来的", /dsh-vision-router@3\.1\.0/.test(trustText), trustText.slice(0, 200));
	check("R31 信任卡：默认不展开二次确认", !trustText.includes("我确认豁免这一个版本"));

	resetHooks();
	hooks[0] = true;
	const trustAsking = t.TrustExemptCard({ job: trustJob, busy: null, act: () => {} });
	const trustAskingText = trustAsking ? textOf(trustAsking).join(" | ") : "";
	check("R31 信任卡：二次确认说清「这一步等于把闸门打开」",
		trustAskingText.includes("我确认豁免这一个版本") && /闸门|不再/.test(trustAskingText), trustAskingText.slice(0, 240));
	check("R31 信任卡：二次确认写明只到这一条、不做通配", /通配/.test(trustAskingText), trustAskingText.slice(0, 240));
	t.store.data = savedData;
} else {
	check("__test 暴露了 TrustExemptCard", false);
}

/* R34：阶段时间线 → 进度条。
   用户原话：「绿色方框简化成进度条；加载时下方浮现一行淡淡的小字显示目前正在做什么；
   结束时不再浮现小字，但可以点开显示某一步做了什么」。这三条都必须在这里被钉住，
   否则「简化」很容易退化成「把信息弄丢了」。 */
if (typeof t.StageProgress === "function") {
	const runningStages = [
		{ key: "input", label: "① 输入接入", status: "ok", detail: "npm：dsh-ffmpeg@0.7.3", ms: 1300 },
		{ key: "download", label: "② 下载", status: "ok", detail: "78 KiB", ms: 400 },
		{ key: "install", label: "⑧ 安装", status: "running", detail: "正在写 profile" }
	];
	const doneStages = [
		{ key: "input", label: "① 输入接入", status: "ok", detail: "npm：dsh-ffmpeg@0.7.3", ms: 1300 },
		{ key: "install", label: "⑧ 安装", status: "fail", detail: "插件装上了，但没激活：启动时抛错", ms: 13000 }
	];
	resetHooks();
	check("R34 进度条：没有阶段就不渲染", t.StageProgress({ stages: [], status: "running" }) == null);

	resetHooks();
	const runningEl = t.StageProgress({ stages: runningStages, status: "running" });
	const runningText = runningEl ? textOf(runningEl).join(" | ") : "";
	check("R34 进度条：跑起来时下方有一行「现在在做什么」",
		runningText.includes("⑧ 安装") && runningText.includes("正在写 profile"), runningText.slice(0, 160));
	check("R34 进度条：默认不把每一步全铺开（那正是要简化掉的东西）",
		!runningText.includes("① 输入接入"), runningText.slice(0, 160));
	check("R34 进度条：给出进度计数", /\d+\/\d+/.test(runningText), runningText.slice(0, 120));
	check("R34 进度条：当前那段是 running（会呼吸），已完成的是 done", (() => {
		const segs = findNodes(runningEl, (p) => p && typeof p.className === "string" && p.className.includes("dpi-progress-seg"));
		const names = segs.map((n) => String(n.props.className));
		return names.some((c) => c.includes("is-running")) && names.some((c) => c.includes("is-done"));
	})());

	resetHooks();
	const doneEl = t.StageProgress({ stages: doneStages, status: "failed" });
	const doneText = doneEl ? textOf(doneEl).join(" | ") : "";
	check("R34 进度条：跑完就没有那行小字了", !doneText.includes("⑧ 安装"), doneText.slice(0, 160));
	check("R34 进度条：失败时说「失败」而不是数字", doneText.includes("失败"), doneText.slice(0, 120));

	resetHooks();
	hooks[0] = true;
	const openEl = t.StageProgress({ stages: runningStages, status: "done" });
	const openText = openEl ? textOf(openEl).join(" | ") : "";
	check("R34 进度条：点开后能看某一步做了什么（label + detail + 耗时）",
		openText.includes("① 输入接入") && openText.includes("npm：dsh-ffmpeg@0.7.3") && openText.includes("1.3s"), openText.slice(0, 200));
} else {
	check("__test 暴露了 StageProgress", false);
}

/* R34：事后的证据收进「技术细节」，默认不糊在脸上；等待确认时预检必须留在外面（那是按不按的依据） */
if (typeof t.JobTechFold === "function") {
	const precheck = {
		blocked: false,
		needsConfirm: true,
		severity: "medium",
		reasons: [{ level: "warn", text: "需要确认：写/删文件(2 个文件)" }],
		risks: { summary: "写/删文件(2 个文件)", hits: [] },
		compat: { verdict: "ok", runtimeVersion: "0.2.1-rc.5", via: "app-boot(asar)" }
	};
	const foldJob = {
		id: "job-fold",
		status: "done",
		detected: { kind: "bundle", name: "dsh-ffmpeg", version: "0.7.3", files: 29, bytes: 201728 },
		precheck,
		review: { status: "safe", verdict: "safe", summary: "未发现投放行为" },
		install: { kind: "bundle", result: { ok: true, changed: true } }
	};
	resetHooks();
	const foldEl = t.JobTechFold({ job: foldJob });
	const foldText = foldEl ? textOf(foldEl).join(" | ") : "";
	check("R34 技术细节：默认收起（预检理由 / 审查结论 / 回执 JSON 都不在这里）",
		!foldText.includes("写/删文件") && !foldText.includes("未发现投放行为") && !foldText.includes("changed"), foldText.slice(0, 200));
	check("R34 技术细节：标题写明里面有什么", foldText.includes("技术细节") && foldText.includes("安全预检"), foldText.slice(0, 160));

	resetHooks();
	hooks[0] = true;
	const foldOpen = t.JobTechFold({ job: foldJob });
	const foldOpenText = foldOpen ? textOf(foldOpen).join(" | ") : "";
	check("R34 技术细节：点开后一条不少（预检理由 + 审查卡 + 回执 + 来源信息）",
		foldOpenText.includes("写/删文件") && foldOpenText.includes("AI 语义审查") && foldOpenText.includes("changed") && foldOpenText.includes("dsh-ffmpeg"), foldOpenText.slice(0, 240));

	resetHooks();
	check("R34 技术细节：等待确认时预检**不进**折叠（它要留在外面当决策依据）", (() => {
		const waiting = t.JobTechFold({ job: { ...foldJob, status: "awaiting-confirm" } });
		return waiting == null || !String(textOf(waiting).join(" | ")).includes("安全预检");
	})());
	resetHooks();
	check("R34 技术细节：没有什么可折的时候不渲染", t.JobTechFold({ job: { id: "x", status: "done" } }) == null);

	/* 回归（本轮真踩过）：审查卡**只该在折叠里**。改版时漏删了 JobDetail 里那一行，
	   结果它一直挂在折叠外面 —— 实测那一张 507px，占掉整张历史卡的一半高度。 */
	resetHooks();
	const detailEl = t.JobDetail({ job: foldJob });
	const detailText = detailEl ? textOf(detailEl).join(" | ") : "";
	check("R34 历史卡：审查卡正文默认不出现在折叠外面（只在「技术细节」里）",
		!detailText.includes("判 safe 不单独放行"), detailText.slice(0, 320));
} else {
	check("__test 暴露了 JobTechFold", false);
}

/* R34：宿主没起来时不再甩「响应不是 JSON（HTTP 404）」，而是说人话 + 自动重连 + 给真处置 */
if (typeof t.HostDownBanner === "function") {
	resetHooks();
	const fresh = t.HostDownBanner({ host: { down: true, since: Date.now() - 5000, attempts: 2, error: "HTTP 404（返回的不是 JSON，说明这不是面板的路由）" }, onRetry: () => {} });
	const freshText = fresh ? textOf(fresh).join(" | ") : "";
	check("R34 掉线条：说人话（连不上宿主半边 + 第几次重连）",
		freshText.includes("连不上宿主半边") && freshText.includes("第 2 次重连"), freshText.slice(0, 200));
	check("R34 掉线条：给「立即重试」按钮", freshText.includes("立即重试"), freshText.slice(0, 200));
	check("R34 掉线条：10 秒内说「正在重启」（这是最常见的真实情况）", freshText.includes("正在重启"), freshText.slice(0, 220));
	check("R34 掉线条：保留原始错误作为证据（不隐瞒）", freshText.includes("404"), freshText.slice(0, 260));
	check("R34 掉线条：默认不展开「怎么办」（先给结论，别一上来三屏字）", !freshText.includes("dsh-boot-guard"), freshText.slice(0, 260));

	resetHooks();
	const stale = t.HostDownBanner({ host: { down: true, since: Date.now() - 120000, attempts: 40, error: "HTTP 404" }, onRetry: () => {} });
	const staleText = stale ? textOf(stale).join(" | ") : "";
	check("R34 掉线条：超过一分钟改口「这次启动大概失败了」", staleText.includes("这次启动大概失败了"), staleText.slice(0, 220));

	resetHooks();
	hooks[0] = true;
	const helped = t.HostDownBanner({ host: { down: true, since: Date.now() - 120000, attempts: 40, error: "HTTP 404" }, onRetry: () => {} });
	const helpedText = helped ? textOf(helped).join(" | ") : "";
	check("R34 掉线条：展开后给两条真处置（dsh-tools 地雷 / 恢复对话框别点禁用）",
		helpedText.includes("dsh-tools") && helpedText.includes("禁用第三方插件"), helpedText.slice(0, 400));
} else {
	check("__test 暴露了 HostDownBanner", false);
}

/* R35：「等待确认」要先给一个**决定条**，再折叠细节。
   用户原话：「安装过程也需要简化，信息有点太多，不知道该看哪个」。
   这张卡原来把「安全预检」+「用途 vs 权限」两张巨卡摊开，而且里面还有逐字重复的段落。 */
if (typeof t.DecisionBar === "function") {
	const purposeErr = {
		purpose: { label: "界面 / 交互增强" },
		verdict: "error",
		unexpected: [{ kind: "child-process", label: "启动子进程" }, { kind: "fs-write", label: "写/删文件" }, { kind: "network", label: "网络请求" }]
	};
	const waitingJob = {
		id: "job-wait",
		status: "awaiting-confirm",
		precheck: {
			blocked: false,
			needsConfirm: true,
			severity: "high",
			purpose: purposeErr,
			risks: { summary: "写/删文件(2 个文件)、读文件(2 个文件)、网络请求(2 个文件)、组合信号×1", scripts: [{ name: "prepublishOnly" }] },
			reasons: [
				{ level: "warn", text: "静态扫描发现高危能力信号", detail: "写/删文件(2 个文件)、读文件(2 个文件)" },
				{ level: "warn", text: "权限与用途不符：用途「界面 / 交互增强」与它要的能力不符：启动子进程、写/删文件", detail: "这一整段和下面的用途卡逐字重复" }
			]
		}
	};
	resetHooks();
	const barEl = t.DecisionBar({ job: waitingJob });
	const barText = barEl ? textOf(barEl).join(" | ") : "";
	check("R35 决定条：一句话说清「为什么停下来」", barText.includes("为什么停下来") && barText.includes("它自称「界面 / 交互增强」") && barText.includes("不像这个用途该有的"), barText.slice(0, 200));
	check("R35 决定条：把能力列成 chips（不再是一整段文字）", (() => {
		const chips = findNodes(barEl, (p) => p && typeof p.className === "string" && p.className.includes("dpi-chip"));
		return chips.length >= 3;
	})());
	check("R35 决定条：组合信号不算「能力」", !barText.includes("组合信号"), barText.slice(0, 220));
	check("R35 决定条：有安装期脚本时单独提醒（会真的在本机跑）", barText.includes("安装期脚本") && barText.includes("prepublishOnly"), barText.slice(0, 260));

	resetHooks();
	const barNoPurpose = t.DecisionBar({ job: { id: "j", status: "awaiting-confirm", precheck: { needsConfirm: true, risks: { summary: "网络请求(1 个文件)" } } } });
	const barNoPurposeText = barNoPurpose ? textOf(barNoPurpose).join(" | ") : "";
	check("R35 决定条：认不出用途时也给一句人话（不空着）", /为什么停下来/.test(barNoPurposeText) && /点头|确认/.test(barNoPurposeText), barNoPurposeText.slice(0, 160));

	/* 去重：purpose 卡在场时，不再由 precheck 重复渲染那条「权限与用途不符」 */
	resetHooks();
	const pcEl = t.PrecheckCard({ precheck: waitingJob.precheck });
	const pcText = pcEl ? textOf(pcEl).join(" | ") : "";
	check("R35 预检卡：不再重复「权限与用途不符」那一段（交给用途卡说一次）", !pcText.includes("权限与用途不符"), pcText.slice(0, 240));
	check("R35 预检卡：静态扫描的同一条明细不再说两遍", (pcText.match(/写\/删文件\(2 个文件\)/g) || []).length <= 2, (pcText.match(/写\/删文件\(2 个文件\)/g) || []).length);

	/* 决定条在，详细判据进折叠 */
	resetHooks();
	const waitDetail = t.JobDetail({ job: waitingJob });
	const waitDetailText = waitDetail ? textOf(waitDetail).join(" | ") : "";
	check("R35 等待确认：先给决定条", waitDetailText.includes("为什么停下来"), waitDetailText.slice(0, 200));
	/* ⚠️ 不能用「文本里看不到预检正文」来判折叠：textOf 会把 <details> 里的子节点也读出来
	   （React 里它们本来就被渲染了，只是视觉上收起）。判据必须是**结构**：预检卡挂在 details 下。 */
	check("R35 等待确认：详细判据收进折叠（预检不是顶层直挂）", (() => {
		const why = findNodes(waitDetail, (p) => p && typeof p.className === "string" && p.className.includes("dpi-why"));
		if (why.length !== 1) return false;
		const kids = [].concat((why[0].props && why[0].props.children) || []);
		return kids.some((kid) => kid && kid.type === t.PrecheckCard);
	})(), "预检卡应作为 <details> 的子节点");
} else {
	check("__test 暴露了 DecisionBar", false);
}

/* R35 兜底：整段 pnpm 输出停在任务里时，界面只该显示「该看的那一行」 */
if (typeof t.JobDetail === "function") {
	const noisy = {
		id: "job-noisy",
		status: "failed",
		error: {
			code: "remove-failed",
			message: [
				"卸载旧版失败：✓ Lockfile passes supply-chain policies (verified 54m ago)",
				"Progress: resolved 33, reused 8, downloaded 0, added 0",
				"[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 6 resolution-policy violations were produced."
			].join("\n")
		}
	};
	resetHooks();
	const noisyEl = t.JobDetail({ job: noisy });
	const noisyText = noisyEl ? textOf(noisyEl).join(" | ") : "";
	check("R35 老任务：界面只显示该看的那一行（不再把整段 pnpm 输出倒出来）",
		noisyText.includes("ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED") && !noisyText.includes("Progress: resolved"), noisyText.slice(0, 220));
	check("R35 老任务：保留「卸载旧版失败：」这层前缀（知道是哪一步挂的）",
		noisyText.includes("卸载旧版失败：") && !noisyText.includes("✓ Lockfile"), noisyText.slice(0, 200));
}

/* ── R36：清单菜单 / 浮窗 / 已装 MCP / 独立更新条 ─────────────────────────
 * 这一轮改的是「入口的位置」：三个低频清单从主面板搬进浮窗，检查更新单独留一条。
 * 位置错了用户会以为功能没了，所以这组断言钉的是「入口在、内容在、关得掉」。 */
if (typeof t.ListMenu === "function") {
	const picked = [];
	resetHooks();
	hooks[0] = true; /* useState(open) */
	const menu = t.ListMenu({ counts: { plugins: 3, skills: 4, mcp: 2 }, onPick: (key) => picked.push(key), onOpen: () => {} });
	const menuText = textOf(menu).join(" | ");
	check("R36 清单：按钮文字是「清单」", menuText.includes("清单"), menuText.slice(0, 120));
	check("R36 清单：三个条目齐全", menuText.includes("已装插件") && menuText.includes("已装 Skill") && menuText.includes("已装 MCP"), menuText.slice(0, 200));
	check("R36 清单：条目带计数", menuText.includes("3") && menuText.includes("4") && menuText.includes("2"));
	const items = findNodes(menu, (props) => props && props.className === "dpi-menu-item");
	check("R36 清单：三项都可点", items.length === 3, items.length);
	if (items[0] && items[0].props.onClick) items[0].props.onClick();
	check("R36 清单：点一项回调到对应清单", picked[0] === "plugins", picked);
} else {
	check("__test 暴露了 ListMenu", false);
}

if (typeof t.FloatWindow === "function") {
	let closed = 0;
	resetHooks();
	const win = t.FloatWindow({ title: "已装 MCP", subtitle: "浮窗副标题", onClose: () => { closed += 1; }, children: "内容" });
	const winText = textOf(win).join(" | ");
	check("R36 浮窗：标题与副标题都渲染", winText.includes("已装 MCP") && winText.includes("浮窗副标题"), winText.slice(0, 120));
	check("R36 浮窗：有右上角关闭按钮", findNodes(win, (props) => props && props.className === "dpi-float-x").length === 1);
	const xBtn = findNodes(win, (props) => props && props.className === "dpi-float-x")[0];
	if (xBtn && xBtn.props.onClick) xBtn.props.onClick();
	check("R36 浮窗：点 X 会关", closed === 1, closed);
	const overlay = findNodes(win, (props) => typeof props.className === "string" && props.className.includes("dpi-float-overlay"))[0];
	if (overlay && overlay.props.onClick) overlay.props.onClick();
	check("R36 浮窗：点周围空白也会关", closed === 2, closed);
}

if (typeof t.UpdateBar === "function") {
	const saved = t.store.local;
	const savedData = t.store.data;
	t.store.local = {
		inventory: {
			ok: true,
			counts: { total: 3, bundle: 2 },
			summary: { checked: 2, outdated: 1, current: 1, ahead: 0, failed: 0 },
			items: [{ name: "a", update: { relation: "outdated" } }]
		},
		mcp: { ok: true, counts: { total: 1, running: 1 }, items: [] },
		mcpUpdates: {
			at: "2026-10-30T14:00:00.000Z",
			summary: { checked: 1, outdated: 1, current: 0, ahead: 0, undetectable: 0, failed: 0 },
			items: []
		},
		skills: { ok: true, counts: { skills: 4, tracked: 1, untracked: 3, locallyEdited: 1, updatable: 1 }, items: [] },
		skillUpdates: {
			at: "2026-10-30T14:00:00.000Z",
			summary: { skills: 4, tracked: 1, untracked: 3, checked: 1, current: 0, outdated: 1, unknown: 0, locallyEdited: 1 },
			items: []
		}
	};
	t.store.data = { collaborator: { ok: true, line: "卸载协作：可用" } };
	resetHooks();
	const bar = t.UpdateBar({ onOpenList: () => {} });
	const barText = textOf(bar).join(" | ");
	check("R38 更新条：标题是「插件 / MCP / Skill 更新」（一个入口三条链）", barText.includes("插件 / MCP / Skill 更新"), barText.slice(0, 100));
	check("R36 更新条：检查更新独立出现", barText.includes("检查更新"));
	check("R38 更新条：同一条里同时报插件、MCP 与 Skill 的更新结果",
		barText.includes("插件：可升级 1 个") && barText.includes("MCP：可升级 1 台") && barText.includes("Skill：可升级 1 个"),
		barText.slice(0, 600));
	check("R36 更新条：可升级时给「全部升级」", barText.includes("全部升级 1"));
	check("R36 更新条：留一个「看清单」入口", barText.includes("看清单"));
	t.store.local = saved;
	t.store.data = savedData;
} else {
	check("__test 暴露了 UpdateBar", false);
}

/* R37：合并检查的一句话摘要 —— 0 条可检查 ≠ 都是最新的（本机 0 台 MCP 时第一版说过假话）。 */
if (typeof t.checkAllSummaryText === "function") {
	check("R37 合并摘要：0 条可检查时说「没有可检查的条目」（不许说都是最新的）",
		t.checkAllSummaryText({ ok: true, summary: { outdated: 2 } }, { summary: { checked: 0, outdated: 0 } }, null) === "插件可升级 2 个 · MCP 没有可检查的条目");
	check("R37 合并摘要：两边都可升级时一句说全",
		t.checkAllSummaryText({ ok: true, summary: { outdated: 2 } }, { summary: { checked: 1, outdated: 1 } }, null) === "插件可升级 2 个 · MCP 可升级 1 台");
	check("R37 合并摘要：一条链失败不吞掉另一条",
		t.checkAllSummaryText({ ok: false }, null, "MCP 更新检查失败：registry down") === "插件检查失败 · MCP 更新检查失败：registry down");
	check("R38 合并摘要：没有来源记录时不许说「Skill 都是最新的」",
		t.checkAllSummaryText({ ok: true, summary: { outdated: 2 } }, null, null, { summary: { skills: 58, tracked: 0, unknown: 0, outdated: 0 } }, null) === "插件可升级 2 个 · Skill 没有来源记录（存量补不回来）");
	check("R38 合并摘要：Skill 可升级时带上「无法判断」计数",
		t.checkAllSummaryText({ ok: true, summary: { outdated: 2 } }, null, null, { summary: { skills: 58, tracked: 3, unknown: 1, outdated: 1 } }, null) === "插件可升级 2 个 · Skill 可升级 1 个（无法判断 1）");
} else {
	check("__test 暴露了 checkAllSummaryText", false);
}

if (typeof t.McpList === "function") {
	const saved = t.store.local;
	t.store.local = {
		mcp: {
			ok: true,
			counts: { total: 2, running: 1, configured: 1, disabled: 0, problems: 0 },
			notes: ["只读 profile 的两份组合文件"],
			items: [
				{ id: "mcp-a", serverName: "alpha", transport: "stdio", command: "npx", args: ["-y", "@mcp/fs"], running: true, state: "running", envKeys: ["TOKEN"], file: "cordis.patch.yml", line: 1, problems: [] },
				{ id: "mcp-b", serverName: "beta", transport: "streamable-http", url: "https://b/mcp", running: false, state: "configured", envKeys: [], file: "cordis.patch.yml", line: 9, problems: [] }
			],
			template: "- id: mcp-x\n  name: '@deepseek-ai/dsh-mcp-client'"
		},
		mcpUpdates: {
			at: "2026-10-30T14:00:00.000Z",
			summary: { checked: 2, outdated: 1, current: 1, ahead: 0, undetectable: 1, failed: 0 },
			items: [
				{ serverName: "alpha", relation: "outdated", localVersion: "1.0.0", latestVersion: "2.0.0", gap: { text: "主版本 1 → 2" }, error: null, reason: "" },
				{ serverName: "beta", relation: "unknown", error: null, reason: "远程端点没有版本号，无法与本地配置比对" }
			]
		}
	};
	resetHooks();
	const mcpTree = t.McpList({});
	const mcpText = textOf(mcpTree).join(" | ");
	check("R36 MCP：卡片标题是「已装 MCP」", mcpText.includes("已装 MCP"), mcpText.slice(0, 120));
	check("R36 MCP：报「几台 · 几台在跑」", mcpText.includes("2 台") && mcpText.includes("1 台在跑"), mcpText.slice(0, 160));
	check("R36 MCP：运行中与未加载分开标", mcpText.includes("运行中") && mcpText.includes("已配置 · 未加载"));
	check("R36 MCP：显示启动命令与来源文件行", mcpText.includes("npx -y @mcp/fs") && mcpText.includes("cordis.patch.yml:1"));
	check("R36 MCP：env 只显示键名（不显示值）", mcpText.includes("env TOKEN") && !mcpText.includes("sk-"), mcpText.slice(0, 300));
	const mcpButtons = findNodes(mcpTree, (props) => typeof props.className === "string" && props.className.includes("dpi-btn"));
	const mcpCheckButtons = mcpButtons.filter((node) => textOf(node).join(" ").includes("检查更新"));
	check("R37 MCP 更新：不再有独立的「检查更新」按钮（合并到主面板）", mcpCheckButtons.length === 0, mcpCheckButtons.map((node) => textOf(node).join("")));
	check("R37 MCP 更新：说清更新检查在主面板一起查", mcpText.includes("主面板") && mcpText.includes("一起查"), mcpText.slice(0, 300));
	check("R36 MCP 更新：摘要报可升级 / 无法判断", mcpText.includes("可升级 1 台") && mcpText.includes("无法判断 1"), mcpText.slice(0, 400));
	check("R36 MCP 更新：可升级行给目标版本", mcpText.includes("可升级 → 2.0.0"), mcpText.slice(0, 500));
	check("R36 MCP 更新：无法判断时写明原因", mcpText.includes("无法判断") && mcpText.includes("远程端点没有版本号"), mcpText.slice(0, 600));

	t.store.local = {
		mcp: { ok: true, counts: { total: 0, running: 0, configured: 0, disabled: 0, problems: 0 }, notes: [], items: [], template: "- id: mcp-x" }
	};
	resetHooks();
	const emptyText = textOf(t.McpList({})).join(" | ");
	check("R36 MCP：空态给出两种加法", emptyText.includes("还没有配置 MCP 服务器") && emptyText.includes("mcp:<registry"));
	check("R36 MCP：空态能看并复制组合片段", emptyText.includes("看一段能直接抄") && emptyText.includes("复制"));
	check("R36 MCP 更新：没检查过时说清「没有统一版本源」", emptyText.includes("还没检查过 MCP 更新") && emptyText.includes("没有统一的版本源"), emptyText.slice(0, 300));

	t.store.local = { mcp: { ok: false, error: "宿主还没重启：MCP 清单是新代码", items: [], counts: { total: 0 } } };
	resetHooks();
	const errText = textOf(t.McpList({})).join(" | ");
	check("R36 MCP：读不到时说清原因并给重试", errText.includes("读不到：宿主还没重启") && errText.includes("重试"), errText.slice(0, 160));
	t.store.local = saved;
} else {
	check("__test 暴露了 McpList", false);
}

if (typeof t.AiBox === "function") {
	const saved = t.store.local;
	t.store.local = {
		aiBusy: false,
		ai: {
			reply: "搜索：time（2 条）",
			searchOnly: true,
			recommendations: [
				{ kind: "mcp", name: "ai.b77/time", displayName: "time", version: "1.0.0", source: "mcp-registry", serverName: "time", transport: "streamable-http", installPath: "https://time.b77.ai/mcp", installable: true, why: "远程时间服务", requiredEnv: [], trust: { badges: [{ label: "官方 MCP Registry", tone: "ok" }], flags: [] }, url: "https://example.com/repo" },
				{ kind: "mcp", name: "ai.example/auth", displayName: "auth", version: "1.0.0", source: "mcp-registry", serverName: "auth", transport: "stdio", installPath: "npx -y auth-mcp", installable: false, blockedReason: "需要先设置环境变量：TOKEN", requiredEnv: ["TOKEN"], configYaml: "- id: mcp-auth", why: "需要密钥", trust: { badges: [], flags: [] } }
			]
		}
	};
	resetHooks();
	const aiMcp = textOf(t.AiBox({})).join(" | ");
	check("R36 MCP 推荐：标出 MCP 服务器与 transport", aiMcp.includes("MCP 服务器") && aiMcp.includes("streamable-http"), aiMcp.slice(0, 300));
	check("R36 MCP 推荐：给出安装路径", aiMcp.includes("安装路径：") && aiMcp.includes("https://time.b77.ai/mcp"));
	check("R36 MCP 推荐：可装的有「装成 MCP」", aiMcp.includes("装成 MCP"));
	check("R36 MCP 推荐：不可装的有「复制组合片段」+ 原因", aiMcp.includes("复制组合片段") && aiMcp.includes("需要环境变量：TOKEN"), aiMcp.slice(0, 500));
	t.store.local = saved;
} else {
	check("__test 暴露了 AiBox", false);
}

if (typeof t.Panel === "function") {
	const savedData = t.store.data;
	const savedLocal = t.store.local;
	t.store.data = {
		host: { dsh: "0.2.1-rc.5", profile: "desktop", profileDir: "D:/p", skillRoots: ["D:/s"], dataDir: "D:/d", build: "0.8.0" },
		jobs: [], active: null, warnings: [], queue: { count: 0 },
		attention: { dot: false, count: 0, items: [] },
		collaborator: { ok: true, line: "卸载协作：可用" }
	};
	t.store.local = {
		inventory: { ok: true, counts: { total: 3, bundle: 2 }, items: [], problems: [], summary: null },
		skills: { ok: true, counts: { skills: 4, hostTotal: 5 }, items: [], hostOnly: [], summary: "4 个技能 · 宿主认 5 个" },
		mcp: { ok: true, counts: { total: 1, running: 1 }, items: [] },
		toast: null
	};
	resetHooks();
	let panelText = "";
	try {
		panelText = textOf(t.Panel({})).join(" | ");
		check("R36 Panel：头部三件套「设置 / 清单 / 刷新」都在", panelText.includes("设置") && panelText.includes("清单") && panelText.includes("刷新"), panelText.slice(0, 200));
		check("R36 Panel：「清单」在「设置」之后、「刷新」之前", panelText.indexOf("设置") < panelText.indexOf("清单") && panelText.indexOf("清单") < panelText.indexOf("刷新"), panelText.slice(0, 200));
		check("R38 Panel：主面板有「插件 / MCP / Skill 更新」条（唯一入口）", panelText.includes("插件 / MCP / Skill 更新") && panelText.includes("检查更新"), panelText.slice(0, 300));
		check("R38 Panel：更新条在「历史」与「环境体检」之间", (() => {
			const iHist = panelText.indexOf("历史");
			const iUpd = panelText.indexOf("插件 / MCP / Skill 更新");
			const iDoc = panelText.indexOf("环境体检");
			return iHist >= 0 && iHist < iUpd && iUpd < iDoc;
		})(), panelText.slice(0, 600));
		check("R37 Panel：「检查更新」在整页只出现一次（入口已合并）", (panelText.match(/检查更新/g) || []).length === 1, (panelText.match(/检查更新/g) || []).length);
		check("R36 Panel：清单窗口默认不挂载（低频内容不占主面板）", !panelText.includes("看一段能直接抄") && !panelText.includes("只读 profile 的两份组合文件"));
	} catch (e) {
		check("R36 Panel：渲染不抛异常", false, String((e && e.message) || e));
	}
	t.store.data = savedData;
	t.store.local = savedLocal;
} else {
	check("__test 暴露了 Panel", false);
}

/* 条数自对表：断言被删/被加都会在这里当场红（数源码不可靠，见 EXPECTED_TOTAL 的注释） */
if (passed !== EXPECTED_TOTAL) {
	failed += 1;
	console.log("FAIL 断言条数变了：实际跑 " + passed + " 条，预期 " + EXPECTED_TOTAL +
		"（同步这里 + audit.mjs 的 EXPECTED_RENDER_ASSERTIONS + README/交接文件）");
}
console.log("TOTAL " + passed + " checks");
console.log(failed === 0 ? "\nSUMMARY all render checks passed" : "\nSUMMARY " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
