/**
 * dev/probe-archive-subdir.mjs — 回归探针：GitHub 归档包装目录 × tree 链接的 subdir × 台账仓库内路径。
 *
 * 背景（2026-10-31 R38 收口时真机 e2e 撞到、R39 修掉的两个判据问题）：
 *  ① `detectKind(extractRoot, { subdir })` 曾把 subdir **直接拼在解包根上**：
 *     GitHub 源码归档解出来是 `repo-<ref>/…`，于是 `skills/foo` 被拼成
 *     `<extract>/skills/foo`（不存在）→ kind=unknown → 面板报「未识别内容」。
 *  ② 不带 subdir 时，`collapseSingleDirs` 会把**技能目录本身**也折进 `wrappers`：
 *     单技能仓库 `repo-abc/skills/foo/SKILL.md` 的 wrappers 实测是
 *     `["repo-abc","skills","foo"]`。旧 `recordSkillSource` 拿 wrappers 当前缀拼
 *     「仓库内路径」，会记成 `repo-abc/skills/foo`（含归档包装 + 技能目录），
 *     不是 `skills/foo`。更新检查于是按错误路径查提交。
 *
 * 现在的判据（R39）：
 *  · 先剥**一层**归档包装（codeload tarball 的 `repo-<ref>/`），得到 `repoRoot`；
 *  · subdir 相对 **repoRoot** 拼接，再做目录折叠；
 *  · 台账的仓库内路径 = `repoRelativePath(repoRoot, payload.dir)`；
 *    `wrappers` 只作展示，不能再当仓库路径（它折叠的是"从解包根到技能根"的整条链）。
 *
 * 跑法：
 *   node dev/probe-archive-subdir.mjs              # 只报告（KNOWN RED 也退 0）
 *   node dev/probe-archive-subdir.mjs --strict     # 任何红都退 1（日常/交付用这个）
 *   host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-archive-subdir.mjs"})
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectKind, repoRelativePath } from "../lib/detect.js";

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
	const repoRootExpected = join(root, "repo-abc");
	const skillDir = join(repoRootExpected, "skills", "foo");
	await mkdir(skillDir, { recursive: true });
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: foo\ndescription: probe\n---\n\nbody\n", "utf8");

	/* ① 不带 subdir：识别照旧（折叠能走到技能），但仓库根必须停在 repo-abc */
	const plain = await detectKind(root);
	report("归档包装能一路折叠到技能（不带 subdir）", plain.kind === "skill", "kind=" + plain.kind + " wrappers=" + JSON.stringify(plain.wrappers));
	report("不带 subdir：仓库根 = 剥掉归档包装那一层", plain.repoRoot === repoRootExpected, "repoRoot=" + String(plain.repoRoot).replace(root, "<tmp>"));
	report("不带 subdir：归档包装单独记着（不进仓库内路径）", JSON.stringify(plain.archiveWrappers) === JSON.stringify(["repo-abc"]), JSON.stringify(plain.archiveWrappers));
	report("不带 subdir：仓库内路径 = skills/foo（不是 wrappers 拼出来的整条链）",
		repoRelativePath(plain.repoRoot, plain.payload && plain.payload.dir) === "skills/foo",
		"path=" + JSON.stringify(repoRelativePath(plain.repoRoot, plain.payload && plain.payload.dir)) + " wrappers=" + JSON.stringify(plain.wrappers));

	/* ② tree 链接：subdir 相对仓库根 */
	const sub = await detectKind(root, { subdir: "skills/foo" });
	const subOk = sub.kind === "skill";
	report("tree 链接的 subdir 相对「剥掉归档包装后的仓库根」定位", subOk,
		"kind=" + sub.kind + " root=" + String(sub.root).replace(root, "<tmp>") + " notes=" + JSON.stringify(sub.notes), !subOk);
	if (subOk) {
		report("tree 链接：技能目录落在 <tmp>/repo-abc/skills/foo", sub.payload.dir === skillDir, "dir=" + String(sub.payload.dir).replace(root, "<tmp>"));
		report("tree 链接：仓库内路径 = skills/foo", repoRelativePath(sub.repoRoot, sub.payload.dir) === "skills/foo",
			"path=" + JSON.stringify(repoRelativePath(sub.repoRoot, sub.payload.dir)));
	}
	if (!subOk) {
		console.log("  已知根因：subdir 被拼在解包根上，实际应为 <extract>/repo-abc/skills/foo");
		console.log("  修复方向：detectKind 先剥一层归档包装 → repoRoot；subdir 相对 repoRoot 拼；再折叠");
	}

	/* ③ 兜底：仓库自己的顶层目录（只有一个）与归档包装同形 —— subdir 只可能相对解包根 */
	const flat = join(root, "flat");
	await mkdir(join(flat, "skills", "bar"), { recursive: true });
	await writeFile(join(flat, "skills", "bar", "SKILL.md"), "---\nname: bar\ndescription: probe\n---\n\nbody\n", "utf8");
	const flatSub = await detectKind(flat, { subdir: "skills/bar" });
	report("兜底：仓库只有一个顶层目录时不会被当成归档包装（subdir 退回解包根）",
		flatSub.kind === "skill" && flatSub.repoRoot === flat,
		"kind=" + flatSub.kind + " repoRoot=" + String(flatSub.repoRoot).replace(root, "<tmp>"));

	/* ④ 仓库根下的技能（path = ""）与算不出来的路径（null）—— 台账不许编造 */
	report("仓库内路径：技能就在仓库根 → 空串", repoRelativePath(repoRootExpected, repoRootExpected) === "");
	report("仓库内路径：目录不在仓库根下 → null（不编造）", repoRelativePath(repoRootExpected, join(root, "elsewhere")) === null);
	report("仓库内路径：缺仓库根 → null", repoRelativePath(null, skillDir) === null);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("");
if ((failed > 0 || knownRed > 0) && strict) {
	console.log("SUMMARY " + failed + " FAIL / " + knownRed + " KNOWN-RED（--strict：有红就退 1，别当噪音）");
	process.exitCode = 1;
} else if (failed > 0) {
	console.log("SUMMARY " + failed + " FAIL");
	process.exitCode = 1;
} else if (knownRed > 0) {
	console.log("SUMMARY " + knownRed + " KNOWN-RED（不加 --strict 退 0）");
} else {
	console.log("SUMMARY all archive/subdir/path checks passed");
}
