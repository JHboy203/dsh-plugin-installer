/**
 * dev/probe-asset-pick.mjs —— Release 多资产时「选哪一个」的只读探针（R50）。
 *
 * 为什么要有它：2026-11-07 用户装 `woniuniuniu/dsh-media-desk` 时，Release 里有两个资产
 * （`-with-install-guide.zip` 与 `.tgz`），旧规则只看「名字里有没有 dsh」，两个都命中，
 * 于是拿了 GitHub 返回的第一个（套壳 zip）→ 解出来是「说明 + 内层包」→ 判未识别 → 卡在「已转人工确认」。
 *
 * 这个探针**只调 GitHub API 看 resolveGithub 选了哪个资产**：不下载、不安装、不写盘。
 *   node dev/probe-asset-pick.mjs                 # 默认查用户踩过的那个仓库
 *   node dev/probe-asset-pick.mjs owner/repo ...  # 换成别的仓库
 *
 * 判据：选了「带 install-guide 的套壳包」而候选里明明有 `.tgz` → FAIL。
 */
import { resolveGithub } from "../lib/download.js";

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["woniuniuniu/dsh-media-desk"];
let failed = 0;

for (const spec of targets) {
	const [owner, repo] = String(spec).split("/");
	if (!owner || !repo) {
		console.log("FAIL 参数要写成 owner/repo：" + spec);
		failed += 1;
		continue;
	}
	try {
		const r = await resolveGithub({ kind: "github-repo", owner, repo });
		const picked = String(r.fileName || r.url || "");
		const alts = (r.alternatives || []).map((a) => a.name).filter(Boolean);
		console.log("· " + owner + "/" + repo + " → " + picked + (alts.length > 0 ? "（候选：" + alts.join("、") + "）" : ""));
		const pickedIsGuide = /install-?guide|说明/i.test(picked);
		const hasTgz = alts.some((n) => /\.tgz$/i.test(n)) || /\.tgz$/i.test(picked);
		if (pickedIsGuide && hasTgz) {
			console.log("FAIL 仍然选了套壳包，而候选里有 .tgz");
			failed += 1;
		} else {
			console.log("PASS 选的是能直接装的那个（没有优先套壳包）");
		}
	} catch (e) {
		console.log("FAIL " + owner + "/" + repo + " 解析失败：" + ((e && e.message) || e));
		failed += 1;
	}
}

console.log(failed === 0 ? "\nSUMMARY probe passed" : "\nSUMMARY " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
