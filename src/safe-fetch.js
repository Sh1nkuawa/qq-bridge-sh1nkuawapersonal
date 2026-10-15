// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

/**
 * mihomo/clash 的 fake-ip 池（默认 198.18.0.0/15，RFC 2544 基准测试段）。
 *
 * 它**不是内网地址**，也无法路由到局域网：开了 fake-ip 的代理会在本地劫持这些地址、
 * 交给代理出网。把它当"内网"拦掉，会让**所有走代理的域名**都抓不到 ——
 * 2026-10-15 实测：群友发的 B 站短链 `b23.tv/xxx` 解析成 198.18.x.x 后被判
 * “域名解析到内网/本机地址，已阻止”，整条 B 站预取直接失效（连模型自己的 web_fetch 也一起被挡）。
 *
 * 默认放行；要恢复严格拦截就设环境变量 `QQB_SAFE_FETCH_FAKE_IP=deny`。
 */
export function isFakeIpPool(ip) {
  const h = String(ip || '').trim();
  if (net.isIP(h) !== 4) return false;
  const parts = h.split('.').map(Number);
  return parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19;
}

export const FAKE_IP_ALLOWED = String(process.env.QQB_SAFE_FETCH_FAKE_IP ?? 'allow').toLowerCase() !== 'deny';

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // fake-ip 池（198.18.0.0/15）：见 isFakeIpPool 的注释 —— 默认放行，否则走代理的域名全都抓不到
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return !FAKE_IP_ALLOWED;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

const REQUEST_TIMEOUT_MS = 20000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// 默认 User-Agent 必须是完整的浏览器 UA 字符串。
// 原先只发 'Mozilla/5.0'（11 个字符的裸 UA），所有搜索引擎的反爬都会直接判定为机器人：
// Bing 返回 200 但结果区为空、Mojeek 直接 403、部分站点超时 —— 这就是「联网查询查不出东西」的根因。
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

// 使用已校验的 IP 发起请求，保留原始 Host/SNI，禁止重新解析 DNS。
// 总时限包含 TCP/TLS、响应头和响应体；仅 socket idle timeout 无法阻止慢速滴流。
function requestOnce(url, ip, limit, binary = false, extraHeaders = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, REQUEST_TIMEOUT_MS);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: ip,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': extraHeaders?.['user-agent'] || DEFAULT_USER_AGENT,
          accept: extraHeaders?.accept
            || (binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(extraHeaders ? Object.fromEntries(
            Object.entries(extraHeaders).filter(([k]) => !['host', 'user-agent', 'accept', 'accept-language', 'connection'].includes(k.toLowerCase()))
          ) : {}),
        },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        response = res;
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('响应体读取中断')));
        res.on('close', () => {
          if (!res.complete) finish(new Error('响应体读取中断'));
        });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          finish(null, { statusCode, redirect: String(res.headers.location || '') });
          // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
          res.destroy();
          return;
        }
        const chunks = [];
        const decoder = binary ? null : new StringDecoder('utf8');
        let size = 0;
        const appendText = (text) => {
          const points = Array.from(text);
          const remaining = limit - size;
          chunks.push(points.slice(0, remaining).join(''));
          size += Math.min(points.length, remaining);
          if (size >= limit) {
            finish(null, { statusCode, body: chunks.join(''), truncated: true });
            res.destroy();
          }
        };
        res.on('data', (chunk) => {
          if (settled) return;
          if (!binary) { appendText(decoder.write(chunk)); return; }
          size += chunk.length;
          if (size > limit) {
            finish(new Error(`图片超过大小限制（${limit} 字节）`));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (binary) finish(null, { statusCode, buffer: Buffer.concat(chunks) });
          else {
            appendText(decoder.end());
            finish(null, { statusCode, body: chunks.join(''), truncated: false });
          }
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

export async function safeFetch(urlString, maxChars = 50000, options = null) {
  validateLimit(maxChars, 'maxChars');
  const extraHeaders = options?.headers ?? null;
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxChars, false, extraHeaders);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。 */
/**
 * QQ 内置表情（face）的图片候选 URL（纯函数，按优先级排序）。
 *
 * 为什么要这个：SnowLuma 给的 `face.url` 有一部分**已经 404**（返回 HTML 而不是图片），
 * 于是 safeFetchBuffer 的图片校验直接抛"抓取内容不是有效图片"，模型就只拿到文字描述、
 * 看不到这张表情。实测（2026-09-30）：
 *   https://qzonestyle.gtimg.cn/qzone/em/e498.gif      → 404 text/html   ✗
 *   https://qzonestyle.gtimg.cn/qzone/em/e400498.gif   → 200 image/png  ✓（同一个表情的另一种写法）
 * 所以按「原 URL → 补/去 400 前缀的变体 → 规范的 400 写法」依次尝试。
 * 注意：这些候选仍然全部走 safeFetchBuffer（含 SSRF/大小/格式校验），不会绕过防护。
 */
export function faceImageUrlCandidates(url, faceId) {
  const out = [];
  const push = (u) => { const s = String(u ?? '').trim(); if (s && !out.includes(s)) out.push(s); };
  const raw = String(url ?? '').trim();
  const id = Number(faceId);
  push(raw);
  // 同一路径上的 400 前缀变体：/em/e498.gif → /em/e400498.gif（反之亦然）
  const m = raw.match(/^(.*\/em\/e)(\d+)(\.[A-Za-z0-9]+)$/);
  if (m) {
    if (m[2].startsWith('400')) push(`${m[1]}${m[2].slice(3)}${m[3]}`);
    else push(`${m[1]}400${m[2]}${m[3]}`);
  }
  // 兜底规范写法（腾讯表情 CDN，固定可信主机）
  if (Number.isInteger(id) && id > 0) push(`https://qzonestyle.gtimg.cn/qzone/em/e400${id}.gif`);
  return out;
}

export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxBytes, true);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}
