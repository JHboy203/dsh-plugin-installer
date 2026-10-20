/**
 * precheck.js — 安装前安全预检（确定性、零 token）。
 *
 * 四件事：
 *  ① 版本兼容：engines.dsh / DSH 系 peerDependencies 对本机宿主版本；
 *  ② 依赖与 engines：Node 版本、bundle 清单、patch 是否真存在；
 *  ③ 静态危险能力：交给 lib/scan.js 的 13 类特征；
 *  ④ 信任策略：pnpm trustPolicy、npm provenance（只作加分/警告，不作唯一放行依据）。
 *
 * 输出里 `block` 是硬阻断，`warn` 要用户点确认，`info` 只是知情。
 */
import { compareVersions, satisfiesVersion } from "./semver.js";
import { hostVersions, pnpmTrustPolicy, profileName } from "./hostinfo.js";
import { evaluateCompat } from "./compat.js";
import { judgePurpose } from "./purpose.js";
import { reviewWorthIt } from "./ai.js";
import { scanToolContract } from "./contract.js";

const DSH_PEER_PREFIX = "@deepseek-ai/";

function checkOne({ kind, name, range, actual }) {
	if (!actual) {
		return { kind, name, range, actual: null, ok: null, note: "无法确认本机版本，降级为安装后验证" };
	}
	const res = satisfiesVersion(actual, range);
	return { kind, name, range, actual, ok: res.ok, note: res.ok ? null : res.reason };
}

/**
 * @param {object} input
 * @param {object} input.detected detectKind() 结果
 * @param {object} input.scan scanTree() 结果
 * @param {Array}  input.scripts installScripts() 结果
 * @param {object} input.source {type, spec, name, version}
 * @param {object} [input.reputation] {ok, provenance, publishedAt, maintainers, error}
 * @param {object} [input.host] hostVersions() 结果
 * @param {object} [input.trust] pnpmTrustPolicy() 结果
 */
export async function precheck(input) {
	const host = input.host || (await hostVersions());
	const trust = input.trust || (await pnpmTrustPolicy());
	const detected = input.detected;
	const scan = input.scan || { severity: "none", hits: [], combos: [], summary: "未扫描" };
	const scripts = input.scripts || [];
	const reasons = [];
	const fixes = [];

	const manifest = (detected.payload && detected.payload.manifest) || {};
	const official = await evaluateCompat(manifest);
	const checks = [];
	if (manifest.engines && manifest.engines.dsh) {
		checks.push(checkOne({ kind: "engines.dsh", name: "engines.dsh", range: String(manifest.engines.dsh), actual: host.dsh }));
	}
	for (const [name, range] of Object.entries(manifest.peerDependencies || {})) {
		if (!name.startsWith(DSH_PEER_PREFIX)) continue;
		const actual = name === "@deepseek-ai/dsh-tools" ? host.dshTools || host.dsh : host.dsh;
		checks.push(checkOne({ kind: "peerDependencies", name, range: String(range), actual }));
	}
	const nodeRange = manifest.engines && manifest.engines.node ? String(manifest.engines.node) : null;
	const nodeCheck = nodeRange
		? { range: nodeRange, actual: host.node, ok: satisfiesVersion(host.node, nodeRange).ok }
		: null;

	const mismatch = checks.filter((c) => c.ok === false);
	const unknown = checks.filter((c) => c.ok === null);
	// 判定以官方 evaluatePluginCompatibility 为准；本地表只用于展示「哪一条不满足」。
	const blockedByCompat = official.ok === false && official.exempted !== true;
	const compatVerdict = official.ok
		? "ok"
		: official.exempted
			? "exempted"
			: official.requirements === null
				? "unknown"
				: "mismatch";

	if (blockedByCompat) {
		const pkgName = (input.source && input.source.name) || manifest.name || "<package>";
		const pkgVer = (input.source && input.source.version) || manifest.version || "<version>";
		const req = official.requirements || {};
		const list = Object.entries(req).map(([name, range]) => name + " 要求 " + range).join("；");
		reasons.push({
			level: "block",
			text: "版本不兼容：本机 DSH " + (official.runtimeVersion || "未知") + " 不满足 " + list,
			detail: "判据用官方 evaluatePluginCompatibility（via " + official.via + "）。" + (official.error ? "降级说明：" + official.error : "")
		});
		if (official.runtimeVersion) {
			fixes.push({
				label: "确认兼容风险后放行（官方版本豁免）",
				command: "dsh plugin --profile " + profileName() + " allow-version " + pkgName + "@" + pkgVer +
					" --dsh-version " + official.runtimeVersion + " --accept-risk"
			});
		}
		fixes.push({ label: "换一个匹配当前 DSH 的版本", command: null });
	} else if (official.exempted) {
		reasons.push({
			level: "warn",
			text: "版本不兼容，但你之前给这个版本发过豁免",
			detail: "按官方语义继续安装；出问题用面板的一键回滚。"
		});
	} else if (unknown.length > 0 && !official.runtimeVersion) {
		reasons.push({
			level: "warn",
			text: "无法确认版本兼容性：" + unknown.map((c) => c.name).join("、"),
			detail: "本机 DSH 版本读不到（" + (host.sources.length ? "已尝试 " + host.sources.join(", ") : "没有可用路径") + "）。按「装最新版 + 装后诊断」处理。"
		});
	} else if (checks.length > 0) {
		reasons.push({ level: "info", text: "版本兼容：" + checks.map((c) => c.name + " ✓").join("、") + "（via " + official.via + "）" });
	}

	if (nodeCheck && nodeCheck.ok === false) {
		reasons.push({
			level: "warn",
			text: "Node 版本不满足 engines.node（要求 " + nodeRange + "，本机 " + host.node + "）",
			detail: "宿主是 Electron 内置 Node，通常无法更换；若插件用到了新语法可能运行期报错。"
		});
	}

	/* 已装版本对照（R5.1）：只有 bundle 有意义。同版本也有价值 ——
	   它明确告诉用户「这次会用新字节覆盖已装的那份」。 */
	let installed = null;
	if (input.installed && input.installed.installed) {
		const current = input.installed.version || null;
		/* ⚠️ detectKind() 的结果**没有**顶层 version —— 它在 payload.manifest 里
		   （pipeline 的 compactDetected 才把它拍平）。这里必须两边都认。 */
		const target = manifest.version || detected.version || (input.source && input.source.version) || null;
		let relation = "unknown";
		if (current && target) {
			try {
				const c = compareVersions(target, current);
				relation = c > 0 ? "upgrade" : c < 0 ? "downgrade" : "same";
			} catch {
				relation = "unknown";
			}
		}
		installed = { installed: true, version: current, target, relation };
		const label = { upgrade: "这是升级", downgrade: "这是降级", same: "同版本重装", unknown: "已装过这个插件" }[relation];
		reasons.push({
			level: relation === "downgrade" ? "warn" : "info",
			text: label + "：已装 " + (current || "未知版本") + (target ? " → 本次 " + target : ""),
			detail:
				relation === "downgrade"
					? "降级会丢掉新版里的修复；装完看一次诊断，确认功能还在。"
					: relation === "same"
						? "版本号相同，但仍会用你这回的字节覆盖已装的那份（安装前有快照，出问题可一键回滚）。"
						: "安装前会先做快照，出问题用「回滚到安装前」。"
		});
	}

	if (detected.kind === "profile") {
		reasons.push({ level: "block", text: "这是 profile 清单，不是可安装包", detail: "profile 属于 DSH 自己的配置层，装进来会覆盖你的运行配置。" });
	}	if (detected.kind === "unknown") {
		reasons.push({
			level: "block",
			text: "未识别内容，已转人工确认",
			detail: detected.reason || "既没有 dsh.bundle，也没有 SKILL.md。"
		});
	}
	if (detected.kind === "bundle" && !detected.installable) {
		reasons.push({ level: "block", text: "bundle 不完整", detail: detected.reason || "缺少 patch 文件" });
	}
	if (detected.kind === "skill" && !detected.installable) {
		reasons.push({ level: "block", text: "Skill 不合法", detail: detected.reason || "SKILL.md frontmatter 缺字段" });
	}

	if (scripts.length > 0) {
		reasons.push({
			level: "warn",
			text: "含安装期脚本：" + scripts.map((s) => s.name).join("、"),
			detail: scripts.map((s) => s.name + ": " + s.command).join("\n")
		});
	}
	if (scan.severity === "high") {
		reasons.push({ level: "warn", text: "静态扫描发现高危能力信号", detail: scan.summary });
	} else if (scan.severity === "medium") {
		reasons.push({ level: "warn", text: "静态扫描发现中危能力", detail: scan.summary });
	} else if (scan.severity === "low") {
		reasons.push({ level: "info", text: "静态扫描：只有低危特征", detail: scan.summary });
	}

	/* 用途 vs 权限：先推断它是干什么的，再看它要的能力对不对得上（R3）。
	   只影响「要不要停下来问你」，不阻断安装；用途认不出来就明确写「未判」。 */
	const purpose = judgePurpose({ detected, scan, scripts, files: scan.scanned || [] });
	if (purpose.verdict === "error") {
		reasons.push({ level: "warn", text: "权限与用途不符：" + purpose.summary, detail: purpose.plain + "\n" + purpose.findings.map((f) => "· " + f.text).join("\n") });
	} else if (purpose.verdict === "warn") {
		reasons.push({ level: "info", text: "权限略超用途范围：" + purpose.summary, detail: purpose.plain });
	} else if (purpose.verdict === "ok") {
		reasons.push({ level: "info", text: "用途与权限匹配", detail: purpose.summary });
	}

	// 信任策略
	const trustNotes = [];
	if (trust.known === false) {
		trustNotes.push("读不到 profile 的 pnpm-workspace.yaml，无法确认 trustPolicy");
	} else if (trust.policy !== "no-downgrade") {
		trustNotes.push("pnpm 的 trustPolicy 未设为 no-downgrade（无法阻断「可信版本被降级替换」）");
	} else {
		trustNotes.push("pnpm trustPolicy = no-downgrade ✓");
	}
	const rep = input.reputation || null;
	let provenance = null;
	if (rep) {
		if (rep.ok) {
			provenance = {
				available: Boolean(rep.provenance),
				signed: Boolean(rep.signed),
				publishedAt: rep.publishedAt || null,
				maintainers: rep.maintainers || null
			};
			trustNotes.push(rep.provenance ? "npm provenance（构建来源证明）✓ —— 只证明「从哪个仓库构建」，不证明代码安全" : "没有 npm provenance");
		} else {
			trustNotes.push("来源声誉查询失败（" + (rep.error || "断网/超时") + "）：降级为「无法确认来源声誉」");
		}
	}
	if (input.source && input.source.type === "local") trustNotes.push("来源是本机文件：跳过 registry 声誉检查");

	/* 要不要跑异步 AI 审查，交给 ai.js 的 reviewWorthIt 统一判（R4）：
	   只有「安装脚本 / 提示注入 / 高危命中 / 用途不符」值得花那 ≈2.5k token；
	   其余情况显式写明「跳过 + 为什么」，而不是偷偷花钱换一个 inconclusive。

	   R6：审核档位在这里分流 ——
	   · 普通 = 上面这套（= R5.1 的现有强度，默认档就是标准版）；
	   · 严格 = 只要检出任何能力特征就停下来问一次，且**连中危常规能力也审**；
	   · 关闭 = 不再停下来问、也不调模型，但**阻断项照旧**（profile / 未识别 / 版本不兼容 / bundle 不完整）。 */
	const reviewLevel = (input.settings && input.settings.reviewLevel) || "normal";
	let review = reviewWorthIt({ scan, scripts, purpose });
	let needsAiReview = review.yes;
	if (reviewLevel === "strict" && !needsAiReview && (scan.hits || []).length > 0) {
		needsAiReview = true;
		review = { yes: true, why: "严格档：有 " + scan.hits.length + " 处能力命中，宁可多审一次" };
	} else if (reviewLevel === "off") {
		needsAiReview = false;
		review = { yes: false, why: "审核已在设置里关闭" };
	}
	/* ⑤ 工具注册契约（R8）：0.2.1 起漏 `output` 会让插件在下次启动整体失活，
	   而 required 插件失活还会让整次启动中止（恢复对话框 + 一串「等待服务」）。
	   装之前就扫一遍，别等重启后才发现。 */
	let contract = null;
	if (detected && detected.kind === "bundle" && detected.root) {
		contract = await scanToolContract(detected.root, { maxFiles: 150 }).catch(() => null);
		if (contract && contract.violations.length > 0) {
			const tools = contract.violations.slice(0, 8).map((v) => v.tool).join("、");
			reasons.push({
				level: "warn",
				text: "工具注册契约：检测到 " + contract.violations.length + " 个工具定义没声明 output（" + tools + "）",
				detail: "DSH 0.2.1 起 ctx.tools.register() 要求 output { schema, render }；漏了不是静默降级，插件激活会失败，required 插件还会让整次启动中止。静态扫描是近似判据（builder 动态生成的工具扫不到）；确认要装就继续，装完 doctor 会再扫一遍。"
			});
			fixes.push({ label: "让作者补 output { schema, render }（模板见 skill dsh-selfrepair 陷阱⑤）", command: null });
			fixes.push({ label: "先不装：换一个兼容 0.2.1 的版本", command: null });
		}
	}

	const blocked = reasons.some((r) => r.level === "block");
	const warned = reasons.some((r) => r.level === "warn");
	let needsConfirm = !blocked && (warned || needsAiReview || compatVerdict === "unknown");
	if (reviewLevel === "strict" && !blocked && !needsConfirm && ((scan.hits || []).length > 0 || scripts.length > 0)) {
		needsConfirm = true;
		reasons.push({
			level: "info",
			text: "严格档：检出能力特征就停下问你一次",
			detail: "这是你在设置里选的强度（严格 / 普通 / 关闭）。普通档下这类情况不会停下来。"
		});
	}
	if (reviewLevel === "off" && !blocked) {
		needsConfirm = false;
		reasons.push({
			level: "info",
			text: "审核已关闭：不再停下来确认，也不会花 token 做 AI 审查",
			detail: "风险提示仍然全部展示。真正装不了的东西（profile / 无法识别 / 版本不兼容 / bundle 不完整）照样阻断；装完仍会做诊断，出问题可一键回滚。改回「普通」在面板右上角「设置」。"
		});
	}

	if (needsAiReview) {
		reasons.push({
			level: "info",
			text: "已标记：安装后异步跑一次 AI 语义审查（" + review.why + "）",
			detail: "只喂被标记的文件片段 + 安装脚本 + manifest 声明，不读整包；AI 判 malicious 会红点提示并给一键回滚。"
		});
	} else {
		reasons.push({ level: "info", text: "跳过 AI 语义审查（省 token）", detail: review.why });
	}

	return {
		ok: !blocked,
		blocked,
		needsConfirm,
		needsAiReview,
		severity: scan.severity,
		reasons,
		fixes,
		compat: {
			verdict: compatVerdict,
			via: official.via,
			runtimeVersion: official.runtimeVersion,
			requirements: official.requirements,
			exempted: official.exempted,
			checks,
			node: nodeCheck,
			host
		},
		trust: { pnpmTrustPolicy: trust.policy, notes: trustNotes, provenance },
		installed,
		/* R8：工具注册契约的静态扫描结果（null = 没扫/不是插件包） */
		contract,
		/* 审核档位回传：面板显示、诊断与审查都能核对「这次是按哪一档判的」 */
		reviewLevel,
		purpose,
		risks: {
			severity: scan.severity,
			summary: scan.summary,
			hits: scan.hits,
			combos: scan.combos,
			/* density：每类能力出现在几个文件里（跨文件精确数）。面板与审查都靠它区分
			   「一个文件里有一处 fetch」和「74 个文件都在联网」。 */
			density: scan.density || {},
			scripts,
			scanned: (scan.scanned || []).length,
			skipped: scan.skipped || []
		}
	};
}

/** npm 来源的声誉查询（失败不阻断）。 */
export async function npmReputation(name) {
	if (!name) return { ok: false, error: "缺少包名" };
	try {
		const res = await fetch("https://registry.npmjs.org/" + encodeURIComponent(name).replace("%40", "@"), {
			headers: { "user-agent": "dsh-plugin-installer/0.1", accept: "application/json" },
			signal: AbortSignal.timeout(12000)
		});
		if (!res.ok) return { ok: false, error: "HTTP " + res.status };
		const data = await res.json();
		const latest = data["dist-tags"] && data["dist-tags"].latest;
		const version = latest && data.versions ? data.versions[latest] : null;
		const time = data.time || {};
		return {
			ok: true,
			latest,
			publishedAt: latest ? time[latest] || null : null,
			createdAt: time.created || null,
			maintainers: Array.isArray(data.maintainers) ? data.maintainers.length : null,
			provenance: Boolean(version && version.dist && version.dist.attestations && version.dist.attestations.provenance),
			signed: Boolean(version && version.dist && version.dist.signatures && version.dist.signatures.length)
		};
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}
