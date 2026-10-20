/**
 * urls.js — 输入分类（纯函数，不联网，可单测）。
 *
 * 面板收到的一律是「一段文本」或「一个本地文件」。这里只判断**它是什么**，
 * 不做任何 IO（本地路径是否存在由调用方 stat 后补 kind）。
 */
import { extname } from "node:path";

const ARCHIVE_EXT = [".zip", ".tgz", ".tar.gz", ".tar", ".7z", ".rar", ".gz"];

const NETDISK = [
	[/(^|\.)pan\.baidu\.com$/i, "百度网盘"],
	[/(^|\.)aliyundrive\.com$/i, "阿里云盘"],
	[/(^|\.)alipan\.com$/i, "阿里云盘"],
	[/(^|\.)123pan\.com$/i, "123 云盘"],
	[/(^|\.)lanzou[a-z]*\.com$/i, "蓝奏云"],
	[/(^|\.)quark\.cn$/i, "夸克网盘"],
	[/(^|\.)weiyun\.com$/i, "腾讯微云"],
	[/(^|\.)caiyun\.139\.com$/i, "移动云盘"],
	[/(^|\.)115\.com$/i, "115 网盘"],
	[/(^|\.)189\.cn$/i, "天翼云盘"],
	[/(^|\.)drive\.google\.com$/i, "Google Drive"],
	[/(^|\.)mega\.nz$/i, "MEGA"],
	[/(^|\.)dropbox\.com$/i, "Dropbox"],
	[/(^|\.)1drv\.ms$/i, "OneDrive"],
	[/(^|\.)jianguoyun\.com$/i, "坚果云"]
];

function stripHash(url) {
	return String(url).split("#")[0];
}

function pathOf(url) {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}

function hasArchiveExt(pathname) {
	const lower = pathname.toLowerCase();
	return ARCHIVE_EXT.some((ext) => lower.endsWith(ext));
}

export function netdiskProvider(url) {
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return null;
	}
	for (const [re, label] of NETDISK) {
		if (re.test(host)) return label;
	}
	return null;
}

/**
 * @param {string} raw 用户输入
 * @returns {object} 描述符：{kind, raw, url?, owner?, repo?, ref?, subdir?, label, hint?}
 */
export function classifyInput(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return { kind: "empty", raw: text, label: "空输入" };

	// 本地路径：盘符 / UNC / 以 . 开头 / 含反斜杠
	if (/^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text) || /^\.{1,2}[\\/]/.test(text)) {
		return { kind: "local-path", raw: text, path: text, label: "本地路径" };
	}

	// 不是 URL、不是路径 → 当成「名称/关键词」，交给搜索（"视频下载"、"dsh-ffmpeg" 都走这条）
	if (!/^[a-z]+:\/\//i.test(text) && !text.startsWith("github:") && !text.startsWith("gh:") && !text.startsWith("npm:")) {
		if (text.length <= 120) {
			return { kind: "name", raw: text, name: text, label: "关键词：" + text };
		}
		return { kind: "unrecognized", raw: text, label: "输入太长，既不像链接也不像名字：" + text.slice(0, 60) };
	}

	let url = stripHash(text);
	if (url.startsWith("github:")) url = "https://github.com/" + url.slice("github:".length);
	if (url.startsWith("gh:")) url = "https://github.com/" + url.slice(3);
	if (url.startsWith("npm:")) {
		return { kind: "npm-spec", raw: text, spec: text, label: "npm：" + text.slice(4) };
	}
	if (url.startsWith("git@github.com:")) {
		const m = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
		if (m) return { kind: "github-repo", raw: text, url, owner: m[1], repo: m[2], ref: null, subdir: null, label: m[1] + "/" + m[2] };
	}

	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return { kind: "unrecognized", raw: text, label: "无法识别：" + text.slice(0, 60) };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { kind: "unrecognized", raw: text, label: "只支持 http(s) 链接" };
	}

	const disk = netdiskProvider(url);
	if (disk) {
		return {
			kind: "netdisk",
			raw: text,
			url,
			provider: disk,
			label: disk + " 链接",
			hint: "网盘不自动下载：请手动下载后把文件拖进面板，或填写本机绝对路径"
		};
	}

	const host = parsed.hostname.toLowerCase();
	const pathname = parsed.pathname;

	if (host === "github.com" || host === "www.github.com") {
		const parts = pathname.split("/").filter(Boolean);
		if (parts.length >= 2) {
			const owner = parts[0];
			const repo = parts[1].replace(/\.git$/, "");
			if (parts[2] === "releases" && parts[3] === "download") {
				return { kind: "archive-url", raw: text, url, label: owner + "/" + repo + " Release 资产" };
			}
			if (parts[2] === "releases") {
				return { kind: "github-release", raw: text, url, owner, repo, tag: parts[4] && parts[3] === "tag" ? parts[4] : null, label: owner + "/" + repo + " Releases" };
			}
			if (parts[2] === "tree" && parts[3]) {
				return {
					kind: "github-repo",
					raw: text,
					url,
					owner,
					repo,
					ref: decodeURIComponent(parts[3]),
					subdir: parts.slice(4).map(decodeURIComponent).join("/") || null,
					label: owner + "/" + repo + (parts[4] ? " → " + parts.slice(4).join("/") : "")
				};
			}
			if (parts[2] === "archive") {
				return { kind: "archive-url", raw: text, url, label: owner + "/" + repo + " 源码归档" };
			}
			if (parts.length === 2) {
				return { kind: "github-repo", raw: text, url, owner, repo, ref: null, subdir: null, label: owner + "/" + repo };
			}
		}
		return { kind: "github-page", raw: text, url, label: "GitHub 页面（非仓库根）" };
	}

	if (host === "codeload.github.com" || host === "objects.githubusercontent.com" ||
		host === "raw.githubusercontent.com" || host === "github-releases.githubusercontent.com") {
		return { kind: hasArchiveExt(pathname) ? "archive-url" : "unknown-github-file", raw: text, url, label: "GitHub 直链" };
	}

	if (hasArchiveExt(pathname)) {
		return { kind: "archive-url", raw: text, url, label: "压缩包直链（" + extname(pathname) + "）" };
	}

	if (/(^|\.)npmjs\.(com|org)$/i.test(host) || /(^|\.)npmmirror\.com$/i.test(host)) {
		const m = /^\/(?:package\/)?(@?[^/]+(?:\/[^/]+)?)(?:\/v\/([^/]+))?/.exec(pathname);
		if (m) {
			return {
				kind: "npm-spec",
				raw: text,
				url,
				spec: m[1] + (m[2] ? "@" + m[2] : ""),
				label: "npm：" + m[1] + (m[2] ? "@" + m[2] : "")
			};
		}
	}

	return { kind: "web-page", raw: text, url, label: "普通网页（不是压缩包直链）", hint: "面板只认仓库页 / Release / 压缩包直链" };
}

/** 给 UI 的一句话结论。 */
export function describeInput(desc) {
	if (!desc) return "";
	switch (desc.kind) {
		case "github-repo": return "GitHub 仓库：" + desc.label;
		case "github-release": return "GitHub Release：" + desc.label;
		case "archive-url": return desc.label;
		case "netdisk": return desc.label + "（需手动下载）";
		case "local-path": return "本地路径";
		case "npm-spec": return desc.label;
		case "name": return "只有名字，需要先搜索";
		default: return desc.label || desc.kind;
	}
}
