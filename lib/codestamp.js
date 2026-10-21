/**
 * codestamp.js — 「现在跑的是哪一版代码」的**自动**答案。
 *
 * 为什么需要它（R9/R10 各踩一次）：
 *   宿主对插件的 `index.js` 改动会被重新 apply，但被它 import 的 `lib/*` **不保证**换新。
 *   于是「磁盘上是新代码、跑着的是旧逻辑」能持续半小时而毫无提示。我们当时的办法是
 *   人工做「行为探针」——加一个新的动作/字段，再打一次请求看哪一边回话。那不叫机制。
 *
 * 现在的做法：模块**首次被 import 时**把 `index.js + client.js + lib/*.js` 的内容哈希
 * 记在内存里（那一刻的磁盘内容就是真正被加载的那份代码），之后任何一次请求都能拿
 * 「加载时的哈希」和「此刻磁盘的哈希」对比：
 *   fresh=true  → 跑的就是磁盘上的代码；
 *   fresh=false → 磁盘改过了，宿主还没换成新的（需要重启；改的若是 lib/* 尤其如此）。
 *
 * 它同时替代了两件不可靠的事：
 *   · 构建标签（= 源码 mtime）只能证明**磁盘**新，证明不了**运行中**的是哪一版；
 *   · `client-state.build` 只说明客户端 bundle 的版本，与宿主侧无关。
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 参与指纹的文件：入口、客户端 bundle、以及 lib/ 下全部 .js（排序保证稳定）。 */
async function sourceFiles() {
	const files = ["index.js", "client.js"];
	const libDir = join(ROOT, "lib");
	const libs = await readdir(libDir).catch(() => []);
	for (const file of libs.filter((f) => f.endsWith(".js")).sort()) files.push("lib/" + file);
	return files;
}

/**
 * 对当前磁盘上的源码算指纹。
 * @returns {Promise<{digest:string, files:number, newest:number, newestFile:string|null}>}
 */
export async function sourceDigest() {
	const hash = createHash("sha256");
	let count = 0;
	let newest = 0;
	let newestFile = null;
	for (const rel of await sourceFiles()) {
		let text;
		try {
			text = await readFile(join(ROOT, rel), "utf8");
		} catch {
			continue;
		}
		hash.update(rel + "\u0000" + text + "\u0000");
		count += 1;
		try {
			const info = await stat(join(ROOT, rel));
			if (info.mtimeMs > newest) {
				newest = info.mtimeMs;
				newestFile = rel;
			}
		} catch {
			/* ignore */
		}
	}
	return { digest: hash.digest("hex").slice(0, 16), files: count, newest, newestFile };
}

/** 模块首次被 import 的那一刻快照 —— 这就是「真正加载进来的代码」。 */
const capture = async () => {
	const at = new Date().toISOString();
	const digest = await sourceDigest().catch(() => null);
	return { at, digest };
};

export const LOADED = await capture();

/**
 * 运行中代码 vs 磁盘代码。
 *
 * ⚠️ 它能证明什么、不能证明什么（必须写清楚，否则又变成「自洽地错」）：
 *   · 能证明：**加载发生之后磁盘又改过**（此时 fresh=false —— 这是最常见的「改了没生效」）；
 *   · 不能证明：每当宿主只重新 apply 了入口、被 import 的 `lib/*` 仍沿用旧实例时，
 *     本模块自己可能也是「这一代」新载入的，于是哈希与磁盘相同、却仍有个别 lib 是旧实例。
 *   所以口径是：`fresh=true` 只说明「加载晚于这些文件的写入」；**改完 `lib/*` 要确认新版真的在跑，
 *   最稳的仍然是重启**。这一行是起点（省掉人工探针），不是终点。
 */
export async function freshness() {
	const disk = await sourceDigest().catch(() => null);
	const loaded = LOADED.digest;
	const fresh = Boolean(disk && loaded && disk.digest === loaded.digest);
	return { fresh, loaded, disk, at: LOADED.at };
}

/** 一句话给状态工具/面板用。 */
export function describeFreshness(state) {
	if (!state || !state.disk || !state.loaded) return "读不到（源码目录不可读）";
	const at = state.at ? new Date(state.at) : null;
	const when = at && !Number.isNaN(at.getTime())
		? String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0") + ":" + String(at.getSeconds()).padStart(2, "0")
		: "?";
	if (state.fresh) return "加载于 " + when + " · 与磁盘一致（" + state.disk.files + " 个文件 · " + state.disk.digest + "）";
	const changed = state.disk.newestFile || "源码";
	return "加载于 " + when + " · 旧（磁盘已改：" + changed + "，需要重启 DSH 才会换新）";
}
