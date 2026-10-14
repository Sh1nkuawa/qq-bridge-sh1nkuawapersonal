// "繁忙期间积压的唤醒"怎么挑：① 过期的丢掉 ② 只补最新那条。
//
// [qq-bridge 本地补丁 2026-10-14] 事故：18:35:51 群友说的话在会话繁忙时被暂存，桥接一直等到
// 18:44:32 才补发，而且 shift() 取的是**最早**那条 → 于是 AI 接了一句 8 分 41 秒前的旧话。
// 原逻辑只看"这条消息是否还在未读里"（stillRelevant），完全不看**多久以前** ✗。
//
// 纯函数便于回归：输入积压队列，输出"该补哪条 / 丢了几条 / 过期几条"。
// 注意：被丢弃的**消息本身**仍留在未读缓冲里（模型照样能在上下文/工具里看到），
// 这里丢的只是"补发这次唤醒"的资格 —— 所以丢弃是安全的。

/** 默认多久算过期（毫秒）：超过就不再补发 */
export const DEFAULT_BACKLOG_TTL_MS = 120000;

/**
 * @param {Array<{reason?:string, seq?:number, at?:number}>} reasons 暂存的唤醒原因（按到达顺序 push，最旧在前）
 * @param {{now?:number, ttlMs?:number}} [opts]
 * @returns {{pick:object|null, expired:number, dropped:number, total:number}}
 *   pick：要补发的那条（最新且未过期）；没有就是 null
 *   expired：因超时被丢掉的条数
 *   dropped：因"只补最新"被丢掉的较早条数（不含 expired）
 */
export function pickBacklogWake(reasons, { now = Date.now(), ttlMs = DEFAULT_BACKLOG_TTL_MS } = {}) {
  const items = (Array.isArray(reasons) ? reasons : []).filter((x) => x && typeof x === 'object');
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_BACKLOG_TTL_MS;
  const fresh = items.filter((x) => {
    const at = Number(x?.at);
    if (!Number.isFinite(at) || at <= 0) return true;   // 老结构没有时间戳：当作未过期（兼容）
    return now - at <= ttl;
  });
  const expired = items.length - fresh.length;
  if (!fresh.length) return { pick: null, expired, dropped: 0, total: items.length };
  const pick = fresh.reduce((a, b) => ((Number(b?.seq) || 0) >= (Number(a?.seq) || 0) ? b : a));
  return { pick, expired, dropped: fresh.length - 1, total: items.length };
}
