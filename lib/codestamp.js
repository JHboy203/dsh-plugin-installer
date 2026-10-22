/**
 * codestamp.js — 「现在跑的是哪一版代码」的**自动**答案。
 *
 * 为什么需要它（R9/R10 各踩一次）：
 *   宿主对插件的 `index.js` 改动会被重新 apply，但被它 import 的 `lib/*` **不保证**换新。
 *   于是「磁盘上是新代码、跑着的是旧逻辑」能持续半小时而毫无提示。我们当时的办法是
 *   人工做「行为探针」——加一个新的动作/字段，再打一次请求看哪一边回话。那不叫机制。
 *
 * 现在的做法：模块**首次被 import 时**把源码内容哈希记在内存里（那一刻的磁盘内容就是
 * 真正被加载的那份代码），之后任何一次请求都能拿「加载时的哈希」和「此刻磁盘的哈希」对比：
 *   fresh=true  → 跑的就是磁盘上的代码；
 *   fresh=false → 磁盘改过了，宿主还没换成新的（需要重启；改的若是 lib/* 尤其如此）。
 *
 * R15：指纹拆成**宿主**（`index.js` + `lib/*.js`）与**客户端**（`client.js`）两栏。
 *   为什么必须拆：`client.js` 是宿主**自动热重载**的（改完提 BUILD 号即可），但旧实现把它
 *   算进同一枚指纹，于是「只改了客户端」也会让状态工具报「这一版还没被 apply / 要重启」——
 *   一句会指挥人做无用功的假告警（R14 会话里连着踩了两次）。现在：
 *   · 宿主指纹变 → 真需要重新 apply / 重启；
 *   · 只有客户端变 → 明确说「宿主会自动重载，别为这个重启」。
 *   ⚠️ 兼容旧进程：旧实例的 `LOADED` 只有合并指纹（没有 host/client 两栏），此时退回合并口径，
 *   直到那次 re-apply 把它换新为止 —— 宁可暂时保持旧行为，也不许在旧进程上编一个假结论。
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

/** 宿主侧代码（改这些才需要重启）。 */
async function hostFileList() {
	const files = ["index.js"];
	const libDir = join(ROOT, "lib");
	const libs = await readdir(libDir).catch(() => []);
	for (const file of libs.filter((f) => f.endsWith(".js")).sort()) files.push("lib/" + file);
	return files;
}

/** 客户端 bundle（宿主会自动重载；只用于「客户端变没变」这一栏）。 */
const CLIENT_FILE = "client.js";

async function hashList(files) {
	const hash = createHash("sha256");
	let count = 0;
	let newest = 0;
	let newestFile = null;
	for (const rel of files) {
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
	return { digest: hash.digest("hex").slice(0, 16), count, newest, newestFile };
}

/**
 * 两栏指纹 + 合并口径。
 * @returns {Promise<{all:string, host:string, client:string, files:number, hostFiles:number,
 *   clientFiles:number, newest:number, newestFile:string|null, clientNewest:number, clientNewestFile:string|null}>}
 */
export async function sourceDigests() {
	const files = [...(await hostFileList()), CLIENT_FILE];
	const [all, host, client] = await Promise.all([hashList(files), hashList(files.filter((f) => f !== CLIENT_FILE)), hashList([CLIENT_FILE])]);
	return {
		all: all.digest,
		host: host.digest,
		client: client.digest,
		files: all.count,
		hostFiles: host.count,
		clientFiles: client.count,
		/* 「需要重启」只看宿主那半的最后写入时刻 */
		newest: host.newest,
		newestFile: host.newestFile,
		clientNewest: client.newest,
		clientNewestFile: client.newestFile
	};
}

/**
 * 合并指纹（R11 的旧口径，保留给外部/测试使用）。
 * @returns {Promise<{digest:string, files:number, newest:number, newestFile:string|null}>}
 */
export async function sourceDigest() {
	const disk = await sourceDigests();
	const clientNewer = disk.clientNewest > disk.newest;
	return {
		digest: disk.all,
		files: disk.files,
		newest: clientNewer ? disk.clientNewest : disk.newest,
		newestFile: clientNewer ? disk.clientNewestFile : disk.newestFile
	};
}

/** 模块首次被 import 的那一刻快照 —— 这就是「真正加载进来的代码」。 */
const capture = async () => {
	const at = new Date().toISOString();
	const digest = await sourceDigests().catch(() => null);
	return {
		at,
		all: digest ? digest.all : null,
		host: digest ? digest.host : null,
		client: digest ? digest.client : null
	};
};

export const LOADED = await capture();

/**
 * 记录「宿主刚刚重新 apply 过一次」（R12.1）。
 *
 * 为什么需要它：本模块自己的 `LOADED` 只在 **codestamp.js 被加载**时算一次。而宿主
 * 实测是**逐文件**换新的（改了哪个文件就重新 import 哪个）：`codestamp.js` 内容没变，
 * 它就一直沿用 02:04 那个实例 —— 于是「加载于 02:04」这句话永远不会更新，哪怕入口
 * 与 `lib/*` 早就换成了 02:32 的新代码（2026-10-22 实测：`/inventory` 已经是新路由、
 * 面板新卡也在渲染，这一行却还在说「需要重启」）。**那是最坏的一种：判据反过来指挥人去重启。**
 *
 * `apply()` 每次（重新）apply 都会跑，所以把「最后一次 apply 的时间」记到 globalThis 上
 * （跨模块实例共享，且旧实例写的东西新实例也读得到）。有了它，就能把两种情况分开：
 *   · 磁盘改过、之后**没有** re-apply → 确实还是旧代码，建议重启；
 *   · 磁盘改过、之后**有** re-apply   → 入口已是新的；`lib/*` 是否全部换新本机制**证不了**，
 *     这时该看行为（新路由/新字段回不回话），而不是无脑重启。
 */
export function recordApply(at = Date.now()) {
	globalThis.__dpiInstallerApply = { at };
	return globalThis.__dpiInstallerApply;
}

export function lastApply() {
	const v = globalThis.__dpiInstallerApply;
	return v && Number.isFinite(v.at) ? v : null;
}

/**
 * 运行中代码 vs 磁盘代码。
 *
 * ⚠️ 它能证明什么、不能证明什么（必须写清楚，否则又变成「自洽地错」）：
 *   · 能证明：**加载发生之后磁盘又改过**（此时 fresh=false —— 这是最常见的「改了没生效」）；
 *   · 不能证明：每当宿主只重新 apply 了入口、被 import 的 `lib/*` 仍沿用旧实例时，
 *     本模块自己可能也是「这一代」新载入的，于是哈希与磁盘相同、却仍有个别 lib 是旧实例。
 *   所以口径是：`fresh=true` 只说明「加载晚于这些文件的写入」；**改完 `lib/*` 要确认新版真的在跑，
 *   最稳的仍然是重启**。这一行是起点（省掉人工探针），不是终点。
 *
 * R12.1 补的第三条口径：宿主是**逐文件**换新的，所以 `LOADED.at` 只代表 codestamp.js
 * 自己被加载的时刻，不代表别的模块。`appliedAfterLoad=true` 时说明入口被重新 apply 过，
 * 此时**不能再断言「需要重启」** —— 只能说「证不了，看行为」。
 *
 * R15 补的第四条口径：`fresh` 现在只指**宿主**那半。`client.js` 单独一栏（`client.changed`），
 * 因为它是宿主自动热重载的 —— 把两者混在一起会让「只改客户端」也报「需要重启」。
 */
export async function freshness() {
	const disk = await sourceDigests().catch(() => null);
	const split = Boolean(LOADED.host && LOADED.client);
	const loadedHost = split ? LOADED.host : LOADED.all;
	const fresh = Boolean(disk && loadedHost && loadedHost === disk.host);
	const applied = lastApply();
	const loadedAt = LOADED.at ? new Date(LOADED.at).getTime() : null;
	const appliedAfterLoad = Boolean(applied && loadedAt && applied.at > loadedAt + 500);
	/* R13：真正的判据不是「有没有 re-apply 过」，而是「最后一次 re-apply 是否晚于磁盘最后写入」。
	   R12.1 在这点上判歪了：appliedAt 比磁盘新才算入口换新；否则「apply 过」只说明曾经换过一次，
	   改完这一版仍然没生效（本机实测：13:03 改 index.js，appliedAt 还停在 12:51:54）。 */
	const diskNewest = disk && Number.isFinite(disk.newest) ? disk.newest : null;
	const staleAfterApply = Boolean(applied && diskNewest && applied.at < diskNewest - 1000);
	return {
		fresh,
		loaded: loadedHost || null,
		disk: disk
			? { digest: disk.host, files: disk.files, hostFiles: disk.hostFiles, newest: disk.newest, newestFile: disk.newestFile }
			: null,
		/* 客户端那一栏：changed=null 表示这次加载没有分栏（旧进程），不许猜 */
		client: disk ? { digest: disk.client, changed: split ? LOADED.client !== disk.client : null, newestFile: disk.clientNewestFile } : null,
		at: LOADED.at,
		appliedAt: applied ? new Date(applied.at).toISOString() : null,
		appliedAfterLoad,
		staleAfterApply,
		/* 磁盘比最后一次 apply 新 = 这一版没被 apply（要么等它自己、要么重启） */
		needsApply: !fresh && !applied ? true : staleAfterApply
	};
}

/** 一句话给状态工具/面板用。 */
export function describeFreshness(state) {
	if (!state || !state.disk || !state.loaded) return "读不到（源码目录不可读）";
	const hm = (iso) => {
		const at = iso ? new Date(iso) : null;
		return at && !Number.isNaN(at.getTime())
			? String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0") + ":" + String(at.getSeconds()).padStart(2, "0")
			: "?";
	};
	const when = hm(state.at);
	if (state.fresh) {
		const base = "加载于 " + when + " · 与磁盘一致（宿主 " + (state.disk.hostFiles || state.disk.files) + " 个文件 · " + state.disk.digest + "）";
		if (state.client && state.client.changed === true) {
			return base + "；客户端 client.js 磁盘已更新（宿主会自动重载，看面板 BUILD 号；别为这个重启）";
		}
		if (state.client && state.client.changed === false) return base + " · 客户端未变";
		return base;
	}
	const changed = state.disk.newestFile || "源码";
	if (state.needsApply) {
		/* 磁盘比「最后一次 apply」还新 → 这一版**没被 apply**，说什么都没用，就是没生效。 */
		return "加载于 " + when + " · 旧（磁盘已改：" + changed + (state.appliedAt ? "，但最后一次 apply 是 " + hm(state.appliedAt) : "") +
			"）—— 这一版还没被 apply，要重新 apply / 重启 DSH 才会换新";
	}
	if (state.appliedAfterLoad) {
		/* 实测最常见的一种：宿主逐文件换新 → 入口已经重新 apply 过，但 codestamp.js 自己没变、
		   仍报「加载于旧的时刻」。这时**不能说「需要重启」** —— 那会指挥人做无用功。 */
		return "加载于 " + when + " · 磁盘之后改过（" + changed + "）且宿主已在 " + hm(state.appliedAt) +
			" 重新 apply（晚于磁盘）—— 入口是新的；`lib/*` 是否全部换新本指纹证不了，看行为（新接口回话即生效），别为这个盲目重启";
	}
	return "加载于 " + when + " · 旧（磁盘已改：" + changed + "，需要重新 apply / 重启 DSH 才会换新）";
}
