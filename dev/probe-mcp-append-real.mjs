/**
 * dev/probe-mcp-append-real.mjs — R36 真形追加探针（只写临时副本，不碰真 profile）：
 * 把真实 profile 的 cordis.patch.yml 复制到临时目录，走一遍 addMcpToProfile，
 * 确认「解析 579 行真文件 → 追加 → 备份 → 写后复核」这条链在真形状上成立。
 */
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMcpToProfile, parseCompositionEntries } from "../lib/mcp.js";

const real = "D:/信息库/AI工作区/.dsh/profiles/desktop/cordis.patch.yml";
let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) {
		passed += 1;
		console.log("PASS " + name);
	} else {
		failed += 1;
		console.log("FAIL " + name + (detail !== undefined ? " :: " + JSON.stringify(detail) : ""));
	}
}

const original = await readFile(real, "utf8");
const before = parseCompositionEntries(original, { file: real });
const root = await mkdtemp(join(tmpdir(), "dpi-mcp-real-"));
try {
	const profile = join(root, "profile");
	const backups = join(root, "backups");
	await mkdir(profile, { recursive: true });
	await copyFile(real, join(profile, "cordis.patch.yml"));
	const added = await addMcpToProfile({
		profileDir: profile,
		backupDir: backups,
		candidate: {
			registryName: "ai.b77/time",
			serverName: "time-probe",
			transport: "streamable-http",
			remoteUrl: "https://time.b77.ai/mcp",
			installable: true,
			installPath: "https://time.b77.ai/mcp"
		}
	});
	ok("真形：追加成功", added.ok === true, added.reason);
	ok("真形：备份存在且是原文", added.ok && (await readFile(added.backup, "utf8")) === original);
	const afterText = await readFile(join(profile, "cordis.patch.yml"), "utf8");
	const after = parseCompositionEntries(afterText, { file: join(profile, "cordis.patch.yml") });
	ok("真形：原文条目一条没少", after.length === before.length + 1, { before: before.length, after: after.length });
	ok("真形：新条目在最后", after[after.length - 1].id === "mcp-time-probe" && after[after.length - 1].config.serverName === "time-probe", after[after.length - 1]);
	ok("真形：行号落在文件尾部", added.line > before.length, { line: added.line, before: before.length });
} finally {
	await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log("\nSUMMARY " + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
