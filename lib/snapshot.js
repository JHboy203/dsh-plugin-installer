/**
 * snapshot.js — 安装前快照与一键回滚。
 *
 * 快照记录的是**事实**，不是启动时的回退点：
 *   · profile 的三件套（package.json / cordis.patch.yml / pnpm-lock.yaml）
 *   · 插件清单与 bundle 清单（调用方传进来）
 *   · 技能根目录的文件名列表，以及**将被覆盖的那个技能目录整份拷贝**
 *
 * 回滚顺序：先卸掉这次装上的插件（走宿主插件管理，包管理器那一步由它负责），
 * 再把三件套按快照写回，最后恢复技能目录。任一步失败都保留已完成的部分并如实报告。
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const PROFILE_FILES = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"];

async function readOrNull(file) {
	try {
		return await readFile(file);
	} catch {
		return null;
	}
}

export async function createSnapshot({ root, reason, profileDir, skillsRoot, bundles, plugins, versions }) {
	const at = new Date();
	const id = "snap-" + at.toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
	const dir = join(root, id);
	await mkdir(join(dir, "profile"), { recursive: true });
	const saved = [];
	if (profileDir) {
		for (const name of PROFILE_FILES) {
			const data = await readOrNull(join(profileDir, name));
			if (data === null) continue;
			await writeFile(join(dir, "profile", name), data);
			saved.push(name);
		}
	}
	let skillNames = [];
	if (skillsRoot) {
		try {
			const entries = await readdir(skillsRoot, { withFileTypes: true });
			skillNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			skillNames = [];
		}
	}
	const meta = {
		id,
		at: at.toISOString(),
		reason: reason || "",
		profileDir: profileDir || null,
		skillsRoot: skillsRoot || null,
		savedFiles: saved,
		versions: versions || null,
		bundles: (bundles || []).map((b) => ({ name: b.name, enabled: b.enabled, version: b.version || null, availability: b.availability || null })),
		plugins: (plugins || []).map((p) => ({ id: p.id, enabled: p.enabled, status: p.status || null })),
		skills: skillNames
	};
	await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
	return { id, dir, meta };
}

/** 在快照里额外备份一个「即将被覆盖」的技能目录。 */
export async function backupSkillInSnapshot(snapshotDir, srcDir, name) {
	const dest = join(snapshotDir, "skills-backup", name);
	await rm(dest, { recursive: true, force: true });
	await cp(srcDir, dest, { recursive: true, dereference: true, force: true });
	return dest;
}

/**
 * R26：`file:` 依赖 → 本机路径。
 * 本面板把本地包装成 `data/vendor/pkg-<name>-<ver>.tgz`，profile 里记的是绝对路径的 `file:`；
 * 相对路径（手写的老依赖）不做解析 —— 那种回滚会失败，但会如实报「没有备份」。
 */
export function fileSpecPath(spec) {
	const text = String(spec || "").trim();
	if (!/^file:/i.test(text)) return null;
	const rest = text.slice(5).trim();
	if (!rest || !isAbsolute(rest)) return null;
	return rest;
}

/**
 * 升级前把「旧的那份本地面包」拷进快照。
 *
 * 为什么必须拷：本地包重打包之后 vendor/ 里的文件名会带上新版本号（或同名文件被覆盖），
 * 升级完成时**旧包已经不在磁盘上了**；回滚要装回旧版，只有快照里这一份能救命。
 */
export async function backupVendorTarball(snapshotDir, spec) {
	const file = fileSpecPath(spec);
	if (!file) return null;
	try {
		const data = await readFile(file);
		const dest = join(snapshotDir, "vendor", basename(file));
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, data);
		return { source: file, copy: dest, bytes: data.length };
	} catch {
		return null;
	}
}

/** 回滚时把快照里的旧包写回原路径（装配之前的 `file:` 依赖必须指向它）。 */
export async function restoreVendorTarball(entry) {
	if (!entry || !entry.copy || !entry.source) return { restored: false, reason: "快照里没有旧包" };
	try {
		const data = await readFile(entry.copy);
		await mkdir(dirname(entry.source), { recursive: true });
		await writeFile(entry.source, data);
		return { restored: true, path: entry.source, bytes: data.length };
	} catch (e) {
		return { restored: false, reason: String((e && e.message) || e) };
	}
}

export async function readSnapshotMeta(snapshotDir) {
	try {
		return JSON.parse(await readFile(join(snapshotDir, "meta.json"), "utf8"));
	} catch {
		return null;
	}
}

async function sameFile(a, b) {
	const x = await readOrNull(a);
	if (x === null) return true;
	const y = await readOrNull(b);
	if (y === null) return false;
	return x.equals(y);
}

/**
 * 把快照里的 profile 三件套写回。只改动**已经变了**的文件，返回改动清单。
 */
export async function restoreProfileFiles(snapshotDir, profileDir) {
	if (!profileDir) return { changed: [], skipped: ["没有 profile 目录"] };
	const changed = [];
	const skipped = [];
	for (const name of PROFILE_FILES) {
		const from = join(snapshotDir, "profile", name);
		const to = join(profileDir, name);
		const data = await readOrNull(from);
		if (data === null) {
			skipped.push(name + "（快照里没有）");
			continue;
		}
		if (await sameFile(from, to)) {
			skipped.push(name + "（未变化）");
			continue;
		}
		await writeFile(to, data);
		changed.push(name);
	}
	return { changed, skipped };
}

export async function restoreSkill(snapshotDir, skillsRoot, name) {
	if (!skillsRoot || !name) return { restored: false, reason: "缺少技能根目录或名字" };
	const live = join(skillsRoot, name);
	const backup = join(snapshotDir, "skills-backup", name);
	let hasBackup = false;
	try {
		hasBackup = (await stat(backup)).isDirectory();
	} catch {
		hasBackup = false;
	}
	if (hasBackup) {
		await rm(live, { recursive: true, force: true });
		await cp(backup, live, { recursive: true, dereference: true, force: true });
		return { restored: true, mode: "restored-previous" };
	}
	await rm(live, { recursive: true, force: true });
	return { restored: true, mode: "removed" };
}

/** 只留最近 N 份快照（默认 40），避免 data/ 无限长。 */
export async function pruneSnapshots(root, keep = 40) {
	let entries = [];
	try {
		entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.startsWith("snap-"));
	} catch {
		return [];
	}
	const withTime = [];
	for (const entry of entries) {
		const dir = join(root, entry.name);
		let at = 0;
		try {
			at = (await stat(dir)).mtimeMs;
		} catch {
			at = 0;
		}
		withTime.push({ dir, name: entry.name, at });
	}
	withTime.sort((a, b) => b.at - a.at);
	const dropped = [];
	for (const item of withTime.slice(keep)) {
		await rm(item.dir, { recursive: true, force: true }).catch(() => {});
		dropped.push(item.name);
	}
	return dropped;
}
