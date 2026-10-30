/**
 * dsh-plugin-installer — 宿主半边。
 *
 * 这里放的是**确定性**的那一半：下载、解包、识别、安全预检、安装、快照、诊断、回滚。
 * 浏览器半边只做展示与交互；面板里的 AI 只能搜索/推荐/递请求，装的事一律在这里做。
 *
 * R26.2（2026-10-25 01:3x）：inject 扫描修正（timer 方法映射 / 客户端 bundle 隔离）已落盘，
 * 这里改一行注释触发宿主热 re-apply，让 `lib/inject.js` 也换成新代码（不用整体重启）。
 *
 * 路由（全部同源或 loopback）：
 *   GET  /plugin-installer/state        面板状态（任务、红点、宿主事实、设置）
 *   POST /plugin-installer/submit       提交一段输入（链接/路径/名字）
 *   POST /plugin-installer/search       确定性搜索候选
 *   GET  /plugin-installer/settings     个性化设置（提醒 / 审核档位 / 轮询 / 搜索源…）
 *   POST /plugin-installer/settings     改设置（补丁，逐项合并并落盘）
 *   GET  /plugin-installer/inventory    已装清单（本地读，不联网）；附带 30 分钟内最近一次检查更新的结果
 *   GET  /plugin-installer/skills       已装 Skill（本地读 + 宿主技能清单对账；重名 / 备份 / 没被认）
 *   POST /plugin-installer/action       confirm / skip-review / cancel / ack / rollback / review /
 *                                       check-updates / rediagnose / approve-builds / exempt-version /
 *                                       repair / fix-landmine / integrations / park-skill-backup /
 *                                       fix-skill-frontmatter
 *   POST /plugin-installer/upload       拖进来的文件（原始字节，x-file-name 带头）
 *   POST /plugin-installer/ai           面板 AI：搜索 → 推荐 → 安装请求
 *   GET  /plugin-installer/ai-status    AI 通道是否可用
 *   GET  /plugin-installer/doctor       环境体检（只读；修复走 action:"repair"）
 *   POST /plugin-installer/client-state  客户端自报（版本/几何/打开状态，只存内存）
 *   GET  /plugin-installer/health       自检
 *   GET  /plugin-installer/debug/inventory  只读：插件清单原始结构（支持时用）
 *
 * ⚠️ 失败关闭：任何一个工具注册失败都只记录，不影响面板本身（也不会拖垮插件树）。
 *
 * R13（2026-10-22 13:0x）：装上了 ≠ 起来了 —— 预检/诊断接 `lib/inject.js`（服务声明契约），
 * 安装回执里的 `application:"failed"` 也走分诊（激活失败 / already-installed），
 * vendor 包名带版本（否则同 spec 重装静默无效）。入口文件的这行注释同时用来触发热 re-apply。
 *
 * R14（2026-10-22 14:0x）：补齐「Skill」那一半 —— `GET /skills` 把磁盘技能目录与宿主
 * `ctx.skills.list()` 对账（宿主没认 / 重名 / 备份残留 / 不会自动调用），并修掉 frontmatter
 * `>` / `|` 块标量被读成指示符的解析 bug。**注意 `skills` 不在 inject 里**，必须走
 * `ctx.get("skills")`（`lib/pipeline.js` 的 `hostSkillList`）—— 只写 `ctx.skills` 会永远
 * 得到 undefined，从而得出「本机没有技能服务」这种假结论。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Installer } from "./lib/pipeline.js";
import { buildInstallerTools } from "./lib/tools.js";
import { createReviewer, runPanelAi } from "./lib/ai.js";
import { checkDshToolsShadow } from "./lib/landmine.js";
import { buildStamp, dataDir, hostVersions, profileDir, skillRoots } from "./lib/hostinfo.js";
import { freshness, describeFreshness, recordApply } from "./lib/codestamp.js";
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
		/* R36：MCP 的「跑没跑」只能看工具表里有没有 mcp__<server>__* —— 工具服务已在 inject 里。 */
		get tools() { return svc(ctx, "tools"); },
		get pluginManager() { return svc(ctx, "pluginManager"); },
		get webApp() { return svc(ctx, "webApp"); },
		get remoteAccess() { return svc(ctx, "remoteAccess"); },
		/* R27：**可选**协作方（dsh-plugin-catalog）—— 只在换版本时用来卸载旧版。
		   取不到不是错误：整个安装/回滚/诊断链路都不依赖它，只是升级会明确拒绝。 */
		get pluginCatalog() { return svc(ctx, "pluginCatalog"); }
	};
}

export async function apply(ctx) {
	/* R12.1：宿主是**逐文件**换新的（改了哪个就重新 import 哪个），所以 codestamp.js
	   自己的 `LOADED` 时刻会一直停在最早那次。apply() 每次（重新）apply 都会跑 ——
	   把「最后一次 apply」记下来，'运行中的代码' 那一行才能区分
	   「改完没人管（该重启）」与「宿主已经重新 apply 过（看行为，别盲目重启）」。 */
	recordApply();
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
					/* R11：`code` 回答的是「**运行中**的代码是不是磁盘这一版」——
					   build（源码 mtime）只能证明磁盘新，证明不了跑的是哪一版。 */
					const code = await freshness().catch(() => null);
					return json(res, 200, {
						ok: true,
						/* R5.1：以前写死 "p2-pack" —— 宿主侧不热重载时，
						   这是唯一能回答「现在跑的是哪一版」的东西。 */
						build: build ? build.label : null,
						buildDetail: build,
						code: code ? {
							fresh: code.fresh,
							at: code.at,
							appliedAt: code.appliedAt,
							appliedAfterLoad: code.appliedAfterLoad,
							loaded: code.loaded && code.loaded.digest,
							disk: code.disk && code.disk.digest,
							newestFile: code.disk && code.disk.newestFile,
							line: describeFreshness(code)
						} : null,
						versions,
						profileDir: profileDir(),
						skillRoots: skillRoots(),
						dataDir: dataDir(),
						tools: names,
						landmine,
						clientReport: lastClientState,
						/* R27：换版本的卸载协作方（插件目录）在不在 —— 与 /state 同一份结论 */
						collaborator: await installer.collaboratorInfo(),
						inject: { pluginManager: Boolean(svc(ctx, "pluginManager")), skills: Boolean(svc(ctx, "skills")), llm: Boolean(svc(ctx, "llm")), pluginCatalog: Boolean(svc(ctx, "pluginCatalog")) }
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

				/* R12：已装清单。**纯本地读**（30 秒缓存），不联网 —— 面板打开就敢拉。
				   最近一次「检查更新」的结果（30 分钟内）会一并并进来，刷新面板不丢。
				   ⚠️ lib/* 不热重载：只换 index.js 时这里可能还没有新方法，如实回一句「要重启」。 */
				if (path === "/inventory" && method === "GET") {
					if (typeof installer.inventoryView !== "function") {
						return json(res, 503, { ok: false, error: "宿主还没重启：已装清单是新代码（lib/pipeline.js 不热重载）" });
					}
					const inventory = await installer.inventoryView();
					return json(res, 200, { ok: true, inventory });
				}

				/* R14：已装 Skill —— 磁盘上的技能目录 + 宿主 `ctx.skills.list()` 的对账结果。
				   只读、30 秒缓存、不联网；「宿主没认 / 重名 / 备份残留」都在这一份里。 */
				if (path === "/skills" && method === "GET") {
					if (typeof installer.skills !== "function") {
						return json(res, 503, { ok: false, error: "宿主还没重启：技能清单是新代码（lib/pipeline.js 不热重载）" });
					}
					const skills = await installer.skills(url && url.searchParams && url.searchParams.get("fresh") === "1");
					return json(res, 200, { ok: true, skills });
				}

				/* R36：已装 MCP —— 不是 profile 依赖，而是组合文件里 `@deepseek-ai/dsh-mcp-client`
				   的条目。每台给 serverName / transport / command/url / 在哪个文件第几行 /
				   是否真的跑起来了（工具表里有没有 mcp__<serverName>__*）。
				   只读，每次现读（两份文件很便宜），写完条目要能立刻看见。 */
				if (path === "/mcp" && method === "GET") {
					if (typeof installer.mcpView !== "function") {
						return json(res, 503, { ok: false, error: "宿主还没重启：MCP 清单是新代码（lib/pipeline.js 不热重载）" });
					}
					const mcp = await installer.mcpView();
					return json(res, 200, { ok: true, mcp });
				}

				/* R13：激活视图 —— 「我装的东西现在都在跑吗」。
				   GET /plugin-installer/activation[?inject=0]（inject=0 时不扫源码，很快）。
				   事实来自 listPlugins() 的 enabled/fiberPhase，静态侧由 lib/inject.js 解释「为什么起不来」。 */
				if (path === "/activation" && method === "GET") {
					if (typeof installer.activation !== "function") {
						return json(res, 503, { ok: false, error: "宿主还没重启：激活视图是新代码（lib/pipeline.js 不热重载）" });
					}
					const withInject = !(url && url.searchParams && url.searchParams.get("inject") === "0");
					const view = await installer.activation({ inject: withInject });
					return json(res, 200, { ok: true, activation: view });
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
					else if (action === "clear-history") {
						/* R30：清历史（只清终态；进行中 / 等待确认的保留）。
						   **不暴露给模型** —— 它是「整理界面」，不是安装能力；模型看不见这个动作，
						   也就不会替用户把证据清掉。面板上还要再点一次确认。 */
						if (typeof installer.clearHistory !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：清历史是新代码（lib/pipeline.js 不热重载）" });
						}
						const cleared = await installer.clearHistory();
						return json(res, 200, { ok: true, cleared, state: await installer.snapshotState() });
					}
					else if (action === "rollback") result = await installer.rollback(id);
					else if (action === "review") result = await installer.review(id);
					else if (action === "rediagnose") result = await installer.rediagnose(id);
					else if (action === "resume-upgrade") {
						/* R27：宿主在「卸载旧版之后、安装新版之前」重启 → 一键续跑。
						   只有这一种中断可续；其它中断仍按原样报失败（不自动装东西）。 */
						if (typeof installer.resumeUpgrade !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：中断续跑是新代码（lib/pipeline.js 不热重载）" });
						}
						result = await installer.resumeUpgrade(id);
					}
					else if (action === "check-updates") {
						/* R12：联网比对 registry 最新版。只在人点「检查更新」时走这条 ——
						   绑到 /state 轮询上等于每 2.5 秒打一轮 npm。 */
						if (typeof installer.checkUpdates !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：检查更新是新代码（lib/pipeline.js 不热重载）" });
						}
						const updates = await installer.checkUpdates();
						return json(res, 200, { ok: true, inventory: updates, state: await installer.snapshotState() });
					}
					else if (action === "approve-builds") {
						/* R9：批准「待决定的安装脚本」并重试。名单由面板从任务里带上来，
						   但复核在 Installer 里做（对着 profile 现存的 pending 列表）。 */
						result = await installer.approveBuilds(id, Array.isArray(body.names) ? body.names : []);
					}
					else if (action === "exempt-version") {
						/* R10：给「版本不兼容」开精确版本豁免并重试。目标由服务端从预检结论里取
						   （客户端只能点同意，不能自带包名/版本 —— 名额不放宽，判据只在一处）。 */
						result = await installer.exemptVersion(id);
					}
					else if (action === "link-install") {
						/* R31：本机目录插件的**直连安装**（建链接 + 写两行 profile 配置，不走 pnpm）。
						   **不暴露给模型** —— 它会改 profile 的 package.json 与 node_modules，
						   属于「人按一下才做」的动文件动作（工具面里没有它）。 */
						if (typeof installer.linkInstall !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：直连安装是新代码（lib/pipeline.js 不热重载）" });
						}
						result = await installer.linkInstall(id, { reason: String(body.reason || "panel") });
					}
					else if (action === "add-trust-exclude") {
						/* R31：把某一条加进 profile 的 trustPolicyExclude（放松一条供应链策略）。
						   与「批准安装脚本」「版本豁免」同类：**只能人来按**，模型没有这个工具。
						   面板要求二次确认；写前备份、写后复核都在 lib/trustpolicy.js 里。 */
						if (typeof installer.addTrustExclude !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：豁免写入是新代码（lib/pipeline.js 不热重载）" });
						}
						const entries = Array.isArray(body.entries) ? body.entries : body.entry ? [body.entry] : [];
						result = await installer.addTrustExclude(entries);
					}
					else if (action === "repair") {
						const report = await installer.doctor({ apply: true });
						return json(res, 200, { ok: true, report, state: await installer.snapshotState() });
					}
					else if (action === "fix-landmine") {
						const swept = await installer.sweepLandmine("manual");
						return json(res, 200, { ok: true, landmine: swept, state: await installer.snapshotState() });
					}
					else if (action === "park-skill-backup") {
						/* R15：把技能根里的备份目录移到 data/parked-skills（移动，不删除，可搬回）。
						   只处理 `.bak-*` 形态、只接受技能根下一层名字（判据在 planSkillPark）；
						   **不暴露给模型** —— 与「批准」「授权」同类，动文件的事只能人按。 */
						if (typeof installer.parkSkillBackup !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：技能备份处置是新代码（lib/pipeline.js 不热重载）" });
						}
						const parked = await installer.parkSkillBackup(String(body.dir || ""));
						return json(res, 200, parked.ok
							? { ok: true, parked, skills: parked.skills || null, state: await installer.snapshotState() }
							: { ok: false, error: parked.reason || "移不动", parked });
					} else if (action === "fix-skill-frontmatter") {
						/* R16：把「不是合法 YAML」的 frontmatter 就地改成块标量（先备份、原子写、重扫）。
						   判据与改写都是确定性的（lib/skills.js），**不暴露给模型**：动用户文件只能人按。 */
						if (typeof installer.repairSkillFrontmatter !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：frontmatter 修复是新代码（lib/pipeline.js 不热重载）" });
						}
						const fixed = await installer.repairSkillFrontmatter(String(body.dir || ""));
						return json(res, 200, fixed.ok
							? { ok: true, fixed, skills: fixed.skills || null, state: await installer.snapshotState() }
							: { ok: false, error: fixed.reason || "修不了", fixed });
					} else if (action === "update-all") {
						/* R26：批量升级 —— 只升「npm 来源 + 已落地 + 有明确 latest」的那一类，
						   串行排队（一次只跑一单）。复用 30 分钟更新缓存；队列在宿主重启后不续跑。
						   R26.1：跨大版本 / 0.x 小版本默认不排（回在 needsAttention 里），
						   面板二次确认后才带 includeRisky:true 再来一次。 */
						if (typeof installer.upgradeOutdated !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：批量升级是新代码（lib/pipeline.js 不热重载）" });
						}
						const batch = await installer.upgradeOutdated({ includeRisky: body.includeRisky === true });
						return json(res, 200, { ...batch, state: await installer.snapshotState() });
					} else if (action === "clear-queue") {
						/* 只清「还没开始装」的排队项，不碰正在跑的那一单 */
						const cleared = await installer.clearQueue();
						return json(res, 200, { ...cleared, state: await installer.snapshotState() });
					} else if (action === "integrations") {
						const eco = await installer.integrations(true);
						return json(res, 200, { ok: true, integrations: eco, state: await installer.snapshotState() });
					} else if (action === "check-mcp-updates") {
						/* R36：只读检查 —— 有来源台账的查 Registry、锁版本的 npx 包查 npm；
						   其余如实标「无法判断」。不写盘、不装东西。 */
						if (typeof installer.checkMcpUpdates !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：MCP 更新检查是新代码（lib/pipeline.js 不热重载）" });
						}
						const result = await installer.checkMcpUpdates();
						return json(res, 200, { ...result, state: await installer.snapshotState() });
					} else if (action === "add-mcp") {
						/* R36：把一台 MCP 服务器写进 profile 组合文件。
						   面板只能给「Registry 名字 + 版本」—— command / args / url 由宿主重新查
						   Registry 得到，客户端塞不进来任意命令。写入带备份、写后复核；
						   写完要重启 DSH 才加载（patch 层不热更）。
						   **不暴露给模型**（动组合文件只能人按）。 */
						if (typeof installer.addMcp !== "function") {
							return json(res, 503, { ok: false, error: "宿主还没重启：MCP 安装是新代码（lib/pipeline.js 不热重载）" });
						}
						const input = body.candidate && typeof body.candidate === "object"
							? { name: body.candidate.name || body.candidate.registryName, version: body.candidate.version }
							: String(body.spec || body.name || "");
						const added = await installer.addMcp(input);
						return json(res, 200, added.ok
							? { ok: true, added: added.added, mcp: added.mcp || null, note: added.note, restartRequired: true, state: await installer.snapshotState() }
							: { ok: false, error: added.reason || "写不进组合文件", added });
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

	/* 六个宿主工具（注册失败只记录，不影响面板） */
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
