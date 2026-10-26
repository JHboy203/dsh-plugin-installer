/**
 * dev/probe-live-upgrade.mjs — 「现在到底能不能真升级？」一条命令回答（R27 收尾资产）。
 *
 * 为什么需要它：R27 之后升级变成「先卸载再装」，而它依赖**运行中的宿主**里两件事同时成立：
 *   ① 本插件的宿主代码是新的（`withReplacement` / ⑦b 阶段在跑）；
 *   ② 「插件目录」的 `pluginCatalog.removal` 服务真的在（api ≥ 1，且宿主已重启过）。
 * 这两件事各自都能被误判：构建标签只说明磁盘新；面板上的「已装」也不代表服务在。
 * 换会话/重启后第一句话应该是**一个可执行的结论**，而不是翻三个工具的输出。
 *
 * ★ 只读：只打三个 GET（loopback），不安装、不改设置、不检查更新（不联网）。
 * ★ 端口不写死：`--base` > `DSH_WEB_URL` > 报错（每次重启端口都会变，写死必过期）。
 * ★ 对端不健康时**如实说**：例如「插件目录」的 health 自己 500（另一个会话正在改它），
 *   这条探针降级为「只能确认 installer 半边」，而不是把别人的中间态算成自己的失败。
 *
 * 跑法：
 *   node dev/probe-live-upgrade.mjs                     # 用 DSH_WEB_URL
 *   node dev/probe-live-upgrade.mjs --base http://127.0.0.1:29634
 *   host_selfcheck({ plugin:"dsh-plugin-installer", script:"dev/probe-live-upgrade.mjs" })
 */

const args = process.argv.slice(2);
function arg(name, fallback = "") {
	const i = args.indexOf("--" + name);
	if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
	return fallback;
}

const base = String(arg("base", process.env.DSH_WEB_URL || "")).replace(/\/+$/, "");
const checks = [];
function ok(name, condition, detail) {
	checks.push({ name, ok: Boolean(condition), detail: condition ? "" : String(detail ?? "") });
}
function note(name, detail) {
	checks.push({ name, ok: true, detail: String(detail ?? ""), note: true });
}

if (!/^https?:\/\//.test(base)) {
	console.log("FAIL 不知道 GUI 地址：传 --base http://127.0.0.1:<端口>，或让 DSH_WEB_URL 在环境里");
	process.exit(2);
}

/**
 * 只读 HTTP：用 `node:http` 而不是全局 fetch。
 *
 * 两个理由，都是本机踩过的：
 *   ① 全局 fetch 是 undici —— 流被对端断开时会触发 `assert(!this.paused)` 直接打死宿主
 *      （dsh-boot-guard 里那条 `dsh-video-downloader` 事故就是它）；
 *   ② 这个探针要在 `process.exit` 前收尾干净：undici 的 keep-alive 句柄在退出时会撞
 *      `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码从 0 变成 1（假失败）。
 * 所以用 `agent:false` + `Connection: close`，并把结论写进 `process.exitCode` 让它自然退出。
 */
import { request as httpRequest } from "node:http";

function getJson(baseUrl, path, timeoutMs = 5000) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let req;
		try {
			const url = new URL(baseUrl + path);
			req = httpRequest(
				{
					hostname: url.hostname,
					port: url.port,
					path: url.pathname + url.search,
					method: "GET",
					agent: false,
					headers: { accept: "application/json", connection: "close" },
					timeout: timeoutMs,
				},
				(res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						text += chunk;
						if (text.length > 200000) res.destroy();
					});
					res.on("end", () => {
						let json = null;
						try {
							json = JSON.parse(text);
						} catch {
							json = null;
						}
						done({ status: res.statusCode || 0, json, text: text.slice(0, 300) });
					});
				},
			);
		} catch (error) {
			done({ status: 0, json: null, text: String((error && error.message) || error) });
			return;
		}
		req.on("timeout", () => {
			req.destroy(new Error("timeout " + timeoutMs + "ms"));
		});
		req.on("error", (error) => done({ status: 0, json: null, text: String((error && error.message) || error) }));
		req.end();
	});
}
const get = (path) => getJson(base, path);

/* ① 本插件宿主半边：路由在不在、跑的是不是磁盘这一版 */
const health = await get("/plugin-installer/health");
ok("installer 路由在（GET /health 200）", health.status === 200 && health.json && health.json.ok === true, "status=" + health.status + " " + health.text);
const code = (health.json && health.json.code) || null;
if (code) {
	/* 指纹行本身有两种说法容易读反：「磁盘比加载那一刻新」+「之后有过 re-apply」= 入口已是新的；
	   只有「从没 re-apply」才真需要重启。这里替人翻一遍。 */
	const line = code.appliedAfterLoad === true
		? "入口已是新的（加载于 " + new Date(code.at || 0).toLocaleTimeString("zh-CN", { hour12: false }) + "，之后宿主重新 apply 过）"
		: (code.line || "指纹未知");
	note("运行中的代码：" + line);
	if (code.fresh !== true && code.appliedAfterLoad !== true) {
		ok("宿主已加载 R27 代码（或至少重新 apply 过）", false, "code.fresh=false 且没有 re-apply —— 需要重新 apply / 重启 DSH");
	}
} else {
	note("health 没回 code（旧版 installer）—— R27 肯定没在跑");
}
const healthCollaborator = (health.json && health.json.collaborator) || null;

/* ② 面板状态：协作方的一行结论 + 队列 */
const state = await get("/plugin-installer/state");
ok("installer 状态可取（GET /state 200）", state.status === 200 && state.json && state.json.ok === true, "status=" + state.status);
const collaborator = (state.json && state.json.collaborator) || healthCollaborator || null;
ok("卸载协作方可用（R27 的前提）", Boolean(collaborator && collaborator.ok === true), collaborator ? (collaborator.line || collaborator.reason || JSON.stringify(collaborator)) : "state 里没有 collaborator 字段（旧代码）");
if (collaborator && collaborator.ok !== true) {
	note("为什么不可用", (collaborator.reason || "") + (collaborator.fix && collaborator.fix.length ? "；下一步：" + collaborator.fix.map((f) => f.text).join("；") : ""));
}
const queue = (state.json && state.json.queue) || null;
if (queue) note("队列", queue.count + " 个待装" + (queue.items && queue.items.length ? "（" + queue.items.slice(0, 3).map((i) => i.name || i.raw).join("、") + "）" : ""));

/* ③ 协作方自己的版本与契约（它可能正被另一个会话改着 —— 不健康就如实记，不算本插件的失败） */
const catalog = await get("/plugin-catalog/health");
if (catalog.status === 200 && catalog.json && catalog.json.ok !== false) {
	const removal = catalog.json.removal || null;
	note("插件目录：" + (catalog.json.build ? "构建 " + (catalog.json.build.label || catalog.json.build.version || "?") : "健康") +
		(removal ? " · 卸载契约 api " + (removal.api || "?") + " · removeBundle " + (removal.canRemove ? "可用" : "不可用") : " · 没有 removal 字段"));
	if (removal && removal.canRemove !== true) ok("插件目录能执行 removeBundle", false, removal.reason || "canRemove=false");
} else {
	note("插件目录的 /health 没答上来（" + (catalog.status || "连接失败") + "）", catalog.text);
	console.log("  ⚠ 这一项可能是**另一个会话正在改它**（未提交/未重载），不代表 R27 失败；协作方可用性以 installer 的 state 为准");
}

/* ④ 结论 */
const ready = collaborator && collaborator.ok === true && health.status === 200 && state.status === 200;
const failed = checks.filter((item) => !item.ok);
console.log("dsh-plugin-installer · live upgrade probe（R27）· " + base);
for (const item of checks) {
	const mark = item.ok ? (item.note ? "·" : "✓") : "✗";
	console.log("  " + mark + " " + item.name + (item.detail ? " — " + item.detail : ""));
}
console.log("");
if (ready) {
	console.log("结论：**可以真升级**（面板「已装插件」→ 检查更新 → 升级；会先停下来确认「先卸载旧版」）。");
	console.log("提醒：装完要再重启一次 DSH 才加载新代码；失败看任务上的「换版本」卡。");
} else {
	console.log("结论：**现在还不能真升级** —— 先解决上面 ✗ 的那几项（最常见：重启 DSH 让 R27 与「插件目录」的宿主代码生效）。");
}
/* 用 exitCode 而不是 process.exit：让 http 句柄自然收尾，退出码不会被 libuv 断言带偏 */
process.exitCode = ready ? 0 : 1;
