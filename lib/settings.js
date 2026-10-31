/**
 * settings.js — 面板个性化设置（R6）。
 *
 * 三条设计原则（别改）：
 *  1. **默认值 = 现在的行为**。任何一项不改，面板跑起来要和 R5.1 一模一样；
 *     这样才能说「默认档就是标准版」。
 *  2. **只认白名单 + 夹取**。用户手改 settings.json 写坏了不该让面板炸：
 *     未知键丢弃、非法值回退默认、数值落回最近的合法项。
 *  3. **设置只影响「停下来问你」与「提醒」，不放松真判据**。
 *     审核关掉也仍然阻断：profile / 无法识别 / 版本不兼容 / bundle 不完整。
 */
import { readFile, rename, writeFile } from "node:fs/promises";

export const REVIEW_LEVELS = ["strict", "normal", "off"];
export const LEVEL_LABELS = { strict: "严格", normal: "普通", off: "关闭" };

/** R41：AI 推荐的广度档（三档；**standard = R40 的行为**，所以默认档不变）。 */
export const AI_BREADTH = ["standard", "wide", "max"];
export const AI_BREADTH_LABELS = { standard: "标准", wide: "广", max: "很广" };

/**
 * R43/R44：推荐条数是「自定义」的 —— 6~25 的任意整数（6/15/25 只是面板上的快捷档）。
 * 下限 6 / 上限 25 是 2026-10-31 用户指定的：最少 6 条才算「有得挑」；
 * 上限 25 是因为 max 广度下一共只送 36 个候选进模型（16+8+12），再多只能重复或凑数。
 */
export const AI_PICKS_MIN = 6;
export const AI_PICKS_MAX = 25;
export const AI_PICKS_PRESETS = [6, 15, 25];
/**
 * 每档具体是多少。三个数字分开管，是因为它们解决的是不同的事：
 *  · `search`  —— 先问每个源多要几条（决定**池子**有多宽）
 *  · `perKind` —— 每类最多送几条进模型（决定**模型看见多少**，见 R40 的截断事故）
 *  · `maxChars` / `skillScan` —— 预算与扫描上限（防止「更广」变成「更慢更贵」）
 */
export const AI_BREADTH_PRESETS = {
	standard: {
		search: { plugin: 12, mcp: 4, skill: 6 },
		perKind: { plugin: 8, mcp: 4, skill: 4 },
		maxChars: 12000,
		skillScan: 40
	},
	wide: {
		search: { plugin: 18, mcp: 6, skill: 10 },
		perKind: { plugin: 12, mcp: 6, skill: 8 },
		maxChars: 16000,
		skillScan: 60
	},
	max: {
		search: { plugin: 24, mcp: 8, skill: 16 },
		perKind: { plugin: 16, mcp: 8, skill: 12 },
		maxChars: 22000,
		skillScan: 80
	}
};

/** 默认档 = 标准版本（= R5.1 的现有行为）。 */
export const DEFAULTS = {
	/* 提醒 */
	redDot: true, // 侧栏图标红点
	sound: false, // 消息声音
	desktopPopup: false, // 桌面弹窗（浏览器 Notification）
	/* 审核 */
	reviewLevel: "normal", // strict | normal | off
	skipReview: true, // 允许「跳过审核，直接安装」按钮（点了还要二次确认）
	/* 界面与性能 */
	pollMs: 2500, // 面板打开时的轮询间隔
	historyLimit: 8, // 历史列表显示条数
	snapshotKeep: 40, // 保留最近多少份快照
	/* AI 推荐（R41/R43/R44）—— 条数自定义（6~25），默认 6 */
	aiPicks: 6, // 最多给几条推荐（R43/R44：6~25 的任意整数）
	aiBreadth: "standard", // standard | wide | max —— 决定每类送多少候选进模型
	/* 搜索来源（关掉可以少发请求 / 避免限流） */
	sources: { npm: true, github: true, hub: true }
};

export const CHOICES = {
	pollMs: [2500, 5000, 10000],
	historyLimit: [5, 8, 20],
	snapshotKeep: [20, 40, 80],
	aiPicks: AI_PICKS_PRESETS // R43/R44：这三项只是面板上的快捷档，条数本身是 6~25 的自定义整数
};

/**
 * 把设置翻译成「这一轮 AI 推荐到底取多少」。
 * 纯函数：面板、宿主、自检读的是同一份口径（别再在别处写第二套数字）。
 */
export function aiLimits(settings) {
	const s = normalizeSettings(settings);
	const preset = AI_BREADTH_PRESETS[s.aiBreadth] || AI_BREADTH_PRESETS.standard;
	/* R43/R44：条数不再只认三档 —— normalizeSettings 已夹到 6~25，这里直接用它 */
	const picks = s.aiPicks;
	return {
		picks,
		breadth: s.aiBreadth,
		breadthLabel: AI_BREADTH_LABELS[s.aiBreadth] || s.aiBreadth,
		search: { ...preset.search },
		perKind: { ...preset.perKind },
		maxChars: preset.maxChars,
		skillScan: preset.skillScan
	};
}

const BOOL_KEYS = ["redDot", "sound", "desktopPopup", "skipReview"];

/** 落到数组里最近的合法值（写坏了不至于让面板不能用）。 */
function nearest(value, allowed, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	if (allowed.includes(n)) return n;
	return allowed.reduce((best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best), fallback);
}

/**
 * 把任意输入整理成合法设置。未知键丢弃，非法值回退默认。
 * @param {object} raw
 * @returns {typeof DEFAULTS}
 */
export function normalizeSettings(raw) {
	const out = {
		...DEFAULTS,
		sources: { ...DEFAULTS.sources }
	};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const key of BOOL_KEYS) {
		if (typeof raw[key] === "boolean") out[key] = raw[key];
	}
	if (REVIEW_LEVELS.includes(raw.reviewLevel)) out.reviewLevel = raw.reviewLevel;
	out.pollMs = nearest(raw.pollMs, CHOICES.pollMs, DEFAULTS.pollMs);
	out.historyLimit = nearest(raw.historyLimit, CHOICES.historyLimit, DEFAULTS.historyLimit);
	out.snapshotKeep = nearest(raw.snapshotKeep, CHOICES.snapshotKeep, DEFAULTS.snapshotKeep);
	/* R43/R44：AI 推荐 —— 条数是 6~25 的任意整数（6/15/25 只是快捷档），
	   手改文件写坏了（NaN）回默认、越界夹到边上（0 → 6、99 → 25）；
	   广度仍只认三档（写坏了回标准，不让它变成「无限」） */
	if (raw.aiPicks !== undefined && raw.aiPicks !== null) {
		const picks = Math.round(Number(raw.aiPicks));
		if (Number.isFinite(picks)) out.aiPicks = Math.min(AI_PICKS_MAX, Math.max(AI_PICKS_MIN, picks));
	}
	if (AI_BREADTH.includes(raw.aiBreadth)) out.aiBreadth = raw.aiBreadth;
	if (raw.sources && typeof raw.sources === "object" && !Array.isArray(raw.sources)) {
		for (const key of Object.keys(DEFAULTS.sources)) {
			if (typeof raw.sources[key] === "boolean") out.sources[key] = raw.sources[key];
		}
		/* 至少要留一个源：全关掉的话搜索永远空，看起来像坏了 */
		if (!out.sources.npm && !out.sources.github && !out.sources.hub) out.sources = { ...DEFAULTS.sources };
	}
	return out;
}

/** 合并一次补丁（面板每次改一项就发一次）。 */
export function mergeSettings(current, patch) {
	const base = normalizeSettings(current);
	if (!patch || typeof patch !== "object") return base;
	const merged = { ...base, ...patch };
	if (patch.sources && typeof patch.sources === "object") {
		merged.sources = { ...base.sources, ...patch.sources };
	}
	return normalizeSettings(merged);
}

/** 一行摘要：工具输出与面板头部都用它。 */
export function describeSettings(settings) {
	const s = normalizeSettings(settings);
	const onOff = (v) => (v ? "开" : "关");
	const src = [s.sources.npm ? "npm" : null, s.sources.github ? "GitHub" : null, s.sources.hub ? "商店" : null]
		.filter(Boolean)
		.join("/");
	return (
		"红点" + onOff(s.redDot) +
		" · 声音" + onOff(s.sound) +
		" · 弹窗" + onOff(s.desktopPopup) +
		" · 审核" + (LEVEL_LABELS[s.reviewLevel] || s.reviewLevel) +
		" · 跳过审核按钮" + onOff(s.skipReview) +
		" · 轮询 " + s.pollMs / 1000 + "s" +
		" · 历史 " + s.historyLimit +
		" · 快照留 " + s.snapshotKeep +
		" · AI 推荐 " + s.aiPicks + " 条 / 广度 " + (AI_BREADTH_LABELS[s.aiBreadth] || s.aiBreadth) +
		" · 源 " + src
	);
}

/** 读设置；文件不存在/读坏都回默认（绝不抛）。 */
export async function loadSettings(file) {
	try {
		const text = await readFile(file, "utf8");
		return normalizeSettings(JSON.parse(text));
	} catch {
		return normalizeSettings({});
	}
}

/**
 * 原子写（先写唯一 tmp 再 rename），失败不抛 —— 设置写不进去不该让面板挂掉。
 * R9：tmp 名带上 pid + 序号。settings.json 也会被面板的连续改设置并发写，
 * 固定 `.tmp` 会让后一次 rename 撞 ENOENT（同一个坑，只是后果轻些）。
 */
let settingsSeq = 0;

/**
 * rename 重试：Windows 上两个 rename 同时指向同一目标会撞 EPERM（不是 ENOENT），
 * 杀软短暂持有句柄也会。都是瞬时错误，退让一下重试即可。
 * （与 lib/pipeline.js 里的同名逻辑同因；分开放是为了不制造 settings ↔ pipeline 的循环依赖。）
 */
const TRANSIENT_RENAME = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(from, to, attempts = 4) {
	let lastError = null;
	for (let i = 0; i < attempts; i += 1) {
		try {
			await rename(from, to);
			return true;
		} catch (e) {
			lastError = e;
			if (!e || !TRANSIENT_RENAME.has(e.code)) throw e;
			await new Promise((resolve) => setTimeout(resolve, 40 * (i + 1)));
		}
	}
	throw lastError;
}

export async function saveSettings(file, settings) {
	const payload = JSON.stringify(normalizeSettings(settings), null, 2);
	settingsSeq += 1;
	const tmp = file + "." + process.pid + "." + settingsSeq + ".tmp";
	try {
		await writeFile(tmp, payload, "utf8");
		await renameWithRetry(tmp, file);
		return true;
	} catch {
		return false;
	}
}
