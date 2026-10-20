/**
 * dsh-plugin-installer — 宿主半边。
 *
 * 这里放的是**确定性**的那一半：下载、解包、识别、安全预检、安装、快照、诊断、回滚。
 * 浏览器半边只做展示与交互；面板里的 AI 只能搜索/推荐/递请求，装的事一律在这里做。
 *
 * 路由（全部同源或 loopback）：
 *   GET  /plugin-installer/state        面板状态（任务、红点、宿主事实、设置）
 *   POST /plugin-installer/submit       提交一段输入（链接/路径/名字）
 *   POST /plugin-installer/search       确定性搜索候选
 *   GET  /plugin-installer/settings     个性化设置（提醒 / 审核档位 / 轮询 / 搜索源…）
 *   POST /plugin-installer/settings     改设置（补丁，逐项合并并落盘）
 *   POST /plugin-installer/action       confirm / skip-review / cancel / ack / rollback / review / …
 *   POST /plugin-installer/upload       拖进来的文件（原始字节，x-file-name 带头）
 *   POST /plugin-installer/ai           面板 AI：搜索 → 推荐 → 安装请求
 *   GET  /plugin-installer/ai-status    AI 通道是否可用
 *   GET  /plugin-installer/health       自检
 *   GET  /plugin-installer/debug/inventory  只读：插件清单原始结构（支持时用）
 *
 * ⚠️ 失败关闭：任何一个工具注册失败都只记录，不影响面板本身（也不会拖垮插件树）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Installer } from "./lib/pipeline.js";
import { buildInstallerTools } from "./lib/tools.js";
import { createReviewer, runPanelAi } from "./lib/ai.js";
import { checkDshToolsShadow } from "./lib/landmine.js";
import { buildStamp, dataDir, hostVersions, profileDir, skillRoots } from "./lib/hostinfo.js";
import { DEFAULTS as DEFAULT_SETTINGS, REVIEW_LEVELS, CHOICES as SETTING_CHOICES } from "./lib/settings.js";

const PREFIX = "/plugin-installer";
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_UPLOAD_BODY = 80 * 1024 * 1024;

function svc(ctx, name) {
	try {
		if (ctx && typeof ctx.get === "function") {
			const found = ctx.get(name);
			if (found) return found;
		}
	} catch {
		/* 没注入不算错 */
	}
	try {
		return ctx ? ctx[name] : undefined;
	} catch {
		return undefined;
	}
}

function json(res, code, payload) {
	let body;
	try {
		body = JSON.stringify(payload);
	} catch (e) {
		body = JSON.stringify({ ok: false, error: "serialize-failed: " + String((e && e.message) || e) });
		code = 500;
	}
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}

function isLoopback(req) {
	const address = (req.socket && req.socket.remoteAddress) || "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * 信任判据（三种，任一成立）：
 *  ① 本机回环；
 *  ② Electron 自定义协议 `dsh-app://app`；
 *  ③ **同源**：Origin 的 host 与请求的 Host 头一致 —— 手机経 Tailscale 打开同一个
 *     DSH 实例时走这条（此时页面本身就归这个人控制，面板没有额外暴露面）。
 */
function isTrusted(req) {
	if (isLoopback(req)) return true;
	const origin = String(req.headers.origin || "");
	if (origin === "dsh-app://app") return true;
	const referer = String(req.headers.referer || "");
	if (referer.startsWith("dsh-app://app/")) return true;
	try {
		if (origin) {
			const host = new URL(origin).host;
			const expected = String(req.headers.host || "");
			if (host && expected && host === expected) return true;
		}
	} catch {
		/* ignore */
	}
	return false;
}

function readJsonBody(req, limit = MAX_JSON_BODY) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("body too large"), { code: "too-big" }));
				try {
					req.destroy();
				} catch {
					/* ignore */
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(Object.assign(new Error("invalid json"), { code: "bad-json" }));
			}
		});
		req.on("error", reject);
	});
}

function writeUpload(req, dest, limit) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("upload too large"), { code: "too-big" }));
				try {
					req.destroy();
				} catch {
					/* ignore */
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", async () => {
			try {
				const buf = Buffer.concat(chunks);
				await writeFile(dest, buf);
				resolve({ bytes: buf.length, head: buf.subarray(0, 8) });
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

export const inject = ["tools", "webServer"];

/**
 * 服务的活引用：注入期未就绪、或某个服务根本不存在时，读到的就是 undefined，
 * 由调用方逐处降级 —— 不让一个缺服务把整棵插件树带下去。
 */
function makeFaces(ctx) {
	return {
		get llm() { return svc(ctx, "llm"); },
		get agentDefaultModel() { return svc(ctx, "agentDefaultModel"); },
		get skills() { return svc(ctx, "skills"); },
		get pluginManager() { return svc(ctx, "pluginManager"); },
		get webApp() { return svc(ctx, "webApp"); },
		get remoteAccess() { return svc(ctx, "remoteAccess"); }
	};
}

export async function apply(ctx) {
	const faces = makeFaces(ctx);
	const installer = await new Installer({
		ctx: faces,
		options: { reviewer: createReviewer({ ctx: faces }) }
	}).init();

	let lastClientState = null;

	const dispose = ctx.webServer.register({
		kind: "prefix",
		path: PREFIX,
		handler: async (req, res) => {
			if (!isTrusted(req)) return json(res, 403, { ok: false, error: "trusted origin required" });
			const url = new URL(req.url ?? "/", "http://x");
			const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;
			const method = req.method || "GET";

			try {
				if (path === "/state" && method === "GET") {
					const state = await installer.snapshotState();
					return json(res, 200, state);
				}

				if (path === "/health" && method === "GET") {
					const versions = await hostVersions(true);
					const build = await buildStamp(true).catch(() => null);
					const tools = svc(ctx, "tools");
					const names = tools && typeof tools.schemas === "function"
						? tools.schemas().map((s) => s.name).filter((n) => String(n).startsWith("install_hub_"))
						: [];
					const landmine = await checkDshToolsShadow(profileDir()).catch(() => ({ present: false }));
					return json(res, 200, {
						ok: true,
						/* R5.1：以前写死 "p2-pack" —— 宿主侧不热重载时，
						   这是唯一能回答「现在跑的是哪一版」的东西。 */
						build: build ? build.label : null,
						buildDetail: build,
						versions,
						profileDir: profileDir(),
						skillRoots: skillRoots(),
						dataDir: dataDir(),
						tools: names,
						landmine,
						clientReport: lastClientState,
						inject: { pluginManager: Boolean(svc(ctx, "pluginManager")), skills: Boolean(svc(ctx, "skills")), llm: Boolean(svc(ctx, "llm")) }
					});
				}

				if (path === "/settings" && method === "GET") {
					return json(res, 200, {
						ok: true,
						settings: installer.settings,
						defaults: DEFAULT_SETTINGS,
						levels: REVIEW_LEVELS,
						choices: SETTING_CHOICES
					});
				}

				if (path === "/settings" && method === "POST") {
					const body = await readJsonBody(req);
					const settings = await installer.updateSettings(body);
					return json(res, 200, { ok: true, settings, state: await installer.snapshotState() });
				}

				if (path === "/doctor" && method === "GET") {
					const report = await installer.doctor({ apply: false });
					return json(res, 200, { ok: true, report });
				}

				if (path === "/submit" && method === "POST") {
					const body = await readJsonBody(req);
					const input = String(body.input || body.raw || "").trim();
					const result = await installer.submit(input, { source: body.source || "panel" });
					return json(res, 200, result);
				}

				if (path === "/search" && method === "POST") {
					const body = await readJsonBody(req);
					const result = await installer.search(String(body.query || "").trim());
					return json(res, 200, { ok: true, ...result });
				}

				if (path === "/action" && method === "POST") {
					const body = await readJsonBody(req);
					const action = String(body.action || "");
					const id = body.id ? String(body.id) : null;
					let result;
					if (action === "confirm") result = await installer.confirm(id);
					else if (action === "skip-review") result = await installer.skipReview(id);
					else if (action === "cancel") result = await installer.cancel(id);
					else if (action === "ack") result = await installer.ack(id);
					else if (action === "rollback") result = await installer.rollback(id);
					else if (action === "review") result = await installer.review(id);
					else if (action === "rediagnose") result = await installer.rediagnose(id);
					else if (action === "repair") {
						const report = await installer.doctor({ apply: true });
						return json(res, 200, { ok: true, report, state: await installer.snapshotState() });
					}
					else if (action === "fix-landmine") {
						const swept = await installer.sweepLandmine("manual");
						return json(res, 200, { ok: true, landmine: swept, state: await installer.snapshotState() });
					} else if (action === "integrations") {
						const eco = await installer.integrations(true);
						return json(res, 200, { ok: true, integrations: eco, state: await installer.snapshotState() });
					} else return json(res, 400, { ok: false, error: "unknown action: " + action });
					const state = await installer.snapshotState();
					return json(res, 200, { ...result, state });
				}

				if (path === "/upload" && method === "POST") {
					const rawName = String(req.headers["x-file-name"] || "");
					let name = "upload.bin";
					try {
						name = decodeURIComponent(rawName) || name;
					} catch {
						name = rawName || name;
					}
					const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "upload.bin";
					const dir = join(dataDir(), "staging", "uploads", String(Date.now()));
					await mkdir(dir, { recursive: true });
					const dest = join(dir, safe);
					const info = await writeUpload(req, dest, MAX_UPLOAD_BODY);
					const result = await installer.submit(dest, { source: "drop" });
					return json(res, 200, { ok: result.ok, bytes: info.bytes, submitted: result });
				}

				if (path === "/ai" && method === "POST") {
					const body = await readJsonBody(req);
					const faces = makeFaces(ctx);
					const result = await runPanelAi({ ctx: faces, installer, message: String(body.message || "") });
					return json(res, 200, result);
				}

				if (path === "/ai-status" && method === "GET") {
					const faces = makeFaces(ctx);
					let selection = null;
					try {
						selection = faces.agentDefaultModel && typeof faces.agentDefaultModel.currentSelection === "function"
							? faces.agentDefaultModel.currentSelection()
							: null;
					} catch {
						selection = null;
					}
					return json(res, 200, {
						ok: true,
						llm: Boolean(faces.llm),
						selection: selection ? { provider: selection.provider, model: selection.model } : null
					});
				}

				if (path === "/client-state" && method === "POST") {
					const body = await readJsonBody(req);
					lastClientState = { at: Date.now(), state: body };
					return json(res, 200, { ok: true });
				}

				if (path === "/debug/inventory" && method === "GET") {
					const pm = svc(ctx, "pluginManager");
					const bundles = pm && typeof pm.listBundles === "function" ? await pm.listBundles().catch((e) => ({ error: String(e) })) : null;
					const plugins = pm && typeof pm.listPlugins === "function" ? await pm.listPlugins().catch((e) => ({ error: String(e) })) : null;
					const trim = (list) => (Array.isArray(list) ? list.slice(0, 40) : list);
					return json(res, 200, { ok: true, bundles: trim(bundles), plugins: trim(plugins) });
				}

				return json(res, 404, { ok: false, error: "unknown endpoint: " + path });
			} catch (e) {
				const code = e && e.code === "too-big" ? 413 : e && e.code === "bad-json" ? 400 : 500;
				return json(res, code, { ok: false, error: String((e && e.message) || e), code: e && e.code });
			}
		}
	});
	ctx.effect(() => dispose, "plugin-installer: panel routes");

	/* 五个宿主工具（注册失败只记录，不影响面板） */
	const registered = [];
	const failed = [];
	const definitions = buildInstallerTools({ installer, ctx });
	try {
		const tools = svc(ctx, "tools");
		if (!tools || typeof tools.register !== "function") throw new Error("tools service unavailable");
		for (const definition of definitions) {
			try {
				registered.push(tools.register(definition));
			} catch (e) {
				failed.push(definition.name + ": " + String((e && e.message) || e));
			}
		}
	} catch (e) {
		failed.push("tools: " + String((e && e.message) || e));
	}
	ctx.effect(() => () => {
		for (const disposeTool of registered) {
			try {
				disposeTool();
			} catch {
				/* ignore */
			}
		}
	}, "plugin-installer: tools");
	if (failed.length > 0) {
		console.warn("[dsh-plugin-installer] tool registration failed:", failed.join(" | "));
	}

	console.log("[dsh-plugin-installer] ready · data=" + dataDir() + " · tools=" + registered.length + "/" + definitions.length);
}

export const __test = { isTrusted, isLoopback };
