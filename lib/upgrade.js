/**
 * upgrade.js — 「这次提交是不是换版本、要不要先卸、怎么装回去」的**纯函数**判据。
 *
 * 为什么单独成文件：这三件事以前分散在 pipeline 里，而且判据彼此不一致 ——
 *   · 预检里的 `installed.relation`（升级/降级/同版本）只看版本号；
 *   · 装完后的 `upgradeStalled()` 只认 `noop + 版本不同`；
 *   · 回滚的 `rollbackPlan()` 又是另一套。
 * 结果是「假成功」有三个出口（R27 独立审计抓到的 P0：回滚不看回执、中断回填不比版本）。
 * 现在统一到这里：**换版本 = 先卸再装**，并且「旧版怎么装回去」也一并算出来。
 *
 * 没有副作用、不读盘、不碰宿主 —— hosttest 直接喂对象。
 *
 * @module dsh-plugin-installer/upgrade
 */

import { classifyDepSpec } from "./inventory.js";
import { compareVersions } from "./semver.js";

/** 本插件自己的包名：不能由自己卸自己（调用会把自己正在跑的运行时撕掉）。 */
export const SELF_PACKAGE = "dsh-plugin-installer";

/** 哪些声明形态**可以**走「先卸再装」。 */
const REPLACEABLE = new Set(["npm", "tarball"]);

/**
 * 这次提交需要「先卸载旧版」吗？
 *
 * @param {object} input
 * @param {string} [input.name]                    包名（默认取 detected.name）
 * @param {{version?:string|null, spec?:string|null}|null} [input.installedBefore]
 * @param {{name?:string, version?:string|null, kind?:string}} [input.detected]
 * @param {string} [input.targetVersion]           默认 detected.version
 * @param {{type?:string, spec?:string}} [input.source]
 * @returns {{needed:boolean, reason:string, name:string, from:string, to:string, kind:string,
 *   direction:string, blocked:object|null, text:string}}
 */
export function decideReplacement(input) {
	const it = input || {};
	const detected = it.detected || {};
	const before = it.installedBefore || null;
	const name = String(it.name || detected.name || "").trim();
	const from = before && before.version ? String(before.version) : "";
	const to = String(it.targetVersion || detected.version || "").trim();
	const base = { needed: false, reason: "no-installed", name, from, to, kind: "", direction: "", blocked: null, text: "" };
	if (!name || !before || !from) return base;
	if (!to) return { ...base, reason: "no-target-version" };
	if (from === to) return { ...base, reason: "same-version" };
	const cls = classifyDepSpec(before.spec, name);
	const direction = compareVersions(to, from) >= 0 ? "upgrade" : "downgrade";
	const text = from + " → " + to;
	const needed = { ...base, needed: true, reason: direction, kind: cls.kind, direction, text };
	/* 自己换自己：会把自己所在的那份依赖先删掉，安装方也就跟着死了 → 一律拒绝，交给官方管理器 */
	if (name === SELF_PACKAGE) {
		return {
			...needed,
			blocked: {
				code: "self-replace",
				text: "不能由面板换「插件安装」自己的版本",
				plain: "大白话：换版本要先把这个插件卸掉，而卸载它的正是它自己 —— 卸到一半面板就没了，装回来的那一步没人执行。",
				fix: [
					{ text: "用官方插件管理器升级 dsh-plugin-installer（它不会把自己卸掉）" },
					{ text: "或者：在官方管理器里禁用本插件 → 手动装新版 → 再启用" }
				]
			}
		};
	}
	if (!REPLACEABLE.has(cls.kind)) {
		const reasons = {
			link: {
				code: "link-source",
				text: "本机目录插件（link:）没有「新版本」这回事",
				plain: "大白话：它是从你本机的源码目录直接链进来的，改了源码就是新版 —— 不存在「装一个新版本」这个动作。",
				fix: [
					{ text: "要更新：改那个目录里的代码（client.js 会自动热重载；宿主半边重启 DSH 才生效）" },
					{ text: "想改成「装一份快照」：用官方插件管理器卸掉 link 那条，再在面板里提交 .tgz" }
				]
			},
			git: {
				code: "git-source",
				text: "Git 来源的插件不能在这里换版本",
				plain: "大白话：它的版本在仓库 manifest 里，不在 npm registry 上；硬换会先把它删掉、再装回同一个 Git 地址（还是同一个版本）。",
				fix: [
					{ text: "要换版本：先在官方插件管理器卸载，再用面板提交新仓库/新分支地址" },
					{ text: "或者：让作者在 Git 仓库里发版，再重新提交一次" }
				]
			},
			workspace: { code: "workspace-source", text: "工作区/补丁类依赖不参与换版本", plain: "大白话：它由工作区或组合补丁管理，不归安装器管。", fix: [{ text: "改工作区里的那份源码" }] },
			unknown: { code: "unknown-source", text: "读不出它的依赖声明形态，不敢先卸", plain: "大白话：profile 里那条声明认不出来（可能被手改过），先卸掉再装的风险没法评估。", fix: [{ text: "在官方插件管理器里处理这个插件" }] }
		};
		return { ...needed, blocked: reasons[cls.kind] || reasons.unknown };
	}
	return needed;
}

/**
 * 「把旧版装回去」的地址（升级失败/中断/回滚时用）。
 *
 * npm 来源按**精确版本**重装；本面板装的 .tgz 必须用快照里备份的那一份
 * （重打包会写新文件名，旧文件可能已经不在，profile 里那条 `file:` 也就指空了）。
 *
 * @param {{name:string, installedBefore:object|null, vendorBackup:object|null}} input
 * @returns {{ok:boolean, type:string, spec:string, version:string, why:string}}
 */
export function restoreTarget(input) {
	const it = input || {};
	const name = String(it.name || "").trim();
	const before = it.installedBefore || null;
	const version = before && before.version ? String(before.version) : "";
	const spec = before && before.spec ? String(before.spec) : "";
	if (!name) return { ok: false, type: "", spec: "", version, why: "不知道包名" };
	if (/^file:/i.test(spec)) {
		const copy = it.vendorBackup && it.vendorBackup.copy ? String(it.vendorBackup.copy) : "";
		if (copy) return { ok: true, type: "file", spec: copy, version, why: "用快照里备份的旧 .tgz 装回" };
		return { ok: false, type: "file", spec: spec.slice(5), version, why: "旧 .tgz 没有备份（或已被清掉），只能按原路径试" };
	}
	if (!version) return { ok: false, type: "npm", spec, version, why: "不知道旧版本号，按原声明装回去可能还是新版" };
	return { ok: true, type: "npm", spec: "npm:" + name + "@" + version, version, why: "按旧版本号从 registry 装回" };
}

/**
 * 预检要展示的「换版本」理由（面板与工具共用一份措辞）。
 * @returns {{level:"block"|"warn"|"info", text:string, detail:string}}
 */
export function replacementReason(replacement, collaborator) {
	const r = replacement || {};
	if (!r.needed) return null;
	if (r.blocked) return { level: "block", text: "换版本：这次不能做 —— " + r.blocked.text, detail: (r.blocked.plain || "") + (r.blocked.fix && r.blocked.fix.length ? "\n\n建议：\n" + r.blocked.fix.map((f) => "· " + f.text).join("\n") : "") };
	if (!collaborator || collaborator.ok !== true) {
		return {
			level: "block",
			text: "换版本需要「插件目录」配合卸载，但当前不可用",
			detail: (collaborator && collaborator.reason ? collaborator.reason + "\n\n" : "") +
				"宿主 0.2.1 的 installBundle 按包名判已装，对已存在的包名一律回 already-installed；真换版本只能「先卸载再安装」，而卸载由插件目录执行（它知道谁依赖它、它现在会不会被加载）。"
		};
	}
	return {
		level: "warn",
		text: "换版本：" + r.text + "，会先卸载旧版再装新版",
		detail: "卸载由「插件目录」执行并复核依赖行（它同时给出依赖者/加载态警告）。从卸载到装回之间插件不可用；新版本按宿主契约要下次启动才加载。失败时面板会尝试装回 " + (r.from || "旧版") + "。"
	};
}

/** 一句话摘要（工具输出、任务备注共用）。 */
export function summarizeReplacement(replacement) {
	const r = replacement || {};
	if (!r.needed) return "";
	if (r.blocked) return "换版本被拒（" + r.blocked.code + "）：" + r.blocked.text;
	return (r.direction === "downgrade" ? "降级" : "升级") + " " + r.text + "（两阶段：先卸载旧版）";
}
