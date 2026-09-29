// 回合级错误的重试策略（纯函数，便于单测）。
//
// 背景（2026-09-29 实测）：DSH 把「模型把工具参数写成非法 JSON」报成
// `MALFORMED_RESPONSE: DeepSeek Messages stream: tool input is invalid JSON`，
// 而它自己的 LLM 重试策略只覆盖 EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT
// —— 这个错误码会**直接判死整个回合**，群里只会看到一句报错。
// 实测两次都是同一个手滑：`qq_send_message` 的 messages 写成了不带引号的中文正文：
//   {"key":"group:1","messages": 好问归好问，这图笑得我发毛, "token":"…"}
// 模型偶发、重发一次基本就好，所以桥接自己补一次重试最划算。

/** 让模型知道怎么改的重发提示（写进下一轮唤醒提示，消费一次即清空）。 */
export const MALFORMED_RETRY_HINT = '上一轮你把工具参数写成了**非法 JSON**（最常见：messages 里的正文没有加引号），'
  + '那个回合被判失败、消息没发出去。这一轮请把想说的话重新发一次：参数必须是合法 JSON，字符串一定要用双引号包起来，'
  + '例如 {"key":"group:123","messages":"在的","token":"…"} 或 {"key":"group:123","messages":["在的","叫我干嘛"],"token":"…"}。';

/** 这个错误是不是「工具入参不是合法 JSON」。 */
export function isMalformedResponse({ code = '', message = '' } = {}) {
  return /MALFORMED_RESPONSE/i.test(String(code)) || /tool input is invalid JSON/i.test(String(message));
}

/**
 * 是否再补一次重试。
 * @param state - 会话状态（读 state.malformedRetry = { count, at }）
 * @param cfg - 完整配置（读 cfg.socialV2.errorRetry）
 * @returns { allowed, attempt, max, windowMs, hint }
 */
export function planMalformedRetry({ state = null, cfg = null, now = Date.now() } = {}) {
  const c = cfg?.socialV2?.errorRetry ?? {};
  const maxRaw = Number(c.malformedMax);
  const max = Number.isFinite(maxRaw) ? maxRaw : 2;
  const winRaw = Number(c.windowMs);
  const windowMs = Number.isFinite(winRaw) ? winRaw : 180000;
  const prev = state?.malformedRetry ?? null;
  const inWindow = Boolean(prev) && now - Number(prev.at || 0) < windowMs;
  const used = inWindow ? Number(prev.count) || 0 : 0;
  const allowed = max > 0 && used < max;
  return { allowed, attempt: allowed ? used + 1 : used, max, windowMs, hint: MALFORMED_RETRY_HINT };
}

/** 记账：把这次重试写回会话状态（保持形状不变，便于持久化）。 */
export function noteMalformedRetry(state, { now = Date.now() } = {}) {
  const prev = state?.malformedRetry ?? null;
  state.malformedRetry = { count: (Number(prev?.count) || 0) + 1, at: now };
  return state.malformedRetry;
}
