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

/**
 * profile 里「插件登记配置」的四个文件。
 *
 * ⚠️ 为什么是四个而不是三个（R49 补）：`pnpm-workspace.yaml` 也在被本面板写 ——
 *  R31 的「豁免这一个版本」会把 `trustPolicyExclude` 追加进去。少拍一个，
 *  回滚之后那条豁免还留在磁盘上，就会变成"回滚了但配置没回去"。
 */
const PROFILE_FILES = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

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

/**
 * 装完之后再拍一份（post）。**这是三方比对的前提**。
 *
 * 没有它就只能比「装之前」和「现在」：分不清"这次安装写下的"与"装完之后人又手改的"，
 * 一律覆盖就会静默吃掉用户的手改（B 站评论问的正是这个场景）。
 * 失败不影响安装 —— 回滚会自动降级成 `unverified`（先备份当前内容再还原，并如实说明没依据）。
 */
export async function captureProfileAfter(snapshotDir, profileDir) {
	if (!snapshotDir || !profileDir) return { ok: false, reason: "缺快照目录或 profile 目录", captured: [] };
	const dest = join(snapshotDir, "after-profile");
	await mkdir(dest, { recursive: true });
	const captured = [];
	for (const name of PROFILE_FILES) {
		const data = await readOrNull(join(profileDir, name));
		if (data === null) continue;
		await writeFile(join(dest, name), data);
		captured.push(name);
	}
	try {
		const metaPath = join(snapshotDir, "meta.json");
		const meta = JSON.parse(await readFile(metaPath, "utf8"));
		meta.afterCaptured = new Date().toISOString();
		meta.afterFiles = captured;
		await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
	} catch {
		/* meta 写不进去不影响 after-profile 目录本身 */
	}
	return { ok: true, captured, dir: dest };
}

/**
 * 三方比对：快照前的 `pre`、这次安装写下的 `post`、现在的 `now`。
 *
 * 返回 action：
 *  · `unchanged` —— 现在与装之前一致（或两边都没有），不用动
 *  · `restore`   —— 现在的内容就是这次安装写的，按快照还原
 *  · `remove`    —— 文件是这次安装新建的、且内容没被改过 → 删掉才算回滚干净
 *  · `conflict`  —— **装完之后被人改过**（既不是 pre 也不是 post）→ 不覆盖，另存证据
 *  · `added`     —— 安装新建但当时没记 post（旧快照 / post 拍失败）→ 不删，只报告
 *  · `unverified`—— 旧快照没有 post：没有证据，不假装知道，恢复前先备份
 */
export function classifyProfileDrift({ pre, post, now } = {}) {
	const toBuf = (value) =>
		value === null || value === undefined ? null : Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
	const before = toBuf(pre);
	const after = toBuf(post);
	const live = toBuf(now);
	const eq = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));
	if (before === null && live === null) return { action: "unchanged", reason: "装之前没有、现在也没有" };
	if (before === null && after !== null && eq(live, after)) {
		return { action: "remove", reason: "这个文件是这次安装新建的、之后没被改过 → 删掉才算回滚干净" };
	}
	if (before === null && after !== null) {
		return { action: "conflict", reason: "这个文件是这次安装新建的，但装完之后又被改过，不删" };
	}
	if (before === null) return { action: "added", reason: "装之前没有这个文件，且没有「装完之后」的记录（旧快照）→ 不删" };
	if (live === null) return { action: "restore", reason: "文件现在不在了，按快照恢复" };
	if (eq(live, before)) return { action: "unchanged", reason: "与安装前一致" };
	if (after !== null && eq(live, after)) return { action: "restore", reason: "现在的内容正是这次安装写下的，按快照还原" };
	if (after !== null) return { action: "conflict", reason: "装完之后被改过（既不是安装前，也不是这次安装写下的），不覆盖" };
	return { action: "unverified", reason: "这份快照是旧版生成的，没有「装完之后」的记录，无法判断有没有被手改" };
}

/**
 * 冲突摘要：给出「多了几行 / 少了几行 / 第一处不同」，比一句"冲突了"有用得多。
 * 纯函数（自检直接喂字符串）。
 */
export function summarizeDrift(pre, now) {
	const toLines = (value) => String(value === null || value === undefined ? "" : value).replace(/\r\n/g, "\n").split("\n");
	const a = toLines(pre);
	const b = toLines(now);
	const countOf = (lines) => {
		const map = new Map();
		for (const line of lines) map.set(line, (map.get(line) || 0) + 1);
		return map;
	};
	const ma = countOf(a);
	const mb = countOf(b);
	let added = 0;
	let removed = 0;
	for (const [line, n] of mb) added += Math.max(0, n - (ma.get(line) || 0));
	for (const [line, n] of ma) removed += Math.max(0, n - (mb.get(line) || 0));
	const setA = new Set(a);
	const setB = new Set(b);
	const first = b.find((line) => line.trim() && !setA.has(line)) || a.find((line) => line.trim() && !setB.has(line)) || "";
	return { added, removed, first: String(first).trim().slice(0, 120) };
}

/**
 * 把快照里的 profile 配置写回。**三方比对**后只动「该动且安全」的文件：
 *   · 装完之后被手改过的（conflict）→ 不覆盖，当前内容另存到 `<快照>/conflicts/`
 *   · 这次安装新建的（remove）→ 删掉（回滚干净）
 *   · 旧快照没有 post（unverified）→ 先备份再还原，并如实说明判断没有依据
 *
 * 返回 `{changed, removed, skipped, conflicts, added}`。
 */
export async function restoreProfileFiles(snapshotDir, profileDir) {
	if (!profileDir) return { changed: [], removed: [], skipped: ["没有 profile 目录"], conflicts: [], added: [] };
	const changed = [];
	const removed = [];
	const skipped = [];
	const conflicts = [];
	const added = [];
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const saveAside = async (name, data, kind) => {
		try {
			const dest = join(snapshotDir, "conflicts", name + "." + kind + "-" + stamp + ".bak");
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, data === null ? Buffer.from("") : data);
			return dest;
		} catch {
			return null;
		}
	};
	for (const name of PROFILE_FILES) {
		const pre = await readOrNull(join(snapshotDir, "profile", name));
		const post = await readOrNull(join(snapshotDir, "after-profile", name));
		const to = join(profileDir, name);
		const now = await readOrNull(to);
		const verdict = classifyProfileDrift({ pre, post, now });
		if (verdict.action === "unchanged") {
			skipped.push(name + "（" + verdict.reason + "）");
			continue;
		}
		if (verdict.action === "added") {
			added.push({ file: name, reason: verdict.reason });
			skipped.push(name + "（" + verdict.reason + "）");
			continue;
		}
		if (verdict.action === "conflict") {
			const summary = summarizeDrift(pre ? pre.toString("utf8") : "", now ? now.toString("utf8") : "");
			const backup = await saveAside(name, now, "conflict");
			conflicts.push({ file: name, reason: verdict.reason, summary, backup });
			skipped.push(name + "（" + verdict.reason + "）");
			continue;
		}
		if (verdict.action === "remove") {
			await rm(to, { force: true });
			removed.push(name);
			continue;
		}
		if (verdict.action === "unverified") {
			const backup = await saveAside(name, now, "pre-rollback");
			if (backup) skipped.push(name + "（旧快照：覆盖前已备份当前内容）");
		}
		await writeFile(to, pre);
		changed.push(name);
	}
	return { changed, removed, skipped, conflicts, added };
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
