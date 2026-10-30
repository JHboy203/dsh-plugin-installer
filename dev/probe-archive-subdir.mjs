/**
 * dev/probe-archive-subdir.mjs — R38 收口探针：GitHub 归档包装目录 × tree 链接的 subdir。
 *
 * 背景（2026-10-31 真机 e2e 撞到的两个判据问题，**还没修**，下一个会话先看这里）：
 *  ① `detectKind(extractRoot, { subdir })` 把 subdir **直接拼在解包根上**：
 *     GitHub 源码归档解出来是 `repo-<ref>/…`，于是 `skills/foo` 被拼成
 *     `<extract>/skills/foo`（不存在）→ kind=unknown → 面板报「未识别内容」。
 *  ② 不带 subdir 时，`collapseSingleDirs` 会把**技能目录本身**也折进 `wrappers`：
 *     单技能仓库 `repo-abc/skills/foo/SKILL.md` 的 wrappers 实测是
 *     `["repo-abc","skills","foo"]`。而 `recordSkillSource` 拿 wrappers 当前缀拼
 *     「仓库内路径」，会记成 `repo-abc/skills/foo`（含归档包装 + 技能目录），
 *     不是 `skills/foo`。更新检查于是按错误路径查提交。
 *
 * 正确判据（下一个会话照这个改）：
 *  · 先剥**一层**归档包装（codeload tarball 的 `repo-<ref>/`），得到 repoRoot；
 *  · subdir 相对 **repoRoot** 拼接，再做目录折叠；
 *  · 台账里的仓库内路径 = `relative(repoRoot, payload.dir)`；
 *    `wrappers` 不能再当仓库路径用（它折叠的是"从解包根到技能根"的整条链）。
 *
 * 跑法：
 *   node dev/probe-archive-subdir.mjs              # 只报告（KNOWN RED 也退 0）
 *   node dev/probe-archive-subdir.mjs --strict     # 修好后应全绿；红则退 1
 *   host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-archive-subdir.mjs"})
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectKind } from "../lib/detect.js";

const strict = process.argv.includes("--strict");
let failed = 0;
let knownRed = 0;

function report(name, ok, detail, isKnownRed = false) {
	if (ok) {
		console.log("PASS " + name);
		return;
	}
	if (isKnownRed) {
		knownRed += 1;
		console.log("KNOWN-RED " + name + (detail ? "  " + detail : ""));
		return;
	}
	failed += 1;
	console.log("FAIL " + name + (detail ? "  " + detail : ""));
}

const root = await mkdtemp(join(tmpdir(), "skill-archive-"));
try {
	/* 造一个和 GitHub codeload 一致的布局：repo-abc/ 是归档包装，skills/foo/ 是仓库里的技能 */
	await mkdir(join(root, "repo-abc", "skills", "foo"), { recursive: true });
	await writeFile(join(root, "repo-abc", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: probe\n---\n\nbody\n", "utf8");

	const plain = await detectKind(root);
	report("归档包装能一路折叠到技能（不带 subdir）", plain.kind === "skill", "kind=" + plain.kind + " wrappers=" + JSON.stringify(plain.wrappers));
	console.log("  说明：不带 subdir 时 wrappers = " + JSON.stringify(plain.wrappers) +
		"（含归档包装与技能目录本身，所以它**不能**当仓库内路径用）");

	const sub = await detectKind(root, { subdir: "skills/foo" });
	const subOk = sub.kind === "skill";
	report("tree 链接的 subdir 相对「剥掉归档包装后的仓库根」定位", subOk,
		"kind=" + sub.kind + " root=" + sub.root.replace(root, "<tmp>") + " notes=" + JSON.stringify(sub.notes), !subOk);
	if (!subOk) {
		console.log("  已知根因：subdir 被拼在解包根上，实际应为 <extract>/repo-abc/skills/foo");
		console.log("  修复方向：detectKind 先剥一层归档包装 → repoRoot；subdir 相对 repoRoot 拼；再折叠");
	}

	/* 期望的仓库内路径：相对 repoRoot（<extract>/repo-abc），技能目录应为 skills/foo */
	const expectedRepoPath = "skills/foo";
	console.log("  期望台账仓库内路径：" + expectedRepoPath + "（当前实现会记成 " + JSON.stringify(plain.wrappers) + "）");
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("");
if ((failed > 0 || knownRed > 0) && strict) {
	console.log("SUMMARY " + failed + " FAIL / " + knownRed + " KNOWN-RED（--strict：修好之前这里必须红，别当噪音）");
	process.exitCode = 1;
} else if (failed > 0) {
	console.log("SUMMARY " + failed + " FAIL");
	process.exitCode = 1;
} else if (knownRed > 0) {
	console.log("SUMMARY " + knownRed + " KNOWN-RED（不加 --strict 退 0；R39 修好后应消失）");
} else {
	console.log("SUMMARY all archive/subdir checks passed");
}
