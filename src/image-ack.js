// image-ack.js —— 生图请求的文本识别 + 回执去重（纯函数，可单测）。
//
// 为什么单独抽出来：同一套"这条消息算不算生图请求"的判断有两处要用——
//   1) 桥接受理接口 /api/socialV2/image-request（真正扣配额的那道闸）；
//   2) 群里收到消息时的**即时回执**（不等模型回合，先回一句"画着呢"）。
// 两处必须完全一致，否则会出现"回了执但没生成"或"生成了却没回执"。
//
// 规则：@ 提及必然出现在「生图」之前，而昵称里可能含任意字符（实测昵称「！？哦鲸鲸？！」），
// 所以不能用字符白名单，改用状态机：遇到 @ 进入提及态，一直吃到空白/标点为止，
// 这之前的任何"实质文字"都判定为不合格。

const MENTION_BREAK = /[\s:：,，、;；\-—·]/u;

/**
 * @param {string} rawText 消息正文（可含 "@昵称" 前缀）
 * @param {string} prefix 触发词，默认「生图」
 * @returns {{ok:boolean, prefixAt:number, text:string, reason:string}}
 *   ok=true 时 text 为从触发词开始的正文；ok=false 时 reason 说明原因
 */
export function analyzeImageRequest(rawText, prefix = '生图') {
  const raw = String(rawText ?? '');
  const word = String(prefix || '生图');
  const prefixAt = raw.indexOf(word);
  if (prefixAt < 0) return { ok: false, prefixAt: -1, text: raw.trim(), reason: 'NO_PREFIX' };
  const head = raw.slice(0, prefixAt);
  let inMention = false;
  for (const ch of head) {
    if (ch === '@') { inMention = true; continue; }
    if (MENTION_BREAK.test(ch)) { inMention = false; continue; }
    if (!inMention) return { ok: false, prefixAt, text: raw.slice(prefixAt).trim(), reason: 'NO_PREFIX' };
  }
  return { ok: true, prefixAt, text: raw.slice(prefixAt).trim(), reason: '' };
}

/**
 * 从最近的 @ 记录里挑出"这次生图请求真正对应的那一条"。
 *
 * 背景：原来只保留最后一条 @（`lastMention`），会话繁忙时 agent 回合会拖后，
 * 期间后面那条无关的 @ 会把生图请求顶掉 → 模型明明看到"@我 生图 …"却调不动工具。
 * 现在保留一个小列表，这里挑**最新的、而且正文真的以触发词开头的那一条**。
 *
 * @param {object[]} mentions [{senderId, senderName, at, text, messageId, quoteId}]
 * @param {{now?:number, windowMs?:number, prefix?:string, senderId?:string}} options
 * @returns {object|null}
 */
export function pickImageMention(mentions, options = {}) {
  const now = Number(options.now) || Date.now();
  const windowMs = Number(options.windowMs) || 10 * 60000;
  const prefix = options.prefix ?? '生图';
  const only = options.senderId != null ? String(options.senderId) : null;
  const list = (Array.isArray(mentions) ? mentions : []).filter((m) => m && typeof m === 'object');
  const sorted = [...list].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  for (const m of sorted) {
    if (now - Number(m.at || 0) > windowMs) continue;
    if (only && String(m.senderId ?? '') !== only) continue;
    const analyzed = analyzeImageRequest(m.text, prefix);
    if (!analyzed.ok) continue;
    return m;
  }
  return null;
}

/**
 * 要不要发"开始生图"的即时回执？
 * @param {{now:number, atSelf?:boolean, quoteTargetIsSelf?:boolean, text:string, prefix?:string,
 *          isOwner?:boolean, used?:number, dailyLimit?:number, imageJob?:object, lastAck?:object,
 *          dedupeMs?:number, ackEnabled?:boolean}} input
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldSendEarlyAck(input = {}) {
  const now = Number(input.now) || Date.now();
  const dedupeMs = Number(input.dedupeMs) || 180000;
  if (input.ackEnabled === false) return { ok: false, reason: 'ack-disabled' };
  if (!input.atSelf && !input.quoteTargetIsSelf) return { ok: false, reason: 'not-addressed-to-bot' };
  const analyzed = analyzeImageRequest(input.text, input.prefix ?? '生图');
  if (!analyzed.ok) return { ok: false, reason: 'not-an-image-request' };
  // 配额已用完就别先许诺（让 agent 老老实实说"今天次数用完了"）
  const used = Number(input.used) || 0;
  const limit = Number(input.dailyLimit) || 0;
  if (!input.isOwner && limit > 0 && used >= limit) return { ok: false, reason: 'quota-exhausted' };
  // 同一个人刚回过执 → 不重复回。
  // 注意：过去这里只按"发送者 + 3 分钟"去重，结果**同一个人隔 2 分钟重新发一次（上一次被判无效/失败）时，
  // 第二次既没有即时回执、受理回执也被吞掉**（2026-09-28 实测：库库重发那次群里一句提示都没有）。
  // 现在按"请求"去重：有 requestId（消息 id）就只比对 requestId；没有才退回 20 秒的短窗口。
  const lastAck = input.lastAck && typeof input.lastAck === 'object' ? input.lastAck : null;
  if (lastAck) {
    const sameRequest = Boolean(lastAck.requestId && input.requestId
      && String(lastAck.requestId) === String(input.requestId));
    const sameSenderFresh = String(lastAck.senderId ?? '') === String(input.senderId ?? '')
      && now - Number(lastAck.at || 0) < (Number(input.sameSenderWindowMs) || 20000);
    if (sameRequest || (!input.requestId && sameSenderFresh)) {
      return { ok: false, reason: sameRequest ? 'already-acked' : 'already-acked-recently' };
    }
  }
  const job = input.imageJob && typeof input.imageJob === 'object' ? input.imageJob : null;
  if (job && String(job.senderId ?? '') === String(input.senderId ?? '') && Number(job.expiresAt || 0) > now) {
    return { ok: false, reason: 'job-in-flight' };
  }
  return { ok: true, reason: '' };
}
