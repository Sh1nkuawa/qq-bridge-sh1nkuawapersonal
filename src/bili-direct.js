// B 站专用通道：**DoH 拿真实 IP → 直连**（绕过 mihomo 的 fake-ip / 代理路由）
//
// 为什么需要（2026-10-16 实测，一因三果都指向它）：
//   本机 mihomo 开了 TUN + fake-ip，并且**全局劫持 DNS**：连 223.5.5.5 / 119.29.29.29 都返回
//   198.18.x.x（fake-ip）。B 站流量于是走了国外出口，B 站回 `{"code":-412,"request was banned}`，
//   导致：桥接的卡片元信息预取失败 ✗、字幕取不到 ✗、yt-dlp 也 412 ✗。
//   实测对照（同一接口、同一台机器）：
//     走代理：HTTP 412 request was banned ✗
//     DoH 解析出真实 IP（121.194.11.74）后带 SNI 直连：HTTP 200 正常 JSON ✓
//
// 设计：
//   - 只用 `node:https`（桥接跑在 Node 16 上，没有全局 fetch）—— 不引任何依赖；
//   - 只对 B 站域名生效（含 b23.tv / hdslb.com / bilivideo.*）；其它域名一律原样交给默认 fetch；
//   - **任何一步失败都回落到默认 fetch**（DoH 不通、IP 连不上、超时……），保证不会比原来更差；
//   - DoH 结果按 host 缓存（默认 10 分钟），避免每个请求都查一次；
//   - 返回一个 **fetch 兼容**的对象（ok/status/headers.get/getSetCookie/text/json/arrayBuffer），
//     这样 bili-auth 的 Set-Cookie 续期、link-bilibili 的 json() 都能直接复用。

import https from 'node:https';
import http from 'node:http';

const BILI_HOST_RE = /(^|\.)(bilibili\.com|b23\.tv|hdslb\.com|bilivideo\.com|bilivideo\.cn)$/i;

/** 默认 DoH 端点（都是国内解析，返回真实 IP；按顺序试） */
const DOH_ENDPOINTS = [
  'https://223.5.5.5/resolve',
  'https://1.12.12.12/resolve',
  'https://223.6.6.6/resolve'
];

const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ipCache = new Map();      // host → { ips, at }
const CACHE_TTL_MS = 10 * 60 * 1000;

export function isBiliHost(host) {
  return BILI_HOST_RE.test(String(host ?? '').toLowerCase());
}

export function isBiliUrl(url) {
  try { return isBiliHost(new URL(String(url)).hostname); } catch { return false; }
}

/** 清缓存（测试/排障用） */
export function clearDirectCache() { ipCache.clear(); }

/**
 * 用 DoH 拿真实 IP（A 记录）。返回数组；失败返回空数组（调用方会回落）。
 */
export async function dohResolve(host, { timeoutMs = 8000, fetchImpl = fetch, endpoints = DOH_ENDPOINTS } = {}) {
  const h = String(host ?? '').toLowerCase();
  const hit = ipCache.get(h);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ips;
  for (const base of endpoints) {
    try {
      const url = `${base}?name=${encodeURIComponent(h)}&type=A`;
      const res = await fetchImpl(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) });
      const j = await res.json();
      const ips = (j?.Answer ?? []).filter((a) => Number(a?.type) === 1 && typeof a?.data === 'string').map((a) => a.data);
      if (ips.length) {
        ipCache.set(h, { ips, at: Date.now() });
        return ips;
      }
    } catch { /* 试下一个端点 */ }
  }
  return [];
}

/** 把 https 响应包成 fetch 兼容对象 */
function wrapResponse(url, res, body) {
  const raw = res.headers ?? {};
  return {
    url,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage ?? '',
    headers: {
      get: (name) => {
        const v = raw[String(name).toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : (v ?? null);
      },
      getSetCookie: () => {
        const v = raw['set-cookie'];
        return Array.isArray(v) ? v : (v ? [v] : []);
      },
      raw
    },
    text: async () => body.toString('utf8'),
    json: async () => JSON.parse(body.toString('utf8')),
    arrayBuffer: async () => body
  };
}

/** 直连某个 IP（带 SNI 与 Host），返回 { status, res, body } */
function requestIp(ip, { url, method = 'GET', headers = {}, body, timeoutMs = 20000, signal }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const finalHeaders = { 'User-Agent': UA_DEFAULT, ...headers, Host: u.host };
    const req = mod.request({
      host: ip,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      servername: isHttps ? u.hostname : undefined,   // ★ SNI 必须是域名
      headers: finalHeaders,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, res, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('direct-timeout')); });
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * B 站专用 fetch：DoH 直连。**失败会抛异常**（调用方负责回落到默认 fetch）。
 * 支持 redirect: 'manual'（b23.tv 短链要读 location）；默认跟随，但最多 3 跳，
 * 且只在 B 站域名之间跟 —— 跳到别的域名就抛出，由调用方回落。
 */
export async function biliDirectFetch(url, init = {}, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const target = String(url);
  let u;
  try { u = new URL(target); } catch (e) { throw new Error('bad-url'); }
  if (!isBiliHost(u.hostname)) throw new Error('not-bili-host');

  const ips = await dohResolve(u.hostname, { fetchImpl });
  if (!ips.length) throw new Error('doh-failed');

  const redirectMode = init.redirect ?? 'follow';
  let lastError = null;
  let current = target;

  for (let hop = 0; hop <= 3; hop += 1) {
    const cu = new URL(current);
    if (!isBiliHost(cu.hostname)) throw new Error('redirect-leaves-bili');
    const hopIps = hop === 0 ? ips : await dohResolve(cu.hostname, { fetchImpl });
    if (!hopIps.length) throw new Error('doh-failed');
    let resp = null;
    for (const ip of hopIps) {
      try {
        resp = await requestIp(ip, {
          url: current,
          method: init.method ?? 'GET',
          headers: init.headers ?? {},
          body: init.body,
          timeoutMs,
          signal: init.signal
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!resp) throw lastError ?? new Error('all-ips-failed');
    const location = resp.res.headers?.location;
    if (redirectMode === 'manual' || !location || !(resp.status >= 300 && resp.status < 400)) {
      return wrapResponse(current, resp.res, resp.body);
    }
    current = new URL(location, current).toString();
  }
  throw new Error('too-many-redirects');
}

/**
 * 给桥接用的入口：B 站域名走直连，**失败自动回落到默认 fetch**；其它域名直接走默认 fetch。
 * @param {object} opts
 * @param {typeof fetch} [opts.fallbackFetch]  默认 fetch（可注入，便于测试）
 * @param {typeof fetch} [opts.dohFetch]       DoH 查询用的 fetch（默认同 fallbackFetch；单独可注入）
 * @param {(msg:string)=>void} [opts.log]
 */
export function createBiliFetch({ fallbackFetch = fetch, dohFetch = fallbackFetch, log = () => {}, timeoutMs = 20000 } = {}) {
  let warnedAt = 0;
  return async function biliFetch(url, init = {}) {
    if (isBiliUrl(url)) {
      try {
        return await biliDirectFetch(url, init, { fetchImpl: dohFetch, timeoutMs });
      } catch (error) {
        // 只每 5 分钟抱怨一次，免得日志被刷屏；然后老老实实回落
        if (Date.now() - warnedAt > 5 * 60 * 1000) {
          warnedAt = Date.now();
          log(`[bili-direct] 直连失败（${error?.message ?? error}），本次回落到默认 fetch：${String(url).slice(0, 90)}`);
        }
      }
    }
    return fallbackFetch(url, init);
  };
}
