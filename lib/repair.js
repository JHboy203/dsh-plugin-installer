/**
 * repair.js — 「环境体检 / 自动修复」：把这次开发里两次手工救火的步骤固化进插件。
 *
 * 体检项（只读）：
 *   ① profile 里多出来的 @deepseek-ai/dsh-tools（会让下次启动插件批量加载失败）
 *   ② profile 的 `file:` 依赖指向已经不存在的 .tgz（下次任何 pnpm 操作必炸）
 *   ③ data/vendor 里的打包产物、data 体积
 *   ④ pnpm 的 trustPolicy 是否设了 no-downgrade
 *   ⑤ git 在不在（`github:` spec 要靠它）
 *   ⑥ 远程访问：当前 GUI 端口 + tailscale serve 需要的一条命令
 *
 * 修复（apply）：① 挪走 dsh-tools；② 从 node_modules 里已安装的那份重新打包补回 .tgz。
 * 两个动作都是**幂等**的：没事可做时什么都不动。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkDshToolsShadow, quarantineDshTools } from "./landmine.js";
import { packPluginTarball } from "./pack.js";

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function runQuick(cmd, args, timeoutMs = 5000) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve({ ok: false, out: "spawn failed" });
			return;
		}
		let out = "";
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		}, timeoutMs);
		child.stdout.on("data", (b) => {
			out += String(b);
			if (out.length > 2000) out = out.slice(0, 2000);
		});
		child.stderr.on("data", (b) => {
			out += String(b);
			if (out.length > 2000) out = out.slice(0, 2000);
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ ok: false, out: "not found" });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, out: out.trim() });
		});
	});
}

/**
 * profile manifest 里所有 `file:` 依赖，以及它们的实体在不在。
 * 纯函数的一半（findDanglingFileDeps）单独导出，好单测。
 */
export function fileDepsOf(pkg) {
	const deps = (pkg && pkg.dependencies) || {};
	return Object.entries(deps)
		.filter(([, spec]) => String(spec || "").startsWith("file:"))
		.map(([name, spec]) => ({ name, spec: String(spec), path: String(spec).slice("file:".length).replace(/\//g, "\\") }));
}

export function findDanglingFileDeps(pkg, checkExists) {
	return fileDepsOf(pkg).filter((dep) => checkExists(dep.path) !== true);
}

export async function inspectEnvironment({ profileDir, dataDir, advertisedUrl }) {
	const report = { at: new Date().toISOString(), findings: [], fixes: [], info: {} };
	const pkgPath = profileDir ? join(profileDir, "package.json") : null;
	let pkg = null;
	if (pkgPath) {
		try {
			pkg = JSON.parse(await readFile(pkgPath, "utf8"));
		} catch {
			pkg = null;
		}
	}
	report.info.profile = profileDir;
	report.info.dataDir = dataDir;

	/* ① dsh-tools 覆盖 */
	const shadow = await checkDshToolsShadow(profileDir);
	report.info.dshToolsShadow = shadow;
	if (shadow.present) {
		report.findings.push({
			code: "dsh-tools-shadow",
			severity: "error",
			title: "profile 里有一份 @deepseek-ai/dsh-tools" + (shadow.version ? "（" + shadow.version + "）" : ""),
			detail: "插件按路径算模块标识：多这一份，下次启动会批量加载失败（reading 'prepare'）。任何一次 pnpm 之后都可能出现。",
			plain: "大白话：profile 里多出来一份「DSH 自己的内部工具包」。版本一样也照样出事 —— 因为宿主按文件路径认包，两份就等于两个不同的东西，下次启动时插件会一整片加载失败。",
			fix: [
				{ text: "点上面的「一键修复」，它会把这多出来的一份挪进 .tools/backups（不删，能找回）" },
				{ text: "然后重启一次 DSH —— 这个雷只在「插件加载那一刻」炸，先修再重启" }
			],
			fixable: true
		});
		report.fixes.push({ kind: "quarantine-dsh-tools", label: "把它挪进 .tools/backups" });
	}

	/* ② 悬空的 file: 依赖 */
	const deps = fileDepsOf(pkg);
	const dangling = [];
	for (const dep of deps) {
		if (await exists(dep.path)) continue;
		const installed = join(profileDir, "node_modules", ...dep.name.split("/"));
		const recoverable = await exists(join(installed, "package.json"));
		dangling.push({ ...dep, recoverable });
		report.findings.push({
			code: "dangling-file-dep",
			severity: recoverable ? "warn" : "error",
			title: "依赖 " + dep.name + " 指向的 .tgz 已经不在",
			detail: dep.path + (recoverable ? "（node_modules 里还有已安装的副本，可以重新打包补回）" : "（node_modules 里也没有，只能重装）"),
			plain: recoverable
				? "大白话：profile 记着「从这个压缩包装插件」，可那个压缩包已经被删了。现在还能用，但下次一跑依赖安装就会失败。能救：node_modules 里还有装好的那份，可以重新打包补回。"
				: "大白话：profile 指着一个已经不存在的压缩包，而且 node_modules 里也没有副本了 —— 只能回滚/重装这个插件。",
			fix: recoverable
				? [
					{ text: "点上面的「一键修复」：它会把 node_modules 里那份重新打成 .tgz 补回原位，同时往 data/vendor 留一份持久的" },
					{ text: "修完再点「检查」确认这条消失" }
				]
				: [
					{ text: "在面板历史里对这个插件点「回滚到安装前」，再重新装一次" },
					{ text: "不要手改 package.json 里的 file: 路径 —— 锁文件对不上，下次 pnpm 还会炸" }
				],
			fixable: recoverable
		});
		if (recoverable) report.fixes.push({ kind: "restore-tarball", label: "重新打包补回 " + dep.name, name: dep.name, path: dep.path });
	}
	report.info.fileDeps = deps.length;
	report.info.danglingFileDeps = dangling.length;

	/* ③ 打包产物 */
	let vendor = { files: 0, bytes: 0 };
	try {
		const dir = join(dataDir, "vendor");
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			vendor.files += 1;
			vendor.bytes += (await stat(join(dir, entry.name))).size;
		}
	} catch {
		vendor = { files: 0, bytes: 0 };
	}
	report.info.vendor = vendor;

	/* ④ pnpm trustPolicy */
	try {
		const ws = await readFile(join(profileDir, "pnpm-workspace.yaml"), "utf8");
		const m = /^trustPolicy\s*:\s*(\S+)/m.exec(ws);
		report.info.trustPolicy = m ? m[1].replace(/["']/g, "") : null;
		if (!m || report.info.trustPolicy !== "no-downgrade") {
			report.findings.push({
				code: "no-trust-policy",
				severity: "info",
				title: "pnpm 的 trustPolicy 不是 no-downgrade",
				detail: "它挡的是「可信版本被降级替换成旧版」这一类供应链手法。要开就在 pnpm-workspace.yaml 里加一行 `trustPolicy: no-downgrade`（这是 profile 配置，面板不擅自改）。",
				plain: "大白话：pnpm 有个开关能挡住「把新版本偷偷换成旧版本」这种供应链手法。现在没开。加一行就行，不影响装插件。",
				fix: [
					{ text: "在 profile 的 pnpm-workspace.yaml 里加一行：trustPolicy: no-downgrade" },
					{ text: "改完不用重装任何东西，下次 pnpm 操作才会校验" }
				],
				fixable: false
			});
		}
	} catch {
		report.info.trustPolicy = "unknown";
	}

	/* ⑤ git */
	const git = await runQuick("git", ["--version"]);
	report.info.git = git.ok ? git.out : null;
	if (!git.ok) {
		report.findings.push({
			code: "no-git",
			severity: "info",
			title: "PATH 里没有 git",
			detail: "插件管理器解析 `github:` spec 时要用 git；本面板装 GitHub 链接走的是「下载→重打包成 .tgz」，不需要 git。",
			plain: "大白话：机器上没装 git。装 GitHub 链接用不到它（面板自己会下载）；只有手敲 `github:owner/repo` 这种装法才需要。",
			fix: [
				{ text: "不用管它 —— 从面板贴 GitHub 链接装的话，走的不是这条路" },
				{ text: "确实要 git 的话：装 Git for Windows，装完重开 DSH" }
			],
			fixable: false
		});
	}

	/* ⑥ 远程访问 */
	report.info.advertisedUrl = advertisedUrl || null;
	if (advertisedUrl) {
		const m = /:(\d+)\//.exec(advertisedUrl) || /:(\d+)$/.exec(advertisedUrl);
		const port = m ? m[1] : null;
		report.info.guiPort = port;
		report.fixes.push({
			kind: "hint",
			label: "手机连不上时（tailscale serve 还指着旧端口）。一次性修：",
			command: port ? "tailscale serve --bg --https=443 http://127.0.0.1:" + port : null
		});
		report.fixes.push({
			kind: "hint",
			label: "一劳永逸：装一次看护任务，之后端口变了它自己重指，热键 Ctrl+Alt+Y 可当场触发",
			command: "powershell -ExecutionPolicy Bypass -File \"D:\\信息库\\AI工作区\\DSH-Plugin\\dsh-plugin-installer\\dev\\install-serve-watch.ps1\""
		});
	}

	return report;
}

/**
 * 执行可自动修复的项。每次都返回「做了什么」，没做也说明原因。
 */
export async function applyRepairs({ profileDir, dataDir, backupsRoot, findings }) {
	const actions = [];
	const shadow = await quarantineDshTools(profileDir, backupsRoot);
	if (shadow.moved) actions.push({ kind: "quarantine-dsh-tools", ok: true, from: shadow.from, to: shadow.to });
	else if (shadow.error) actions.push({ kind: "quarantine-dsh-tools", ok: false, error: shadow.error });
	else actions.push({ kind: "quarantine-dsh-tools", ok: true, skipped: "没有副本" });

	let pkg = null;
	try {
		pkg = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
	} catch {
		pkg = null;
	}
	const deps = pkg ? fileDepsOf(pkg) : [];
	for (const dep of deps) {
		if (await exists(dep.path)) continue;
		const installed = join(profileDir, "node_modules", ...dep.name.split("/"));
		if (!(await exists(join(installed, "package.json")))) {
			actions.push({ kind: "restore-tarball", ok: false, name: dep.name, error: "node_modules 里也没有它" });
			continue;
		}
		try {
			await mkdir(dirname(dep.path), { recursive: true });
			const packed = await packPluginTarball(installed, dep.path);
			const vendorPath = join(dataDir, "vendor", "pkg-" + dep.name.replace(/[^A-Za-z0-9._-]/g, "_") + ".tgz");
			await mkdir(dirname(vendorPath), { recursive: true });
			await packPluginTarball(installed, vendorPath);
			actions.push({ kind: "restore-tarball", ok: true, name: dep.name, files: packed.files, path: dep.path, vendor: vendorPath });
		} catch (e) {
			actions.push({ kind: "restore-tarball", ok: false, name: dep.name, error: String((e && e.message) || e) });
		}
	}
	return { actions, findingsBefore: (findings || []).length };
}

/** 给报告写一份可存档的 Markdown（排查时贴给下一个人看）。 */
export async function writeReport(report, file) {
	const lines = [];
	lines.push("# 插件安装面板 · 环境体检");
	lines.push("");
	lines.push("- 时间：" + report.at);
	lines.push("- profile：" + (report.info.profile || "?"));
	lines.push("- 数据目录：" + (report.info.dataDir || "?"));
	lines.push("- dsh-tools 覆盖：" + (report.info.dshToolsShadow && report.info.dshToolsShadow.present ? "**有**" : "无"));
	lines.push("- file: 依赖：" + report.info.fileDeps + " 条，悬空 " + report.info.danglingFileDeps + " 条");
	lines.push("- vendor 产物：" + report.info.vendor.files + " 个 / " + Math.round(report.info.vendor.bytes / 1024) + " KiB");
	lines.push("- pnpm trustPolicy：" + (report.info.trustPolicy || "未设置"));
	lines.push("- git：" + (report.info.git || "无"));
	lines.push("");
	if (report.findings.length === 0) {
		lines.push("没有发现问题。");
	} else {
		lines.push("## 发现");
		for (const f of report.findings) {
			lines.push("- [" + f.severity + "] **" + f.title + "**" + (f.fixable ? "（可自动修复）" : ""));
			if (f.detail) lines.push("  " + f.detail);
		}
	}
	await writeFile(file, lines.join("\n"), "utf8");
	return file;
}
