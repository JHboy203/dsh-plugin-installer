/**
 * dev/quarantine-dshtools.mjs — 手动兜底：把 profile 里那份不该存在的
 * `@deepseek-ai/dsh-tools` 挪进备份目录。
 *
 * 实现已收进 `lib/landmine.js`（面板的「环境体检」与 `install_hub_doctor` 用的是同一份），
 * 这里只是给它一个能脱离 DSH 直接跑的入口：
 *
 *   host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/quarantine-dshtools.mjs" })
 *   node DSH-Plugin/dsh-plugin-installer/dev/quarantine-dshtools.mjs
 *
 * 为什么必须挪：插件按**路径**算模块标识，profile 里多一份 dsh-tools（版本相同也一样）
 * = 两个 Symbol，下次启动插件批量加载失败（reading 'prepare'）。pnpm 的 overrides
 * 只管版本号，不阻止它被装进来 —— 本机已复发四次。
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDshToolsShadow, quarantineDshTools } from "../lib/landmine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const pluginRoot = resolve(here, "..");
const workspace = resolve(pluginRoot, "..", "..");
const profile = process.env.DSH_PROFILE_DIR || join(workspace, ".dsh", "profiles", "desktop");
const backups = join(workspace, ".tools", "backups");

const before = await checkDshToolsShadow(profile);
if (!before.present) {
	console.log("OK   profile 里没有 dsh-tools 副本（无需处理）");
	console.log("PROFILE " + profile);
} else {
	const result = await quarantineDshTools(profile, backups);
	if (result.moved) {
		console.log("FIXED 已把陈旧的 @deepseek-ai/dsh-tools 挪走");
		console.log("  from " + result.from);
		console.log("  to   " + result.to);
	} else {
		console.log("FAIL " + (result.error || "未知原因"));
		process.exitCode = 1;
	}
	console.log("PROFILE " + profile);
}
