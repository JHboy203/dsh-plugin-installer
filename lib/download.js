/**
 * download.js — 网络层（宿主进程内，Node 内置 fetch）。
 *
 * 纪律：
 *  · 所有出站请求都有超时与体积上限；
 *  · 下载先落到 `<staging>/dl-*`，绝不写到工作区/插件目录以外；
 *  · 断网/超时一律返回结构化错误，**不抛到流水线外面**（降级由上层决定）。
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const UA = "dsh-plugin-installer/0.1 (+local panel)";
const DEFAULT_TIMEOUT = 20000;
const DOWNLOAD_TIMEOUT = 120000;

function cryptoRandom() {
	// 不引额外依赖：用 Math.random 足够做临时文件名（不含安全语义）
	return Math.random().toString(36).slice(2, 10);
}

export class NetError extends Error {
	constructor(code, message, detail) {
		super(message);
		this.name = "NetError";
		this.code = code;
		this.detail = detail;
	}
}

function requireFetch() {
	if (typeof fetch !== "function") {
		throw new NetError("no-fetch", "宿主进程没有可用的 fetch（Node < 18？）");
	}
	return fetch;
}

function authHeaders(extra = {}) {
	return { "user-agent": UA, accept: "application/json", ...extra };
}

export async function fetchJson(url, options = {}) {
	const f = requireFetch();
	const timeout = options.timeoutMs || DEFAULT_TIMEOUT;
	const headers = authHeaders(options.headers);
	if (options.token) headers.authorization = "Bearer " + options.token;
	let res;
	try {
		res = await f(url, { headers, signal: AbortSignal.timeout(timeout), redirect: "follow" });
	} catch (e) {
		throw new NetError("network", "请求失败：" + String((e && e.message) || e), { url });
	}
	const text = await res.text();
	if (!res.ok) {
		throw new NetError(
			res.status === 404 ? "not-found" : res.status === 403 || res.status === 429 ? "rate-limited" : "http-" + res.status,
			"HTTP " + res.status + "：" + text.slice(0, 300),
			{ url, status: res.status }
		);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new NetError("bad-json", "返回的不是 JSON：" + text.slice(0, 200), { url });
	}
}

function fileNameFrom(url, res) {
	const disposition = res && res.headers ? String(res.headers.get("content-disposition") || "") : "";
	const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
	if (m) {
		try {
			return decodeURIComponent(m[1].replace(/"/g, "")).trim();
		} catch {
			return m[1].trim();
		}
	}
	try {
		const name = basename(new URL(url).pathname);
		return name || "download.bin";
	} catch {
		return "download.bin";
	}
}

/**
 * 流式下载到 dir 下（先写 .part 再改名）。
 * @returns {{path:string, bytes:number, contentType:string, fileName:string}}
 */
export async function downloadToFile(url, dir, options = {}) {
	const f = requireFetch();
	const maxBytes = options.maxBytes || 256 * 1024 * 1024;
	const timeout = options.timeoutMs || DOWNLOAD_TIMEOUT;
	await mkdir(dir, { recursive: true });
	const name = options.fileName || null;
	let res;
	try {
		res = await f(url, {
			headers: { "user-agent": UA, ...(options.headers || {}) },
			signal: AbortSignal.timeout(timeout),
			redirect: "follow"
		});
	} catch (e) {
		throw new NetError("network", "下载失败：" + String((e && e.message) || e), { url });
	}
	if (!res.ok) {
		throw new NetError("http-" + res.status, "下载返回 HTTP " + res.status, { url, status: res.status });
	}
	const contentType = String(res.headers.get("content-type") || "");
	const declared = Number(res.headers.get("content-length") || 0);
	if (declared > maxBytes) {
		throw new NetError("too-big", "文件过大（" + Math.round(declared / 1048576) + " MiB > 上限 " + Math.round(maxBytes / 1048576) + " MiB）", { declared });
	}
	const fileName = name || fileNameFrom(url, res);
	const target = join(dir, "dl-" + cryptoRandom() + "-" + sanitizeName(fileName));
	const part = target + ".part";
	const out = createWriteStream(part);
	let bytes = 0;
	try {
		if (res.body) {
			for await (const chunk of res.body) {
				bytes += chunk.length;
				if (bytes > maxBytes) {
					throw new NetError("too-big", "下载超出体积上限（" + Math.round(maxBytes / 1048576) + " MiB）", { bytes });
				}
				if (!out.write(chunk)) {
					await new Promise((resolve) => out.once("drain", resolve));
				}
			}
		} else {
			const buf = Buffer.from(await res.arrayBuffer());
			bytes = buf.length;
			if (bytes > maxBytes) throw new NetError("too-big", "下载超出体积上限", { bytes });
			out.write(buf);
		}
		await new Promise((resolve, reject) => {
			out.end((err) => (err ? reject(err) : resolve()));
		});
		await rename(part, target);
	} catch (e) {
		out.destroy();
		await rm(part, { force: true }).catch(() => {});
		if (e instanceof NetError) throw e;
		throw new NetError("download-failed", "写盘失败：" + String((e && e.message) || e), { url });
	}
	if (/text\/html/i.test(contentType) && /\.(zip|tgz|tar\.gz|7z)$/i.test(fileName)) {
		await rm(target, { force: true }).catch(() => {});
		throw new NetError("html-instead", "这个直链返回的是网页（可能要登录或链接已失效），不是压缩包", { contentType });
	}
	return { path: target, bytes, contentType, fileName };
}

function sanitizeName(name) {
	return String(name)
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120) || "download.bin";
}

/* ── GitHub ───────────────────────────────────────────────────────────── */

export function githubToken() {
	return process.env.DSH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

const repoCache = new Map();

export async function githubRepo(owner, repo) {
	const key = owner + "/" + repo;
	const hit = repoCache.get(key);
	if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
	const value = await fetchJson("https://api.github.com/repos/" + key, { token: githubToken() });
	repoCache.set(key, { at: Date.now(), value });
	return value;
}

function isInstallerAsset(name) {
	return /\.(exe|msi|msix|dmg|pkg|deb|rpm|appimage|apk|jar|blockmap|sig|sha256|sha512|asc)$/i.test(name);
}

/**
 * 把 GitHub 描述符解析成「一个可下载的归档」。
 * 优先 Release 里的归档资产；没有就退回源码 tarball。
 */
export async function resolveGithub(desc) {
	const notes = [];
	let repoInfo = null;
	try {
		repoInfo = await githubRepo(desc.owner, desc.repo);
	} catch (e) {
		notes.push("仓库信息读取失败（" + (e.code || "network") + "），退回源码归档");
	}
	const ref = desc.ref || (repoInfo && repoInfo.default_branch) || null;
	const meta = repoInfo
		? {
			fullName: repoInfo.full_name,
			description: repoInfo.description,
			stars: repoInfo.stargazers_count,
			defaultBranch: repoInfo.default_branch,
			license: repoInfo.license && repoInfo.license.spdx_id,
			archived: repoInfo.archived
		}
		: null;

	// Release 资产（只看 latest / 指定的 tag）
	let assets = [];
	try {
		const releaseUrl = desc.tag
			? "https://api.github.com/repos/" + desc.owner + "/" + desc.repo + "/releases/tags/" + encodeURIComponent(desc.tag)
			: "https://api.github.com/repos/" + desc.owner + "/" + desc.repo + "/releases/latest";
		const release = await fetchJson(releaseUrl, { token: githubToken(), timeoutMs: 12000 });
		assets = Array.isArray(release.assets) ? release.assets : [];
		if (release.tag_name) notes.push("Release：" + release.tag_name);
	} catch (e) {
		if (e.code !== "not-found") notes.push("Release 查询失败（" + (e.code || "network") + "）");
	}

	const usable = assets.filter((a) => a && a.name && !isInstallerAsset(a.name) && /\.(zip|tgz|tar\.gz)$/i.test(a.name));
	const preferred = usable.find((a) => /(source|src|dsh|plugin|skill|bundle)/i.test(a.name)) || usable[0];
	if (preferred && preferred.browser_download_url) {
		notes.push("选用 Release 资产：" + preferred.name);
		return {
			url: preferred.browser_download_url,
			fileName: preferred.name,
			kind: "release-asset",
			meta,
			notes
		};
	}
	if (assets.length > 0) {
		notes.push("Release 里没有可用的 .zip/.tgz 资产（" + assets.map((a) => a.name).slice(0, 4).join(", ") + "）");
	}
	if (!ref) {
		throw new NetError("no-ref", "拿不到默认分支，无法下载源码归档", { owner: desc.owner, repo: desc.repo });
	}
	const url = "https://codeload.github.com/" + desc.owner + "/" + desc.repo + "/tar.gz/refs/heads/" + encodeURIComponent(ref);
	notes.push("下载源码归档：" + ref);
	return { url, fileName: desc.repo + "-" + ref + ".tar.gz", kind: "source-archive", meta, notes };
}

/**
 * 把 npm spec 解析成「能下载来扫一遍」的 tarball。
 * 支持 name / name@version / @scope/name@range。
 */
export async function resolveNpmSpec(spec) {
	const text = String(spec || "").trim();
	const at = text.lastIndexOf("@");
	const name = at > 0 ? text.slice(0, at) : text;
	const wanted = at > 0 ? text.slice(at + 1) : "latest";
	if (!name) throw new NetError("bad-spec", "npm spec 缺少包名");
	const registry = "https://registry.npmjs.org/" + encodeURIComponent(name).replace(/^%40/, "@").replace("%2F", "%2f");
	const data = await fetchJson(registry, { timeoutMs: 15000 });
	const tags = data["dist-tags"] || {};
	let version = tags[wanted] || null;
	if (!version && data.versions && data.versions[wanted]) version = wanted;
	if (!version) version = tags.latest || null;
	if (!version) throw new NetError("no-version", "npm 上找不到可安装版本：" + name);
	const entry = data.versions && data.versions[version];
	const tarball = entry && entry.dist && entry.dist.tarball;
	if (!tarball) throw new NetError("no-tarball", "registry 没给出 tarball 地址：" + name + "@" + version);
	return {
		name,
		version,
		tarball,
		description: (entry && entry.description) || data.description || null,
		peerDependencies: (entry && entry.peerDependencies) || {},
		engines: (entry && entry.engines) || {}
	};
}

/* ── 搜索已迁走（R3 → R5 清理）───────────────────────────────────────────
 * 以前的 searchNpm / searchGitHub 只查两个源、而且不带 trust / popularity。
 * 现在统一走 lib/sources.js 的 searchAll（6 个源 + TTL 缓存），这两个函数已无调用方，
 * 留着只会让下一个人以为「搜索还在这」。要加源/改判据，去 sources.js。
 */

export async function fileSize(path) {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}
