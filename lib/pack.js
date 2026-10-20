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
import { join, resolve, sep } from "node:path";

function octal(value, length) {
	const text = Math.max(0, Math.floor(value)).toString(8);
	return text.padStart(length - 1, "0") + "\0";
}

function tarHeader(name, size, mtime, mode) {
	const block = Buffer.alloc(512, 0);
	const nameBuf = Buffer.from(name, "utf8");
	nameBuf.copy(block, 0, 0, Math.min(100, nameBuf.length));
	block.write(octal(mode, 8), 100, "ascii");
	block.write(octal(0, 8), 108, "ascii");
	block.write(octal(0, 8), 116, "ascii");
	block.write(octal(size, 12), 124, "ascii");
	block.write(octal(mtime, 12), 136, "ascii");
	block.write("        ", 148, "ascii");
	block.write("0", 156, "ascii");
	block.write("ustar\0", 257, "ascii");
	block.write("00", 263, "ascii");
	let sum = 0;
	for (let i = 0; i < 512; i += 1) sum += block[i];
	block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
	return block;
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
		if (Buffer.byteLength(name) > 100) {
			/* ustar 的 name 只有 100 字节；超长就拒绝，别悄悄截断 */
			throw new Error("路径过长，无法打进 tgz：" + file.rel);
		}
		if (resolve(file.full) !== resolve(root + sep + file.rel)) {
			throw new Error("打包路径越界：" + file.rel);
		}
		const data = await readFile(file.full);
		parts.push(tarHeader(name, data.length, Math.floor(file.mtime / 1000), 0o644), data);
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
