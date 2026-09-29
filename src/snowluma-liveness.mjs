// SnowLuma 链路存活判定（纯函数，便于单测）。
//
// 事故背景（2026-09-29 19:17 实测）：
//   桥接进程活着、WebSocket 也没报 close，但群友 19:17:50 的「@机器人 …」**根本没进桥接**
//   —— SnowLuma 日志里有这条 [Event]（消息到了 OneBot 网关），桥接的活动日志里一个字都没有。
//   几分钟后 SnowLuma 才打出 `socket error: read ECONNRESET`。
//   这就是典型的"半死连接"：对端不再投递、写缓冲堆积，但 socket 没有显式关闭，
//   而 SDK 的 reconnect 只在收到 close 时触发 —— 于是"桥接活着但收发全废"，直到有人手工重启。
//
// 对策：不信任"连接对象还在"，改为按**入站活动**判定存活：
//   - 任何入站事件（群/私聊/通知）都刷新 lastAliveAt；
//   - 静默超过 idleProbeMs 就主动发一个廉价的 get_status 探活；
//   - 探活失败（或静默超过 hardReconnectMs）就强制重连。
// 群聊活跃时"5 分钟没有任何入站"本身就足够可疑，所以这套判定不需要知道对方是否在说话。

export const SNOWLUMA_PROBE_MIN_INTERVAL_MS = 15000;

/**
 * 该不该探活/重连。
 * @param {object} p
 * @param {number} p.now            当前时间
 * @param {number} p.lastAliveAt    最近一次入站活动时间
 * @param {number} p.idleProbeMs    静默多久开始探活（默认 5 分钟）
 * @param {number} p.hardReconnectMs 静默多久直接强制重连（默认 12 分钟）
 * @param {number} [p.lastProbeAt]  上次探活时间
 * @param {boolean} [p.probeInFlight] 是否有探活在飞
 * @param {boolean} [p.probeFailed] 上次探活是否失败
 * @returns {{action:'none'|'probe'|'reconnect', idleMs:number, reason:string}}
 */
export function decideSnowlumaAction({
  now = Date.now(),
  lastAliveAt = 0,
  idleProbeMs = 300000,
  hardReconnectMs = 720000,
  lastProbeAt = 0,
  probeInFlight = false,
  probeFailed = false
} = {}) {
  const idleMs = Math.max(0, now - Number(lastAliveAt || 0));
  // 探活刚失败：立刻重连，别再等（此时链路基本可以判死）。
  if (probeFailed) return { action: 'reconnect', idleMs, reason: '探活失败（get_status 无响应）' };
  if (idleMs >= hardReconnectMs) return { action: 'reconnect', idleMs, reason: `静默 ${Math.round(idleMs / 60000)} 分钟，直接重连` };
  if (idleMs >= idleProbeMs) {
    if (probeInFlight) return { action: 'none', idleMs, reason: '探活进行中' };
    if (now - Number(lastProbeAt || 0) < SNOWLUMA_PROBE_MIN_INTERVAL_MS) return { action: 'none', idleMs, reason: '距上次探活太近' };
    return { action: 'probe', idleMs, reason: `静默 ${Math.round(idleMs / 60000)} 分钟，探活` };
  }
  return { action: 'none', idleMs, reason: '正常' };
}

/** 归一化配置（对错值/负数宽容，避免把看门狗配成 0 导致每轮都重连）。 */
export function normalizeSnowlumaWatchConfig(cfg = {}) {
  const c = cfg?.socialV2?.snowluma ?? cfg?.snowlumaWatch ?? {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const idleProbeMs = num(c.idleProbeMs, 300000);
  return {
    enabled: c.enabled !== false,
    idleProbeMs,
    hardReconnectMs: Math.max(idleProbeMs * 2, num(c.hardReconnectMs, 720000)),
    tickMs: num(c.tickMs, 30000),
    probeTimeoutMs: num(c.probeTimeoutMs, 10000),
  };
}
