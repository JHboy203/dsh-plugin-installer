/**
 * dev/probe-repo.mjs — 只读探针 CLI（薄壳；判据全在 `lib/probe.js`）。
 *
 * 跑法（宿主进程里跑，沙箱里不能写 data/、不能 spawn）：
 *   host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/probe-repo.mjs",
 *                    args: ["https://github.com/owner/repo"] })
 *
 * 输出最后一行是 `PROBE_JSON {...}`；报告另存 `data/probe/probe-*.json`。
 * R32 起同一份逻辑也以工具形式暴露：`install_hub_probe_repo`（模型不必先装一遍就能问）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

import { probeRepo, summarizeProbe } from "../lib/probe.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const DATA = join(here, "..", "data");
const outDir = join(DATA, "probe");
const raw = process.argv[2] || "";

async function main() {
	if (!raw) {
		console.log("用法：node dev/probe-repo.mjs <链接|github:owner/repo|npm 包名>");
		process.exit(2);
	}
	const work = join(outDir, "work-" + Date.now());
	const result = await probeRepo({ input: raw, workDir: work, outDir });
	if (!result.ok && !result.report) {
		console.log("PROBE_SKIP " + result.message);
		return;
	}
	for (const line of summarizeProbe(result.report)) console.log(line);
	console.log("PROBE_JSON " + JSON.stringify({ ...result.report, probeOk: result.ok, reason: result.reason || null }, null, 1));
	await rm(work, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => {
	console.log("PROBE_FAIL " + String((e && e.stack) || e));
	process.exitCode = 1;
});
