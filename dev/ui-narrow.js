/**
 * dev/ui-narrow.js — 窄屏实测片段（R20 立的法子，R30 又用了一次，所以固定下来）。
 *
 * 它不能 `node dev/ui-narrow.js` 跑：需要在**渲染进程**里量真实布局，所以用法是
 * 把下面的 `measure()` 函数体粘进 `client_eval`（dsh-diag 的反向通道），或者
 * 直接 `client_eval` 一句：
 *
 *     (() => { const s = document.createElement('script'); s.src = 'data:text/javascript,' +
 *       encodeURIComponent(document.querySelector('#dpi-ui-narrow-src')?.textContent || '');
 *       return 'use client_eval with the snippet in dev/ui-narrow.js'; })()
 *
 * 实际上就一条：复制下面 `function measure()` 的整个函数，把它作为 `client_eval` 的 code。
 *
 * ## 它回答什么
 *
 *   · 面板在 **360px** 宽下有没有**横向溢出**（`scrollWidth > clientWidth`）；
 *   · 哪些元素是「**主动省略**」（`scrollWidth > clientWidth` 且带 ellipsis）—— 那不算溢出；
 *   · 哪些元素**真的越出右边界**（`rect.right > 容器宽 + 0.5`）。
 *
 * ## 两条已知边界（别据此下错结论）
 *
 * 1. **它验不了 `@media (max-width:760px)` 那一段**：媒体查询看的是**视口**宽度，而这里是把面板
 *    克隆进一个 360px 的容器 —— 视口仍是桌面的。窄屏分支的存在性由 `dev/render-check.cjs` 的
 *    5 条文本契约负责（媒体查询在不在 / 面板内边距有没有收紧 / 有没有 >320px 的固定宽度）。
 * 2. 克隆是**静态快照**：轮询刚更新过的状态可能没进去。量之前先等一拍（或先点一次「刷新」）。
 *
 * ## 本机实测记录（供对照）
 *
 *   · R20（2026-10-24）：主面板 `scrollWidth 355 / 360`、设置面板 360×634 内部滚动 —— 0 处越界；
 *   · R30（2026-10-26）：`cloneScrollW == cloneClientW == 350`，15 个「超界」全是
 *     `dpi-history-title` / `dpi-hist-meta` 的 ellipsis —— 无真溢出。
 */

/* eslint-disable no-unused-vars */
function measure(containerWidth) {
	const width = Number(containerWidth) || 360;
	const panel = document.querySelector(".dpi-panel");
	if (!panel) return { err: "没有 .dpi-panel —— 面板没打开（先点侧栏「插件安装」）" };

	const box = document.createElement("div");
	box.style.cssText = "position:fixed;left:-4000px;top:0;width:" + width + "px;height:700px;overflow:hidden;";
	const clone = panel.cloneNode(true);
	clone.style.cssText += ";width:" + width + "px;height:700px;overflow:auto;";
	box.appendChild(clone);
	document.body.appendChild(box);

	const overflowing = [];   // 真的越出右边界
	const ellipsis = [];      // 主动省略（不算溢出）
	for (const el of clone.querySelectorAll("*")) {
		const rect = el.getBoundingClientRect();
		if (rect.width === 0) continue;
		const cls = String(el.className || "").slice(0, 52);
		if (rect.right > width + 0.5) overflowing.push({ cls, right: Math.round(rect.right) });
		else if (el.scrollWidth > el.clientWidth + 1) ellipsis.push({ cls, sw: el.scrollWidth, cw: el.clientWidth });
	}
	const result = {
		width,
		noHorizontalOverflow: clone.scrollWidth <= clone.clientWidth + 1,
		cloneScrollW: clone.scrollWidth,
		cloneClientW: clone.clientWidth,
		overflowing: overflowing.slice(0, 10),
		overflowingCount: overflowing.length,
		ellipsis: ellipsis.slice(0, 10),
		ellipsisCount: ellipsis.length,
		verdict: overflowing.length === 0
			? "PASS：没有元素越出 " + width + "px（" + ellipsis.length + " 个是主动省略）"
			: "FAIL：" + overflowing.length + " 个元素越界，见 overflowing"
	};
	document.body.removeChild(box);
	return result;
}
