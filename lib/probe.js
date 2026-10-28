/**
 * probe.js — 「这个链接到底是什么？装上去会怎样？」**只读探针**（R32，从 dev 脚本固化而来）。
 *
 * 原来这条路只有 `dev/probe-repo.mjs` 一条（要由人/AI 在宿主进程里手动跑）。R32 把它抽成模块，
 * 于是两处都能用、判据只有一份：
 *   · `dev/probe-repo.mjs`（命令行 / host_selfcheck 探针）；
 *   · **工具 `install_hub_probe_repo`** —— 模型可以直接问「这个仓库是 DSH 插件吗、要什么权限」，
 *     而**不必先装一遍**（装一遍会改 profile、还要重启宿主，代价高得多）。
 *
 * 纪律：**不安装、不写 profile、不改任务历史**。唯一副作用是可选地落一份 JSON 报告
 * （`data/probe/probe-*.json`）与临时解包目录（跑完就删）。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { classifyInput } from "./urls.js";
import { downloadToFile, resolveGithub, resolveNpmSpec } from "./download.js";
import { DEFAULT_LIMITS, extractToDir, sniffFormat } from "./formats.js";
import { detectKind } from "./detect.js";
import { scanTree } from "./scan.js";
import { precheck } from "./precheck.js";
import { judgePurpose } from "./purpose.js";
import { judgeTrust } from "./sources.js";

async function listFiles(root, rel = "", out = []) {
	const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
	for (const e of entries) {
		const childRel = rel ? rel + "/" + e.name : e.name;
		if (e.isDirectory()) await listFiles(root, childRel, out);
		else out.push(childRel);
	}
	return out;
}

/**
 * 探一个仓库 / npm 包（**只读**）。
 *
 * @param {object} input
 * @param {string} input.input 链接 / `github:owner/repo` / npm 包名（可带版本）
 * @param {string} input.workDir 解包用的临时目录（调用方负责清；本函数只清里面的 x/）
 * @param {string|null} [input.outDir] 给了就落一份 JSON 报告
 * @returns {Promise<{ok:boolean, reason?:string, message?:string, report?:object}>}
 */
export async function probeRepo({ input, workDir, outDir = null } = {}) {
	const raw = String(input || "").trim();
	if (!raw) return { ok: false, reason: "empty", message: "没有输入" };
	const desc = classifyInput(raw);
	if (desc.kind !== "github-repo" && desc.kind !== "npm-spec") {
		return {
			ok: false,
			reason: "unsupported-input",
			message: "只探 GitHub 仓库与 npm 包（现在这个是：" + (desc.label || desc.kind) + "）"
		};
	}
	const report = { input: raw, desc, at: new Date().toISOString() };
	await mkdir(workDir, { recursive: true });
	let archivePath = null;
	if (desc.kind === "github-repo") {
		const resolved = await resolveGithub(desc);
		report.repo = resolved.meta || null;
		report.resolve = { url: resolved.url || null, fileName: resolved.fileName || null, notes: resolved.notes || [], ref: resolved.ref || null };
		if (resolved.meta) {
			report.trust = judgeTrust({
				name: resolved.meta.fullName,
				owner: String(resolved.meta.fullName || "").split("/")[0],
				license: resolved.meta.license,
				repoUrl: "https://github.com/" + resolved.meta.fullName,
				stars: resolved.meta.stars,
				archived: resolved.meta.archived
			});
		}
		const got = await downloadToFile(resolved.url, workDir, { fileName: resolved.fileName || "pkg.tgz", timeoutMs: 120000 });
		archivePath = got.path;
		report.download = { bytes: got.bytes };
	} else {
		const spec = await resolveNpmSpec(desc.spec);
		report.npm = { name: spec.name, version: spec.version };
		const got = await downloadToFile(spec.tarball, workDir, { fileName: "pkg.tgz", timeoutMs: 120000 });
		archivePath = got.path;
		report.download = { bytes: got.bytes };
	}

	const buf = await readFile(archivePath);
	const sniff = sniffFormat(buf);
	report.sniff = { format: sniff.format, label: sniff.label, family: sniff.family };
	if (sniff.family !== "archive") {
		return { ok: false, reason: "not-archive", message: "不是可解归档：" + sniff.label, report };
	}
	const extractRoot = join(workDir, "x");
	const stats = await extractToDir(buf, sniff.format, extractRoot, DEFAULT_LIMITS);
	report.extract = { files: stats.files, bytes: stats.bytes };

	const detected = await detectKind(extractRoot, {});
	report.detected = {
		kind: detected.kind,
		name: detected.name || null,
		version: detected.version || null,
		description: detected.description || null,
		installable: detected.installable,
		reason: detected.reason || null,
		/* R32：非 DSH 资产的身份（MCP / VS Code / Obsidian / Python / CLI / 库） */
		foreign: detected.foreign || null,
		skillCount: detected.skillCount || 0,
		skills: detected.skills || []
	};

	const paths = await listFiles(extractRoot);
	const files = paths.map((rel) => ({ rel, path: join(extractRoot, rel), size: 0 }));
	const scan = await scanTree(files, {});
	report.scan = {
		severity: scan.severity,
		summary: scan.summary,
		/* density 与 combos 是判断陌生仓库最有用的两个信号：「74 个文件都在联网」比「×5」有信息量 */
		density: scan.density,
		combos: scan.combos,
		scanned: (scan.scanned || []).length,
		hits: (scan.hits || []).slice(0, 30).map((h) => ({ kind: h.kind, severity: h.severity, file: h.file, line: h.line, excerpt: h.excerpt }))
	};

	const scripts = [];
	const pkgRel = paths.find((rel) => /(^|\/)package\.json$/.test(rel));
	if (pkgRel) {
		try {
			const pkg = JSON.parse(await readFile(join(extractRoot, pkgRel), "utf8"));
			for (const name of ["preinstall", "install", "postinstall"]) {
				if (pkg.scripts && pkg.scripts[name]) scripts.push({ name, command: String(pkg.scripts[name]) });
			}
		} catch {
			/* 读不懂就当没有安装脚本 */
		}
	}

	const purpose = judgePurpose({ detected, scan, scripts, files });
	report.purpose = {
		purpose: purpose.purpose,
		verdict: purpose.verdict,
		score: purpose.score,
		summary: purpose.summary,
		plain: purpose.plain,
		findings: purpose.findings,
		advice: purpose.advice,
		present: purpose.present,
		unexpected: purpose.unexpected,
		tolerated: purpose.tolerated
	};

	const pc = await precheck({ detected, scan, scripts, source: { type: desc.kind } });
	report.precheck = {
		ok: pc.ok,
		blocked: pc.blocked,
		needsConfirm: pc.needsConfirm,
		needsAiReview: pc.needsAiReview,
		severity: pc.severity,
		compat: { verdict: pc.compat.verdict, runtimeVersion: pc.compat.runtimeVersion, checks: pc.compat.checks },
		reasons: pc.reasons,
		fixes: pc.fixes,
		trust: pc.trust,
		purpose: pc.purpose ? { verdict: pc.purpose.verdict, summary: pc.purpose.summary } : null
	};

	if (outDir) {
		await mkdir(outDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = join(outDir, "probe-" + stamp + ".json");
		await writeFile(file, JSON.stringify(report, null, 2), "utf8");
		report.reportFile = file;
	}
	await rm(extractRoot, { recursive: true, force: true }).catch(() => null);
	return { ok: true, report };
}

/** 工具输出用的几行摘要（纯函数：只吃 report）。 */
export function summarizeProbe(report) {
	if (!report) return [];
	const lines = [];
	const detected = report.detected || {};
	const kindLabel = { bundle: "DSH 插件（bundle）", skill: "Skill", profile: "profile 清单（不可装）", unknown: "未识别" }[detected.kind] || detected.kind || "?";
	lines.push("识别：" + kindLabel + (detected.name ? " · " + detected.name : "") + (detected.version ? "@" + detected.version : "") +
		(detected.installable ? " · 可装" : " · 不可装"));
	if (detected.foreign) {
		lines.push("它是：" + detected.foreign.label);
		lines.push("  为什么不能这样装：" + detected.foreign.why);
		lines.push("  正确用法：" + detected.foreign.howTo);
		if (Array.isArray(detected.foreign.evidence) && detected.foreign.evidence.length > 0) lines.push("  判据：" + detected.foreign.evidence.join("；"));
	}
	if (Number(detected.skillCount) > 1) {
		lines.push("注意：仓库里有 " + detected.skillCount + " 个 SKILL.md，真装只会装一个（" + (detected.skills[0] || {}).name + "）");
	}
	const scan = report.scan || {};
	if (scan.summary) lines.push("静态扫描：" + scan.summary + (scan.combos && scan.combos.length ? " · 组合信号 " + scan.combos.map((c) => c.kind).join("/") : ""));
	const purpose = report.purpose || {};
	if (purpose.summary) lines.push("用途对账：" + purpose.summary + (purpose.verdict ? "（" + purpose.verdict + "）" : ""));
	const pc = report.precheck || {};
	lines.push("预检：" + (pc.blocked ? "会阻断" : pc.needsConfirm ? "会停下来等你确认" : "直接放行") +
		(pc.severity ? " · severity " + pc.severity : "") +
		(pc.needsAiReview ? " · 会触发一次 AI 审查（≈2k token）" : " · 不会花 token"));
	for (const reason of (pc.reasons || []).slice(0, 4)) {
		lines.push("  " + (reason.level === "block" ? "✗" : reason.level === "warn" ? "!" : "·") + " " + reason.text);
	}
	if (report.reportFile) lines.push("报告：" + report.reportFile);
	return lines;
}
