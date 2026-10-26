/**
 * install.js — 安装执行（只走宿主侧 API，不 spawn 外部 dsh CLI）与安装后诊断。
 *
 * 插件：`ctx.pluginManager.installBundle(spec)` —— 桌面 desktop profile 的
 *       package.json / cordis.patch.yml / pnpm 调用都由它负责，我们只递一个
 *       **已经检过的本地目录**（或 npm spec），保证「装的就是扫描过的那份字节」。
 * Skill：直接落位到技能根目录（`$DSH_HOME/skills/<name>/`），文件系统 provider
 *       会热加载，不需要重启。
 */
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { firstExistingDir, profileDir, skillRoots } from "./hostinfo.js";
import { scanToolContract } from "./contract.js";
import { injectFixLine, scanInject, servicesFromHostError } from "./inject.js";
import { backupSkillInSnapshot } from "./snapshot.js";
import { packPluginTarball } from "./pack.js";
import { describeInstallFailure, readBuildPolicy } from "./installfailure.js";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 ChangeResult 里挑出人要看的那几个字段（形状随版本变，读不到就不编）。 */
export function summarizeChange(result) {
	if (!result || typeof result !== "object") return { raw: String(result) };
	const out = {};
	for (const key of ["application", "stage", "target", "enabled", "bundle", "version", "nextStep", "code", "message", "error"]) {
		if (result[key] !== undefined) out[key] = result[key];
	}
	if (result.saved) out.saved = result.saved;
	if (Array.isArray(result.warnings) && result.warnings.length > 0) {
		out.warnings = result.warnings.map((w) => (typeof w === "string" ? w : JSON.stringify(w))).slice(0, 8);
	}
	if (result.packageResult) out.packageResult = result.packageResult;
	if (result.pendingBuilds) out.pendingBuilds = result.pendingBuilds;
	/* 兜底：把没覆盖到的顶层标量也带上（便于支持时看真话） */
	for (const [key, value] of Object.entries(result)) {
		if (out[key] !== undefined) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
	}
	return out;
}

function api(pluginManager, name) {
	if (!pluginManager || typeof pluginManager[name] !== "function") {
		throw new Error("宿主 pluginManager." + name + " 不可用");
	}
	return pluginManager[name].bind(pluginManager);
}

/**
 * 把识别出来的插件目录重打成 npm 风格 `.tgz`（落 `data/vendor/`）。
 *
 * ★ 为什么单独抽出来：两阶段升级必须**先打包、再卸载旧版** —— 顺序反了就会
 *   "旧版卸了、新包还没打出来"，而打包这一步是可能失败的（读盘/写盘/文件数上限）。
 *   `installPlugin` 内部仍会在没有 prepared 时自己调它，行为与以前一致。
 *
 * @returns {Promise<{spec:string, packed:object, name:string|null, version:string|null}>}
 */
export async function preparePluginTarball({ detected, packDir, profileDirOverride } = {}) {
	const dir = detected && detected.payload && detected.payload.dir;
	if (!dir) throw new Error("识别结果里没有可打包的目录");
	const manifest = (detected.payload && detected.payload.manifest) || {};
	const safe = String(manifest.name || "plugin").replace(/[^A-Za-z0-9._-]/g, "_");
	/* R13：**文件名必须带版本**。宿主判「已经装过」只看依赖行里的 spec 字符串 ——
	   同一个 `pkg-x.tgz` 换了内容也照样回 already-installed，于是「重装/升级」静默无效
	   （本机实证：dsh-imgops 0.1.0 → 0.1.1，pnpm 一次都没跑，任务显示失败）。
	   带上版本号，spec 就变了，pnpm 才会真替换。 */
	const rawVersion = manifest.version || "";
	const safeVersion = String(rawVersion).replace(/[^A-Za-z0-9._-]/g, "_");
	const out = join(packDir || dir, "pkg-" + safe + (safeVersion ? "-" + safeVersion : "") + ".tgz");
	let packed = await packPluginTarball(dir, out);
	/* 旧版本包没人引用就收掉（否则 data/vendor 每次升级多一个 13KB 的孤儿） */
	const sweptNames = await cleanupVendorTarballs(packDir || dir, safe, out, profileDirOverride);
	if (sweptNames.length > 0) packed = { ...packed, swept: sweptNames };
	return { spec: out, packed, name: manifest.name || null, version: manifest.version || null };
}

export async function installPlugin({ pluginManager, detected, source, packDir, approvedBuilds, profileDirOverride, prepared }) {
	const name = api(pluginManager, "installBundle");
	let spec;
	let packed = null;
	if (prepared && prepared.spec) {
		/* 两阶段升级/中断续跑：包已经打好了（可能是在卸载旧版**之前**打的），别再打一次 */
		spec = prepared.spec;
		packed = prepared.packed || null;
	} else if (source && source.type === "npm" && source.spec) {
		/* registry 来源按 name@version 装：那是 pnpm 自己下载解包的，不产生 link */
		spec = source.spec;
	} else {
		/* 本地/下载来源：先重打成 .tgz 再装。
		   ⚠️ 不能直接传目录 —— pnpm 会记成 link:，而解包目录是任务临时区，收尾就删了。 */
		const p = await preparePluginTarball({ detected, packDir, profileDirOverride });
		spec = p.spec;
		packed = p.packed;
	}
	const before = await safeCall(() => pluginManager.listBundles());
	const started = Date.now();
	/* R9：用户明确批准过的构建脚本，按宿主契约走 approvedBuilds 传进去
	   （宿主会先写 allowBuilds=true 再跑 pnpm；名单过期时它抛 stale-approval）。 */
	const options = { enabled: true };
	const approved = (Array.isArray(approvedBuilds) ? approvedBuilds : []).map(String).filter(Boolean);
	if (approved.length > 0) options.approvedBuilds = approved;
	let result;
	try {
		result = await name(spec, options);
	} catch (e) {
		/* R9：这里以前只留 code+message —— 于是「pnpm 为什么失败」与
		   「哪些包的安装脚本待批准」全丢了，面板只剩一段英文原文。 */
		const policy = await readBuildPolicy(profileDir()).catch(() => null);
		const failure = describeInstallFailure({
			code: e && e.code,
			message: String((e && e.message) || e),
			output: String((e && e.message) || e),
			errno: e && e.errno,
			timedOut: Boolean(e && e.timedOut),
			incompatible: e && e.incompatible,
			pendingBuilds: e && e.pendingBuilds,
			policyPending: policy && policy.pending
		});
		return {
			ok: false,
			spec,
			packed,
			elapsedMs: Date.now() - started,
			error: {
				code: e && e.code,
				message: String((e && e.message) || e),
				incompatible: (e && e.incompatible) || null,
				failure
			},
			failure,
			pendingBuilds: failure.pendingBuilds,
			approvedBuilds: approved,
			before: before ? before.length : null
		};
	}
	const bundleName = detected.payload && detected.payload.manifest ? detected.payload.manifest.name : null;
	const summary = summarizeChange(result);
	/* 宿主把待批准的构建脚本留在 result.pendingBuilds 上；失败时它随错误走，
	   成功路径上一般没有 —— 但别假设，有就带出去。 */
	const stillPending = Array.isArray(summary.pendingBuilds) ? summary.pendingBuilds : [];

	/* R13：**不抛异常的那种失败**也要分诊。
	   宿主在 apply/activate 阶段失败时是**正常返回** `{ application: "failed", error: {...} }`
	   （不是 throw），旧代码在这条路上没有 failure → 面板只剩一句「package manager 报告安装失败」，
	   而真相可能是「装上了但没激活（漏 inject）」或「已经装过、这次没改动」。
	   实证：2026-10-21 dsh-imgops 的两条任务。 */
	const hostError = (summary && summary.error) || null;
	const failed = (summary.application === "failed") || Boolean(hostError);
	let failure = null;
	if (failed) {
		const policy = await readBuildPolicy(profileDir()).catch(() => null);
		const diagnostics = hostError && hostError.diagnostic ? String(hostError.diagnostic) : "";
		const pkgOutput = summary.packageResult && summary.packageResult.output ? String(summary.packageResult.output) : "";
		failure = describeInstallFailure({
			code: hostError && hostError.code ? hostError.code : null,
			message: diagnostics || (hostError && hostError.message) || "",
			output: [diagnostics, pkgOutput].filter(Boolean).join("\n"),
			diagnostic: diagnostics,
			stage: summary.stage,
			incompatible: hostError && hostError.incompatible,
			pendingBuilds: stillPending,
			policyPending: policy && policy.pending
		});
	}

	return {
		ok: !failed,
		/* `already-installed` 不算失败：宿主只是说「它已经在依赖里了，这次没改动」 */
		noop: Boolean(failure && failure.noop),
		spec,
		packed,
		bundleName,
		elapsedMs: Date.now() - started,
		application: summary.application || null,
		result: summary,
		failure,
		error: hostError,
		pendingBuilds: stillPending,
		approvedBuilds: approved
	};
}

async function safeCall(fn) {
	try {
		return await fn();
	} catch {
		return null;
	}
}

/**
 * 清掉同一个插件的**旧版** vendor 包（R13）。
 * 只动两种文件名：`pkg-<name>.tgz`（R13 之前的旧命名）与 `pkg-<name>-<version>.tgz`；
 * 只要 profile 里还有任何一条 `file:` 依赖指着它（或它就是这次的产物），就留下 ——
 * 这里宁可少删：删掉在用的包 = 下次 pnpm 直接 ENOENT。
 */
async function cleanupVendorTarballs(dir, safeName, keepFile, proOverride) {
	const removed = [];
	const pro = proOverride || profileDir();
	if (!pro) return removed;
	let referenced = new Set();
	try {
		const manifest = JSON.parse(await readFile(join(pro, "package.json"), "utf8"));
		referenced = new Set(
			Object.values((manifest && manifest.dependencies) || {})
				.filter((v) => typeof v === "string" && v.startsWith("file:"))
				.map((v) => String(v.slice(5)).replace(/\\/g, "/").toLowerCase())
		);
	} catch {
		/* 读不到 profile 清单就别删任何东西 */
		return removed;
	}
	let names = [];
	try {
		names = await readdir(dir);
	} catch {
		return removed;
	}
	const keep = String(keepFile || "").replace(/\\/g, "/").toLowerCase();
	for (const name of names) {
		if (!name.endsWith(".tgz")) continue;
		if (name !== "pkg-" + safeName + ".tgz" && !name.startsWith("pkg-" + safeName + "-")) continue;
		const full = join(dir, name);
		const normalized = full.replace(/\\/g, "/").toLowerCase();
		if (normalized === keep || referenced.has(normalized)) continue;
		try {
			await rm(full, { force: true });
			removed.push(name);
		} catch {
			/* 删不掉就留着，不影响这次安装 */
		}
	}
	return removed;
}

/**
 * Skill：剥离包装目录后落位。
 * 同名技能会**显式覆盖**（并在快照里留了备份），返回 replaced 标记。
 */
export async function installSkill({ detected, snapshotDir }) {
	const meta = detected.payload.meta;
	const name = (meta.name || detected.payload.dirName || "skill").trim();
	const root = await firstExistingDir(skillRoots());
	if (!root) return { ok: false, error: { message: "找不到技能根目录" } };
	await mkdir(root, { recursive: true });
	const dest = join(root, name);
	let replaced = false;
	try {
		if ((await stat(dest)).isDirectory()) {
			replaced = true;
			if (snapshotDir) await backupSkillInSnapshot(snapshotDir, dest, name);
			await rm(dest, { recursive: true, force: true });
		}
	} catch {
		/* 不存在 */
	}
	const tmp = dest + ".installing-" + Date.now();
	await cp(detected.payload.dir, tmp, { recursive: true, dereference: true, force: true });
	await rm(dest, { recursive: true, force: true }).catch(() => {});
	await cp(tmp, dest, { recursive: true, force: true });
	await rm(tmp, { recursive: true, force: true }).catch(() => {});
	let entryOk = false;
	try {
		entryOk = (await stat(join(dest, "SKILL.md"))).isFile();
	} catch {
		entryOk = false;
	}
	if (!entryOk) return { ok: false, error: { message: "落位后找不到 SKILL.md" }, dest, root };
	return { ok: true, name, dest, root, replaced };
}

/* ── 诊断 ─────────────────────────────────────────────────────────────── */

function rowIdsOf(bundle) {
	const rows = bundle && (bundle.rows || bundle.entries || bundle.plugins);
	if (!Array.isArray(rows)) return [];
	return rows
		.map((row) => ({
			/* rowId 是 patch 里写的稳定 id；entryId 是组合后的 `include:<rowId>`，
			   同一个 rowId 在不同 bundle 里各有一份是正常的，不能拿来判重复。 */
			id: row && (row.rowId || row.id || row.patchId),
			entryId: row && row.entryId,
			name: row && (row.moduleName || row.name),
			status: row && (row.status || row.state)
		}))
		.filter((row) => row.id);
}

/**
 * 安装后只读诊断：为什么没生效、和谁冲突、下一步做什么。
 * @returns {{verdict:'ok'|'warn'|'error', findings:Array, inventory:object}}
 */
export async function diagnose({ pluginManager, skills, job }) {
	const findings = [];
	const inventory = { bundles: null, plugins: null, skills: null };

	if (job.detected && job.detected.kind === "bundle") {
		const bundleName = (job.install && job.install.bundleName) || (job.detected.payload && job.detected.payload.manifest.name);
		const bundles = await safeCall(() => pluginManager.listBundles());
		const plugins = await safeCall(() => pluginManager.listPlugins());
		/* 宿主在这次安装回执里留的原话（激活失败时就是 `did not activate` 那一行） */
		const hostDiag = (job.install && job.install.result && job.install.result.error && job.install.result.error.diagnostic) || null;
		inventory.bundles = Array.isArray(bundles) ? bundles.length : null;
		inventory.plugins = Array.isArray(plugins) ? plugins.length : null;

		if (!Array.isArray(bundles)) {
			findings.push({
				severity: "warn",
				title: "读不到插件清单",
				detail: "宿主插件管理服务暂时不可用；不代表安装失败，重启后到 Settings → Plugins 确认。",
				plain: "大白话：不是装失败，是宿主这会儿答不上来「装了哪些插件」。多半是刚升级/刚重启还没接上。",
				fix: [
					{ text: "重启一次 DSH（插件清单是启动时读的），再回来点「重新诊断」" },
					{ text: "重启后仍报这一条，就去 Settings → Plugins 看一眼这次装的插件在不在列表里" }
				],
				action: null
			});
		} else {
			const bundle = bundles.find((b) => b && (b.name === bundleName || b.packageName === bundleName));
			if (!bundle) {
				findings.push({
					severity: "error",
					title: "安装后清单里找不到 " + bundleName,
					detail: "包管理器可能没真正写入 profile 依赖，或包名与 manifest 不一致。",
					plain: "大白话：文件确实落地了，但宿主那边的「要加载哪些插件」名单里没有它 —— 也就是说它不会被运行。",
					fix: [
						{ text: "点下面的「回滚到安装前」，把这次装的东西收干净" },
						{ text: "换一个来源再装一次（同一个名字的旧版本先卸掉）" },
						{ text: "反复出现就把这段贴给 AI：清单里没有 " + bundleName + "，profile 依赖已写入" }
					],
					action: { kind: "goto", label: "去插件页核对", command: null }
				});
			} else {
				if (bundle.error) {
					findings.push({
						severity: "error",
						title: "bundle 加载报错",
						detail: String(typeof bundle.error === "string" ? bundle.error : JSON.stringify(bundle.error)).slice(0, 600),
						plain: "大白话：宿主试过加载它，但加载的时候报错了 —— 插件代码或它要的依赖有问题。",
						fix: [
							{ text: "点「回滚到安装前」，先让 DSH 回到能用的状态" },
							{ text: "把上面这条报错原文贴给 AI，让它对着代码看是哪个 import/peer 缺了" }
						],
						action: { kind: "rollback", label: "回滚到安装前", command: null }
					});
				}
				if (bundle.availability === "missing") {
					findings.push({
						severity: "error",
						title: "包文件缺失",
						detail: "依赖声明在，但包目录读不到。",
						plain: "大白话：名单上有它，可磁盘上找不到那份文件 —— 常见于「从临时目录装进来、临时目录随后被清掉」。",
						fix: [
							{ text: "点「回滚到安装前」，把这条坏依赖去掉" },
							{ text: "重新装一次：面板会把包装进 data/vendor（持久目录），重启也不丢" },
							{ text: "不想重装就点体检里的「一键修复」，它会从 node_modules 重新打包补回" }
						],
						action: { kind: "rollback", label: "回滚", command: null }
					});
				}
				if (bundle.enabled === false) {
					findings.push({
						severity: "warn",
						title: "已安装但未选中（disabled）",
						detail: "bundle 在 dsh.profile.bundles 里没有启用。",
						plain: "大白话：装是装好了，只是没勾上 —— 勾上才会跑。",
						fix: [
							{ text: "点下面的「启用」，它会把这个 bundle 写进 dsh.profile.bundles" },
							{ text: "或者自己去 Settings → Plugins 勾上它" }
						],
						action: { kind: "enable", label: "启用", command: null }
					});
				}
				const rows = rowIdsOf(bundle);
				if (Array.isArray(plugins) && rows.length > 0) {
					/* R13：这里的行匹配以前是坏的 —— 只比 `p.entryId === row.id`，
					   而宿主给的是 `include:<rowId>`，于是**永远匹配不上**，那一整段
					   「插件行没有运行」的判断从来没生效过（dsh-imgops 激活失败就是这么漏掉的）。 */
					const liveFor = (row) => {
						const ids = new Set([row.id, row.entryId, row.id && "include:" + row.id].filter(Boolean).map(String));
						return plugins.find((p) => {
							if (!p) return false;
							if (ids.has(String(p.entryId || ""))) return true;
							if (ids.has(String(p.id || ""))) return true;
							return Boolean(p.meta && ids.has(String(p.meta.patchId || "")));
						}) || null;
					};
					for (const row of rows) {
						const live = liveFor(row);
						const failed = live && (live.failed || live.status === "failed" || live.status === "error" || live.inactive === true);
						if (failed) {
							findings.push({
								severity: "error",
								title: "插件行没有运行：" + (row.id || row.name),
								detail: JSON.stringify(live).slice(0, 500),
								plain: "大白话：插件已经被宿主认领了，但它起不来 —— 通常是它要的某个依赖没装上，或者宿主版本对不上。",
								fix: [
									{ text: "先点「重新诊断」确认不是刚装完的瞬间状态" },
									{ text: "看体检里有没有「profile 里多了一份 dsh-tools」——有的话先点「一键修复」再重启" },
									{ text: "还是不行：点「回滚到安装前」，把报错原文贴给 AI" }
								],
								action: { kind: "fix", label: "看诊断", command: "dsh-fix doctor" }
							});
						} else if (live && live.enabled === true && live.fiberPhase !== "active") {
							/* R13：**装上了 ≠ 起来了**。行勾着、包也在，但宿主的 fiber 没进 active ——
							   它的工具/命令一个都不会出现，而面板过去会报「一切正常」。
							   最常见的原因就差一行 inject 声明（宿主原话：cannot get property "X" without inject）。 */
							const services = servicesFromHostError(hostDiag || "");
							const guess = services.length > 0
								? injectFixLine(services, [])
								: "看下面「服务声明」那条扫描结果，把用到的服务补进入口文件的 export const inject 数组";
							findings.push({
								severity: "error",
								title: "装上了，但没激活：" + (row.id || row.name),
								detail: "bundle 行已勾选（enabled），但宿主这一行的 fiberPhase 是 " + JSON.stringify(live.fiberPhase) + "，不是 \"active\"。\n" +
									(hostDiag ? "宿主原话：" + String(hostDiag).slice(0, 800) + "\n" : "") +
									"行记录：" + JSON.stringify(live).slice(0, 400),
								plain: "大白话：包已经躺在 node_modules 里、名单上也勾上了，但插件**启动的那一步失败了** —— 所以它的工具、命令、界面一个都不会出现。这不是网络问题，重装一百次也一样，得改插件自己的入口代码。",
								fix: [
									{ text: "让作者补服务声明：" + guess },
									{ text: "自己改：在 apply 所在的那个文件顶部加 export const inject = ['" + (services[0] || "tools") + "']（已有 inject 就往数组里加）" },
									{ text: "改完重新打包安装一次（或让作者发新版），重启后点「重新诊断」确认 fiberPhase 变成 active" }
								],
								action: { kind: "fix", label: "看诊断", command: "dsh-fix doctor" }
							});
						}
					}
				}
				/* 重复 rowId：patch 层真正会互相覆盖的那种冲突。
				   只比**这次装上的 bundle** 与其它 bundle，且跳过 `include:` 组合层
				   （预设会合法地重复引用 base 的行，报出来只是噪音）。 */
				const seen = new Map();
				for (const other of bundles) {
					for (const row of rowIdsOf(other)) {
						if (!row.id || String(row.id).startsWith("include:")) continue;
						if (!seen.has(row.id)) seen.set(row.id, new Set());
						seen.get(row.id).add(other.name || other.packageName);
					}
				}
				for (const [id, owners] of seen) {
					if (owners.size > 1 && [...owners].some((name) => name === bundleName)) {
						findings.push({
							severity: "warn",
							title: "patch 层重复 rowId：" + id,
							detail: "被这些 bundle 同时声明：" + [...owners].join("、") + "。后加载的会覆盖先加载的。",
							plain: "大白话：两个插件都想占用同一个「行编号」，后加载的会把前面的盖掉 —— 于是某个插件的功能会凭空消失。",
							fix: [
								{ text: "先确认是不是同一个功能的两个版本同时装着，卸掉多余的那个" },
								{ text: "必须共存的话，在 profile 的 cordis.patch.yml 里给其中一行的 id 改名" }
							],
							action: { kind: "fix", label: "复制排查命令", command: "dsh doctor" }
						});
					}
				}
			}
		}
		if (job.install && job.install.application === "restart-required") {
			findings.push({
				severity: "info",
				title: "需要重启桌面应用才生效",
				detail: "宿主已写入配置，但当前进程不重载这一层。",
				plain: "大白话：东西已经装好了，但要关掉 DSH 再打开一次才会用上（宿主代码不热重载）。",
				fix: [
					{ text: "点下面的「重启 DSH」，或者自己关掉窗口再打开" },
					{ text: "重启回来后点「重新诊断」，确认变成「一切正常」" }
				],
				action: { kind: "restart", label: "重启 DSH", command: null }
			});
		}
	}

	if (job.detected && job.detected.kind === "skill") {
		const name = (job.install && job.install.skillName) || (job.detected.payload && job.detected.payload.meta.name);
		let found = null;
		for (let i = 0; i < 4 && !found; i += 1) {
			const list = await safeCall(() => (skills && typeof skills.list === "function" ? skills.list({}) : null));
			if (Array.isArray(list)) {
				inventory.skills = list.length;
				found = list.find((s) => s && (s.name === name || s.id === name)) || null;
			}
			if (!found) await sleep(i === 0 ? 200 : 700);
		}
		if (!found) {
			findings.push({
				severity: "error",
				title: "技能目录已落位，但目录清单里读不到 " + name,
				detail: "可能是 frontmatter 的 name 与目录名不一致、被更高优先级的根同名覆盖，或 watcher 还没刷新。",
				plain: "大白话：文件已经放进技能目录了，但宿主报「没有这个技能」。最常见的原因是 SKILL.md 里的 name 和文件夹名写的不一样。",
				fix: [
					{ text: "打开这个技能目录，确认 SKILL.md 顶部 frontmatter 的 name 与文件夹名一致" },
					{ text: "还不行就点「重新诊断」（宿主会重扫技能目录）" }
				],
				action: { kind: "fix", label: "查看技能根目录", command: job.install && job.install.skillDir ? "explorer \"" + job.install.skillDir + "\"" : null }
			});
		} else {
			const path = found.path || found.file || found.directory || found.instructionFile || null;
			if (path && job.install && job.install.skillDir && !String(path).replace(/\\/g, "/").startsWith(String(job.install.skillDir).replace(/\\/g, "/"))) {
				findings.push({
					severity: "warn",
					title: "同名技能被更高优先级的目录覆盖",
					detail: "清单命中的是 " + String(path) + "，不是刚落位的 " + job.install.skillDir,
					plain: "大白话：新技能是装上了，但同名的另一个技能优先级更高，所以真正被用上的是那个旧的。",
					fix: [
						{ text: "要留新的：把旧的那份改名或删掉，再点「重新诊断」" },
						{ text: "要留旧的：忽略这条，新装的那份不会生效" }
					],
					action: { kind: "info", label: "重命名后重装", command: null }
				});
			}
		}
	}

	/* R8：装完当场扫一遍工具注册契约。
	   0.2.1 起漏 `output` 的插件不是"小毛病"——它在**下次启动**才会失活，required 插件
	   还会让整次启动中止（恢复对话框 + 一串「等待服务」）。装的时候就把它说出来。 */
	if (job.detected && job.detected.kind === "bundle") {
		const installedName = (job.install && job.install.bundleName) ||
			(job.detected.payload && job.detected.payload.manifest && job.detected.payload.manifest.name);
		const pro = profileDir();
		if (installedName && pro) {
			const installedDir = join(pro, "node_modules", ...String(installedName).split("/"));
			const contract = await scanToolContract(installedDir, { maxFiles: 120 }).catch(() => null);
			if (contract && contract.violations.length > 0) {
				findings.push({
					severity: "warn",
					title: "装上后自检：" + contract.violations.length + " 个工具定义没声明 output",
					detail: contract.violations.slice(0, 8).map((v) => "  · " + v.tool + " @ " + v.file + ":" + v.line).join("\n") +
						"\nDSH 0.2.1 起 ctx.tools.register() 要求 output { schema, render }；漏了下次启动这个插件会失活（required 插件还会让整次启动中止）。静态扫描是近似判据，实际以启动日志为准。",
					plain: "大白话：这份插件少了一段宿主现在必需的声明。装是装上了，但下次启动可能起不来 —— 先别急着重启，等修好或换版本。",
					fix: [
						{ text: "让作者补 output { schema, render }（模板见 skill dsh-selfrepair 陷阱⑤）" },
						{ text: "暂时用不了就先点「回滚到安装前」，或者先别重启 DSH" }
					],
					action: { kind: "rollback", label: "回滚到安装前", command: null }
				});
			}

			/* R13：装完再扫一遍服务声明。装之前没确认的人、以及老板本，都在这里兜住；
			   宿主回执里已经点名「without inject」时按 error 报（那不是猜，是实测）。 */
			const injectScan = await scanInject(installedDir, { maxFiles: 120 }).catch(() => null);
			if (injectScan && injectScan.violations.length > 0) {
				const services = injectScan.violations.map((v) => v.service);
				const hostSaid = /without inject|did not activate/i.test(hostDiag || "");
				findings.push({
					severity: hostSaid ? "error" : "warn",
					title: (hostSaid ? "已确认：插件没激活 —— " : "装上后自检：") + "入口用了 " + services.join("、") + "，inject 里没声明",
					detail: injectScan.violations.slice(0, 8).map((v) => "  · " + v.service + " @ " + v.file + ":" + v.line).join("\n") +
						"\nCordis 规则：没在 inject 里声明的服务不许取，取了就抛 cannot get property \"X\" without inject，整个插件激活失败。\n" +
						(hostDiag ? "宿主原话：" + String(hostDiag).slice(0, 600) + "\n" : "") +
						"静态扫描是近似判据，实际以宿主启动日志为准。",
					plain: "大白话：这份插件的入口用了宿主的 " + services.join("、") + " 服务，却没在文件顶部声明要用它 —— 宿主一启动就抛错，于是插件整个起不来（工具/命令一个都不会出现）。补一行声明就好。",
					fix: [
						{ text: injectFixLine(services, injectScan.declared) },
						{ text: "改完重新打包安装（或让作者发新版），重启后点「重新诊断」确认这条消失" }
					],
					action: { kind: "rollback", label: "先回滚到安装前", command: null }
				});
			}
		}
	}

	const verdict = findings.some((f) => f.severity === "error")
		? "error"
		: findings.some((f) => f.severity === "warn")
			? "warn"
			: "ok";
	/* 一句话大白话结论：面板上永远显示，不用先点开关。用户要的是「看完就知道怎么办」。 */
	const plain = verdict === "ok"
		? "装好了，宿主也认得它 —— 没发现要处理的。"
		: verdict === "warn"
			? "装上了，但有地方不太对劲。下面每条都写了怎么解决；不确定就先点「重新诊断」。"
			: "这次没能正常用起来。下面每条都写了怎么解决；最稳的一步是「回滚到安装前」再重装。";
	return { verdict, plain, findings, inventory, at: new Date().toISOString() };
}

export async function readSkillEntry(dir) {
	try {
		return await readFile(join(dir, "SKILL.md"), "utf8");
	} catch {
		return null;
	}
}
