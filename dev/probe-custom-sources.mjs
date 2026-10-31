/**
 * dev/probe-custom-sources.mjs — R45：自定义搜索来源的离线探针（不发网络、不花 token）。
 *
 * 为什么单独一条：自定义来源同时碰三件容易出事的东西 ——
 *   ① **设置归一化**（坏条目 / 重复 / 超上限不能把面板搞坏）；
 *   ② **URL 安全边界**（不许把本机/内网地址当来源，否则这就是个 SSRF 入口）；
 *   ③ **搜索编排**（npm / github / json / web 四种，web 默认关闭；任何一条失败不拖垮别的）。
 *
 * 用注入的假 fetch 跑，不需要网络。跑法：
 *   node dev/probe-custom-sources.mjs
 *   host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-custom-sources.mjs"})
 */
import {
	CUSTOM_SOURCES_MAX,
	checkSourceUrl,
	githubQueryFromTarget,
	htmlToText,
	matchesQuery,
	normalizeCustomSource,
	normalizeCustomSources,
	normalizeRegistryBase,
	searchCustomSources,
	shapeJsonCandidate
} from "../lib/customsources.js";

let failed = 0;
function report(name, ok, detail) {
	if (ok) {
		console.log("PASS " + name);
		return;
	}
	failed += 1;
	console.log("FAIL " + name + (detail === undefined ? "" : "  " + JSON.stringify(detail)));
}

/* ① URL 安全边界 */
report("本机 / 内网地址一律拒绝（localhost / 127 / 10 / 192.168 / 169.254）",
	["http://localhost/x", "http://127.0.0.1:8080/x", "http://10.1.2.3/x", "http://192.168.1.5/x", "http://169.254.1.1/x"]
		.every((url) => checkSourceUrl(url) !== null));
report("只收 http(s)，拒绝 file / 带账号密码",
	checkSourceUrl("file:///C:/x.json") !== null && checkSourceUrl("https://u:p@example.com/x.json") !== null);
report("公网地址放行", checkSourceUrl("https://registry.npmmirror.com") === null && checkSourceUrl("https://example.com/a.json") === null);

/* ② GitHub 目标归一化 */
report("GitHub 网址折成搜索表达式（topic / orgs / repo / search）",
	githubQueryFromTarget("https://github.com/topics/dsh-plugin") === "topic:dsh-plugin" &&
	githubQueryFromTarget("https://github.com/orgs/deepseek-ai") === "org:deepseek-ai" &&
	githubQueryFromTarget("https://github.com/o/r") === "repo:o/r" &&
	githubQueryFromTarget("https://github.com/search?q=harness+plugin") === "harness plugin");
report("已经是 topic:/org:/repo: 的原样保留；非 GitHub 网址返回 null",
	githubQueryFromTarget("topic:x") === "topic:x" && githubQueryFromTarget("https://gitlab.com/a/b") === null);

/* ③ registry 基地址 */
report("registry 基地址去尾斜杠、非法地址返回 null",
	normalizeRegistryBase("https://registry.npmmirror.com/") === "https://registry.npmmirror.com" &&
	normalizeRegistryBase("http://127.0.0.1:4873") === null);

/* ④ 条目归一化：坏条目丢掉、重复去重、超上限截断 */
const many = Array.from({ length: CUSTOM_SOURCES_MAX + 4 }, (_, i) => ({ type: "npm", target: "https://r" + i + ".example.com" }));
const normalizedMany = normalizeCustomSources(many);
report("最多留 " + CUSTOM_SOURCES_MAX + " 条（多出来的截掉）", normalizedMany.length === CUSTOM_SOURCES_MAX, normalizedMany.length);
report("坏条目丢掉（未知类型 / 空目标 / 非法网址）",
	normalizeCustomSources([
		{ type: "ftp", target: "ftp://x" },
		{ type: "npm", target: "" },
		{ type: "json", target: "http://localhost/index.json" },
		{ type: "github", target: "topic:ok" }
	]).length === 1);
const dup = normalizeCustomSources([
	{ type: "github", target: "topic:dsh-plugin", label: "a" },
	{ type: "github", target: "topic:dsh-plugin", label: "b" }
]);
report("同 type+target 只留一条（后者覆盖标签、保留 id）", dup.length === 1 && dup[0].label === "b", dup);

/* ⑤ JSON 索引形状与查询过滤 */
const shaped = shapeJsonCandidate({ name: "foo-plugin", spec: "foo", description: "一个 DSH 插件", url: "https://github.com/o/foo" }, { id: "s1", label: "自建索引", type: "json" });
report("JSON 条目带「自定义来源」徽章与未验证警告",
	!!shaped && shaped.customSource.id === "s1" && shaped.trust.badges.some((b) => b.id === "custom-source") &&
	shaped.trust.flags.some((f) => f.id === "custom-unverified"));
report("JSON 条目按查询词过滤（名字/描述都要含）",
	matchesQuery({ name: "foo-plugin", description: "一个 DSH 插件" }, "dsh 插件") === true &&
	matchesQuery({ name: "foo-plugin", description: "一个 DSH 插件" }, "不相关") === false);

/* ⑥ 搜索编排：注入假 fetch，四种类型各跑一遍 */
const calls = [];
const fakeJson = async (url) => {
	calls.push(url);
	if (url.includes("registry.npmjs.org")) return { objects: [{ package: { name: "npm-hit", version: "1.0.0", description: "dsh plugin", links: {} } }] };
	if (url.endsWith("/index.json")) return { items: [{ name: "json-hit", spec: "json-hit", description: "dsh json plugin" }, { name: "other", description: "无关" }] };
	return {};
};
const fakeText = async () => "<html><body><a href='https://github.com/o/web-hit'>web-hit DSH 插件</a></body></html>";
const webParsed = [];
const result = await searchCustomSources("dsh", [
	{ id: "a", label: "镜像", type: "npm", target: "https://registry.npmjs.org", enabled: true },
	{ id: "b", label: "JSON", type: "json", target: "https://example.com/index.json", enabled: true },
	{ id: "c", label: "网页", type: "web", target: "https://example.com/list", enabled: true },
	{ id: "d", label: "停用的", type: "npm", target: "https://registry.npmjs.org", enabled: false }
], {
	limit: 5,
	allowWeb: false,
	fetchJson: fakeJson,
	fetchText: fakeText,
	parseWeb: async (source, q, text) => {
		webParsed.push({ q, text });
		return [{ name: "web-hit", url: "https://github.com/o/web-hit", description: "dsh web plugin" }];
	}
});
report("npm / JSON 两类真的跑出结果（web 默认关闭）",
	result.items.some((it) => it.name === "npm-hit") && result.items.some((it) => it.name === "json-hit"),
	result.items.map((it) => it.name));
report("web 默认关闭：provider 标记失败并说明原因，不抓页面",
	result.providers.find((p) => p.id === "custom-c")?.ok === false &&
	/默认关闭/.test(result.providers.find((p) => p.id === "custom-c")?.error || "") && webParsed.length === 0,
	result.providers.find((p) => p.id === "custom-c"));
report("停用的来源不抓、但如实列出", result.providers.find((p) => p.id === "custom-d")?.ok === false &&
	result.providers.find((p) => p.id === "custom-d")?.error === "已停用");
report("任何一条失败不影响别的来源（npm + JSON 都还在）",
	result.providers.filter((p) => p.ok).length === 2 && result.errors.length === 0, result.errors);

const withWeb = await searchCustomSources("dsh", [
	{ id: "c", label: "网页", type: "web", target: "https://example.com/list", enabled: true }
], { limit: 5, allowWeb: true, fetchJson: fakeJson, fetchText: fakeText, parseWeb: async () => [{ name: "web-hit", url: "https://github.com/o/web-hit", description: "dsh" }] });
report("打开 allowWeb 后网页来源生效（抓正文 + 解析）", withWeb.items.some((it) => it.name === "web-hit"), withWeb.items.map((it) => it.name));

/* ⑦ HTML → 正文 */
report("HTML 去标签/脚本，保留文字",
	(() => {
		const text = htmlToText("<html><script>bad()</script><body><h1>插件</h1><p>一个 dsh 插件</p></body></html>");
		return text.includes("插件") && !text.includes("bad()") && text.length < 200;
	})());

/* ⑧ 「AI 辅助添加」的确定性分流（不花 token 的那一半） */
const { guessCustomSource } = await import("../lib/ai.js");
const guessedGithub = guessCustomSource("https://github.com/topics/dsh-plugin");
const guessedNpm = guessCustomSource("https://registry.npmmirror.com");
const guessedWeb = guessCustomSource("https://example.com/plugins");
report("AI 辅助：GitHub 网址先走规则（topic:dsh-plugin，不调模型）",
	guessedGithub?.type === "github" && guessedGithub.target === "topic:dsh-plugin", guessedGithub);
report("AI 辅助：registry 基地址先走规则（npm）", guessedNpm?.type === "npm" && guessedNpm.target === "https://registry.npmmirror.com", guessedNpm);
report("AI 辅助：普通网页先走规则（web，默认关闭）", guessedWeb?.type === "web", guessedWeb);
report("AI 辅助：规则给的提案一定能通过 normalizeCustomSource",
	[guessedGithub, guessedNpm, guessedWeb].every((g) => g && normalizeCustomSource({ ...g, label: g.label || "x" }) !== null));

console.log("");
console.log("SUMMARY " + failed + " FAIL / " + (failed === 0 ? "全部通过" : "见上"));
process.exitCode = failed > 0 ? 1 : 0;
