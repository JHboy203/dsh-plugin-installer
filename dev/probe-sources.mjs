#!/usr/bin/env node
/**
 * dev/probe-sources.mjs — 「已装分来源」判据在**真 profile** 上是什么结果（R25 的离线探针）。
 *
 *   node DSH-Plugin/dsh-plugin-installer/dev/probe-sources.mjs [--profile <profile 目录>]
 *
 * 为什么要有它：R25 的判据（`repoKey` / `compareInstalledSource` / `localOnlyHint`）在
 * `hosttest` 里是用**构造的 fixture** 钉的；可真机上到底有多少依赖能算出仓库指纹、
 * 哪几个是 `link:` 的本机目录、对账结果长什么样 —— 换个会话的人看不见，只能重跑一遍实验。
 * 这个探针把那次实验固化下来：只读、不联网、不碰宿主，一个命令回答四个问题：
 *
 *   ① 规模：多少依赖 / 四类形态各多少 / 多少能算出 `host/owner/repo`（= 对账的下限）
 *   ② 样本：link 与 npm 各几个，各自有没有 `repository`（没写的是自写插件，很常见）
 *   ③ 三态对账：拿真实条目跑 —— 同仓库 → `same`；换一个仓库 → `different`(warn)；
 *      link → `different`(**error**，这条是「会把你本机那份换掉」的那个场景)；仓库未知 → `unknown`
 *   ④ 一句话提示：拿一个 link 装的插件名去问，`localOnlyHint` 会说成什么样
 *
 * 判据实现与插件共用 `lib/inventory.js`（同一份代码，不复制）。
 */
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";

import { compareInstalledSource, localOnlyHint, readInventory, repoKey } from "../lib/inventory.js";
import { profileDir as hostProfileDir } from "../lib/hostinfo.js";

const args = process.argv.slice(2);
const argOf = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : null;
};

/** profile 目录：显式 > 宿主探测 > 从 cwd 往上找 `.dsh/profiles/<name>`。 */
async function resolveProfile() {
	const explicit = argOf("--profile");
	if (explicit) return explicit;
	const fromHost = hostProfileDir();
	if (fromHost) {
		/* hostProfileDir() 可能给到 profiles 的**根**（宿主认不出具体实例时）——
		   根目录下没有 package.json，这时往下找一个像 profile 的子目录。 */
		const picked = await pickProfileUnder(fromHost);
		if (picked) return picked;
	}
	let dir = process.cwd();
	for (let i = 0; i < 8; i += 1) {
		const profiles = join(dir, ".dsh", "profiles");
		const picked = await pickProfileUnder(profiles);
		if (picked) return picked;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** `dir` 自己像 profile 就返回它；否则在下一层里挑一个带 package.json 的。 */
async function pickProfileUnder(dir) {
	if (!dir) return null;
	try {
		const st = await stat(join(dir, "package.json"));
		if (st.isFile()) return dir;
	} catch {
		/* 继续往下 */
	}
	try {
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(dir, { withFileTypes: true });
		const kids = entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)).sort();
		const found = [];
		for (const kid of kids) {
			try {
				const st = await stat(join(kid, "package.json"));
				if (st.isFile()) found.push(kid);
			} catch {
				/* 不是 profile */
			}
		}
		if (found.length === 0) return null;
		if (found.length === 1) return found[0];
		return found.find((kid) => /desktop$/.test(kid)) || found[0];
	} catch {
		return null;
	}
}

let passed = 0;
let failed = 0;
const check = (name, condition, extra) => {
	if (condition) {
		passed += 1;
		console.log("PASS " + name);
	} else {
		failed += 1;
		console.log("FAIL " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra)));
	}
};

const profile = await resolveProfile();
if (!profile) {
	console.log("读不到 profile 目录：用 --profile <dir> 指定一个（例如 D:/…/.dsh/profiles/desktop）");
	process.exitCode = 1;
} else {
	console.log("profile：" + profile);
	const inv = await readInventory({ profileDir: profile });
	if (!inv.ok) {
		console.log("读不到已装清单：" + inv.reason + "（" + (inv.note || "") + "）");
		process.exitCode = 1;
	} else {
		const items = inv.items || [];
		const byKind = (inv.counts && inv.counts.byKind) || {};
		const withKey = items.filter((item) => item.repoKey);
		const links = items.filter((item) => item.kind === "link");
		const npms = items.filter((item) => item.kind === "npm" && item.installed);
		console.log("");
		console.log("① 规模");
		console.log("  依赖 " + items.length + " 个 · npm " + (byKind.npm || 0) + " / 本机目录 " + (byKind.link || 0) +
			" / .tgz " + (byKind.tarball || 0) + " / Git " + (byKind.git || 0));
		console.log("  能算出仓库指纹（repoKey 非 null）：" + withKey.length + " 个 —— 对账的下限就是它");
		console.log("  没写 repository 的：" + (items.filter((item) => item.installed && !item.repoKey).length) +
			" 个（多为自写插件；按设计**不标红**）");

		console.log("");
		console.log("② 样本（各取前 5）");
		for (const item of items.filter((i) => i.repoKey).slice(0, 5)) {
			console.log("  " + item.name + "  [" + item.kindLabel + "]  " + item.repoKey);
		}
		for (const item of links.slice(0, 5)) {
			console.log("  " + item.name + "  [" + item.kindLabel + "]  " + item.spec + "  （无仓库指纹）");
		}

		console.log("");
		console.log("③ 三态对账（用真实条目 + 构造的候选来源）");
		const linkSample = links[0] || null;
		const npmSample = items.find((item) => item.kind === "npm" && item.repoKey) || null;
		const blindSample = items.find((item) => item.installed && !item.repoKey && item.kind === "npm") || null;

		if (linkSample) {
			const verdict = compareInstalledSource(linkSample, {
				source: "npm",
				repoUrl: "https://github.com/someone/" + linkSample.name
			});
			check("link 装的 + 同名 npm 包 → 判「来源不同」", verdict.source === "different", verdict);
			check("link 那条是 error 级（会换掉本机那份）", verdict.tone === "error", verdict.tone);
			console.log("    「" + linkSample.name + "」→ " + verdict.text);
		} else {
			console.log("  （这个 profile 没有 link: 依赖，跳过 link 对账）");
		}

		if (npmSample) {
			const same = compareInstalledSource(npmSample, { source: "npm", repoUrl: npmSample.repoUrl });
			check("npm 装的 + 同仓库候选 → 判「同一个来源」", same.source === "same", same);
			const diff = compareInstalledSource(npmSample, { source: "npm", repoUrl: "https://github.com/zzz-fork/" + npmSample.name.replace(/^@[^/]+\//, "") });
			check("npm 装的 + 换一个仓库 → 判「来源不同」", diff.source === "different", diff);
			check("换仓库那条是 warn 级（不是一定错）", diff.tone === "warn", diff.tone);
			console.log("    「" + npmSample.name + "」→ " + diff.text);
		} else {
			console.log("  （没有带仓库指纹的 npm 依赖，跳过 npm 对账）");
		}

		if (blindSample) {
			const unknown = compareInstalledSource(blindSample, { source: "npm", repoUrl: "https://github.com/whatever/thing" });
			check("仓库未知时不判（unknown，不标红）", unknown.source === "unknown", unknown);
			check("unknown 不带红旗文案", !unknown.text, unknown.text);
		} else {
			console.log("  （没有「npm 但没写 repository」的样本，跳过未知态）");
		}

		console.log("");
		console.log("④ 「你搜的是本机插件」那句话");
		const hintSample = links[0] || items.find((item) => item.kind === "link");
		if (hintSample) {
			const hint = localOnlyHint(inv, hintSample.name, [{ name: "unrelated-result" }]);
			check("搜本机插件名（结果里没有同名条目）→ 给提示", Boolean(hint && hint.text), hint);
			if (hint) console.log("    " + hint.text);
			const quiet = localOnlyHint(inv, hintSample.name, [{ name: hintSample.name }]);
			check("结果里已有同名条目 → 不再啰嗦", quiet === null, quiet);
		} else {
			console.log("  （这个 profile 没有 link: 依赖，跳过）");
		}
	}
}

console.log("");
console.log("SUMMARY probe-sources: PASS " + passed + " / FAIL " + failed);
process.exitCode = failed === 0 && process.exitCode !== 1 ? 0 : 1;
