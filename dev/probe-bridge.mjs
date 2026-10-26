/**
 * dev/probe-bridge.mjs — 跨插件契约探针（R27）：**两边真的能对上话吗**。
 *
 * 为什么需要它：`pluginCatalog.removal` 是**两个插件之间的字段契约**，各自的自检只能证明
 * 「我按我以为的形状收发」。字段名一改（`token` → `planToken`、`verified.removed` → `removed`），
 * 两边自检都绿，真升级时才炸 —— 而这正好是一条**不可逆**的链路（先卸载再装）。
 *
 * 做法：把**真的** CatalogService 装成消费方眼里的服务，交给 installer 的
 * `describeRemovalProvider()` 去探测，再按 installer 的实际调用方式走一遍
 * plan → apply（apply 用假宿主，**不会真卸载**），最后核对 installer 读到的字段是否齐全。
 *
 * ★ 独立性：协作方（dsh-plugin-catalog）不在本机时 **SKIP 而不是 FAIL** ——
 *   一个可选协作方不该让本插件的自检在别的机器上变红。
 *
 * 跑法：`node dev/probe-bridge.mjs`（普通 node 即可；只读 profile + 临时留痕文件）
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeCollaboratorLine, describeRemovalProvider, pickRemovalProvider } from "../lib/collaborator.js";
import { profileDir } from "../lib/hostinfo.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CATALOG = join(HERE, "..", "..", "dsh-plugin-catalog");

const checks = [];
function ok(name, condition, detail) {
	checks.push({ name, ok: Boolean(condition), detail: condition ? "" : String(detail ?? "") });
}
function skip(name, why) {
	checks.push({ name, ok: true, skipped: true, detail: why });
}

if (!existsSync(join(CATALOG, "lib", "service.mjs"))) {
	skip("跨插件契约：协作方（dsh-plugin-catalog）不在本机", "可选依赖 —— 装在同一工作区时才会跑这条");
} else {
	const { CatalogService } = await import("file://" + join(CATALOG, "lib", "service.mjs").replace(/\\/g, "/"));
	const tempRoot = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
	const journalFile = join(tempRoot, "removal-journal.json");

	/* 假宿主：记录调用、永远回 applied —— apply 阶段**不会真卸载任何东西** */
	let removeCalls = 0;
	const fakePluginManager = {
		removeBundle: async (name) => {
			removeCalls += 1;
			return { changed: true, application: "applied", stage: "remove", target: name };
		},
	};

	/* 真 CatalogService，装成消费方会看到的样子 */
	const catalog = new CatalogService({ ctx: { get: (key) => (key === "pluginManager" ? fakePluginManager : undefined) }, toolSchemas: () => [] });
	catalog.settings = { workspace: tempRoot };
	catalog.removalJournalFile = () => journalFile;

	const service = {
		name: "dsh-plugin-catalog",
		version: "0.31.0-probe",
		removal: {
			api: 1,
			describe: () => catalog.removalHost(),
			plan: async (input) => await catalog.removalPlan(input),
			apply: async (input) => await catalog.removalApply(input),
			journal: async (limit) => await catalog.removalJournal(limit),
		},
	};
	const ctx = { get: (key) => (key === "pluginCatalog" ? service : key === "pluginManager" ? fakePluginManager : undefined) };

	/* ① 探测：installer 认不认这个服务 */
	const provider = pickRemovalProvider(ctx);
	ok("契约：installer 认得出协作方（api=1 + plan/apply）", provider && provider.ok === true, JSON.stringify(provider && { ok: provider.ok, state: provider.state }));
	ok("契约：一行摘要能写出来（面板/工具直接用）", /可用/.test(describeCollaboratorLine(provider)), describeCollaboratorLine(provider));
	ok("契约：服务名与版本对得上（面板会显示 v 版本）", provider && provider.name === "dsh-plugin-catalog" && /0\.31\.0/.test(provider.version), JSON.stringify(provider && { name: provider.name, version: provider.version }));

	/* ② 真走一遍 plan（用本机确实装着的包；只读，不卸载） */
	const dir = profileDir();
	const deps = dir
		? JSON.parse(await readFile(join(dir, "package.json"), "utf8").catch(() => "{}")).dependencies || {}
		: {};
	const target = Object.keys(deps).find((name) => !name.startsWith("@deepseek-ai/") && name !== "dsh-plugin-catalog") || "";
	if (!target) {
		skip("契约：真走一遍 plan → apply", "本机 profile 里没有非宿主自带的已装包");
	} else {
		const planned = await provider.removal.plan({ name: target, purpose: "replace", requestedBy: "probe-bridge" });
		ok("契约：plan 回 ok + token + 有效期（installer 读这三个字段）",
			planned && planned.ok === true && typeof planned.token === "string" && planned.token.length > 8 && Number(planned.expiresAt) > Date.now(),
			JSON.stringify({ ok: planned && planned.ok, token: Boolean(planned && planned.token), expiresAt: planned && planned.expiresAt }));
		ok("契约：plan 带 text / warnings / blockers 三个数组（预检卡直接渲染）",
			planned && typeof planned.text === "string" && Array.isArray(planned.warnings) && Array.isArray(planned.blockers),
			JSON.stringify({ text: typeof (planned && planned.text), warnings: Array.isArray(planned && planned.warnings), blockers: Array.isArray(planned && planned.blockers) }));

		/* ③ 按 installer 的真实方式调 apply：假宿主 + confirm:true */
		if (planned && planned.token) {
			const applied = await provider.removal.apply({ token: planned.token, confirm: true, requestedBy: "probe-bridge" });
			/* ★ 这里**必须**是 false：假宿主没有真的卸载，真 profile 的依赖行还在 ——
			   契约的核心就是「以依赖行为准」，所以 ok 一定是 false（而不是相信回执里的 applied）。 */
			ok("契约：宿主回 applied 但依赖行还在 → ok=false（installer 会判卸载失败）",
				applied && applied.ok === false && /依赖/.test(String(applied.error || "")),
				JSON.stringify({ ok: applied && applied.ok, error: applied && applied.error, code: applied && applied.code }));
			ok("契约：失败也带 verified 三段事实（removed / inDeps / dirExists）",
				applied && applied.verified && typeof applied.verified.removed === "boolean" && typeof applied.verified.inDeps === "boolean",
				JSON.stringify(applied && applied.verified));
			ok("契约：apply 会写留痕（失败的卸载也记，事后能查是谁干的）",
				Number(removeCalls) === 1 && existsSync(journalFile),
				JSON.stringify({ removeCalls, journal: existsSync(journalFile) }));
			const replay = await provider.removal.apply({ token: planned.token, confirm: true });
			ok("契约：token 一次性（重放被拒，不会把同一个包卸两次）",
				replay && replay.ok === false && replay.code === "unknown-token",
				JSON.stringify({ ok: replay && replay.ok, code: replay && replay.code }));
		}
	}

	/* ④ 版本不兼容时要能降级（installer 有 unsupported 分支） */
	const oldService = { name: "dsh-plugin-catalog", version: "0.30.0", removal: { api: 0, plan: async () => ({}), apply: async () => ({}) } };
	const oldProvider = await describeRemovalProvider({ get: () => oldService });
	ok("契约：对方面是老版本（api=0）→ installer 判 unsupported 并说明需要 0.31.0+",
		oldProvider.ok === false && oldProvider.state === "unsupported" && /0\.31\.0/.test(oldProvider.reason),
		JSON.stringify({ state: oldProvider.state, reason: oldProvider.reason }));

	await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

const passed = checks.filter((item) => item.ok).length;
const failed = checks.filter((item) => !item.ok);
const skipped = checks.filter((item) => item.skipped).length;
console.log("dsh-plugin-installer · 跨插件契约探针（R27）");
for (const item of checks) {
	if (!item.ok) console.log("  FAIL " + item.name + (item.detail ? " · " + item.detail : ""));
	else if (item.skipped) console.log("  SKIP " + item.name + (item.detail ? " · " + item.detail : ""));
}
console.log((failed.length === 0 ? "PASS " : "FAIL ") + passed + " / " + checks.length + (skipped ? "（SKIP " + skipped + "）" : ""));
process.exit(failed.length === 0 ? 0 : 1);
