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

let failed = 0;
function check(name, condition, extra) {
	if (condition) console.log("PASS " + name);
	else {
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

console.log(failed === 0 ? "\nSUMMARY all render checks passed" : "\nSUMMARY " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
