/**
 * dev/probe-pnpm-resolve.mjs — 「这条 pnpm 策略报错是包的问题，还是 profile 状态的问题？」
 *
 * 由来（2026-10-30）：升级 `@liustack/modsearch` 时报 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`
 * （6 条违规，没点名）。当时靠**手工**做对照实验才定性：把 profile 的三个清单复制到临时目录、
 * 让 pnpm 自己解析 —— 5.10.10 与 5.10.11 **都零违规**，说明违规来自 profile 的**陈旧 lockfile 状态**。
 * 这个探针把那一次实验固化下来。
 *
 * 跑法（**只在临时目录里跑 pnpm，绝不碰真 profile**）：
 *   node dev/probe-pnpm-resolve.mjs                          # 基线：原样解析
 *   node dev/probe-pnpm-resolve.mjs --pin @liustack/modsearch=5.10.11
 *   node dev/probe-pnpm-resolve.mjs --profile "<profile>" --pnpm "<pnpm.cjs>" --keep
 *
 * 输出最后一行 `PROBE_RESOLVE_JSON {...}`。判读：
 *   · 基线 clean + 带 pin 也 clean → 违规来自「状态」，不是这个包（换豁免没用，得让 pnpm 重写 lockfile）
 *   · 基线就不 clean            → 违规是这条链路本身的属性（换 profile / 换包也一样）
 *   · failed / cannot           → 探针自己没跑通（看 tail，别当成结论）
 */
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findPnpmBin, probeResolve } from "../lib/pnpmresolve.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function arg(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
	if (i >= 0) return true;
	return fallback;
}

/** 没给 --profile 时，从本文件往上找 `.dsh/profiles/<name>`。 */
function guessProfile() {
	let dir = here;
	for (let i = 0; i < 8; i += 1) {
		const candidate = join(dir, ".dsh", "profiles");
		try {
			const names = readdirSync(candidate);
			if (names.length > 0) return join(candidate, names[0]);
		} catch {
			/* 继续往上 */
		}
		dir = join(dir, "..");
	}
	return null;
}

async function main() {
	const profileDir = String(arg("profile", "") || guessProfile() || "");
	if (!profileDir) {
		console.log("PROBE_SKIP 找不到 profile（用 --profile <dir> 指定）");
		return;
	}
	const pinArg = arg("pin", null);
	const pin = {};
	if (typeof pinArg === "string") {
		for (const item of pinArg.split(",")) {
			const [name, version] = item.split("=");
			if (name && version) pin[name.trim()] = version.trim();
		}
	}
	const pnpmBin = arg("pnpm", null) || undefined;
	const keep = Boolean(arg("keep", false));
	const workDir = await mkdtemp(join(tmpdir(), "dpi-resolve-"));
	console.log("profile：" + profileDir);
	console.log("pnpm：" + (pnpmBin || findPnpmBin() || "（找不到）"));
	console.log("临时目录：" + workDir + (keep ? "（保留）" : "（跑完删）"));
	if (Object.keys(pin).length > 0) console.log("pin：" + JSON.stringify(pin));

	const result = await probeResolve({ profileDir, workDir, pnpmBin, pin });
	const label = { clean: "通过（零违规）", violations: "违规", failed: "跑失败", cannot: "跑不了" }[result.verdict] || result.verdict;
	console.log("");
	console.log("结论：" + label + (result.count !== null && result.count !== undefined ? "（" + result.count + " 条）" : ""));
	if (result.line) console.log("  " + result.line);
	if (result.dropped && result.dropped.length > 0) console.log("  摘掉的 git 依赖（沙箱里 git 不可用）：" + result.dropped.join("、"));
	if (result.pinned && result.pinned.length > 0) console.log("  本次固定：" + result.pinned.map((p) => p.name + " " + p.from + " → " + p.to).join("、"));
	if (result.elapsedMs) console.log("  耗时：" + (result.elapsedMs / 1000).toFixed(1) + "s");
	if (result.reason) console.log("  原因：" + result.reason);
	for (const line of result.tail || []) console.log("  | " + line);
	if (result.verdict === "clean") {
		console.log("");
		console.log("判读：**干净基线也通过** → 那 6 条违规来自 profile 的「状态」（多半是陈旧 lockfile /");
		console.log("      19 个 link: 依赖从没进过 lockfile），不是这个包。加豁免大概率没用；");
		console.log("      结构性修法是让 pnpm 重写一次 lockfile（面板永不跑 pnpm，得人决定）。");
	} else if (result.verdict === "violations") {
		console.log("");
		console.log("判读：**干净基线就违规** → 违规是这条链路本身的属性；看上面那行里的包/版本。");
	}
	console.log("PROBE_RESOLVE_JSON " + JSON.stringify({ ...result, profileDir, pin }));
	if (!keep) await rm(workDir, { recursive: true, force: true }).catch(() => null);
}

main().catch((error) => {
	console.log("PROBE_FAIL " + String((error && error.stack) || error));
	process.exitCode = 1;
});
