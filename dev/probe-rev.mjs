#!/usr/bin/env node
/**
 * dev/probe-rev.mjs — 「崩溃日志里失败的那份 client 包，现在还在不在」（R24 的离线探针）。
 *
 *   node DSH-Plugin/dsh-plugin-installer/dev/probe-rev.mjs [--crash <dir>] [--full]
 *
 * 三件事，都是只读、不联网、不碰宿主：
 *   ① 用 dev/fixtures/rev-vectors.json 钉住算法（其中一条是**真机观测值**：
 *      宿主日志里写的 rev，我们反算出同一个 12 位串）；
 *   ② 读最近一份 `crash-*-web-boot.log`，把点名的每个包的「日志里的 rev」与
 *      「现在磁盘上的 rev」对一遍，打印判定（same / rebuilt / unknown）；
 *   ③ `--full` 时连体检结论（finding 标题 / 严重度 / 面板动作）一起打出来。
 *
 * 换会话接手时先跑这个：能一句话回答「上次那个没激活的面板修没修」，
 * 比盯着日志里的 rev 手算强。判据与插件共用 lib/clientrev.js（同一份实现，不复制）。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { artifactRevision, classifyBundle, findBundleRev, parseBundleRevs, resolveClientArtifact } from "../lib/clientrev.js";
import { describeCrash, inspectProfile } from "../lib/profilehealth.js";
import { dataDir, profileDir as hostProfileDir } from "../lib/hostinfo.js";

const args = process.argv.slice(2);
const argOf = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : null;
};
const full = args.includes("--full");
const crashDir = argOf("--crash") || (process.env.APPDATA ? join(process.env.APPDATA, "@deepseek-ai", "dsh-desktop", "logs") : null);

/**
 * profile 目录：宿主里跑时会自己知道；从终端/探针跑时不知道，就往上找 `.dsh/profiles/<name>/package.json`。
 * 这一步不做的话整份探针会静默判成「no-input」—— 看着像 bug，其实是没找到 profile。
 */
async function findProfile(start) {
	const explicit = argOf("--profile") || process.env.DSH_PROFILE_DIR;
	if (explicit) return explicit;
	let fromHost = null;
	try {
		fromHost = hostProfileDir();
	} catch {
		fromHost = null;
	}
	if (fromHost) return fromHost;
	let dir = start;
	for (let i = 0; i < 6; i += 1) {
		const base = join(dir, ".dsh", "profiles");
		try {
			const names = (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
			for (const name of names) {
				const p = join(base, name);
				try {
					await stat(join(p, "package.json"));
					return p;
				} catch {
					/* 这份 profile 没 package.json，换下一个 */
				}
			}
		} catch {
			/* 这层没有 .dsh/profiles，往上走 */
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

console.log("dsh-plugin-installer · rev 探针（R24）");

/* ① 算法：真机向量 */
const fx = JSON.parse(await readFile(new URL("./fixtures/rev-vectors.json", import.meta.url), "utf8"));
let bad = 0;
for (const v of fx.vectors) {
	const got = artifactRevision(v);
	const ok = got === v.rev;
	if (!ok) bad += 1;
	console.log((ok ? "PASS " : "FAIL ") + "向量 " + v.id + " → " + got + (ok ? "" : "（期望 " + v.rev + "）") + (v.authoritative ? "  [真机]" : ""));
}
console.log(bad === 0 ? "· 算法与宿主一致（真机向量对上了）" : "· ⚠️ 算法与宿主不一致：lib/clientrev.js 被改坏了");

if (!crashDir) {
	console.log("· 读不到崩溃日志目录（没有 APPDATA？），到此为止");
	process.exit(bad === 0 ? 0 : 1);
}

/* ② 最近一份 web-boot 日志 */
let files = [];
try {
	files = (await readdir(crashDir)).filter((n) => /^crash-.*-web-boot\.log$/.test(n));
} catch {
	console.log("· 读不到 " + crashDir);
	process.exit(bad === 0 ? 0 : 1);
}
if (files.length === 0) {
	console.log("· 没有 web-boot 崩溃日志 —— 没有前端入口激活失败过（这是好事）");
	process.exit(bad === 0 ? 0 : 1);
}
const stamped = [];
for (const name of files) {
	const info = await stat(join(crashDir, name)).catch(() => null);
	if (info) stamped.push({ name, mtimeMs: info.mtimeMs });
}
stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
const newest = stamped[0];
const text = await readFile(join(crashDir, newest.name), "utf8");
const atMs = Date.parse((/^time:\s*(.+)$/m.exec(text) || [])[1] || "") || newest.mtimeMs;
const revs = parseBundleRevs(text);
const named = [];
for (const line of text.split(/\r?\n/)) {
	const m = /^([a-z0-9][a-z0-9@/_.-]*):\s*import failed/i.exec(line.trim());
	if (m && !named.includes(m[1])) named.push(m[1]);
}
const profile = await findProfile(process.cwd());
if (!profile) console.log("· 认不出 profile 目录（用 --profile <dir> 指定）");
console.log("· 最近一份：" + newest.name + "（" + new Date(atMs).toLocaleString("zh-CN") + "）· 点名 " + named.length + " 个");
for (const plugin of named) {
	const current = await resolveClientArtifact(profile, plugin);
	const verdict = classifyBundle({ loggedRev: findBundleRev(revs, plugin), loggedAt: atMs, current });
	const label = verdict.state === "same"
		? "同一份字节还在（重启会再失败）"
		: verdict.state === "rebuilt"
			? "日志里那份已经不在（现在这份是 " + new Date(verdict.artifactAt).toLocaleString("zh-CN") + " 的）"
			: "判定不了（" + (verdict.reason || "?") + "）" + (verdict.movedAfterLog ? "，但失败之后又构建过" : "");
	console.log("  · " + plugin.padEnd(28) + " " + label);
	console.log("      " + (verdict.loggedRev || "（日志没抄 rev）") + " → " + (verdict.rev || "?"));
}

/* ③ --full：连体检结论一起 */
if (full) {
	const report = await inspectProfile({ profileDir: profile, dataDir: dataDir(), contract: false });
	console.log("· 体检结论：" + describeCrash(report.info.crash));
	for (const f of report.findings) {
		if (f.code !== "web-boot-recent") continue;
		console.log("  [" + f.severity + "] " + f.title);
		for (const a of f.actions || []) console.log("  面板动作：" + a.label);
		for (const s of f.fix || []) console.log("  · " + s.text);
	}
}
process.exit(bad === 0 ? 0 : 1);
