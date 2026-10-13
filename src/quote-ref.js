// 引用消息的"身份证"：把「引用的是谁、哪一条、带什么附件」写清楚，供模型直接定位。
//
// [qq-bridge 本地补丁 2026-10-13] 背景：以前引用段只拼成 `[引用 某人：文本]`（src/bridge.js），
// 一旦被引用的是**图片/表情**（没有文本），就成了 `[引用 某人]` —— 模型既不知道这是图片消息，
// 也拿不到被引用消息的 id ✗ → 实测它会对一串 id 挨个调 qq_get_message_images 去**猜**
// （2026-10-11 22:51~22:54 日志里连试了 5 个 id）。
//
// 本模块只做纯拼装/解析：把 id 与附件类型写进引用段，再从上下文里把这信息捞出来给提示词用。
// 注意：图像本身没法塞进提示词（只能经 MCP 工具结果进模型），所以这里的价值是
// **让模型知道该调哪一个 id**，而不是替它把图读进来。

const KIND_LABEL = {
  image: '图片',
  face: '表情',
  sticker: '收藏表情',
  video: '视频',
  record: '语音',
  file: '文件',
  card: '卡片',
  json: '卡片',
  forward: '合并转发',
  at: '@',
  reply: '引用'
};

/** 附件列表 → '图片×1、表情×2'（空/无 → ''） */
export function describeMediaList(media, { max = 4 } = {}) {
  const list = Array.isArray(media) ? media : [];
  const counts = new Map();
  for (const m of list) {
    const kind = String(m?.kind ?? m?.type ?? '').trim() || '附件';
    const label = KIND_LABEL[kind] ?? kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].slice(0, max).map(([label, n]) => (n > 1 ? `${label}×${n}` : label)).join('、');
}

/**
 * 拼引用段文本。
 * 形如：`[引用 张三：看这个｜附件：图片×1｜quotedId=-1370457565]`
 * 有 id 就一定带上；有附件就一定标注（这是这次修复的核心）。
 */
export function buildQuoteText({ sender, text, messageId, media, maxText = 60, maxMedia = 4 } = {}) {
  const parts = [];
  const who = String(sender ?? '').replace(/[｜\]]/g, ' ').trim();
  const body = String(text ?? '').replace(/\s+/g, ' ').replace(/[｜\]]/g, ' ').trim().slice(0, maxText);
  const tail = [];
  const attachments = describeMediaList(media, { max: maxMedia });
  if (attachments) tail.push(`附件：${attachments}`);
  const id = String(messageId ?? '').trim();
  if (id) tail.push(`quotedId=${id}`);
  const head = who ? (body ? `${who}：${body}` : who) : body;
  if (head) parts.push(head);
  parts.push(...tail);
  if (!parts.length) return '[引用消息]';
  return `[引用 ${parts.join('｜')}]`;
}

/** 从我们自己拼出来的文本里把引用信息捞回来（给提示词用）。 */
export function parseQuotedRefs(text) {
  const out = [];
  const src = String(text ?? '');
  const re = /\[引用\s*([^｜\]]*?)(?:｜附件：([^｜\]]+))?(?:｜quotedId=([^\]\s]+))?\]/g;
  for (const m of src.matchAll(re)) {
    const head = String(m[1] ?? '').trim();
    const media = String(m[2] ?? '').trim();
    const messageId = String(m[3] ?? '').trim();
    if (!media && !messageId) continue;
    const ci = head.indexOf('：');
    out.push({
      sender: ci > 0 ? head.slice(0, ci).trim() : (media || messageId ? head : ''),
      text: ci > 0 ? head.slice(ci + 1).trim() : '',
      media,
      messageId
    });
  }
  return out;
}

/**
 * 给唤醒提示的一句话：只在"引用了带附件的消息"时非空。
 * 重点是**把 quotedId 直接给出来**，并明确禁止拿别的 id 去猜。
 */
export function quoteMediaHint({ sender, messageId, media, toolName = 'mcp__snowluma__qq_get_message_images' } = {}) {
  const attachments = String(media ?? '').trim();
  const id = String(messageId ?? '').trim();
  if (!attachments) return '';
  const lines = ['【引用】群里有人**引用了一条带附件的消息**（图片/表情这类没有文字的消息最常见）：'];
  lines.push(`- 被引用的那条：${id ? `quotedId=${id}，` : ''}附件：${attachments}${sender ? `（发件人 ${sender}）` : ''}`);
  if (id) {
    lines.push(`要看内容就直接调 ${toolName}，**messageId 用上面这个 quotedId**；`);
    lines.push('**不要**拿其它消息 id 挨个试（那是 2026-10-11 犯过的错 ✗），也不要说"我不知道你引用的是哪张图"。');
  } else {
    lines.push('这条引用没带 id（很旧的记录），如实说看不到被引用的原图，不要瞎猜是哪一条。');
  }
  return lines.join('\n');
}
