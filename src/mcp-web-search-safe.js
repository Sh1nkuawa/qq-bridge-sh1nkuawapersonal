// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Tavily API key：环境变量优先，其次 config.json（config.json 在 .gitignore 里，不入库） */
function tavilyKey() {
  const fromEnv = process.env.TAVILY_API_KEY;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const c = loadConfig();
  const key = c?.webSearch?.tavilyApiKey;
  return key && String(key).trim() ? String(key).trim() : '';
}

/**
 * Tavily 搜索（主力）。它是给 AI 用的搜索 API，返回已经抽好的正文片段，
 * 对"生僻中文人名/小机构"这类 Bing 完全查不到的查询效果好得多。
 * 实测同一句「孙景昊 山东大学 导师」：Bing 只给《孙（汉语汉字）_百度百科》，
 * Tavily 第一条就是 faculty.sdu.edu.cn 的教师主页。失败时由上层落回 Bing。
 */
async function tavilySearch(query, maxResults = 8) {
  const key = tavilyKey();
  if (!key) return { results: [], skipped: 'no-key' };
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: false }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 不要把 key 回显到任何地方
    throw new Error(`Tavily HTTP ${res.status}${data?.detail ? `：${String(data.detail).slice(0, 120)}` : ''}`);
  }
  const results = (data?.results ?? [])
    .map((r) => ({
      title: String(r.title ?? '').slice(0, 200),
      url: String(r.url ?? ''),
      snippet: String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 400),
      score: typeof r.score === 'number' ? Number(r.score.toFixed(3)) : undefined
    }))
    .filter((r) => r.title && /^https?:\/\//i.test(r.url));
  return { results, answer: typeof data?.answer === 'string' ? data.answer.slice(0, 600) : '' };
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// HTML → 纯文本
// 背景：原实现把原始 HTML 直接丢给模型，50000 字符配额会被 <script>/<link>/<meta>
// 和导航栏吃光，正文根本进不来（truncated=true 却什么都读不到），导致 agent 换好几个
// 搜索引擎反复抓取仍然查不到内容、最后放弃。这里做一次像样的正文提取。
// ---------------------------------------------------------------------------
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwj: '', zwnj: '',
  hellip: '…', mdash: '—', ndash: '–', minus: '−',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  middot: '·', bull: '•', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  ne: '≠', le: '≤', ge: '≥', infin: '∞', radic: '√', sum: '∑', prod: '∏',
  loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦',
  star: '★', starf: '★', check: '✓', cross: '✗',
};

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

/** 把 HTML 转成可读纯文本；同时抽出 <title> 和链接 */
function htmlToText(html) {
  let s = String(html ?? '');

  // 去掉注释和「一定不是正文」的整块内容
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // 自闭合或未闭合的同类标签残留
  s = s.replace(/<(script|style|noscript|link|meta|svg)\b[^>]*\/?>/gi, ' ');
  // Bing/Google 这类搜索页会在头部塞**未闭合**的 <script>（没有 </script>），
  // 上面的配对正则清不掉，残留的 JS 会挤占正文配额。这里逐块扫描：只删真正没有闭合标签的 script。
  s = removeUnclosedBlocks(s, 'script');
  s = removeUnclosedBlocks(s, 'style');

  // 标题：优先 og:title，其次 <title>
  const titleMatch =
    s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  // 去掉 head、页眉页脚侧栏等
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside|form|figure)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  // 块级/换行标签 → 换行，保留段落结构；<br> 单独处理
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|dd|dt|ul|ol|table|pre)\s*>/gi, '\n');
  s = s.replace(/<(p|div|section|article|li|tr|h[1-6]|blockquote|dd|dt|ul|ol|table|pre)\b[^>]*>/gi, '\n');
  // 单元格/Tab 分隔
  s = s.replace(/<\/(td|th)\s*>/gi, '\t');

  // 其余标签直接剥掉
  s = s.replace(/<[^>]*>/g, ' ');

  // 实体解码 + 空白规整
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t\u00a0\u2000-\u200b\u3000]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  // 兜底：某些站点（典型是 Bing/Google 搜索结果页）会在正文里漏出内联脚本或样式片段，
  // 单靠标签匹配清不干净。这里按行丢掉「明显是代码/样式」的行，避免它们挤占正文配额。
  s = s.split('\n').filter((line) => !looksLikeCode(line)).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return { title, text: s };
}

/** 判断一行是否明显是 JS/CSS 代码而不是人话 */
function looksLikeCode(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.length > 300) {
    // 超长单行且代码符号密集 → 基本是压缩过的脚本
    const codeChars = (t.match(/[{};=()<>[\]]/g) || []).length;
    if (codeChars / t.length > 0.12) return true;
  }
  const markers = [
    'function(', 'function (', '=>{', '(){', '};', 'var ', 'let ', 'const ',
    'window.', 'document.', '_G.', 'sj_evt', 'CDATA', 'use strict',
    'querySelector', 'addEventListener', 'prototype', 'return ',
    '@media', 'px;}', 'background:', 'font-family:', 'display:flex',
  ];
  return markers.some((m) => t.includes(m));
}

/** 逐个扫描某种块级标签（script/style），删掉「没有配对自己闭合标签」的那些块 */
function removeUnclosedBlocks(html, tag) {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
  let out = '';
  let last = 0;
  let m;
  openRe.lastIndex = 0;
  while ((m = openRe.exec(html))) {
    const block = m[0];
    if (/\/>\s*$/.test(block)) {           // 自闭合，直接删
      out += html.slice(last, m.index);
      last = m.index + block.length;
      continue;
    }
    const tail = html.slice(m.index + block.length);
    const closeAt = tail.search(closeRe);
    const nextOpen = tail.search(openRe);
    // 后面根本没有闭合标签，或闭合标签出现在下一个 open 之后（说明本块未闭合）
    if (closeAt === -1 || (nextOpen !== -1 && nextOpen < closeAt)) {
      out += html.slice(last, m.index) + ' ';
      last = m.index + block.length;
      continue;
    }
    const end = m.index + block.length + closeAt;
    const closeMatch = tail.slice(closeAt).match(closeRe)[0];
    out += html.slice(last, m.index) + ' ';
    last = end + closeMatch.length;
    openRe.lastIndex = last;
  }
  out += html.slice(last);
  return out;
}

/** 从网页里抽 http(s) 链接，方便 agent 顺着链接继续查 */
function extractLinks(html, limit = 30) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const href = decodeEntities(m[1]).trim();
    if (!/^https?:\/\//i.test(href)) continue;
    if (seen.has(href)) continue;
    const text = decodeHtml(m[2]);
    if (!text) continue;
    seen.add(href);
    out.push({ text: text.slice(0, 120), url: href });
  }
  return out;
}

/**
 * 相关性打分：结果标题/摘要里出现了多少查询词。
 * 为什么需要它：Bing 的 RSS 接口对中文查询会退化成"首字"结果
 * （实测「孙景昊 山东大学 导师 评价」→ 全是《孙（汉语汉字）_百度百科》《孙姓》），
 * 但它照样返回 HTTP 200 + 一堆 item，所以"RSS 有结果就用"是错的。
 * 这里用查询里的实词（中文 2 字以上片段、英文/数字词）去命中，命中太少就认为结果不可信。
 */
function relevanceScore(results, query) {
  const terms = [];
  const q = String(query ?? '');
  // 英文/数字词
  for (const m of q.matchAll(/[A-Za-z0-9]{2,}/g)) terms.push(m[0].toLowerCase());
  // 中文连续片段（≥2 字），并拆出相邻 2 字组合，兼顾分词未知的情况
  for (const m of q.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    terms.push(seg);
    for (let i = 0; i + 1 < seg.length; i += 1) terms.push(seg.slice(i, i + 2));
  }
  // 去掉纯引号/空格之类的噪声
  const uniq = [...new Set(terms.filter((t) => t.length >= 2))];
  if (!uniq.length) return 1; // 查询本身没有可用词（例如单个汉字），不做判断
  let hit = 0;
  for (const r of results) {
    const hay = `${r.title ?? ''} ${r.snippet ?? ''} ${r.url ?? ''}`.toLowerCase();
    if (uniq.some((t) => hay.includes(t))) hit += 1;
  }
  return hit / results.length;
}

async function bingSearchRss(query) {
  const rssUrl = new URL('https://cn.bing.com/search');
  rssUrl.searchParams.set('format', 'rss');
  rssUrl.searchParams.set('q', query);
  const res = await safeFetch(rssUrl.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) return [];
  return parseRssItems(res.body, 10);
}

async function bingSearch(query) {
  // 来源顺序：Tavily（若配了 key）→ Bing HTML 结果页 → Bing RSS。
  // 2026-09-26 两次修正：
  //   1) 原来 RSS 优先，而 Bing RSS 对中文查询会返回 200 + 一堆"首字百科"垃圾，
  //      把真正有排序价值的 HTML 结果永久挡住；
  //   2) Bing 对生僻中文人名/小机构（实测「孙景昊 山东大学 导师」「李伟湋 南京航空航天大学」）
  //      压根没有可用结果，于是接入 Tavily 作为主力。
  const candidates = [];
  let htmlCount = 0;
  let rssCount = 0;
  let tavilyError = '';
  let tavilyCount = 0;
  // [qq-bridge 本地补丁] 三个来源的失败原因都留下来：全都失败时必须让模型看到**为什么**失败
  // （例如"内网地址/重定向被拒""DNS 解析失败"），而不是回一个空的 results 让它以为"网上没这内容"。
  const errors = [];
  try {
    const tavily = await tavilySearch(query);
    tavilyCount = tavily.results.length;
    if (tavilyCount) candidates.push({ results: tavily.results, source: 'tavily', answer: tavily.answer });
  } catch (error) {
    tavilyError = String(error?.message ?? error);
    errors.push(`tavily: ${tavilyError}`);
  }
  // Tavily 命中且相关性够高时就不必再打 Bing 了（省一次网络往返）。
  const tavilyOk = candidates.length > 0 && relevanceScore(candidates[0].results, query) >= 0.5;
  if (!tavilyOk) {
    try {
      const html = await bingSearchHtml(query);
      htmlCount = html.results.length;
      if (htmlCount) candidates.push({ results: html.results, source: 'bing-html' });
    } catch (error) { errors.push(`bing-html: ${String(error?.message ?? error)}`); /* 落到 RSS */ }
    try {
      const items = await bingSearchRss(query);
      rssCount = items.length;
      if (rssCount) candidates.push({ results: items, source: 'bing-rss' });
    } catch (error) { errors.push(`bing-rss: ${String(error?.message ?? error)}`); /* 都不行就返回空 */ }
  }

  if (!candidates.length) {
    return {
      query, results: [], source: 'none',
      counts: { tavily: tavilyCount, html: htmlCount, rss: rssCount },
      ...(tavilyError ? { tavilyError } : {}),
      ...(errors.length ? { errors } : {})
    };
  }

  // 选相关性最高的一份；并列时按加入顺序（Tavily 优先）。
  let best = candidates[0];
  let bestScore = relevanceScore(best.results, query);
  for (const c of candidates.slice(1)) {
    const s = relevanceScore(c.results, query);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  const out = {
    query,
    results: best.results,
    source: best.source,
    relevance: Number(bestScore.toFixed(2)),
    counts: { tavily: tavilyCount, html: htmlCount, rss: rssCount }
  };
  if (best.answer) out.answer = best.answer;
  if (tavilyError) out.tavilyError = tavilyError;
  // [qq-bridge 本地补丁] 把"这堆结果多半不是你要的"直接告诉模型。
  // 起因：查一个生僻中文人名（导师）时，Bing 无论 RSS 还是 HTML 都返回"姓氏/汉字百科"，
  // 但工具只回一堆看起来像结果的东西，模型不知道是垃圾，于是连换 6 个关键词、抓了 8 个页面。
  // 相关性低时明确提示它换策略：直接抓官网/权威站点，而不是继续换搜索引擎。
  if (bestScore < 0.5) {
    out.warning = `搜索结果与查询的相关性很低（relevance=${out.relevance}，source=${out.source}），很可能不是你想要的内容`
      + '——搜索服务对生僻中文人名/小机构常常只返回"姓氏/汉字/地名百科"。'
      + '建议换策略：① 用 web_fetch 直接抓官网或权威页面（学校院系主页、教师主页、学术主页、公司官网）；'
      + '② 改用更通用的关键词（去掉人名，改搜机构+职位）；'
      + '③ 或者直接告诉群友"搜不到公开资料"，不要反复换搜索引擎空转。';
  }
  return out;
}

/** 解析 RSS/Atom，抽出标题/链接/摘要 */
function parseRssItems(xml, limit = 10) {
  const out = [];
  const blocks = String(xml ?? '').split(/<item\b/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/item\s*>/i)[0];
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i'));
      if (!m) return '';
      return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
    };
    const title = pick('title');
    let link = pick('link');
    if (!link) {
      const m = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (m) link = decodeEntities(m[1]).trim();
    }
    const desc = pick('description').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title && /^https?:\/\//i.test(link)) {
      out.push({ title, url: link, snippet: desc.slice(0, 400) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function bingSearchHtml(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.7' });

server.tool(
  'web_search',
  '只读网络搜索，返回标题/URL/摘要（主力是 Tavily 搜索 API，未配置或失败时落回 Bing）。'
  + '普通话题（产品、价格、新闻、概念、梗）以及"某人在某机构的公开资料"这类查询通常很好用。'
  + '结果里会带 relevance（相关性 0~1）和 source；若出现 warning，说明这次结果多半不是你要的，'
  + '别继续换关键词空转——改用 web_fetch 直接抓官网/权威页面（院系主页、教师主页、公司官网），'
  + '或如实说搜不到。不执行任何本地操作。',
  { query: z.string().describe('搜索词；中文人名建议带上机构一起搜（例如"孙景昊 山东大学"）') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      // 三个来源全失败 ⇒ 这是**失败**，不是"网上没这内容"：必须回 isError 把原因说清楚，
      // 否则模型会把空结果当成事实依据（"搜不到相关资料"）继续往下说。
      if (Array.isArray(result?.results) && result.results.length === 0) {
        const why = Array.isArray(result.errors) && result.errors.length
          ? result.errors.join('；')
          : '所有搜索来源都没有返回结果';
        return { content: [{ type: 'text', text: `搜索失败：${why}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页并提取正文纯文本（脚本/样式/导航已剔除，另附页面标题与可继续访问的链接）。'
  + '禁止访问内网/本机地址，不执行任何本地操作。需要看原始 HTML 时可传 raw=true。',
  {
    url: z.string().describe('要抓取的 http(s) URL'),
    maxChars: z.number().optional().describe('正文最大字符数，默认 40000'),
    raw: z.boolean().optional().describe('true 则返回未经提取的原始 HTML（默认 false）'),
  },
  async ({ url, maxChars, raw }) => {
    try {
      const result = await safeFetch(url);
      const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.min(maxChars, 200000) : 40000;
      const isHtml = /html|xml/i.test(String(result.contentType || ''))
        || /^\s*<(!doctype|html|head|\?xml)/i.test(String(result.body || ''));

      if (raw || !isHtml) {
        const body = String(result.body ?? '');
        const out = {
          url: result.url ?? url,
          statusCode: result.statusCode,
          contentType: result.contentType,
          truncated: result.truncated || body.length > limit,
          body: body.slice(0, limit),
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }

      const { title, text } = htmlToText(result.body);
      const links = extractLinks(result.body, 30);
      const out = {
        url: result.url ?? url,
        statusCode: result.statusCode,
        title,
        contentChars: text.length,
        truncated: text.length > limit,
        text: text.slice(0, limit),
        links: links.length ? links : undefined,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
