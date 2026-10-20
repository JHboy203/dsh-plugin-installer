/**
 * formats.js — 压缩包嗅探 + 解包（纯 Node，无第三方依赖）。
 *
 * 设计要点：
 *  1. **不信任扩展名**：只看魔数。`.zip` 里装个 PE 也照样被识破。
 *  2. **只收普通文件与目录**：符号链接 / 硬链接 / 设备节点一律整包拒绝
 *     （否则「先落一个指向 ../../ 的链接，再往里写文件」就能逃出临时目录）。
 *  3. **路径围栏**：绝对路径、盘符、`..`、NUL、超长、超深一律拒绝。
 *  4. **体积围栏**：解压总量、单文件、文件数、压缩比全有上限（防 zip bomb）。
 *     gzip 用 zlib 的 maxOutputLength 硬截断，不靠估算。
 *
 * 支持：zip（store/deflate；zip64 自动降级给系统 bsdtar）、tar（ustar+prefix+pax 路径）、
 *       tar.gz、**7z / rar（借 Windows 自带的 bsdtar，见下）**。
 *
 * 7z/rar 为什么外包给 bsdtar（2026-10-20 R2）：
 *   Windows 10/11 自带 `%SystemRoot%\System32\tar.exe`，它其实是 **bsdtar + libarchive 3.8**，
 *   实测能读 7z / rar4 / rar5（本机 3.8.9 现场验证：`tar --format 7zip` 造的包能原样解回）。
 *   自己写 7z 解码器要处理 LZMA2 与 folder 结构，成本远高于收益；外包出去只多一个进程。
 *   **围栏一点没放松**：解完立刻回扫整棵树，软链接/硬链接/设备节点照样整包拒绝，
 *   文件数、单文件、总量、压缩比四道上限全部重新按「解出来的实际大小」核算
 *   —— 因为 bsdtar 自己不管这些。
 */
import { spawn } from "node:child_process";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const UNSUPPORTED_HINT =
	"这个格式本机解不开。支持的是 zip / tar / tar.gz / 7z / rar；exe 一律不装。bzip2、zstd、加密压缩包请先用 7-Zip 转成普通 zip。";

export const DEFAULT_LIMITS = {
	maxBytes: 256 * 1024 * 1024,
	maxFileBytes: 64 * 1024 * 1024,
	maxFiles: 20000,
	maxDepth: 12,
	maxRatio: 2000
};

export class ArchiveError extends Error {
	constructor(code, message, detail) {
		super(message);
		this.name = "ArchiveError";
		this.code = code;
		this.detail = detail;
	}
}

function u16(buf, o) {
	return buf[o] | (buf[o + 1] << 8);
}
function u32(buf, o) {
	return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) + buf[o + 3] * 0x1000000;
}

function startsWithBytes(buf, bytes, at = 0) {
	if (buf.length < at + bytes.length) return false;
	for (let i = 0; i < bytes.length; i += 1) {
		if (buf[at + i] !== bytes[i]) return false;
	}
	return true;
}

function asciiAt(buf, at, text) {
	if (buf.length < at + text.length) return false;
	for (let i = 0; i < text.length; i += 1) {
		if (buf[at + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * 按魔数判真实格式。tar 没有文件头，只能看 257 偏移处的 "ustar"（POSIX 约定）。
 * @returns {{format: string, family: 'archive'|'forbidden'|'unknown', label: string}}
 */
export function sniffFormat(buf) {
	if (!buf || buf.length < 4) {
		return { format: "unknown", family: "unknown", label: "空文件或过短" };
	}
	if (startsWithBytes(buf, [0x50, 0x4b, 0x03, 0x04]) ||
		startsWithBytes(buf, [0x50, 0x4b, 0x05, 0x06]) ||
		startsWithBytes(buf, [0x50, 0x4b, 0x07, 0x08])) {
		return { format: "zip", family: "archive", label: "ZIP" };
	}
	if (startsWithBytes(buf, [0x1f, 0x8b])) {
		return { format: "tar.gz", family: "archive", label: "gzip（按 tar.gz 处理）" };
	}
	if (asciiAt(buf, 257, "ustar")) {
		return { format: "tar", family: "archive", label: "TAR" };
	}
	if (startsWithBytes(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
		return { format: "7z", family: "archive", label: "7-Zip" };
	}
	if (startsWithBytes(buf, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) {
		return { format: "rar", family: "archive", label: "RAR" };
	}
	if (startsWithBytes(buf, [0x42, 0x5a, 0x68])) {
		return { format: "bzip2", family: "unknown", label: "bzip2（不支持）" };
	}
	if (startsWithBytes(buf, [0x28, 0xb5, 0x2f, 0xfd])) {
		return { format: "zstd", family: "unknown", label: "zstd（不支持）" };
	}
	if (startsWithBytes(buf, [0x4d, 0x5a])) {
		return { format: "exe", family: "forbidden", label: "Windows 可执行文件 (PE)" };
	}
	if (startsWithBytes(buf, [0x7f, 0x45, 0x4c, 0x46])) {
		return { format: "elf", family: "forbidden", label: "Linux 可执行文件 (ELF)" };
	}
	return { format: "unknown", family: "unknown", label: "未知格式" };
}

/**
 * 把归档里的一个名字变成安全的相对路径。
 * 拒绝：空、绝对路径、盘符、`..`、NUL、超长、超深。
 */
export function safeRelPath(raw, limits = DEFAULT_LIMITS) {
	const text = String(raw ?? "").replace(/\\/g, "/");
	if (!text || text.length > 1024) {
		throw new ArchiveError("bad-path", "归档里有非法路径（空或过长）", { raw: text.slice(0, 200) });
	}
	if (text.includes("\0")) {
		throw new ArchiveError("bad-path", "归档路径里有 NUL 字节", { raw: text.slice(0, 200) });
	}
	if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) {
		throw new ArchiveError("path-escape", "归档里有绝对路径，已拒绝整包", { raw: text.slice(0, 200) });
	}
	const parts = text.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.some((p) => p === "..")) {
		throw new ArchiveError("path-escape", "归档里有 `..` 路径穿越，已拒绝整包", { raw: text.slice(0, 200) });
	}
	if (parts.length === 0) return { rel: "", dir: true };
	if (parts.length > limits.maxDepth) {
		throw new ArchiveError("too-deep", "归档目录层级过深（>" + limits.maxDepth + "）", { raw: text.slice(0, 200) });
	}
	return { rel: parts.join("/"), dir: false };
}

function destFor(root, rel) {
	const target = resolve(root, rel);
	const base = resolve(root);
	if (target !== base && !target.startsWith(base + sep)) {
		throw new ArchiveError("path-escape", "解包目标逃出了受控目录", { rel });
	}
	return target;
}

/* ── ZIP ──────────────────────────────────────────────────────────────── */

function zipEntries(buf, limits) {
	// 找 EOCD（末尾最多 64 KiB 注释）
	let eocd = -1;
	const from = Math.max(0, buf.length - 66000);
	for (let i = buf.length - 22; i >= from; i -= 1) {
		if (u32(buf, i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ArchiveError("bad-zip", "ZIP 缺少中央目录（文件可能没下完）");
	const count = u16(buf, eocd + 10);
	const cdOffset = u32(buf, eocd + 16);
	if (count === 0xffff || cdOffset === 0xffffffff) {
		throw new ArchiveError("zip64", "ZIP64 暂不支持，请用 7-Zip 重新压缩为普通 zip");
	}
	const items = [];
	let p = cdOffset;
	for (let i = 0; i < count; i += 1) {
		if (u32(buf, p) !== 0x02014b50) throw new ArchiveError("bad-zip", "ZIP 中央目录损坏");
		const flags = u16(buf, p + 8);
		const method = u16(buf, p + 10);
		const crc = u32(buf, p + 16);
		const compSize = u32(buf, p + 20);
		const uncompSize = u32(buf, p + 24);
		const nameLen = u16(buf, p + 28);
		const extraLen = u16(buf, p + 30);
		const commentLen = u16(buf, p + 32);
		const extAttr = u32(buf, p + 38);
		const localOffset = u32(buf, p + 42);
		const rawName = buf.subarray(p + 46, p + 46 + nameLen);
		const name = rawName.toString(flags & 0x800 ? "utf8" : "utf8");
		p += 46 + nameLen + extraLen + commentLen;
		const mode = (extAttr >>> 16) & 0xffff;
		const isSymlink = (mode & 0xf000) === 0xa000;
		if (flags & 0x1) throw new ArchiveError("encrypted", "ZIP 有密码，本机不处理加密压缩包");
		if (isSymlink) {
			throw new ArchiveError("symlink", "ZIP 里有符号链接，已拒绝整包（防目录逃逸）", { name });
		}
		if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
			throw new ArchiveError("zip64", "ZIP64 暂不支持，请用 7-Zip 重新压缩为普通 zip");
		}
		items.push({ name, method, crc, compSize, uncompSize, localOffset, dir: name.endsWith("/") });
	}
	if (items.length > limits.maxFiles) {
		throw new ArchiveError("too-many", "归档文件数超上限（>" + limits.maxFiles + "）");
	}
	return items;
}

function zipRead(buf, item) {
	const p = item.localOffset;
	if (u32(buf, p) !== 0x04034b50) throw new ArchiveError("bad-zip", "ZIP 本地头损坏", { name: item.name });
	const nameLen = u16(buf, p + 26);
	const extraLen = u16(buf, p + 28);
	const start = p + 30 + nameLen + extraLen;
	const raw = buf.subarray(start, start + item.compSize);
	if (item.method === 0) return Buffer.from(raw);
	if (item.method === 8) {
		try {
			return inflateRawSync(raw, { maxOutputLength: Math.max(item.uncompSize, 1) + 1024 });
		} catch (e) {
			throw new ArchiveError("inflate", "ZIP 解压失败：" + String((e && e.message) || e), { name: item.name });
		}
	}
	throw new ArchiveError("method", "ZIP 压缩方法不支持（method=" + item.method + "）", { name: item.name });
}

/* ── TAR ──────────────────────────────────────────────────────────────── */

function parseOctal(buf, at, len) {
	let text = "";
	for (let i = 0; i < len; i += 1) {
		const c = buf[at + i];
		if (c === 0 || c === 0x20) {
			if (text === "") continue;
			break;
		}
		text += String.fromCharCode(c);
	}
	text = text.trim();
	if (!text) return 0;
	const n = parseInt(text, 8);
	return Number.isFinite(n) ? n : 0;
}

function cString(buf, at, len) {
	let end = at;
	while (end < at + len && buf[end] !== 0) end += 1;
	return buf.subarray(at, end).toString("utf8");
}

function tarEntries(buf, limits) {
	const items = [];
	let p = 0;
	let paxPath = null;
	while (p + 512 <= buf.length) {
		const block = buf.subarray(p, p + 512);
		if (block.every((b) => b === 0)) break;
		const name = cString(buf, p, 100);
		const size = parseOctal(buf, p + 124, 12);
		const type = String.fromCharCode(buf[p + 156] || 0x30);
		const prefix = asciiAt(buf, p + 257, "ustar") ? cString(buf, p + 345, 155) : "";
		const dataStart = p + 512;
		const padded = Math.ceil(size / 512) * 512;
		if (type === "x" || type === "X") {
			const body = buf.subarray(dataStart, dataStart + size).toString("utf8");
			const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body);
			if (m) paxPath = m[1];
			p = dataStart + padded;
			continue;
		}
		if (type === "g") {
			p = dataStart + padded;
			continue;
		}
		if (type === "L") {
			// GNU 长名字：下一个块才是真数据
			paxPath = cString(buf, dataStart, size);
			p = dataStart + padded;
			continue;
		}
		if (type === "2" || type === "1") {
			throw new ArchiveError("symlink", "tar 里有符号链接/硬链接，已拒绝整包（防目录逃逸）", { name });
		}
		if (type !== "0" && type !== "\0" && type !== "5" && type !== "7") {
			throw new ArchiveError("tar-type", "tar 里有不支持的条目类型：" + type, { name });
		}
		const full = paxPath || (prefix ? prefix + "/" + name : name);
		paxPath = null;
		items.push({
			name: full,
			size,
			dir: type === "5" || full.endsWith("/"),
			dataStart,
			dataEnd: dataStart + size
		});
		if (items.length > limits.maxFiles) {
			throw new ArchiveError("too-many", "归档文件数超上限（>" + limits.maxFiles + "）");
		}
		p = dataStart + padded;
	}
	return items;
}

/* ── 7z / rar / zip64：外包给系统 bsdtar（libarchive）────────────────────── */

/** `%SystemRoot%\System32\tar.exe` 是 bsdtar；PATH 里那只可能是 GNU tar，不能用来解 7z。 */
export function findBsdtar() {
	const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
	return join(root, "System32", "tar.exe");
}

function runBsdtar(args, timeoutMs = 120000) {
	return new Promise((done) => {
		let child;
		try {
			child = spawn(findBsdtar(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			done({ ok: false, code: -1, out: "spawn failed: " + String((e && e.message) || e) });
			return;
		}
		let out = "";
		const cap = (b) => {
			out += String(b);
			if (out.length > 8000) out = out.slice(0, 8000);
		};
		child.stdout.on("data", cap);
		child.stderr.on("data", cap);
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			done({ ok: false, code: -1, out: "spawn error: " + String((e && e.message) || e) });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			done({ ok: code === 0, code, out: out.trim() });
		});
	});
}

/**
 * 解包之后重新核算一遍围栏 —— bsdtar 自己不管体积/链接/数量。
 * 这也是「外包」唯一的补偿手段：**先解出来，再按实际落盘的东西判**。
 */
async function verifyExtracted(root, lim, archiveBytes) {
	const stats = { files: 0, bytes: 0, dirs: 0, top: new Set() };
	const stack = [""];
	while (stack.length > 0) {
		const rel = stack.pop();
		const dir = rel ? join(root, rel) : root;
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const childRel = rel ? rel + "/" + entry.name : entry.name;
			const full = join(root, childRel);
			const st = await lstat(full);
			if (st.isSymbolicLink()) {
				throw new ArchiveError("symlink", "归档里有符号链接，已拒绝整包（防目录逃逸）", { name: childRel });
			}
			if (st.isDirectory()) {
				stats.dirs += 1;
				stack.push(childRel);
				continue;
			}
			if (!st.isFile()) {
				throw new ArchiveError("tar-type", "归档里有不支持的条目类型（不是普通文件）", { name: childRel });
			}
			if (childRel.split("/").length > lim.maxDepth) {
				throw new ArchiveError("too-deep", "归档目录层级过深（>" + lim.maxDepth + "）", { name: childRel });
			}
			if (st.size > lim.maxFileBytes) {
				throw new ArchiveError("too-big", "单个文件超出上限：" + childRel, { name: childRel, size: st.size });
			}
			stats.files += 1;
			stats.bytes += st.size;
			if (stats.files > lim.maxFiles) {
				throw new ArchiveError("too-many", "归档文件数超上限（>" + lim.maxFiles + "）");
			}
			if (stats.bytes > lim.maxBytes) {
				throw new ArchiveError("too-big", "解压总量超出上限（>" + lim.maxBytes + " 字节）");
			}
			if (childRel.includes("/")) stats.top.add(childRel.split("/")[0]);
		}
	}
	const ratio = archiveBytes > 0 ? stats.bytes / archiveBytes : 0;
	if (ratio > lim.maxRatio) {
		throw new ArchiveError("ratio", "压缩比异常（疑似压缩炸弹）：" + Math.round(ratio) + " 倍", { ratio });
	}
	return stats;
}

const BSDTAR_EXT = { "7z": "7z", rar: "rar", zip: "zip" };

async function extractViaBsdtar(buf, kind, destDir, lim) {
	const stage = await mkdtemp(join(tmpdir(), "dpi-arc-"));
	const file = join(stage, "pkg." + (BSDTAR_EXT[kind] || "bin"));
	try {
		await writeFile(file, buf);
		await mkdir(destDir, { recursive: true });
		const r = await runBsdtar(["-xf", file, "-C", destDir]);
		if (!r.ok) {
			throw new ArchiveError("bsdtar", "系统 bsdtar 解不开这个包（" + kind + "）：" + r.out.slice(0, 400), { format: kind });
		}
		const stats = await verifyExtracted(destDir, lim, buf.length);
		if (stats.files === 0) {
			throw new ArchiveError("empty", "归档里没有可解出的普通文件");
		}
		return { ...stats, top: [...stats.top] };
	} finally {
		await rm(stage, { recursive: true, force: true }).catch(() => {});
	}
}

/* ── 统一入口 ─────────────────────────────────────────────────────────── */

/**
 * 解包到 destDir。返回统计信息；任何围栏被触碰都抛 ArchiveError（整包失败）。
 * @param {Buffer} buf
 * @param {string} format sniffFormat() 给出的 format
 * @param {string} destDir 受控临时目录（调用方保证已按 job 隔离）
 * @param {object} [limits]
 */
export async function extractToDir(buf, format, destDir, limits = DEFAULT_LIMITS) {
	const lim = { ...DEFAULT_LIMITS, ...limits };
	let work = buf;
	let kind = format;
	if (kind === "tar.gz") {
		try {
			work = gunzipSync(buf, { maxOutputLength: lim.maxBytes });
		} catch (e) {
			throw new ArchiveError("gunzip", "gzip 解压失败或超出体积上限：" + String((e && e.message) || e), {});
		}
		kind = "tar";
	}
	if (kind !== "zip" && kind !== "tar") {
		if (kind === "7z" || kind === "rar") {
			return extractViaBsdtar(buf, kind, destDir, lim);
		}
		throw new ArchiveError("format", "不支持的归档格式：" + format, { format });
	}

	const stats = { files: 0, bytes: 0, skipped: 0, top: new Set(), dirs: 0 };
	await mkdir(destDir, { recursive: true });

	const guardSize = (uncomp, comp, name) => {
		if (uncomp > lim.maxFileBytes) {
			throw new ArchiveError("too-big", "单个文件超出上限：" + name, { name, size: uncomp });
		}
		if (comp > 0 && uncomp / comp > lim.maxRatio) {
			throw new ArchiveError("ratio", "压缩比异常（疑似 zip bomb）：" + name, { name, uncomp, comp });
		}
	};

	if (kind === "zip") {
		try {
			for (const item of zipEntries(buf, lim)) {
			if (item.dir) {
				stats.dirs += 1;
				continue;
			}
			const { rel, dir } = safeRelPath(item.name, lim);
			if (dir) continue;
			guardSize(item.uncompSize, item.compSize, item.name);
			stats.bytes += item.uncompSize;
			if (stats.bytes > lim.maxBytes) {
				throw new ArchiveError("too-big", "解压总量超出上限（>" + lim.maxBytes + " 字节）");
			}
			const data = zipRead(buf, item);
			if (data.length > lim.maxFileBytes) {
				throw new ArchiveError("too-big", "单个文件超出上限：" + item.name);
			}
			const target = destFor(destDir, rel);
			await mkdir(join(target, ".."), { recursive: true });
			await writeFile(target, data);
			stats.files += 1;
			const top = rel.split("/")[0];
			if (rel.includes("/")) stats.top.add(top);
			}
		} catch (e) {
			// ZIP64 / 少见的存储方法（deflate64、bzip2-in-zip）：交给系统 bsdtar 再来一次。
			if (e && e.name === "ArchiveError" && (e.code === "zip64" || e.code === "method")) {
				return extractViaBsdtar(buf, "zip", destDir, lim);
			}
			throw e;
		}
	} else {
		for (const item of tarEntries(work, lim)) {
			if (item.dir) {
				stats.dirs += 1;
				continue;
			}
			const { rel, dir } = safeRelPath(item.name, lim);
			if (dir) continue;
			guardSize(item.size, item.size, item.name);
			stats.bytes += item.size;
			if (stats.bytes > lim.maxBytes) {
				throw new ArchiveError("too-big", "解压总量超出上限（>" + lim.maxBytes + " 字节）");
			}
			const data = work.subarray(item.dataStart, item.dataEnd);
			const target = destFor(destDir, rel);
			await mkdir(join(target, ".."), { recursive: true });
			await writeFile(target, data);
			stats.files += 1;
			const top = rel.split("/")[0];
			if (rel.includes("/")) stats.top.add(top);
		}
	}
	if (stats.files === 0) {
		throw new ArchiveError("empty", "归档里没有可解出的普通文件");
	}
	return { ...stats, top: [...stats.top] };
}
