// 收到的语音 → 文字（「听懂语音」）。
//
// 背景：桥接**发**语音的能力（socialV2.voice / qq_send_voice）早就存在，但**收**到的语音
// 一直只写成占位符 `[语音]`（bridge.js 的 segmentsToText、forward.js 的 segmentText），
// AI 根本不知道对方说了什么。SnowLuma 提供 `fetch_ptt_text`（驱动 QQ 原生
// `pttTrans.Trans{C2C,Group}PttReq`，见 snowluma/index.mjs 的 fetchPttText），本模块把它
// 包装成「可重试、不抛异常、超时有界」的一次调用，并负责把结果回填进消息对象。
//
// 两种接入方式（调用方选）：
//   1) 回填式（reserved2 二代仿真）：消息先按原时序入库（占用 seq），拿到转写后原地改写
//      同一个消息对象（recentMessages / unread 共用同一个引用）。
//   2) 等待式（chat / closed-agent 等）：入库前限时等待，等不到就退回占位符。
//
// 为什么不能一律用等待式：SDK 的 WS 事件是**并发派发**的
// （@snowluma/sdk 的 websocket-client.js：`void this.dispatchEvent(...)`，不 await），
// 语音消息若在入库前等几秒，它会晚于其后到达的文本消息入库 —— seq 单调递增的假设被破坏，
// AI 会看到「先被回复、后提问」的错乱时序。
//
// 安全：fetch_ptt_text 是只读动作；转写文本来自**外部输入**（对方说的话 / QQ 的 ASR 结果），
// 一律当不可信文本处理：只做规范化与截断，不执行、不拼命令、不写文件。
import { truncateText, truncateTextTail } from './md-to-plain.js';

/** 语音段在消息文本里的占位符（与 bridge.js / forward.js 保持一致）。 */
export const VOICE_PLACEHOLDER = '[语音]';

/** 转写文本在消息里的前缀：保留 `[语音]` 是为了让 AI 知道对方是**说**的，不是打字。 */
export const VOICE_TRANSCRIPT_PREFIX = `${VOICE_PLACEHOLDER} 转写：`;

/**
 * 把 ASR 文本整理成一条可塞进消息文本的转写标签。
 *
 * - 折叠所有空白（ASR 偶尔返回换行/连续空格），避免提示词里一行消息被撑成多行；
 * - 空文本返回空串：调用方据此判定「没听懂」，保持占位符不动。
 */
export function buildVoiceTranscript(text, { prefix = VOICE_TRANSCRIPT_PREFIX } = {}) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return `${prefix}${s}`;
}

/**
 * 造一个「到点就 abort」的 AbortSignal。
 *
 * 为什么不直接 `AbortSignal.timeout(ms)`：它是 Node 17.3+ 才有的 API。旧运行时下写
 * `signal: AbortSignal.timeout?.(ms)` 会得到 `undefined` —— **超时静默失效**，一次卡住的
 * 网关调用会把这条语音的转写名额一直占着。所以退化路径用手动 AbortController 补上。
 */
function makeTimeoutSignal(ms) {
  if (typeof AbortSignal?.timeout === 'function') return { signal: AbortSignal.timeout(ms), cancel: () => {} };
  if (typeof AbortController === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* 已经 abort 过就算了 */ } }, ms);
    timer.unref?.();
    return { signal: controller.signal, cancel: () => clearTimeout(timer) };
  }
  return { signal: undefined, cancel: () => {} };
}

/**
 * 调 SnowLuma 的 `fetch_ptt_text`（POST /fetch_ptt_text）。
 *
 * 永不抛异常：网络/超时/网关错误/非 0 retcode 一律折成 `{ ok:false, error }`，因为调用方
 * 在消息处理链路上，一个未捕获的 rejection 会把那条消息的处理带偏。
 *
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function fetchPttText(messageId, {
  httpUrl = '',
  accessToken = '',
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch
} = {}) {
  const base = String(httpUrl ?? '').replace(/\/+$/, '');
  const id = String(messageId ?? '').trim();
  if (!base) return { ok: false, error: '未配置 snowluma.httpUrl' };
  if (!id) return { ok: false, error: '缺少 message_id' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: '运行环境没有 fetch' };
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs)) : 5000;
  // SnowLuma 内部的 pttTrans 等待上限是 20s，这里必须更短：宁可早点放弃去重试，
  // 也不要让一条语音把消息链路的预算耗光。
  const { signal, cancel } = makeTimeoutSignal(budget);
  try {
    const res = await fetchImpl(`${base}/fetch_ptt_text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
      },
      body: JSON.stringify({ message_id: id }),
      signal
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}${body?.message ? `：${body.message}` : ''}` };
    if (body?.status !== 'ok' || Number(body?.retcode) !== 0) {
      return { ok: false, error: String(body?.message ?? body?.wording ?? `retcode=${body?.retcode ?? '?'}`) };
    }
    return { ok: true, text: String(body?.data?.text ?? '').trim() };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    cancel();
  }
}

/**
 * 带重试的语音转写。
 *
 * 为什么要重试：QQ 侧的语音识别是**异步**的 —— SnowLuma 会先发一次 Trans 请求（同步返回
 * 文本，通常就是这一次拿到），拿不到就等 QQ 推回结果（最长 20s）。我们只等几秒，所以
 * 「第一次空手而归」是常态而不是异常；隔一会儿再问一次，服务端往往已经有结果了。
 * 每次尝试都是只读动作，重试的代价只是一次本地 HTTP 往返。
 *
 * 空文本（纯音乐/环境音/对方没说话）在重试后仍是空 → 归为失败，调用方保持占位符。
 *
 * 永不抛异常。
 *
 * @returns {Promise<{ok:boolean, text?:string, error?:string, attempts:number}>}
 */
export async function transcribeVoiceMessage({
  messageId,
  httpUrl = '',
  accessToken = '',
  attempts = 2,
  timeoutMs = 5000,
  retryDelayMs = 800,
  fetchImpl = globalThis.fetch,
  sleepImpl = null
} = {}) {
  const sleep = typeof sleepImpl === 'function' ? sleepImpl : (ms) => new Promise((r) => setTimeout(r, ms));
  const maxAttempts = Math.max(1, Math.min(4, Math.round(Number(attempts) || 1)));
  const delay = Math.max(0, Number(retryDelayMs) || 0);
  let last = { ok: false, error: '未尝试' };
  for (let i = 1; i <= maxAttempts; i++) {
    last = await fetchPttText(messageId, { httpUrl, accessToken, timeoutMs, fetchImpl });
    if (last.ok && last.text) return { ok: true, text: last.text, attempts: i };
    if (i < maxAttempts && delay) {
      try { await sleep(delay); } catch { /* 睡不着的实现不该让转写失败 */ }
    }
  }
  if (last.ok && !last.text) return { ok: false, error: '转写结果为空（可能不是人声）', attempts: maxAttempts };
  return { ok: false, error: last.error ?? '转写失败', attempts: maxAttempts };
}

/**
 * 等一个已经启动的转写任务，最多等 `timeoutMs`；超时/失败都返回失败结果，**永不抛**。
 *
 * 供「等待式」接入（chat / closed-agent）使用：那些模式没有回填机制，只能在入库前等一下。
 * 注意超时不代表任务终止 —— 它还在跑，只是这次不等了。
 */
export async function settleVoiceTranscript(task, { timeoutMs = 8000 } = {}) {
  if (!task || typeof task.then !== 'function') return { ok: false, error: '没有转写任务', attempts: 0 };
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs)) : 8000;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `等待转写超时(${budget}ms)`, attempts: 0 }), budget);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve(task).catch((error) => ({ ok: false, error: error?.message ?? String(error), attempts: 0 })),
      timeout
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把转写结果**原地**回填进一条已入库的消息。
 *
 * 只替换**第一个** `[语音]` 占位符：
 * - 一条消息里同时有文字和语音（「听这个 [语音]」）时，原来的文字必须保留 —— 直接覆盖
 *   `msg.text` 会把对方打的字丢掉；
 * - 一条消息里有多个语音段时，一次转写只对应一个 message_id，多余的那些继续留占位符，
 *   总比把同一段转写复制两遍强。
 *
 * `text` / `plain` / `tail` 三个字段一起改：前两个是给 AI 看的正文，`tail` 供
 * 「对方可能没说完」的判定使用（bridge.js 的 looksLikeUnfinished）。
 *
 * 失败时保持文本原样，只在 `msg.voice` 里记下原因（便于日志/控制台排查）。
 *
 * @returns {boolean} 是否真的回填了文本
 */
export function applyVoiceTranscript(msg, result, { maxChars = 200 } = {}) {
  if (!msg || typeof msg !== 'object') return false;
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.round(Number(maxChars)) : 200;
  const info = {
    attempts: Number(result?.attempts) || 0,
    at: Date.now()
  };
  const label = result?.ok ? buildVoiceTranscript(result.text) : '';
  if (!label) {
    msg.voice = { ...(msg.voice ?? {}), ...info, ok: false, error: String(result?.error ?? '转写为空') };
    return false;
  }
  msg.voice = { ...(msg.voice ?? {}), ...info, ok: true, text: truncateText(String(result.text ?? ''), limit) };
  for (const field of ['text', 'plain']) {
    const current = String(msg[field] ?? '');
    const next = current.includes(VOICE_PLACEHOLDER)
      ? current.replace(VOICE_PLACEHOLDER, label)
      : `${current}${current ? ' ' : ''}${label}`;
    msg[field] = truncateText(next, limit);
  }
  const tailSource = String(msg.tail ?? '');
  const tailNext = tailSource.includes(VOICE_PLACEHOLDER)
    ? tailSource.replace(VOICE_PLACEHOLDER, label)
    : `${tailSource}${tailSource ? ' ' : ''}${label}`;
  msg.tail = truncateTextTail(tailNext, limit);
  return true;
}
