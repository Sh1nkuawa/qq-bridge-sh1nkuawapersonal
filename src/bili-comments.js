// B 站评论（辅助理解用）：给"看完字幕"再加一层「观众怎么看」。
//
// 为什么需要：字幕告诉你视频**讲了什么**，但群友真正想聊的常常是"大家怎么看/有没有意思"。
// 热评能补上气氛与争议点；但它也**最容易误导模型**（把评论当视频内容）⇒ 注入时必须
// 明确标注「观众观点，不是视频内容」。
//
// 接口（2026-10-18 实测，登录态 + DoH 直连，**不需要 WBI 签名**）：
//   ✓ x/v2/reply?type=1&oid=<aid>&sort=2&ps=20&pn=1   → code=0，带 like/rcount/uname/ctime
//   ✓ x/v2/reply/main?oid=…&type=1&mode=3            → 同数据
//   ✗ x/v2/reply/wbi/main（不签名）                   → code=-403 访问权限不足
// 所以用旧版 x/v2/reply，sort=2（按热度）。

import fs from 'node:fs';
import path from 'node:path';

const REPLY_API = 'https://api.bilibili.com/x/v2/reply';
const DEFAULT_TTL_MIN = 60;
const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_CHARS_PER = 80;

/** 清洗一条评论：去表情标记/URL/多余空白，超长截断 */
export function cleanComment(input, maxChars = DEFAULT_MAX_CHARS_PER) {
  let t = String(input ?? '');
  t = t.replace(/\[[^\]]{1,12}\]/g, '');            // [笑哭] [脱单doge] 这类表情标记
  t = t.replace(/https?:\/\/\S+/g, '');             // 链接
  t = t.replace(/@[^\s@]{1,20}/g, '');              // @某人
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > maxChars) t = t.slice(0, maxChars - 1) + '…';
  return t;
}

/**
 * 从接口原始列表里挑出要用的几条：
 * - 去掉清洗后太短（<4 字）的、纯符号的、重复的；
 * - 按赞数降序取前 limit 条（sort=2 已是热度序，这里再稳一手）。
 */
export function pickComments(rawList, { limit = DEFAULT_LIMIT, maxCharsPer = DEFAULT_MAX_CHARS_PER } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rawList) ? rawList : []) {
    const text = cleanComment(r?.content?.message, maxCharsPer);
    if (text.length < 4) continue;
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)) continue;   // 纯符号/纯表情
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      user: String(r?.member?.uname ?? '').slice(0, 24),
      text,
      likes: Number(r?.like) || 0,
      replies: Number(r?.rcount) || 0
    });
  }
  out.sort((a, b) => b.likes - a.likes);
  return out.slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT));
}

/**
 * 生成注入用的文本块。**必须**带上"观众观点、不是视频内容"的警示。
 * 没有评论时返回 ''（调用方直接跳过，不留空标题）。
 */
export function formatCommentsBlock(items, { title = '' } = {}) {
  const list = Array.isArray(items) ? items.filter((x) => x && x.text) : [];
  if (!list.length) return '';
  const head = title ? `《${title}》` : '这条视频';
  const lines = [
    `[评论·仅供参考] ${head}的热评 ${list.length} 条：`,
    '（以下是**观众**说的，**不是视频内容** —— 只能用来感受气氛/争议点，',
    '  绝不能当成"视频里讲了什么"来回答；被追问视频细节时以字幕为准。）'
  ];
  for (const c of list) {
    const like = c.likes > 0 ? `👍${c.likes}` : '';
    const user = c.user ? `${c.user}：` : '';
    lines.push(`· ${user}「${c.text}」${like ? ` ${like}` : ''}`);
  }
  return lines.join('\n');
}

function cachePathOf(cacheDir, bvid) {
  return cacheDir ? path.join(cacheDir, `${bvid}.json`) : '';
}

function readCache(cacheDir, bvid, ttlMinutes) {
  const p = cachePathOf(cacheDir, bvid);
  if (!p) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j?.at || Date.now() - Number(j.at) > (Number(ttlMinutes) || DEFAULT_TTL_MIN) * 60000) return null;
    if (!Array.isArray(j.items)) return null;
    return j;
  } catch { return null; }
}

function writeCache(cacheDir, bvid, payload) {
  const p = cachePathOf(cacheDir, bvid);
  if (!p) return;
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* 缓存失败不影响主流程 */ }
}

/**
 * 取热评。返回 { ok, items, reason?, message? }
 * reason: 'no-aid' | 'no-auth' | '-412' | '-403' | 'empty' | 'http-<code>' | 'exception' | 'bad-json'
 */
export async function fetchTopComments(aid, {
  bvid = '', auth, limit = DEFAULT_LIMIT, maxCharsPer = DEFAULT_MAX_CHARS_PER,
  cacheDir = '', ttlMinutes = DEFAULT_TTL_MIN, log = () => {}, timeoutMs = 8000, force = false
} = {}) {
  const a = String(aid ?? '').trim();
  if (!/^\d+$/.test(a)) return { ok: false, reason: 'no-aid' };
  const key = bvid || a;
  if (!force) {
    const hit = readCache(cacheDir, key, ttlMinutes);
    if (hit) return { ok: true, items: hit.items, cached: true };
  }
  if (!auth?.request) return { ok: false, reason: 'no-auth' };
  const url = `${REPLY_API}?type=1&oid=${encodeURIComponent(a)}&sort=2&ps=20&pn=1`;
  let timer = null;
  try {
    const ac = new AbortController();
    timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await auth.request(url, {
      headers: { Referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' },
      signal: ac.signal
    });
    if (timer) { clearTimeout(timer); timer = null; }
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { return { ok: false, reason: 'bad-json', message: text.slice(0, 80) }; }
    if (j?.code !== 0) {
      const code = String(j?.code ?? '');
      const message = String(j?.message ?? '').slice(0, 80);
      log(`[bili-comments] 接口返回 code=${code} ${message}（aid=${a}）`);
      return { ok: false, reason: code === '-412' || code === '-403' ? code : `api-${code}`, message };
    }
    const raw = [...(j?.data?.top_replies ?? []), ...(j?.data?.replies ?? [])];
    const items = pickComments(raw, { limit, maxCharsPer });
    if (!items.length) return { ok: false, reason: 'empty' };
    writeCache(cacheDir, key, { at: Date.now(), items });
    return { ok: true, items };
  } catch (error) {
    if (timer) clearTimeout(timer);
    const msg = String(error?.message ?? error);
    log(`[bili-comments] 请求失败（aid=${a}）：${msg.slice(0, 80)}`);
    return { ok: false, reason: 'exception', message: msg.slice(0, 80) };
  }
}
