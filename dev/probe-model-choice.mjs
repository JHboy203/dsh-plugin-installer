/**
 * dev/probe-model-choice.mjs — R48「AI 模型自选」的离线探针（不是全量自检）。
 *
 * 为什么单独一个：改完 `lib/ai.js` / `lib/models.js` / `lib/settings.js` 之后，
 * 全量 `dev/hosttest.mjs` 要跑一千多项；这一条只打「模型选择」这一条链：
 *
 *   设置归一化（写坏 = 跟随默认） → 选择优先级（自选 > DSH 默认）
 *   → askLlm 真的用那个模型 → 审查结果记下模型与来源
 *   → 模型目录（一个 provider 失败不拖垮整张表 / 卡死会被超时掐掉）
 *   → 接线（/models、/onboarding、首次引导的文案）
 *
 * 全程离线：假 ctx、假 llm、不联网、不写盘、不花 token。
 *
 *   node DSH-Plugin/dsh-plugin-installer/dev/probe-model-choice.mjs
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, mergeSettings, normalizeAiModel, normalizeSettings } from "../lib/settings.js";
import { askLlm, createReviewer, resolveSelection } from "../lib/ai.js";
import { describeModelCatalog, listLlmModels } from "../lib/models.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let passed = 0;
const failed = [];

function ok(name, condition, extra) {
	if (condition) {
		passed += 1;
		console.log("PASS " + name);
	} else {
		failed.push(name);
		console.log("FAIL " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra)));
	}
}
function eq(name, actual, expected) {
	ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const CUSTOM = { provider: "my-p", model: "my-m" };
const DEFAULT = { provider: "def-p", model: "def-m" };

function ctxOf(models = {}) {
	const calls = [];
	const ctx = {
		agentDefaultModel: { currentSelection: () => ({ ...DEFAULT }) },
		llm: {
			stream: async function* (options) {
				calls.push({ provider: options.provider, model: options.model });
				yield { type: "text-delta", text: "{\"verdict\":\"safe\",\"findings\":[]}" };
				yield { type: "finish", reason: { kind: "stop" } };
			},
			listProviders: () => models.providers || [],
			listModels: models.listModels || (async () => [])
		}
	};
	return { ctx, calls };
}

/* ① 设置归一化：写坏 = 跟随默认；合法值只留两个字段 */
eq("设置：默认 aiModel 是 null（跟随 DSH 默认）", normalizeSettings({}).aiModel, null);
eq("设置：合法自选去空白并丢掉多余字段",
	normalizeAiModel({ provider: " p ", model: " m ", name: "x" }), { provider: "p", model: "m" });
eq("设置：缺一半 / 非对象 / 空串都退回 null",
	[normalizeAiModel({ provider: "p" }), normalizeAiModel("p/m"), normalizeAiModel({ provider: "p", model: "" })],
	[null, null, null]);
eq("设置：mergeSettings 可以把自选清回默认",
	mergeSettings({ ...DEFAULTS, aiModel: CUSTOM }, { aiModel: null }).aiModel, null);

/* ② 优先级：自选 > DSH 默认；都没有 = null（面板要能说「没有可用模型」） */
eq("选择：没自选用 DSH 默认", resolveSelection({ agentDefaultModel: { currentSelection: () => DEFAULT } }, DEFAULTS),
	{ ...DEFAULT, source: "default" });
eq("选择：有自选用自选", resolveSelection({ agentDefaultModel: { currentSelection: () => DEFAULT } }, { ...DEFAULTS, aiModel: CUSTOM }),
	{ ...CUSTOM, source: "custom" });
eq("选择：两边都没有 → null", resolveSelection({ agentDefaultModel: { currentSelection: () => null } }, DEFAULTS), null);

/* ③ askLlm 真的把 provider/model 交给宿主；换自选不用重启 */
const { ctx, calls } = ctxOf();
const outCustom = await askLlm(ctx, { system: "s", user: "u", settings: { ...DEFAULTS, aiModel: CUSTOM } });
eq("askLlm：自选模型被真的用上", [calls[0], outCustom.model, outCustom.modelSource], [CUSTOM, "my-p/my-m", "custom"]);
const outDefault = await askLlm(ctx, { system: "s", user: "u", settings: DEFAULTS });
eq("askLlm：没自选时跟随默认", [calls[1], outDefault.model, outDefault.modelSource], [DEFAULT, "def-p/def-m", "default"]);
const noModelError = await askLlm({ llm: { stream: async function* () {} } }, { settings: DEFAULTS })
	.then(() => null, (e) => e.message);
ok("askLlm：没有默认也没有自选 → 明确报错（不猜模型）",
	/没有设置默认模型/.test(String(noModelError)) && /自选模型/.test(String(noModelError)), noModelError);

/* ④ 审查：结果里记录模型与来源；选中的模型不可用时写清「本来是哪个」 */
const job = {
	id: "probe",
	title: "x",
	precheck: {
		risks: { hits: [{ kind: "child-process", severity: "high", file: "a.js", line: 1, excerpt: "spawn" }], scripts: [{ name: "postinstall", command: "node x" }], combos: [] },
		needsAiReview: true
	},
	detected: { name: "x", kind: "bundle", version: "1.0.0", hasClient: false }
};
const reviewed = await createReviewer({ ctx })(job, { ...DEFAULTS, aiModel: CUSTOM });
eq("审查：结果带自选模型与来源", [reviewed.status, reviewed.model, reviewed.modelSource], ["done", "my-p/my-m", "custom"]);
const failedCtx = { llm: { stream: async function* () { throw new Error("unknown provider"); } }, agentDefaultModel: { currentSelection: () => null } };
const failedReview = await createReviewer({ ctx: failedCtx })(job, { ...DEFAULTS, aiModel: { provider: "gone", model: "gone-m" } });
eq("审查：失败时也说清本来是哪个模型", [failedReview.status, failedReview.model, failedReview.modelSource], ["failed", "gone/gone-m", "custom"]);

/* ⑤ 模型目录：坏的只标自己、空列表是 0、卡死被超时掐掉 */
const catalog = await listLlmModels({
	llm: {
		stream: async function* () {},
		listProviders: () => [{ id: "good", name: "Good" }, { id: "bad", name: "Bad" }, { id: "none", name: "None" }],
		listModels: async (provider) => {
			if (provider === "bad") throw new Error("401 密钥无效");
			if (provider === "none") return [];
			return [{ id: "m1", name: "M1" }];
		}
	}
}, { timeoutMs: 200 });
eq("目录：ok / 数量 / provider 数", [catalog.ok, catalog.count, catalog.providers.length], [true, 1, 3]);
eq("目录：坏的 provider 只标自己", catalog.providers.find((p) => p.id === "bad").ok, false);
ok("目录：错误原因如实带回", /401/.test(catalog.providers.find((p) => p.id === "bad").error));
ok("目录：摘要能读", /模型 1 个/.test(describeModelCatalog(catalog)), describeModelCatalog(catalog));
const hung = await listLlmModels({
	llm: {
		stream: async function* () {},
		listProviders: () => [{ id: "hang", name: "Hang" }],
		listModels: () => new Promise(() => {})
	}
}, { timeoutMs: 60 });
ok("目录：卡死的 provider 被硬超时掐掉", hung.providers[0].ok === false && /超时/.test(hung.providers[0].error), hung.providers[0]);
const noLlm = await listLlmModels({});
ok("目录：没有 llm 服务时 ok=false（不是「没有模型」）", noLlm.ok === false && /llm/.test(noLlm.error), noLlm);

/* ⑥ 接线与文案：三条路缺一条，新功能就是死的 */
const indexSrc = await readFile(join(root, "index.js"), "utf8");
ok("接线：/models 与 /onboarding 路由都在",
	indexSrc.includes('path === "/models"') && indexSrc.includes('path === "/onboarding"'));
const clientSrc = await readFile(join(root, "client.js"), "utf8");
ok("面板：设置里有 AI 模型区，且能自选", /AI 模型/.test(clientSrc) && /ModelPicker/.test(clientSrc) && /自选模型/.test(clientSrc));
ok("面板：首次打开有引导，并说清用途",
	/function ModelGuide/.test(clientSrc) && /AI 语义审查/.test(clientSrc) && /api\("\/onboarding"/.test(clientSrc));
ok("面板：引导只出现一次（有 firstRun 判据）", /onboarding\.firstRun/.test(clientSrc) && /guideClosed/.test(clientSrc));
const pipelineSrc = await readFile(join(root, "lib", "pipeline.js"), "utf8");
ok("接线：审查时传的是「此刻的设置」（改模型不用重启）", /reviewer\(job, this\.settings\)/.test(pipelineSrc));

console.log("");
console.log("SUMMARY " + passed + " passed, " + failed.length + " failed, " + (passed + failed.length) + " total");
if (failed.length > 0) process.exitCode = 1;
