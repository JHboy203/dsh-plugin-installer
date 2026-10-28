/**
 * foreign.js — 「这不是 DSH 插件，那它到底是什么」：非 DSH 资产的确定性分类（R32）。
 *
 * 为什么需要它（2026-10-29 调研）：面板对 `unknown` 的处理是**阻断 + 一句「未识别内容」**。
 * 技术上安全，但对人没有信息量 —— 实测四个真实样本里有三个是**有明确身份**的东西
 * （MCP 服务器 / Obsidian 插件 / 普通 npm CLI），面板却只会说「既没有 dsh.bundle，也没有 SKILL.md」。
 * 用户下一步该干什么、能不能这么装，全靠自己猜。
 *
 * 这里只做一件事：**读 manifest 与文件清单，认出它属于哪个生态**，然后给一句话
 * 「它是什么 + 正确用法在哪」。**判据是确定性的（零 token）、只读、不改变放行条件** ——
 * `unknown` 依然阻断，只是把话说清楚。
 *
 * 六类（按判据的硬度排序，命中即返回）：
 *   mcp-server / vscode-extension / obsidian-plugin / chrome-extension / python-package /
 *   npm-cli / npm-library
 */
import { basename } from "node:path";

const MCP_HINT = /(@modelcontextprotocol\/|modelcontextprotocol|mcp-server|^mcp-)/i;

function depsOf(manifest) {
	const out = {};
	for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		const block = manifest && manifest[key];
		if (block && typeof block === "object") Object.assign(out, block);
	}
	return out;
}

function hasFile(files, pattern) {
	return files.some((rel) => pattern.test(String(rel)));
}

function firstMatch(files, pattern) {
	return files.find((rel) => pattern.test(String(rel))) || null;
}

/**
 * 分类。**纯函数**：只吃「已经读到的 manifest 与文件清单」，不碰盘。
 *
 * @param {object} input
 * @param {Array<{dir:string, manifest:object|null}>} [input.packages] 候选目录（根 + 一层包装）里能读到的 package.json
 * @param {string[]} [input.files] 相对路径清单（detect 的 tree.files.map(f => f.rel)）
 * @param {object|null} [input.rootManifest] 根目录的 manifest.json（Obsidian / Chrome 扩展用；读不到就传 null）
 * @param {string[]} [input.skillPaths] 找到的 SKILL.md 路径（用于说明「有几个技能」）
 * @returns {null|{family:string, label:string, why:string, howTo:string, evidence:string[]}}
 */
export function classifyForeign(input = {}) {
	const packages = Array.isArray(input.packages) ? input.packages.filter((p) => p && p.manifest) : [];
	const files = Array.isArray(input.files) ? input.files.map(String) : [];
	const rootManifest = input.rootManifest || null;
	const evidence = [];

	/* ① MCP 服务器：依赖名是最硬的证据（协议客户端/服务端包都带 @modelcontextprotocol） */
	for (const pkg of packages) {
		const all = { ...depsOf(pkg.manifest), [String(pkg.manifest.name || "")]: "self" };
		const hit = Object.keys(all).find((name) => MCP_HINT.test(name));
		if (hit) {
			evidence.push("依赖/名字里有 " + hit);
			return {
				family: "mcp-server",
				label: "MCP 服务器（Model Context Protocol）",
				why: "它用 MCP 协议把外部工具/数据源暴露给 AI 客户端，靠 stdio 或 HTTP 通信 —— 不是「装进 profile 的插件」，这样装进去不会被加载。",
				howTo: "接法：在 DSH 的组合文件里加一条 @deepseek-ai/dsh-mcp-client 条目（serverName + command 或 url），重启 DSH 生效；npm 包形态的通常用 npx -y <包名>。",
				evidence
			};
		}
	}

	/* ② VS Code 扩展：engines.vscode 是独占判据（别的生态不会这么写） */
	for (const pkg of packages) {
		const engines = pkg.manifest.engines || {};
		if (typeof engines.vscode === "string" || pkg.manifest.contributes) {
			evidence.push("package.json 里有 " + (engines.vscode ? "engines.vscode" : "contributes"));
			return {
				family: "vscode-extension",
				label: "VS Code 扩展",
				why: "它装进 VS Code 的扩展宿主里运行，跟 DSH 是两套宿主。",
				howTo: "用 VS Code 的「安装扩展」或 `code --install-extension <vsix>`；这不是 DSH 插件，别装进 profile。",
				evidence
			};
		}
	}

	/* ③ Obsidian 插件：manifest.json(id/version/minAppVersion) + main.js */
	if (rootManifest && typeof rootManifest.id === "string" && rootManifest.minAppVersion !== undefined) {
		evidence.push("manifest.json 有 id + minAppVersion");
		if (hasFile(files, /(^|\/)main\.js$/i)) evidence.push("有 main.js");
		return {
			family: "obsidian-plugin",
			label: "Obsidian 插件",
			why: "它跑在 Obsidian 的渲染进程里（manifest.json + main.js），DSH 不认这套清单。",
			howTo: "把 manifest.json / main.js / styles.css 放进 <你的库>/.obsidian/plugins/<id>/，在 Obsidian 设置里启用。",
			evidence
		};
	}

	/* ④ Chrome / Chromium 扩展：manifest_version（MV2/MV3） */
	if (rootManifest && (rootManifest.manifest_version === 2 || rootManifest.manifest_version === 3)) {
		evidence.push("manifest.json 有 manifest_version: " + rootManifest.manifest_version);
		return {
			family: "chrome-extension",
			label: "Chromium 内核浏览器扩展",
			why: "它由浏览器加载（Chrome/Edge/夸克），跟 DSH 的插件机制无关。",
			howTo: "浏览器 → 扩展 → 打开「开发者模式」→「加载已解压的扩展程序」选这个目录（需要打包成 .crx 就先用浏览器自带的打包）。",
			evidence
		};
	}

	/* ⑤ Python 包：pyproject / setup.py / wheel */
	const py = firstMatch(files, /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/i) || firstMatch(files, /\.whl$/i);
	if (py) {
		evidence.push("含 " + py);
		return {
			family: "python-package",
			label: "Python 包",
			why: "它是给 Python 环境装的（pip/uv），跟 DSH 的 JS 插件体系不搭。",
			howTo: "用 `pip install .` / `uv pip install .`（或直接装那个 wheel）装进目标 Python 环境；DSH 插件面板不该碰它。",
			evidence
		};
	}

	/* ⑥ npm CLI / 普通库：有 bin 是 CLI，否则是库 */
	for (const pkg of packages) {
		const manifest = pkg.manifest;
		if (manifest.bin) {
			const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.keys(manifest.bin || {});
			evidence.push("package.json 有 bin（" + bins.slice(0, 3).join("、") + "）");
			return {
				family: "npm-cli",
				label: "命令行工具（npm 包）",
				why: "它是给你在终端里跑的命令，不是 DSH 插件 —— 装进 profile 也不会被加载，只会多一行依赖。",
				howTo: "用 `npx <包名>` 临时跑，或 `npm i -g <包名>` 全局装；确实要 DSH 用它，就由某个插件在子进程里调它。",
				evidence
			};
		}
		if (manifest.main || manifest.exports || manifest.module) {
			evidence.push("package.json 有 main/exports（是库）");
			return {
				family: "npm-library",
				label: "普通 npm 库",
				why: "它是给代码 import 的库，没有 dsh.bundle 声明，装进 profile 不会被挂载。",
				howTo: "在需要它的项目里 `npm i <包名>`；DSH 插件要提供工具/命令，得自己写成带 dsh.bundle 的包。",
				evidence
			};
		}
	}

	/* ⑦ 有多个 SKILL.md 但没被认成 skill（SKILL.md 都在更深的层） */
	if (Array.isArray(input.skillPaths) && input.skillPaths.length > 1) {
		evidence.push("找到 " + input.skillPaths.length + " 个 SKILL.md（都在更深的层级）");
		return {
			family: "skill-collection",
			label: "技能集合（多个 SKILL.md）",
			why: "这是「一堆技能」的仓库，不是一个技能；面板只认根目录或一层包装里的 SKILL.md。",
			howTo: "先解包，把你要的那一个技能目录（含 SKILL.md 的那层）单独拖进面板。",
			evidence
		};
	}
	return null;
}

/** 面板/工具用的一行摘要。 */
export function foreignLine(foreign) {
	if (!foreign) return "";
	return foreign.label + " —— " + foreign.why;
}

export const __test = { depsOf, hasFile, firstMatch, MCP_HINT };
