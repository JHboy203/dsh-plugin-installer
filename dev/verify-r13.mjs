/**
 * dev/verify-r13.mjs — R13 的**线上验收**脚本（一条命令，跑完给出五步结论）。
 *
 * 为什么要有它：
 *   ① 中文路径经 bash/curl 命令行传递会被控制台代码页改成乱码（实测 `D:\��Ϣ��\…`），
 *      写进 `.mjs` 文件（UTF-8）再交给 node 才稳；
 *   ② 重启后的验收有固定顺序与固定期望值，手敲 curl 容易漏步骤；
 *   ③ 它同时是「面板流水线端到端」的可复用验收器 —— 换插件只要换 `--path`。
 *
 * 用法：
 *   node dev/verify-r13.mjs                       # 默认验 dsh-imgops，端口取 --port/环境变量/47475
 *   node dev/verify-r13.mjs --port 50123 --yes
 *   node dev/verify-r13.mjs --path "D:\…\某个插件" --no-install   # 只看运行状态，不装
 *
 * 退出码：0 = 全部达到期望；1 = 有步骤不符（输出里逐条标 PASS/FAIL）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));

function arg(name, fallback = null) {
	const list = process.argv.slice(2);
	const i = list.indexOf("--" + name);
	if (i < 0) return fallback;
	const next = list[i + 1];
	return next && !next.startsWith("--") ? next : true;
}

const port = arg("port", process.env.DPI_PORT || "47475");
const base = "http://127.0.0.1:" + port + "/plugin-installer";
const pluginPath = arg("path", "D:\\信息库\\AI工作区\\DSH-Plugin\\dsh-imgops");
const autoYes = arg("yes", false) === true;
const noInstall = arg("no-install", false) === true;

const results = [];
function record(ok, label, extra) {
	results.push({ ok, label, extra });
	console.log((ok ? "PASS " : "FAIL ") + label + (extra ? "  " + String(extra).slice(0, 300) : ""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 体检里某个 code 的明细（失败时打印，省得再去面板翻）。 */
function CODE_NOTE(findings, code) {
	const hit = (findings || []).find((f) => f.code === code);
	return hit ? hit.title + " :: " + String(hit.detail || "").split("\n").slice(0, 6).join(" / ") : "";
}

async function getJson(path) {
	const res = await fetch(base + path, { signal: AbortSignal.timeout(12000) });
	return res.json();
}

async function postJson(path, body) {
	const res = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(180000)
	});
	return res.json();
}

/* ① 运行中的代码：必须是重启后加载的、且包含 lib/inject.js（30 个文件） */
let health;
try {
	health = await getJson("/health");
} catch (e) {
	console.error("连不上 " + base + " —— 端口对吗？（用 --port 指定）");
	process.exit(1);
}
console.log("· 构建：" + health.build);
console.log("· 运行中的代码：" + (health.code && health.code.line));
record(Boolean(health.code && health.code.fresh), "运行中的代码与磁盘一致（不是半新半旧）", health.code && health.code.line);
/* /health 的 code 只回摘要字段（digest 是字符串，不是对象），文件数只能从 line 里读 */
record(Boolean(health.code && /(\d+) 个文件/.test(health.code.line || "") && Number(/(\d+) 个文件/.exec(health.code.line)[1]) >= 30), "指纹覆盖了 lib/inject.js（≥30 个文件）", health.code && health.code.line);

if (noInstall) {
	const failed = results.filter((r) => !r.ok).length;
	console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项不符"));
	process.exit(failed === 0 ? 0 : 1);
}

/* ② 提交 → 可能需要确认 → 等任务结束 */
const submitted = await postJson("/submit", { input: pluginPath });
record(Boolean(submitted && submitted.ok), "提交被受理", submitted && (submitted.message || submitted.reason));
const jobId = submitted && submitted.job && submitted.job.id;
if (!jobId) {
	console.log("没有拿到任务 id，后续无法验证");
	process.exit(1);
}

const precheck = (submitted.job && submitted.job.precheck) || null;
if (precheck) {
	const injectWarn = (precheck.reasons || []).some((r) => /服务声明/.test(r.text || ""));
	record(!injectWarn, "预检没有「服务声明契约」提醒（源码已补 inject）", (precheck.reasons || []).map((r) => r.level + ":" + r.text).join(" | "));
}

async function waitJob(id, timeoutMs = 240000) {
	const started = Date.now();
	let last = null;
	while (Date.now() - started < timeoutMs) {
		const state = await getJson("/state");
		const job = (state.jobs || []).find((j) => j.id === id);
		if (job) last = job;
		if (job && job.status === "awaiting-confirm" && autoYes) {
			await postJson("/action", { action: "confirm", id });
			console.log("· 已自动确认（--yes）");
		}
		if (job && ["done", "failed", "cancelled"].includes(job.status)) return job;
		if (state.active && state.active.id === id) {
			/* 还在跑 */
		}
		await sleep(1500);
	}
	return last;
}

const job = await waitJob(jobId);
if (!job) {
	console.log("任务没有出现在 /state 里（可能被 prune 掉了）");
	process.exit(1);
}
console.log("\n· 任务 " + job.id + " → " + job.status);
for (const stage of job.stages || []) console.log("   " + stage.label + "[" + stage.status + "] " + String(stage.detail || "").slice(0, 120));

/* ③ 安装回执：分两条路 —— 真的装了（vendor 包名带版本） / 已经装过（noop，也该是 done） */
const install = job.install || {};
const spec = String(install.spec || "");
const installStage = (job.stages || []).find((s) => /安装$/.test(s.label || "")) || {};
record(["done", "failed"].includes(job.status), "任务有终态", job.status);
if (install.noop) {
	record(job.status === "done", "noop 收成 done（不是红色失败）", job.status);
	record(/已经装过/.test(String(installStage.detail || "")), "⑧ 说清「已经装过、本次没改动」", installStage.detail);
	record(Boolean((job.notes || []).some((n) => /already-installed/.test(n))), "任务上留了 already-installed 备注", (job.notes || []).join(" / "));
	record(Boolean(job.diagnosis), "noop 之后照常跑了诊断", job.diagnosis && job.diagnosis.verdict);
} else {
	record(/pkg-[^\\/]+-\d[^\\/]*\.tgz$/.test(spec), "vendor 包名带版本（换了内容也会真替换）", spec);
	record(Boolean(install.ok), "⑧ 安装 ok", install.application || (install.failure && install.failure.title));
	if (install.failure) console.log("   分诊：" + install.failure.kind + " · " + install.failure.title);
}

/* ④ 诊断：ok，且没有「没激活 / 缺 inject」 */
const diag = job.diagnosis || {};
record(diag.verdict === "ok", "⑨ 诊断 ok", (diag.findings || []).map((f) => f.severity + ":" + f.title).join(" | "));

/* ⑤ 全量体检：不该有「行开着但没激活」/「缺 inject」（这两条正是 R13 新增的判据）。
   用 /doctor 而不是 /debug/inventory —— 后者只回前 40 行，看不到靠后的插件。 */
const doctor = await getJson("/doctor").catch(() => null);
const findings = (doctor && doctor.report && doctor.report.findings) || [];
const codes = findings.map((f) => f.code);
record(!codes.includes("plugin-inactive"), "体检里没有「行开着但没激活」的插件", CODE_NOTE(findings, "plugin-inactive"));
record(!codes.includes("inject-contract"), "体检里没有「缺 inject 声明」的插件", CODE_NOTE(findings, "inject-contract"));
const tools = (job.diagnosis && job.diagnosis.inventory) || {};
console.log("· 诊断清单：" + JSON.stringify(tools));

const failed = results.filter((r) => !r.ok).length;
console.log("\n" + (failed === 0 ? "全部通过（" + results.length + " 项）" : failed + " 项不符 / 共 " + results.length + " 项"));
process.exit(failed === 0 ? 0 : 1);
