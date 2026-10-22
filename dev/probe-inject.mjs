/**
 * dev/probe-inject.mjs — 手动探针：拿**本机真实插件**验 inject 扫描会不会误报。
 *
 * 为什么单独留一个：`scanInject` 的判据是静态近似（函数体切分、注释剥离、三种声明写法），
 * 单元测试用的是自己造的合成包；真正判断「会不会对着真实插件乱喊」要看这里。
 * 2026-10-22 R13 用它对照过：dsh-imgops（真有病）报 1 条、本插件 / dsh-screenshot（canvas 同名 ctx）/
 * dsh-diag / dsh-ops 全部零误报。
 *
 * 跑法：`node dev/probe-inject.mjs [目录…]`（默认取相邻的 DSH-Plugin 里的几个已知插件）
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeInjectScan, injectFixLine, scanInject } from "../lib/inject.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const siblings = join(here, "..");

const targets = process.argv.slice(2).length > 0
	? process.argv.slice(2)
	: [
		join(here),                      /* 本插件自己（应当零违规） */
		join(siblings, "dsh-imgops"),
		join(siblings, "dsh-screenshot"), /* canvas 里同名 ctx：最容易误报的一个 */
		join(siblings, "dsh-diag"),
		join(siblings, "dsh-ops")
	];

let bad = 0;
for (const dir of targets) {
	const scan = await scanInject(dir, { maxFiles: 200 });
	const label = dir.split(/[\\/]/).filter(Boolean).pop();
	if (scan.files === 0) {
		console.log("skip", label, "（读不到或没有 .js）");
		continue;
	}
	if (scan.violations.length > 0) bad += 1;
	console.log((scan.violations.length > 0 ? "HIT  " : "clean") + " " + label + " · entries " + scan.entries + " · " + describeInjectScan(scan));
	if (scan.violations.length > 0) console.log("      fix:", injectFixLine(scan.violations.map((v) => v.service), scan.declared));
}
console.log("");
console.log(bad === 0 ? "全部干净（若期望有命中，确认路径）" : bad + " 个目录有命中 —— 确认是否符合预期");
