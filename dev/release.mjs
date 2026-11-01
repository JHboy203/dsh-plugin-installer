#!/usr/bin/env node
/**
 * dev/release.mjs — 一条命令发一个 GitHub Release（R48.1 把这次手工流程固化）。
 *
 * 为什么需要它：2026-11-01 发 v0.18.0 时，`gh release create --target <短 sha>` 被 GitHub
 * 回 422（`target_commitish is invalid` / `tag_name is not a valid tag`），只能改成
 * 「API 先建 tag → gh release create --verify-tag」。这个顺序、以及发完要校验
 * `releases/latest` 指向新 tag，现在都在这里，不再靠记性。
 *
 * 默认 **dry-run**：只做只读检查并把计划打出来，不发任何写请求。
 * `--apply` 才真的：建 tag（若不存在）→ 建 release（--verify-tag）→ 改仓库描述 → 校验 latest。
 *
 * 用法：
 *   node dev/release.mjs                       # 看计划
 *   node dev/release.mjs --apply \
 *     --notes dev/release-notes/v0.18.1.md \
 *     --title "v0.18.1 — ..." \
 *     --desc  dev/repo-meta.json               # 真发
 *
 * 约束（故意写死，别放宽）：
 *   · 不 push 代码；HEAD 必须已经在远端（用 gh api commits/<sha> 校验），否则拒绝。
 *   · 工作区必须干净（`--allow-dirty` 可强制，但 release 指着一个没提交的版本没有意义）。
 *   · 描述文件最多 350 字符（GitHub 限制），超了直接拒绝。
 *   · 已经存在的 tag / release 不覆盖（发新版就改 package.json 版本）。
 */
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const APPLY = has("--apply");
const ALLOW_DIRTY = has("--allow-dirty");
const MAX_DESCRIPTION = 350;

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function gh(args) {
	return run("gh", args);
}
function ghJson(args) {
	return JSON.parse(gh(args));
}
function ghText(args) {
	return gh(args);
}
function ghExists(args) {
	try {
		ghJson(args);
		return true;
	} catch {
		return false;
	}
}
function fail(message) {
	console.error("RELEASE: " + message);
	process.exit(1);
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = String(pkg.version || "").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail("package.json version is not semver: " + JSON.stringify(version));
const tag = "v" + version;

const repoMatch = /github\.com[/:]([^/]+)\/([^/#?]+)/.exec(String((pkg.repository && pkg.repository.url) || ""));
const repo = valueOf("--repo") || (repoMatch ? repoMatch[1] + "/" + repoMatch[2].replace(/\.git$/, "") : null);
if (!repo) fail("cannot resolve owner/repo (set \"repository\" in package.json or pass --repo owner/name)");

const notesPath = resolve(root, valueOf("--notes") || join("dev", "release-notes", tag + ".md"));
const descPath = resolve(root, valueOf("--desc") || join("dev", "repo-meta.json"));
const title = valueOf("--title") || tag;

/* ① 只读检查 */
let head = "";
let branch = "";
try {
	head = run("git", ["rev-parse", "HEAD"]);
	branch = run("git", ["branch", "--show-current"]);
} catch (e) {
	fail("git is unavailable here: " + String((e && e.message) || e));
}
const dirty = run("git", ["status", "--porcelain"]).split("\n").filter(Boolean);
const headShort = head.slice(0, 7);

const pushed = (() => {
	try {
		return ghText(["api", "repos/" + repo + "/commits/" + head, "--jq", ".sha"]) === head;
	} catch {
		return false;
	}
})();
const tagExists = ghExists(["api", "repos/" + repo + "/git/refs/tags/" + tag]);
let latest = null;
try {
	latest = ghText(["api", "repos/" + repo + "/releases/latest", "--jq", ".tag_name"]).trim() || null;
} catch {
	latest = null;
}
const releaseExists = ghExists(["api", "repos/" + repo + "/releases/tags/" + tag]);

let notesOk = false;
let notesBytes = 0;
try {
	const info = await stat(notesPath);
	notesBytes = info.size;
	notesOk = notesBytes > 0;
} catch {
	notesOk = false;
}

let description = null;
try {
	const meta = JSON.parse(await readFile(descPath, "utf8"));
	description = typeof meta.description === "string" ? meta.description.trim() : null;
} catch {
	description = null;
}

/* ② 计划 */
console.log("release plan");
console.log("  repo       " + repo);
console.log("  version    " + version + "  (tag " + tag + ")");
console.log("  head       " + headShort + "  branch " + (branch || "(detached)"));
console.log("  worktree   " + (dirty.length === 0 ? "clean" : "DIRTY (" + dirty.length + " files)"));
console.log("  pushed     " + (pushed ? "yes" : "NO"));
console.log("  tag        " + (tagExists ? "already exists (will not overwrite)" : "absent (will create at head)"));
console.log("  release    " + (releaseExists ? "already exists (will not overwrite)" : "absent"));
console.log("  latest     " + (latest || "(none)"));
console.log("  notes      " + notesPath + "  (" + (notesOk ? notesBytes + " bytes" : "MISSING") + ")");
console.log("  title      " + title);
console.log("  desc       " + (description ? descPath + "  (" + description.length + "/" + MAX_DESCRIPTION + " chars)" : "(skip)"));
console.log("  mode       " + (APPLY ? "APPLY" : "dry-run (add --apply to write)"));

const problems = [];
if (dirty.length > 0 && !ALLOW_DIRTY) problems.push("worktree is dirty (commit first, or --allow-dirty)");
if (!pushed) problems.push("HEAD is not on the remote (git push first)");
if (releaseExists) problems.push("release " + tag + " already exists");
if (!notesOk) problems.push("release notes file is missing/empty: " + notesPath);
if (description && description.length > MAX_DESCRIPTION) problems.push("description is " + description.length + " chars (limit " + MAX_DESCRIPTION + ")");

if (problems.length > 0) {
	console.log("");
	for (const problem of problems) console.log("  ! " + problem);
	if (APPLY) fail("refusing to apply: fix the problems above");
	console.log("");
	console.log("dry-run: would stop here. (--apply refuses while these problems remain)");
} else if (!APPLY) {
	console.log("");
	console.log("dry-run: would create tag " + tag + ", create the release, and update the repo description.");
	console.log("run again with --apply to do it.");
} else {
	/* ③ 真做（顺序不能换：先 tag，再 --verify-tag） */
	if (!tagExists) {
		gh(["api", "--method", "POST", "repos/" + repo + "/git/refs", "-f", "ref=refs/tags/" + tag, "-f", "sha=" + head]);
		console.log("created tag " + tag + " at " + headShort);
	}
	gh(["release", "create", tag, "--verify-tag", "--title", title, "--notes-file", notesPath, "-R", repo]);
	console.log("created release " + tag);
	if (description) {
		gh(["api", "--method", "PATCH", "repos/" + repo, "-f", "description=" + description]);
		console.log("updated repo description (" + description.length + " chars)");
	}
	const after = ghText(["api", "repos/" + repo + "/releases/latest", "--jq", ".tag_name"]).trim();
	if (after !== tag) fail("verification failed: latest is " + after + ", expected " + tag);
	console.log("verified latest release = " + after);
	console.log("url https://github.com/" + repo + "/releases/tag/" + tag);
}
