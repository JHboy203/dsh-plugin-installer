/**
 * dev/probe-crash.mjs — 用**真实**崩溃日志目录跑一遍崩溃分诊，把判据打出来。
 *
 * 为什么要有它：宿主里改了 lib/* 要重启才生效，而「最近一次启动失败」这件事
 * 恰恰每次开机都变。这条脚本不进宿主、只读日志，改完立刻能看新代码怎么判。
 *
 * 跑法：
 *   node DSH-Plugin/dsh-plugin-installer/dev/probe-crash.mjs
 *   node DSH-Plugin/dsh-plugin-installer/dev/probe-crash.mjs <crashDir> <profileDir>
 */
import { readNewestCrash, inspectProfile } from "../lib/profilehealth.js";

const crashDir = process.argv[2] || undefined; // undefined = 默认 %APPDATA%\@deepseek-ai\dsh-desktop\logs
const profileDir = process.argv[3] || "D:\\信息库\\AI工作区\\.dsh\\profiles\\desktop";

const crash = await readNewestCrash(crashDir);
if (!crash) {
	console.log("NO_CRASH_LOGS");
	process.exit(0);
}

console.log("== readNewestCrash ==");
console.log(JSON.stringify({
	kind: crash.kind,
	source: crash.source,
	at: crash.at,
	ageHours: Math.round((crash.ageMs / 3600000) * 10) / 10,
	app: crash.app,
	summary: crash.summary,
	failed: crash.failed,
	console: crash.console,
	signature: crash.signature ? crash.signature.name : null,
	sibling: crash.sibling
}, null, 2));

const report = await inspectProfile({ profileDir, dataDir: ".tmp-probe", crashDir, contract: false });
const crashFindings = report.findings.filter((f) => f.code === "crash-recent" || f.code === "web-boot-recent");
console.log("\n== findings ==");
for (const f of crashFindings) {
	console.log("[" + f.severity + "] " + f.code + " · " + f.title);
	console.log("  detail: " + String(f.detail).split("\n").join("\n          "));
	console.log("  plain : " + f.plain);
	console.log("  fix   : " + (f.fix || []).map((x) => x.text).join("\n          "));
}
if (crashFindings.length === 0) console.log("(no fresh crash finding)");
