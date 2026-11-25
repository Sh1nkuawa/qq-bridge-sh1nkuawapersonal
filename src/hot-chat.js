// 热聊窗口（owner 2026-11-26 要求，AGY 侧在契约 §10 登记）
//
// 现象：bot 回完一句后，群友接着聊（不带 @ / 关键词）根本唤不醒它 ——
//   2026-11-26 00:08 实测：@bot 回复后 87 秒 owner 追问「看看你的功能点是否正常」，零唤醒，
//   对话直接断掉（AGY 回完即结束回合，群停在 diving）。
//
// 规则：每次**成功发言**把窗口滑到 now + hotChatWindowMs（默认 5 分钟，配 0 = 关闭）；
//   窗口期内普通消息也能唤醒（reason: hotChat）；窗口过期、或 bot 显式潜水即失效
//   ⇒ 安静时仍然 0 唤醒 ✓
//
// 单独成模块是为了能测：这段判定错了不会报错，只会在群里表现成"它突然不理人/一直在刷屏"。

export const DEFAULT_HOT_CHAT_WINDOW_MS = 300000;          // 5 分钟
export const DEFAULT_HOT_CHAT_MAX_WAKE_PER_MINUTE = 3;     // 热聊期内每分钟最多唤醒几次

/** 窗口时长：配置读不出/负数就回落默认；0 表示关闭热聊 ✓ */
export function normalizeHotChatWindowMs(value, fallback = DEFAULT_HOT_CHAT_WINDOW_MS) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.round(v);
}

/** 现在是否还在窗口内（`hotChatUntil` 是毫秒时间戳）。 */
export function isHotChat(untilMs, nowMs = Date.now()) {
  const until = Number(untilMs) || 0;
  return until > Number(nowMs);
}

/** 说了一句话之后新的窗口截止时间（窗口关掉时返回 0）。 */
export function nextHotChatUntil(nowMs, windowMs) {
  const w = Number(windowMs) || 0;
  if (w <= 0) return 0;
  return Number(nowMs) + w;
}

/**
 * 这一分钟实际生效的唤醒上限。
 * 热聊期内适度放宽（契约 §10：刚接一句就被限频会打断对话），但**不会**放宽到无限：
 * 配置了 `hotChatMaxWakePerMinute` 就听它的，否则取 max(默认 3, 基础值)。
 */
export function effectiveMaxWakePerMinute({ hotChat = false, base = 0, hot = null } = {}) {
  const b = Number(base) || 0;
  if (!hotChat) return b;
  const h = Number(hot);
  if (Number.isFinite(h) && h > 0) return h;
  return Math.max(DEFAULT_HOT_CHAT_MAX_WAKE_PER_MINUTE, b);
}
