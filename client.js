/**
 * dsh-plugin-installer — 浏览器半边（client bundle，classic script）。
 *
 * 只做三件事：展示流水线状态、收集用户输入与确认、把动作 POST 回宿主。
 * **不下载、不解包、不装、不读文件** —— 那些全在宿主半边。
 *
 * 席位：
 *   sidebar.panellist  → 侧栏图标（红点挂在这里，收起成窄条也看得见）
 *   main               → 中央面板（key 与 sidebar 的 id 相同，点图标即切过去）
 *
 * 窄屏：面板本身是标准侧栏席位，桌面端/远程端（含 dsh-remote-mobile）由外壳决定
 * 抽屉/覆盖层；这里只保证 720px 以下内边距、触控尺寸与代码块可横向滚动。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-installer",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback, useReducer } = React;

		const API = "/plugin-installer";
		const PANEL_LABEL = "插件安装";
		/* 客户端 build 号（R5.1）：改 client.js 就提一位。
		   client 会热重载、但没人保证「当前页面跑的是哪一版」—— 这个号随 client-state
		   一起上报，宿主 /health 的 clientReport.build 就是答案（宿主侧另有 mtime 标签）。 */
		const BUILD = "r42.0";

		/* ── 迷你 store（模块级，面板关着时图标也在用）──────────────────── */

		const store = {
			data: null,
			loading: true,
			error: null,
			local: { toast: null, busy: false, ai: null, aiBusy: false, open: false }
		};
		const listeners = new Set();
		function emit() {
			for (const fn of listeners) {
				try {
					fn();
				} catch (e) {
					/* 单个订阅者出错不能拖垮别的 */
				}
			}
		}
		function setStore(patch) {
			Object.assign(store, patch);
			emit();
		}
		function setLocal(patch) {
			store.local = { ...store.local, ...patch };
			emit();
		}
		function useStore() {
			const [, force] = useReducer((x) => x + 1, 0);
			useEffect(() => {
				listeners.add(force);
				return () => listeners.delete(force);
			}, []);
			return store;
		}

		async function api(path, init) {
			const res = await fetch(API + path, {
				cache: "no-store",
				...init,
				headers: { "content-type": "application/json", ...(init && init.headers ? init.headers : {}) }
			});
			let data = null;
			try {
				data = await res.json();
			} catch (e) {
				/* R34：宿主没起来时（重启窗口 / 启动失败 / 被换成最小 profile）这里拿到的是 HTML 或空体。
				   以前把它当普通错误甩出去，还会**覆盖掉上一次的数据** —— 面板整块变空，看着像插件没了。
				   现在打上 hostDown 标记，由 refresh() 决定「保留旧数据 + 说人话 + 自动重连」。 */
				data = { ok: false, error: "HTTP " + res.status + "（返回的不是 JSON，说明这不是面板的路由）", hostDown: true, status: res.status };
			}
			return data;
		}

		let polling = null;
		let refreshing = false;
		/* R34：宿主掉线时记账（什么时候开始掉、重连了几次、最近一次错什么）。 */
		function markHost(ok, error) {
			const prev = store.host || {};
			setStore({
				host: ok
					? { down: false }
					: { down: true, since: prev.down ? prev.since : Date.now(), at: Date.now(), attempts: (prev.attempts || 0) + 1, error: error || null }
			});
		}
		async function refresh() {
			if (refreshing) return;
			refreshing = true;
			try {
				const data = await api("/state");
				if (data && data.hostDown) {
					/* 断线：**不清 data** —— 上一次能用的那份继续显示。一次重启不该让面板变空白。 */
					markHost(false, data.error);
					setStore({ loading: false, error: null });
				} else {
					markHost(true);
					setStore({ data, loading: false, error: data && data.ok === false ? data.error || "状态读取失败" : null });
				}
			} catch (e) {
				markHost(false, String((e && e.message) || e));
				setStore({ loading: false });
			} finally {
				refreshing = false;
			}
		}
		function startPolling(intervalMs) {
			if (polling) return;
			refresh();
			polling = setInterval(refresh, intervalMs || 4000);
		}
		function stopPolling() {
			if (!polling) return;
			clearInterval(polling);
			polling = null;
		}

		/* 客户端自报（排查用；不送正文，只送结构化摘要） */
		let lastReport = 0;
		function reportClientState(extra) {
			const now = Date.now();
			if (now - lastReport < 5000) return;
			lastReport = now;
			const data = store.data || {};
			try {
				fetch(API + "/client-state", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						build: BUILD,
						open: store.local.open,
						width: window.innerWidth,
						height: window.innerHeight,
						jobs: (data.jobs || []).length,
						dot: Boolean(data.attention && data.attention.dot),
						activeStatus: data.active ? data.active.status : null,
						...extra
					})
				}).catch(() => {});
			} catch (e) {
				/* ignore */
			}
		}

		/* ── 小工具 ───────────────────────────────────────────────────── */

		function ago(iso) {
			if (!iso) return "";
			const ms = Date.now() - new Date(iso).getTime();
			if (!Number.isFinite(ms)) return "";
			if (ms < 60000) return "刚刚";
			const m = Math.round(ms / 60000);
			if (m < 60) return m + " 分钟前";
			const hrs = Math.round(m / 60);
			if (hrs < 24) return hrs + " 小时前";
			return Math.round(hrs / 24) + " 天前";
		}

		function fmtBytes(bytes) {
			const n = Number(bytes) || 0;
			if (n < 1024) return n + " B";
			if (n < 1048576) return Math.round(n / 1024) + " KiB";
			return (n / 1048576).toFixed(1) + " MiB";
		}

		function copyText(text) {
			const value = String(text || "");
			if (!value) return Promise.resolve(false);
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					return navigator.clipboard.writeText(value).then(() => true).catch(() => fallbackCopy(value));
				}
			} catch (e) {
				/* ignore */
			}
			return Promise.resolve(fallbackCopy(value));
		}

		function fallbackCopy(value) {
			try {
				const area = document.createElement("textarea");
				area.value = value;
				area.setAttribute("readonly", "readonly");
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand && document.execCommand("copy");
				document.body.removeChild(area);
				return Boolean(ok);
			} catch (e) {
				return false;
			}
		}

		function toast(text) {
			setLocal({ toast: text });
			setTimeout(() => {
				if (store.local.toast === text) setLocal({ toast: null });
			}, 3200);
		}

		/* ── R6.1：自检快捷键（自检 + 自动修复，任意页面都能按）───────────────
		 *
		 * 为什么是「装完之后、重启之前」这个时机：
		 *   重复的 @deepseek-ai/dsh-tools 这颗雷**只在插件加载那一刻**发作 ——
		 *   磁盘上多一份包对已经在跑的实例毫无影响（2026-10-16：20:08 埋雷、
		 *   一直用到 22:02 都没事，22:16 重启才整片插件加载失败）。
		 *   所以真正有效的动作是在下一次启动**之前**清掉它。
		 *
		 * 面板里本来就有「检查 / 一键修复」两个按钮，这里做的是两件事：
		 *   ① 把它们搬到**任意页面**都能按到的地方（不用先切到插件安装面板）；
		 *   ② 结果用**游离浮窗**报出来 —— 面板的 toast 走 store，
		 *      面板没挂载时根本看不见。
		 */
		const HOTKEY_KEY = "dpi.selfcheck.hotkey";
		const HOTKEY_DEFAULT = "Ctrl+Alt+D";
		const HOTKEY_OFF = "off";
		/* 预设用面板已有的 SegRow 呈现，不另造一个录制界面 */
		const HOTKEY_CHOICES = [
			{ value: HOTKEY_DEFAULT, label: "Ctrl+Alt+D" },
			{ value: "Ctrl+Shift+D", label: "Ctrl+Shift+D" },
			{ value: "Alt+Shift+D", label: "Alt+Shift+D" },
			{ value: HOTKEY_OFF, label: "关闭" }
		];

		/* 只认「至少一个修饰键 + 一个键位」，否则在输入框里打字就会误触 */
		function parseHotkey(combo) {
			const parts = String(combo || "")
				.split("+")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			if (parts.length < 2) return null;
			const out = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
			for (const part of parts) {
				if (part === "ctrl" || part === "control") out.ctrl = true;
				else if (part === "alt") out.alt = true;
				else if (part === "shift") out.shift = true;
				else if (part === "meta" || part === "win" || part === "cmd") out.meta = true;
				else out.key = part;
			}
			if (!out.key) return null;
			if (!out.ctrl && !out.alt && !out.meta) return null;
			return out;
		}

		/* 四个修饰键**逐个比对**（不是"包含"）：Ctrl+Alt+D 不应被 Ctrl+D 或 Ctrl+Alt+Shift+D 命中 */
		function hotkeyMatches(combo, event) {
			const want = parseHotkey(combo);
			if (!want || !event) return false;
			if (String(event.key || "").toLowerCase() !== want.key) return false;
			if (want.ctrl !== !!event.ctrlKey) return false;
			if (want.alt !== !!event.altKey) return false;
			if (want.shift !== !!event.shiftKey) return false;
			if (want.meta !== !!event.metaKey) return false;
			return true;
		}

		function currentHotkey() {
			try {
				const raw = localStorage.getItem(HOTKEY_KEY);
				if (raw === HOTKEY_OFF) return HOTKEY_OFF;
				if (raw && parseHotkey(raw)) return raw;
			} catch {
				/* localStorage 不可用就退回默认 */
			}
			return HOTKEY_DEFAULT;
		}

		function saveHotkey(value) {
			try {
				localStorage.setItem(HOTKEY_KEY, value === HOTKEY_OFF ? HOTKEY_OFF : String(value || HOTKEY_DEFAULT));
			} catch {
				/* ignore */
			}
			bindHotkey();
		}

		/* 游离浮窗：不依赖 React、不依赖面板挂载、不吃焦点、不建标题栏 */
		let hotkeyCard = null;
		let hotkeyCardTimer = 0;
		function hideHotkeyCard() {
			clearTimeout(hotkeyCardTimer);
			try {
				if (hotkeyCard && hotkeyCard.parentNode) hotkeyCard.parentNode.removeChild(hotkeyCard);
			} catch {
				/* ignore */
			}
			hotkeyCard = null;
		}
		function showHotkeyCard(spec) {
			if (typeof document === "undefined" || !document.body) return;
			const tone = (spec && spec.tone) || "info";
			const lines = spec && Array.isArray(spec.lines) ? spec.lines.filter(Boolean) : [];
			try {
				if (!hotkeyCard) {
					/* 自己的节点自己定位 —— 绝不给 React 管的元素打属性（铁律 1 的反面用法） */
					hotkeyCard = document.createElement("div");
					hotkeyCard.setAttribute("data-dpi-hotkey-card", "1");
					hotkeyCard.style.cssText = [
						"position:fixed",
						"right:18px",
						"bottom:64px",
						"z-index:2147483000",
						"max-width:400px",
						"padding:12px 14px",
						"border-radius:10px",
						"font-size:13px",
						"line-height:1.55",
						"color:var(--dsw-alias-text-1,#e8e8e8)",
						"background:var(--dsw-alias-bg-elevated,#232326)",
						"border:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.14))",
						"box-shadow:0 10px 30px rgba(0,0,0,.35)",
						"cursor:pointer"
					].join(";");
					hotkeyCard.addEventListener("click", hideHotkeyCard);
					document.body.appendChild(hotkeyCard);
				}
				const colors = { ok: "#3ddc84", warn: "#ffb84d", err: "#ff6b6b", info: "#7aa7ff", busy: "#7aa7ff" };
				hotkeyCard.textContent = "";
				const head = document.createElement("div");
				head.textContent = String((spec && spec.title) || "");
				head.style.cssText = "font-weight:600;color:" + (colors[tone] || colors.info);
				hotkeyCard.appendChild(head);
				for (const line of lines) {
					const row = document.createElement("div");
					row.textContent = String(line);
					row.style.cssText = "opacity:.82;margin-top:3px";
					hotkeyCard.appendChild(row);
				}
				clearTimeout(hotkeyCardTimer);
				/* 要人处理的那种留久一点，好让人看清 */
				hotkeyCardTimer = setTimeout(hideHotkeyCard, tone === "err" || tone === "warn" ? 9000 : 4200);
			} catch {
				/* 浮窗失败不影响动作本身 */
			}
		}

		let selfCheckBusy = false;
		/**
		 * 自检 + 自动修复（= 面板上「一键修复」那条路，POST /action {action:"repair"}）。
		 * 幂等，可在任意页面触发；正在跑时再按只是忽略（不排队、不发第二个请求）。
		 */
		function runSelfCheck() {
			if (selfCheckBusy) return Promise.resolve(null);
			selfCheckBusy = true;
			showHotkeyCard({
				tone: "busy",
				title: "环境自检中…",
				lines: ["查 dsh-tools 覆盖 / 悬空 file: 依赖 / trustPolicy / git"]
			});
			/* 先问一句「现在有没有任务在跑」：装到一半时 applyRepairs 会和 pnpm 抢同一批文件。
			   读的是宿主 /state，不是 store.data —— 面板没挂载时 store 可能是空的。 */
			return api("/state", { method: "GET" })
				.then((state) => {
					if (state && state.active) {
						const job = state.active;
						showHotkeyCard({
							tone: "warn",
							title: "正在装东西，先别动环境",
							lines: [
								String(job.name || job.input || job.id || "有一个任务") + "（" + String(job.status || "进行中") + "）",
								"等它结束再按一次 " + currentHotkey()
							]
						});
						return null;
					}
					return api("/action", { method: "POST", body: JSON.stringify({ action: "repair" }) });
				})
				.then((r) => {
					if (!r) return null;
					if (r.report) setLocal({ doctor: r.report });
					if (r && r.state) setStore({ data: r.state });
					const report = (r && r.report) || {};
					/* 宿主那边也有自己的闸：装到一半时它会拒绝并发修复 */
					if (report.busy) {
						showHotkeyCard({
							tone: "warn",
							title: "正在装东西，先别动环境",
							lines: [String(report.error || "等安装结束再按一次")]
						});
						return r;
					}
					const findings = Array.isArray(report.findings) ? report.findings : [];
					const actions = Array.isArray(report.actions) ? report.actions : [];
					const fixed = actions.filter((a) => a && a.ok && !a.skipped);
					const failed = actions.filter((a) => a && a.ok === false);
					const errors = findings.filter((f) => f && f.severity === "error");
					if (failed.length > 0) {
						/* 最要紧的一句：没修干净就别重启 —— 重启只会把问题放大成整片插件加载失败 */
						showHotkeyCard({
							tone: "err",
							title: "有 " + failed.length + " 项没修掉 —— 先别重启",
							lines: [
								String(failed[0].kind || "") + "：" + String(failed[0].error || "未知错误"),
								"打开「插件安装」面板看完整清单"
							]
						});
					} else if (fixed.length > 0) {
						showHotkeyCard({
							tone: "ok",
							title: "清掉了 " + fixed.length + " 项 —— 现在重启是安全的",
							lines: fixed.slice(0, 3).map((a) => "✓ " + String(a.kind || "已处理"))
						});
					} else if (errors.length > 0) {
						showHotkeyCard({
							tone: "warn",
							title: "没有能自动修的，但有 " + errors.length + " 处要看一眼",
							lines: errors.slice(0, 2).map((f) => String(f.title || f.detail || "").slice(0, 90))
						});
					} else if (findings.length > 0) {
						showHotkeyCard({
							tone: "info",
							title: "环境基本正常（" + findings.length + " 条提示）",
							lines: [String(findings[0].title || "").slice(0, 90), "没有需要修的东西"]
						});
					} else {
						showHotkeyCard({
							tone: "ok",
							title: "环境正常，没有埋雷",
							lines: ["dsh-tools 无覆盖 · 无悬空依赖 · 随时可以重启"]
						});
					}
					return r;
				})
				.catch((e) => {
					showHotkeyCard({
						tone: "err",
						title: "自检没跑起来",
						lines: [String((e && e.message) || e), "宿主半边可能还没重启（面板路由要重启才生效）"]
					});
					return null;
				})
				.finally(() => {
					selfCheckBusy = false;
				});
		}

		/**
		 * 换绑快捷键。
		 * ★ client.js 是热重载的：每次重载都会再生一个模块实例，
		 *   所以必须先摘掉上一份监听，否则按一次键会发 N 个请求（N = 重载次数）。
		 *   旧实例的闭包已经没意义，最新实例就该是唯一活着的那一个。
		 */
		function bindHotkey() {
			if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
			try {
				const previous = window.__dpiSelfCheckKeydown;
				if (previous) window.removeEventListener("keydown", previous, true);
			} catch {
				/* ignore */
			}
			const combo = currentHotkey();
			if (combo === HOTKEY_OFF) {
				window.__dpiSelfCheckKeydown = null;
				return;
			}
			const handler = (event) => {
				try {
					if (!hotkeyMatches(combo, event)) return;
					event.preventDefault();
					event.stopPropagation();
					runSelfCheck();
				} catch {
					/* 一个监听里的异常不能污染整个页面 */
				}
			};
			window.__dpiSelfCheckKeydown = handler;
			/* 捕获阶段拿：比面板里的输入框更早知道，避免被吞 */
			window.addEventListener("keydown", handler, true);
		}

		/* ── 设置（R6）───────────────────────────────────────────────────
		 * 默认档 = R5.1 的现有行为：红点开、声音/弹窗关、审核普通、跳过审核按钮开、
		 * 轮询 2.5s、历史 8 条、快照留 40、三个源全开。
		 * 宿主侧存 settings.json 并负责真正的门禁（审核档位 / 红点 / 搜索源）；
		 * 客户端只负责「看得见的那些」：轮询节奏、历史条数、声音与弹窗。
		 */
		const SETTING_DEFAULTS = {
			redDot: true,
			sound: false,
			desktopPopup: false,
			reviewLevel: "normal",
			skipReview: true,
			pollMs: 2500,
			historyLimit: 8,
			snapshotKeep: 40,
			/* R41：AI 推荐 —— 默认 = 现在的行为（3 条 / 标准广度） */
			aiPicks: 3,
			aiBreadth: "standard",
			sources: { npm: true, github: true, hub: true }
		};

		function currentSettings() {
			const data = store.data || {};
			const raw = data.settings || {};
			return {
				...SETTING_DEFAULTS,
				...raw,
				sources: { ...SETTING_DEFAULTS.sources, ...(raw.sources || {}) }
			};
		}

		function saveSettings(patch) {
			return api("/settings", { method: "POST", body: JSON.stringify(patch) })
				.then((r) => {
					if (r && r.state) setStore({ data: r.state });
					else if (r && r.settings) setStore({ data: { ...(store.data || {}), settings: r.settings } });
					return r;
				})
				.catch((e) => {
					toast("设置没保存上：" + String((e && e.message) || e));
				});
		}

		/* 声音：不引音频文件，用 WebAudio 打一短音（权限/自动播放失败一律静默） */
		let audioCtx = null;
		function beep() {
			try {
				const Ctx = window.AudioContext || window.webkitAudioContext;
				if (!Ctx) return;
				audioCtx = audioCtx || new Ctx();
				if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
				const osc = audioCtx.createOscillator();
				const gain = audioCtx.createGain();
				osc.type = "sine";
				osc.frequency.value = 880;
				gain.gain.value = 0.05;
				osc.connect(gain);
				gain.connect(audioCtx.destination);
				osc.start();
				osc.stop(audioCtx.currentTime + 0.14);
			} catch (e) {
				/* 没声音不该影响别的 */
			}
		}

		/* 桌面弹窗：浏览器 Notification；没授权先问一次，仍不行就退回面板内提示 */
		function desktopNotify(title, body) {
			try {
				if (typeof Notification === "undefined") {
					toast(title + " · " + body);
					return;
				}
				const fire = () => {
					try {
						new Notification(title, { body, silent: true });
					} catch (e) {
						toast(title + " · " + body);
					}
				};
				if (Notification.permission === "granted") fire();
				else if (Notification.permission === "default") {
					Notification.requestPermission().then((p) => {
						if (p === "granted") fire();
						else toast(title + " · " + body);
					}).catch(() => toast(title + " · " + body));
				} else {
					toast(title + " · " + body);
				}
			} catch (e) {
				/* 弹窗失败不影响面板 */
			}
		}

		const STATUS_TEXT = {
			running: "进行中",
			"awaiting-confirm": "等待确认",
			done: "已完成",
			failed: "失败",
			cancelled: "已取消",
			"rolled-back": "已回滚"
		};

		const STAGE_ICON = { ok: "✓", warn: "!", fail: "×", running: "…", skip: "–", pending: "·" };

		/* ── 图标 ─────────────────────────────────────────────────────── */

		function InstallIcon(props) {
			const size = props && props.size ? props.size : 18;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					"aria-hidden": true,
					style: { display: "block", pointerEvents: "none" }
				},
				h("path", {
					d: "M3.2 7.4 12 3l8.8 4.4v9.2L12 21l-8.8-4.4z",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinejoin: "round",
					opacity: 0.55
				}),
				h("path", {
					d: "M3.4 7.5 12 11.9l8.6-4.4M12 11.9V20.8",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinejoin: "round",
					opacity: 0.45
				}),
				h("path", {
					d: "M12 7.1v5.2m0 0-2.3-2.3M12 12.3l2.3-2.3",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.9,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			);
		}

		/**
		 * 小图标集（R30）：一律自绘 SVG、同一套描边（1.7 / round），不用 unicode 字符冒充图标。
		 * 只收面板真的用得到的几个 —— 设置 / 刷新 / 安装 / 信息 / 展开箭头。
		 */
		function Glyph(props) {
			const name = (props && props.name) || "info";
			const size = (props && props.size) || 14;
			const common = {
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			};
			const shapes = {
				sliders: [
					h("path", { key: "a", d: "M4 7h16M4 12h16M4 17h16", ...common }),
					h("circle", { key: "b", cx: 9, cy: 7, r: 2, ...common, fill: "var(--dpi-surface,transparent)" }),
					h("circle", { key: "c", cx: 15, cy: 12, r: 2, ...common, fill: "var(--dpi-surface,transparent)" }),
					h("circle", { key: "d", cx: 8, cy: 17, r: 2, ...common, fill: "var(--dpi-surface,transparent)" })
				],
				refresh: [
					h("path", { key: "a", d: "M19 12a7 7 0 1 1-2.1-5", ...common }),
					h("path", { key: "b", d: "M19.4 4.6v4.2h-4.2", ...common })
				],
				install: [
					h("path", { key: "a", d: "M12 4v9.4", ...common }),
					h("path", { key: "b", d: "M8 10l4 3.4 4-3.4", ...common }),
					h("path", { key: "c", d: "M4.8 19.2h14.4", ...common })
				],
				chevron: [h("path", { key: "a", d: "M9.5 6.5 15 12l-5.5 5.5", ...common })],
				/* R36：右上角「清单」与浮窗关闭 —— 自绘，不用 unicode 字符 */
				list: [
					h("path", { key: "a", d: "M5 7h14M5 12h14M5 17h14", ...common }),
					h("circle", { key: "b", cx: 3.2, cy: 7, r: 0.9, ...common, fill: "currentColor", stroke: "none" }),
					h("circle", { key: "c", cx: 3.2, cy: 12, r: 0.9, ...common, fill: "currentColor", stroke: "none" }),
					h("circle", { key: "d", cx: 3.2, cy: 17, r: 0.9, ...common, fill: "currentColor", stroke: "none" })
				],
				x: [h("path", { key: "a", d: "M6.5 6.5l11 11M17.5 6.5l-11 11", ...common })],
				info: [
					h("circle", { key: "a", cx: 12, cy: 12, r: 8.2, ...common }),
					h("path", { key: "b", d: "M12 11v5.2", ...common }),
					h("path", { key: "c", d: "M12 7.9v.2", ...common })
				]
			};
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					"aria-hidden": true,
					style: { display: "block", pointerEvents: "none" }
				},
				shapes[name] || shapes.info
			);
		}

		function SidebarEntry(props) {
			const s = useStore();
			const dot = Boolean(s.data && s.data.attention && s.data.attention.dot);
			const count = (s.data && s.data.attention && s.data.attention.count) || 0;
			const size = props && props.size ? props.size : 18;
			return h(
				"span",
				{
					className: "dpi-entry" + (props && props.active ? " is-active" : ""),
					title: dot ? "插件安装 · " + count + " 条待处理" : "插件安装"
				},
				h(InstallIcon, { size }),
				dot ? h("i", { className: "dpi-dot", "aria-label": count + " 条待处理" }) : null
			);
		}

		/* ── 小组件 ───────────────────────────────────────────────────── */

		function Pill(props) {
			return h("span", { className: "dpi-pill dpi-pill-" + props.tone }, props.children);
		}

		function Row(props) {
			return h("div", { className: "dpi-row " + (props.className || "") }, props.children);
		}

		function Copyable(props) {
			const [done, setDone] = useState(false);
			return h(
				"div",
				{ className: "dpi-cmd" },
				h("code", null, props.children),
				h(
					"button",
					{
						className: "dpi-mini",
						onClick: () => {
							copyText(props.children).then((ok) => {
								setDone(ok);
								if (ok) toast("已复制命令");
								else toast("复制失败：请手动选中");
								setTimeout(() => setDone(false), 1600);
							});
						}
					},
					done ? "已复制" : "复制"
				)
			);
		}

		/* 「怎么解决」：把每条发现的处置步骤摊开（命令仍可一键复制）。
		   数据来自宿主半边的 finding.fix = [{text, command?}]；老任务没有这个字段时退回到
		   finding.action（只有 label/command），所以历史记录不会变成空白。
		   R24：finding.actions = [{kind:"upgrade-npm", plugin, label, hint}] —— 发现卡上的可点动作。
		   现在只有一种：先查 registry 有没有新版，有就升级（真修法），没有就直说。 */
		function FixSteps(props) {
			const steps = props.steps || [];
			const action = props.action;
			const actions = Array.isArray(props.actions) ? props.actions : [];
			if (steps.length === 0 && !(action && action.label) && actions.length === 0) return null;
			return h(
				"div",
				{ className: "dpi-fixbox" },
				h("div", { className: "dpi-fixhead" }, "怎么解决"),
				steps.length > 0
					? h("ol", { className: "dpi-fixlist" }, steps.map((s, i) => {
						const text = typeof s === "string" ? s : (s && (s.text || s.label)) || "";
						const cmd = s && typeof s === "object" ? s.command : null;
						return h("li", { key: "fx" + i }, h("span", null, text), cmd ? h(Copyable, null, cmd) : null);
					}))
					: null,
				actions.length > 0
					? h("div", { className: "dpi-actions dpi-actions-tight" }, actions.map((a, i) =>
						h("button", {
							key: "fa" + i,
							className: "dpi-btn dpi-btn-primary dpi-btn-sm",
							title: (a && a.hint) || "",
							onClick: () => runFindingAction(a)
						}, (a && a.label) || "处置")))
					: null,
				action && action.label
					? h("div", { className: "dpi-fixaction" },
						h("span", null, "面板动作：" + action.label),
						action.command ? h(Copyable, null, action.command) : null)
					: null
			);
		}

		/* 「大白话解释」开关（用户指定的名字，别再改回「通俗讲给我听」）。
		   存 localStorage：同一个用户下次打开面板仍然是他上次选的模式。 */
		const PLAIN_KEY = "dpi.plain-explain";

		function usePlainMode() {
			const [on, setOn] = useState(false);
			useEffect(() => {
				try {
					if (localStorage.getItem(PLAIN_KEY) === "1") setOn(true);
				} catch {
					/* localStorage 不可用就保持默认 */
				}
				return () => {};
			}, []);
			const flip = () => {
				const next = !on;
				setOn(next);
				try {
					localStorage.setItem(PLAIN_KEY, next ? "1" : "0");
				} catch {
					/* ignore */
				}
			};
			return [on, flip];
		}

		function PlainToggle(props) {
			return h("button", {
				className: "dpi-btn dpi-btn-sm dpi-plain-btn" + (props.on ? " is-on" : ""),
				title: props.on ? "现在显示的是大白话；点一下换回术语细节" : "点一下把术语翻译成大白话",
				onClick: props.onFlip
			}, props.on ? "大白话解释 ✓" : "大白话解释");
		}

		/* 一批发现（安装后诊断 / 环境体检共用）。plain = 大白话模式。 */
		function FindingsList(props) {
			const findings = props.findings || [];
			const plain = !!props.plain;
			return h(
				"ul",
				{ className: "dpi-list dpi-list-" + props.tone },
				findings.map((f, i) =>
					h("li", { key: "fd" + i },
						h("b", null, (f.title || "") + (f.fixable ? "（可自动修复）" : "")),
						plain && f.plain
							? h("span", { className: "dpi-detail is-plain" }, f.plain)
							: (f.detail ? h("span", { className: "dpi-detail" }, f.detail) : null),
						plain && f.plain && f.detail
							? h("details", { className: "dpi-hits" },
								h("summary", null, "术语原文"),
								h("div", { className: "dpi-detail" }, f.detail))
							: null,
						h(FixSteps, { steps: f.fix || [], action: f.action, actions: f.actions })
					)
				)
			);
		}

		/* 阶段时间线 */
		function StageList(props) {

			const stages = props.stages || [];
			return h(
				"ol",
				{ className: "dpi-stages" },
				stages.map((stage) => {
					if (stage.status === "pending") return null;
					return h(
						"li",
						{ key: stage.key, className: "dpi-stage is-" + stage.status },
						h("span", { className: "dpi-stage-icon" }, STAGE_ICON[stage.status] || "·"),
						h(
							"span",
							{ className: "dpi-stage-body" },
							h("span", { className: "dpi-stage-label" }, stage.label),
							stage.detail ? h("span", { className: "dpi-stage-detail" }, stage.detail) : null
						),
						typeof stage.ms === "number" && stage.ms > 400
							? h("span", { className: "dpi-stage-ms" }, (stage.ms / 1000).toFixed(1) + "s")
							: null
					);
				})
			);
		}

		/* R34：阶段时间线 → **进度条**。
		   用户原话：「历史里的『插件』展开后非常长一串，需要简化，使其更适合小白用户使用…
		   绿色方框的位置可以简化成进度条，进度条在加载时会在下方浮现一行淡淡的小字显示目前正在做什么，
		   结束时不再浮现小字，但是可以点开会显示某一步做了什么」。
		   所以：条 = 每一步一段；小字 = 只在**还在跑**时出现（当前这一步在干什么）；
		   点条（或右侧箭头）= 展开原来那张一步不落的明细。 */
		function StageProgress(props) {
			const stages = props.stages || [];
			if (stages.length === 0) return null;
			const [open, setOpen] = useState(false);
			const finished = props.status === "done" || props.status === "failed" || props.status === "cancelled";
			const done = stages.filter((s) => s.status === "ok" || s.status === "skip").length;
			const running = finished ? null : stages.find((s) => s.status === "running");
			const failed = stages.find((s) => s.status === "fail") || null;
			const segClass = (st) => (st === "ok" || st === "skip" ? "done" : st === "warn" ? "warn" : st === "fail" ? "fail" : st === "running" ? "running" : "idle");
			return h(
				"div",
				{ className: "dpi-progress" },
				h(
					"button",
					{
						className: "dpi-progress-btn" + (open ? " is-open" : ""),
						title: "点开看每一步做了什么",
						onClick: () => setOpen(!open)
					},
					h("span", { className: "dpi-progress-track", "aria-hidden": true },
						stages.map((stage) => h("i", { key: stage.key, className: "dpi-progress-seg is-" + segClass(stage.status) }))),
					h("span", { className: "dpi-progress-count" }, failed ? "失败" : done + "/" + stages.length),
					h("span", { className: "dpi-chev" + (open ? " is-open" : "") }, h(Glyph, { name: "chevron", size: 11 }))
				),
				running
					? h("div", { className: "dpi-progress-note" },
						running.label + (running.detail ? " · " + running.detail : "") + "…")
					: null,
				open ? h(StageList, { stages }) : null
			);
		}

		/* R34：**事的后材料默认收起来**。
		   「决定要不要装」的东西（等待确认时的安全预检）留在外面；
		   事后的证据（预检全文 / AI 审查 / 插件管理器回执 / 来源信息）收进「技术细节」。
		   数据一条没少 —— 只是默认不糊在脸上，点一下全在。 */
		function JobTechFold(props) {
			const job = props.job || {};
			const [open, setOpen] = useState(false);
			const detected = job.detected;
			const showPc = Boolean(job.precheck) && job.status !== "awaiting-confirm";
			const showReview = Boolean(job.review);
			const showReceipt = Boolean(job.install && job.install.kind === "bundle" && job.install.result);
			const showMeta = Boolean(detected && (detected.description || detected.files || detected.skill));
			if (!showPc && !showReview && !showReceipt && !showMeta) return null;
			const bits = [];
			if (showPc) bits.push("安全预检");
			if (showReview) bits.push("AI 审查");
			if (showReceipt) bits.push("插件管理器回执");
			if (showMeta) bits.push("来源信息");
			return h(
				"div",
				{ className: "dpi-tech" },
				h("button", { className: "dpi-tech-btn" + (open ? " is-open" : ""), onClick: () => setOpen(!open) },
					h("span", { className: "dpi-chev" + (open ? " is-open" : "") }, h(Glyph, { name: "chevron", size: 11 })),
					"技术细节：" + bits.join(" / ")),
				open
					? h(
						"div",
						{ className: "dpi-tech-body" },
						showMeta
							? h("div", { className: "dpi-meta" },
								detected.description ? h("div", null, detected.description) : null,
								h("div", { className: "dpi-muted" },
									(detected.name || "未命名") +
									(detected.files ? " · " + detected.files + " 个文件 / " + fmtBytes(detected.bytes) : "") +
									(detected.wrappers && detected.wrappers.length ? " · 剥壳 " + detected.wrappers.join("/") : "") +
									(detected.skill && detected.skill.name ? " · 技能 " + detected.skill.name : "")))
							: null,
						showPc ? h(PrecheckCard, { precheck: job.precheck }) : null,
						showReview ? h(ReviewCard, { review: job.review }) : null,
						showReceipt ? h("pre", { className: "dpi-pre" }, JSON.stringify(job.install.result, null, 2)) : null)
					: null
			);
		}

		/* R34：宿主没在响应时**不再**甩一句「面板读不到状态：响应不是 JSON（HTTP 404）」。
		   人要的是：它可能正在重启、现在自动重连到第几次、要不要管、管就得做什么。
		   ⚠️ 2026-10-30 的真实现场：装完插件宿主重启时 `tools` 服务没起来（45 个插件都在等它），
		   `/plugin-installer/*` 整块 404 —— 那时候唯一有用的话是「等它回来，回不来就修启动失败」。 */
		function HostDownBanner(props) {
			const host = props.host || {};
			const [open, setOpen] = useState(false);
			const secs = Math.max(0, Math.round((Date.now() - (host.since || Date.now())) / 1000));
			const stage = secs < 10
				? "正在重启（装完 / 升级插件后宿主会重启一次）"
				: secs < 60
					? "还没回来 —— 它可能卡在启动里"
					: "一直没回来 —— 这次启动大概失败了";
			return h(
				"div",
				{ className: "dpi-offline" },
				h("div", { className: "dpi-offline-head" },
					h("span", { className: "dpi-offline-dot" }),
					h("b", null, "连不上宿主半边"),
					h("span", { className: "dpi-muted" }, "· 第 " + (host.attempts || 1) + " 次重连 · 已 " + secs + " 秒"),
					h("button", { className: "dpi-btn dpi-btn-sm", onClick: props.onRetry }, "立即重试")),
				h("div", { className: "dpi-offline-note" }, stage + "。面板每 2.5 秒自动重连，不用刷新页面。"),
				host.error ? h("div", { className: "dpi-offline-err" }, "最近一次失败：" + host.error) : null,
				h("button", { className: "dpi-btn dpi-btn-ghost dpi-btn-sm", onClick: () => setOpen(!open) },
					open ? "收起怎么做" : "一直连不上怎么办"),
				open
					? h("ol", { className: "dpi-offline-steps" },
						h("li", null, "先等 30 秒：装完插件宿主会自己重启一次，这段时间连不上是正常的。"),
						h("li", null, "还不行：把 DSH 完全退出再打开（托盘里也要退），别只关窗口。"),
						h("li", null, "如果启动时它报「1 required plugin did not activate」或「plugins waiting for services: tools」：多半是 profile 里多了一份 @deepseek-ai/dsh-tools —— 跑一次 `.tools\\dsh-boot-guard.mjs --apply`（或 python `.tools\\dsh_doctor.py --fix`）再启动。"),
						h("li", null, "启动失败后 DSH 可能弹「禁用第三方插件」——**别点**，它会把 dsh.profile.bundles 从几十项裁到 2 项。要恢复用 `.tools\\dsh-boot-guard.mjs --apply`。"))
					: null
			);
		}

		/* R35：「等待确认」以前是两张巨卡（安全预检 + 用途 vs 权限），里面还有重复段落 ——
		   用户原话：「安装过程也需要简化，信息有点太多，不知道该看哪个」。
		   现在先给一个**决定条**：为什么停下来（一句）+ 它要什么（能力 chips）+ 有没有安装期脚本；
		   详细判据收进一个折叠（点一下全在）。 */
		function DecisionBar(props) {
			const job = props.job || {};
			const pc = job.precheck || {};
			const purpose = pc.purpose || null;
			const risks = pc.risks || {};
			const caps = String(risks.summary || "")
				.split("、")
				.map((s) => s.trim())
				.filter((s) => s && !/^组合信号/.test(s));
			const scripts = (risks.scripts || []).map((s) => s.name).filter(Boolean);
			const purposeLabel = (purpose && purpose.purpose && purpose.purpose.label) || null;
			const never = (purpose && purpose.unexpected) || [];
			let why;
			if (pc.blocked) why = "安全预检判定不能装（下面写清了原因）";
			else if (purpose && purpose.verdict === "error" && purposeLabel) {
				why = "它自称「" + purposeLabel + "」，却要" +
					(never.length > 0 ? never.map((u) => u.label).slice(0, 4).join("、") : "这些能力") +
					" —— 不像这个用途该有的，所以停下来先问你";
			} else if (purpose && purpose.verdict === "warn" && purposeLabel) {
				why = "它比「" + purposeLabel + "」该有的多要了一点，看一眼再决定";
			} else if (pc.needsConfirm) why = "有 " + (caps.length || "几") + " 类能力需要你点头";
			else why = "预检要你确认一下";
			return h(
				"div",
				{ className: "dpi-decide" },
				h("div", { className: "dpi-decide-why" }, h("b", null, "为什么停下来："), why),
				caps.length > 0
					? h("div", { className: "dpi-decide-caps" }, caps.map((cap, i) => h("span", { key: "cap" + i, className: "dpi-chip" }, cap)))
					: null,
				scripts.length > 0
					? h("div", { className: "dpi-decide-flag" }, "⚠ 它带安装期脚本（" + scripts.join("、") + "）：确认后会真的在本机跑")
					: null
			);
		}

		/* R35：把一段「整段 pnpm 输出」压成**该看的那一行**。
		   由来：失败当时把 pnpm 的整段输出存进了 error.message，红点上显示的是
		   `卸载旧版失败：✓ Lockfile passes supply-chain policies…`（那是**成功**信息），
		   真原因被埋在中间。宿主侧出口已经改了，但**已经失败的旧任务**存的是老文案 ——
		   这层兜底让它在不重启的情况下也读得懂。 */
		function tidyError(message) {
			const text = String(message || "");
			const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
			if (lines.length <= 1) return text;
			const pick = lines.find((line) => /ERR_PNPM_|^Error:|^✖/.test(line));
			if (!pick) return lines[0].length > 220 ? lines[0].slice(0, 217) + "…" : lines[0];
			const head = /^([^：]{2,14})：/.exec(lines[0]);
			return (head ? head[1] + "：" : "") + pick;
		}

		/* 预检结论 */
		function PrecheckCard(props) {
			const pc = props.precheck;
			if (!pc) return null;
			const reasons = pc.reasons || [];
			const blocks = reasons.filter((r) => r.level === "block");
			const warns = reasons.filter((r) => r.level === "warn");
			const infos = reasons.filter((r) => r.level === "info");
			const risks = pc.risks || {};
			return h(
				"div",
				{ className: "dpi-card dpi-precheck" },
				h(
					"div",
					{ className: "dpi-card-head" },
					h("strong", null, "安全预检"),
					h(Pill, { tone: pc.blocked ? "error" : warns.length > 0 ? "warn" : "ok" },
						pc.blocked ? "阻断" : warns.length > 0 ? "需确认" : "通过"),
					pc.compat && pc.compat.verdict
						? h(Pill, { tone: pc.compat.verdict === "ok" ? "ok" : pc.compat.verdict === "mismatch" ? "error" : "warn" },
							"兼容：" + (pc.compat.verdict === "ok" ? "满足" : pc.compat.verdict === "mismatch" ? "不匹配" : pc.compat.verdict === "exempted" ? "已豁免" : "无法确认"))
						: null,
					pc.compat && pc.compat.runtimeVersion
						? h("span", { className: "dpi-muted" }, "宿主 " + pc.compat.runtimeVersion + " · " + (pc.compat.via || ""))
						: null
				),
				blocks.length > 0
					? h("ul", { className: "dpi-list dpi-list-block" }, blocks.map((r, i) => h("li", { key: "b" + i }, h("b", null, r.text), r.detail ? h("span", { className: "dpi-detail" }, r.detail) : null)))
					: null,
				/* R35：去掉两处「同一件事说两遍」——
				   ① 「权限与用途不符」那条 warn 的 detail 与下面的「用途 vs 权限」卡逐字重复；
				   ② 「静态扫描发现…」那条 warn 的 detail 与紧接着的 `静态扫描：…` 行重复。
				   判据：purpose 卡在场时跳过 ①；静态扫描那行只留标题，明细交给下面那次（可展开）。 */
				warns.length > 0
					? h("ul", { className: "dpi-list dpi-list-warn" }, warns
						.filter((r) => !(pc.purpose && /权限与用途不符/.test(String(r.text || ""))))
						.map((r, i) => h("li", { key: "w" + i }, h("b", null, r.text),
							r.detail && !/静态扫描/.test(String(r.text || "")) ? h("span", { className: "dpi-detail" }, r.detail) : null)))
					: null,
				h(
					"div",
					{ className: "dpi-risks" },
					h("span", { className: "dpi-muted" }, "静态扫描：" + (risks.summary || "未扫描")),
					risks.hits && risks.hits.length > 0
						? h(
							"details",
							{ className: "dpi-hits" },
							h("summary", null, "看 " + risks.hits.length + " 条命中"),
							h(
								"ul",
								null,
								risks.hits.map((hit, i) => h("li", { key: "h" + i },
									h("code", null, hit.file + ":" + hit.line),
									" ",
									h("span", { className: "dpi-tag dpi-tag-" + hit.severity }, hit.label),
									h("div", { className: "dpi-excerpt" }, hit.excerpt)
								))
							)
						)
						: null,
					risks.combos && risks.combos.length > 0
						? h("ul", { className: "dpi-list dpi-list-warn" }, risks.combos.map((combo, i) => h("li", { key: "c" + i }, h("b", null, combo.label), h("span", { className: "dpi-detail" }, combo.detail))))
						: null
				),
				infos.length > 0
					? h("ul", { className: "dpi-list dpi-list-info" }, infos.slice(0, 6).map((r, i) => h("li", { key: "i" + i }, r.text, r.detail ? h("span", { className: "dpi-detail" }, r.detail) : null)))
					: null,
				pc.fixes && pc.fixes.length > 0
					? h(
						"div",
						{ className: "dpi-fixes" },
						h("div", { className: "dpi-muted" }, "下一步"),
						pc.fixes.map((fix, i) =>
							fix.command
								? h(Copyable, { key: "f" + i }, fix.command)
								: h("div", { key: "f" + i, className: "dpi-muted" }, "· " + fix.label)
						)
					)
					: null,
				/* 用途 vs 权限（R3）：先说是干什么的，再说它要的能力对不对得上。
				   用户明确要「按用途判断权限是否合理」，所以这块单独成卡，不藏在命中列表里。 */
				pc.purpose
					? h("div", { className: "dpi-purpose" },
						h("div", { className: "dpi-purpose-head" },
							h("strong", null, "用途 vs 权限"),
							h("span", { className: "dpi-tag dpi-tag-kind" }, (pc.purpose.purpose && pc.purpose.purpose.label) || "未识别"),
							h(Pill, {
								tone: pc.purpose.verdict === "ok" ? "ok" : pc.purpose.verdict === "warn" ? "warn" : pc.purpose.verdict === "error" ? "error" : "idle"
							}, pc.purpose.verdict === "ok" ? "匹配" : pc.purpose.verdict === "warn" ? "略超范围" : pc.purpose.verdict === "error" ? "明显不符" : "未判"),
							pc.purpose.purpose && pc.purpose.purpose.confidence ? h("span", { className: "dpi-muted" }, "判断把握：" + (pc.purpose.purpose.confidence === "high" ? "高" : pc.purpose.purpose.confidence === "medium" ? "中" : "低")) : null),
						h("div", { className: "dpi-detail is-plain" }, pc.purpose.plain || ""),
						pc.purpose.findings && pc.purpose.findings.length > 0
							? h("ul", { className: "dpi-list dpi-list-warn" }, pc.purpose.findings.map((f, i) =>
								h("li", { key: "pp" + i }, h("b", null, f.text), f.detail ? h("span", { className: "dpi-detail" }, f.detail) : null)))
							: null,
						pc.purpose.present && pc.purpose.present.length > 0
							? h("div", { className: "dpi-muted" }, "它实际用到的能力：" + pc.purpose.present.join("、"))
							: null,
						pc.purpose.advice && pc.purpose.advice.length > 0
							? h(FixSteps, { steps: pc.purpose.advice.map((t) => ({ text: t })) })
							: null)
					: null,
				pc.trust && pc.trust.notes && pc.trust.notes.length > 0
					? h("ul", { className: "dpi-list dpi-list-info" }, pc.trust.notes.map((note, i) => h("li", { key: "t" + i }, note)))
					: null
			);
		}

		/* 安装后诊断：结论 + 每条发现 + 怎么解决 + 大白话解释开关。
		   用户的原话是「不仅要给诊断，还要交代怎么解决」，所以这里默认就把处置步骤摊开，
		   不需要先点开什么；「大白话解释」是给不想看术语的人准备的另一种说法。 */
		function DiagnosisCard(props) {
			const diag = props.diagnosis;
			const [plain, flip] = usePlainMode();
			if (!diag) return null;
			const findings = diag.findings || [];
			const hasPlain = findings.some((f) => f && typeof f.plain === "string" && f.plain.length > 0);
			const plainLine = diag.plain || (diag.verdict === "ok"
				? "大白话：装好了，宿主也认得它，没发现要处理的。"
				: diag.verdict === "warn"
					? "大白话：装上了，但有地方不太对劲，下面每条都写了怎么解决。"
					: "大白话：这次没能正常用起来，下面每条都写了怎么解决。");
			return h(
				"div",
				{ className: "dpi-card" },
				h(
					"div",
					{ className: "dpi-card-head" },
					h("strong", null, "安装后诊断"),
					h(Pill, { tone: diag.verdict === "ok" ? "ok" : diag.verdict === "warn" ? "warn" : "error" },
						diag.verdict === "ok" ? "一切正常" : diag.verdict === "warn" ? "有告警" : "需要处理"),
					hasPlain ? h(PlainToggle, { on: plain, onFlip: flip }) : null
				),
				h("div", { className: "dpi-detail is-plain" }, plainLine),
				findings.length > 0
					? h(FindingsList, {
						findings,
						plain,
						tone: diag.verdict === "ok" ? "info" : diag.verdict === "warn" ? "warn" : "block"
					})
					: h("div", { className: "dpi-muted" }, "没有发现问题。")
			);
		}

		/* AI 审查结果 */
		function ReviewCard(props) {
			const review = props.review;
			if (!review) return null;
			const skipped = review.status === "skipped";
			const tone = skipped ? "idle" : review.verdict === "safe" ? "ok" : review.verdict === "malicious" ? "error" : "warn";
			return h(
				"div",
				{ className: "dpi-card" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "AI 语义审查"),
					h(Pill, { tone }, skipped ? "已跳过" : (review.verdict || review.status)),
					review.model ? h("span", { className: "dpi-muted" }, review.model) : null,
					/* R4：把「这次审查花了多少 token / 省了多少」直接写出来 —— 用户问过一次成本，就让他从此看得见。 */
					review.estTokens && review.estTokens.total
						? h("span", { className: "dpi-muted" }, "≈" + review.estTokens.total + " token")
						: (review.estTokens && review.estTokens.saved ? h("span", { className: "dpi-muted" }, "省下 ≈" + review.estTokens.saved + " token") : null)
				),
				h("div", { className: "dpi-muted" },
					review.status === "pending" ? "排队中（异步，不阻塞安装）"
						: skipped ? (review.skipReason || review.note || "常规能力，不需要模型判断")
							: review.status === "unavailable" ? "AI 通道未启用"
								: review.error ? "未完成：" + review.error
									: review.verdict === "safe" ? "判 safe 不单独放行：最终仍以静态扫描为准"
										: review.verdict === "malicious" ? "判恶意：建议立刻回滚"
											: "结论不确定：请自己看上面的命中片段"
				),
				review.findings && review.findings.length > 0
					? h("ul", { className: "dpi-list dpi-list-info" }, review.findings.map((f, i) =>
						h("li", { key: "r" + i }, h("b", null, f.title), f.why ? h("span", { className: "dpi-detail" }, f.why) : null, f.evidence ? h("div", { className: "dpi-excerpt" }, f.evidence) : null)))
					: null
			);
		}

		/* R9：安装脚本待批准 —— 「允许并重试」。
		记两条纪律：① 名单必须一个个列出来给人看（批准 = 让作者写的脚本在本机跑）；
		② 二次确认后才发请求；宿主还会再核一遍名单是否仍然 pending。 */
		function BuildApprovalCard(props) {
			const job = props.job;
			const busy = props.busy;
			const act = props.act;
			const [asking, setAsking] = useState(false);
			const install = (job && job.install) || null;
			const names = install && Array.isArray(install.pendingBuilds) ? install.pendingBuilds.filter(Boolean) : [];
			if (names.length === 0) return null;
			const failure = install.failure || null;
			const already = Array.isArray(install.approvedBuilds) && install.approvedBuilds.length > 0;
			return h(
				"div",
				{ className: "dpi-card dpi-card-warn" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "安装脚本待批准：" + names.length + " 个包"),
					h(Pill, { tone: "warn" }, "要你点头"),
					already ? h("span", { className: "dpi-muted" }, "已批准过：" + install.approvedBuilds.join("、")) : null),
				h("div", { className: "dpi-muted" },
					failure && failure.plain
						? failure.plain
						: "大白话：这些包装的时候要跑一段脚本（常是编译原生模块、下平台二进制）。宿主不让它们自己偷偷跑，所以这次停在这儿了。"),
				h("ul", { className: "dpi-list dpi-list-warn" },
					names.map((name, i) => h("li", { key: "bp" + i }, h("b", null, name)))),
				asking
					? h("div", { className: "dpi-ask" },
						h("b", null, "确认让这些包在本机跑安装脚本？"),
						h("div", { className: "dpi-detail" },
							"批准 = 允许 " + names.join("、") + " 作者写的脚本以你的权限执行（编译、下载二进制都可能）。",
							"只批准你认识、且来源可信的包；不确定就先别批 —— 换一个不需要构建脚本的版本也行。"),
						h("div", { className: "dpi-actions dpi-actions-tight" },
							h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setAsking(false) }, "再想想"),
							h("button", {
								className: "dpi-btn dpi-btn-primary dpi-btn-sm",
								disabled: busy !== null,
								onClick: () => {
									setAsking(false);
									act("approve-builds", { names });
								}
							}, busy === "approve-builds" ? "重试中…" : "我确认允许")))
					: h("div", { className: "dpi-actions dpi-actions-tight" },
						h("button", { className: "dpi-btn dpi-btn-primary dpi-btn-sm", disabled: busy !== null, onClick: () => setAsking(true) }, "允许这些包跑安装脚本并重试"),
						h("span", { className: "dpi-muted" }, "会开一条新任务重新装一遍（批准记录写进 profile 的 allowBuilds）"))
			);
		}

		/* R31：本机目录插件的**直连安装**（不走 pnpm）。
		   为什么要有这一张卡：用户自己写的插件通常就住在工作区里，pnpm 那条路（重打成 .tgz →
		   插件管理器 → 重算依赖树）在本机会被 profile 的 trustPolicy 掐掉，于是「总是装不上」。
		   直连安装只做三件事：建链接、写一行 link: 依赖、加进 bundles —— 一次 pnpm 都不跑。
		   代价必须写在按钮旁边：装的是「随时在变的源码」，不是固定字节；宿主半边要重启才生效。 */
		function LinkInstallCard(props) {
			const job = props.job;
			const busy = props.busy;
			const act = props.act;
			const [asking, setAsking] = useState(false);
			const link = (job && job.link) || null;
			if (!job || !link) return null;
			if (job.status === "running") return null;
			/* 已经是直连安装：不出现按钮（那时「装一遍」本身就不该被点） */
			if (link.alreadyLinked && link.entryLinked) return null;
			const name = link.name || (job.detected && job.detected.name) || "";
			const dir = link.sourceDir || "";
			if (link.blocked) {
				return h("div", { className: "dpi-card" },
					h("div", { className: "dpi-card-head" }, h("strong", null, "这条路走不通：直连安装被拒"), h(Pill, { tone: "warn" }, "不能直连")),
					h("div", { className: "dpi-muted" }, link.blocked.text),
					link.blocked.plain ? h("div", { className: "dpi-detail" }, link.blocked.plain) : null,
					link.blocked.fix && link.blocked.fix.length > 0
						? h("ul", { className: "dpi-list dpi-list-info" }, link.blocked.fix.map((f, i) => h("li", { key: "lkf" + i }, f.text)))
						: null);
			}
			const steps = Array.isArray(link.steps) ? link.steps : [];
			return h("div", { className: "dpi-card dpi-card-info" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "也可以直连安装（不走 pnpm）"),
					h(Pill, { tone: "ok" }, "不碰依赖树")),
				h("div", { className: "dpi-muted" },
					"直连安装 = 在 profile 的 node_modules 里建链接指向你的源码目录 + 写一行 link: 依赖 + 加进 dsh.profile.bundles。" +
					"它**不重算依赖树、不跑 pnpm** —— 本机 pnpm 现在被 trustPolicy 挡着，走 .tgz 很可能失败，这条路不受影响。"),
				h("div", { className: "dpi-muted" }, "这次会做：" + (steps.length > 0 ? steps.join("；") : "（profile 已经对上了，只会跑一次复核）")),
				h("div", { className: "dpi-muted" }, "目录：" + dir),
				asking
					? h("div", { className: "dpi-ask" },
						h("b", null, "确认把这台机器上的 profile 指向这个源码目录？"),
						h("div", { className: "dpi-detail" },
							"会改 profile 的 package.json（依赖行 + bundles 清单）与 node_modules/" + name + " 的一条链接；写前有快照可回滚。",
							"装的是「随时在变的源码」：以后改了代码不用再装，但宿主半边要重启 DSH 才生效。",
							"不跑 pnpm，也不改 pnpm-lock.yaml —— 所以它不改依赖树，也就不会被 trustPolicy 挡。"),
						h("div", { className: "dpi-actions dpi-actions-tight" },
							h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setAsking(false) }, "再想想"),
							h("button", {
								className: "dpi-btn dpi-btn-primary dpi-btn-sm",
								disabled: busy !== null,
								onClick: () => {
									setAsking(false);
									act("link-install", { reason: "panel" });
								}
							}, busy === "link-install" ? "安装中…" : "我确认直连安装")))
					: h("div", { className: "dpi-actions dpi-actions-tight" },
						h("button", { className: "dpi-btn dpi-btn-primary dpi-btn-sm", disabled: busy !== null, onClick: () => setAsking(true) }, "直连安装（不走 pnpm）"),
						h("span", { className: "dpi-muted" }, "装完要重启 DSH 才加载新代码"))
			);
		}

		/* R31：pnpm 的供应链策略挡住了整次安装（ERR_PNPM_TRUST_DOWNGRADE）。
		   要点：被点名的包**不是**你要装的插件（它是别的插件的传递依赖），所以重试没有意义。
		   面板给两条真路径：豁免这一个版本（写前备份 + 二次确认），或者改走直连安装（那张卡在上面）。 */
		function TrustExemptCard(props) {
			const job = props.job;
			const busy = props.busy;
			const act = props.act;
			const [asking, setAsking] = useState(false);
			const install = (job && job.install) || null;
			const failure = install && install.failure ? install.failure : null;
			if (!failure || failure.kind !== "trust-downgrade") return null;
			const action = failure.action || null;
			const trust = failure.trust || null;
			const entry = (action && action.entry) || (trust && trust.entry) || "";
			if (!entry) return null;
			const chain = trust && trust.root && trust.via ? trust.root + " → " + trust.via : "";
			return h("div", { className: "dpi-card dpi-card-warn" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "pnpm 信任策略挡了一次安装：" + entry),
					h(Pill, { tone: "warn" }, "跟你要装的插件无关")),
				h("div", { className: "dpi-muted" },
					"profile 里开着 trustPolicy: no-downgrade。同一个包，旧版本有「可信发布者」证据、新版本没有，" +
					"pnpm 就当成可能被人接管，于是**拒绝整次安装** —— 一个包被拒，整棵树都不装。" +
					(chain ? "被点名的这个包是被 " + chain + " 拉进来的。" : "")),
				h("div", { className: "dpi-detail" },
					"所以换插件、重试都不会好：要动的是这条策略的豁免名单，或者把那个依赖钉回有可信证据的旧版。"),
				asking
					? h("div", { className: "dpi-ask" },
						h("b", null, "确认豁免 " + entry + "？"),
						h("div", { className: "dpi-detail" },
							"这会在 profile 的 pnpm-workspace.yaml 里加一行 trustPolicyExclude: " + entry + "（写前备份、写后复核）。",
							"含义：pnpm **不再**对这一个包的这一个版本做「可信度降级」检查。范围只到这一条，不做通配。",
							"只在你看过它确实只是版本更新导致证据缺失时才点；如果它是被投毒的包，这一步等于把闸门打开。"),
						h("div", { className: "dpi-actions dpi-actions-tight" },
							h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setAsking(false) }, "再想想"),
							h("button", {
								className: "dpi-btn dpi-btn-primary dpi-btn-sm",
								disabled: busy !== null,
								onClick: () => {
									setAsking(false);
									act("add-trust-exclude", { entries: [entry] });
								}
							}, busy === "add-trust-exclude" ? "写入中…" : "我确认豁免这一个版本")))
					: h("div", { className: "dpi-actions dpi-actions-tight" },
						h("button", { className: "dpi-btn dpi-btn-primary dpi-btn-sm", disabled: busy !== null, onClick: () => setAsking(true) }, "豁免 " + entry),
						h("span", { className: "dpi-muted" }, "豁免之后回面板点「重试」"))
			);
		}

		/* R10：版本不兼容 —— 以前这里是一条「先退出 DSH 再跑 CLI」的死路。
		   现在把宿主的精确版本豁免做成同一套「二次确认 → 宿主授权 → 重试」。 */
		function CompatExemptCard(props) {			const job = props.job;
			const busy = props.busy;
			const act = props.act;
			const [asking, setAsking] = useState(false);
			const compat = (job && job.precheck && job.precheck.compat) || null;
			if (!compat) return null;
			const blocked = compat.verdict === "mismatch" && compat.exempted !== true;
			if (!blocked) return null;
			const name = compat.name || "这个包";
			const version = compat.version || "?";
			const runtime = compat.runtimeVersion || "未知";
			const key = (compat.exemption && compat.exemption.key) || (name + "@" + version);
			const staleFor = compat.exemption && compat.exemption.forOtherRuntimes ? compat.exemption.runtimes || [] : [];
			const req = compat.requirements && Object.keys(compat.requirements).length
				? Object.entries(compat.requirements).map(([dep, range]) => dep + " 要求 " + range).join("；")
				: "";
			const granted = job && job.install && job.install.versionExemption;
			return h(
				"div",
				{ className: "dpi-card dpi-card-warn" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "版本不兼容：" + key),
					h(Pill, { tone: "warn" }, "要你决定"),
					granted ? h("span", { className: "dpi-muted" }, "已授权过精确版本豁免") : null),
				h("div", { className: "dpi-muted" },
					"这个版本声明不接受本机 DSH " + runtime + (req ? "（" + req + "）" : "") +
					"。宿主会直接跳过它 —— 不报错，插件和它的工具一起消失。"),
				staleFor.length > 0
					? h("div", { className: "dpi-detail" },
						"宿主里有一条给这个版本的旧豁免，但只对 " + staleFor.join(" / ") + " 生效，对当前 " + runtime +
						" 不生效（多半是升级 DSH 之后失效的）。重新授权一次即可。")
					: null,
				asking
					? h("div", { className: "dpi-ask" },
						h("b", null, "确认在这个 DSH 上强行走 " + key + "？"),
						h("div", { className: "dpi-detail" },
							"放行 = 让作者写的代码在它没声明支持的环境里跑，可能崩溃或损坏数据。",
							"豁免只对**这一个精确版本 + 当前 DSH 版本**生效，写进 profile 的 compatibility.json（宿主留痕）。",
							"升级 DSH 或换插件版本后自动失效，需要重新授权。"),
						h("div", { className: "dpi-actions dpi-actions-tight" },
							h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setAsking(false) }, "再想想"),
							h("button", {
								className: "dpi-btn dpi-btn-primary dpi-btn-sm",
								disabled: busy !== null,
								onClick: () => {
									setAsking(false);
									act("exempt-version", {});
								}
							}, busy === "exempt-version" ? "授权中…" : "我确认风险，授权这一次")))
					: h("div", { className: "dpi-actions dpi-actions-tight" },
						h("button", { className: "dpi-btn dpi-btn-sm", disabled: busy !== null, onClick: () => setAsking(true) }, "接受风险并授权这个精确版本"),
						h("span", { className: "dpi-muted" }, "推荐先「换一个匹配当前 DSH 的版本」；这条是硬用的最后手段"))
			);
		}

		/* R27：换版本（先卸后装）—— 面板上要能看见「为什么必须卸、由谁卸、中断了能不能续」。
		   判据全在宿主（job.replacement / job.upgrade / job.collaborator），客户端不重算。 */
		const UPGRADE_PHASE_TEXT = {
			prepared: "新包已备好（还没动旧版）",
			removing: "正在卸载旧版",
			removed: "旧版已卸载，准备装新版",
			"remove-failed": "卸载失败（profile 未变）",
			interrupted: "中断：等续跑",
			done: "完成"
		};
		function UpgradeCard(props) {
			const job = props.job;
			const busy = props.busy;
			const act = props.act;
			const rep = job && job.replacement;
			if (!rep || !rep.needed) return null;
			const up = job.upgrade || null;
			const collab = job.collaborator || null;
			const canResume = Boolean(job.error && job.error.code === "upgrade-interrupted" && up &&
				(up.resumable === true || (up.phase === "interrupted" && up.prepared)));
			const removal = up && up.removal ? up.removal : null;
			const restore = up && up.restore ? up.restore : null;
			return h("div", { className: "dpi-card" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, rep.direction === "downgrade" ? "降级（先卸后装）" : "换版本（先卸后装）"),
					h("span", { className: "dpi-muted" }, (rep.from || "?") + " → " + (rep.to || "?"))),
				rep.blocked
					? h("div", { className: "dpi-error" },
						h("b", null, rep.blocked.text),
						rep.blocked.plain ? h("div", { className: "dpi-detail" }, rep.blocked.plain) : null,
						rep.blocked.fix && rep.blocked.fix.length > 0 ? h(FixSteps, { steps: rep.blocked.fix }) : null)
					: h("div", { className: "dpi-muted" },
						collab && collab.ok
							? "会先卸载旧版（由 " + (collab.label || "「插件目录」") + " 执行并复核依赖行），再装新版。装失败会尝试装回旧版；新版本要下次启动 DSH 才加载。"
							: "升级需要「插件目录」执行卸载：" + ((collab && collab.reason) || "协作方未知")),
				up && up.phase
					? h("div", { className: "dpi-muted" },
						"阶段：" + (UPGRADE_PHASE_TEXT[up.phase] || up.phase) +
						(removal ? " · 卸载" + (removal.ok ? "成功" : "失败：" + (removal.error || removal.code || "?")) : "") +
						(restore ? " · 装回" + (restore.ok ? "成功（v" + (restore.current || "?") + "）" : "没成功：" + (restore.error || restore.why || "?")) : ""))
					: null,
				canResume
					? h("div", { className: "dpi-actions" },
						h("button", {
							className: "dpi-btn dpi-btn-primary",
							disabled: busy !== null,
							onClick: () => act("resume-upgrade")
						}, busy === "resume-upgrade" ? "续跑中…" : "继续升级（装 " + (up.to || "新版") + "）"),
						h("span", { className: "dpi-muted" }, "包已备好，不会重新下载；只做「安装」这一步。"))
					: null,
				up && up.removalPlan && up.removalPlan.warnings && up.removalPlan.warnings.length > 0
					? h("details", { className: "dpi-hits" },
						h("summary", null, "「插件目录」卸载前的提醒（" + up.removalPlan.warnings.length + " 条）"),
						h("ul", { className: "dpi-list dpi-list-info" },
							up.removalPlan.warnings.map((w, i) => h("li", { key: "upw" + i }, w.text))))
					: null
			);
		}

		/* 一个任务的全部细节 */
		function JobDetail(props) {
			const job = props.job;
			const [busy, setBusy] = useState(null);
			if (!job) return null;
			const detected = job.detected;
			const act = async (action, extra) => {
				setBusy(action);
				try {
					const result = await api("/action", { method: "POST", body: JSON.stringify({ action, id: job.id, ...(extra || {}) }) });
					if (result && result.state) setStore({ data: result.state });
					if (result && result.ok === false) toast(result.message || "操作失败");
					else if (action === "rollback") toast("已回滚到安装前快照");
					else if (action === "confirm") toast("继续安装");
					else if (action === "ack") toast("已清除红点");
					else if (action === "approve-builds") toast("已批准安装脚本，正在重新安装");
					else if (action === "link-install") toast("已直连安装：重启 DSH 后加载新代码");
					else if (action === "add-trust-exclude") toast((result && result.message) || "已写入豁免，回面板点重试");
				} catch (e) {
					toast("操作失败：" + String((e && e.message) || e));
				} finally {
					setBusy(null);
				}
			};

			return h(
				"div",
				{ className: "dpi-job" },
				/* R30：历史里展开的那一条**已经在行里**写了状态/标题/时间 —— 详情再写一遍就是重复。
				   `hideHead` 只由 History 传（顶层「正在跑」的那张卡仍然需要自己的头）。 */
				props.hideHead
					? null
					: h(
						"div",
						{ className: "dpi-job-head" },
						h(Pill, { tone: job.status === "failed" ? "error" : job.status === "done" ? "ok" : job.status === "awaiting-confirm" ? "warn" : "idle" },
							STATUS_TEXT[job.status] || job.status),
						h("span", { className: "dpi-job-title" }, job.title || (job.input && job.input.raw) || job.id),
						detected && detected.kind
							? h("span", { className: "dpi-tag dpi-tag-kind" }, detected.kind === "bundle" ? "插件" : detected.kind === "skill" ? "Skill" : detected.kind)
							: null,
						detected && detected.version ? h("span", { className: "dpi-muted" }, "v" + detected.version) : null,
						h("span", { className: "dpi-muted dpi-right" }, ago(job.updatedAt || job.createdAt))
					),

				job.error
					? h("div", { className: "dpi-error" },
						h("b", null, (job.error.stage ? "[" + job.error.stage + "] " : "") + tidyError(job.error.message)),
						job.error.plain ? h("div", { className: "dpi-detail" }, job.error.plain) : null,
						job.error.hint ? h("div", { className: "dpi-detail" }, "建议：" + job.error.hint) : null,
						job.error.fix && job.error.fix.length > 0 ? h(FixSteps, { steps: job.error.fix, actions: job.error.actions }) : null)
					: null,

				/* R9：安装脚本待批准 —— 面板上直接给「允许并重试」，别让人自己去翻 yaml */
				h(BuildApprovalCard, { job, busy, act }),

				/* R31：pnpm 供应链策略挡路（ERR_PNPM_TRUST_DOWNGRADE）—— 给「豁免这一个版本」 */
				h(TrustExemptCard, { job, busy, act }),

				/* R31：本机目录插件 —— 给「直连安装（不走 pnpm）」这条不碰依赖树的路 */
				h(LinkInstallCard, { job, busy, act }),

				/* R10：版本不兼容 —— 面板上直接给「授权精确版本豁免并重试」 */
				h(CompatExemptCard, { job, busy, act }),

				/* R27：换版本（先卸后装）—— 为什么必须卸、由谁卸、中断了能不能续 */
				h(UpgradeCard, { job, busy, act }),

				/* R34：原来这里是一张「10 个绿色方框」的详细时间线 + 预检卡 + 回执 + 审查卡，
				   展开一条历史能拉出两三屏（用户原话：「非常长一串，需要简化，更适合小白用户」）。
				   现在：**进度条**（还在跑时下面浮一行小字说在干什么，跑完就没小字，点开看每一步），
				   事后的证据统一收进「技术细节」；只有「等待确认」时预检留在外面（那是按不按的依据）。 */
				h(StageProgress, { stages: job.stages, status: job.status }),

				job.status === "awaiting-confirm" ? h(DecisionBar, { job }) : null,

				job.status === "awaiting-confirm"
					? h("div", { className: "dpi-actions" },
						h("button", { className: "dpi-btn dpi-btn-primary", disabled: busy !== null, onClick: () => act("confirm") }, busy === "confirm" ? "继续中…" : "确认安装"),
						h(SkipReviewButton, { job, busy, act }),
						h("button", { className: "dpi-btn", disabled: busy !== null, onClick: () => act("cancel") }, "取消"),
						h("span", { className: "dpi-muted" }, "有告警才停下来问你；确认后秒装。")
					)
					: null,

				/* R35：详细判据收进一个折叠 —— 想核对的点开，不想看的不必先滚过两屏。 */
				job.status === "awaiting-confirm"
					? h("details", { className: "dpi-hits dpi-why" },
						h("summary", null, "凭什么这么判（安全预检 / 用途对账 / 扫描命中）"),
						h(PrecheckCard, { precheck: job.precheck }))
					: null,

				h(JobTechFold, { job }),

				h(DiagnosisCard, { diagnosis: job.diagnosis }),
				/* ⚠️ 审查卡**只在 JobTechFold 里**渲染。这里以前还有一份（R34 改版时漏删），
				   结果它一直挂在折叠外面 —— 实测那一张就占 507px，占掉整张历史卡的一半高度。 */

				job.rollback
					? h("div", { className: "dpi-card" },
						h("div", { className: "dpi-card-head" }, h("strong", null, "已回滚"), h("span", { className: "dpi-muted" }, ago(job.rollback.at))),
						h("ul", { className: "dpi-list dpi-list-info" },
							job.rollback.results.map((r, i) => h("li", { key: "rb" + i }, r.step + (r.ok === false ? "（失败：" + (r.reason || "?") + "）" : " ✓")))))
					: null,

				h("div", { className: "dpi-actions dpi-actions-end" },
					job.detected && job.status !== "running" && job.status !== "awaiting-confirm"
						? h("button", { className: "dpi-btn", disabled: busy !== null, onClick: () => act("rediagnose") },
							busy === "rediagnose" ? "诊断中…" : "重新诊断")
						: null,
					job.precheck && job.precheck.needsAiReview && (!job.review || job.review.status === "pending" || job.review.status === "failed")
						? h("button", { className: "dpi-btn", disabled: busy !== null, onClick: () => act("review") }, busy === "review" ? "审查中…" : "跑一次 AI 审查")
						: null,
					job.snapshot
						? h("button", { className: "dpi-btn", disabled: busy !== null, onClick: () => act("rollback") },
							busy === "rollback"
								? "回滚中…"
								: job.rollback
									? "再回滚一次"
									: job.install && job.install.upgrade && job.install.previousVersion
										/* R26：升级的回滚是「装回旧版」，不是卸载 */
										? "回滚到 v" + job.install.previousVersion
										: "回滚到安装前")
						: null,
					job.status === "failed" && job.input
						? h("button", { className: "dpi-btn", onClick: () => { submitInput(job.input.raw); } }, "重试")
						: null,
					(store.data && store.data.attention && store.data.attention.count > 0)
						? h("button", { className: "dpi-btn dpi-btn-ghost", onClick: () => act("ack") }, "清除红点")
						: null
				)
			);
		}

		/* ── 提交 ─────────────────────────────────────────────────────── */

		let inputValue = "";
		function submitInput(raw) {
			const text = String(raw || "").trim();
			if (!text) return Promise.resolve();
			/* R36：`mcp:<registry 名字>` = 装一台 MCP 服务器（写组合文件，不是装插件包）。 */
			if (/^mcp:/i.test(text)) {
				return installMcpSpec(text).then((result) => {
					if (result && result.ok) {
						inputValue = "";
						setLocal({ search: null });
					}
					return result;
				});
			}
			setLocal({ busy: true });
			return api("/submit", { method: "POST", body: JSON.stringify({ input: text, source: "panel" }) })
				.then((result) => {
					if (result.state) setStore({ data: result.state });
					if (!result.ok) {
						if (result.reason === "netdisk") toast(result.message);
						else if (result.reason === "name" || (result.candidates && result.candidates.items)) {
							setLocal({ search: result.candidates || null, ai: null });
							toast("只给了名字：先看下面的候选");
						} else toast(result.message || result.reason || "提交失败");
						return result;
					}
					inputValue = "";
					setLocal({ search: null });
					return result;
				})
				.catch((e) => {
					toast("提交失败：" + String((e && e.message) || e));
				})
				.finally(() => setLocal({ busy: false }));
		}

		/* ── 已装清单 / 更新检查 / MCP（R36：三个清单都已收纳到「清单」浮窗）──
		 *
		 * 以前 Inventory / Skills 是主面板里的两张常驻卡，面板打开就各拉一次数据。
		 * 用户说它们「用的不多」—— 现在只在点开浮窗时才挂载并拉取；但「检查更新」
		 * 与已装规模仍是主流程要看见的，所以留了一个独立的 UpdateBar（不依赖浮窗）。
		 */
		let invLoading = false;
		function loadInventory(force) {
			if (invLoading) return Promise.resolve(null);
			if (!force && store.local.inventory && store.local.inventory.ok !== false) return Promise.resolve(store.local.inventory);
			invLoading = true;
			setLocal({ invBusy: true });
			return api("/inventory")
				.then((r) => {
					if (!r || r.ok === false) {
						const view = { ok: false, error: (r && r.error) || "读不到已装清单" };
						setLocal({ inventory: view });
						return view;
					}
					setLocal({ inventory: r.inventory });
					return r.inventory;
				})
				.catch((e) => {
					const view = { ok: false, error: String((e && e.message) || e) };
					setLocal({ inventory: view });
					return view;
				})
				.finally(() => {
					invLoading = false;
					setLocal({ invBusy: false });
				});
		}

		/**
		 * R37/R38：合并检查完成后的一句话摘要（toast 用）。
		 *
		 * 单独抽成纯函数，是因为这里有一个很容易说假话的判据：**0 条可检查 ≠ 都是最新的**。
		 * 本机没有 MCP 时，第一版就把 checked=0 说成了「MCP 都是最新的」—— 面板上那条却写着
		 * 「没有可检查的条目」；R38 的 Skill 同理：没有来源记录时不能说「都是最新的」。
		 */
		function checkAllSummaryText(inventory, mcpUpdates, mcpError, skillUpdates, skillError) {
			const sum = inventory && inventory.summary;
			const msum = mcpUpdates && mcpUpdates.summary;
			const ssum = skillUpdates && skillUpdates.summary;
			const parts = [];
			if (inventory && inventory.ok === false) parts.push("插件检查失败");
			else if (sum) parts.push(sum.outdated > 0 ? "插件可升级 " + sum.outdated + " 个" : "插件都是最新的");
			if (mcpError) parts.push(mcpError);
			else if (msum) {
				parts.push(msum.checked === 0
					? "MCP 没有可检查的条目"
					: msum.outdated > 0
						? "MCP 可升级 " + msum.outdated + " 台"
						: "MCP 都是最新的");
			}
			if (skillError) parts.push(skillError);
			else if (ssum) {
				if (ssum.tracked === 0) parts.push("Skill 没有来源记录（存量补不回来）");
				else if (ssum.outdated > 0) parts.push("Skill 可升级 " + ssum.outdated + " 个" + (ssum.unknown > 0 ? "（无法判断 " + ssum.unknown + "）" : ""));
				else parts.push("Skill 都跟来源一致" + (ssum.unknown > 0 ? "（无法判断 " + ssum.unknown + "）" : ""));
			}
			return parts.length ? parts.join(" · ") : "检查完成";
		}

		/**
		 * R37：一次点击检查更新（插件 + MCP；R38 起再加 Skill）。
		 *
		 * 以前主面板一个「检查更新」、已装 MCP 浮窗里又一个，各查各的 ——
		 * 用户得记住「MCP 的更新在另一个窗口里查」。现在只有这一个入口：
		 * 宿主侧 checkAllUpdates() 把三条链都跑完（一条失败不拖垮其它），
		 * 这里一次写回三边的结果，摘要也在同一条里说清。
		 */
		function runCheckAllUpdates() {
			setLocal({ invBusy: true, mcpBusy: true });
			return api("/action", { method: "POST", body: JSON.stringify({ action: "check-all-updates" }) })
				.then((r) => {
					if (r && r.state) setStore({ data: r.state });
					if (!r) return r;
					if (r.ok === false) {
						toast(r.error || "检查更新失败");
						return r;
					}
					if (r.inventory) setLocal({ inventory: r.inventory });
					if (r.mcp) setLocal({ mcp: r.mcp });
					if (r.mcpUpdates) setLocal({ mcpUpdates: r.mcpUpdates });
					if (r.skills) setLocal({ skills: r.skills });
					if (r.skillUpdates) setLocal({ skillUpdates: r.skillUpdates });
					setLocal({ skillError: r.skillError || null });
					toast(checkAllSummaryText(r.inventory, r.mcpUpdates, r.mcpError, r.skillUpdates, r.skillError));
					return r;
				})
				.catch((e) => {
					toast("检查更新失败：" + String((e && e.message) || e));
				})
				.finally(() => setLocal({ invBusy: false, mcpBusy: false }));
		}

		/* R26：批量升级 —— 串行排队、一次一单；只升 npm 来源（本地 .tgz 要重新打包，排不了队）。
		   R36：从「已装插件」卡里搬出来（清单已收进浮窗），入口在 UpdateBar。 */
		function upgradeAllOutdated(includeRisky) {
			const inv = store.local.inventory || {};
			const items = Array.isArray(inv.items) ? inv.items : [];
			const targets = items.filter((item) => item.update && item.update.relation === "outdated");
			if (!targets.length) return;
			const collab = (store.data && store.data.collaborator) || null;
			if (!collab || !collab.ok) {
				toast("批量升级需要「插件目录」卸载旧版 —— " + ((collab && collab.reason) || "它当前不可用"));
				return;
			}
			if (includeRisky !== true) {
				const ok = typeof window !== "undefined" && window.confirm
					? window.confirm("把可升级的 " + targets.length + " 个 npm 包排进队列，逐个换版本？\n\n" +
						"· 每个都是「先卸载旧版（由「插件目录」执行并复核）→ 再装新版」\n" +
						"· 卸载到装回之间，那个插件不可用；新版本要下次启动 DSH 才加载\n" +
						"· 装失败会自动尝试装回旧版\n" +
						"· 每个都会先做安全预检与安装前快照；需要确认的会停下来等你\n" +
						"· 宿主重启后队列不自动续跑\n" +
						"· 跨大版本 / 0.x 小版本的会单独再问你一次\n" +
						"· 本地 .tgz / Git / link 来源不排队（需要时按单条「升级」走）")
					: true;
				if (!ok) return;
			}
			setLocal({ invBusy: true });
			api("/action", { method: "POST", body: JSON.stringify({ action: "update-all", includeRisky: includeRisky === true }) })
				.then((r) => {
					if (r && r.state) setStore({ data: r.state });
					if (!r || r.ok === false) {
						toast((r && r.error) || "排队失败");
						return;
					}
					const n = (r.queued || []).length;
					const risky = (r.needsAttention || []);
					const startedInfo = r.started || null;
					const startNote = startedInfo && startedInfo.started
						? "第一个已开始"
						: startedInfo && startedInfo.reason
							? "第一个没有开始（" + ({ busy: "已有任务在跑", "awaiting-confirm": "有一单在等你确认", empty: "队列是空的" }[startedInfo.reason] || startedInfo.reason) + "）"
							: "排队完成";
					if (risky.length > 0) {
						const list = risky.slice(0, 5).map((x) => "· " + x.name + " " + (x.from || "?") + " → " + x.to + (x.gap ? "（" + x.gap + "）" : "")).join("\n");
						const go = typeof window !== "undefined" && window.confirm
							? window.confirm("已把 " + n + " 个常规升级排进队列。\n\n另有 " + risky.length +
								" 个跨越较大的版本（可能含破坏性变更）：\n" + list +
								(risky.length > 5 ? "\n· …等 " + risky.length + " 个" : "") +
								"\n\n仍要一起升级吗？点「取消」就只装前面那些。")
							: false;
						if (go) {
							upgradeAllOutdated(true);
							return;
						}
						toast("已排队 " + n + " 个；跨版本的 " + risky.length + " 个没有排");
						return;
					}
					toast(n > 0
						? "已排队 " + n + " 个（" + startNote + "，后面的自动接着跑）"
						: (includeRisky === true ? "没有可排队的升级" : "没有可排队的升级（跨版本的需单独确认）"));
				})
				.catch((e) => toast("排队失败：" + String((e && e.message) || e)))
				.finally(() => setLocal({ invBusy: false }));
		}

		let skillsLoading = false;
		function loadSkills(force) {
			if (skillsLoading) return Promise.resolve(null);
			if (!force && store.local.skills && store.local.skills.ok !== false) return Promise.resolve(store.local.skills);
			skillsLoading = true;
			setLocal({ skillsBusy: true });
			return api("/skills" + (force ? "?fresh=1" : ""))
				.then((r) => {
					if (!r || r.ok === false) {
						const view = { ok: false, error: (r && r.error) || "读不到技能清单" };
						setLocal({ skills: view });
						return view;
					}
					/* R38：视图里带着来源台账与最近一次更新检查（30 分钟内）—— 面板重开不丢结果 */
					setLocal(r.skills && r.skills.updates ? { skills: r.skills, skillUpdates: r.skills.updates } : { skills: r.skills });
					return r.skills;
				})
				.catch((e) => {
					const view = { ok: false, error: String((e && e.message) || e) };
					setLocal({ skills: view });
					return view;
				})
				.finally(() => {
					skillsLoading = false;
					setLocal({ skillsBusy: false });
				});
		}

		let mcpLoading = false;
		function loadMcp(force) {
			if (mcpLoading) return Promise.resolve(null);
			if (!force && store.local.mcp && store.local.mcp.ok !== false) return Promise.resolve(store.local.mcp);
			mcpLoading = true;
			setLocal({ mcpBusy: true });
			return api("/mcp" + (force ? "?fresh=1" : ""))
				.then((r) => {
					if (!r || r.ok === false) {
						const view = { ok: false, error: (r && r.error) || "读不到 MCP 清单", items: [], counts: { total: 0, running: 0 } };
						setLocal({ mcp: view });
						return view;
					}
					/* R37：宿主把上一条更新检查的结果一起回传（30 分钟内），
					   面板重开 / 热重载后 MCP 的「可升级 / 无法判断」不会莫名消失。 */
					setLocal(r.updates ? { mcp: r.mcp, mcpUpdates: r.updates } : { mcp: r.mcp });
					return r.mcp;
				})
				.catch((e) => {
					const view = { ok: false, error: String((e && e.message) || e), items: [], counts: { total: 0, running: 0 } };
					setLocal({ mcp: view });
					return view;
				})
				.finally(() => {
					mcpLoading = false;
					setLocal({ mcpBusy: false });
				});
		}

		/** 写一台 MCP 服务器进 profile 组合文件（R36）。spec 可以是 `mcp:foo` / `foo@1.2.3`。 */
		function installMcpSpec(spec, options) {
			const text = String(spec || "").trim().replace(/^mcp:/i, "");
			if (!text) return Promise.resolve({ ok: false, error: "缺 MCP 名字" });
			const where = "profile 的 cordis.patch.yml";
			const ok = typeof window === "undefined" || !window.confirm
				? true
				: window.confirm(
					"把这台 MCP 服务器写进 " + where + "？\n\n" +
					"· 服务器：" + text + "\n" +
					"· 写的是组合文件里的一条 dsh-mcp-client 配置（不是装插件包）\n" +
					"· 会先备份原文件；写完要重启 DSH 才加载\n" +
					"· 只写 Registry 给的 command / URL；不会写任何密钥\n\n" +
					(options && options.installPath ? "安装路径：" + options.installPath + "\n\n" : "") +
					"继续？"
				);
			if (!ok) return Promise.resolve({ ok: false, cancelled: true });
			setLocal({ busy: true });
			return api("/action", { method: "POST", body: JSON.stringify({ action: "add-mcp", spec: text }) })
				.then((r) => {
					if (r && r.state) setStore({ data: r.state });
					if (!r || r.ok === false) {
						toast((r && (r.error || r.message)) || "写不进组合文件");
						return r;
					}
					if (r.mcp) setLocal({ mcp: r.mcp, mcpUpdates: null });
					else loadMcp(true);
					toast("已写入组合文件" + (r.added && r.added.file ? "：" + r.added.file : "") + "，重启 DSH 后生效");
					setLocal({ ai: null, search: null });
					return r;
				})
				.catch((e) => {
					toast("写入失败：" + String((e && e.message) || e));
				})
				.finally(() => setLocal({ busy: false }));
		}

		function installMcpCandidate(item) {
			if (!item) return Promise.resolve();
			if (item.installable === false) {
				if (typeof window !== "undefined" && window.confirm) window.confirm((item.blockedReason || "这台服务器不能自动装") + "\n\n可以点「复制组合片段」，自己填好再粘进 cordis.patch.yml。");
				return Promise.resolve();
			}
			return installMcpSpec((item.registryName || item.name) + (item.version ? "@" + item.version : ""), { installPath: item.installPath });
		}

		/* ── 面板 ─────────────────────────────────────────────────────── */

		/* R24：发现卡上的可点动作。当前只有 `upgrade-npm` ——
		   「日志里失败的那份 client 包还是同一份字节」时，唯一真修法就是换成新版本。
		   两步走：先问 registry（POST action:check-updates，30 分钟缓存），有新版才提交升级；
		   没有就直说「已经是最新版」，不给假按钮（R19 的判据：别让人点一个做不成事的按钮）。 */
		function runFindingAction(action) {
			const kind = action && action.kind;
			const plugin = String((action && action.plugin) || "");
			/* R31：两个新动作。都走 POST /action，且都由宿主再判一遍（面板只是把按钮接上）。
			   · link-install：失败卡上的「直连安装（不走 pnpm）」，需要 jobId；
			   · add-trust-exclude：失败卡上的「豁免 <pkg>@<ver>」，需要 entry。 */
			if (kind === "link-install") {
				const jobId = String((action && (action.jobId || action.id)) || "");
				if (!jobId) {
					toast("这条动作缺少任务 id：请到任务卡上点那个按钮");
					return Promise.resolve();
				}
				return api("/action", { method: "POST", body: JSON.stringify({ action: "link-install", id: jobId, reason: "finding" }) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						toast(r && r.ok === false ? (r.message || "直连安装失败") : "已直连安装：重启 DSH 后加载新代码");
					})
					.catch((e) => toast("直连安装失败：" + String((e && e.message) || e)));
			}
			if (kind === "add-trust-exclude") {
				const entry = String((action && action.entry) || "");
				if (!entry) {
					toast("这条动作缺少要豁免的包名");
					return Promise.resolve();
				}
				return api("/action", { method: "POST", body: JSON.stringify({ action: "add-trust-exclude", entries: [entry] }) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						toast((r && (r.message || r.error)) || "已处理");
					})
					.catch((e) => toast("写豁免失败：" + String((e && e.message) || e)));
			}
			if (kind !== "upgrade-npm" || !plugin) return Promise.resolve();
			return api("/action", { method: "POST", body: JSON.stringify({ action: "check-updates" }) })
				.then((r) => {
					if (r && r.state) setStore({ data: r.state });
					const inv = (r && r.inventory) || null;
					if (inv && inv.ok === false) {
						toast("读不到已装清单：" + (inv.error || inv.note || "未知原因"));
						return null;
					}
					const item = ((inv && inv.items) || []).find((x) => x && x.name === plugin);
					const current = item && item.update && item.update.relation === "current";
					const latest = item && item.update && item.update.relation === "outdated" ? item.update.latestVersion : null;
					if (!item) {
						toast("已装清单里没有 " + plugin + "：它可能不是 npm 装的，重启也修不了那份字节");
						return null;
					}
					if (!latest) {
						toast(current
							? "npm 上已经是最新版（v" + (item.localVersion || "?") + "）：这个错得等作者修，或先把这个插件停掉"
							: "查不到 " + plugin + " 的最新版（" + ((item.update && item.update.error) || "registry 没回话") + "）：先按下面几步处置");
						return null;
					}
					toast("升级 " + plugin + " → " + latest);
					return submitInput("npm:" + (item.registryName || item.name) + "@" + latest);
				})
				.catch((e) => toast("检查更新失败：" + String((e && e.message) || e)));
		}

		function Composer() {
			const s = useStore();
			const [text, setText] = useState(inputValue);
			const [dragging, setDragging] = useState(false);
			const areaRef = useRef(null);
			const busy = s.local.busy;

			const send = () => {
				inputValue = text;
				submitInput(text).then(() => setText(""));
			};

			const drop = async (event) => {
				event.preventDefault();
				setDragging(false);
				const files = event.dataTransfer && event.dataTransfer.files;
				if (!files || files.length === 0) {
					const textData = event.dataTransfer && event.dataTransfer.getData && event.dataTransfer.getData("text");
					if (textData) {
						setText(textData.trim());
						toast("已从剪贴板填入链接，点安装即可");
					}
					return;
				}
				const file = files[0];
				if (file.size > 80 * 1024 * 1024) {
					toast("文件超过 80 MB：请把它放到本机，然后在上面填绝对路径");
					return;
				}
				setLocal({ busy: true });
				try {
					const res = await fetch(API + "/upload", {
						method: "POST",
						headers: { "x-file-name": encodeURIComponent(file.name) },
						body: file
					});
					const result = await res.json();
					if (result.state) setStore({ data: result.state });
					if (!result.ok) toast((result.submitted && result.submitted.message) || "上传后处理失败");
					else toast("已收到 " + file.name + "（" + Math.round(file.size / 1024) + " KiB）");
				} catch (e) {
					toast("上传失败：" + String((e && e.message) || e));
				} finally {
					setLocal({ busy: false });
				}
			};

			return h(
				"div",
				{
					className: "dpi-composer" + (dragging ? " is-drag" : ""),
					onDragOver: (e) => {
						e.preventDefault();
						setDragging(true);
					},
					onDragLeave: () => setDragging(false),
					onDrop: drop
				},
				h("textarea", {
					ref: areaRef,
					className: "dpi-input",
					rows: 2,
					placeholder: "GitHub 链接 / Release 页 / .tgz·.zip 直链 / 本机绝对路径 / 包名 / mcp:<MCP Registry 名字>。也可以直接把文件拖进来。",
					value: text,
					onChange: (e) => setText(e.target.value),
					onKeyDown: (e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							if (!busy) send();
						}
					}
				}),
				h("div", { className: "dpi-composer-row" },
					h("button", { className: "dpi-btn dpi-btn-primary", disabled: busy || !text.trim(), onClick: send },
						h(Glyph, { name: "install", size: 14 }),
						busy ? "处理中…" : "安装"),
					h("button", { className: "dpi-btn", disabled: busy || !text.trim(), onClick: () => { const t = text.trim(); setText(""); setLocal({ ai: { reply: "搜索中…", recommendations: [] }, aiBusy: true });
						api("/search", { method: "POST", body: JSON.stringify({ query: t }) }).then((r) => {
							setLocal({ ai: { reply: "搜索：" + t + "（" + ((r.items || []).length) + " 条）", recommendations: (r.items || []).map((x) => ({ ...x, why: x.description })), localOnly: r.localOnly || null, searchOnly: true }, aiBusy: false });
						}).catch((e) => setLocal({ ai: { reply: "搜索失败：" + String((e && e.message) || e), recommendations: [] }, aiBusy: false })); }
					}, "只搜索")
				),
				/* 提示从「按钮行右端」挪到自己一行：右端那一坨在窄屏会被整块藏掉，
				   而它说的正是「哪些链接不处理」，属于应该在的地方。 */
				h("div", { className: "dpi-composer-note" },
					h(Glyph, { name: "info", size: 13 }),
					h("span", null, "网盘链接不自动下载（自己下好再拖进来）；只给名字会先搜候选。MCP 服务器也走这里：搜到会标 MCP，安装 = 往 profile 组合文件写一条配置（重启后生效）。全程只有确定性的下载 / 解包 / 预检 / 安装 —— 唯一会花 token 的是下面的 AI 推荐。")),
				dragging ? h("div", { className: "dpi-drop-veil" }, "松手：我会把它交给宿主解包识别") : null
			);
		}

		/** R36：MCP 推荐的「安装路径 / 环境变量 / 不能自动装」三行。 */
		function mcpRecoDetails(item) {
			const rows = [];
			if (!item || item.kind !== "mcp") return rows;
			rows.push(h("div", { className: "dpi-mcp-path" },
				h("span", { className: "dpi-muted" }, "安装路径："),
				h("code", null, item.installPath || (item.transport === "stdio" ? item.spec : "（registry 没给）")),
				h("span", { className: "dpi-muted" }, " · 写进 profile 的 cordis.patch.yml，重启后生效")));
			if (item.requiredEnv && item.requiredEnv.length > 0) {
				rows.push(h("div", { className: "dpi-muted" }, "需要环境变量：" + item.requiredEnv.join("、") + "（面板不会替你写值）"));
			}
			if (item.installable === false) {
				rows.push(h("div", { className: "dpi-flag is-warn" }, "⚠ " + (item.blockedReason || "这台服务器不能自动装")));
			}
			return rows;
		}

		/**
		 * R36 / R40：推荐卡底部动作 —— 三类各有各的「装」：
		 *   · plugin → 安装这个（提交 spec）
		 *   · mcp    → 装成 MCP（写组合文件）/ 复制片段（缺参数时）
		 *   · skill  → 安装这个 Skill（提交 treeUrl；面板现有的安装入口就认 tree 链接，
		 *              装的是这个仓库的这个子目录，不会误装同仓库的别的技能）
		 */
		function recoActions(item, isMcp) {
			if (item && item.kind === "skill") {
				if (item.installedKnown) return h("span", { className: "dpi-muted" }, "技能根里已经有同名目录了（重装请到「已装 Skill」里按来源重装）");
				if (item.installable === false) return h("span", { className: "dpi-muted" }, "不能装：" + (item.blockedReason || "SKILL.md 不合法"));
				return h("button", {
					className: "dpi-btn dpi-btn-primary dpi-btn-sm",
					title: item.treeUrl || "",
					onClick: () => { toast("提交技能目录：" + (item.subdir || item.name)); submitInput(item.treeUrl || item.spec || item.name); }
				}, "安装这个 Skill");
			}
			if (!isMcp) return h("button", { className: "dpi-btn dpi-btn-primary dpi-btn-sm", onClick: () => submitInput(item.spec || item.name) }, "安装这个");
			if (item.installedKnown) return h("span", { className: "dpi-muted" }, "已经在「已装 MCP」里（重启后才会出现在工具表）");
			if (item.installable === false) {
				return h("button", {
					className: "dpi-btn dpi-btn-sm",
					onClick: () => { copyText(item.configYaml || ""); toast("已复制组合片段，粘进 cordis.patch.yml 后重启"); }
				}, "复制组合片段");
			}
			return h("button", { className: "dpi-btn dpi-btn-primary dpi-btn-sm", onClick: () => installMcpCandidate(item) }, "装成 MCP");
		}

		function AiBox() {
			const s = useStore();
			const st = currentSettings();
			const [text, setText] = useState("");
			const [customText, setCustomText] = useState("");
			const busy = s.local.aiBusy;
			const result = s.local.ai;
			const ask = () => {
				const query = text.trim();
				if (!query || busy) return;
				setLocal({ aiBusy: true, ai: { reply: "想…", recommendations: [] } });
				api("/ai", { method: "POST", body: JSON.stringify({ message: query }) })
					.then((r) => {
						if (r && r.ok === false && r.error === "empty") return setLocal({ ai: { reply: r.reply, recommendations: [] }, aiBusy: false });
						setLocal({ ai: r, aiBusy: false });
					})
					.catch((e) => setLocal({ ai: { reply: "AI 调用失败：" + String((e && e.message) || e), recommendations: [] }, aiBusy: false }));
			};
			const breadthLabel = st.aiBreadth === "wide" ? "广" : st.aiBreadth === "max" ? "很广" : "标准";
			const listing = result && result.listing;
			/* R42：自定义条目 —— 推荐列表的最后一条永远是一个「自己填」的入口。
			   它走的是与推荐卡**完全相同**的提交口（submitInput），所以 GitHub 链接 / tree 链接 /
			   npm 包名 / `mcp:名字` / 本机 .tgz 都认，预检、快照、诊断、AI 审查照常走。
			   为什么要有它：AI 与六个源都可能搜不到（本机自写、私有库、刚发布的），
			   而「贴一个链接进来」本来就是面板最强的入口 —— 不该只藏在输入框里。 */
			const submitCustom = () => {
				const value = customText.trim();
				if (!value || busy) return;
				setCustomText("");
				toast("已提交自定义条目：" + value);
				submitInput(value);
			};
			const customRow = h("div", { className: "dpi-reco dpi-reco-custom", key: "custom" },
				h("div", { className: "dpi-reco-head" },
					h("b", null, "自定义条目"),
					h("span", { className: "dpi-tag dpi-tag-kind" }, "自己填"),
					h("span", { className: "dpi-muted" }, "链接 / 包名 / mcp:名字 / 本机 .tgz")),
				h("div", { className: "dpi-reco-why" }, "不在上面的候选里也能直接提交；预检、快照、诊断与 AI 审查照常走。"),
				h("div", { className: "dpi-composer-row" },
					h("input", {
						className: "dpi-input dpi-input-line",
						placeholder: "https://github.com/o/r/tree/main/skills/x · @scope/pkg · mcp:filesystem · D:/pkg.tgz",
						value: customText,
						onChange: (e) => setCustomText(e.target.value),
						onKeyDown: (e) => {
							if (e.key === "Enter") submitCustom();
						}
					}),
					h("button", { className: "dpi-btn dpi-btn-primary dpi-btn-sm", disabled: busy || !customText.trim(), onClick: submitCustom }, "装这个")));
			return h(
				"div",
				{ className: "dpi-card dpi-ai" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "AI 推荐"),
					h("span", { className: "dpi-muted" }, "只有三件事：搜索 / 推荐 / 递安装请求 —— 它不能装，装的是宿主代码")),
				/* R41：现在能看见「这一轮按什么广度、给几条」——否则用户不知道设置有没有生效 */
				h("div", { className: "dpi-muted dpi-ai-limits" },
					"本轮设置：最多 " + st.aiPicks + " 条 · 广度 " + breadthLabel +
					(listing && listing.total ? " · 候选 " + listing.total + " 条（列出 " + listing.listed + " 条）" : "") +
					" —— 可在「设置 → AI 推荐」里调"),
				h("div", { className: "dpi-composer-row" },
					h("input", {
						className: "dpi-input dpi-input-line",
						placeholder: "想装什么？例如「给对话加折叠」「视频下载」",
						value: text,
						onChange: (e) => setText(e.target.value),
						onKeyDown: (e) => {
							if (e.key === "Enter") ask();
						}
					}),
					h("button", { className: "dpi-btn", disabled: busy || !text.trim(), onClick: ask }, busy ? "思考中…" : "问 AI")),
				result && result.reply ? h("div", { className: "dpi-ai-reply" }, result.reply) : null,
				/* R25：搜的是本机自己写的插件时，六个源都不会有它 —— 不说清楚，6 条不相干的结果看起来像搜索坏了 */
				result && result.localOnly
					? h("div", { className: "dpi-muted dpi-local-only", title: result.localOnly.spec || "" }, "· " + result.localOnly.text)
					: null,
				/* R42：推荐列表最后永远跟一条「自定义条目」—— 没搜到、或用户就是知道自己要装什么时，
				   直接填一个链接/包名提交；走的是与推荐卡同一个入口（submitInput） */
				h("div", { className: "dpi-recos" },
					result && result.recommendations && result.recommendations.length > 0
						? [...result.recommendations.map((item, i) => {
						const isMcp = item.kind === "mcp";
						const isSkill = item.kind === "skill";
						return h("div", { className: "dpi-reco" + (isMcp ? " dpi-reco-mcp" : "") + (isSkill ? " dpi-reco-skill" : ""), key: "reco" + i },
							h("div", { className: "dpi-reco-head" },
								h("b", null, item.displayName || item.name),
								h("span", { className: "dpi-tag" }, item.source || "?"),
								isMcp ? h("span", { className: "dpi-tag dpi-tag-kind" }, "MCP 服务器") : null,
								isSkill ? h("span", { className: "dpi-tag dpi-tag-kind" }, "Skill") : null,
								isSkill && item.subdir ? h("span", { className: "dpi-tag", title: item.treeUrl || "" }, item.subdir) : null,
								isSkill && item.installable === false ? h("span", { className: "dpi-tag dpi-tag-medium" }, "SKILL.md 不合法") : null,
								isMcp && item.transport ? h("span", { className: "dpi-tag" }, item.transport) : null,
								isMcp && item.installable === false ? h("span", { className: "dpi-tag dpi-tag-medium" }, "需先填参数") : null,
								item.installedKnown ? h("span", {
									className: "dpi-tag dpi-tag-kind",
									title: isMcp
										? "profile 组合文件里已经有这台服务器（serverName=" + (item.serverName || item.installed) + "）"
										: isSkill
											? "技能根里已经有同名目录（重复安装会覆盖；重装请到「已装 Skill」里按来源重装，那里有本地改动保护）"
											: "本机已装这个包" + (item.installedSpec ? "（" + item.installedSpec + "）" : "") +
											(item.installedSource === "different" ? " —— 同名但来源不同，见下面的红旗" : "")
								}, isMcp ? "已配置" : "已装" + (item.installed ? " v" + item.installed : "") +
									(item.installedKindLabel ? " · " + item.installedKindLabel : "")) : null,
								item.stars ? h("span", { className: "dpi-tag" }, "★" + item.stars) : null,
								item.downloads ? h("span", { className: "dpi-tag" }, "⬇" + item.downloads + "/周") : null),
							/* 可信度徽章与红旗（R3）：官方 / 许可证 / 有源码 / 近期更新，以及无仓库、刷星这类红旗。
							   这些都来自确定性数据，不来自模型，可以当事实读。 */
							item.trust && item.trust.badges && item.trust.badges.length
								? h("div", { className: "dpi-badges" }, item.trust.badges.map((b, bi) =>
									h("span", { key: "bd" + bi, className: "dpi-tag dpi-tag-" + (b.tone === "ok" ? "kind" : "medium"), title: b.why || "" }, b.label)))
								: null,
							item.trust && item.trust.flags && item.trust.flags.length
								? h("div", { className: "dpi-flags" }, item.trust.flags.map((f, fi) =>
									h("div", { key: "fl" + fi, className: "dpi-flag is-" + (f.tone || "warn") }, "⚠ " + f.text)))
								: null,
							item.why ? h("div", { className: "dpi-reco-why" }, item.why) : null,
							/* R36：MCP 的「下载路径」直接摆出来 —— 是 npx 命令还是远程 URL，
							   以及它会被写进哪里。不能一键装时给可复制的组合片段。 */
							mcpRecoDetails(item),
							h("div", { className: "dpi-actions dpi-actions-tight" },
								recoActions(item, isMcp),
								item.url ? h("a", { className: "dpi-link", href: item.url, target: "_blank", rel: "noreferrer" }, "看来源") : null)
						);
							}),
							customRow]
						: [customRow]),
				result && result.searchSuggestions && result.searchSuggestions.length ? h("div", { className: "dpi-muted" }, "换个搜索词：" + result.searchSuggestions.join("、")) : null,
				result && result.degraded ? h("div", { className: "dpi-muted" }, "（AI 不可用，这里给的是确定性搜索的结果）") : null
			);
		}

		/**
		 * 一条历史行里能说得出口的「次要事实」：版本怎么变、为什么失败、诊断结论。
		 * R30 之前这些都埋在展开后的详情里 —— 只装过一次的人不需要展开，只想一眼看出「上次怎么挂的」。
		 * 只留最有判别力的两条：版本跨度 + 失败原因（或诊断结论）。再多就变成噪音。
		 */
		function historyMeta(job) {
			const parts = [];
			const before = job.installedBefore && job.installedBefore.version;
			const target = job.detected && job.detected.version;
			/* 失败原因优先：它通常自带版本跨度（「…（0.5.0 → 0.5.1）」），再补一个 vX 就是同一件事说两遍。 */
			if (job.error && job.error.message) {
				const msg = String(job.error.message).replace(/\s+/g, " ").trim();
				parts.push(msg.slice(0, 58) + (msg.length > 58 ? "…" : ""));
			} else if (before && target && String(before) !== String(target)) {
				parts.push(before + " → " + target);
			} else if (target) {
				parts.push("v" + target);
			}
			if (!job.error && job.diagnosis && job.diagnosis.verdict && job.diagnosis.verdict !== "ok") {
				parts.push("诊断 " + job.diagnosis.verdict);
			}
			return parts;
		}

		function History(props) {
			const s = useStore();
			const [openId, setOpenId] = useState(null);
			/* R30：「清理」是两段式 —— 第一下只是把按钮变成「确认清理？」，4 秒内不再点就自己收回。
			   清掉的是**已结束**的历史（进行中与等待确认的保留，判据在 lib/pipeline.js）。 */
			const [confirmClear, setConfirmClear] = useState(false);
			const jobs = (s.data && s.data.jobs) || [];
			const activeId = s.data && s.data.active ? s.data.active.id : null;
			const limit = currentSettings().historyLimit;
			const all = jobs.filter((job) => job.id !== activeId);
			const past = all.slice(0, limit);
			useEffect(() => {
				if (!confirmClear) return undefined;
				const timer = setTimeout(() => setConfirmClear(false), 4000);
				return () => clearTimeout(timer);
			}, [confirmClear]);
			const clearHistory = () => {
				if (!confirmClear) {
					setConfirmClear(true);
					return;
				}
				setConfirmClear(false);
				api("/action", { method: "POST", body: JSON.stringify({ action: "clear-history" }) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						if (!r || r.ok === false) return toast((r && r.error) || "清理失败");
						toast("已清理 " + ((r.cleared && r.cleared.removed) || 0) + " 条历史");
					})
					.catch((e) => toast("清理失败：" + String((e && e.message) || e)));
			};
			/* 一条都没有：公开之后第一次打开看到的就是这里 —— 给一句「怎么开始」，而不是一片空白 */
			if (past.length === 0) {
				if (jobs.length > 0) return null;
				return h(
					"div",
					{ className: "dpi-card dpi-history-card" },
					h("div", { className: "dpi-card-head" },
						h("strong", null, "历史"),
						h("span", { className: "dpi-count" }, "0 条")),
					h("div", { className: "dpi-empty" },
						h("b", null, "还没有安装记录"),
						h("span", null, "把 GitHub 链接、.tgz 直链或包名粘到上面的输入框，回车就开始。装完这一条会留在这里；失败也能一键回滚到安装前。")));
			}
			return h(
				"div",
				{ className: "dpi-card dpi-history-card" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "历史"),
					h("span", { className: "dpi-count" }, past.length + (all.length > past.length ? " / " + all.length : "") + " 条"),
					h("span", { className: "dpi-head-spacer" }),
					h("span", { className: "dpi-muted" }, "点开看每一阶段"),
					h("button", {
						className: "dpi-btn dpi-btn-sm dpi-btn-ghost" + (confirmClear ? " dpi-btn-confirm" : ""),
						title: "清掉已结束的历史（进行中与等待确认的会保留）",
						onClick: clearHistory
					}, confirmClear ? "确认清理？" : "清理")),
				h("div", { className: "dpi-history" },
					past.map((job) => {
						const open = openId === job.id;
						const meta = historyMeta(job);
						return h(
							"div",
							{ key: job.id, className: "dpi-history-item" },
							h("button", {
								className: "dpi-history-row" + (open ? " is-open" : ""),
								onClick: () => setOpenId(open ? null : job.id)
							},
								h("span", { className: "dpi-status is-" + job.status }, STATUS_TEXT[job.status] || job.status),
								h("span", { className: "dpi-hist-main" },
									h("span", { className: "dpi-history-title" }, job.title || (job.input && job.input.raw) || job.id),
									meta.length > 0
										? h("span", { className: "dpi-hist-meta", title: meta.join(" · ") }, meta.join(" · "))
										: null),
								h("span", { className: "dpi-hist-right" },
									h("span", { className: "dpi-hist-when" }, ago(job.updatedAt || job.createdAt)),
									h("span", { className: "dpi-chev" + (open ? " is-open" : "") }, h(Glyph, { name: "chevron", size: 11 })))),
							open ? h("div", { className: "dpi-hist-detail" }, h(JobDetail, { job, hideHead: true })) : null);
					})
				)
			);
		}

		/* ── 已装清单 + 检查更新（R12）────────────────────────────────────
		 * 面板以前只会**装**：想升级一个已装插件，得自己记得名字、再搜一次、再提交一次；
		 * 「哪些落后了」这个问题从来没被回答过。这块补的就是这个视角。
		 *
		 * 数据：GET /inventory（宿主**本地读** profile，30 秒缓存，不联网）；
		 * R37 起联网检查只有主面板「插件与 MCP 更新」一个入口（action:check-all-updates），
		 * 这张卡只显示结果，不再自己发请求。
		 * 判据在 lib/inventory.js + lib/updates.js —— link: / file: / git 这三类**不参与**比对，
		 * 它们没有「registry 上的新版本」，硬比会产出假的「落后」。 */
		function Inventory({ inWindow } = {}) {
			const s = useStore();
			const inv = s.local.inventory || null;
			/* R36：主面板里不再挂这张卡；浮窗里默认展开，且在浮窗里没有「收起」按钮。 */
			const [open, setOpen] = useState(Boolean(inWindow));
			const isOpen = Boolean(inWindow) || open;
			/* R26：80 条上限原本是静默截断 —— 本机 47 条时看不出来，插件多了以后会「有更新却找不到」 */
			const [showAll, setShowAll] = useState(false);
			const queue = (s.data && s.data.queue) || null;
			/* R27：换版本要「插件目录」配合卸载 —— 不在就没法升级（宿主按包名判已装） */
			const collab = (s.data && s.data.collaborator) || null;
			const collabOk = Boolean(collab && collab.ok);
			useEffect(() => {
				if (!s.local.inventory && !s.local.invBusy) loadInventory();
			}, []);
			const counts = (inv && inv.counts) || null;
			const summary = (inv && inv.summary) || null;
			const items = (inv && inv.items) || [];
			const problems = (inv && inv.problems) || [];
			const outdated = items.filter((item) => item.update && item.update.relation === "outdated");
			/* R26：批量升级 —— 串行排队、一次一单；只升 npm 来源（本地 .tgz 要重新打包，排不了队）。
			   队列是宿主内存态：重启后不续跑，避免一开机就在没人看着的时候装东西。
			   R26.1：跨越较大的版本（主版本 / 0.x 小版本）先不排，弹第二次确认再决定。 */
			const upgradeAll = (includeRisky) => {
				const targets = sorted.filter((item) => item.update && item.update.relation === "outdated");
				if (!targets.length) return;
				if (!collabOk) {
					toast("批量升级需要「插件目录」卸载旧版 —— " + ((collab && collab.reason) || "它当前不可用"));
					return;
				}
				if (includeRisky !== true) {
					const ok = typeof window !== "undefined" && window.confirm
						? window.confirm("把可升级的 " + targets.length + " 个 npm 包排进队列，逐个换版本？\n\n" +
							"· 每个都是「先卸载旧版（由「插件目录」执行并复核）→ 再装新版」\n" +
							"· 卸载到装回之间，那个插件不可用；新版本要下次启动 DSH 才加载\n" +
							"· 装失败会自动尝试装回旧版\n" +
							"· 每个都会先做安全预检与安装前快照；需要确认的会停下来等你\n" +
							"· 宿主重启后队列不自动续跑\n" +
							"· 跨大版本 / 0.x 小版本的会单独再问你一次\n" +
							"· 本地 .tgz / Git / link 来源不排队（需要时按单条「升级」走）")
						: true;
					if (!ok) return;
				}
				setLocal({ invBusy: true });
				api("/action", { method: "POST", body: JSON.stringify({ action: "update-all", includeRisky: includeRisky === true }) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						if (!r || r.ok === false) {
							toast((r && r.error) || "排队失败");
							return;
						}
						const n = (r.queued || []).length;
						const risky = (r.needsAttention || []);
						const startedInfo = r.started || null;
						/* R27：一单已经装完不会再自动开下一单（busy / awaiting-confirm / empty）——
						   以前一律说「第一个已开始」，而宿主可能根本没开始（独立审计的 P1-5）。 */
						const startNote = startedInfo && startedInfo.started
							? "第一个已开始"
							: startedInfo && startedInfo.reason
								? "第一个没有开始（" + ({ busy: "已有任务在跑", "awaiting-confirm": "有一单在等你确认", empty: "队列是空的" }[startedInfo.reason] || startedInfo.reason) + "）"
								: "排队完成";
						if (risky.length > 0) {
							/* 第二次确认：只把「跨越较大的版本」摆出来，让人明确知道要跨过什么 */
							const list = risky.slice(0, 5).map((x) => "· " + x.name + " " + (x.from || "?") + " → " + x.to + (x.gap ? "（" + x.gap + "）" : "")).join("\n");
							const go = typeof window !== "undefined" && window.confirm
								? window.confirm("已把 " + n + " 个常规升级排进队列。\n\n另有 " + risky.length +
									" 个跨越较大的版本（可能含破坏性变更）：\n" + list +
									(risky.length > 5 ? "\n· …等 " + risky.length + " 个" : "") +
									"\n\n仍要一起升级吗？点「取消」就只装前面那些。")
								: false;
							if (go) {
								upgradeAll(true);
								return;
							}
							toast("已排队 " + n + " 个；跨版本的 " + risky.length + " 个没有排");
							return;
						}
						toast(n > 0
							? "已排队 " + n + " 个（" + startNote + "，后面的自动接着跑）"
							: (includeRisky === true ? "没有可排队的升级" : "没有可排队的升级（跨版本的需单独确认）"));
					})
					.catch((e) => toast("排队失败：" + String((e && e.message) || e)))
					.finally(() => setLocal({ invBusy: false }));
			};
			const clearQueue = () => {
				api("/action", { method: "POST", body: JSON.stringify({ action: "clear-queue" }) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						toast(r && r.cleared ? "已清空队列（" + r.cleared + " 个）" : "队列本来就是空的");
					})
					.catch((e) => toast("清空失败：" + String((e && e.message) || e)));
			};
			const rank = (item) => {
				if (item.update && item.update.relation === "outdated") return 0;
				if (!item.installed) return 1;
				if (item.update && item.update.error) return 2;
				return 3;
			};
			const sorted = items.slice().sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			const headline = inv && inv.ok === false
				? "读不到：" + (inv.error || inv.note || "未知原因")
				: counts
					? counts.total + " 个依赖 · " + counts.bundle + " 个在 bundle 行里"
					: "读取中…";
			return h(
				"div",
				{ className: "dpi-card dpi-inventory" + (inWindow ? " dpi-in-window" : "") },
				h("div", { className: "dpi-card-head" },
					/* 浮窗标题由 FloatWindow 负责，卡里不再重复一遍「已装插件」 */
					inWindow ? null : h("strong", null, "已装插件"),
					h("span", { className: "dpi-muted" }, headline),
					/* R36/R37：「检查更新」「全部升级」已搬到主面板的 UpdateBar（清单收进浮窗后，
					   这两个动作不能跟着一起藏起来；R37 起面板上只有那一个检查入口）。这里只留窗口内自己的「展开/收起」。 */
					inWindow
						? null
						: h("button", { className: "dpi-btn dpi-btn-sm", style: { marginLeft: "auto" }, disabled: !counts, onClick: () => setOpen(!open) },
							open ? "收起" : "展开")),
				summary
					? h("div", { className: "dpi-muted" },
						"更新：" + (summary.outdated > 0 ? "可升级 " + summary.outdated + " 个" : "都是最新的") +
						"（比对 " + summary.checked + " · 最新 " + summary.current +
						(summary.ahead ? " · 比 registry 新 " + summary.ahead : "") +
						(summary.failed ? " · 查不到 " + summary.failed : "") + "）" +
						(inv && inv.updatesAt ? " · " + ago(inv.updatesAt) : ""))
					: h("div", { className: "dpi-muted" },
						inv && inv.ok === false
							? ""
							: "还没比对过最新版。点主面板「插件与 MCP 更新」的「检查更新」才联网（只查 npm 来源的包；本机目录 / 本面板装的 .tgz / Git 来源不参与）。"),
				problems.length > 0 && !isOpen
					? h("div", { className: "dpi-muted" }, "· " + problems.length + " 个依赖「声明了但没落地」（展开看，或用环境体检细查）")
					: null,
				/* R27：换版本的卸载协作方（插件目录）—— 它决定了「升级」可不可点。
				   说清"为什么不可用 / 怎么解决"，而不是把按钮灰掉就完事。 */
				collab
					? h("div", { className: "dpi-muted", style: collabOk ? null : { color: "var(--dsw-alias-state-warning-primary)" } },
						h("span", null, collab.line || (collabOk ? "卸载协作：可用" : "卸载协作：不可用")),
						collabOk
							? null
							: h("span", null, " —— " + (collab.reason || "原因未知") +
								(collab.fix && collab.fix.length > 0 ? "；" + collab.fix[0].text : "")))
					: null,
				queue && queue.count > 0
					? h("div", { className: "dpi-muted" },
						"队列：" + queue.count + " 个待装（" + queue.items.slice(0, 3).map((q) => q.name || q.raw).join("、") +
						(queue.count > 3 ? " 等" : "") + "）· 一次装一个，装完自动继续",
						h("button", { className: "dpi-btn dpi-btn-sm", style: { marginLeft: "8px" }, onClick: clearQueue }, "清空队列"))
					: null,
				outdated.length > 0
					? h("div", { className: "dpi-muted" },
						collabOk
							? "升级 = 先卸载旧版（由「插件目录」执行并复核依赖行）→ 再装新版。宿主按包名判已装，所以不能原地换版本；新版本要重启 DSH 才加载。"
							: "⚠ 这批升级暂时做不了：宿主按包名判已装，换版本必须先卸载，而卸载要「插件目录」配合 —— 它当前不可用（见上一行）。")
					: null,
				inv && inv.ok === false
					? h("div", { className: "dpi-actions dpi-actions-tight" },
						h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => loadInventory(true) }, "重试"))
					: null,
				isOpen && sorted.length > 0
					? h("ul", { className: "dpi-list dpi-list-info dpi-inv-list" }, sorted.slice(0, showAll ? sorted.length : 80).map((item) =>
						h("li", { key: "inv" + item.name },
							h("div", { className: "dpi-reco-head" },
								h("b", null, item.name),
								h("span", { className: "dpi-muted" }, "v" + (item.localVersion || "?")),
								h("span", { className: "dpi-tag", title: item.why }, item.kindLabel),
								item.bundle ? h("span", { className: "dpi-tag dpi-tag-kind" }, "bundle 行") : null,
								item.update && item.update.relation === "outdated"
									? h("span", { className: "dpi-pill dpi-pill-warn" }, "可升级 → " + item.update.latestVersion)
									: null,
								/* R26：只给两个版本号看不出「跨了 9 个补丁」还是「跨了一个大版本」；
								   0.x 的 minor 变化按 npm 惯例可能是破坏性变更，单独染色但仍不拦安装 */
								item.update && item.update.relation === "outdated" && item.update.gap && item.update.gap.text
									? h("span", {
										className: item.update.gap.severe ? "dpi-tag dpi-tag-medium" : "dpi-tag",
										title: (item.update.localVersion || "?") + " → " + item.update.latestVersion + (item.update.gap.severe ? "（这个跨度可能含破坏性变更）" : "")
									}, item.update.gap.text)
									: null,
								item.update && item.update.relation === "current"
									? h("span", { className: "dpi-pill dpi-pill-ok" }, "最新")
									: null,
								item.update && item.update.relation === "ahead"
									? h("span", { className: "dpi-pill dpi-pill-idle", title: "本机版本比 registry 上的 latest 还新（本地开发/预发布常见）" }, "比 registry 新")
									: null,
								item.update && item.update.error
									? h("span", { className: "dpi-tag dpi-tag-medium", title: item.update.error }, "查不到最新版")
									: null,
								item.update && item.update.deprecated
									? h("span", { className: "dpi-tag dpi-tag-high", title: item.update.deprecated }, "已弃用")
									: null,
								!item.installed ? h("span", { className: "dpi-tag dpi-tag-high" }, "声明了但没落地") : null),
							item.update && item.update.relation === "outdated"
								? h("div", { className: "dpi-actions dpi-actions-tight" },
									collabOk
										? h("button", {
											className: "dpi-btn dpi-btn-primary dpi-btn-sm",
											title: "会先卸载 v" + (item.localVersion || "?") + "（由「插件目录」执行并复核）再装 v" + item.update.latestVersion +
												"；确认后才会动手，装失败会尝试装回旧版",
											onClick: () => submitInput("npm:" + (item.registryName || item.name) + "@" + item.update.latestVersion)
										}, "升级到 " + item.update.latestVersion)
										: h("span", { className: "dpi-muted", title: (collab && collab.reason) || "" }, "需要「插件目录」才能升级"))
								: null,
							h("div", { className: "dpi-detail" }, item.spec + (item.checkable ? "" : " · " + item.why)))))
					: null,
				isOpen && sorted.length > 80
					? h("div", { className: "dpi-muted" },
						"只显示前 80 个（共 " + sorted.length + " 个）。按「有更新 → 没落地 → 其它」排序，所以可升级的不会被折叠掉。",
						showAll
							? null
							: h("button", { className: "dpi-btn dpi-btn-sm", style: { marginLeft: "8px" }, onClick: () => setShowAll(true) }, "显示全部"))
					: null,
				isOpen && sorted.length === 0
					? h("div", { className: "dpi-muted" }, "这个 profile 里没有依赖声明（或还没装上任何东西）。")
					: null
			);
		}

		/* ── 已装 Skill（R14）────────────────────────────────────────────
		 * 面板标题写着「插件 / Skill 安装」，但过去只回答插件那一半：装了哪些技能、
		 * 宿主认不认、名字有没有撞车，全都没有入口。而「装了却从不被自动调用」的根因
		 * 恰恰是这些 —— 看不见就只能靠猜。
		 *
		 * 数据：GET /skills（宿主本地读技能根 + ctx.skills.list() 对账，30 秒缓存，不联网）。
		 * 判据在 lib/skills.js：磁盘有而宿主没认 / 同名 / 备份残留 / modelInvocable=false。 */
		function Skills({ inWindow } = {}) {
			const s = useStore();
			const view = s.local.skills || null;
			const [open, setOpen] = useState(Boolean(inWindow));
			const isOpen = Boolean(inWindow) || open;
			/* 待确认「移出」的备份目录名（R15）。两段式是刻意的：动文件前先说清后果。 */
			const [parking, setParking] = useState(null);
			/* 待确认「修 frontmatter」的目录名（R16）：先备份原文再改，同样两段式。 */
			const [fixing, setFixing] = useState(null);
			/* R38：待确认「按来源重装」的目录。第一次点只展开后果；宿主发现本地改过时
			   会再拒绝一次，这里换成「确认覆盖」的第二段（绝不因为面板看到的是旧状态就覆盖掉新改动）。 */
			const [reinstall, setReinstall] = useState(null);
			const fix = (dir) => {
				setLocal({ skillsBusy: true });
				api("/action", { method: "POST", body: JSON.stringify({ action: "fix-skill-frontmatter", dir }) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						if (!r || r.ok === false) {
							toast((r && r.error) || "修不了");
							return;
						}
						if (r.skills) setLocal({ skills: r.skills });
						setFixing(null);
						toast("已修好：" + dir + "（原文备份在 data/skill-fixes）");
					})
					.catch((e) => toast("修不了：" + String((e && e.message) || e)))
					.finally(() => setLocal({ skillsBusy: false }));
			};
			const park = (dir) => {
				setLocal({ skillsBusy: true });
				api("/action", { method: "POST", body: JSON.stringify({ action: "park-skill-backup", dir }) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						if (!r || r.ok === false) {
							toast((r && r.error) || "移不动");
							return;
						}
						if (r.skills) setLocal({ skills: r.skills });
						setParking(null);
						toast("已移出技能根：" + dir);
					})
					.catch((e) => toast("移不动：" + String((e && e.message) || e)))
					.finally(() => setLocal({ skillsBusy: false }));
			};
			const load = (force) => loadSkills(force);
			/* R38：按来源重装（两段式确认；宿主判据才是权威 —— 它说「本地改过」就再确认一次）。 */
			const doReinstall = (row, forceEdited) => {
				setLocal({ skillsBusy: true });
				api("/action", { method: "POST", body: JSON.stringify({
					action: "reinstall-skill",
					name: row.dir,
					confirm: true,
					confirmEdited: forceEdited === true || row.locallyEdited === true
				}) })
					.then((r) => {
						if (r && r.state) setStore({ data: r.state });
						if (!r || r.ok === false) {
							if (r && r.reason === "locally-edited") {
								/* 面板打开之后本地又改过：宿主拒绝。换成更明确的第二段确认。 */
								setReinstall({ dir: row.dir, force: true, message: r.message || "" });
								return;
							}
							toast((r && r.error) || "重装失败");
							return;
						}
						setReinstall(null);
						toast("已提交重装任务：重新下载来源并覆盖这个技能（看上面的进度）");
					})
					.catch((e) => toast("重装失败：" + String((e && e.message) || e)))
					.finally(() => setLocal({ skillsBusy: false }));
			};
			useEffect(() => {
				if (!s.local.skills && !s.local.skillsBusy) loadSkills();
			}, []);
			const counts = (view && view.counts) || null;
			const items = (view && view.items) || [];
			const hostOnly = (view && view.hostOnly) || [];
			const summary = (view && view.summary) || "";
			const hostKnown = Boolean(view && view.host && view.host.available);
			const headline = view && view.ok === false
				? "读不到：" + (view.error || view.note || "未知原因")
				: counts
					? counts.skills + " 个技能 · 宿主认 " + (hostKnown ? counts.hostTotal + " 个" : "?")
					: "读取中…";
			/* 摘要那一行与状态工具/体检共用同一句话，但标题已经说了规模 ——
			   这里把开头那一段剥掉，否则卡上会出现两遍「55 个技能 · 宿主认 64 个」。 */
			const detail = summary.replace(/^\d+ 个技能(?: · (?:宿主认 \d+ 个|宿主清单读不到))?/, "").replace(/^ · /, "");
			const tag = (cls, text, title) => h("span", { className: "dpi-tag " + cls, title: title || null }, text);
			return h("div", { className: "dpi-card dpi-skills" + (inWindow ? " dpi-in-window" : "") },
				h("div", { className: "dpi-card-head" },
					inWindow ? null : h("strong", null, "已装 Skill"),
					h("span", { className: "dpi-muted" }, headline),
					h("button", {
						className: "dpi-btn dpi-btn-sm",
						style: { marginLeft: "auto" },
						disabled: Boolean(s.local.skillsBusy),
						title: "重扫技能根并重新对账（宿主会自己重扫目录；不重启也能看到新增的技能）",
						onClick: () => loadSkills(true)
					}, s.local.skillsBusy ? "刷新中…" : "刷新"),
					inWindow
						? null
						: h("button", { className: "dpi-btn dpi-btn-sm", disabled: !counts, onClick: () => setOpen(!open) }, open ? "收起" : "展开")),
				detail ? h("div", { className: "dpi-muted" }, detail) : null,
				h("div", { className: "dpi-muted" },
					counts && counts.tracked > 0
						? "来源台账：" + counts.tracked + " 个技能有来源记录（可查更新 / 可重装），" + counts.untracked + " 个没有记录（存量技能补不回来）。更新检查在主面板「检查更新」里一起跑。"
						: "来源台账：还没有技能有来源记录（存量技能补不回来）。今后从 GitHub 仓库装的技能会记下来源与 commit；更新检查在主面板「检查更新」里一起跑。"),
				view && view.updates && view.updates.summary
					? h("div", { className: "dpi-muted" },
						view.updates.summary.tracked === 0
							? "更新：没有可比的来源（0 个技能有来源记录），不能判断有没有更新"
							: "更新：" + (view.updates.summary.outdated > 0 ? "可升级 " + view.updates.summary.outdated + " 个" : "都跟来源一致") +
								"（已跟踪 " + view.updates.summary.tracked + " · 无法判断 " + view.updates.summary.unknown +
								(view.updates.summary.locallyEdited ? " · 本地改过 " + view.updates.summary.locallyEdited : "") +
								(view.updates.at ? " · " + ago(view.updates.at) : "") + "）")
					: null,
				view && view.notes && view.notes.length > 0
					? h("div", { className: "dpi-muted" }, view.notes.join(" · "))
					: null,
				counts && counts.yamlBroken > 0
					? h("div", { className: "dpi-muted", style: { color: "var(--dsw-alias-state-error-primary)" } },
						"⚠ " + counts.yamlBroken + " 个技能的 frontmatter 不是合法 YAML —— 宿主读不出 name，整条被跳过（展开看改法）")
					: null,
				counts && counts.notVisible > 0
					? h("div", { className: "dpi-muted", style: { color: "var(--dsw-alias-state-error-primary)" } },
						"⚠ " + counts.notVisible + " 个技能宿主没认 —— 文件在，但用不上（展开看是哪些）")
					: null,
				/* R26：磁盘之外的那批（插件包内置 / 宿主自带）。不写这一句，人会以为
				   「55 + 12 = 67」全是自己装的，然后去技能根里找一个根本不存在的目录。
				   R30：这一行原本是一段两行的长句（点名 8 个 + 来源），公开版里读起来像调试输出 ——
				   收进 details，默认只留一句「另有 N 个」，展开才是名单。 */
				counts && counts.hostOnly > 0
					? h("details", { className: "dpi-hostonly" },
						h("summary", null, "另有 " + counts.hostOnly + " 个来自插件包/内置（不在技能根，所以这里删不掉）"),
						hostOnly.length > 0
							? h("div", { className: "dpi-hostonly-list" },
								hostOnly.slice(0, 24).map((entry, hi) =>
									h("span", { key: "ho" + hi, className: "dpi-tag", title: entry.source ? "来源：" + entry.source : null },
										entry.name + (entry.source ? " ← " + entry.source : ""))),
								counts.hostOnly > 24 ? h("span", { className: "dpi-muted" }, "等 " + counts.hostOnly + " 个") : null)
							: null)
					: null,
				view && view.ok === false
					? h("div", { className: "dpi-actions dpi-actions-tight" },
						h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => loadSkills(true) }, "重试"))
					: null,
				isOpen && items.length > 0
					? h("ul", { className: "dpi-list dpi-list-info" }, items.slice(0, 120).map((row) =>
						h("li", { key: "sk" + row.dir },
							h("div", { className: "dpi-reco-head" },
								h("b", null, row.name || row.dir),
								row.backup ? tag("dpi-tag-medium", "备份残留", "覆盖安装时留下的旧副本；它的 frontmatter 名字与正式那份相同") : null,
								row.yamlIssue ? tag("dpi-tag-high", "frontmatter 写坏了", row.yamlIssue.message) : null,
								!row.hasFile ? tag("dpi-tag-high", "没有 SKILL.md", (row.reasons || []).join("；")) : null,
								row.hasFile && !row.valid ? tag("dpi-tag-high", "frontmatter 不完整", (row.reasons || []).join("；")) : null,
								row.hasFile && row.valid && hostKnown && !row.hostVisible && !row.yamlIssue ? tag("dpi-tag-high", "宿主没认", "磁盘上有，但宿主技能清单里没有它") : null,
								row.hostVisible && row.modelInvocable === false ? tag("dpi-tag-medium", "不会自动调用", "宿主把它标成 modelInvocable=false；最常见的原因是 SKILL.md 里写了 disable-model-invocation: true") : null,
								/* 备份行不标来源：宿主认的是同名的那份正式技能，不是这个目录 —— 标上去会误导 */
								row.sourceLabel && !row.backup ? tag("dpi-tag", row.sourceLabel) : null,
								/* R38：安装时记下的来源（GitHub owner/repo@commit + 仓库内路径） */
								row.tracked && !row.backup ? tag("dpi-tag", row.ledgerSource || "已记来源", "安装时记下的来源；更新检查按这个仓库 / 路径比") : null,
								row.locallyEdited && !row.backup ? tag("dpi-tag-medium", "本地改过", "装完之后目录被改过；按来源重装会覆盖这些改动") : null,
								row.update && row.update.relation === "outdated"
									? h("span", {
										className: "dpi-pill dpi-pill-warn",
										title: "来源 " + String(row.update.localCommit || "?").slice(0, 8) + " → " + String(row.update.latestCommit || "?").slice(0, 8) +
											(row.locallyEdited ? "；本地也改过，重装会覆盖" : "")
									}, "可升级 → " + String(row.update.latestCommit || "").slice(0, 7))
									: null,
								row.update && row.update.relation === "current" ? h("span", { className: "dpi-pill dpi-pill-ok" }, "最新") : null,
								row.update && row.update.relation === "unknown" ? tag("dpi-tag", "无法判断", row.update.reason || row.update.error || "") : null,
								row.installedByPanel ? tag("dpi-tag-kind", "本面板装的") : null),
							h("div", { className: "dpi-skill-desc" }, row.description || (row.reasons && row.reasons[0]) || "（没有描述：模型不会自动挑它）"),
							row.update && (row.update.reason || row.update.error)
								? h("div", { className: "dpi-detail" }, "更新：" + (row.update.error ? "查不到（" + row.update.error + "）" : row.update.reason))
								: null,
							row.yamlIssue
								? h("div", { className: "dpi-detail" }, "改法：" + row.yamlIssue.fix)
								: null,
							/* R16：frontmatter 写坏的行给一个「就地修」入口（两段式，先备份原文）。
							   R21：只对 fixable 的（`: `/` #`）给 —— Tab 缩进/重复键/引号没闭合改写救不了。 */
							row.yamlIssue && row.yamlIssue.fixable !== false
								? fixing === row.dir
									? h("div", { className: "dpi-actions dpi-actions-tight" },
										h("span", { className: "dpi-muted" }, "先备份原文，再把这一行改成块标量（不删任何内容）"),
										h("button", {
											className: "dpi-btn dpi-btn-sm dpi-btn-primary",
											disabled: Boolean(s.local.skillsBusy),
											onClick: () => fix(row.dir)
										}, "我确认修复"),
										h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setFixing(null) }, "取消"))
									: h("div", { className: "dpi-actions dpi-actions-tight" },
										h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setFixing(row.dir) }, "修成块标量…"))
								: null,
							/* R15：备份目录给一个「移出」入口（两段式）。移动不删除，落在 data/parked-skills。 */
							row.backup
								? parking === row.dir
									? h("div", { className: "dpi-actions dpi-actions-tight" },
										h("span", { className: "dpi-muted" }, "移到 data/parked-skills/（不删除，随时能搬回）"),
										h("button", {
											className: "dpi-btn dpi-btn-sm dpi-btn-primary",
											disabled: Boolean(s.local.skillsBusy),
											onClick: () => park(row.dir)
										}, "我确认移出"),
										h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setParking(null) }, "取消"))
									: h("div", { className: "dpi-actions dpi-actions-tight" },
										h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setParking(row.dir) }, "移出技能根…"))
								: null,
							/* R38：台账里有 GitHub 来源的技能才给「按来源重装」（两段式；本地改过会再确认一次）。
							   它不自动升级：覆盖前会进安装前快照，但本地改动仍会丢，必须人说清楚。 */
							row.tracked && !row.backup && row.hasFile
								? reinstall && reinstall.dir === row.dir
									? h("div", { className: "dpi-actions dpi-actions-tight" },
										h("span", { className: "dpi-muted", style: { color: "var(--dsw-alias-state-warning-primary)" } },
											reinstall.force
												? "宿主刚检测到目录与台账不一致（面板打开后又改过），覆盖会丢掉这些改动（装前快照里有旧版）。"
												: "会重新下载来源仓库并覆盖这个目录" + (row.locallyEdited ? "；检测到本地改过，这些改动会被覆盖" : "") + "（装前快照里有旧版）。"),
										h("button", {
											className: "dpi-btn dpi-btn-sm dpi-btn-primary",
											disabled: Boolean(s.local.skillsBusy),
											onClick: () => doReinstall(row, reinstall.force === true)
										}, reinstall.force ? "我确认覆盖" : "我确认重装"),
										h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setReinstall(null) }, "取消"))
									: h("div", { className: "dpi-actions dpi-actions-tight" },
										row.update && row.update.relation === "outdated"
											? h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setReinstall({ dir: row.dir }) }, "按来源更新…")
											: h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setReinstall({ dir: row.dir }) }, "按来源重装…"))
								: null,
							h("div", { className: "dpi-detail" },
								row.dir + (row.bytes ? " · " + Math.max(1, Math.round(row.bytes / 1024)) + " KB" : "") +
								(row.duplicate ? " · 与另一份同名" : "")))))
					: null,
				isOpen && items.length === 0
					? h("div", { className: "dpi-muted" }, "技能根里还没有技能（或者宿主扫不到这个目录）。")
					: null
			);
		}

		/* ── R36：独立更新条 / 清单菜单 / 浮窗 / 已装 MCP ─────────────────── */

		/** 插件更新摘要（更新条与「已装插件」浮窗共用一套措辞）。 */
		function pluginUpdateText(summary, at) {
			const bits = [
				summary.outdated > 0 ? "可升级 " + summary.outdated + " 个" : "都是最新的",
				"比对 " + summary.checked,
				"最新 " + summary.current
			];
			if (summary.ahead) bits.push("比 registry 新 " + summary.ahead);
			if (summary.failed) bits.push("查不到 " + summary.failed);
			return bits.join(" · ") + (at ? " · " + ago(at) : "");
		}

		/** MCP 更新摘要 —— 单独一条，因为 MCP 有「无法判断」这一档（没有版本源）。 */
		function mcpUpdateText(summary, at) {
			if (summary.checked === 0) return "没有可检查的条目（先装一台）";
			const bits = [
				summary.outdated > 0 ? "可升级 " + summary.outdated + " 台" : "都是最新的",
				"比对 " + summary.checked,
				"无法判断 " + (summary.undetectable + summary.failed)
			];
			if (summary.failed) bits.push("其中查不到 " + summary.failed);
			if (at) bits.push(ago(at));
			return bits.join(" · ");
		}

		/** Skill 更新摘要 —— 关键是「没有来源记录」不能写成「都是最新的」（存量技能补不回来）。 */
		function skillUpdateText(summary, at) {
			if (!summary) return "";
			if (summary.skills === 0) return "技能根里还没有技能";
			if (summary.tracked === 0) {
				return "没有来源记录（" + summary.skills + " 个存量技能补不回来；今后从 GitHub 仓库装的才会记）";
			}
			const bits = [
				summary.outdated > 0 ? "可升级 " + summary.outdated + " 个" : "都跟来源一致",
				"已跟踪 " + summary.tracked + "/" + summary.skills,
				"无法判断 " + summary.unknown
			];
			if (summary.locallyEdited) bits.push("本地改过 " + summary.locallyEdited);
			if (at) bits.push(ago(at));
			return bits.join(" · ");
		}

		/**
		 * R37/R38：主面板上**唯一**的更新入口 —— 一次点击同时检查插件、MCP 与 Skill。
		 *
		 * 以前这里是「插件更新」，MCP 的更新检查藏在「已装 MCP」浮窗里；两处都叫
		 * 「检查更新」，用户得记住去哪个窗口查。现在一个按钮、三条链、一份结果。
		 */
		function UpdateBar({ onOpenList } = {}) {
			const s = useStore();
			const inv = s.local.inventory || null;
			const mcp = s.local.mcp || null;
			const mcpUpdates = s.local.mcpUpdates || null;
			const skills = s.local.skills || null;
			const skillUpdates = s.local.skillUpdates || null;
			const counts = (inv && inv.counts) || null;
			const mcpCounts = (mcp && mcp.counts) || null;
			const skillCounts = (skills && skills.counts) || null;
			const summary = (inv && inv.summary) || null;
			const mcpSummary = (mcpUpdates && mcpUpdates.summary) || null;
			const skillSummary = (skillUpdates && skillUpdates.summary) || null;
			const skillError = s.local.skillError || null;
			const items = (inv && inv.items) || [];
			const outdated = items.filter((item) => item.update && item.update.relation === "outdated");
			const busy = Boolean(s.local.invBusy || s.local.mcpBusy);
			const collab = (s.data && s.data.collaborator) || null;
			const collabOk = Boolean(collab && collab.ok);
			useEffect(() => {
				if (!s.local.inventory && !s.local.invBusy) loadInventory();
				/* R37：MCP 的规模也要在这一条里看见 —— 合并之后，这里就是唯一的更新入口。 */
				if (!s.local.mcp && !s.local.mcpBusy) loadMcp();
				/* R38：Skill 台账的覆盖情况同理（本地读，30 秒缓存） */
				if (!s.local.skills && !s.local.skillsBusy) loadSkills();
			}, []);
			const headline = inv && inv.ok === false
				? "读不到：" + (inv.error || inv.note || "未知原因")
				: counts
					? counts.total + " 个依赖 · " + counts.bundle + " 个在 bundle 行里" +
						(mcpCounts ? " · " + mcpCounts.total + " 台 MCP" : "") +
						(skillCounts ? " · " + skillCounts.skills + " 个技能" : "")
					: "读取中…";
			return h("div", { className: "dpi-card dpi-updatebar" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "插件 / MCP / Skill 更新"),
					h("span", { className: "dpi-muted" }, headline),
					h("button", {
						className: "dpi-btn dpi-btn-primary dpi-btn-sm",
						style: { marginLeft: "auto" },
						disabled: busy,
						title: "一次联网比对：npm 上每个插件包的最新版 + MCP（Registry / 锁版本的 npx 包）+ Skill（来源台账里记过 GitHub 坐标的）。30 分钟内同结果走缓存；没有版本源/来源记录的会如实标「无法判断」",
						onClick: runCheckAllUpdates
					}, busy ? "检查中…" : "检查更新"),
					outdated.length > 0
						? h("button", {
							className: "dpi-btn dpi-btn-sm",
							disabled: busy || !collabOk,
							title: collabOk
								? "把可升级的 npm 包排进队列，逐个换版本（每个都是先卸载旧版再由「插件目录」复核；跨大版本的会单独再问你一次）"
								: "需要「插件目录」才能升级：" + ((collab && collab.reason) || "它当前不可用"),
							onClick: () => upgradeAllOutdated(false)
						}, "全部升级 " + outdated.length)
						: null,
					onOpenList
						? h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => onOpenList("plugins") }, "看清单")
						: null),
				summary
					? h("div", { className: "dpi-muted" }, "插件：" + pluginUpdateText(summary, inv && inv.updatesAt))
					: h("div", { className: "dpi-muted" },
						inv && inv.ok === false
							? ""
							: "插件：还没比对过最新版（只查 npm 来源的包；本机目录 / 本面板装的 .tgz / Git 来源不参与）。"),
				mcpSummary
					? h("div", { className: "dpi-muted" }, "MCP：" + mcpUpdateText(mcpSummary, mcpUpdates && mcpUpdates.at))
					: h("div", { className: "dpi-muted" },
						mcp && mcp.ok === false
							? "MCP：读不到 —— " + (mcp.error || "未知原因")
							: mcpCounts && mcpCounts.total > 0
								? "MCP：还没检查过（" + mcpCounts.total + " 台；没有版本源的会如实标「无法判断」）。"
								: "MCP：还没配置（没有条目可比对）。"),
				skillError
					? h("div", { className: "dpi-muted", style: { color: "var(--dsw-alias-state-error-primary)" } }, "Skill：" + skillError)
					: skillSummary
						? h("div", { className: "dpi-muted" }, "Skill：" + skillUpdateText(skillSummary, skillUpdates && skillUpdates.at))
						: h("div", { className: "dpi-muted" },
							skillCounts && skillCounts.tracked > 0
								? "Skill：还没检查过（" + skillCounts.tracked + " 个有来源记录，可查更新；" + skillCounts.untracked + " 个没有记录）。"
								: "Skill：还没检查过" + (skillCounts ? "（" + skillCounts.skills + " 个技能都没有来源记录，存量补不回来）" : "") + "。"),
				outdated.length > 0
					? h("div", { className: "dpi-muted" },
						collabOk
							? "升级 = 先卸载旧版（由「插件目录」执行并复核依赖行）→ 再装新版。宿主按包名判已装，所以不能原地换版本；新版本要重启 DSH 才加载。"
							: "⚠ 这批升级暂时做不了：宿主按包名判已装，换版本必须先卸载，而卸载要「插件目录」配合 —— 它当前不可用。")
					: null
			);
		}

		/**
		 * 右上角「清单」下拉（在「设置」与「刷新」之间）。三个清单都是低频的，
		 * 点哪一项才挂载哪个浮窗 —— 不再常驻占主面板。
		 */
		function ListMenu({ counts, onPick, onOpen } = {}) {
			const [open, setOpen] = useState(false);
			const ref = useRef(null);
			useEffect(() => {
				if (!open) return;
				const onDoc = (event) => {
					if (ref.current && event && event.target && ref.current.contains(event.target)) return;
					setOpen(false);
				};
				document.addEventListener("pointerdown", onDoc);
				return () => document.removeEventListener("pointerdown", onDoc);
			}, [open]);
			const pick = (key) => {
				setOpen(false);
				if (onPick) onPick(key);
			};
			const counts2 = counts || {};
			const rows = [
				["plugins", "已装插件", counts2.plugins],
				["skills", "已装 Skill", counts2.skills],
				["mcp", "已装 MCP", counts2.mcp]
			];
			return h("div", { className: "dpi-menu-wrap", ref },
				h("button", {
					type: "button",
					className: "dpi-btn dpi-btn-ghost dpi-btn-sm",
					"aria-haspopup": "menu",
					"aria-expanded": open ? "true" : "false",
					onClick: () => {
						const next = !open;
						setOpen(next);
						if (next && onOpen) onOpen();
					}
				}, h(Glyph, { name: "list", size: 13 }), "清单",
					h("span", { className: "dpi-chev", style: { transform: open ? "rotate(90deg)" : "none" } }, h(Glyph, { name: "chevron", size: 11 }))),
				open
					? h("div", { className: "dpi-menu", role: "menu" }, rows.map(([key, label, count]) =>
						h("button", { key, type: "button", role: "menuitem", className: "dpi-menu-item", onClick: () => pick(key) },
							h("span", null, label),
							count === null || count === undefined ? null : h("span", { className: "dpi-count" }, count))))
					: null
			);
		}

		/** 浮在界面上的固定窗口：点右上角 X、点周围空白、按 Esc 都关。 */
		function FloatWindow({ title, subtitle, onClose, children } = {}) {
			useEffect(() => {
				const onKey = (event) => {
					if (event && event.key === "Escape" && onClose) onClose();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [onClose]);
			return h("div", { className: "dpi-overlay dpi-float-overlay", role: "presentation", onClick: onClose },
				h("div", {
					className: "dpi-float",
					role: "dialog",
					"aria-label": title,
					onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); }
				},
					h("div", { className: "dpi-float-head" },
						h("div", { className: "dpi-float-title" },
							h("strong", null, title || "清单"),
							subtitle ? h("div", { className: "dpi-muted" }, subtitle) : null),
						h("button", { type: "button", className: "dpi-float-x", title: "关闭（Esc）", "aria-label": "关闭", onClick: onClose },
							h(Glyph, { name: "x", size: 15 }))),
					h("div", { className: "dpi-float-body" }, children)));
		}

		/**
		 * R36：已装 MCP —— 读的是 profile 组合文件里的 dsh-mcp-client 条目，
		 * 并用「工具表里有没有 mcp__<server>__*」判断它到底跑没跑。
		 *
		 * R37：这里**不再单独联网检查更新** —— 主面板的「检查更新」一次查完插件和 MCP，
		 * 这个浮窗只显示同一份结果；「刷新」仍然只读本地组合文件。
		 */
		/** R36：MCP 行上的更新标记（可升级 / 最新 / 无法判断）。 */
		function mcpUpdateTag(item, updates) {
			const up = ((updates && updates.items) || []).find((entry) => entry.serverName === item.serverName);
			if (!up) return null;
			if (up.relation === "outdated") {
				return h("span", { className: "dpi-pill dpi-pill-warn", title: "来源版本 " + (up.localVersion || "?") + " → " + (up.latestVersion || "?") + (up.gap && up.gap.text ? "（" + up.gap.text + "）" : "") },
					"可升级 → " + (up.latestVersion || "?"));
			}
			if (up.relation === "current") return h("span", { className: "dpi-pill dpi-pill-ok" }, "最新");
			if (up.relation === "ahead") return h("span", { className: "dpi-pill dpi-pill-idle" }, "比来源新");
			if (up.error) return h("span", { className: "dpi-tag dpi-tag-medium", title: up.error }, "查不到");
			return h("span", { className: "dpi-tag", title: up.reason || "" }, "无法判断");
		}

		function mcpUpdateDetail(item, updates) {
			const up = ((updates && updates.items) || []).find((entry) => entry.serverName === item.serverName);
			if (!up) return null;
			const text = up.error ? "更新检查失败：" + up.error : up.reason || "";
			return text ? h("div", { className: "dpi-detail" }, text) : null;
		}

		function McpList({ inWindow } = {}) {
			const s = useStore();
			const view = s.local.mcp || null;
			const updates = s.local.mcpUpdates || null;
			const busy = s.local.mcpBusy;
			useEffect(() => {
				if (!s.local.mcp && !s.local.mcpBusy) loadMcp();
			}, []);
			const counts = (view && view.counts) || null;
			const items = (view && view.items) || [];
			const summary = (updates && updates.summary) || null;
			const updateOf = (serverName) => ((updates && updates.items) || []).find((entry) => entry.serverName === serverName) || null;
			const headline = view && view.ok === false
				? "读不到：" + (view.error || "未知原因")
				: counts
					? counts.total + " 台 · " + counts.running + " 台在跑"
					: "读取中…";
			return h("div", { className: "dpi-card dpi-mcp" + (inWindow ? " dpi-in-window" : "") },
				h("div", { className: "dpi-card-head" },
					inWindow ? null : h("strong", null, "已装 MCP"),
					h("span", { className: "dpi-muted" }, headline),
					h("button", {
						className: "dpi-btn dpi-btn-sm",
						style: { marginLeft: "auto" },
						disabled: busy,
						title: "重新读 profile 的两份组合文件（本地，不联网）",
						onClick: () => loadMcp(true)
					}, busy ? "刷新中…" : "刷新")),
				h("div", { className: "dpi-muted" },
					"更新检查在主面板「插件与 MCP 更新」里一起查 —— 这里只显示同一份结果，不再单独联网。"),
				summary
					? h("div", { className: "dpi-muted" }, "更新：" + mcpUpdateText(summary, updates && updates.at))
					: h("div", { className: "dpi-muted" },
						"还没检查过 MCP 更新。主面板的「检查更新」会一次查完插件和 MCP；MCP 没有统一的版本源：面板从 Registry 装的会记版本，手工 npx 未锁版本 / 远程端点只能标「无法判断」。"),
				h("div", { className: "dpi-muted" },
					"MCP 条目写在 profile 的 cordis.patch.yml；改完要重启 DSH 才加载。env / headers 的值不会显示（只显示键名）。"),
				view && view.notes && view.notes.length > 0
					? h("div", { className: "dpi-muted" }, view.notes.join(" · "))
					: null,
				counts && counts.problems > 0
					? h("div", { className: "dpi-muted", style: { color: "var(--dsw-alias-state-error-primary)" } },
						"⚠ " + counts.problems + " 台配置有问题（缺 serverName / transport / 命令；看下面标红的条目）")
					: null,
				view && view.ok === false
					? h("div", { className: "dpi-actions dpi-actions-tight" },
						h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => loadMcp(true) }, "重试"))
					: null,
				items.length > 0
					? h("ul", { className: "dpi-list dpi-list-info dpi-mcp-list" }, items.map((item) =>
						h("li", { key: "mcp" + (item.id || item.serverName || item.line) },
							h("div", { className: "dpi-reco-head" },
								h("b", null, item.serverName || item.id || "（没有 serverName）"),
								item.transport ? h("span", { className: "dpi-tag" }, item.transport) : null,
								mcpUpdateTag(item, updates),
								item.disabled
									? h("span", { className: "dpi-pill dpi-pill-idle" }, "已停用")
									: item.running
										? h("span", { className: "dpi-pill dpi-pill-ok" }, "运行中")
										: h("span", { className: "dpi-pill dpi-pill-warn" }, "已配置 · 未加载"),
								item.envKeys && item.envKeys.length > 0
									? h("span", { className: "dpi-tag", title: "只显示键名，值不会出现在这里" }, "env " + item.envKeys.join("/"))
									: null,
								item.headerKeys && item.headerKeys.length > 0
									? h("span", { className: "dpi-tag", title: "只显示键名，值不会出现在这里" }, "headers " + item.headerKeys.join("/"))
									: null),
							h("div", { className: "dpi-detail" },
								item.transport === "stdio"
									? [item.command].concat(item.args || []).filter(Boolean).join(" ")
									: (item.url || "（缺 url）")),
							h("div", { className: "dpi-detail" },
								(item.file || "?") + (item.line ? ":" + item.line : "") + (item.id ? " · id " + item.id : "")),
							mcpUpdateDetail(item, updates),
							item.problems && item.problems.length > 0
								? item.problems.map((problem, pi) => h("div", { key: "p" + pi, className: "dpi-detail", style: { color: "var(--dsw-alias-state-error-primary)" } }, "⚠ " + problem.text))
								: null)))
					: null,
				items.length === 0 && view && view.ok !== false
					? h("div", null,
						h("div", { className: "dpi-muted" }, "还没有配置 MCP 服务器。两种加法：① 在 AI 推荐 / 只搜索里搜（结果里会标 MCP）；② 在输入框里写 mcp:<registry 名字>。"),
						h("details", { className: "dpi-mcp-template" },
							h("summary", null, "看一段能直接抄的组合片段"),
							h("pre", { className: "dpi-code" }, view.template || ""),
							h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => { copyText(view.template || ""); toast("已复制组合片段"); } }, "复制")))
					: null
			);
		}

		function DoctorBox() {
			const s = useStore();
			const [open, setOpen] = useState(false);
			const [busy, setBusy] = useState(null);
			const [plain, flipPlain] = usePlainMode();
			const report = s.local.doctor || null;
			const runCheck = () => {
				setBusy("check");
				setOpen(true);
				api("/doctor", { method: "GET" })
					.then((r) => setLocal({ doctor: r.report || null }))
					.catch((e) => toast("体检失败：" + String((e && e.message) || e)))
					.finally(() => setBusy(null));
			};
			const repair = () => {
				setBusy("repair");
				api("/action", { method: "POST", body: JSON.stringify({ action: "repair" }) })
					.then((r) => {
						if (r && r.report && r.report.busy) {
							toast(String(r.report.error || "正在装东西，等它结束再修"));
							return;
						}
						if (r && r.report) setLocal({ doctor: r.report });
						if (r && r.state) setStore({ data: r.state });
						const n = r && r.report && Array.isArray(r.report.actions) ? r.report.actions.filter((a) => a.ok && !a.skipped).length : 0;
						toast(n > 0 ? "修好了 " + n + " 项" : "没有需要修的东西");
					})
					.catch((e) => toast("修复失败：" + String((e && e.message) || e)))
					.finally(() => setBusy(null));
			};
			const fixable = report && Array.isArray(report.findings) && report.findings.some((f) => f.fixable);
			return h(
				"div",
				{ className: "dpi-card dpi-doctor" },
				h("div", { className: "dpi-card-head" },
					h("strong", null, "环境体检"),
					/* R8 起 doctor 覆盖四层：安装环境 + profile 层 + 工具注册契约 + 崩溃日志。
					   文案别再只写前三项 —— 「算了但没用」的第一种是**说了但没说全**。 */
					h("span", { className: "dpi-muted" }, "dsh-tools 覆盖 / 悬空 file: 依赖 / bundles 对账 / 工具契约 / 崩溃日志"),
					h("span", {
						className: "dpi-muted",
						title: "任意页面按这个组合键 = 自检 + 自动修复（设置里可改 / 可关）",
						style: {
							padding: "1px 6px",
							borderRadius: 6,
							border: "1px solid currentColor",
							opacity: 0.72,
							fontSize: 11,
							whiteSpace: "nowrap"
						}
					}, currentHotkey() === HOTKEY_OFF ? "快捷键已关" : "快捷键 " + currentHotkey()),
					h("button", { className: "dpi-btn dpi-btn-sm", style: { marginLeft: "auto" }, disabled: busy !== null, onClick: runCheck },
						busy === "check" ? "检查中…" : report ? "再查一次" : "检查"),
					fixable ? h("button", { className: "dpi-btn dpi-btn-sm dpi-btn-primary", disabled: busy !== null, onClick: repair },
						busy === "repair" ? "修复中…" : "一键修复") : null),
				open && report
					? h("div", null,
						h("div", { className: "dpi-muted" },
							"profile " + (report.info.profile || "?") + " · vendor " + report.info.vendor.files + " 个产物 · trustPolicy " + (report.info.trustPolicy || "未设置") + " · git " + (report.info.git ? "有" : "无")),
						/* R5.1：宿主侧不热重载，所以「跑的是哪一版」必须看得见。
						   宿主那半是源码 mtime 标签，客户端这半是手动提的 build 号。 */
						h("div", { className: "dpi-muted" },
							"客户端 " + BUILD + " · 宿主 " + ((s.data && s.data.host && s.data.host.build) || "未知（重启 DSH 后可见）")),
						report.findings && report.findings.some((f) => f && f.plain)
							? h("div", { className: "dpi-actions dpi-actions-tight" }, h(PlainToggle, { on: plain, onFlip: flipPlain }))
							: null,
						report.findings.length === 0
							? h("div", { className: "dpi-muted" }, "没有发现问题。")
							: h(FindingsList, {
								findings: report.findings,
								plain,
								tone: report.findings.some((f) => f.severity === "error") ? "block" : "warn"
							}),
						Array.isArray(report.actions) && report.actions.length > 0
							? h("ul", { className: "dpi-list dpi-list-info" }, report.actions.map((a, i) =>
								h("li", { key: "act" + i }, a.kind + " → " + (a.ok ? (a.skipped ? "跳过（" + a.skipped + "）" : "完成") : "失败：" + a.error))))
							: null,
						report.info.guiPort ? h("div", { className: "dpi-muted" },
							"手机打不开（ts.net 502）= tailscale serve 还指着旧端口。一次性修：tailscale serve --bg --https=443 http://127.0.0.1:" + report.info.guiPort) : null,
						h("div", { className: "dpi-muted" },
							"一劳永逸：跑一次 dev\\install-serve-watch.ps1（管理员），它注册开机看护任务 —— 端口一变自己重指，热键 Ctrl+Alt+Y 也能当场触发。")
					)
					: null
			);
		}

		/* ── 设置面板（R6）────────────────────────────────────────────── */

		function ToggleRow(props) {
			const { label, hint, on, onChange } = props;
			return h(
				"div",
				{ className: "dpi-set-row" },
				h("div", { className: "dpi-set-label" },
					h("div", null, label),
					hint ? h("div", { className: "dpi-muted dpi-set-hint" }, hint) : null),
				h("button", {
					className: "dpi-switch" + (on ? " is-on" : ""),
					role: "switch",
					"aria-checked": on ? "true" : "false",
					"aria-label": label,
					onClick: () => onChange(!on)
				}, h("i", null))
			);
		}

		function SegRow(props) {
			const { label, hint, value, options, onChange } = props;
			return h(
				"div",
				{ className: "dpi-set-row dpi-set-row-col" },
				h("div", { className: "dpi-set-label" },
					h("div", null, label),
					hint ? h("div", { className: "dpi-muted dpi-set-hint" }, hint) : null),
				h("div", { className: "dpi-seg" }, options.map((opt) =>
					h("button", {
						key: String(opt.value),
						className: "dpi-seg-btn" + (String(opt.value) === String(value) ? " is-on" : ""),
						onClick: () => onChange(opt.value)
					}, opt.label)))
			);
		}

		function SettingsModal() {
			const st = currentSettings();
			const close = () => setLocal({ settingsOpen: false });
			const setSources = (key, next) => {
				const sources = { ...st.sources, [key]: next };
				if (!sources.npm && !sources.github && !sources.hub) {
					toast("至少要留一个搜索源");
					return;
				}
				saveSettings({ sources });
			};
			return h(
				"div",
				{ className: "dpi-overlay", onClick: close, role: "dialog", "aria-label": "设置" },
				h("div", { className: "dpi-settings", onClick: (e) => e.stopPropagation() },
					h("div", { className: "dpi-card-head" },
						h("strong", null, "设置"),
						h("span", { className: "dpi-muted" }, "默认档 = 现在的行为"),
						h("button", { className: "dpi-btn dpi-btn-ghost dpi-btn-sm", style: { marginLeft: "auto" }, onClick: close }, "关闭")),

					h("div", { className: "dpi-set-body" },
						h("div", { className: "dpi-set-section" },
							h("div", { className: "dpi-set-section-title" }, "提醒"),
							h(ToggleRow, {
								label: "侧边栏红点",
								hint: "关掉后图标不再冒红点；面板里仍会写「N 条待处理（红点已关）」",
								on: st.redDot,
								onChange: (v) => saveSettings({ redDot: v })
							}),
							h(ToggleRow, {
								label: "声音提醒",
								hint: "有任务变成「等待确认」或「失败」时响一声（不引音频文件，浏览器可能要求先交互一次）",
								on: st.sound,
								onChange: (v) => saveSettings({ sound: v })
							}),
							h(ToggleRow, {
								label: "桌面弹窗",
								hint: "同上，但走系统通知；没授权会先问一次，拒绝则退回面板内提示",
								on: st.desktopPopup,
								onChange: (v) => {
									saveSettings({ desktopPopup: v });
									if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
										Notification.requestPermission().catch(() => {});
									}
								}
							})),

						h("div", { className: "dpi-set-section" },
							h("div", { className: "dpi-set-section-title" }, "审核"),
							h(SegRow, {
								label: "审核强度",
								hint: "普通 = 一直以来的标准强度（默认）。严格 = 检出任何能力特征就停下来问，且中危常规能力也交给 AI 看一眼。关闭 = 不再停下来问、也不调模型，但装不了的东西照样阻断。",
								value: st.reviewLevel,
								options: [{ value: "strict", label: "严格" }, { value: "normal", label: "普通" }, { value: "off", label: "关闭" }],
								onChange: (v) => saveSettings({ reviewLevel: v })
							}),
							h(ToggleRow, {
								label: "允许「跳过审核」按钮",
								hint: "给「信任这个插件 / 想赶紧用上 / 想省 token」的人一个选择。开着时确认卡上多一个按钮，点它还要再确认一次；关掉则完全没有这个入口。",
								on: st.skipReview,
								onChange: (v) => saveSettings({ skipReview: v })
							})),

						h("div", { className: "dpi-set-section" },
							h("div", { className: "dpi-set-section-title" }, "AI 推荐"),
							h("div", { className: "dpi-muted dpi-set-hint" },
								"「条数」是最多给几条推荐；「广度」决定每一类（插件 / MCP / 技能）各送多少候选进模型 —— 调广会多要一些搜索结果、也多送几条进模型，代价是慢一点、token 多一点。默认档 = 一直以来的行为。"),
							h(SegRow, {
								label: "推荐条数",
								hint: "1 条最省；5 条会把同一需求下的不同路子（能读 / 能改 / 能自动化）都列出来。",
								value: st.aiPicks,
								options: [{ value: 1, label: "1 条" }, { value: 3, label: "3 条（默认）" }, { value: 5, label: "5 条" }],
								onChange: (v) => saveSettings({ aiPicks: v })
							}),
							h(SegRow, {
								label: "推荐广度",
								hint: "标准 = 每类最多 8 / 4 / 4 条候选（默认）；广 = 12 / 6 / 8 并多要一些搜索结果；很广 = 16 / 8 / 12。候选再多也不会超预算：按类保底，省略多少会如实写在 AI 的回复里。",
								value: st.aiBreadth,
								options: [{ value: "standard", label: "标准" }, { value: "wide", label: "广" }, { value: "max", label: "很广" }],
								onChange: (v) => saveSettings({ aiBreadth: v })
							})),

						h("div", { className: "dpi-set-section" },
							h("div", { className: "dpi-set-section-title" }, "界面与性能"),
							h(SegRow, {
								label: "状态轮询间隔",
								hint: "面板开着时的刷新节奏。调慢能少发请求，代价是进度看起来更「跳」。",
								value: st.pollMs,
								options: [{ value: 2500, label: "2.5 秒" }, { value: 5000, label: "5 秒" }, { value: 10000, label: "10 秒" }],
								onChange: (v) => saveSettings({ pollMs: v })
							}),
							h(SegRow, {
								label: "历史显示条数",
								hint: "只影响显示；任务本身最多留 40 条。",
								value: st.historyLimit,
								options: [{ value: 5, label: "5 条" }, { value: 8, label: "8 条" }, { value: 20, label: "20 条" }],
								onChange: (v) => saveSettings({ historyLimit: v })
							}),
							h(SegRow, {
								label: "快照保留份数",
								hint: "回滚就靠这些快照。调少省磁盘，但很久以前的安装就回不去了。",
								value: st.snapshotKeep,
								options: [{ value: 20, label: "20 份" }, { value: 40, label: "40 份" }, { value: 80, label: "80 份" }],
								onChange: (v) => saveSettings({ snapshotKeep: v })
							})),

						h("div", { className: "dpi-set-section" },
							h("div", { className: "dpi-set-section-title" }, "自检快捷键"),
							h("div", { className: "dpi-muted dpi-set-hint" },
								"任意页面按一下 = 环境自检 + 自动修复，不用先切到这个面板。结果落在右下角的游离浮窗里，会直接告诉你「现在能不能重启」—— 重复的 dsh-tools 只在插件加载那一刻发作，所以有效的时机就是重启之前。"),
							h(SegRow, {
								label: "按键",
								hint: "默认 Ctrl+Alt+D。若被别的程序抢了（Windows 的 Ctrl+Alt+字母常被输入法 / 显卡驱动占住），换一个即可；选「关闭」就不注册监听。存在这台浏览器的 localStorage 里，不走宿主设置。",
								value: currentHotkey(),
								options: HOTKEY_CHOICES,
								onChange: (v) => {
									saveHotkey(v);
									toast(v === HOTKEY_OFF ? "自检快捷键已关闭" : "自检快捷键改为 " + v);
								}
							})),

						h("div", { className: "dpi-set-section" },
							h("div", { className: "dpi-set-section-title" }, "搜索来源"),
							h("div", { className: "dpi-muted dpi-set-hint" }, "关掉某个源能少发请求（GitHub 搜索未认证只有 10 次/分）；至少要留一个。"),
							h(ToggleRow, { label: "npm registry", on: st.sources.npm, onChange: (v) => setSources("npm", v) }),
							h(ToggleRow, { label: "GitHub（仓库搜索 / topic 发现）", on: st.sources.github, onChange: (v) => setSources("github", v) }),
							h(ToggleRow, { label: "dsh-hub 商店（评分 / 安装量）", on: st.sources.hub, onChange: (v) => setSources("hub", v) }))),

					h("div", { className: "dpi-actions" },
						h("button", {
							className: "dpi-btn",
							onClick: () => saveSettings(SETTING_DEFAULTS).then(() => toast("已恢复默认（= 现在的标准版）"))
						}, "恢复默认"),
						h("span", { className: "dpi-muted" }, "改动立刻生效，存在 data/settings.json")))
			);
		}

		/**
		 * 「跳过审核，直接安装」（R6）。
		 * 只在「等待确认 + 这次本来要审」时出现；点了先在原地展开二次确认，
		 * 把后果写清楚再让他自己按下去 —— 按钮提供选择，不替用户做决定。
		 */
		function SkipReviewButton(props) {
			const { job, busy, act } = props;
			const st = currentSettings();
			const [asking, setAsking] = useState(false);
			if (!st.skipReview) return null;
			if (!job || !job.precheck || !job.precheck.needsAiReview) return null;
			if (!asking) {
				return h("button", { className: "dpi-btn dpi-btn-ghost", disabled: busy !== null, onClick: () => setAsking(true) }, "跳过审核，直接安装");
			}
			return h("div", { className: "dpi-ask" },
				h("b", null, "确认跳过审核？"),
				h("div", { className: "dpi-detail" },
					"这会：① 不再停下来等你确认；② 不调用模型、不花那笔 token（≈2–4k）。",
					"风险提示仍然全部有效，装完仍会做诊断，出问题可以一键回滚。"),
				h("div", { className: "dpi-actions dpi-actions-tight" },
					h("button", { className: "dpi-btn dpi-btn-sm", onClick: () => setAsking(false) }, "再想想"),
					h("button", {
						className: "dpi-btn dpi-btn-primary dpi-btn-sm",
						disabled: busy !== null,
						onClick: () => {
							setAsking(false);
							act("skip-review");
						}
					}, "我确认跳过")));
		}

		function Panel() {
			const s = useStore();
			const data = s.data || {};
			const active = data.active;
			const attention = data.attention || { dot: false, count: 0 };
			const host = data.host || {};
			const settings = currentSettings();
			const pollMs = settings.pollMs;
			const prevStatus = useRef({});
			/* R36：清单浮窗当前打开的是哪一个（plugins / skills / mcp / null） */
			const [listWindow, setListWindow] = useState(null);
			const listCounts = {
				plugins: s.local.inventory && s.local.inventory.counts ? s.local.inventory.counts.total : null,
				skills: s.local.skills && s.local.skills.counts ? s.local.skills.counts.skills : null,
				mcp: s.local.mcp && s.local.mcp.counts ? s.local.mcp.counts.total : null
			};
			/* 打开菜单时顺手补一下三个计数（都走缓存；已加载过的不会再发请求） */
			const prefetchLists = () => {
				loadInventory();
				loadSkills();
				loadMcp();
			};
			useEffect(() => {
				setLocal({ open: true });
				reportClientState();
				stopPolling();
				startPolling(pollMs);
				return () => {
					setLocal({ open: false });
					stopPolling();
					startPolling(6000);
				};
			}, []);
			/* 改了轮询间隔就当场换节奏（面板关着时不管，收起态固定 6s） */
			useEffect(() => {
				if (!polling) return;
				stopPolling();
				startPolling(pollMs);
			}, [pollMs]);
			/* 提醒（R6）：任务变成「等待确认 / 失败」的那一刻响一声 / 弹一次，每个任务只触发一次 */
			useEffect(() => {
				const jobs = (data.jobs || []).slice();
				if (data.active) jobs.unshift(data.active);
				const next = {};
				let alertJob = null;
				for (const job of jobs) {
					if (!job || !job.id) continue;
					next[job.id] = job.status;
					const before = prevStatus.current[job.id];
					if (!alertJob && before && before !== job.status && (job.status === "awaiting-confirm" || job.status === "failed")) {
						alertJob = job;
					}
				}
				prevStatus.current = next;
				if (!alertJob) return;
				const title = alertJob.status === "awaiting-confirm" ? "有任务在等你确认" : "安装任务失败";
				const body = (alertJob.title || alertJob.id) + (alertJob.error && alertJob.error.message ? " · " + alertJob.error.message : "");
				if (settings.sound) beep();
				if (settings.desktopPopup) desktopNotify(title, body);
			}, [data]);

			return h(
				"div",
				{ className: "dpi-panel" },
				h("header", { className: "dpi-header" },
					h("div", { className: "dpi-brand" },
						h("span", { className: "dpi-brand-icon" }, h(InstallIcon, { size: 20 })),
						h("div", { style: { minWidth: 0 } },
							h("div", { className: "dpi-title-row" },
								h("div", { className: "dpi-title" }, "插件 / Skill 安装"),
								/* R30：版本胶囊 —— 公开之后第一件要能回答的事是「我装的是哪一版」 */
								host.build
									? h("span", { className: "dpi-ver", title: "本插件构建（值来自源码最后修改时间）" },
										"v" + String(host.build).split("·")[0].trim())
									: null),
							h("div", { className: "dpi-muted" },
								"DSH " + (host.dsh || "?") + " · " + (host.profile || "?") + " 档 · 安装不花 token"
								+ (attention.count > 0 ? " · " + attention.count + " 条待处理" + (attention.dot ? "" : "（红点已关）") : "")))),
					h("div", { className: "dpi-header-actions" },
						h("button", { className: "dpi-btn dpi-btn-ghost dpi-btn-sm", onClick: () => setLocal({ settingsOpen: true }) },
							h(Glyph, { name: "sliders", size: 13 }), "设置"),
						/* R36：清单菜单在「设置」与「刷新」之间 —— 三个低频清单收进浮窗 */
						h(ListMenu, { counts: listCounts, onPick: (key) => setListWindow(key), onOpen: prefetchLists }),
						h("button", { className: "dpi-btn dpi-btn-ghost dpi-btn-sm", onClick: () => refresh() },
							h(Glyph, { name: "refresh", size: 13 }), "刷新"),
						attention.dot ? h("button", { className: "dpi-btn dpi-btn-ghost dpi-btn-sm", onClick: () => api("/action", { method: "POST", body: JSON.stringify({ action: "ack" }) }).then((r) => r.state && setStore({ data: r.state })) }, "清除红点") : null)),

				s.host && s.host.down
					? h(HostDownBanner, { host: s.host, onRetry: () => refresh() })
					: s.error
						? h("div", { className: "dpi-error" }, "面板读不到状态：" + s.error)
						: null,

				data.warnings && data.warnings.length > 0
					? h("div", { className: "dpi-warnbar" },
						h("b", null, "已自动处理 " + data.warnings.length + " 处环境隐患"),
						data.warnings.slice(-2).map((w, i) => h("div", { key: "warn" + i, className: "dpi-detail" }, w.message + (w.to ? "（备份在 " + w.to + "）" : ""))),
						h("button", {
							className: "dpi-btn dpi-btn-sm",
							onClick: () => api("/action", { method: "POST", body: JSON.stringify({ action: "fix-landmine" }) }).then((r) => {
								if (r && r.state) setStore({ data: r.state });
								toast(r && r.landmine && r.landmine.moved ? "又清理了一份" : "没有发现新的覆盖");
							})
						}, "再查一遍"))
					: null,

				h(Composer),

				data.active ? h("div", { className: "dpi-card dpi-active" }, h(JobDetail, { job: data.active })) : null,

				attention.count > 0 && attention.items && attention.items.length > 0
					? h("ul", { className: "dpi-attention" }, attention.items.map((item) =>
						h("li", { key: "att" + item.id }, h("b", null, item.title), h("span", { className: "dpi-detail" }, tidyError(item.reason)))))
					: null,

				h(AiBox),
				h(History),
				/* R38：更新条按用户要求挪到「历史」与「环境体检」之间 ——
				   先看历史（刚发生了什么），再看更新（要不要动手），最后才是体检（环境有没有病）。
				   它仍是面板上**唯一**的检查入口：插件 + MCP + Skill 一起查。 */
				h(UpdateBar, { onOpenList: (key) => setListWindow(key) }),
				/* R36：已装插件 / 已装 Skill 已收进右上角「清单」浮窗（低频入口）。 */
				h(DoctorBox),

				h("footer", { className: "dpi-footer" },
					h("span", null, "profile：" + (host.profileDir || "?")),
					h("span", null, "技能根：" + ((host.skillRoots && host.skillRoots[0]) || "?")),
					h("span", null, "数据：" + (host.dataDir || "?")),
					s.local.toast ? h("span", { className: "dpi-toast" }, s.local.toast) : null),

				s.local.settingsOpen ? h(SettingsModal) : null,

				/* R36：三个低频清单 —— 点「清单」里的哪一项，才挂载哪一个浮窗。 */
				listWindow === "plugins"
					? h(FloatWindow, {
						title: "已装插件",
						subtitle: "profile 依赖 · 可升级的排在最前 · 更新入口在主面板「插件与 MCP 更新」",
						onClose: () => setListWindow(null)
					}, h(Inventory, { inWindow: true }))
					: null,
				listWindow === "skills"
					? h(FloatWindow, {
						title: "已装 Skill",
						subtitle: "磁盘技能根 × 宿主认领结果 · 备份残留 / frontmatter / 不会自动调用都在这里",
						onClose: () => setListWindow(null)
					}, h(Skills, { inWindow: true }))
					: null,
				listWindow === "mcp"
					? h(FloatWindow, {
						title: "已装 MCP",
						subtitle: "profile 组合文件里的 dsh-mcp-client 条目 · 更新在主面板「检查更新」里一起查 · 写进去要重启 DSH 才加载",
						onClose: () => setListWindow(null)
					}, h(McpList, { inWindow: true }))
					: null
			);
		}

		/* ── 样式 ─────────────────────────────────────────────────────── */

		const CSS = `
.dpi-entry{position:relative;display:inline-flex;align-items:center;justify-content:center;line-height:0}
.dpi-entry .dpi-dot{position:absolute;top:-3px;right:-4px;width:8px;height:8px;border-radius:50%;
  background:var(--dsw-alias-state-error-primary,#e5484d);box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill,transparent)}
.dpi-panel{box-sizing:border-box;height:100%;overflow:auto;padding:22px 24px 40px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  /* 面板自己的节奏量：间距 / 圆角 / 表面色只在这里定义一次，下面所有规则引用它。 */
  --dpi-gap:12px;--dpi-r:12px;--dpi-r-sm:8px;--dpi-r-xs:6px;
  --dpi-surface:var(--dsw-alias-bg-layer-1);--dpi-surface-2:var(--dsw-alias-bg-layer-2);
  --dpi-line:var(--dsw-alias-border-l1);--dpi-line-strong:var(--dsw-alias-border-l2);
  --dpi-muted:var(--dsw-alias-label-secondary);--dpi-accent:var(--dsw-alias-brand-primary);
  --dpi-shadow:0 1px 2px rgba(0,0,0,.14),0 10px 26px -20px rgba(0,0,0,.55);
  font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;
  scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dpi-muted) 34%,transparent) transparent}
.dpi-panel *{box-sizing:border-box}
.dpi-panel ::selection{background:color-mix(in srgb,var(--dpi-accent) 30%,transparent);color:inherit}
.dpi-panel ::-webkit-scrollbar{width:10px;height:10px}
.dpi-panel ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dpi-muted) 30%,transparent);
  border-radius:99px;border:3px solid transparent;background-clip:padding-box}
.dpi-panel ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dpi-muted) 46%,transparent);
  background-clip:padding-box}
.dpi-panel ::-webkit-scrollbar-track{background:transparent}
.dpi-panel :focus-visible{outline:2px solid color-mix(in srgb,var(--dpi-accent) 58%,transparent);
  outline-offset:2px;border-radius:var(--dpi-r-xs)}
/* 一次编排好的入场：卡片依次浮起 6px，做完就停，不参与后续重渲染。 */
@keyframes dpi-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dpi-panel > *{animation:dpi-rise .24s cubic-bezier(.22,.68,.2,1) both}
.dpi-panel > :nth-child(2){animation-delay:.02s}
.dpi-panel > :nth-child(3){animation-delay:.04s}
.dpi-panel > :nth-child(4){animation-delay:.06s}
.dpi-panel > :nth-child(5){animation-delay:.08s}
.dpi-panel > :nth-child(6){animation-delay:.1s}
.dpi-panel > :nth-child(n+7){animation-delay:.12s}
@media (prefers-reduced-motion:reduce){
  .dpi-panel > *{animation:none}
  .dpi-btn,.dpi-history-row,.dpi-switch i{transition:none}
}
/* R36：面板的入场动画让每个直接子元素各成一层（transform/opacity），
   所以「清单」下拉必须把 header 自己也抬成一层，否则会被后面的卡片盖住。
   z-index 30 > 卡片（auto），但 < 设置/浮窗遮罩（60）。 */
.dpi-header{position:relative;z-index:30;display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:18px}
.dpi-brand{display:flex;gap:11px;align-items:center;min-width:0}
.dpi-brand-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px;
  color:var(--dpi-accent);background:color-mix(in srgb,var(--dpi-accent) 12%,var(--dpi-surface-2));
  border:1px solid color-mix(in srgb,var(--dpi-accent) 22%,var(--dpi-line));flex-shrink:0}
.dpi-title{font-size:15.5px;font-weight:600;line-height:1.28;letter-spacing:.005em}
.dpi-title-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}
.dpi-ver{font-size:10.5px;line-height:1;padding:3px 6px;border-radius:99px;color:var(--dpi-muted);
  border:1px solid var(--dpi-line);background:var(--dpi-surface-2);font-variant-numeric:tabular-nums}
.dpi-muted{color:var(--dpi-muted);font-size:12px;line-height:1.5}
.dpi-header-actions{display:flex;gap:7px;flex-shrink:0;align-items:center}
.dpi-composer{position:relative;border:1px solid var(--dpi-line);border-radius:14px;padding:12px 12px 10px;
  margin-bottom:14px;background:linear-gradient(180deg,
    color-mix(in srgb,var(--dpi-accent) 5%,var(--dpi-surface)),var(--dpi-surface));
  box-shadow:var(--dpi-shadow);transition:border-color .15s ease,box-shadow .15s ease}
.dpi-composer:focus-within{border-color:color-mix(in srgb,var(--dpi-accent) 45%,var(--dpi-line));
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dpi-accent) 12%,transparent),var(--dpi-shadow)}
.dpi-composer.is-drag{border-color:var(--dpi-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dpi-accent) 22%,transparent)}
.dpi-drop-veil{position:absolute;inset:0;border-radius:14px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb,var(--dpi-accent) 12%,transparent);font-size:13px;pointer-events:none;
  backdrop-filter:blur(1px)}
.dpi-input{width:100%;border:none;outline:none;resize:vertical;background:transparent;color:inherit;
  font:inherit;font-size:13.5px;line-height:1.6;min-height:46px;padding:2px 2px 0}
.dpi-input::placeholder{color:color-mix(in srgb,var(--dpi-muted) 88%,transparent)}
.dpi-input-line{min-height:34px;border:1px solid var(--dpi-line);border-radius:var(--dpi-r-sm);padding:6px 10px;
  background:var(--dpi-surface-2);flex:1;transition:border-color .15s ease,box-shadow .15s ease}
.dpi-input-line:focus{border-color:color-mix(in srgb,var(--dpi-accent) 50%,var(--dpi-line));
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dpi-accent) 12%,transparent)}
.dpi-composer-row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.dpi-composer-note{margin-top:8px;display:flex;align-items:flex-start;gap:6px;
  font-size:11.5px;line-height:1.5;color:var(--dpi-muted)}
.dpi-composer-note svg{flex-shrink:0;margin-top:1px;opacity:.75}
.dpi-hint{margin-left:auto}
.dpi-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dpi-line);
  background:var(--dpi-surface-2);color:inherit;border-radius:var(--dpi-r-sm);padding:6px 12px;
  font:inherit;font-size:12.5px;cursor:pointer;line-height:1.4;
  transition:background .12s ease,border-color .12s ease,color .12s ease,transform .06s ease}
.dpi-btn:hover:not(:disabled){border-color:var(--dpi-line-strong);
  background:color-mix(in srgb,var(--dpi-muted) 8%,var(--dpi-surface-2))}
.dpi-btn:active:not(:disabled){transform:translateY(.5px)}
.dpi-btn:disabled{opacity:.45;cursor:default}
.dpi-btn svg{flex-shrink:0}
.dpi-btn-primary{background:var(--dpi-accent);border-color:transparent;
  color:var(--dsw-alias-bg-base);font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.18),0 6px 16px -12px var(--dpi-accent)}
.dpi-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dpi-accent) 88%,#000);
  border-color:transparent}
.dpi-btn-ghost{background:transparent}
.dpi-btn-ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dpi-muted) 10%,transparent)}
/* 二次确认态：从「清理」变成「确认清理？」—— 用 warn 色，别让它在两段式的第一下就被误点 */
.dpi-btn-confirm{color:var(--dsw-alias-state-warn-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.dpi-btn-sm{padding:4px 9px;font-size:12px}
.dpi-mini{border:1px solid var(--dpi-line);background:transparent;color:var(--dpi-muted);
  border-radius:var(--dpi-r-xs);padding:2px 7px;font-size:11px;cursor:pointer;flex-shrink:0;
  transition:color .12s ease,border-color .12s ease}
.dpi-mini:hover{color:var(--dsw-alias-label-primary);border-color:var(--dpi-line-strong)}
.dpi-card{border:1px solid var(--dpi-line);background:var(--dpi-surface);border-radius:var(--dpi-r);
  padding:14px 15px;margin-bottom:var(--dpi-gap);box-shadow:var(--dpi-shadow)}
.dpi-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;
  font-size:13px;min-height:22px}
.dpi-card-head strong{font-weight:600;letter-spacing:.005em}
/* 段落标题右端那一小簇动作 / 计数：统一成同一颗胶囊形状，避免每张卡各写一种。 */
.dpi-count{font-size:11px;line-height:1;padding:4px 7px;border-radius:99px;color:var(--dpi-muted);
  background:var(--dpi-surface-2);border:1px solid var(--dpi-line);font-variant-numeric:tabular-nums}
.dpi-card-head .dpi-btn,.dpi-card-head .dpi-mini{margin-left:0}
.dpi-head-spacer{margin-left:auto}
/* R9：安装脚本待批准 / 需要用户点头的卡片 */
.dpi-card-warn{border-color:var(--dsw-alias-state-warn-primary)}
.dpi-active{border-color:var(--dsw-alias-border-l2)}
.dpi-job-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.dpi-job-title{font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52ch}
.dpi-right{margin-left:auto}
.dpi-pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11.5px;border:1px solid transparent}
.dpi-pill-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}
.dpi-pill-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.dpi-pill-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent)}
.dpi-pill-idle{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dpi-stages{list-style:none;margin:6px 0 10px;padding:0;display:flex;flex-direction:column;gap:3px}
/* R35：等待确认时的「决定条」—— 一句话 + 能力 chips + 安装期脚本提醒 */
.dpi-decide{margin:8px 0 6px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-line,rgba(127,127,127,.22));
 background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c48b1d) 7%,transparent)}
.dpi-decide-why{font-size:13px;line-height:1.6}
.dpi-decide-why b{font-weight:600}
.dpi-decide-caps{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.dpi-chip{font-size:11.5px;line-height:1.5;padding:1.5px 7px;border-radius:999px;
 background:var(--dsw-alias-bg-tertiary,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dpi-decide-flag{margin-top:7px;font-size:12px;color:var(--dsw-alias-state-warn-primary,#c48b1d)}

.dpi-progress{margin:2px 0 8px}
.dpi-progress-btn{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;padding:4px 0;cursor:pointer;color:inherit;font:inherit;text-align:left}
.dpi-progress-track{display:flex;gap:3px;flex:1;min-width:0}
.dpi-progress-seg{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-bg-tertiary,rgba(127,127,127,.22));transition:background .18s ease}
.dpi-progress-seg.is-done{background:var(--dsw-alias-state-success-primary,#2f9e5f)}
.dpi-progress-seg.is-warn{background:var(--dsw-alias-state-warn-primary,#c48b1d)}
.dpi-progress-seg.is-fail{background:var(--dsw-alias-state-error-primary,#c0392b)}
.dpi-progress-seg.is-running{background:var(--dsw-alias-brand-primary,#4a7dff);animation:dpi-pulse 1.1s ease-in-out infinite}
@keyframes dpi-pulse{0%,100%{opacity:.45}50%{opacity:1}}
.dpi-progress-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex-shrink:0}
.dpi-progress-note{margin:1px 0 0 1px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.72;
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* R34 技术细节折叠：事后材料收在这里，默认不糊脸 */
.dpi-tech{margin:6px 0 2px}
.dpi-tech-btn{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:2px 0;cursor:pointer;
 font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.9}
.dpi-tech-btn:hover{opacity:1;text-decoration:underline}
.dpi-tech-body{margin-top:6px;padding-left:2px}
/* R34 宿主掉线条：不再甩 "响应不是 JSON(HTTP 404)" */
.dpi-offline{margin:0 0 10px;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary,#c48b1d);
 background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c48b1d) 9%,transparent)}
.dpi-offline-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12.5px}
.dpi-offline-head b{font-weight:600}
.dpi-offline-head .dpi-btn{margin-left:auto}
.dpi-offline-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#c48b1d);
 animation:dpi-pulse 1.1s ease-in-out infinite;flex-shrink:0}
.dpi-offline-note{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dpi-offline-err{margin-top:3px;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.8;word-break:break-all}
.dpi-offline-steps{margin:6px 0 0 16px;padding:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.65}
.dpi-offline-steps li{margin:2px 0}
.dpi-stage{display:flex;align-items:baseline;gap:8px;font-size:12.5px}
.dpi-stage-icon{width:14px;text-align:center;font-weight:700;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.dpi-stage.is-ok .dpi-stage-icon{color:var(--dsw-alias-state-success-primary)}
.dpi-stage.is-warn .dpi-stage-icon{color:var(--dsw-alias-state-warn-primary)}
.dpi-stage.is-fail .dpi-stage-icon{color:var(--dsw-alias-state-error-primary)}
.dpi-stage.is-running .dpi-stage-icon{color:var(--dsw-alias-brand-primary)}
.dpi-stage-body{display:flex;gap:8px;flex-wrap:wrap;min-width:0}
.dpi-stage-label{flex-shrink:0}
.dpi-stage-detail{color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-word}
.dpi-stage-ms{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;flex-shrink:0}
.dpi-list{list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.dpi-list li{padding-left:10px;border-left:2px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:3px}
.dpi-list-block li{border-left-color:var(--dsw-alias-state-error-primary)}
.dpi-list-warn li{border-left-color:var(--dsw-alias-state-warn-primary)}
.dpi-list-info li{border-left-color:var(--dsw-alias-border-l2)}
.dpi-detail{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;word-break:break-word}
.dpi-tag{display:inline-block;padding:0 6px;border-radius:5px;font-size:11px;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.dpi-tag-high{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dpi-tag-medium{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dpi-tag-kind{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dpi-excerpt{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:4px 6px;overflow-x:auto;white-space:pre}
.dpi-pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);
  border-radius:8px;padding:8px;overflow:auto;max-height:260px;margin:6px 0 0}
.dpi-hits summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:6px}
.dpi-hits ul{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12px}
.dpi-fixes{margin-top:8px;display:flex;flex-direction:column;gap:6px}
/* 「怎么解决」：每条发现下面一段带编号的处置步骤，命令仍然是可复制的块。 */
.dpi-fixbox{margin-top:7px;border-radius:8px;padding:7px 9px;border:1px dashed var(--dsw-alias-border-l1);
  display:flex;flex-direction:column;gap:6px}
.dpi-fixhead{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dpi-fixlist{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:12px;
  line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dpi-fixlist li{padding-left:2px}
.dpi-fixaction{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:5px}
/* 「大白话解释」开关：术语细节 ⇄ 大白话。颜色用 brand-primary，暗色主题下也够亮。 */
.dpi-plain-btn{margin-left:auto}
.dpi-plain-btn.is-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dpi-detail.is-plain{color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.65}
.dpi-cmd{display:flex;gap:8px;align-items:flex-start;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 8px}
.dpi-cmd code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;overflow-x:auto;
  white-space:pre;flex:1;color:var(--dsw-alias-label-primary)}
.dpi-error{border-left:2px solid var(--dsw-alias-state-error-primary);padding:6px 10px;margin:8px 0;
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);border-radius:6px;font-size:12.5px}
.dpi-warnbar{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:9px;padding:8px 10px;margin-bottom:12px;
  font-size:12.5px;display:flex;flex-direction:column;gap:5px;
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.dpi-warnbar b{color:var(--dsw-alias-state-warn-primary)}
.dpi-warnbar .dpi-btn{align-self:flex-start;margin-top:2px}
.dpi-meta{font-size:12.5px;margin-bottom:8px;display:flex;flex-direction:column;gap:4px}
.dpi-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.dpi-actions-end{justify-content:flex-end}
.dpi-actions-tight{margin-top:6px}
.dpi-attention{list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12px}
.dpi-attention li{border-left:2px solid var(--dsw-alias-state-error-primary);padding-left:8px;display:flex;flex-direction:column;gap:2px}
.dpi-ai .dpi-ai-reply{margin-top:8px;font-size:12.5px;line-height:1.6}
.dpi-ai .dpi-ai-limits{margin:2px 0 8px;font-size:11.5px;line-height:1.5}
.dpi-recos{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.dpi-reco{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px}
/* R42：自定义条目 —— 用虚线边框和推荐卡区分开（它不是 AI 选的，是人填的） */
.dpi-reco-custom{border-style:dashed;background:color-mix(in srgb,var(--dsw-alias-bg-base) 92%,var(--dsw-alias-border-l1))}
.dpi-reco-custom .dpi-composer-row{margin-top:6px}
.dpi-reco-head{display:flex;gap:8px;align-items:center;font-size:12.5px}
.dpi-reco-why{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px;line-height:1.55}
/* R3：可信度徽章 / 红旗 / 用途-权限卡 */
.dpi-badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.dpi-flags{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.dpi-flag{font-size:11.5px;line-height:1.5;padding:4px 7px;border-radius:6px;
  border-left:2px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.dpi-flag.is-error{border-left-color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dpi-purpose{margin-top:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px;
  display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1)}
.dpi-purpose-head{display:flex;gap:8px;align-items:center;font-size:12.5px;flex-wrap:wrap}
.dpi-link{font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:none}
/* 历史：两行一条（名字 + 状态，下面一行是版本/失败原因/阶段），比原来「一行塞满」可扫得多。
   失败的那几条是用户最需要一眼认出来的 —— 所以状态做成一颗粒，而不是一个 7px 的小点。 */
.dpi-history{display:flex;flex-direction:column;gap:3px;margin:0 -7px}
.dpi-history-item{border-radius:var(--dpi-r-sm);overflow:hidden}
.dpi-history-row{display:grid;grid-template-columns:auto 1fr auto;gap:2px 9px;align-items:center;width:100%;
  background:transparent;border:1px solid transparent;color:inherit;padding:8px 9px;cursor:pointer;
  text-align:left;font:inherit;font-size:12.5px;border-radius:var(--dpi-r-sm);
  transition:background .12s ease,border-color .12s ease}
.dpi-history-row:hover{background:var(--dpi-surface-2);border-color:var(--dpi-line)}
.dpi-history-row.is-open{background:var(--dpi-surface-2);border-color:var(--dpi-line)}
.dpi-hist-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.dpi-history-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dpi-hist-meta{font-size:11.5px;line-height:1.5;color:var(--dpi-muted);display:block;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dpi-hist-meta i{font-style:normal;opacity:.5}
.dpi-hist-right{display:flex;align-items:center;gap:9px;flex-shrink:0}
.dpi-hist-when{font-size:11.5px;color:var(--dpi-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.dpi-chev{display:flex;color:var(--dpi-muted);font-size:10px;transition:transform .16s ease}
.dpi-chev.is-open{transform:rotate(90deg)}
/* 展开的详情：从「一行」变成「一张内嵌的纸」，而不是让内容直接铺在卡片底色上。 */
.dpi-hist-detail{margin:2px 0 8px;padding:10px 12px 12px;border-top:1px solid var(--dpi-line);
  background:color-mix(in srgb,var(--dpi-surface-2) 60%,transparent);border-radius:0 0 var(--dpi-r-sm) var(--dpi-r-sm)}
.dpi-hist-detail .dpi-job{display:flex;flex-direction:column;gap:4px}
.dpi-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1;padding:4px 8px;
  border-radius:99px;border:1px solid transparent;white-space:nowrap;font-weight:500}
.dpi-status::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.dpi-status.is-done{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.dpi-status.is-failed{color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dpi-status.is-awaiting-confirm,.dpi-status.is-warn{color:var(--dsw-alias-state-warn-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent)}
.dpi-status.is-running{color:var(--dpi-accent);background:color-mix(in srgb,var(--dpi-accent) 13%,transparent)}
.dpi-status.is-idle,.dpi-status.is-cancelled{color:var(--dpi-muted);background:var(--dpi-surface-2)}
.dpi-empty{display:flex;flex-direction:column;gap:5px;align-items:flex-start;padding:16px;
  border:1px dashed var(--dpi-line);border-radius:var(--dpi-r);color:var(--dpi-muted);font-size:12.5px;
  line-height:1.55;background:color-mix(in srgb,var(--dpi-surface-2) 50%,transparent)}
.dpi-empty b{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dpi-dot-static{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex-shrink:0}
.dpi-dot-static.is-done{background:var(--dsw-alias-state-success-primary)}
.dpi-dot-static.is-failed{background:var(--dsw-alias-state-error-primary)}
.dpi-dot-static.is-awaiting-confirm{background:var(--dsw-alias-state-warn-primary)}
.dpi-dot-static.is-running{background:var(--dpi-accent)}
.dpi-footer{display:flex;flex-direction:column;gap:2px;margin-top:18px;padding-top:10px;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dpi-toast{margin-top:6px;color:var(--dsw-alias-brand-primary)}

/* ── 已装清单（R12）────────────────────────────────────────────────── */
/* 一行里塞了名字 + 版本 + 来源 + 若干徽章，窄屏（360px）必须能折行，否则会被裁掉。 */
.dpi-inventory .dpi-reco-head{flex-wrap:wrap;min-width:0}
.dpi-inventory .dpi-reco-head b{min-width:0;overflow:hidden;text-overflow:ellipsis;max-width:100%}
/* R14：已装 Skill —— 55 条挤在一张卡里，标签必须能换行，描述最多两行 */
.dpi-skills .dpi-reco-head{flex-wrap:wrap;min-width:0;gap:6px}
.dpi-skills .dpi-reco-head b{min-width:0;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.dpi-skill-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dpi-inv-list li{gap:4px}
/* R14：两张大清单展开后会有 44 / 59 行（本机实测 4494px 高）—— 卡片自己滚，
   别把下面的体检卡和页脚顶出视口；首行永远是「有问题」的那几条（排序保证）。 */
.dpi-inventory .dpi-list,.dpi-skills .dpi-list{max-height:480px;overflow:auto;padding-right:4px}
/* R30：磁盘之外的那批技能 —— 收进 details，默认一行，展开是名单 */
.dpi-hostonly{margin-top:7px;font-size:12px;color:var(--dpi-muted)}
.dpi-hostonly summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;line-height:1.5}
.dpi-hostonly summary::-webkit-details-marker{display:none}
.dpi-hostonly summary::before{content:"";width:0;height:0;border-left:4.5px solid currentColor;
  border-top:3.5px solid transparent;border-bottom:3.5px solid transparent;opacity:.7;
  transition:transform .15s ease;flex-shrink:0}
.dpi-hostonly[open] summary::before{transform:rotate(90deg)}
.dpi-hostonly summary:hover{color:var(--dsw-alias-label-primary)}
.dpi-hostonly-list{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}

/* ── 设置（R6）───────────────────────────────────────────────────── */
.dpi-overlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.42);
  display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;overflow:auto;
  backdrop-filter:blur(1.5px)}
.dpi-settings{width:min(620px,100%);max-height:calc(100vh - 96px);overflow:auto;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:14px;
  border:1px solid var(--dpi-line);padding:16px 18px 18px;
  box-shadow:0 24px 64px -28px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.18);
  scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dpi-muted) 34%,transparent) transparent}
/* 设置项之间用「组」分隔，而不是每一项都画一条线 —— 二十来项时后者会变成一堵表格墙。 */
.dpi-set-body{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.dpi-set-section{display:flex;flex-direction:column;gap:6px;padding:13px 0 6px;border-top:1px solid var(--dpi-line)}
.dpi-set-section:first-child{border-top:none;padding-top:2px}
.dpi-set-section-title{font-size:11.5px;letter-spacing:.07em;color:var(--dpi-muted);font-weight:600}
.dpi-set-row{display:flex;align-items:center;gap:14px;justify-content:space-between;padding:5px 0}
.dpi-set-row-col{flex-direction:column;align-items:stretch;gap:8px}
.dpi-set-row-col{flex-direction:column;align-items:stretch;gap:8px}
.dpi-set-label{display:flex;flex-direction:column;gap:3px;font-size:13px;min-width:0}
.dpi-set-hint{font-size:11.5px;line-height:1.5}
.dpi-switch{width:42px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;flex-shrink:0;padding:0;
  transition:background .15s ease}
.dpi-switch i{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;
  background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}
.dpi-switch.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dpi-switch.is-on i{transform:translateX(18px);background:var(--dsw-alias-bg-base)}
.dpi-seg{display:inline-flex;gap:6px;flex-wrap:wrap}
.dpi-seg-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12.5px}
.dpi-seg-btn:hover{border-color:var(--dsw-alias-border-l2)}
.dpi-seg-btn.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base)}
.dpi-ask{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:8px;padding:10px 12px;
  border-radius:10px;border:1px solid var(--dsw-alias-state-warn-primary,#d89614);
  background:var(--dsw-alias-bg-layer-2)}

/* ── R36：右上角「清单」菜单 ───────────────────────────────────────── */
.dpi-menu-wrap{position:relative;display:inline-flex;flex-shrink:0}
.dpi-chev{display:inline-flex;transition:transform .14s ease}
.dpi-menu{position:absolute;right:0;top:calc(100% + 7px);z-index:200;min-width:196px;padding:5px;
  display:flex;flex-direction:column;gap:2px;border:1px solid var(--dpi-line-strong);border-radius:10px;
  background:var(--dpi-surface);box-shadow:0 18px 42px -20px rgba(0,0,0,.62),0 2px 8px rgba(0,0,0,.16)}
.dpi-menu-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;
  border:none;background:transparent;color:inherit;text-align:left;font:inherit;font-size:12.5px;
  padding:8px 10px;border-radius:7px;cursor:pointer}
.dpi-menu-item:hover{background:color-mix(in srgb,var(--dpi-muted) 12%,transparent)}
.dpi-menu-item .dpi-count{font-size:10.5px;padding:3px 6px}

/* ── R36：浮动清单窗（点 X / 点周围空白 / Esc 关） ─────────────────── */
.dpi-float-overlay{align-items:center;justify-content:center;padding:24px;overflow:hidden}
.dpi-float{width:min(960px,100%);max-height:min(82vh,820px);display:flex;flex-direction:column;
  overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dpi-surface);
  border:1px solid var(--dpi-line-strong);border-radius:16px;
  box-shadow:0 28px 70px -30px rgba(0,0,0,.65),0 4px 14px rgba(0,0,0,.2)}
.dpi-float-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
  flex-shrink:0;padding:14px 16px 12px;border-bottom:1px solid var(--dpi-line);background:var(--dpi-surface)}
.dpi-float-title{min-width:0;display:flex;flex-direction:column;gap:3px}
.dpi-float-title strong{font-size:14.5px;font-weight:600}
.dpi-float-x{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
  flex-shrink:0;border-radius:8px;border:1px solid transparent;background:transparent;
  color:var(--dpi-muted);cursor:pointer}
.dpi-float-x:hover{color:var(--dsw-alias-label-primary);border-color:var(--dpi-line);
  background:color-mix(in srgb,var(--dpi-muted) 12%,transparent)}
.dpi-float-body{overflow:auto;min-height:0;padding:14px 16px 18px}
.dpi-float-body .dpi-card{padding:0;margin-bottom:0;border:none;box-shadow:none;background:transparent}
.dpi-in-window .dpi-card-head{margin-bottom:8px}
.dpi-updatebar .dpi-card-head{margin-bottom:6px}
.dpi-mcp-path{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;margin-top:6px;
  font-size:11.5px;line-height:1.6}
.dpi-mcp-path code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;
  padding:2px 6px;border-radius:5px;border:1px solid var(--dpi-line);background:var(--dpi-surface-2);
  overflow-wrap:anywhere}
.dpi-mcp-template{margin-top:8px}
.dpi-mcp-template summary{cursor:pointer;font-size:12px;color:var(--dpi-muted)}
.dpi-code{margin:8px 0;padding:10px 12px;overflow:auto;max-height:260px;border-radius:8px;
  border:1px solid var(--dpi-line);background:var(--dpi-surface-2);font-size:11.5px;line-height:1.55;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre}
.dpi-mcp-list .dpi-detail{overflow-wrap:anywhere}

@media (max-width:760px){
  .dpi-overlay{padding:12px 8px}
  .dpi-settings{max-height:calc(100vh - 24px);padding:12px}
  .dpi-float-overlay{padding:8px}
  .dpi-float{max-height:calc(100vh - 16px);border-radius:12px}
  .dpi-float-head{padding:12px 12px 10px}
  .dpi-float-body{padding:12px}
  .dpi-menu{min-width:170px}
}
@media (max-width:760px){
  .dpi-panel{padding:14px 12px 32px}
  .dpi-job-title{max-width:100%;white-space:normal}
  .dpi-hint{display:none}
  .dpi-btn{padding:9px 14px;font-size:13px}
  .dpi-btn-sm{padding:7px 11px}
  .dpi-header{flex-direction:column;align-items:stretch}
  .dpi-header-actions{justify-content:flex-end}
}
`;

		/* ── 插件体 ───────────────────────────────────────────────────── */

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-plugin-installer");
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => {
					try {
						style.remove();
					} catch (e) {
						/* ignore */
					}
				};
			}, "plugin-installer: styles");

			ctx.effect(() => {
				startPolling(4000);
				return () => stopPolling();
			}, "plugin-installer: polling");

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: "installer", order: 30, label: () => PANEL_LABEL },
					SidebarEntry
				)
			);

			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: "installer" }, Panel)
			);
		}

		const exports = { apply, inject: ["slots"] };
		exports.__test = {
			PANEL_LABEL,
			InstallIcon,
			SidebarEntry,
			Panel,
			JobDetail,
			PrecheckCard,
			ReviewCard,
			DiagnosisCard,
			copyText,
			ago,
			store,
			refresh,
			submitInput,
			startPolling,
			stopPolling,
			/* R6：设置面板与「跳过审核」按钮也要能被无头渲染到 */
			SETTING_DEFAULTS,
			currentSettings,
			beep,
			desktopNotify,
			SettingsModal,
			SkipReviewButton,
			/* R9：安装脚本待批准卡（无头渲染要摸得到，否则二次确认态没人验） */
			BuildApprovalCard,
			/* R10：版本不兼容卡（同上） */
			CompatExemptCard,
			/* R27：换版本卡（先卸后装 / 中断续跑）—— 无头渲染要能验「为什么必须卸、能不能续」 */
			UpgradeCard,
			/* R31：直连安装卡与信任豁免卡（两条新处置都必须能被无头渲染摸到） */
			LinkInstallCard,
			TrustExemptCard,
			/* R34：进度条 / 技术细节折叠 / 宿主掉线条（三块新界面都要能被无头渲染验到） */
			StageProgress,
			JobTechFold,
			HostDownBanner,
			/* R35：等待确认时的「决定条」 */
			DecisionBar,
			StageList,
			/* R30：界面打磨 —— 顶部品牌块 / 历史两行 / 空态 / 自绘图标（无头渲染要能验） */
			History,
			Glyph,
			historyMeta,
			/* R12：已装清单 + 检查更新（无头渲染要能验折叠/可升级行/空态） */
			Inventory,
			/* R25：AI 推荐 / 只搜索卡片（无头渲染要能验「已装」分来源与「本机插件」提示） */
			AiBox,
			/* R14：已装 Skill（无头渲染要能验：折叠/展开、备份标签、宿主没认、读不到兜底） */
			Skills,
			/* R36：清单菜单 / 浮窗 / 已装 MCP / 独立更新条（四个新界面都要能被无头渲染验到） */
			checkAllSummaryText,
			UpdateBar,
			ListMenu,
			FloatWindow,
			McpList,
			mcpRecoDetails,
			recoActions,
			/* R6.1：自检快捷键（无头渲染与自测也要能摸到这几个） */
			runSelfCheck,
			bindHotkey,
			hotkeyMatches,
			parseHotkey,
			currentHotkey,
			saveHotkey,
			showHotkeyCard,
			hideHotkeyCard,
			HOTKEY_DEFAULT,
			HOTKEY_OFF,
			HOTKEY_CHOICES
		};

		/* 模块加载即绑定：client bundle 在启动时跑一次，
		   所以快捷键从一开始就是活的 —— 不用先打开「插件安装」面板。 */
		bindHotkey();

		return exports;
	}
});
