/**
 * dev/probe-repo.mjs — 只读探针：把一个 GitHub 仓库/链接「下载→解包→识别→静态扫描→预检+用途判定」
 * 走一遍，**不安装、不写 profile**，把结论写成 JSON 打到 stdout。
 *
 * 为什么需要它：面板流水线要安装才会跑完，而安装会触发宿主重启；只想「先看看这东西要什么权限」
 * 的时候不该付那次重启。宿主进程里跑（沙箱里不能写 data/、不能 spawn）：
 *
 *   host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/probe-repo.mjs",
 *                    args: ["https://github.com/owner/repo"] })
 *
 * 输出最后一行是 `PROBE_JSON {...}`，整份报告另存 data/probe/<时间戳>.json。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyInput } from "../lib/urls.js";
import { downloadToFile, resolveGithub, resolveNpmSpec } from "../lib/download.js";
import { DEFAULT_LIMITS, extractToDir, sniffFormat } from "../lib/formats.js";
import { detectKind } from "../lib/detect.js";
import { scanTree } from "../lib/scan.js";
import { precheck } from "../lib/precheck.js";
import { judgePurpose } from "../lib/purpose.js";
import { judgeTrust } from "../lib/sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "data");
const raw = process.argv[2] || "";
const outDir = join(DATA, "probe");

async function main() {
	if (!raw) {
		console.log("用法：node dev/probe-repo.mjs <链接|github:owner/repo|npm 包名>");
		process.exit(2);
	}
	const desc = classifyInput(raw);
	const report = { input: raw, desc, at: new Date().toISOString(), steps: [] };
	await mkdir(outDir, { recursive: true });
	const work = join(outDir, "work-" + Date.now());
	await mkdir(work, { recursive: true });

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
		const got = await downloadToFile(resolved.url, work, { fileName: resolved.fileName || "pkg.tgz", timeoutMs: 120000 });
		archivePath = got.path;
		report.download = { path: got.path, bytes: got.bytes };
	} else if (desc.kind === "npm-spec") {
		const spec = await resolveNpmSpec(desc.spec);
		report.npm = { name: spec.name, version: spec.version };
		const got = await downloadToFile(spec.tarball, work, { fileName: "pkg.tgz", timeoutMs: 120000 });
		archivePath = got.path;
		report.download = { path: got.path, bytes: got.bytes };
	} else {
		console.log("PROBE_SKIP 这个输入类型不在探针范围（只支持 github 仓库与 npm spec）：" + desc.kind);
		return;
	}

	const buf = await readFile(archivePath);
	const sniff = sniffFormat(buf);
	report.sniff = sniff;
	if (sniff.family !== "archive") {
		console.log("PROBE_JSON " + JSON.stringify({ ...report, error: "不是可解归档：" + sniff.label }, null, 1));
		return;
	}
	const extractRoot = join(work, "x");
	const stats = await extractToDir(buf, sniff.format, extractRoot, DEFAULT_LIMITS);
	report.extract = { files: stats.files, bytes: stats.bytes };

	const detected = await detectKind(extractRoot, {});
	report.detected = {
		kind: detected.kind,
		name: detected.name,
		version: detected.version,
		description: detected.description,
		installable: detected.installable,
		reason: detected.reason || null,
		files: detected.files || null
	};

	const files = [];
	for (const rel of await listFiles(extractRoot)) files.push({ rel, path: join(extractRoot, rel), size: 0 });
	const scan = await scanTree(files, {});
	report.scan = {
		severity: scan.severity,
		summary: scan.summary,
		/* R5：density 与 combos 是判断陌生仓库最有用的两个信号 ——
		   「74 个文件都在联网」比「×5」有信息量得多；打包产物特征也必须落盘，
		   否则下一次读这份报告的人还是会去逐条数命中。 */
		density: scan.density,
		combos: scan.combos,
		counts: scan.counts,
		scanned: (scan.scanned || []).length,
		hits: scan.hits.slice(0, 40).map((h) => ({ kind: h.kind, severity: h.severity, file: h.file, line: h.line, excerpt: h.excerpt }))
	};

	const scripts = [];
	const pkgRel = files.map((f) => f.rel).find((rel) => /(^|\/)package\.json$/.test(rel));
	if (pkgRel) {
		try {
			const pkg = JSON.parse(await readFile(join(extractRoot, pkgRel), "utf8"));
			for (const name of ["preinstall", "install", "postinstall"]) {
				if (pkg.scripts && pkg.scripts[name]) scripts.push({ name, command: String(pkg.scripts[name]) });
			}
		} catch {
			/* ignore */
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

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = join(outDir, "probe-" + stamp + ".json");
	await writeFile(file, JSON.stringify(report, null, 2), "utf8");
	report.reportFile = file;
	console.log("PROBE_JSON " + JSON.stringify(report, null, 1));
	await rm(work, { recursive: true, force: true }).catch(() => {});
}

async function listFiles(root, rel = "", out = []) {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(join(root, rel), { withFileTypes: true });
	for (const e of entries) {
		const childRel = rel ? rel + "/" + e.name : e.name;
		if (e.isDirectory()) await listFiles(root, childRel, out);
		else out.push(childRel);
	}
	return out;
}

main().catch((e) => {
	console.log("PROBE_FAIL " + String((e && e.stack) || e));
	process.exitCode = 1;
});
