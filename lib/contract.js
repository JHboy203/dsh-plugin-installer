/**
 * contract.js — 工具注册契约的静态扫描。
 *
 * 为什么需要它：DSH 0.2.1-rc.2 起 `ctx.tools.register()` 强制要求
 * `output: { schema, render }`，漏了**不是静默降级**，而是让整个插件激活失败；
 * 而 required 插件一失活，宿主启动就中止 —— 症状是恢复对话框 + 一串
 * 「等待服务」的插件（`connection` / `fileUploads` / `webRuntime` …）。
 * 2026-10-18 桌面端就是这么起不来的。
 *
 * 两处复用同一份实现：
 *   - 装之前：`precheck` 对**解包好的包目录**扫一遍 → 有问题先让人确认；
 *   - 装之后：`doctor` 对 profile 里**已安装的第三方插件**扫一遍 → 列出谁不满足契约。
 *
 * ⚠️ 这是**静态近似**：只认「对象字面量里 name + parameters + execute，但没有 output」。
 * 走 builder 动态生成的工具（`buildXxxTools()` 之类）扫不到 —— 报告里单列 `dynamic`，
 * 真正的判据仍然是宿主启动日志。
 *
 * @module dsh-plugin-installer/contract
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 扫描时跳过的目录（依赖、产物、测试夹具都不算插件自己的工具定义）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".cache", "test", "tests", "__pycache__"]);

/** 每个文件只看到这个窗口内的 `execute`，避免把相邻对象误配。 */
const WINDOW_CHARS = 3000;

/**
 * 扫一个目录下的工具定义，找漏声明 `output` 的。
 *
 * @param {string} root 包根目录（解包现场或 node_modules 里的安装目录）
 * @param {{maxFiles?: number}} [options] maxFiles 默认 400，防止误指到大目录时卡住
 * @returns {Promise<{root: string, files: number, definitions: number, dynamic: number,
 *   violations: Array<{tool: string, file: string, line: number}>, truncated: boolean}>}
 */
export async function scanToolContract(root, options = {}) {
	const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 400;
	const result = { root, files: 0, definitions: 0, dynamic: 0, violations: [], truncated: false };
	if (!root) return result;

	const walk = async (dir, depth) => {
		if (depth > 6 || result.files >= maxFiles) {
			if (result.files >= maxFiles) result.truncated = true;
			return;
		}
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (result.files >= maxFiles) {
				result.truncated = true;
				return;
			}
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
				continue;
			}
			if (!/\.(m?js|cjs)$/.test(entry.name)) continue;
			let text;
			try {
				text = await readFile(full, "utf8");
			} catch {
				continue;
			}
			if (!text.includes("execute")) continue;
			result.files += 1;
			const registerCalls = (text.match(/tools\.register\s*\(/g) || []).length;
			let found = 0;
			const re = /name\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g;
			let match;
			while ((match = re.exec(text)) !== null) {
				const windowText = text.slice(match.index, match.index + WINDOW_CHARS);
				const executeAt = windowText.search(/[,{]\s*(async\s+)?execute\s*[(:]/);
				if (executeAt < 0) continue;
				const before = windowText.slice(0, executeAt);
				// 只把「看着像工具定义」的对象算进来：要有 parameters，避免误认普通配置对象
				if (!/parameters\s*:/.test(before)) continue;
				found += 1;
				if (/output\s*:/.test(before)) continue;
				result.violations.push({
					tool: match[1],
					file: full,
					line: text.slice(0, match.index).split("\n").length
				});
			}
			result.definitions += found;
			if (found === 0 && registerCalls > 0) result.dynamic += registerCalls;
		}
	};

	await walk(root, 0);
	return result;
}

/**
 * 一句话结论（工具输出与面板共用）。
 * @param {Awaited<ReturnType<typeof scanToolContract>>} scan
 * @returns {string}
 */
export function describeContractScan(scan) {
	if (!scan || !Array.isArray(scan.violations)) return "未扫描";
	if (scan.violations.length === 0) {
		return "工具契约：未发现漏声明 output" + (scan.dynamic > 0 ? "（" + scan.dynamic + " 处走 builder，需看启动日志）" : "");
	}
	const tools = scan.violations.slice(0, 6).map((v) => v.tool).join("、");
	const more = scan.violations.length > 6 ? " 等 " + scan.violations.length + " 个" : "";
	return "工具契约：**" + scan.violations.length + " 个工具漏声明 output**（" + tools + more + "）—— 装上去下次启动该插件会失活";
}
