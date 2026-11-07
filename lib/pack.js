/**
 * pack.js — 把「已经扫描过的那份目录」重新打成一个 npm 风格的 .tgz，再交给插件管理器。
 *
 * 为什么不用目录直接装：
 *   `pnpm add <目录>` 记的是 **link:**，node_modules 里是一个指向目录的符号链接。
 *   如果那个目录在 jobs 的临时区（我们正是从那儿解包的），任务一收尾就删掉了，
 *   链接立刻变悬空 —— 插件在下次重启时消失。
 *   而 `pnpm add <本机 .tgz>` 会把内容**解进 node_modules**，不依赖任何外部目录，
 *   也正好满足「装的就是我扫过的那份字节」。
 *
 * 输出布局遵循 npm 约定：所有文件都在 `package/` 前缀下。
 */
import { gzipSync } from "node:zlib";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

function octal(value, length) {
	const text = Math.max(0, Math.floor(value)).toString(8);
	return text.padStart(length - 1, "0") + "\0";
}

function tarHeader(nameBuf, prefixBuf, size, mtime, mode, type = "0") {
	const block = Buffer.alloc(512, 0);
	nameBuf.copy(block, 0, 0, Math.min(100, nameBuf.length));
	if (prefixBuf && prefixBuf.length > 0) prefixBuf.copy(block, 345, 0, Math.min(155, prefixBuf.length));
	block.write(octal(mode, 8), 100, "ascii");
	block.write(octal(0, 8), 108, "ascii");
	block.write(octal(0, 8), 116, "ascii");
	block.write(octal(size, 12), 124, "ascii");
	block.write(octal(mtime, 12), 136, "ascii");
	block.write("        ", 148, "ascii");
	block.write(String(type), 156, "ascii");
	block.write("ustar\0", 257, "ascii");
	block.write("00", 263, "ascii");
	let sum = 0;
	for (let i = 0; i < 512; i += 1) sum += block[i];
	block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
	return block;
}

/**
 * R52：ustar 其实有 **两段式路径** —— `name`(100) + `prefix`(155)，中间用 `/` 撑开，
 * 最长可到 255 字节。以前这里只写了 `name`，超过 100 字节就直接报「路径过长」，
 * 结果带深层 assets 的插件（如 `skills/x/assets/screenshot-backgrounds/style-b/….webp`）**根本装不了**。
 * 拆不出来（长尾本身就是 100+ 的一大段）返回 null，调用方改走 PAX。
 */
function splitUstarPath(nameBuf) {
	if (nameBuf.length <= 100) return { name: nameBuf, prefix: Buffer.alloc(0) };
	for (let i = nameBuf.length - 1; i > 0; i -= 1) {
		if (nameBuf[i] !== 0x2f) continue; // '/'
		const prefix = nameBuf.subarray(0, i);
		const tail = nameBuf.subarray(i + 1);
		if (tail.length > 0 && tail.length <= 100 && prefix.length > 0 && prefix.length <= 155) {
			return { name: tail, prefix };
		}
	}
	return null;
}

/** PAX 扩展头的一条记录：`<总长> <key>=<value>\n`，总长含它自己。 */
function paxRecord(key, value) {
	const body = key + "=" + value + "\n";
	const bodyLen = Buffer.byteLength(body);
	let total = bodyLen + String(bodyLen).length + 1;
	for (let guard = 0; guard < 8; guard += 1) {
		const guess = bodyLen + String(total).length + 1;
		if (guess === total) break;
		total = guess;
	}
	return total + " " + body;
}

async function collect(root, rel, out, limits) {
	const entries = await readdir(join(root, rel), { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const childRel = rel ? rel + "/" + entry.name : entry.name;
		if (entry.isDirectory()) {
			await collect(root, childRel, out, limits);
			continue;
		}
		if (!entry.isFile()) continue;
		const full = join(root, childRel);
		const info = await stat(full);
		if (info.size > limits.maxFileBytes) throw new Error("单文件过大，拒绝打包：" + childRel);
		out.push({ rel: childRel, full, size: info.size, mtime: info.mtimeMs });
		if (out.length > limits.maxFiles) throw new Error("文件数超过上限，拒绝打包");
	}
	return out;
}

/**
 * @param {string} dir 已扫描过的插件目录（package.json 所在的那一层）
 * @param {string} outFile 输出的 .tgz 绝对路径
 * @param {object} [options] {maxFiles, maxFileBytes}
 * @returns {{path:string, files:number, bytes:number}}
 */
export async function packPluginTarball(dir, outFile, options = {}) {
	const limits = { maxFiles: options.maxFiles || 20000, maxFileBytes: options.maxFileBytes || 64 * 1024 * 1024 };
	const root = resolve(dir);
	const files = await collect(root, "", [], limits);
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const parts = [];
	let total = 0;
	for (const file of files) {
		const name = "package/" + file.rel;
		if (resolve(file.full) !== resolve(root + sep + file.rel)) {
			throw new Error("打包路径越界：" + file.rel);
		}
		const data = await readFile(file.full);
		const mtime = Math.floor(file.mtime / 1000);
		const nameBuf = Buffer.from(name, "utf8");
		const split = splitUstarPath(nameBuf);
		if (split) {
			parts.push(tarHeader(split.name, split.prefix, data.length, mtime, 0o644), data);
		} else {
			/* 连 prefix 也装不下（>255 字节）：写一条 PAX 扩展头，真名放里面。
			   随后的文件头放「尾部 ≤100 字节」占位，读端见到 paxPath 就以它为准
			   （npm/pnpm 的 tar、以及本插件的 lib/formats.js 都认 PAX）。 */
			const paxBody = Buffer.from(paxRecord("path", name), "utf8");
			const paxName = Buffer.from(("PaxHeader/" + basename(file.rel)).slice(0, 100), "utf8");
			parts.push(tarHeader(paxName, Buffer.alloc(0), paxBody.length, mtime, 0o644, "x"), paxBody);
			const paxPad = (512 - (paxBody.length % 512)) % 512;
			if (paxPad > 0) parts.push(Buffer.alloc(paxPad, 0));
			const tail = nameBuf.subarray(Math.max(0, nameBuf.length - 100));
			parts.push(tarHeader(tail, Buffer.alloc(0), data.length, mtime, 0o644), data);
		}
		const pad = (512 - (data.length % 512)) % 512;
		if (pad > 0) parts.push(Buffer.alloc(pad, 0));
		total += data.length;
	}
	parts.push(Buffer.alloc(1024, 0));
	const gz = gzipSync(Buffer.concat(parts), { level: 9 });
	await writeFile(outFile, gz);
	return { path: outFile, files: files.length, bytes: gz.length, rawBytes: total };
}

/** 给 UI/日志用：把绝对路径改成短标签。 */
export function shortPath(path) {
	return String(path || "").split(/[\\/]/).slice(-2).join("/");
}
