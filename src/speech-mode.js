// 说话姿态（speech mode）：让 bot 区分「答题态」与「闲扯态」
//
// 为什么需要（2026-10-23）：人格卡里的"反 AI 味"规则（有求必应 ✗、可以装傻/已读乱回 ✓）
// 属于**负面清单**；一旦它手上有搜索工具，模型的"我有答案为什么不说"就会压过这些规则 ✗
// ⇒ 群里再正经的提问、和再随意的闲聊，它都用同一种"客服腔"回答 ✗。
//
// 解法不是做两套人格 ✗（人格分裂 + 切换仍靠模型判断 ✗），而是：
//   **一套人格 + 每轮由桥接判定一种"姿态"**，把"允许装傻"变成"当轮就是闲聊态" ✓。
// 判定必须是**确定性**的（不交给模型自己决定 —— 那正是现在失效的原因）。
//
// 判定分三档（级联）：
//   · 强信号（atSelf + 问号 / 正经词）→ 直接 answer，不犹豫；
//   · 明显闲聊（纯梗/表情/单字、无问号）→ 直接 banter；
//   · 其余 → 加权打分，score ≥ 4 = answer，≤ 1 = banter，中间按"是否点名我"兜底。
// 全程零网络请求、可单测。

export const SPEECH_MODE = { ANSWER: 'answer', BANTER: 'banter' };

// 「正经询问」的措辞标志（这类词出现基本可以确定对方在认真问）
const SERIOUS_WORDS = [
  '请问', '求助', '求问', '求推荐', '求解答', '求个', '请教', '帮忙看', '帮我看', '帮我看下',
  '有没有人知道', '有人知道', '在线等', '急', '怎么', '咋', '为什么', '为啥', '是什么', '是啥',
  '能不能', '可不可以', '怎么办', '如何', '哪个', '哪家', '多少', '是否', '正经问', '认真问',
  '确认一下', '问一下', '想问'
];

// 闲聊/情绪/玩梗标志：出现这些通常不是"正经询问"
const BANTER_WORDS = [
  '哈哈', '草', '笑死', '绷', '哎', '唉', '麻了', '寄', '离谱', '好耶', '你说呢',
  '在吗', '睡了', '吃饭', '开黑', '摸鱼', '牛', 'yyds', 'awsl', 'kfc', '喵', '嗷'
];

const EMOJI_RE = /\[[^\]]{1,12}\]|[\u{1F300}-\u{1FAFF}]/u;
const QUESTION_RE = /[?？]|(?:吗|呢|吧)\s*$/;
// 疑问词：中文里"没问号的提问"极常见（"为什么我的桥接一直重启"），只认 ?/吗/呢 会漏判
const INTERROGATIVE_RE = /(为什么|为啥|怎么|咋|如何|哪个|哪家|多少|多久|多远|是否|能不能|可不可以|有没有|是什么|是啥)/g;
const PLACEHOLDER_RE = /^[\[【(（].{0,12}[\]】)）]$/;

/** 单个信号的分数贡献 + 便于调试的记录 */
export function scoreSpeechIntent(msg, { now = Date.now(), ownerQQ = null, recent = [] } = {}) {
  const text = String(msg?.plain ?? msg?.text ?? '').trim();
  const signals = [];
  let score = 0;
  const add = (delta, why) => { score += delta; signals.push(`${delta > 0 ? '+' : ''}${delta} ${why}`); };

  const atSelf = !!msg?.atSelf || !!msg?.quoteTargetIsSelf;
  if (atSelf) add(3, '点名/引用我');

  const qMark = QUESTION_RE.test(text);
  const interroCount = (text.match(INTERROGATIVE_RE) ?? []).length;
  if (qMark) add(2, '带问号/疑问语气');
  if (interroCount) add(2 + (interroCount > 1 ? 1 : 0), `疑问词×${interroCount}`);
  const serious = SERIOUS_WORDS.filter((w) => text.includes(w));
  if (serious.length) add(Math.min(3, 2 + (serious.length > 1 ? 1 : 0)), `正经词(${serious.slice(0, 2).join('/')})`);

  const banter = BANTER_WORDS.filter((w) => text.includes(w));
  if (banter.length) add(-2, `闲聊词(${banter.slice(0, 2).join('/')})`);
  if (EMOJI_RE.test(text)) add(-1, '含表情');

  if (text.length >= 15 && !banter.length && !EMOJI_RE.test(text)) add(2, '长句且无梗无表情');
  if (text.length <= 3) add(-2, '极短');

  const owner = ownerQQ != null && String(msg?.userId ?? '') === String(ownerQQ);
  if (owner) add(1, '管理员发话');

  // 连续追问：同一人 2 分钟内已有 ≥2 条带问号的消息
  const uid = String(msg?.userId ?? '');
  if (uid) {
    const askBack = (Array.isArray(recent) ? recent : []).filter((m) => m && !m.isSelf
      && String(m.userId ?? '') === uid && now - Number(m.time || 0) <= 2 * 60 * 1000
      && QUESTION_RE.test(String(m.plain ?? m.text ?? '')));
    if (askBack.length >= 2) add(2, '连续追问');
  }

  return { score, signals };
}

/**
 * 判定本轮姿态。
 * @returns {{mode:'answer'|'banter', score:number, reason:string, signals:string[]}}
 */
export function classifySpeechIntent(msg, { now = Date.now(), ownerQQ = null, recent = [] } = {}) {
  const text = String(msg?.plain ?? msg?.text ?? '').trim();
  const atSelf = !!msg?.atSelf || !!msg?.quoteTargetIsSelf;
  const { score, signals } = scoreSpeechIntent(msg, { now, ownerQQ, recent });

  // 强信号：点了名 + 明确在问 / 出现"正经问"这类词
  if (atSelf && (QUESTION_RE.test(text) || SERIOUS_WORDS.some((w) => text.includes(w)))) {
    return { mode: SPEECH_MODE.ANSWER, score, reason: '强信号：点名且有明确提问', signals };
  }
  if (/正经问|认真问|请教|求助|在线等/.test(text)) {
    return { mode: SPEECH_MODE.ANSWER, score, reason: '强信号：措辞是正经求助', signals };
  }
  // 明显闲聊：纯占位（[表情]/[图片]）、极短、或分数很低
  if (PLACEHOLDER_RE.test(text) || text.length <= 2) {
    return { mode: SPEECH_MODE.BANTER, score, reason: '明显闲聊：极短或纯占位', signals };
  }
  if (score >= 4) return { mode: SPEECH_MODE.ANSWER, score, reason: '加权判定为正经询问', signals };
  if (score <= 1) return { mode: SPEECH_MODE.BANTER, score, reason: '加权判定为闲聊', signals };
  // 中间地带：点了名就答题，否则闲聊
  return atSelf
    ? { mode: SPEECH_MODE.ANSWER, score, reason: '模糊区间，但点名了我', signals }
    : { mode: SPEECH_MODE.BANTER, score, reason: '模糊区间，按闲聊处理', signals };
}

/**
 * 多条未读合并判定：只要有一条是"正经询问"就进入答题态（宁可认真，也别把正经问题当闲聊混过去）。
 * 但若最后一条是明显闲聊、且没有一条是强信号答题，则按闲聊。
 */
export function aggregateSpeechMode(messages, opts = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.isSelf);
  if (!list.length) return { mode: SPEECH_MODE.BANTER, reason: '没有待处理的新消息', signals: [] };
  const judged = list.map((m) => ({ m, r: classifySpeechIntent(m, opts) }));
  const answers = judged.filter((x) => x.r.mode === SPEECH_MODE.ANSWER);
  if (answers.length) {
    const best = answers[answers.length - 1];
    return { mode: SPEECH_MODE.ANSWER, reason: best.r.reason, signals: best.r.signals, score: best.r.score, from: best.m?.userId };
  }
  const last = judged[judged.length - 1];
  return { mode: SPEECH_MODE.BANTER, reason: last.r.reason, signals: last.r.signals, score: last.r.score };
}

/** 注入提示词的两行姿态说明（短文对 flash 更有效，别写成清单） */
export function formatSpeechLine(mode) {
  if (mode === SPEECH_MODE.ANSWER) {
    return '【本轮姿态·答题态】这轮有人正经问你。可以查、可以给结论，但要**准而短**：不列点、不总结升华、'
      + '不写"总的来说/希望对你有帮助"、不用客服腔。答完就停。\n\n';
  }
  return '【本轮姿态·闲扯态】这轮是群里闲聊。**就算你知道答案，也可以不回、乱回、只说两个字。**'
    + '别主动替人解决问题、别总结别人的话、别把话题往正经方向拽。默认 1~10 字。\n\n';
}
