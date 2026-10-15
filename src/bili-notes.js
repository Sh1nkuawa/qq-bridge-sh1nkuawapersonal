// B 站视频的"轻记忆"：记下**自己对这条视频说过什么**，下次再提到时保持一致。
//
// 为什么不做精确分页（owner 2026-10-15 明确的口径）：
//   "这里不需要记得很精确，只需要能记住自己总结什么不会出现前后矛盾就好。"
// ⇒ 所以这里只保存**本轮发到群里的那几句**（截断到几百字），下次遇到同一个 BV 时
//   把"你之前说过：…"塞进提示，要求保持一致；不追求逐句可溯源。
//
// 设计要点：
//   - 纯函数（load/save 之外全是纯逻辑），可离线回归；
//   - 存储是"每个 bvid 一条"，新的覆盖旧的（本来就只要一致性，不要流水账）；
//   - 有界：最多 maxEntries 条，按 at 由新到旧裁；
//   - 存的文本**去掉 URL/空白**（URL 对一致性没价值，还占预算）。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TAKE_CHARS = 400;
export const DEFAULT_MAX_ENTRIES = 200;

/** 从文本里挑出 BV 号 */
export function bvidOf(text) {
  const m = String(text ?? '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

/**
 * 把"这一轮发到群里的几句话"整理成一条 take。
 * 去掉 URL、压空白、截断到 maxChars（太长没法当"记住结论"用）。
 */
export function takeFromMessages(messages, { maxChars = DEFAULT_TAKE_CHARS } = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  const text = list
    .map((m) => String(m ?? ''))
    .join(' ')
    .replace(/https?:\/\/\S+/g, '')          // URL 不参与"一致性"
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + '…';
}

/** 读出存储（坏了就当空） */
export function loadNotes(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.notes && typeof j.notes === 'object') return j.notes;
  } catch { /* 首次运行/文件坏了 */ }
  return {};
}

/** 原子写回 */
export function saveNotes(file, notes) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ notes }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 记一条 take（新覆盖旧）。返回新的 notes（不便就返回原对象）。
 * 同时把条数裁到 maxEntries。
 */
export function rememberTake(notes, { bvid, title = '', take, at = Date.now(), maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const id = bvidOf(bvid);
  const text = String(take ?? '').trim();
  if (!id || !text) return notes;
  const next = { ...(notes ?? {}) };
  const prev = next[id];
  next[id] = {
    title: title || prev?.title || '',
    take: text,
    at,
    count: (Number(prev?.count) || 0) + 1
  };
  const entries = Object.entries(next);
  if (entries.length > maxEntries) {
    entries.sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0));
    const kept = entries.slice(0, maxEntries);
    return Object.fromEntries(kept);
  }
  return next;
}

/**
 * 生成"你之前说过"那一行（没有记过就返回 ''）。
 * 明确要求"保持一致"，并给出改口的正当出口（免得为了不矛盾而硬撑错话）。
 */
export function buildConsistencyLine(notes, bvid, { maxChars = 400 } = {}) {
  const id = bvidOf(bvid);
  if (!id) return '';
  const item = notes?.[id];
  if (!item?.take) return '';
  const age = item.at ? `（上次 ${new Date(Number(item.at)).toLocaleString()}）` : '';
  const take = String(item.take).slice(0, maxChars);
  return `【你之前对这条视频说过】${take}${age}\n`
    + '↑ 保持一致，别前后矛盾；如果现在发现之前说错了，就直接说"上次我说得不准"再纠正，不要两边都含糊。';
}
