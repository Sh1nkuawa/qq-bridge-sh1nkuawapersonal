// 唤醒配额与限流的纯函数（2026-11-28 v1.6）
//
// 事故背景（契约 §10 · AGY 侧 2026-11-28 实测）：
//   AGY 是"发一条消息就结束回合"，而 DSH 在一个回合内用 qq_wait_for_messages 连续聊只算一次唤醒
//   ⇒ 同样强度的对话，AGY 的唤醒次数天然高一截。12:07–12:20 十几分钟就把 12 次/小时用光，
//   其中近半是"发送 0 条"的空醒；12:21 owner 的 @ 撞限流被排到 46 分钟后才回 ✗
//
// 这里定两件事：
//   1. 谁算"人叫它" —— 人叫它**不受小时额度限制**（额度只管它自己找话说）
//   2. 撞限流最多等多久 —— 短等（分钟级）可以重试，长等（小时级）直接放弃，不挂僵尸定时器

/** 人明确叫它的唤醒原因（不占小时额度）。带子类型时取冒号前的基名。 */
export const HUMAN_WAKE_REASONS = Object.freeze([
  'private', 'atMention', 'question', 'nameMention', 'keyword', 'poke', 'speaker'
]);

export const DEFAULT_MAX_RATE_LIMIT_DEFER_MS = 120000;

export function wakeReasonBase(reason) {
  return String(reason ?? '').split(':')[0].trim();
}

/** 这次唤醒是不是"人叫它"（不受小时额度限制）。 */
export function isHumanWakeReason(reason) {
  return HUMAN_WAKE_REASONS.includes(wakeReasonBase(reason));
}

/** 限流延迟的上限（≥5s，默认 120s）。 */
export function normalizeMaxDeferMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RATE_LIMIT_DEFER_MS;
  return Math.max(5000, Math.min(Math.round(n), 3600000));
}

/**
 * 撞限流时怎么办。
 * @returns {{action:'none'|'wait'|'drop', waitMs:number, reason:string}}
 *   none = 没撞限流；wait = 等 waitMs 后重试；drop = 等太久，放弃（消息留未读，下一轮再带）
 */
export function rateLimitDecision({
  minuteHit = false,
  hourHit = false,
  waitMs = 0,
  maxDeferMs = DEFAULT_MAX_RATE_LIMIT_DEFER_MS,
  humanTriggered = false,
  tries = 0,
  maxTries = 2
} = {}) {
  if (!minuteHit && !hourHit) return { action: 'none', waitMs: 0, reason: 'ok' };
  // 人的唤醒不走小时额度（调用方通常已经把它从 hourHit 里排除，这里兜一层）
  if (hourHit && humanTriggered && !minuteHit) return { action: 'none', waitMs: 0, reason: 'human-exempt' };
  const wait = Math.max(1000, Math.min(Number(waitMs) || 0, 3600000));
  const limit = normalizeMaxDeferMs(maxDeferMs);
  if (wait > limit) return { action: 'drop', waitMs: wait, reason: 'defer-too-long' };
  if (Number(tries) >= Number(maxTries)) return { action: 'drop', waitMs: wait, reason: 'tries-exhausted' };
  return { action: 'wait', waitMs: wait, reason: 'deferred' };
}
