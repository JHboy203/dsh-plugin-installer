/**
 * pnpmresolve.js — 「这条 pnpm 报错，是这个包的问题，还是 profile 状态的问题？」（R35）
 *
 * 为什么要有它（2026-10-30 的真实现场）：
 *   用户升级 `@liustack/modsearch` 5.10.10 → 5.10.11 时，卸载旧版那一步报
 *   `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`（6 条策略违规，**没点名**）。
 *   面板只会原样转述，人和模型都不知道该改哪。
 *   当时是**手工**做了个对照实验才定性的：把 profile 的 `package.json` /
 *   `pnpm-workspace.yaml` / `.npmrc` 复制到临时目录，让 pnpm 自己解析一次 ——
 *   结果 **5.10.10 和 5.10.11 都零违规**。也就是说那 6 条违规不是这个包引起的，
 *   而是 profile 那个**陈旧 lockfile 状态**（lockfile 停在 9:00、package.json 到 9:55、
 *   19 个 `link:` 依赖从没进过 lockfile）在重算整棵树时才冒出来。
 *
 * 这条判据的形态是「**干净基线 vs 现状**」：
 *   · `baseline`（原样解析）干净 → 违规来自「状态」，不是包；
 *   · `baseline` 就违规 → 违规是这条链路本身的属性（换 profile 也一样）。
 *
 * 硬纪律（和面板一致）：
 *   · **只在临时目录里跑**：复制清单过去、`--lockfile-only`、`--ignore-scripts`；
 *   · **绝不碰真 profile**：不写它的 lockfile、不动它的 node_modules；
 *   · 面板本身永不自动调它 —— 只有人 / 模型显式跑 `dev/probe-pnpm-resolve.mjs`（或工具）时才跑。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 会被 pnpm 拒掉的 git 依赖（沙箱里 `git ls-remote` 会 EPERM），解析前先摘掉，并如实记账。 */
const GIT_SPEC = /^(github:|git\+|git:|git@|git:\/\/)/;

/**
 * 从 profile 的 package.json 生成「探针用」的那份清单。
 * **纯函数**：只吃对象，不碰盘，便于自检。
 *
 * @param {object} pkg profile 的 package.json
 * @param {object} [pin] 要额外固定的版本，例如 `{"@liustack/modsearch":"5.10.11"}`
 * @returns {{manifest:object, dropped:string[], pinned:Array<{name:string,from:string,to:string}>}}
 */
export function buildProbeManifest(pkg, pin = {}) {
	const manifest = JSON.parse(JSON.stringify(pkg || {}));
	const dropped = [];
	const pinned = [];
	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		const block = manifest[field];
		if (!block || typeof block !== "object") continue;
		for (const name of Object.keys(block)) {
			const spec = String(block[name] || "");
			if (GIT_SPEC.test(spec)) {
				dropped.push(name + "=" + spec);
				delete block[name];
			}
		}
		for (const [name, version] of Object.entries(pin || {})) {
			if (name in block) {
				pinned.push({ name, from: String(block[name]), to: String(version) });
				block[name] = String(version);
			}
		}
	}
	return { manifest, dropped, pinned };
}

/**
 * 读 pnpm 的输出，判断这次解析「过没过」。
 * **纯函数**：CI / 自检都能直接喂字符串。
 *
 * @param {string} output pnpm 的 stdout+stderr
 * @param {number|null} [exitCode]
 * @returns {{verdict:'clean'|'violations'|'failed'|'unknown', line:string|null, count:number|null}}
 */
export function classifyResolveOutput(output, exitCode = null) {
	const text = String(output || "");
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const violation = lines.find((line) => /RESOLUTION_POLICY_VIOLATIONS_UNHANDLED|resolution-policy violations?/i.test(line));
	if (violation) {
		const count = /(\d+)\s+resolution-policy/i.exec(violation);
		return { verdict: "violations", line: violation.length > 300 ? violation.slice(0, 297) + "…" : violation, count: count ? Number(count[1]) : null };
	}
	if (/Done in [\d.]+s using pnpm/i.test(text) || /^Done in /m.test(text)) return { verdict: "clean", line: null, count: 0 };
	const errLine = lines.find((line) => /^\[ERR_PNPM_|^ERR_PNPM_|^Error:/.test(line));
	if (errLine) return { verdict: "failed", line: errLine.length > 300 ? errLine.slice(0, 297) + "…" : errLine, count: null };
	if (exitCode !== null && exitCode !== 0) return { verdict: "failed", line: lines[lines.length - 1] || null, count: null };
	return { verdict: "unknown", line: lines[lines.length - 1] || null, count: null };
}

/** 找 DSH 自带的那份 pnpm（不依赖 PATH —— 本机 PATH 里没有 pnpm）。 */
export function findPnpmBin() {
	const candidates = [];
	if (process.env.DSH_PNPM_BIN) candidates.push(process.env.DSH_PNPM_BIN);
	/* Electron 主进程里有 resourcesPath；普通 node 下没有，所以再退到可执行文件旁边 */
	const resources = [];
	if (typeof process.resourcesPath === "string" && process.resourcesPath) resources.push(process.resourcesPath);
	if (process.execPath) {
		resources.push(join(dirname(process.execPath), "resources"));
		resources.push(join(dirname(process.execPath), "..", "resources"));
	}
	if (process.env.DSH_APP_ROOT) resources.push(join(process.env.DSH_APP_ROOT, "resources"));
	for (const root of resources) {
		candidates.push(join(root, "runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs"));
	}
	for (const path of candidates) {
		try {
			if (path && existsSync(path)) return path;
		} catch {
			/* 下一个 */
		}
	}
	return null;
}

function run(cmd, args, opts) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
		} catch (error) {
			resolve({ code: -1, output: "spawn error: " + String((error && error.message) || error) });
			return;
		}
		let output = "";
		const push = (buf) => {
			output += String(buf);
			if (output.length > 200000) output = output.slice(-120000);
		};
		child.stdout.on("data", push);
		child.stderr.on("data", push);
		child.on("error", (error) => resolve({ code: -1, output: output + "\nspawn error: " + String((error && error.message) || error) }));
		child.on("exit", (code) => resolve({ code, output }));
	});
}

/**
 * 在临时目录里跑一次「只解析」，回答「干净基线会不会也违规」。
 *
 * @param {object} input
 * @param {string} input.profileDir 真 profile（**只读它的三个清单文件**）
 * @param {string} input.workDir 临时目录（调用方负责清）
 * @param {string} [input.pnpmBin] 省略则 findPnpmBin()
 * @param {object} [input.pin] 额外固定的版本
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{ok:boolean, verdict:string, reason?:string, dropped?:string[], pinned?:Array, line?:string|null,
 *   count?:number|null, elapsedMs?:number, tail?:string[]}>}
 */
export async function probeResolve(input = {}) {
	const profileDir = input.profileDir;
	const workDir = input.workDir;
	if (!profileDir || !workDir) return { ok: false, verdict: "cannot", reason: "缺 profileDir / workDir" };
	const pnpmBin = input.pnpmBin || findPnpmBin();
	if (!pnpmBin) return { ok: false, verdict: "cannot", reason: "找不到 DSH 自带的 pnpm（设 DSH_PNPM_BIN 或传 pnpmBin）" };
	let pkgText;
	try {
		pkgText = await readFile(join(profileDir, "package.json"), "utf8");
	} catch (error) {
		return { ok: false, verdict: "cannot", reason: "读不到 profile 的 package.json：" + String((error && error.message) || error) };
	}
	let pkg;
	try {
		pkg = JSON.parse(pkgText);
	} catch (error) {
		return { ok: false, verdict: "cannot", reason: "profile 的 package.json 不是合法 JSON" };
	}
	const built = buildProbeManifest(pkg, input.pin || {});
	await mkdir(workDir, { recursive: true });
	await writeFile(join(workDir, "package.json"), JSON.stringify(built.manifest, null, 2), "utf8");
	/* 策略与 allowBuilds 必须照搬 —— 违规就是它们产生的 */
	for (const name of ["pnpm-workspace.yaml", ".npmrc"]) {
		try {
			await copyFile(join(profileDir, name), join(workDir, name));
		} catch {
			/* 没有就跳过（.npmrc 常常没有） */
		}
	}
	const startedAt = Date.now();
	const result = await run(
		process.execPath,
		[pnpmBin, "install", "--lockfile-only", "--ignore-scripts", "--store-dir", join(workDir, ".store")],
		{ cwd: workDir, timeout: input.timeoutMs || 240000 }
	);
	const elapsedMs = Date.now() - startedAt;
	const classified = classifyResolveOutput(result.output, result.code);
	const tail = result.output.split(/\r?\n/).filter(Boolean).slice(-8);
	return {
		ok: classified.verdict === "clean",
		verdict: classified.verdict,
		line: classified.line,
		count: classified.count,
		dropped: built.dropped,
		pinned: built.pinned,
		elapsedMs,
		tail
	};
}

export const __test = { GIT_SPEC, run };
