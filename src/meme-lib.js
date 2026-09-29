// 本地表情包库（dsh-meme 图库接入）——纯函数 + 只读索引。
//
// 背景：用户已有的 dsh-meme 插件（Web 端 send_meme）在 memes/<pack>/ 下带
// SQLite 索引（memes 表：path/tag/file_name/caption/keywords）与 manifest.json。
// 这套图库在 QQ 侧原本用不上：dsh-meme 的 QQ 通道依赖 dsh-companion 服务，
// 而 QQ 桥接是独立实现的。本模块把同一份图库“翻译”成 QQ 桥接能用的目录，
// 让 bot 能按情绪挑图、直接用图片消息发出去。
//
// 设计原则：
// - 只读：绝不修改 dsh-meme 的 index.db / 图片文件；
// - 情绪桶与 dsh-meme 保持一致（happy/angry/sad/shy/confused/daily），
//   AI 在 Web 端学到的选图习惯在 QQ 侧同样成立；
// - 使用统计写在自己这边（state/memes.json），用于去重/避免连着发同一张，
//   以及给提示词排序，不回写上游；
// - 找不到 SQLite 时退化为“按目录名当 tag、文件名当描述”，不至于整块功能失效。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const MEME_MOODS = {
  happy: ['happy', 'like', 'meow', 'givemoney', 'color'],
  angry: ['angry', 'fool', 'baka'],
  sad: ['sad', 'sigh'],
  shy: ['shy'],
  confused: ['confused', 'surprised', 'see'],
  daily: ['daily', 'sleep', 'morning', 'work', 'cpu', 'reply']
};

export const MEME_MOOD_WORDS = {
  happy: '开心 高兴 兴奋 喜欢 卖萌 可爱 比心 哈哈 欢迎 得意 好耶 满意 夸 庆祝',
  angry: '生气 愤怒 暴躁 笨蛋 傻瓜 嫌弃 逮 骂 烦',
  sad: '难过 哭 委屈 叹气 无语 求饶 怂 晕 可怜 惨',
  shy: '害羞 腼腆 脸红 花痴 不好意思 羞',
  confused: '困惑 疑惑 惊讶 问号 懵 惊吓 震惊 啥',
  daily: '困 睡觉 早上好 打招呼 你好 上班 下班 摸鱼 工作 熬夜 吃饭 干饭 饿 日常 晚安'
};

export const MEME_MOOD_DICT =
  'happy 开心(卖萌/可爱/喜欢/得意) / angry 生气(嫌弃/笨蛋) / sad 难过(无语/求饶) / shy 害羞 / confused 困惑惊讶 / daily 日常(睡觉/干饭/上班/早上好/晚安)';

export const DEFAULT_MEME_CFG = {
  enabled: true,
  packDirs: [],        // 空 = 自动探测（见 defaultPackDirs）
  packs: [],           // 只启用这些 pack id；空 = packDirs 下全部
  includeInPrompt: true,
  promptMaxMemes: 6,   // 提示词里列几张“最近可用”的示例
  maxPerMinute: 3,
  maxPerHour: 30,
  recentAvoid: 10,     // 随机挑选时避开最近发过的 N 张，减少复读感
  maxFileBytes: 8 * 1024 * 1024,
  maxCaptionChars: 80
};

export function mergeMemeConfig(raw) {
  const cfg = { ...DEFAULT_MEME_CFG, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.packDirs = (Array.isArray(cfg.packDirs) ? cfg.packDirs : []).map((d) => String(d ?? '').trim()).filter(Boolean);
  cfg.packs = (Array.isArray(cfg.packs) ? cfg.packs : []).map((p) => String(p ?? '').trim()).filter(Boolean);
  for (const key of ['promptMaxMemes', 'maxPerMinute', 'maxPerHour', 'recentAvoid', 'maxFileBytes', 'maxCaptionChars']) {
    const n = Number(cfg[key]);
    cfg[key] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MEME_CFG[key];
  }
  return cfg;
}

/** 自动探测图库根目录：dsh-meme 插件自带 memes/ 与用户自建 ~/.dsh/meme-packs。 */
export function defaultPackDirs(home = process.env.USERPROFILE || process.env.HOME || '') {
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
  const out = [];
  const push = (dir) => { if (dir && fs.existsSync(dir) && !out.includes(dir)) out.push(dir); };
  push(path.join(dshHome, 'meme-packs'));
  for (const profile of ['web', 'tui', 'cli', 'default']) {
    push(path.join(dshHome, 'profiles', profile, 'node_modules', 'dsh-meme', 'memes'));
  }
  // 兜底：profiles/*/node_modules/dsh-meme/memes（用户装了别的 profile 名）
  try {
    for (const name of fs.readdirSync(path.join(dshHome, 'profiles'))) {
      push(path.join(dshHome, 'profiles', name, 'node_modules', 'dsh-meme', 'memes'));
    }
  } catch { /* 没有 profiles 目录 */ }
  return out;
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

/** 用 node:sqlite 读一个 pack 的索引；不可用时返回 null（调用方走目录扫描兜底）。 */
function readPackRows(dir) {
  const { DatabaseSync } = loadSqlite() || {};
  const dbFile = path.join(dir, 'index.db');
  if (!DatabaseSync || !fs.existsSync(dbFile)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare("SELECT path, tag, COALESCE(caption,'') AS caption, COALESCE(keywords,'') AS keywords, file_name FROM memes").all();
    return rows.map((r) => ({
      rel: String(r.path || '').replace(/\\/g, '/'),
      tag: String(r.tag || '').trim().toLowerCase(),
      caption: String(r.caption || '').trim(),
      keywords: String(r.keywords || '').trim(),
      fileName: String(r.file_name || path.basename(String(r.path || '')))
    })).filter((r) => r.rel);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
  }
}

// node:sqlite 是实验 API，且本模块要能在旧 Node 上优雅降级：
// 用 createRequire 同步加载，失败就返回 null 让上层走目录扫描。
let sqliteModule = null;
let sqliteTried = false;
function loadSqlite() {
  if (!sqliteTried) {
    sqliteTried = true;
    try {
      sqliteModule = createRequire(import.meta.url)('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

/** 允许外部注入 node:sqlite（测试/降级用）。 */
export function setSqliteModule(mod) {
  sqliteModule = mod || null;
  sqliteTried = true;
}

/** 目录扫描兜底：memes/<tag>/*.(jpg|png|gif|webp) → 用 tag 与文件名做最简索引。 */
function scanDirRows(packDir) {
  const root = path.join(packDir, 'memes');
  const base = fs.existsSync(root) ? root : packDir;
  const out = [];
  let tags = [];
  try { tags = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const tag of tags) {
    let files = [];
    try { files = fs.readdirSync(path.join(base, tag)); } catch { continue; }
    for (const f of files) {
      if (!/\.(jpe?g|png|gif|webp|bmp)$/i.test(f)) continue;
      out.push({
        rel: `memes/${tag}/${f}`,
        tag: String(tag).toLowerCase(),
        caption: path.basename(f, path.extname(f)),
        keywords: '',
        fileName: f
      });
    }
  }
  return out;
}

/**
 * 扫描图库：返回 pack 列表（含各自 memes 行）。
 * @param {string[]} packDirs 根目录（其下每个子目录 = 一个 pack）
 * @param {{ allowIds?: string[] }} [options]
 */
export function scanMemePacks(packDirs, options = {}) {
  const allow = Array.isArray(options.allowIds) ? options.allowIds.filter(Boolean) : [];
  const packs = [];
  const seen = new Set();
  for (const root of packDirs) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const name of names) {
      if (allow.length && !allow.includes(name)) continue;
      if (seen.has(name)) continue; // 同名 pack 以先出现的根目录为准
      const dir = path.join(root, name);
      const manifest = readManifest(dir);
      const rows = readPackRows(dir) ?? scanDirRows(dir);
      if (!rows.length) continue;
      seen.add(name);
      packs.push({
        id: name,
        name: String(manifest.name || name),
        description: String(manifest.description || ''),
        dir,
        source: fs.existsSync(path.join(dir, 'index.db')) ? 'index' : 'dir',
        rows
      });
    }
  }
  return packs;
}

/** pack 列表 → 扁平目录（每张图一条，id 形如 dafeiyu-001:memes/happy/deyi.jpg）。 */
export function buildMemeCatalog(packs, cfg = DEFAULT_MEME_CFG) {
  const out = [];
  for (const pack of packs) {
    for (const row of pack.rows) {
      const abs = path.resolve(pack.dir, row.rel);
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; } // 索引里有、文件不在 = 跳过
      if (cfg.maxFileBytes && size > cfg.maxFileBytes) continue;
      out.push({
        id: `${pack.id}:${row.rel}`,
        packId: pack.id,
        packName: pack.name,
        rel: row.rel,
        abs,
        tag: row.tag,
        mood: moodOfTag(row.tag),
        caption: String(row.caption || row.fileName || '').slice(0, cfg.maxCaptionChars),
        keywords: row.keywords,
        size
      });
    }
  }
  return out;
}

/** 细 tag → 情绪桶（与 dsh-meme 的 MOODS 一致）。 */
export function moodOfTag(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return '';
  if (MEME_MOODS[t]) return t;
  for (const [mood, fine] of Object.entries(MEME_MOODS)) {
    if (fine.includes(t)) return mood;
  }
  return '';
}

/** 情绪解析：显式 tag 优先，其次从 query 的口语词推断。 */
export function resolveMood(tag, query) {
  const t = String(tag || '').trim().toLowerCase();
  if (t) {
    if (MEME_MOODS[t]) return t;
    for (const [mood, fine] of Object.entries(MEME_MOODS)) {
      if (fine.includes(t)) return mood;
    }
    return ''; // 未知 tag：不猜，交给调用方提示模型换一个
  }
  const q = String(query || '').trim().toLowerCase();
  if (!q) return '';
  if (MEME_MOODS[q]) return q;
  const hits = [];
  for (const [mood, words] of Object.entries(MEME_MOOD_WORDS)) {
    if (words.split(/\s+/).some((w) => w && q.includes(w))) hits.push(mood);
  }
  return hits[0] || '';
}

// ── 使用统计（本地，不回写上游） ───────────────────────────────────────────

export function emptyMemeStats() {
  return { version: 1, updatedAt: 0, entries: {} };
}

export function loadMemeStats(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) return emptyMemeStats();
    return { version: 1, updatedAt: Number(parsed.updatedAt) || 0, entries: parsed.entries };
  } catch {
    return emptyMemeStats();
  }
}

export function saveMemeStats(file, stats) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { version: 1, updatedAt: Date.now(), entries: stats?.entries && typeof stats.entries === 'object' ? stats.entries : {} };
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function markMemeUsed(stats, id, context = '', now = Date.now()) {
  const entries = stats?.entries && typeof stats.entries === 'object' ? stats.entries : {};
  const prev = entries[id] && typeof entries[id] === 'object' ? entries[id] : {};
  const next = {
    useCount: (Number(prev.useCount) || 0) + 1,
    lastUsedAt: now,
    lastContext: String(context || '').slice(0, 200)
  };
  return { version: 1, updatedAt: now, entries: { ...entries, [id]: next } };
}

/** 最近发过的表情 id（新 → 旧），用于抽样时避开复读。 */
export function recentMemeIds(stats, n = 10) {
  const entries = stats?.entries && typeof stats.entries === 'object' ? stats.entries : {};
  return Object.entries(entries)
    .map(([id, v]) => ({ id, at: Number(v?.lastUsedAt) || 0 }))
    .filter((x) => x.at > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, n))
    .map((x) => x.id);
}

// ── 抽样 ───────────────────────────────────────────────────────────────────

function shuffle(list, random) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 按情绪（或 query 推断的情绪）随机抽候选。
 * 优先抽“没怎么用过/很久没用”的图：先排除最近发过的，再按使用次数分两档，
 * 从低使用档里随机取；不够再放宽。
 *
 * @param {object[]} catalog buildMemeCatalog 的结果
 * @param {{tag?:string, query?:string, limit?:number, stats?:object, random?:() => number}} options
 */
export function sampleMemes(catalog, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const mood = resolveMood(options.tag, options.query);
  if (!mood) return { mood: '', memes: [], total: catalog.length };
  const pool = catalog.filter((m) => m.mood === mood);
  if (!pool.length) return { mood, memes: [], total: 0 };

  const stats = options.stats;
  const recent = new Set(recentMemeIds(stats, Number(options.recentAvoid) || DEFAULT_MEME_CFG.recentAvoid));
  const scored = pool.map((m) => ({ m, useCount: Number(stats?.entries?.[m.id]?.useCount) || 0 }));
  const tiers = [
    scored.filter((x) => !recent.has(x.m.id) && x.useCount === 0),
    scored.filter((x) => !recent.has(x.m.id) && x.useCount > 0),
    scored.filter((x) => recent.has(x.m.id))
  ];
  const picked = [];
  for (const tier of tiers) {
    if (picked.length >= limit) break;
    const rest = shuffle(tier.map((x) => x.m).filter((m) => !picked.includes(m)), random);
    picked.push(...rest.slice(0, limit - picked.length));
  }
  return { mood, memes: picked, total: pool.length };
}

/** 按 id / rel / 绝对路径找一张图；只认目录内条目，天然不会越界。 */
export function findMeme(catalog, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const norm = raw.replace(/\\/g, '/');
  return catalog.find((m) => m.id === raw || m.rel === norm || m.abs.replace(/\\/g, '/') === norm) || null;
}

// ── 提示词 ─────────────────────────────────────────────────────────────────

/** 注入唤醒提示的“本地表情包”策略说明（软策略，AI 自主决定发不发）。 */
export function buildMemeStrategyHint(hasStickerChannel = true) {
  return [
    '【本地表情包库：真正的梗图/表情包，按需发】',
    '- 你有一个本地表情包库（和 QQ 收藏表情是两套东西）：用 qq_send_meme 按情绪挑图，send 时用图片消息直接发出去，不占用 QQ 收藏表情。',
    '- 情绪桶（tag）：' + MEME_MOOD_DICT + '。先按当下气氛选桶，再在候选里挑 caption 最贴的那张。',
    '- 频率：像真人一样，每 3~5 轮来一张就够；热闹/玩梗时可以更密，但别刷屏，也别连着发同一张。',
    '- 发之前看 caption：拿不准就 action=view 看一眼再发，别瞎发。',
    '- 一条图片消息只有图，不能带文字：想说的话先用 qq_send_message / qq_reply 单独发一个气泡，再单独发图。',
    hasStickerChannel
      ? '- 两个库的分工：QQ 收藏表情（qq_send_sticker）是你平时惯用的表情；本地表情包库（qq_send_meme）适合更具体的梗/情绪，挑不到合适的就用回 QQ 收藏表情。'
      : '',
    '- 不要：严肃/敏感话题硬塞图；一条消息塞多张；把图当唯一回复敷衍人。'
  ].filter(Boolean).join('\n');
}

/** 注入唤醒提示的“可用表情包库”摘要（按情绪列出数量 + 最近常用的示例）。 */
export function buildMemeContext(catalog, stats, packs, max = 6) {
  if (!Array.isArray(catalog) || !catalog.length) return '';
  const counts = {};
  for (const m of catalog) counts[m.mood || '?'] = (counts[m.mood || '?'] || 0) + 1;
  const countLine = Object.entries(MEME_MOODS)
    .map(([mood]) => `${mood} ${counts[mood] || 0}`)
    .filter((s) => !s.endsWith(' 0'))
    .join(' / ');
  const top = [...catalog]
    .sort((a, b) => {
      const ua = Number(stats?.entries?.[a.id]?.useCount) || 0;
      const ub = Number(stats?.entries?.[b.id]?.useCount) || 0;
      return ub - ua;
    })
    .slice(0, Math.max(1, Math.min(20, Number(max) || 6)));
  const lines = top.map((m) => `- [${m.mood || m.tag}] ${m.caption || m.rel}（${m.packName}）`);
  const packNames = (Array.isArray(packs) ? packs : []).map((p) => `${p.name || p.id}(${p.rows.length})`).join('、');
  return `【可用表情包库】共 ${catalog.length} 张，来自 ${packNames || '本地图库'}；按情绪：${countLine || '（未分类）'}。\n常用示例：\n${lines.join('\n')}`;
}

/** 给 AI 看的一行候选描述。 */
export function formatMemeCandidate(m) {
  return `path=${m.id} | [${m.mood || m.tag}] ${m.caption || m.rel}`;
}

/** 提示词里给模型的简短工具说明（qq_get_prompt 用）。 */
export function describeMemeTool() {
  return 'qq_send_meme：本地表情包库。action=search 按情绪抽候选（tag 必填优先，可带 query），action=view 先看图，action=send + path 发出。';
}
