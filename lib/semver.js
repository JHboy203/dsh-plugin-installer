/**
 * semver.js — 只做插件兼容性需要的那部分 semver（零依赖）。
 *
 * 支持：`^ ~ = > >= < <=`、裸版本、`*`/`x` 通配、空格连接的合取、
 * `||` 析取、hyphen range（`1.2.3 - 2.0.0`）。
 * 预发布规则按 npm 惯例：版本带 prerelease 时，只有当范围里**同一
 * major.minor.patch** 也写了 prerelease 才算满足。
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text) {
	const m = VERSION_RE.exec(String(text ?? "").trim());
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] ? m[4].split(".") : [],
		raw: String(text).trim()
	};
}

function cmpIdent(a, b) {
	const na = /^\d+$/.test(a);
	const nb = /^\d+$/.test(b);
	if (na && nb) return Number(a) - Number(b);
	if (na) return -1;
	if (nb) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a, b) {
	const A = typeof a === "string" ? parseVersion(a) : a;
	const B = typeof b === "string" ? parseVersion(b) : b;
	if (!A || !B) throw new Error("invalid version");
	for (const key of ["major", "minor", "patch"]) {
		if (A[key] !== B[key]) return A[key] < B[key] ? -1 : 1;
	}
	if (A.pre.length === 0 && B.pre.length === 0) return 0;
	if (A.pre.length === 0) return 1;
	if (B.pre.length === 0) return -1;
	const n = Math.min(A.pre.length, B.pre.length);
	for (let i = 0; i < n; i += 1) {
		const c = cmpIdent(A.pre[i], B.pre[i]);
		if (c !== 0) return c < 0 ? -1 : 1;
	}
	return A.pre.length === B.pre.length ? 0 : A.pre.length < B.pre.length ? -1 : 1;
}

/**
 * 「落后多少」—— 只用于显示，不参与任何判定。
 *
 * R26：清单上只有 `0.6.24 → 0.6.33` 两个数字时，人看不出这是「跨了 9 个补丁」
 * 还是「跨了一个破坏性大版本」。0.x 的 minor 变化按 npm 惯例可能就是破坏性变更，
 * 所以单独标 severe（面板会把它染成警示色），但仍不拦安装 —— 判断权交回用户。
 *
 * @returns {{text:string, severe:boolean}|null} 不可解析 / 没有落后 → null
 */
export function versionGap(from, to) {
	const a = parseVersion(from);
	const b = parseVersion(to);
	if (!a || !b || compareVersions(a, b) >= 0) return null;
	if (a.major !== b.major) return { text: "主版本 " + a.major + " → " + b.major, severe: true };
	if (a.minor !== b.minor) {
		const n = b.minor - a.minor;
		return { text: "跨 " + n + " 个小版本", severe: a.major === 0 };
	}
	const n = b.patch - a.patch;
	return n > 0 ? { text: "跨 " + n + " 个补丁", severe: false } : { text: "", severe: false };
}

function bump(v, part) {
	const out = { major: v.major, minor: v.minor, patch: v.patch, pre: [] };
	if (part === "major") {
		out.major += 1;
		out.minor = 0;
		out.patch = 0;
	} else if (part === "minor") {
		out.minor += 1;
		out.patch = 0;
	} else {
		out.patch += 1;
	}
	return out;
}

/** 宽松解析：允许 `20` / `1.2` 这种省略位（按 npm 的 x-range 语义补齐 0）。 */
function looseVersion(text) {
	const t = String(text ?? "").trim();
	if (/^\d+$/.test(t)) return { major: Number(t), minor: 0, patch: 0, pre: [], raw: t };
	if (/^\d+\.\d+$/.test(t)) {
		const [a, b] = t.split(".");
		return { major: Number(a), minor: Number(b), patch: 0, pre: [], raw: t };
	}
	return parseVersion(t);
}

/** 把单个 token 展开成若干 {op, version|null} 比较子。 */
function expandToken(token) {
	const t = String(token).trim();
	if (t === "" || t === "*" || t === "x" || t === "X") return [];
	const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(t);
	if (!m) return null;
	const op = m[1] || "=";
	const rest = m[2].trim();

	// 通配（只在没有显式操作符时）：1.x / 1.2.x / 1.* / 裸 "1" / 裸 "1.2"
	const bare = op === "=" && (rest.includes("x") || rest.includes("X") || rest.includes("*") || rest.split(".").length < 3);
	if (bare) {
		const wild = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(rest);
		if (wild) {
			const major = Number(wild[1]);
			const minorTok = wild[2];
			const minor = minorTok === undefined || /[xX*]/.test(minorTok) ? null : Number(minorTok);
			if (minor === null) {
				return [{ op: ">=", version: { major, minor: 0, patch: 0, pre: [] } },
					{ op: "<", version: bump({ major, minor: 0, patch: 0, pre: [] }, "major") }];
			}
			return [{ op: ">=", version: { major, minor, patch: 0, pre: [] } },
				{ op: "<", version: bump({ major, minor, patch: 0, pre: [] }, "minor") }];
		}
	}

	const v = looseVersion(rest);
	if (!v) return null;
	if (op === "^") {
		const lower = [{ op: ">=", version: v }];
		let upper;
		if (v.major > 0) upper = bump(v, "major");
		else if (v.minor > 0) upper = bump(v, "minor");
		else upper = bump(v, "patch");
		lower.push({ op: "<", version: upper });
		return lower;
	}
	if (op === "~") {
		return [{ op: ">=", version: v }, { op: "<", version: bump(v, "minor") }];
	}
	return [{ op, version: v }];
}

function parseRangeSet(text) {
	const tokens = String(text).trim();
	if (!tokens) return { any: true, comparators: [] };
	const hyphen = /^(.+?)\s+-\s+(.+)$/.exec(tokens);
	let comparators = [];
	if (hyphen) {
		const lo = parseVersion(hyphen[1].trim());
		const hi = parseVersion(hyphen[2].trim());
		if (!lo || !hi) return null;
		comparators.push({ op: ">=", version: lo }, { op: "<=", version: hi });
	} else {
		for (const token of tokens.split(/\s+/)) {
			const expanded = expandToken(token);
			if (expanded === null) return null;
			comparators = comparators.concat(expanded);
		}
	}
	return { any: comparators.length === 0, comparators };
}

function testComparator(c, v) {
	const r = compareVersions(v, c.version);
	switch (c.op) {
		case "=": return r === 0;
		case ">": return r > 0;
		case ">=": return r >= 0;
		case "<": return r < 0;
		case "<=": return r <= 0;
		default: return false;
	}
}

/**
 * @param {string} version 被检查的版本（如宿主 0.2.1-rc.2）
 * @param {string} range 声明范围（如 ^0.2.0）
 * @param {{includePrerelease?: boolean}} [options]
 *   `includePrerelease:true` 关掉 npm 的「预发布只能被同 tuple 的预发布范围命中」这条门槛。
 *   **给兼容性判定用时要开**：宿主的 `evaluatePluginCompatibility` 实测就是宽松口径 ——
 *   本机同一份 profile，严格口径判 17 个不兼容，宿主只说 3 个（差的 14 个都是
 *   `>=0.2.0-0 <0.3.0` 这类范围 + 0.2.1-rc.2 这种宿主版本）。这条差异会直接变成
 *   「面板说装不了、宿主其实能装」，比漏报更伤。
 * @returns {{ok: boolean, reason?: string}}
 */
export function satisfiesVersion(version, range, options = {}) {
	const includePrerelease = Boolean(options && options.includePrerelease);
	const v = parseVersion(version);
	if (!v) return { ok: false, reason: "版本号无法解析：" + version };
	const sets = String(range ?? "").split("||");
	let sawValid = false;
	let anyMatched = false;
	for (const raw of sets) {
		const set = parseRangeSet(raw);
		if (!set) continue;
		sawValid = true;
		if (set.any) {
			anyMatched = true;
			break;
		}
		const all = set.comparators.every((c) => testComparator(c, v));
		if (!all) continue;
		if (v.pre.length > 0 && !includePrerelease) {
			const sameTuple = set.comparators.some((c) =>
				c.version.pre.length > 0 &&
				c.version.major === v.major &&
				c.version.minor === v.minor &&
				c.version.patch === v.patch);
			if (!sameTuple) continue;
		}
		anyMatched = true;
		break;
	}
	if (!sawValid) return { ok: false, reason: "范围写法无法解析：" + range };
	return anyMatched ? { ok: true } : { ok: false, reason: version + " 不满足 " + range };
}
