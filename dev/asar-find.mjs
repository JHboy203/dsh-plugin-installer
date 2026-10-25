/**
 * dev/asar-find.mjs — 在 app.asar（或任意大文本文件）里找 ASCII 标记并打印上下文。
 *
 * 为什么需要它（R26.3 固化）：宿主拒绝原地换版本（`already-installed`）这件事，
 * 不是猜出来的 —— 是在 `app.asar` 里搜到
 *   reasonAlreadyInstalled: "This package is already installed; uninstall it before installing another version."
 * 才定的。以后遇到「宿主某个 API 为什么拒绝/怎么判」的问题，用同一个办法查，别靠记忆。
 *
 * 用法：
 *   node dev/asar-find.mjs <app.asar 路径> <标记> [命中数=3] [上下文半径=900]
 *   典型：node dev/asar-find.mjs "D:/DSH/resources/app.asar" "already-installed" 4 700
 *
 * 说明：asar 是拼接归档，JS 源码以明文存在里面，所以按字节找标记再打印周边即可；
 * 输出里的非可打印字节会被替换成 `.`。只读、不联网。
 */
import { open } from "node:fs/promises";

const [file, marker, hitsArg, radiusArg] = process.argv.slice(2);
if (!file || !marker) {
	console.error("usage: node dev/asar-find.mjs <file> <marker> [hits] [radius]");
	process.exit(2);
}
const hits = Number(hitsArg || 3);
const radius = Number(radiusArg || 900);
const fh = await open(file, "r");
const { size } = await fh.stat();
const CHUNK = 8 * 1024 * 1024;
const needle = Buffer.from(marker, "latin1");
let carry = Buffer.alloc(0);
let pos = 0;
let found = 0;
while (pos < size && found < hits) {
	const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
	await fh.read(buf, 0, buf.length, pos);
	const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
	let idx = hay.indexOf(needle);
	const base = pos - carry.length;
	while (idx >= 0 && found < hits) {
		const from = Math.max(0, idx - radius);
		const to = Math.min(hay.length, idx + needle.length + radius);
		console.log("--- hit " + (found + 1) + " @ " + (base + idx) + " ---");
		console.log(hay.slice(from, to).toString("latin1").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "."));
		found += 1;
		idx = hay.indexOf(needle, idx + needle.length);
	}
	carry = hay.slice(Math.max(0, hay.length - needle.length - radius));
	pos += buf.length;
}
await fh.close();
console.log("hits=" + found + " size=" + size);
