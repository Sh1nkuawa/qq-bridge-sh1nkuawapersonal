// 按人格（persona）决定这一轮用哪条传输层：DSH 会话 还是 AGY worker
//
// 需求（owner 2026-11-25）：**小鲸鱼交给 DSH，猫娘交给 AGY**。
// 也就是说"用不用 AGY"不再是全局开关，而是**值班者是谁**决定的：
//   transport: "agy"                       ← 全局允许用 AGY
//   personaSchedule.personas["小鲸鱼"].transport = "dsh"    ← 但这位永远走 DSH
//   personaSchedule.personas["猫娘侍从"].transport = "agy"  ← 这位走 AGY（掉线时仍回落 DSH）
//
// 为什么单独成文件：这段判定决定"这一轮花不花 API 钱"，而且错了**不会报错**
// （只是默默多花钱 / 默默不改），所以必须有离线测试钉住 ✓

/** 合法的传输层取值；其它值一律当"没配"处理（回落全局）。 */
export const TRANSPORTS = ['dsh', 'agy'];

/**
 * 把配置里的值规范成 'dsh' | 'agy' | ''（'' = 没配/看不懂）。
 * 大小写与空白都容忍：`"DSH"`、`" agy "` 都认 ✓
 */
export function normalizePersonaTransport(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return TRANSPORTS.includes(s) ? s : '';
}

/**
 * 解析某个 persona 这一轮该走哪条传输层。
 * @param {object} opts
 * @param {string} opts.globalTransport  cfg.transport（'agy' = 全局启用 AGY）
 * @param {object} [opts.personas]       cfg.personaSchedule.personas
 * @param {string} [opts.persona]        当前值班者（角色卡上的名字）
 * @returns {'agy'|'dsh'}
 *
 * 规则（顺序即优先级）：
 *   1. 全局不是 agy ⇒ 一律 dsh（全局开关没开，persona 写 agy 也不越过）
 *   2. persona 显式写了 agy/dsh ⇒ 听它的
 *   3. 没写/写错 ⇒ 跟随全局（agy）
 */
export function resolvePersonaTransport({ globalTransport = 'dsh', personas = null, persona = null } = {}) {
  const global = normalizePersonaTransport(globalTransport) || 'dsh';
  if (global !== 'agy') return 'dsh';
  const name = String(persona ?? '').trim();
  const entry = name && personas && typeof personas === 'object' && !Array.isArray(personas)
    ? personas[name]
    : null;
  const own = entry && typeof entry === 'object' ? normalizePersonaTransport(entry.transport) : '';
  return own || 'agy';
}

/**
 * 给 status / 日志用的路由表：{ 小鲸鱼: 'dsh', 猫娘侍从: 'agy' }。
 * rotation 里的名字按顺序输出（配置里写错名字的 persona 不在这里刷存在感）。
 */
export function personaRoutingTable({ globalTransport = 'dsh', personas = null, rotation = null } = {}) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    const s = String(name ?? '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    names.push(s);
  };
  if (Array.isArray(rotation)) rotation.forEach(add);
  if (personas && typeof personas === 'object' && !Array.isArray(personas)) Object.keys(personas).forEach(add);
  const out = {};
  for (const name of names) out[name] = resolvePersonaTransport({ globalTransport, personas, persona: name });
  return out;
}

// ── AGY 降级（2026-11-26）─────────────────────────────────────────────────
// 问题：只按"心跳"判定掉线，漏了「worker 活着、但它连不上自己的模型/网络」这种情况 ——
//   回合被认领后卡死 → 租约 10 分钟超时 → 重排 → 再超时 → 丢弃。整个过程中
//   **心跳一直是新的** ⇒ 永远不回落 DSH ⇒ 群里哑火，那条消息最后被丢弃 ✗
// 做法：真正"丢了一个回合"（重排次数超限）时，把这个人格**降级 10 分钟**：
//   这段时间内的唤醒直接走 DSH；10 分钟后再试 AGY（避免一次抖动就永久切走）。

export const AGY_DEGRADE_MS = 10 * 60 * 1000;

/** 哪些"退回"原因算基础设施故障（值得降级）。'refusal'/'manual' 是模型自己不想/人手动退的，不算。 */
export const AGY_INFRA_REQUEUE_REASONS = ['lease-expired', 'tool-error', 'timeout'];

/**
 * 这次"丢弃"是否说明 AGY 这条链路坏了（⇒ 应该降级到 DSH）。
 * @param {object} opts
 * @param {boolean} opts.dropped 回合是否真的被丢弃（不是普通重排）
 * @param {string} [opts.reason] 退回原因；空 = 不知道原因，也按故障处理（宁可回落也别哑火）
 */
export function shouldDegradeToDsh({ dropped = false, reason = '' } = {}) {
  if (!dropped) return false;
  const r = String(reason ?? '').trim().toLowerCase();
  if (!r) return true;
  return AGY_INFRA_REQUEUE_REASONS.includes(r);
}

/** 当前是否处于降级期（`until` 是毫秒时间戳，0/空 = 没降级）。 */
export function isDegraded(untilMs, nowMs = Date.now()) {
  const until = Number(untilMs) || 0;
  return until > Number(nowMs);
}
