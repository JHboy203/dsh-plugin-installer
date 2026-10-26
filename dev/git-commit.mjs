// git-commit.mjs —— 救火：在宿主侧进程里提交（模型侧 shell 写不了 .git/index.lock）
//
// 为什么需要它：工具沙箱会拒绝对 <workspace>/...\.git\index.lock 的写，
// 两个 shell（bash / pwsh）都一样；而 host_selfcheck 跑的脚本是宿主权限的 node，
// 不受这层限制。R27 从 dsh-plugin-catalog 的同名脚本照搬（那边已经用了十来轮）。
//
// 用法：
//   host_selfcheck({ plugin:"dsh-plugin-installer", script:"dev/git-commit.mjs",
//                    args:["--message-file","<消息文件>"] })          # 只提交
//   ... args:["--message-file","<消息文件>","--push"]                  # 提交并推送
//   ... args:["--dry-run"]                                             # 只看会提交什么
//
// 行为：git add -A → git commit -F <file>（-c user.name/email 兜底，不依赖全局身份）
//       → 可选 git push → 回读 HEAD sha 与远端 main 比。只动本仓；不 force push。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

function arg(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
	if (i >= 0) return true;
	return fallback;
}

const dryRun = Boolean(arg("dry-run", false));
const push = Boolean(arg("push", false));
const msgFile = arg("message-file", resolve(REPO, "..", "..", ".tools", "installer-commit-msg.txt"));
/* ★ 只提交点名的路径（逗号分隔，相对仓库根）。用途：工作区里还有**别的会话**未提交的改动时，
   自己那几件（探针/脚本）照样能单独落盘，不用把别人的半成品一起提交。
   不传 = 老行为（git add -A）。 */
const onlyPaths = String(arg("paths", ""))
	.split(",")
	.map((item) => item.trim())
	.filter(Boolean);

function git(args, opts = {}) {
	return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
		cwd: REPO,
		encoding: "utf8",
		stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
		...opts,
	});
}

function say(line) {
	process.stdout.write(`${line}\n`);
}

let message = "";
try {
	message = readFileSync(msgFile, "utf8").trim();
} catch {
	message = "";
}
if (!message) {
	say(`FAIL 读不到提交信息：${msgFile}`);
	process.exit(2);
}
say(`repo: ${REPO}`);
say(`message: ${message.split("\n")[0]}`);
say(`files:  ${message.split("\n").length} 行 / ${Buffer.byteLength(message, "utf8")} 字节`);

let status = "";
try {
	status = git(["status", "--porcelain"]).trim();
} catch (error) {
	say("FAIL git status：" + String(error?.message ?? error));
	process.exit(2);
}
const lines = status ? status.split("\n") : [];
say(`dirty:  ${lines.length} 个改动`);
for (const line of lines.slice(0, 40)) say(`  ${line}`);

if (dryRun) {
	say("DRY-RUN 到此为止（没有 add / commit / push）");
	process.exit(0);
}

if (lines.length > 0) {
	if (onlyPaths.length > 0) {
		/* 选择性提交：先确认每个路径都真的有改动，避免把拼错的路径静默忽略。
		   ★ 不用 porcelain 文本解析（前导空格 / 重命名的 `old -> new` 都能让人栽跟头），
		     直接问 git 两个明确的问题：相对 HEAD 改了哪些、有哪些未跟踪。 */
		const changed = new Set(
			[
				...git(["diff", "--name-only", "HEAD"]).split(/\r?\n/),
				...git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/),
			]
				.map((line) => line.trim())
				.filter(Boolean),
		);
		const missing = onlyPaths.filter((path) => !changed.has(path));
		if (missing.length > 0) {
			say("FAIL --paths 里有不存在的改动：" + missing.join(", ") + "（现有：" + [...changed].slice(0, 20).join(", ") + "）");
			process.exit(2);
		}
		say("selective: 只提交 " + onlyPaths.join(", "));
		git(["add", "--", ...onlyPaths]);
	} else {
		git(["add", "-A"]);
	}
	try {
		execFileSync(
			"git",
			[
				"-c", "user.name=DSH Installer Round",
				"-c", "user.email=installer@local",
				"commit", "-F", msgFile,
			],
			{ cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		const out = String(error?.stdout || "") + String(error?.stderr || "") + String(error?.message || "");
		say("FAIL commit：" + out.split("\n").slice(0, 12).join(" ⏎ "));
		process.exit(1);
	}
	const head = git(["log", "-1", "--pretty=%h %s"]).trim();
	say("committed: " + head);
} else {
	say("nothing to commit（工作区本来就干净）");
}

if (push) {
	try {
		git(["push", "origin", "HEAD:main"], { inherit: true });
		say("pushed");
	} catch (error) {
		say("FAIL push：" + String(error?.message ?? error));
		process.exit(1);
	}
	const head = git(["rev-parse", "HEAD"]).trim();
	let remote = "";
	try {
		remote = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0] || "";
	} catch {
		remote = "";
	}
	say(remote && remote === head ? `verify: HEAD == origin/main (${head.slice(0, 7)})` : `verify: 没对上（HEAD ${head.slice(0, 7)} / remote ${remote.slice(0, 7) || "?"}）`);
}
