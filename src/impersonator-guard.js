// 冒名守卫：群友把昵称/群名片改成"像 bot 的名字"时，自动给他改成「冒名·X」。
//
// 需求（owner 2026-10-23）：有人改成 bot 的名字装 bot ⇒ bot 自动重命名。
// 但**不能按"名字里带哦或鲸"** ✗ —— "哦"是高频字（哦豁/哦哦），会误伤正常人。
// 所以按 owner 选的规则：**归一化后包含「哦鲸」「鲸鲸」「哦鲸鲸」之一**才算像 bot 名 ✓。
//
// 改名规则：`冒名·` + 原昵称尾部（例如「！？鲸鲸？！」→「冒名·鲸鲸」）✓。
//
// 安全护栏（都在这里做，调用方只管问"该不该改"）：
//   · 群主 / 管理员 / bot 自己 永不改 ✓
//   · 已经带「冒名·」前缀的不再改（幂等）✓
//   · 同一个人/同一个名字只改一次（防止反复拉锯）✓
//   · 每小时上限（默认 5 次）✓

export const DEFAULT_MARKERS = ['哦鲸', '鲸鲸', '哦鲸鲸'];
export const DEFAULT_PREFIX = '冒名·';
export const RENAME_HOURLY_CAP = 5;

/** 归一化：去 @、去 emoji 装饰性符号、全角转半角、去掉空白与常见分隔符 */
export function normalizeName(input) {
  return String(input ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角 → 半角
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!?？、,，。.~～_\-|/\\()[\]{}<>《》「」『』"'`]/g, '')
    .toLowerCase();
}

/**
 * 这个昵称像不像 bot 的名字。
 * @returns {{ hit:boolean, marker?:string, normalized:string }}
 */
export function looksLikeBotName(card, { markers = DEFAULT_MARKERS } = {}) {
  const normalized = normalizeName(card);
  if (!normalized) return { hit: false, normalized };
  for (const m of markers) {
    const nm = normalizeName(m);
    if (nm && normalized.includes(nm)) return { hit: true, marker: m, normalized };
  }
  return { hit: false, normalized };
}

/** 从原昵称里取"可辨识的尾部"（去装饰，最多 4 字；取不到就用原串） */
export function tailOfName(card) {
  const norm = normalizeName(card);
  if (!norm) return '';
  // 归一化后可能还是很长（"哦鲸鲸"这种），取后 4 个字符
  return norm.slice(-4);
}

/** 生成要改成的新名片：`冒名·` + 原昵称尾部（QQ 群名片上限约 30 字节，这里控制在 20 字符内） */
export function pickDisguiseCard(card, { prefix = DEFAULT_PREFIX, maxLen = 20 } = {}) {
  const tail = tailOfName(card);
  const out = `${prefix}${tail}`.slice(0, maxLen);
  return out;
}

/**
 * 决定要不要改。
 * @param {object} p
 * @param {string} p.card            当前昵称/群名片
 * @param {boolean} [p.isSelf]       是不是 bot 自己
 * @param {boolean} [p.isOwner]      群主
 * @param {boolean} [p.isAdmin]      管理员
 * @param {Set<string>} [p.done]     已经改过的键（`userId|normalizedCard`）
 * @param {string} [p.userId]
 * @param {number[]} [p.recentRenameAt]  最近的改名时间戳（做每小时上限）
 * @param {number} [p.now]
 * @returns {{ rename:boolean, newCard?:string, key?:string, reason:string }}
 */
export function decideRename({
  card = '', isSelf = false, isOwner = false, isAdmin = false,
  done = new Set(), userId = '', recentRenameAt = [], now = Date.now(),
  markers = DEFAULT_MARKERS, prefix = DEFAULT_PREFIX, hourlyCap = RENAME_HOURLY_CAP
} = {}) {
  if (isSelf) return { rename: false, reason: '自己不改' };
  if (isOwner || isAdmin) return { rename: false, reason: '不改群主/管理员' };
  const look = looksLikeBotName(card, { markers });
  if (!look.hit) return { rename: false, reason: '不像 bot 名' };
  // 已经改过了（幂等）
  if (String(card).includes(prefix)) return { rename: false, reason: '已经是改名后的名片' };
  const key = `${userId}|${look.normalized}`;
  if (done && done.has(key)) return { rename: false, reason: '这个人这张名片已经改过' };
  const recent = (Array.isArray(recentRenameAt) ? recentRenameAt : []).filter((t) => now - Number(t) < 60 * 60 * 1000);
  if (recent.length >= hourlyCap) return { rename: false, reason: `本小时已达上限（${hourlyCap}）` };
  const newCard = pickDisguiseCard(card, { prefix });
  if (!newCard || newCard === card) return { rename: false, reason: '生成的新名片无效' };
  return { rename: true, newCard, key, marker: look.marker, reason: `昵称像 bot 名（命中「${look.marker}」）` };
}
