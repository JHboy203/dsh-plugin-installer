/**
 * clientrev.js — 「崩溃日志里失败的那份 client 包，和现在磁盘上的是不是同一份」（R24）。
 *
 * 为什么要有它：web-boot 失败（`crash-*-web-boot.log`）只有**失败记录**，日志里没有「成功」这一行。
 * R18 用「日志早于本进程启动」判「上一次启动留下的」，那只能说明「之后没有再失败」——
 * 既不能证明「失败的那份字节已经不在了」，也不能证明「现在是好的」。于是面板只能说
 * 「可能已自愈」，用户还是不知道要不要动手。
 *
 * 宿主给了确定性答案：`@deepseek-ai/dsh-client-modules` 会给每个 client bundle 算一个 `rev`
 * 写进 bundle 的 URL（`plugins/??<包名>/client.js&rev=<12 hex>`），而崩溃日志把出错的 URL
 * 原样抄了下来。rev 的算法（该包 `lib/index.js` 的 `artifactRevision`）是：
 *
 *   framedHash("plugin-artifact", [String(mtimeMs), String(ctimeMs), String(size)])
 *   framedHash(domain, parts) = sha1(domain + "\0" + Σ`<bufLen(part)>:<part>`).hex.slice(0, 12)
 *
 * 只依赖文件系统的 mtime / ctime / size，**不读文件内容**。所以只要本机还能 stat 到那个文件，
 * 就能重算出「现在这份」的 rev，与日志里的 rev 一比：
 *
 *   · 相同 → 还是同一份字节，重启会再遇到同一个错误（要真修）；
 *   · 不同 → 日志里那份已经被重新构建/覆盖了（`mtime` 就是新构建时间）；
 *   · 日志里没抄 rev（`import failed (see console)` 那类）→ 退一步用 mtime 与失败时刻比，
 *     只能给「失败之后有没有改过」，不能说「字节是不是同一份」。
 *
 * ⚠️ 与宿主算法保持一致是**硬约束**：真机实测 `dsh-diag/client.js` 反算出的 rev
 * 与日志里的 `a9448b50cf9f` 逐字相同（见 dev/fixtures/rev-vectors.json，自检会钉住它）。
 * 这里**不许**改成「读文件内容算哈希」：宿主不读内容，改了就对不上。
 *
 * ⚠️ 语义边界：`rebuilt`（字节变了）≠「这次启动就好了」。rev 变只说明日志里那份没了；
 * 新的那份会不会再崩，只有下一次启动知道。面板文案不许把这条说成「已修好」。
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** 宿主 `HASH_REVISION_LENGTH`：rev 是 12 位十六进制。 */
export const HOST_REV_LENGTH = 12;

/** 与宿主 `framedHash` 逐字一致（长度前缀防止字段边界串味）。 */
function framedHash(domain, parts) {
	const hash = createHash("sha1").update(domain).update("\0");
	for (const part of parts) hash.update(String(Buffer.byteLength(part)) + ":").update(part);
	return hash.digest("hex").slice(0, HOST_REV_LENGTH);
}

/**
 * 复现宿主的 `artifactRevision(baseline)`。
 * @param {{mtimeMs:number|string, ctimeMs:number|string, size:number|string}} baseline statSync 结果
 * @returns {string} 12 位十六进制
 */
export function artifactRevision(baseline) {
	const b = baseline || {};
	return framedHash("plugin-artifact", [String(b.mtimeMs), String(b.ctimeMs), String(b.size)]);
}

/**
 * `exports["./client"]` → 相对路径。与宿主 `clientExportOf` 同判据（string / 一层条件对象的 default）。
 * @returns {{ok:true, rel:string} | {ok:false, reason:string}}
 */
export function clientBundleRel(exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return { ok: false, reason: "no-exports" };
	const client = exportsField["./client"];
	if (client === undefined) return { ok: false, reason: "no-client-export" };
	if (typeof client === "string") return { ok: true, rel: client };
	if (client && typeof client === "object" && typeof client.default === "string") return { ok: true, rel: client.default };
	return { ok: false, reason: "bad-client-export" };
}

/**
 * 从崩溃日志全文里抓「包名 → rev」。日志里的形态有几种：
 *   `plugins/??dsh-x/client.js&rev=abc123abc123: client-modules: bundle script … failed to load`
 *   `plugins/??scope/pkg/dist/client.js&rev=…`（构建产物在 dist/ 时，路径是嵌套的）
 *   `plugins/??a/client.js,b/client.js,dsh-x/client.js&rev=…`（combo：**整条**的哈希）
 *
 * 做法是「以 `/client.js&rev=` 为锚往前走到 token 起点，再按 npm 的作用域规则切名」，
 * 而不是一条正则走到底 —— 一条正则会把 `pkg/dist/client.js` 里的 `dist` 当成包名的一段。
 *
 * ⚠️ **combo URL 末尾那个 `&rev=` 是整条 combo 的哈希，不是最后一个包的 rev**
 * （真机日志里 `…,dsh-plugin-installer/client.js&rev=ae080526f657: skipped after…` ——
 * `ae080526f657` 属于整条 combo；把它当成 dsh-plugin-installer 的 rev，会得出「字节变了」
 * 的假结论，方向正好是**把该修的降级成不用修**）。判据：token 里出现逗号 = 这是一串 id，
 * 这个 rev 不属于任何单个包，丢弃。
 *
 * @returns {Record<string,string>} 键是包名（取值是小写 rev；按名取用 findBundleRev）
 */
export function parseBundleRevs(text) {
	const source = String(text || "");
	const out = {};
	const re = /\/client\.js&rev=([0-9a-f]{12})/gi;
	const BREAK = new Set([";", "?", "(", ")", "'", '"', " ", "\t", "\r", "\n"]);
	let m = re.exec(source);
	while (m) {
		const slash = m.index;
		let start = slash;
		while (start > 0 && !BREAK.has(source[start - 1])) start -= 1;
		let tail = source.slice(start, slash);
		/* 允许直接写成 `<pkg>/client.js&rev=`（renderer console 里没有 plugins/?? 前缀的情况） */
		tail = tail.replace(/^plugins\//, "");
		if (tail && !tail.includes(",")) {
			const parts = tail.split("/").filter(Boolean);
			const name = parts[0] && parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
			if (name && out[name] === undefined) out[name] = m[1].toLowerCase();
		}
		m = re.exec(source);
	}
	return out;
}

/** 大小写不敏感地取某个包的 rev（npm 包名本身大小写敏感，但日志与清单常混着写）。 */
export function findBundleRev(revs, name) {
	if (!revs) return null;
	const want = String(name || "").toLowerCase();
	for (const [key, value] of Object.entries(revs)) {
		if (key.toLowerCase() === want) return value;
	}
	return null;
}

/**
 * 解析某个已装包的 client bundle 现状（只读、只 stat）。
 * @param {string} profileDir profile 目录（含 node_modules）
 * @param {string} name 包名
 * @returns {Promise<{ok:true, name:string, path:string, rel:string, rev:string, size:number,
 *   mtimeMs:number, at:string, declared:boolean} | {ok:false, name:string, reason:string, note:string, path?:string}>}
 */
export async function resolveClientArtifact(profileDir, name) {
	const pkgName = String(name || "").trim();
	if (!profileDir || !pkgName) return { ok: false, name: pkgName, reason: "no-input", note: "缺 profile 目录或包名" };
	const dir = join(profileDir, "node_modules", pkgName);
	let raw = null;
	try {
		raw = await readFile(join(dir, "package.json"), "utf8");
	} catch {
		return { ok: false, name: pkgName, reason: "no-package", note: "node_modules 里读不到这个包的 package.json（可能没装、或只是声明了）" };
	}
	let pkg = null;
	try {
		pkg = JSON.parse(raw);
	} catch {
		return { ok: false, name: pkgName, reason: "bad-package", note: "这个包的 package.json 不是合法 JSON" };
	}
	const rel = clientBundleRel(pkg && pkg.exports);
	if (!rel.ok) {
		return {
			ok: false, name: pkgName, reason: rel.reason,
			note: rel.reason === "bad-client-export"
				? "exports[\"./client\"] 既不是字符串也不是 { default } —— 宿主会直接报错"
				: "package.json 没有 exports[\"./client\"]：宿主不会给它出 client 包（它可能只有宿主半边）"
		};
	}
	const path = join(dir, rel.rel);
	let info;
	try {
		info = await stat(path);
	} catch {
		return { ok: false, name: pkgName, reason: "no-bundle", path, note: "声明了这个 client 包，但文件不在磁盘上" };
	}
	return {
		ok: true,
		name: pkgName,
		path,
		rel: rel.rel,
		rev: artifactRevision(info),
		size: info.size,
		mtimeMs: info.mtimeMs,
		at: new Date(info.mtimeMs).toISOString(),
		declared: Boolean(pkg && pkg.dsh && pkg.dsh.client)
	};
}

/**
 * 三态判定：日志里那份 client 包现在还在不在。
 *
 * | state       | 含义                                             | 面板该说什么         |
 * |-------------|--------------------------------------------------|----------------------|
 * | `same`      | 有 rev 且相同 = 同一份字节                        | 真修（重启还会再错） |
 * | `rebuilt`   | 有 rev 且不同 = 日志里那份已经被重建/覆盖          | 「那份已经不在了」   |
 * | `unknown`   | 日志里没抄 rev（或读不到现在的文件）→ 只能说时间  | 只报事实，不许断言   |
 *
 * `movedAfterLog` 在 `unknown` 分支里给一个弱信号：文件 mtime 晚于失败时刻 = 失败之后又构建过。
 *
 * @param {{loggedRev?:string|null, loggedAt:number, current:object}} input
 */
export function classifyBundle(input) {
	const { loggedRev = null, loggedAt = 0, current = null } = input || {};
	if (!current || current.ok !== true) {
		return { state: "unknown", reason: (current && current.reason) || "no-artifact", note: (current && current.note) || null };
	}
	const currentRev = current.rev;
	const rev = loggedRev ? String(loggedRev).toLowerCase() : null;
	if (rev) {
		if (rev === currentRev) return { state: "same", rev: currentRev, artifactAt: current.mtimeMs };
		return { state: "rebuilt", loggedRev: rev, rev: currentRev, artifactAt: current.mtimeMs, changedAfterLog: Boolean(loggedAt && current.mtimeMs > loggedAt) };
	}
	return {
		state: "unknown",
		reason: "no-logged-rev",
		rev: currentRev,
		artifactAt: current.mtimeMs,
		movedAfterLog: Boolean(loggedAt && current.mtimeMs > loggedAt)
	};
}
