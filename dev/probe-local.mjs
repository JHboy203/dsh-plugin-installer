/**
 * dev/probe-local.mjs — 对**本机目录**跑一遍面板判据（只读探针，R33）。
 *
 * 为什么需要它：`lib/probe.js` / `install_hub_probe_repo` 只收 GitHub 仓库与 npm 包，
 * 而「用户把本机压缩包拖进面板」是最常见的路径 —— 想先看它会得到什么回答，以前只能真提交一次
 * （真建任务、真改红点）。这一条把那条路变成可复跑的一条命令，**不安装、不动 profile、不建任务**。
 *
 * 跑法：
 *   node dev/probe-local.mjs "D:/某个解包目录"
 *   host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/probe-local.mjs", args: ["<目录>"] })
 *
 * 判据与面板完全同一份：`detectKind` → `scanTree` → `judgePurpose` → `precheck`。
 * 最后一行 `PROBE_LOCAL_JSON {...}` 是完整结论（给人复核用）。
 */
import { precheck } from "../lib/precheck.js";
import { detectKind } from "../lib/detect.js";
import { judgePurpose } from "../lib/purpose.js";
import { scanTree } from "../lib/scan.js";

const target = process.argv[2] || "";

function line(level, text) {
	const mark = level === "block" ? "✗" : level === "warn" ? "!" : "·";
	return "  " + mark + " " + text;
}

async function main() {
	if (!target) {
		console.log("用法：node dev/probe-local.mjs <本机目录>");
		process.exit(2);
	}
	const detected = await detectKind(target, {});
	const scan = await scanTree(detected.tree.files, {});
	const purpose = judgePurpose({ detected, scan, scripts: [], files: detected.tree.files });
	const pc = await precheck({ detected, scan, scripts: [], purpose, source: { type: "local" } });

	const kindLabel = { bundle: "DSH 插件（bundle）", skill: "Skill", profile: "profile 清单（不可装）", unknown: "未识别" }[detected.kind] || detected.kind;
	console.log("识别：" + kindLabel + (detected.installable ? " · 可装" : " · 不可装"));
	if (detected.reason) console.log("  理由：" + detected.reason);
	const foreign = detected.foreign || null;
	if (foreign) {
		console.log("它是：" + foreign.label);
		console.log("  为什么不能这样装：" + foreign.why);
		console.log("  正确用法：" + foreign.howTo);
		if (Array.isArray(foreign.evidence) && foreign.evidence.length > 0) console.log("  判据：" + foreign.evidence.join("；"));
	}
	if (Number(detected.skillCount) > 1) {
		console.log("注意：目录里有 " + detected.skillCount + " 个 SKILL.md，真装只会装一个（" + ((detected.skills || [])[0] || {}).name + "）");
	}
	console.log("静态扫描：" + scan.severity + " · " + scan.summary);
	const coverage = scan.coverage || {};
	console.log(
		"  覆盖：" + (coverage.scannedSource || 0) + "/" + (coverage.sourceFiles || 0) + " 个源码文件" +
			(coverage.complete ? "（扫全了）" : "（没扫全：" + (coverage.unscanned || []).slice(0, 4).join("、") + "）")
	);
	for (const skip of (scan.skipped || []).slice(0, 4)) console.log("  跳过：" + skip.rel + " —— " + skip.reason);
	console.log("用途对账：" + purpose.summary);
	console.log("预检：" + (pc.blocked ? "会阻断" : pc.needsConfirm ? "会停下来等你确认" : "直接放行") +
		" · severity " + pc.severity +
		(pc.needsAiReview ? " · 会触发一次 AI 审查" : " · 不会花 token"));
	for (const reason of (pc.reasons || []).slice(0, 6)) {
		console.log(line(reason.level, reason.text));
		if (reason.detail) console.log("      " + String(reason.detail).split("\n").join("\n      "));
	}
	for (const fix of pc.fixes || []) console.log("  → " + fix.label + (fix.command ? "（`" + fix.command + "`）" : ""));
	console.log("PROBE_LOCAL_JSON " + JSON.stringify({
		kind: detected.kind,
		installable: detected.installable,
		foreign: foreign ? { family: foreign.family, label: foreign.label } : null,
		scan: { severity: scan.severity, summary: scan.summary, coverage },
		purposeVerdict: purpose.verdict,
		precheck: { blocked: pc.blocked, needsConfirm: pc.needsConfirm, needsAiReview: pc.needsAiReview, severity: pc.severity }
	}));
}

main().catch((e) => {
	console.log("PROBE_FAIL " + String((e && e.stack) || e));
	process.exitCode = 1;
});
