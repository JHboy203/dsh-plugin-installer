/**
 * dev/probe-skill-e2e.mjs — R38 收口探针：把「装一个 GitHub Skill → 台账 → 检查更新 →
 * 本地改过时拒绝重装 → 确认后重装 → 清理」这条链**一条命令**跑完。
 *
 * 为什么要有它：这一段此前只有单测（台账读写 / 三态判定 / 重装拒绝），没有真机 e2e。
 * 2026-10-31 第一次手动跑就撞到两个判据问题（归档包装目录 × tree 链接 subdir），
 * 过程散在会话里。这个探针把步骤与清理固定下来，换会话直接跑，不用再手搓 curl。
 *
 * 默认 **dry-run（只做前置检查 + 打印计划）**；真跑必须 `--apply`。
 * 会用真网络、会往技能根写一个真实技能（`--keep` 时保留；默认跑完删掉）。
 *
 * 跑法：
 *   host_selfcheck({plugin:"dsh-plugin-installer", script:"dev/probe-skill-e2e.mjs",
 *                   args:["--base","http://127.0.0.1:<GUI端口>","--apply"]})
 *   node dev/probe-skill-e2e.mjs --base ...            # 只看计划
 *
 * 参数：--base <url> / --repo owner/name / --ref main / --subdir skills/x / --skill x
 *       --apply / --keep / --force / --timeout 240
 */
import { appendFile, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { forgetSkillSource, hashSkillDir, readSkillLedger } from "../lib/skillledger.js";
import { skillRoots } from "../lib/hostinfo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");
const LEDGER = join(PLUGIN_DIR, "data", "skill-sources.json");

function arg(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
	if (i >= 0) return true;
	return fallback;
}

const BASE = String(arg("base", process.env.DSH_WEB_URL || "http://127.0.0.1:24376")).replace(/\/+$/, "");
const API = BASE + "/plugin-installer";
const REPO = String(arg("repo", "anthropics/skills"));
const REF = String(arg("ref", "main"));
const SUBDIR = String(arg("subdir", "skills/brand-guidelines")).replace(/^\/+|\/+$/g, "");
const SKILL = String(arg("skill", basename(SUBDIR) || "brand-guidelines"));
const APPLY = arg("apply", false) === true;
const KEEP = arg("keep", false) === true;
const FORCE = arg("force", false) === true;
const TIMEOUT = Number(arg("timeout", 240)) || 240;

const root = skillRoots()[0] || null;
const skillDir = root ? join(root, SKILL) : null;

function line(text) {
	process.stdout.write(text + "\n");
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
async function http(path, init) {
	const res = await fetch(API + path, { cache: "no-store", ...init });
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("响应不是 JSON（HTTP " + res.status + "）：" + text.slice(0, 160));
	}
}
function stateOf(raw) {
	return raw && raw.state ? raw.state : raw;
}
function findJob(state, id) {
	const all = [...(state.active ? [state.active] : []), ...(state.jobs || [])];
	return all.find((job) => job && job.id === id) || null;
}
async function waitJob(id) {
	const started = Date.now();
	let last = "";
	while (Date.now() - started < TIMEOUT * 1000) {
		const state = stateOf(await http("/state"));
		const job = findJob(state, id);
		if (!job) throw new Error("任务从状态里消失了：" + id);
		const marker = job.status + ":" + (job.stage || "");
		if (marker !== last) {
			line("  · " + marker);
			last = marker;
		}
		if (["done", "failed", "awaiting-confirm", "cancelled"].includes(job.status)) return job;
		await sleep(1000);
	}
	throw new Error("等任务超时（" + TIMEOUT + "s）：" + id);
}
async function submit(treeUrl) {
	const result = await http("/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: treeUrl }) });
	if (!result.ok) throw new Error("提交被拒：" + (result.message || result.reason || "未知"));
	return result.job;
}

line("Skill 端到端探针（R38 收口）");
line("· 面板：" + API);
line("· 技能根：" + (root || "（读不到！）"));
line("· 目标：" + REPO + " @" + REF + " / " + SUBDIR + " → " + (skillDir || "?"));
line("· 模式：" + (APPLY ? "APPLY（会真装、真改、真删）" : "DRY-RUN（只检查 + 打印计划）"));

let exitCode = 0;
let installed = false;
let createdJobId = null;
try {
	const health = await http("/health");
	line("· /health：" + (health.build || "?") + "（运行中代码 " + (health.code && health.code.appliedAfterLoad ? "已 re-apply" : "未见 re-apply") + "）");
	if (!root) throw new Error("读不到技能根（skillRoots() 为空）");

	if (await exists(skillDir)) {
		if (!FORCE) throw new Error("目标技能目录已存在：" + skillDir + "（换 --skill，或加 --force 明确覆盖）");
		line("⚠ 目标技能目录已存在，--force 允许本次探针覆盖/删除它");
	}

	const ledger = await readSkillLedger(LEDGER);
	line("· 台账：" + Object.keys(ledger.items).length + " 条" + (await exists(LEDGER) ? "" : "（文件还不存在）"));

	const treeUrl = "https://github.com/" + REPO + "/tree/" + REF + "/" + SUBDIR;
	if (!APPLY) {
		line("");
		line("计划（--apply 时执行）：");
		line("  ① POST /submit " + treeUrl);
		line("  ② 轮询 /state 到终态；失败就打印 detected/notes（树链接 subdir 的已知问题看这里）");
		line("  ③ 校验 data/skill-sources.json：owner/repo/commit/仓库内路径/digest");
		line("  ④ POST action:check-all-updates → 该技能应在 skillUpdates.items 里");
		line("  ⑤ 改 SKILL.md 模拟本地改动 → reinstall-skill 不带 confirmEdited，应回 locally-edited");
		line("  ⑥ 带 confirmEdited+confirm 重装 → 轮询完成，本地改动被覆盖、台账 digest 更新");
		line("  ⑦ 清理：删技能目录 + forgetSkillSource（--keep 可保留）");
		line("");
		line("SUMMARY dry-run：前置检查通过，未改动任何东西");
	} else {
		line("");
		line("① 提交安装…");
		const job = await submit(treeUrl);
		createdJobId = job.id;
		line("  job " + job.id);
		const finished = await waitJob(job.id);
		if (finished.status !== "done") {
			line("");
			line("安装未完成：" + finished.status + " / " + (finished.error && finished.error.code || "?") + " " + (finished.error && finished.error.message || ""));
			const detected = finished.detected || {};
			line("  detected.kind = " + detected.kind + " · root = " + (detected.root || "?"));
			if (Array.isArray(detected.notes) && detected.notes.length) line("  notes = " + JSON.stringify(detected.notes));
			if (detected.kind === "unknown") {
				line("");
				line("  ★ 已知问题（R38 收口时撞到，未修）：tree 链接的 subdir 被拼在**解包根**上，");
				line("    而 GitHub 归档外面还有一层 repo-<ref>/ 包装 → 找不到 SKILL.md。");
				line("    复现：node dev/probe-archive-subdir.mjs --strict（应红）。");
				line("    修复方向：detectKind 先剥一层归档包装得到 repoRoot，再拼 subdir；");
				line("    台账的仓库内路径改为 relative(repoRoot, payload.dir)，不要用 wrappers 当前缀。");
			}
			throw new Error("安装未完成，后续步骤不做");
		}
		installed = true;
		line("  安装完成");

		line("");
		line("③ 校验台账…");
		const after = await readSkillLedger(LEDGER);
		const entry = after.items[String(SKILL).toLowerCase()];
		if (!entry) throw new Error("台账里没有 " + SKILL + " 的记录");
		const src = entry.source || {};
		line("  来源：" + [src.owner, src.repo, src.ref, src.commit && String(src.commit).slice(0, 8), src.path].filter(Boolean).join(" / "));
		if (src.type !== "github" || !src.commit || src.path === null) throw new Error("台账缺 GitHub 坐标 / commit / 路径");
		if (src.path !== SUBDIR) throw new Error("台账仓库内路径不对：期望 " + SUBDIR + "，实际 " + JSON.stringify(src.path));

		line("");
		line("④ 检查更新（三条链一起）…");
		const checked = await http("/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "check-all-updates" }) });
		const up = ((checked.skillUpdates && checked.skillUpdates.items) || []).find((item) => item.dir === SKILL);
		if (!up) throw new Error("skillUpdates 里没有 " + SKILL);
		line("  关系：" + up.relation + " · 本地改过：" + Boolean(up.locallyEdited) + (up.reason ? " · " + up.reason : ""));

		line("");
		line("⑤ 模拟本地改动，再请求重装（不带 confirmEdited）…");
		await appendFile(join(skillDir, "SKILL.md"), "\n<!-- e2e local edit -->\n", "utf8");
		const editedDigest = await hashSkillDir(skillDir);
		const denied = await http("/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reinstall-skill", name: SKILL, confirm: true }) });
		if (denied.ok !== false || denied.reason !== "locally-edited") throw new Error("本地改过后竟然没有被拒绝：" + JSON.stringify(denied).slice(0, 300));
		line("  已拒绝（reason=locally-edited）——保护生效");

		line("");
		line("⑥ 带 confirmEdited 重装…");
		const redone = await http("/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reinstall-skill", name: SKILL, confirm: true, confirmEdited: true }) });
		if (!redone.ok || !redone.job) throw new Error("重装提交失败：" + (redone.error || redone.reason || "?"));
		const job2 = await waitJob(redone.job.id);
		if (job2.status !== "done") throw new Error("重装未完成：" + job2.status + " / " + (job2.error && job2.error.message));
		const text = await readFile(join(skillDir, "SKILL.md"), "utf8");
		if (/e2e local edit/.test(text)) throw new Error("重装后本地改动还在（覆盖没发生？）");
		const ledger3 = await readSkillLedger(LEDGER);
		const entry3 = ledger3.items[String(SKILL).toLowerCase()];
		if (!entry3 || entry3.digest === entry.digest) throw new Error("重装后台账 digest 没更新");
		line("  重装完成，台账 digest " + String(entry.digest).slice(0, 8) + " → " + String(entry3.digest).slice(0, 8));

		line("");
		line("SUMMARY e2e 全通（安装 → 台账 → 更新 → 本地改动保护 → 重装 → 清理）");
	}
} catch (e) {
	exitCode = 1;
	line("");
	line("FAIL " + String((e && e.message) || e));
} finally {
	if (APPLY && installed && !KEEP && skillDir) {
		try {
			await rm(skillDir, { recursive: true, force: true });
			await forgetSkillSource(LEDGER, SKILL);
			line("清理：已删除技能目录与台账记录" + (createdJobId ? "（任务 " + createdJobId + " 留在历史里）" : ""));
		} catch (e) {
			line("清理失败（需要手动处理）：" + String((e && e.message) || e));
			exitCode = 1;
		}
	} else if (APPLY && KEEP) {
		line("--keep：技能与台账保留在 " + skillDir);
	}
}
process.exitCode = exitCode;
