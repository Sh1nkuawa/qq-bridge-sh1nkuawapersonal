// QQ 分享卡片 / 小程序卡片 → 抽出「来源 + 标题 + 链接」的可读文本。
//
// [qq-bridge 本地补丁 2026-10-12] 背景：以前 `json` 段一律被压成 `[卡片消息]`
// （src/bridge.js 的 case 'json'、src/forward.js 同款），**链接被丢掉**，于是群友发来
// B 站卡片时模型只看到四个字，根本没法去读。本模块只做**纯解析**（不联网、不花 token）：
//   - 文本里带上 URL → 模型用已有的 mcp__web-search-safe__web_fetch 就能读通用网页
//   - B 站视频的元信息（标题/UP/时长/简介）另由 src/link-bilibili.js 预取后走唤醒提示注入
//
// 设计原则：**永不抛异常、永不返回空**。解析不出来就回退成老的 `[卡片消息]`，
// 保证任何畸形卡片都不会改变现有行为。

const TRACKING_PARAMS = [
  'share_source', 'share_medium', 'share_plat', 'share_tag', 'share_session_id',
  'bbid', 'ts', 'vd_source', 'spm_id_from', 'from_source', 'unique_k',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'
];
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|ico)(\?|$)/i;
// QQ 卡片自带的缩略图 CDN：不是"内容链接"，别把它当链接交出去
const THUMB_HOST_RE = /(multimedia\.nt\.qq\.com\.cn|puui\.qpic\.cn|gxh\.vip\.qq\.com|hdslb\.com|i\d\.hdslb\.com)/i;

/** 规整 URL：反转义、去掉跟踪参数、只留 http(s)。不合规返回 ''。 */
export function normalizeUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    // 空 query 就别留个孤零零的 "?"
    let out = u.toString();
    out = out.replace(/\?(?=#|$)/, '');
    return out;
  } catch {
    return '';
  }
}

/** 从文本里抓 URL（去重、规整、滤掉图片直链）。 */
export function linksInText(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s，。；、）)】"'<>｜|]+/gi)) {
    const url = normalizeUrl(m[0]);
    if (!url || seen.has(url)) continue;
    if (IMAGE_EXT_RE.test(url)) continue;      // 图片直链不是"内容"
    if (THUMB_HOST_RE.test(url)) continue;     // QQ 卡片缩略图 CDN
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** 站点名（用于文案），识别不出来就留空。 */
export function siteLabel(url) {
  const u = String(url ?? '').toLowerCase();
  if (/bilibili\.com|b23\.tv/.test(u)) return 'B站';
  if (/weibo\.(com|cn)|t\.cn/.test(u)) return '微博';
  if (/xiaohongshu\.com|xhslink\.com/.test(u)) return '小红书';
  if (/zhihu\.com|zhihu\.link/.test(u)) return '知乎';
  if (/mp\.weixin\.qq\.com/.test(u)) return '公众号';
  if (/douyin\.com|iesdouyin\.com/.test(u)) return '抖音';
  if (/github\.com/.test(u)) return 'GitHub';
  if (/youtube\.com|youtu\.be/.test(u)) return 'YouTube';
  if (/steam|store\.steampowered/.test(u)) return 'Steam';
  return '';
}

/** B 站链接分类：视频(BV/av) / 番剧 / 专栏 / 短链 / 其他。 */
export function bilibiliRef(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === 'b23.tv' || host.endsWith('.b23.tv')) return { kind: 'short', raw: u.toString() };
  if (!/(^|\.)bilibili\.com$/.test(host)) return null;
  const bv = path.match(/\/video\/(BV[0-9A-Za-z]{8,})/);
  if (bv) return { kind: 'video', bvid: bv[1] };
  const av = path.match(/\/video\/av(\d+)/i);
  if (av) return { kind: 'video', aid: Number(av[1]) };
  const ep = path.match(/\/bangumi\/play\/(ep\d+|ss\d+)/i);
  if (ep) return { kind: 'bangumi', id: ep[1] };
  const cv = path.match(/\/read\/(cv\d+)/i);
  if (cv) return { kind: 'article', id: cv[1] };
  const dyn = path.match(/\/opus\/(\d+)/);
  if (dyn) return { kind: 'opus', id: dyn[1] };
  return { kind: 'other' };
}

/** 递归找卡片里"最像内容链接"的那个字段。 */
function pickUrlFromObject(obj) {
  const preferredKeys = ['qqdocurl', 'jumpUrl', 'jump_url', 'url', 'source_url', 'content_url'];
  const found = [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && preferredKeys.some((pk) => k.toLowerCase() === pk.toLowerCase())) {
        const url = normalizeUrl(v);
        if (url && !IMAGE_EXT_RE.test(url) && !THUMB_HOST_RE.test(url)) found.push({ key: k.toLowerCase(), url });
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(obj);
  if (!found.length) return '';
  // qqdocurl 是 B 站/公众号这类分享卡最靠谱的字段，优先
  const order = ['qqdocurl', 'jumpurl', 'jump_url', 'content_url', 'source_url', 'url'];
  for (const k of order) {
    const hit = found.find((f) => f.key === k);
    if (hit) return hit.url;
  }
  return found[0].url;
}

/** 递归找标题类字段。按权重取，且忽略**顶层** `desc`（那通常是 App 名，如"哔哩哔哩"✗）。 */
function pickTitleFromObject(obj) {
  const strong = ['title'];
  const weak = ['desc', 'description', 'summary', 'prompt'];
  const strongHits = [];
  const weakHits = [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const key = k.toLowerCase();
      if (typeof v === 'string' && v.trim()) {
        const text = v.trim();
        if (strong.includes(key)) strongHits.push(text);
        else if (weak.includes(key) && !(depth === 0 && (key === 'desc' || key === 'description'))) weakHits.push(text);
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(obj);
  return strongHits[0] ?? weakHits[0] ?? '';
}

/**
 * 解析卡片数据 → { url, title, app }；解析不出 url 时 url 为空串。
 * data 可以是对象，也可以是 JSON 字符串（QQ 的 json 段通常是字符串）。
 */
export function parseCard(data) {
  let obj = data;
  let rawText = '';
  if (typeof data === 'string') {
    rawText = data;
    try { obj = JSON.parse(data); } catch { obj = null; }
  } else if (data && typeof data === 'object') {
    // 有些实现把 data 包成 { data: "<json 字符串>" }
    if (typeof data.data === 'string') {
      rawText = data.data;
      try { obj = JSON.parse(data.data); } catch { obj = data; }
    }
  }
  let url = obj ? pickUrlFromObject(obj) : '';
  let title = obj ? pickTitleFromObject(obj) : '';
  if (!url && rawText) {
    // 兜底：直接在原始 JSON 文本里找第一个像样的 http 链接
    url = linksInText(rawText)[0] ?? '';
  }
  if (!title && rawText) {
    const m = rawText.match(/"(?:title|desc|prompt)"\s*:\s*"([^"]{2,80})"/);
    if (m) title = m[1];
  }
  const app = (obj && typeof obj === 'object' && typeof obj.app === 'string') ? obj.app : '';
  return { url, title: String(title).replace(/\\n/g, ' ').trim(), app };
}

/**
 * 把一个卡片 segment 变成给模型看的文本。
 * 有链接：`[B站卡片：标题] https://…`；没链接：回退 `[卡片消息]`（与旧行为一致）。
 */
export function cardSegmentText(seg) {
  try {
    const d = seg?.data ?? {};
    const { url, title } = parseCard(d);
    if (!url) return '[卡片消息]';
    const site = siteLabel(url);
    const label = site ? `${site}卡片` : '卡片';
    const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return t ? `[${label}：${t}] ${url}` : `[${label}] ${url}`;
  } catch {
    return '[卡片消息]';
  }
}

/** 给测试/排障用：把卡片原文里的关键字段抖出来（不改任何状态）。 */
export function describeCard(data) {
  const { url, title, app } = parseCard(data);
  return { url, title, app, site: siteLabel(url), ref: url ? bilibiliRef(url) : null };
}
