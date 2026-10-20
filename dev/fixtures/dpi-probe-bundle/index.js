/**
 * dpi-probe-bundle — 安装面板的端到端自检用 bundle。
 *
 * 它**故意**带一个网络调用能力（probe 函数），用来验证「静态扫描发现中危能力 →
 * 面板停下来等用户确认 → 确认后才装」这条链路。apply 本身什么都不注册。
 */
export function apply() {
	/* 什么都不做：这个包存在的唯一目的是被装上再被回滚。 */
}

/** 真被调用时会发一次请求；用于让静态扫描命中 network（medium）。 */
export async function probe(url = "https://example.com/") {
	const res = await fetch(url, { method: "HEAD" });
	return res.status;
}
