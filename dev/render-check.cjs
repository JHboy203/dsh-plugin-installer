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
const EXPECTED_TOTAL = 141;

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
		check("设置面板标明默认档 = 现在的行为", joinedSet.includes("默认档 = 现在的行为"));
		check("设置面板三种提醒都在", joinedSet.includes("侧边栏红点") && joinedSet.includes("声音提醒") && joinedSet.includes("桌面弹窗"));
		check("设置面板审核三档齐全", joinedSet.includes("严格") && joinedSet.includes("普通") && joinedSet.includes("关闭"));
		check("设置面板注明普通 = 标准强度", joinedSet.includes("一直以来的标准强度"));
		check("设置面板有「跳过审核」开关", joinedSet.includes("允许「跳过审核」按钮"));
		check("设置面板有界面与性能项", joinedSet.includes("状态轮询间隔") && joinedSet.includes("历史显示条数") && joinedSet.includes("快照保留份数"));
		check("设置面板有搜索来源项", joinedSet.includes("搜索来源"));
		check("设置面板默认渲染出开关", attrs.classes.filter((c) => c.includes("dpi-switch")).length >= 3, attrs.classes);
		check("设置面板默认档：开着的开关不止一个", attrs.aria.filter((a) => a === "true").length >= 2, attrs.aria);
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
		check("已装清单：有「检查更新」入口", collapsed.includes("检查更新"));
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
			notVisible: 1, yamlBroken: 1, invalid: 1, duplicates: 1, duplicateDirs: 2, modelInvisible: 1, hostOnly: 0, byPanel: 1
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
			skillItem({ dir: "delta", name: "delta", modelInvocable: false, sourceLabel: "自定义根", description: "折叠描述" })
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
			localOnly: { name: "dsh-imgops", version: "0.4.0", kind: "link", kindLabel: "本机目录", spec: "link:D:/信息库/AI工作区/DSH-Plugin/dsh-imgops",
				text: "「dsh-imgops」是本机已装的插件（本机目录），本机目录装的（link:），不会出现在 npm / GitHub 的检索结果里" },
			recommendations: [
				{
					name: "dsh-imgops", source: "npm", spec: "dsh-imgops@0.4.0", version: "0.4.0", why: "同名但不同来源",
					installedKnown: true, installed: "0.4.0", installedKindLabel: "本机目录",
					installedSpec: "link:D:/信息库/AI工作区/DSH-Plugin/dsh-imgops", installedSource: "different",
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

/* 条数自对表：断言被删/被加都会在这里当场红（数源码不可靠，见 EXPECTED_TOTAL 的注释） */
if (passed !== EXPECTED_TOTAL) {
	failed += 1;
	console.log("FAIL 断言条数变了：实际跑 " + passed + " 条，预期 " + EXPECTED_TOTAL +
		"（同步这里 + audit.mjs 的 EXPECTED_RENDER_ASSERTIONS + README/交接文件）");
}
console.log("TOTAL " + passed + " checks");
console.log(failed === 0 ? "\nSUMMARY all render checks passed" : "\nSUMMARY " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
