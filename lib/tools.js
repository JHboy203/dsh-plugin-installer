/**
 * tools.js — 给 Agent 用的五个宿主工具（不装、只递请求）。
 *
 *   install_hub_status           面板与宿主状态（只读）
 *   install_hub_search_plugins   确定性搜索候选（6 个源：npm ×2 / GitHub ×3 / dsh-hub 商店）
 *   install_hub_submit_request   提交一次安装请求 → 交给流水线（**不直接安装**）
 *   install_hub_review           对某个任务跑一次 AI 语义审查
 *   install_hub_doctor           安装环境体检 + 幂等修复
 *
 * ⚠️ DSH 0.2.1 起每个工具都必须声明 `output: { schema, render }`；漏了会让
 *    `ctx.tools.register()` 抛错、整个插件静默失活。这里统一走 TOOL_OUTPUT。
 * ⚠️ 返回值必须是 lossless JSON（不能有 undefined）—— 一律过 prune()。
 */

import { describeSettings } from "./settings.js";
import { describeFreshness, freshness } from "./codestamp.js";
import { clockText } from "./updates.js";
import { describeCrash } from "./profilehealth.js";

function compileParameters(spec) {
	const properties = {};
	const required = [];
	for (const [key, prop] of Object.entries(spec)) {
		if (prop && prop.required === true) required.push(key);
		const node = {};
		if (prop && typeof prop.type === "string") node.type = prop.type;
		if (prop && typeof prop.description === "string") node.description = prop.description;
		if (prop && Array.isArray(prop.enum)) node.enum = prop.enum;
		properties[key] = node;
	}
	return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

function prune(value) {	if (Array.isArray(value)) {
		return value.map((item) => {
			const pruned = prune(item);
			return pruned === undefined ? null : pruned;
		});
	}
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			if (item === undefined) continue;
			const pruned = prune(item);
			if (pruned !== undefined) out[key] = pruned;
		}
		return out;
	}
	if (typeof value === "function") return undefined;
	if (typeof value === "number" && !Number.isFinite(value)) return null;
	return value;
}

function withText(payload, lines) {
	const text = lines.filter((line) => typeof line === "string" && line !== "").join("\n");
	return prune({ ...payload, text });
}

const renderToolResult = (_args, value) => {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (value !== null && typeof value === "object" && typeof value.text === "string") {
		return [{ type: "text", text: value.text }];
	}
	return [{ type: "text", text: JSON.stringify(value) }];
};

const TOOL_OUTPUT = { schema: { type: "object" }, render: renderToolResult };

function stageLine(job) {
	if (!job) return "· 没有活动任务";
	const stages = Array.isArray(job.stages) ? job.stages : [];
	const done = stages.filter((s) => s.status === "ok").length;
	const failed = stages.find((s) => s.status === "fail");
	const running = stages.find((s) => s.status === "running");
	const current = failed || running || stages.find((s) => s.status === "warn") || null;
	return "· 任务 " + job.id + "（" + job.status + "）：" + done + "/" + stages.length +
		" 步完成" + (current ? " · 当前 " + current.label + (current.detail ? " — " + current.detail : "") : "");
}

/**
 * @param {{installer: import('./pipeline.js').Installer, ctx: object}} deps
 */
export function buildInstallerTools(deps) {
	const { installer } = deps;

	return [
		{
			name: "install_hub_status",
			description:
				"插件安装面板体检（只读）。给：宿主版本 / profile / 技能根目录、是否有任务在跑、最近几个任务的状态与诊断结论、" +
				"**已装插件清单**（本地读，含 npm / 本机 link / 本面板装的 .tgz / Git 四类来源）、" +
				"**已装 Skill**（磁盘目录 × 宿主技能清单对账：没被认 / 重名 / 备份残留）、" +
				"以及面板能复用的生态组件（插件管家 / 技能管理 / 移动端适配）是否已装。" +
				"`updates:true` 会联网比对 npm 最新版并列出可升级的包（默认不联网）。 " +
				"★ 用户说「面板里那个装失败了」「装完没反应」「哪些插件能升级」时先跑它：它直接读面板的持久化状态，不靠猜。",
			parameters: compileParameters({
				verbose: { type: "boolean", description: "带上每个任务的全部阶段与诊断明细（默认只给摘要）" },
				updates: { type: "boolean", description: "联网比对已装插件的 npm 最新版（默认 false；30 分钟内同结果走缓存）" }
			}),
			output: TOOL_OUTPUT,
			async execute(args) {
				const verbose = args?.verbose === true;
				const state = await installer.snapshotState();
				const eco = await installer.integrations();
				const lines = [];
				lines.push("插件安装面板 · 状态");
				lines.push("· 宿主 DSH " + (state.host.dsh || "未知") + "（dsh-tools " + (state.host.dshTools || "?") + "）· Node " + state.host.node);
				/* R5.1：宿主侧不热重载 —— 「跑的是哪一版」必须能在这一行读出来。
				   build 由源码 mtime 生成，改了 index.js/lib/*.js 就会变。 */
				lines.push("· 本插件构建：" + (state.host.build || "未知"));
				/* R11：构建标签只说明**磁盘**新；这一行才回答「跑的是不是磁盘这一版」。 */
				const code = await freshness().catch(() => null);
				lines.push("· 运行中的代码：" + describeFreshness(code));
				/* R6：设置摘要一行看完（提醒 / 审核档位 / 跳过审核按钮 / 轮询 / 源） */
				lines.push("· 设置：" + describeSettings(state.settings));
				lines.push("· profile：" + state.host.profile + " · " + (state.host.profileDir || "?"));
				lines.push("· 技能根：" + (state.host.skillRoots || []).join(" | "));
				lines.push(state.active ? stageLine(state.active) : "· 当前没有活动任务");
				lines.push("· 红点：" + (state.attention.dot ? state.attention.count + " 条待处理" : "无"));
				for (const item of state.attention.items) lines.push("  · [" + item.status + "] " + item.title + " — " + item.reason);
				/* R11：把「两个会静默卡住安装的环境事实」并进这一行 —— 它们都不需要模型去修，
				   但不知道就等于没有：版本豁免失效会让插件安静消失，待批准脚本会让下一次安装
				   卡在同一个包上。两条都只读、都只提醒。 */
				const envLine = await installer.environmentCaveats().catch(() => null);
				if (envLine) lines.push("· 环境注意：" + envLine);
				/* R13：激活状态一行 —— 「装了 ≠ 起来了」。
				   这里只看 fiberPhase（纯内存，不扫源码）；有缺口的明细在 install_hub_doctor
				   与 GET /activation。默认只在**有缺口时**才多占一行，全都在跑就并进这一行。 */
				const actLine = typeof installer.activationLine === "function" ? await installer.activationLine().catch(() => null) : null;
				if (actLine) lines.push("· 激活：" + actLine);
				/* R12：已装清单 + 可升级项。清单是**本地读**（30 秒缓存）；只有 updates:true 才联网。
				   这里刻意不 dump 全量 44 条 —— 那是 ~9KB，而用户/模型要的是「哪些落后了」。
				   面板里点开才有逐条清单（GET /inventory）。 */
				let inv = null;
				if (args?.updates === true && typeof installer.checkUpdates === "function") {
					inv = await installer.checkUpdates().catch(() => null);
				} else if (typeof installer.inventoryView === "function") {
					inv = await installer.inventoryView().catch(() => null);
				}
				if (inv) {
					lines.push("· 已装：" + installer.inventoryLine(inv) +
						(Array.isArray(inv.problems) && inv.problems.length > 0 ? " · " + inv.problems.length + " 个声明了但没落地" : ""));
					if (inv.summary) {
						lines.push("· 更新：" + installer.updatesLine(inv.summary) + (inv.updatesAt ? "（" + clockText(inv.updatesAt) + " 检查）" : ""));
					} else {
						lines.push("· 更新：还没检查过（要查就 install_hub_status({updates:true})；只查可比对的 " +
							((inv.counts && inv.counts.checkable) || 0) + " 个包，30 分钟内走缓存）");
					}
					const outdated = (inv.items || []).filter((item) => item.update && item.update.relation === "outdated");
					for (const item of outdated.slice(0, 8)) {
						lines.push("  · 可升级 " + item.name + " " + (item.localVersion || "?") + " → " + item.update.latestVersion +
							(item.update.deprecated ? " ⚠ 该版本被作者标记弃用" : ""));
					}
					if (outdated.length > 8) lines.push("  · …还有 " + (outdated.length - 8) + " 个可升级（面板里看全）");
					const broken = (inv.items || []).filter((item) => item.update && item.update.error).slice(0, 3);
					for (const item of broken) lines.push("  · 查不到最新版 " + item.name + "：" + item.update.error);
				}
				/* R14：Skill 那一半。与已装插件同一条流水，但判据完全不同 ——
				   技能没有版本，只有「宿主认不认」与「名字撞不撞」。 */
				const skillView = typeof installer.skills === "function" ? await installer.skills().catch(() => null) : null;
				if (skillView) {
					lines.push("· Skill：" + installer.skillsLine(skillView));
					if (skillView.counts && skillView.counts.notVisible > 0) {
						lines.push("  · ⚠ 宿主没认 " + skillView.counts.notVisible + " 个：" +
							(skillView.notVisible || []).slice(0, 6).map((item) => item.name || item.dir).join("、") +
							"（装了但用不上；明细见面板「已装 Skill」）");
					}
					if (skillView.counts && skillView.counts.yamlBroken > 0) {
						lines.push("  · ⚠ frontmatter 写坏 " + skillView.counts.yamlBroken + " 个（宿主读不出 name → 整条跳过）：" +
							(skillView.yamlBroken || []).slice(0, 4).map((item) => item.dir).join("、") +
							"（改法：把那一行改成块标量 `description: >` 再用引号/缩进写正文）");
					}
					if (skillView.counts && skillView.counts.duplicates > 0) {
						lines.push("  · 重名 " + skillView.counts.duplicates + " 组（宿主只会用其中一份）" +
							(skillView.counts.backups > 0 ? "，其中备份残留 " + skillView.counts.backups + " 个" : ""));
					}
				}
				const recent = state.jobs.slice(0, 5);
				lines.push("· 最近任务：" + (recent.length === 0 ? "（空）" : ""));
				for (const job of recent) {
					const diag = job.diagnosis ? " · 诊断 " + job.diagnosis.verdict : "";
					const inst = job.install ? " · " + (job.install.kind === "skill" ? "技能 " + job.install.skillName : "插件 " + job.install.bundleName) : "";
					lines.push("  · " + job.id + " [" + job.status + "] " + (job.title || "") + inst + diag);
					if (job.error) lines.push("    错误：" + job.error.code + " " + job.error.message);
					/* R2：诊断不只报症状 —— 工具输出里也带一句大白话和第一条处置步骤，
					   这样不在面板前面的会话（AI 或人）也知道下一步干什么。 */
					if (job.diagnosis && job.diagnosis.plain) lines.push("    大白话：" + job.diagnosis.plain);
					/* R4：审查花没花 token、跳过了没有 —— 面板与工具给同一句话。 */
					if (job.review) {
						const rv = job.review;
						const cost = rv.estTokens && rv.estTokens.total ? "≈" + rv.estTokens.total + " token"
							: rv.estTokens && rv.estTokens.saved ? "省下 ≈" + rv.estTokens.saved + " token" : "";
						lines.push("    审查：" + (rv.status === "skipped"
							? "已跳过（" + (rv.skipReason || "常规能力，不需要模型判断") + "）"
							: (rv.verdict || rv.status)) + (cost ? " · " + cost : ""));
					}
					const firstFinding = job.diagnosis && Array.isArray(job.diagnosis.findings) ? job.diagnosis.findings[0] : null;
					if (firstFinding && Array.isArray(firstFinding.fix) && firstFinding.fix.length > 0) {
						const steps = firstFinding.fix
							.map((s) => (typeof s === "string" ? s : s && s.text))
							.filter(Boolean)
							.join("；");
						lines.push("    怎么解决：" + steps);
					}
					if (verbose && Array.isArray(job.stages)) {
						for (const stage of job.stages) {
							lines.push("    - " + stage.label + " [" + stage.status + "]" + (stage.detail ? " " + stage.detail : ""));
						}
					}
				}
				lines.push("· 生态组件：");
				for (const item of eco.bundles) {
					if (item.installed) lines.push("  · ✓ " + item.name + " — " + item.label);
				}
				const missing = eco.bundles.filter((b) => !b.installed).map((b) => b.name);
				if (missing.length > 0) lines.push("  · 未装：" + missing.join("、"));
				if (eco.remote && eco.remote.url) lines.push("· 远程访问地址：" + eco.remote.url);
				/* R12：清单只回摘要 + 可升级项（全量 44 条对工具调用者没有信息量） */
				const inventoryPayload = inv
					? {
						counts: inv.counts,
						summary: inv.summary || null,
						updatesAt: inv.updatesAt || null,
						problems: (inv.problems || []).slice(0, 4),
						outdated: (inv.items || [])
							.filter((item) => item.update && item.update.relation === "outdated")
							.map((item) => ({ name: item.name, localVersion: item.localVersion, latestVersion: item.update.latestVersion }))
					}
					: null;
				return withText({
					state: verbose ? state : { attention: state.attention, jobs: recent, host: state.host, settings: state.settings },
					integrations: eco,
					inventory: inventoryPayload
				}, lines);
			}
		},
		{
			name: "install_hub_search_plugins",
			description:
				"确定性搜索 DSH 插件 / Skill 候选（6 个源：npm registry 两串、GitHub 仓库两串 + topic 发现、" +
				"以及 dsh-hub.cc 商店目录；不调模型、不花 token，5 分钟内同查询走缓存）。" +
				"每条结果除 name / 来源 / spec 外，还带 trust（官方/许可证/有源码/活跃 + 红旗如无仓库、刷星、年轻爆款）" +
				"与 popularity（npm 周下载量、GitHub stars、商店评分与确认安装量、本机评分）。" +
				"★ 用户只给了一个功能描述或名字时先用它，再把其中一条丢给 install_hub_submit_request。",
			parameters: compileParameters({
				query: { type: "string", required: true, description: "功能描述或名字，例如「深色主题」「dsh-video」" },
				limit: { type: "number", description: "最多返回几条（默认 12）" }
			}),
			output: TOOL_OUTPUT,
			async execute(args) {
				const query = String(args?.query || "").trim();
				if (!query) return withText({ ok: false, items: [] }, ["query 不能为空"]);
				const result = await installer.search(query);
				const limit = Math.max(1, Math.min(30, Number(args?.limit) || 12));
				const items = result.items.slice(0, limit);
				const lines = ["搜索：" + query + " → " + items.length + " 条（多源，含可信度与知名度）" + (result.cached ? " · 5 分钟内缓存" : "")];
				for (const item of items) {
					const badges = item.trust && Array.isArray(item.trust.badges) ? item.trust.badges.map((b) => b.label) : [];
					const flags = item.trust && Array.isArray(item.trust.flags) ? item.trust.flags.map((f) => f.text) : [];
					const pops = [];
					if (typeof item.downloads === "number") pops.push("周下载 " + item.downloads);
					if (typeof item.installs === "number" && item.installs > 0) pops.push("装过 " + item.installs);
					if (item.rating && item.rating.average) pops.push("评分 " + item.rating.average + "(" + item.rating.count + ")");
					if (item.stars) pops.push("★" + item.stars);
					if (typeof item.rankScore === "number") pops.push("本机评分 " + Math.round(item.rankScore));
					lines.push("· " + item.name + (item.version ? "@" + item.version : "") + " [" + item.source + "]" +
						(badges.length ? " · " + badges.join(" / ") : "") +
						(pops.length ? " · " + pops.join(" · ") : "") +
						" — " + (item.description || "（无简介）").slice(0, 160));
					for (const flag of flags) lines.push("    ⚠ " + flag);
					lines.push("  提交用 spec：" + item.spec);
				}
				if (result.providers && result.providers.length > 0) {
					lines.push("· 源状态：" + result.providers.map((p) => p.id + (p.ok ? " " + p.count + " 条" : " 失败")).join("、"));
				}
				if (result.errors.length > 0) lines.push("· 部分来源失败：" + result.errors.join("；"));
				return withText({ ok: true, items, errors: result.errors, providers: result.providers || [] }, lines);
			}
		},
		{
			name: "install_hub_submit_request",
			description:
				"提交一次安装请求给面板的确定性流水线（下载→解包→识别→安全预检→快照→安装→诊断）。" +
				"**它只递请求，不直接安装**：预检发现风险时任务会停在「等待确认」，由人在面板里点确认。" +
				"输入可以是 GitHub 链接、Release 页、.tgz/.zip 直链、本机绝对路径，或 install_hub_search_plugins 给出的 spec。",
			parameters: compileParameters({
				input: { type: "string", required: true, description: "链接 / 本机路径 / npm spec / github:owner/repo" },
				note: { type: "string", description: "给用户看的一句话理由（为什么推荐装它）" }
			}),
			output: TOOL_OUTPUT,
			async execute(args) {
				const input = String(args?.input || "").trim();
				if (!input) return withText({ ok: false }, ["input 不能为空"]);
				const submitted = await installer.submit(input, { source: "tool" });
				if (!submitted.ok) {
					const lines = ["提交未通过：" + (submitted.message || submitted.reason)];
					if (Array.isArray(submitted.candidates && submitted.candidates.items)) {
						for (const item of submitted.candidates.items.slice(0, 6)) {
							lines.push("· 候选 " + item.name + " — " + (item.description || "").slice(0, 120) + "（spec：" + item.spec + "）");
						}
					}
					if (args?.note) lines.push("推荐理由：" + String(args.note));
					return withText({ ok: false, reason: submitted.reason, message: submitted.message, candidates: submitted.candidates || null }, lines);
				}
				const job = submitted.job;
				const lines = [];
				lines.push("已提交：" + (job.title || input));
				lines.push("· 任务 " + job.id + " · 状态 " + job.status);
				lines.push("· 面板会自动跑完剩余步骤；需要确认时侧栏会冒红点。");
				lines.push("· 安装执行在宿主侧完成，不消耗 token。");
				if (args?.note) lines.push("· 推荐理由：" + String(args.note));
				return withText({ ok: true, job }, lines);
			}
		},
		{
			name: "install_hub_review",
			description:
				"对某个安装任务跑一次 AI 语义审查（按需）。输入只有被静态扫描标记的片段 + 安装脚本 + manifest 声明，" +
				"内容被框定为数据并先做 secret redaction。判 malicious 会把任务标红并建议一键回滚；判 safe 不单独放行。",
			parameters: compileParameters({
				jobId: { type: "string", required: true, description: "任务 id（install_hub_status 里有）" }
			}),
			output: TOOL_OUTPUT,
			async execute(args) {
				const jobId = String(args?.jobId || "").trim();
				if (!jobId) return withText({ ok: false }, ["jobId 不能为空"]);
				const result = await installer.review(jobId);
				const job = result.job || null;
				const review = job && job.review ? job.review : null;
				const lines = [];
				if (!result.ok) lines.push("审查未执行：" + (result.message || "未知原因"));
				if (review) {
					lines.push("审查结果：" + (review.verdict || "?") + "（status " + review.status + (review.model ? " · " + review.model : "") + "）");
					if (review.error) lines.push("错误：" + review.error);
					for (const finding of review.findings || []) {
						lines.push("· [" + finding.severity + "] " + finding.title + " — " + (finding.why || finding.evidence || ""));
					}
					if (review.note) lines.push("· " + review.note);
				}
				return withText({ ok: result.ok, review, job: job ? { id: job.id, status: job.status, error: job.error } : null }, lines);
			}
		},
		{
			name: "install_hub_doctor",
			description:
				"安装环境 / profile 一次性体检 + 幂等修复（默认只读）。**换会话、装完/升级完、DSH 起不来或插件变少时，只要这一个工具**：" +
				"① profile 里多出来的 `@deepseek-ai/dsh-tools`（下次启动整片插件加载失败）；" +
				"② `file:` 依赖指向已删除的 .tgz；③ pnpm trustPolicy / git；" +
				"④ **已装插件的工具定义漏 `output`**（0.2.1 起会让插件失活、required 插件还会让整次启动中止）；" +
				"⑤ **`dsh.profile.bundles` 与 node_modules 对不上**（恢复对话框「禁用第三方插件」会把清单裁到 2 项）；" +
				"⑥ pnpm 的 dsh-tools 钉子是否随宿主升级过期；⑦ 最近一次启动失败（宿主崩溃 `*-host.log` / web 入口没激活 `*-web-boot.log`）" +
				"点名了哪些插件、属于已知签名里的哪一类。" +
				"apply=true 执行幂等修复：挪走 dsh-tools、补回 .tgz、把钉子同步到宿主版本、从最近快照写回 bundles/patch（写前自动再存快照）。",
			parameters: compileParameters({
				apply: { type: "boolean", description: "true 才真的修；默认只体检" },
				verbose: { type: "boolean", description: "带上每条发现的 detail 与处置步骤（默认只给一行结论，省 token）" },
				contract: { type: "boolean", description: "是否扫已装插件的 output 契约（默认 true；只想知道 bundles/崩溃时可设 false 提速）" }
			}),
			output: TOOL_OUTPUT,
			async execute(args) {
				const apply = args?.apply === true;
				const verbose = args?.verbose === true;
				const report = await installer.doctor({ apply, contract: args?.contract !== false });
				if (report && report.busy) {
					return withText({ ok: false, busy: true, error: report.error }, ["⚠️ " + report.error]);
				}
				const findings = Array.isArray(report.findings) ? report.findings : [];
				const actions = Array.isArray(report.actions) ? report.actions : [];
				const health = report.info && report.info.profileHealth ? report.info.profileHealth : null;
				const errors = findings.filter((f) => f.severity === "error");
				const warns = findings.filter((f) => f.severity === "warn");
				const infos = findings.filter((f) => f.severity === "info");
				const lines = [];
				lines.push("安装环境体检" + (apply ? "（已执行可修复项）" : "（只读）") + " · " +
					(errors.length > 0 ? errors.length + " 项错误" : warns.length > 0 ? warns.length + " 项提醒" : "全部通过"));
				const shadow = report.info && report.info.dshToolsShadow;
				lines.push("· profile " + ((report.info && report.info.profile) || "?") +
					" · dsh-tools " + (shadow && shadow.present ? "**有覆盖**" : "无") +
					" · file: 依赖 " + report.info.fileDeps + "（悬空 " + report.info.danglingFileDeps + "）" +
					(health ? " · bundles " + health.bundles + (health.bundlesTruncated ? "（**被裁**）" : "") : "") +
					(health && health.crash ? " · " + describeCrash(health.crash) : ""));
				const shown = [].concat(errors, warns, infos).slice(0, verbose ? 20 : 8);
				for (const f of shown) {
					lines.push("· [" + f.severity + "] " + f.title + (f.fixable ? "（可自动修复）" : ""));
					if (verbose && f.detail) {
						for (const part of String(f.detail).split("\n")) lines.push("    " + part);
					} else if (f.severity === "error" && Array.isArray(f.fix) && f.fix.length > 0) {
						const first = f.fix[0];
						lines.push("    → " + String((first && first.text) || first).split("\n")[0]);
					}
				}
				if (findings.length > shown.length) lines.push("· …还有 " + (findings.length - shown.length) + " 项（verbose:true 看全）");
				if (apply && actions.length > 0) {
					for (const a of actions) {
						lines.push("· " + a.kind + " → " + (a.ok
							? (a.skipped ? "跳过（" + a.skipped + "）" : "完成" + (a.detail ? "：" + a.detail : ""))
							: "失败：" + a.error));
					}
					if (Array.isArray(report.findingsAfter)) lines.push("· 修复后仍剩 " + report.findingsAfter.length + " 项（多为需要你决定的信息项）。");
					const changed = actions.filter((a) => a.ok && !a.skipped);
					if (changed.some((a) => /restore-bundles|sync-pnpm-override|quarantine|restore-tarball/.test(String(a.kind)))) {
						lines.push("⚠️ 改动要重启 DSH 才生效（bundles / patch / override 都是启动期读的）。");
					}
				} else {
					const fixable = findings.filter((f) => f.fixable).length;
					lines.push(fixable > 0 ? "→ 可自动修 " + fixable + " 项：install_hub_doctor({apply:true})" : "→ 没有可自动修项。");
				}
				const payload = {
					ok: errors.length === 0,
					apply,
					counts: { errors: errors.length, warns: warns.length, infos: infos.length },
					findings: findings.map((f) => ({ code: f.code, severity: f.severity, title: f.title, fixable: Boolean(f.fixable) })),
					actions,
					/* verbose 才回整份 report —— 默认只回摘要，省 token */
					...(verbose ? { report } : {})
				};
				return withText(payload, lines);
			}
		}
	];
}
