/**
 * probe-skills.mjs — 不进宿主，用**真实技能根**跑一遍技能判据。
 *
 * 为什么要有它：`lib/skills.js` / `lib/detect.js` 的判据改了以后，宿主里要重启才生效；
 * 而「新判据会不会把正常技能报成坏的」必须在真实数据上先看一遍（R21 加了三类 YAML 硬错误：
 * Tab 缩进 / 重复键 / 引号没闭合 —— 误报会直接劝人去改一个本来正常的 SKILL.md）。
 *
 * 用法：host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-skills.mjs"})
 */
import { skillRoots } from "../lib/hostinfo.js";
import { readSkillsOnDisk, buildSkillView, summarizeSkills } from "../lib/skills.js";

const roots = skillRoots();
const items = await readSkillsOnDisk({ roots });
const view = buildSkillView({ roots, items, host: null, panelInstalled: [] });

console.log("roots:", roots.join(" | "));
console.log("items:", items.length);
console.log("counts:", JSON.stringify(view.counts));
console.log("summary:", summarizeSkills(view.counts));
console.log("== yamlBroken ==");
for (const row of view.yamlBroken || []) console.log("  ·", row.dir, row.code, "-", row.message);
console.log("== rows ==");
for (const row of view.items) {
	console.log("  -", row.dir, "| valid=" + row.valid, "| backup=" + Boolean(row.backup), "| yaml=" + (row.yamlIssue ? row.yamlIssue.code + " fixable=" + String(row.yamlIssue.fixable) : "ok"));
}
