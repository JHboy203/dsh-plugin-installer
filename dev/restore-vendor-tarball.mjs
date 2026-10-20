/**
 * dev/restore-vendor-tarball.mjs — 修复「profile 里记的 file: 指向已删除的 .tgz」。
 *
 * 背景：早期版本把重打包好的 .tgz 放在 `data/staging/<job>/pack/`，而任务收尾会清掉
 * staging。于是 profile 的 dependencies 里留下一条指向空气的 `file:` —— 插件本身已经
 * 解进 node_modules（能跑），但**下一次任何 pnpm 操作都会 ENOENT 失败**。
 *
 * 现在的新安装落 `data/vendor/`（持久），prune 也会保留仍被 profile 引用的 staging 目录。
 * 这个脚本只负责把**已经断掉的那条**补回来（从 node_modules 里那份重新打包）。
 *
 * 实现已在 `lib/repair.js`（面板「环境体检 → 一键修复」与 `install_hub_doctor` 同源）：
 *   host_selfcheck({ plugin: "dsh-plugin-installer", script: "dev/restore-vendor-tarball.mjs" })
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRepairs, fileDepsOf, findDanglingFileDeps } from "../lib/repair.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const pluginRoot = resolve(here, "..");
const profile = process.env.DSH_PROFILE_DIR || join(pluginRoot, "..", "..", ".dsh", "profiles", "desktop");
const dataDir = join(pluginRoot, "data");

const pkg = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
const all = fileDepsOf(pkg);
const missing = findDanglingFileDeps(pkg, (p) => existsSync(p));
console.log("file: 依赖 " + all.length + " 条，缺文件 " + missing.length + " 条");

const result = await applyRepairs({
	profileDir: profile,
	dataDir,
	backupsRoot: join(pluginRoot, "..", "..", ".tools", "backups"),
	findings: []
});
for (const action of result.actions) {
	if (action.kind === "quarantine-dsh-tools") continue;
	if (action.ok) console.log("FIXED " + action.name + " → 重建 " + action.files + " 个文件到 " + action.path);
	else console.log("SKIP  " + action.name + " → " + action.error);
}
console.log("PROFILE " + profile);
