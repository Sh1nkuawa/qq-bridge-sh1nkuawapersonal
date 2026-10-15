// B 站字幕：抓取 → 清洗 → 分层压缩（长字幕适配）→ 缓存 + 按时间分页
//
// 2026-10-15 真机实测（登录态下，BV1Cgpd6pEBR / 44 分钟）：
//   x/player/wbi/v2?aid=&cid=&bvid=  ← **明文调用即可（不需要 WBI 签名）**，code=0
//   need_login_subtitle=false，字幕 1 条：ai-zh(中文)
//   1529 条 cue / 原始 JSON 221,494 字（大部分是时间元数据）/ **正文 14,058 字**
//   ⇒ 44 分钟 ≈ 14k 字；10 分钟 ≈ 3k 字；60 分钟 ≈ 2 万字（≈2 万 token，直接塞进一轮会炸）
//
// 长字幕适配借鉴 **SmartNote 项目**（本机 D:\SmartNote，课程实训项目，仅借鉴思路/参数/正则，未抄代码）：
//   - 稿本格式 `[mm:ss] 内容`（SubtitleCueUtil）
//   - 单条清洗去赘词/语气词（同上的 FILLER_PHRASE 思路）
//   - 超长时**按时间桶均匀抽样**，每桶取开头一段，桶数 = max(6, ceil(总长/预算)*4)
//   - 提示词必须声明"这是全片代表性抽样"，否则模型会把亮点全堆在开头
//   - 分段（章节）按字符预算**在 cue 边界**切块
// 与它不同的地方（场景不同）：它是服务端一次性生成笔记（单次可喂 14k 字），
// 我们是群聊里插话 ⇒ 进 prompt 的只放 ~2.5k 字的精编稿，全文留在缓存里按需分页。

import fs from 'node:fs';
import path from 'node:path';

const VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const PAGELIST_API = 'https://api.bilibili.com/x/player/pagelist';
const PLAYER_WBI = 'https://api.bilibili.com/x/player/wbi/v2';
const PLAYER_PLAIN = 'https://api.bilibili.com/x/player/v2';

const HTML_RE = /<[^>]+>/g;
// 赘词短语：这些在口播里极多，去掉不影响语义，纯降 token
const FILLER_RE = /(，\s*(那个|然后|就是说|其实|我觉得|大家知道))+/g;
const BREATH_RE = /(^|[。！？\s])(啊|嗯|哈|呃)([，。！？\s])/g;
const DUP_PUNCT_RE = /([，。！？])\s*[，。！？]+/g;

/** 单条字幕清洗（去 HTML / 赘词 / 语气词 / 叠标点），不碰时间字段 */
export function cleanCueContent(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(HTML_RE, ' ');
  s = s.replace(FILLER_RE, '，');
  s = s.replace(BREATH_RE, '$1$3');
  s = s.replace(DUP_PUNCT_RE, '$1');
  // 去语气词后会留下前导逗号（'嗯，今天…' → '，今天…'），顺手清掉首尾的噪声标点
  s = s.replace(/^[，。！？、；：\s]+/, '').replace(/[，、；：\s]+$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** mm:ss（超过一小时给 h:mm:ss，免得 90 分钟显示成 90:00 看不懂） */
export function formatMmSs(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** 把字幕 JSON 解析成 cue 列表（带清洗） */
export function parseSubtitleBody(jsonText) {
  let body = null;
  try { body = JSON.parse(jsonText); } catch { return []; }
  const arr = Array.isArray(body?.body) ? body.body : [];
  const cues = [];
  for (const line of arr) {
    const content = cleanCueContent(line?.content);
    if (!content) continue;
    const from = Number(line?.from) || 0;
    const to = Number(line?.to);
    cues.push({ from, to: Number.isFinite(to) ? to : from, content });
  }
  return cues;
}

/** 稿本：每行 `[mm:ss] 内容` */
export function buildTimestampedScript(cues) {
  if (!Array.isArray(cues) || !cues.length) return '';
  return cues.map((c) => `[${formatMmSs(c.from)}] ${c.content}`).join('\n').trim();
}

/** 正文（不带时间轴的纯文本，用于粗略计数/兜底） */
export function plainText(cues) {
  if (!Array.isArray(cues) || !cues.length) return '';
  return cues.map((c) => c.content).join(' ');
}

/**
 * 超长时按**时间桶均匀抽样**：覆盖全片时长且不超字符预算。
 * 桶数 = max(6, ceil(全稿长 / 预算) * 4)（照 SmartNote 的公式：预算越紧、桶越多，保证均匀）
 * 每桶预算 = max(64, 预算 / 桶数)，每桶只从桶首往后取，取满即止。
 */
export function sampleByTimeBuckets(cues, maxChars) {
  const full = buildTimestampedScript(cues);
  if (!Array.isArray(cues) || !cues.length || !(maxChars > 0)) return { text: '', sampled: false, buckets: 0 };
  if (full.length <= maxChars) return { text: full, sampled: false, buckets: 0 };
  const videoEnd = cues.reduce((m, c) => Math.max(m, Number(c.to) || 0), 0);
  if (!(videoEnd > 0)) return { text: full.slice(0, maxChars), sampled: true, buckets: 0 };
  // 桶数先按"预算越紧、桶越多"估一个，但**必须反过来服从预算**：
  // 若每桶摊到的字符少于 MIN_PER_BUCKET，就减少桶数 ——
  // 否则 max(64, 预算/桶数) 那个地板会让总长超过预算，最后只能暴力截断，
  // 结果**结尾段整段丢失**（离线回归抓到过：预算 2500、92 个桶 → 实际 4416 字被截到 2500）。
  const MIN_PER_BUCKET = 80;
  let bucketCount = Math.min(cues.length, Math.max(6, Math.ceil(full.length / maxChars) * 4));
  if (Math.floor(maxChars / bucketCount) < MIN_PER_BUCKET) {
    bucketCount = Math.max(6, Math.floor(maxChars / MIN_PER_BUCKET));
  }
  const perBucket = Math.max(MIN_PER_BUCKET, Math.floor(maxChars / bucketCount));
  const out = [];
  for (let b = 0; b < bucketCount; b += 1) {
    const start = (videoEnd * b) / bucketCount;
    const end = (videoEnd * (b + 1)) / bucketCount;
    let used = 0;
    for (const cue of cues) {
      if (cue.from < start || cue.from >= end) continue;
      const line = `[${formatMmSs(cue.from)}] ${cue.content}\n`;
      if (used + line.length > perBucket && used > 0) break;
      out.push(line);
      used += line.length;
    }
  }
  const text = out.join('').trim();
  if (!text) return { text: full.slice(0, maxChars), sampled: true, buckets: bucketCount };
  return { text: text.length <= maxChars ? text : text.slice(0, maxChars), sampled: true, buckets: bucketCount };
}

/**
 * 分层产出"给模型看的那段"（长字幕适配的核心）。
 * mode: raw（原文）/ sampled（抽样稿）/ outline（太长，只给骨架 + 抽样开头）
 * 返回的 text **自带一句声明**，防止模型把抽样稿当全文引用。
 */
export function buildSubtitleBrief(subtitle, { injectMaxChars = 2500, outlineThreshold = 12000 } = {}) {
  const cues = subtitle?.cues ?? [];
  const totalChars = plainText(cues).length;
  if (!cues.length) return { mode: 'empty', text: '', totalChars: 0, usedChars: 0, buckets: 0 };
  const full = buildTimestampedScript(cues);
  const head = `《${subtitle.title || subtitle.bvid}》B 站 AI 字幕（${formatMmSs(subtitle.duration || cues.at(-1)?.to || 0)}，正文约 ${totalChars} 字）`;

  if (totalChars <= injectMaxChars && full.length <= injectMaxChars * 1.6) {
    return { mode: 'raw', text: `${head}\n[字幕全文]\n${full}`, totalChars, usedChars: full.length, buckets: 0 };
  }
  const sampled = sampleByTimeBuckets(cues, injectMaxChars);
  const sampledNote = sampled.sampled
    ? `[注意] 下面是**全片代表性抽样**（按时间均匀取了 ${sampled.buckets} 个时段，各时段均有采样）；`
      + '请据此概括全片，提到的要点须**分布在全片前中后段**，不要都集中在开头。'
    : '[字幕全文]';
  if (totalChars <= outlineThreshold) {
    return { mode: sampled.sampled ? 'sampled' : 'raw', text: `${head}\n${sampledNote}\n${sampled.text}`, totalChars, usedChars: sampled.text.length, buckets: sampled.buckets };
  }
  // 超长：骨架（开头 + 结尾）+ 全片抽样，总长**必须**守住 injectMaxChars（实测踩过：
  // 不把骨架算进预算，预算 2500 会返回 3642 字 ✗ —— 那这个"上限"就没意义了）
  const header = `${head}\n[视频很长（正文约 ${totalChars} 字，约 ${Math.round(totalChars / 400)} 分钟口播）]`
    + '\n下面是**骨架**：开头片段 + 结尾片段 + 全片均匀抽样，够你概括全片。'
    + '（不必逐句精确，抓住主干、别把抽样段当成原话引用即可。）';
  const tailChars = Math.min(400, Math.floor(injectMaxChars * 0.15));
  const headChars = Math.min(600, Math.floor(injectMaxChars * 0.2));
  const sampleBudget = Math.max(200, injectMaxChars - header.length - headChars - tailChars - 40);
  const sampledFit = sampleByTimeBuckets(cues, sampleBudget);
  const outline = `${header}\n\n[开头]\n${full.slice(0, headChars)}`
    + `\n\n[全片抽样]\n${sampledFit.text}`
    + `\n\n[结尾]\n${full.slice(-tailChars)}`;
  return {
    mode: 'outline',
    text: outline.length <= injectMaxChars + 60 ? outline : outline.slice(0, injectMaxChars),
    totalChars,
    usedChars: Math.min(outline.length, injectMaxChars),
    buckets: sampledFit.buckets
  };
}

/** 分页：按时间取一段原文（给 qq_bili_subtitle 工具用） */
export function pageSubtitle(subtitle, { fromSec = 0, maxChars = 4000 } = {}) {
  const cues = subtitle?.cues ?? [];
  const start = Math.max(0, Number(fromSec) || 0);
  const picked = [];
  let used = 0;
  let lastCue = null;
  for (const cue of cues) {
    if ((Number(cue.to) || 0) < start) continue;   // 整条都在起点之前 → 跳过
    const line = `[${formatMmSs(cue.from)}] ${cue.content}\n`;
    if (used + line.length > maxChars && used > 0) break;
    picked.push(line);
    used += line.length;
    lastCue = cue;
  }
  return {
    fromSec: start,
    nextFromSec: lastCue ? Math.ceil(Number(lastCue.to) || 0) : null,
    text: picked.join('').trim(),
    returnedChars: used,
    totalChars: plainText(cues).length
  };
}

/** 落盘路径（每个分 P 一个文件） */
export function subtitleCachePath(cacheDir, bvid, page = 1) {
  return path.join(cacheDir, `${bvid}${page > 1 ? `-p${page}` : ''}.json`);
}

/**
 * 抓字幕（含缓存）。
 * 返回 { ok, reason, subtitle }：
 *   ok=true  → subtitle = { bvid, title, duration, lan, lanDoc, ai, fetchedAt, cues }
 *   ok=false → reason ∈ no-login / need-login / no-subtitle / api-error / too-long
 */
export async function fetchSubtitle(bvid, { auth, cacheDir, page = 1, force = false, ttlMinutes = 10080, maxCharsHard = 200000, log = () => {} } = {}) {
  const id = String(bvid ?? '').trim();
  if (!/^BV[0-9A-Za-z]{6,}$/i.test(id)) return { ok: false, reason: 'bad-bvid' };
  const cacheFile = subtitleCachePath(cacheDir, id, page);

  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const ageMinutes = (Date.now() - (Number(cached?.fetchedAt) || 0)) / 60000;
      if (cached?.cues?.length && ageMinutes <= ttlMinutes) return { ok: true, cached: true, subtitle: cached };
    } catch { /* 没缓存或坏了，继续抓 */ }
  }

  const status = await auth.status();
  if (!status.loggedIn) return { ok: false, reason: 'no-login' };

  try {
    const viewRes = await auth.request(`${VIEW_API}?bvid=${id}`);
    const view = await viewRes.json();
    const data = view?.data;
    if (view?.code !== 0 || !data) return { ok: false, reason: 'api-error', message: `view code=${view?.code}` };

    let cid = Number(data.cid) || 0;
    const pages = Array.isArray(data.pages) ? data.pages : [];
    if (pages.length > 1) {
      // 多 P：按 pagelist 解析目标分 P 的 cid（照 SmartNote 的做法）
      const pgRes = await auth.request(`${PAGELIST_API}?aid=${data.aid}&bvid=${id}`);
      const pg = await pgRes.json();
      const target = pg?.data?.find((p) => Number(p.page) === Number(page)) ?? pg?.data?.[0];
      if (target?.cid) cid = Number(target.cid);
    }
    if (!cid) return { ok: false, reason: 'api-error', message: '拿不到 cid' };

    // 主路径 wbi/v2（实测**不需要 WBI 签名**），失败退回老接口
    let player = null;
    for (const url of [`${PLAYER_WBI}?aid=${data.aid}&cid=${cid}&bvid=${id}`, `${PLAYER_PLAIN}?aid=${data.aid}&cid=${cid}&bvid=${id}`]) {
      try {
        const r = await auth.request(url);
        const j = await r.json();
        if (j?.code === 0 && j?.data) { player = j.data; break; }
      } catch { /* 试下一个 */ }
    }
    if (!player) return { ok: false, reason: 'api-error', message: 'player 接口都失败' };
    if (player.need_login_subtitle === true) return { ok: false, reason: 'need-login' };

    const subs = Array.isArray(player?.subtitle?.subtitles) ? player.subtitle.subtitles : [];
    if (!subs.length) return { ok: false, reason: 'no-subtitle' };
    // 优先 AI 中文字幕 → 任意中文字幕 → 第一条
    const pick = subs.find((s) => s.ai_status === 1 && /zh/i.test(String(s.lan)))
      ?? subs.find((s) => /zh/i.test(String(s.lan)))
      ?? subs[0];

    let url = String(pick.subtitle_url ?? '');
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://api.bilibili.com' + url;
    if (!url) return { ok: false, reason: 'api-error', message: '字幕没有 url' };

    const raw = await (await auth.request(url)).text();
    const cues = parseSubtitleBody(raw);
    if (!cues.length) return { ok: false, reason: 'no-subtitle' };
    const chars = plainText(cues).length;
    if (chars > maxCharsHard) return { ok: false, reason: 'too-long', message: `正文 ${chars} 字` };

    const subtitle = {
      bvid: id,
      page: Number(page) || 1,
      title: String(data.title ?? ''),
      duration: Number(data.duration) || Math.ceil(cues.at(-1)?.to ?? 0),
      lan: String(pick.lan ?? ''),
      lanDoc: String(pick.lan_doc ?? ''),
      // 实测：lan 形如 `ai-zh` 时 ai_status 可能不是 1（BV1Cgpd6pEBR 就是），所以两个信号一起看
      ai: pick.ai_status === 1 || /^ai-/i.test(String(pick.lan ?? '')),
      chars,
      fetchedAt: Date.now(),
      cues
    };
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(subtitle), 'utf8');
    } catch (error) {
      log(`[bili-subtitle] 写缓存失败：${error?.message ?? error}`);
    }
    return { ok: true, cached: false, subtitle };
  } catch (error) {
    return { ok: false, reason: 'api-error', message: String(error?.message ?? error).slice(0, 160) };
  }
}
