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
	/* 搜索来源（关掉可以少发请求 / 避免限流） */
	sources: { npm: true, github: true, hub: true }
};

export const CHOICES = {
	pollMs: [2500, 5000, 10000],
	historyLimit: [5, 8, 20],
	snapshotKeep: [20, 40, 80]
};

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

/** 原子写（先写 .tmp 再 rename），失败不抛 —— 设置写不进去不该让面板挂掉。 */
export async function saveSettings(file, settings) {
	const payload = JSON.stringify(normalizeSettings(settings), null, 2);
	const tmp = file + ".tmp";
	try {
		await writeFile(tmp, payload, "utf8");
		await rename(tmp, file);
		return true;
	} catch {
		return false;
	}
}
