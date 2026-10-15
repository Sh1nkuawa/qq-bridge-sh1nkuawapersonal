// B 站链接 → 结构化短摘要（免登录官方接口）。
//
// [qq-bridge 本地补丁 2026-10-12] 为什么需要它：B 站网页是 JS 渲染的，模型自带的
// mcp__web-search-safe__web_fetch 抓下来基本没正文 ✗；而官方的 view 接口
// （api.bilibili.com/x/web-interface/view）**免登录**就能拿到标题/UP/时长/简介/分P/播放数 ✓。
// 所以这里给卡片里的 B 站视频预取一份"够用就好"的元信息，拼成一小段文本注入唤醒提示。
//
// 刻意不做的事（保持诚实）：
//   - 不引入登录 cookie（账号风险 ✗）
//   - 不做字幕/ASR（属于 P2 ✗）——所以"视频里讲了什么"这一级总结不了，
//     文案里明确写"只有简介/元信息"，让模型别硬编内容。
import { validateFetchUrl } from './safe-fetch.js';
import { bilibiliRef, normalizeUrl } from './card-link.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view';

/** 12345 → 1.2万；1234 → 1234 */
export function humanCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '?';
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(Math.round(v));
}

/** 秒 → 12:34 / 1:02:03 */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 纯函数：把 view 接口的返回值拼成一段模型好读的文本（便于回归）。 */
export function formatVideoSummary(view, { descChars = 400, url = '' } = {}) {
  const v = view ?? {};
  const title = String(v.title ?? '').replace(/\s+/g, ' ').trim() || '（无标题）';
  const up = String(v.owner?.name ?? '').trim();
  const parts = [];
  parts.push(`【B站视频】${title}`);
  const meta = [];
  if (up) meta.push(`UP：${up}`);
  if (v.duration) meta.push(`时长：${formatDuration(v.duration)}`);
  if (v.tname) meta.push(`分区：${v.tname}`);
  if (v.pubdate) {
    const d = new Date(Number(v.pubdate) * 1000);
    if (!Number.isNaN(d.getTime())) meta.push(`发布：${d.toISOString().slice(0, 10)}`);
  }
  if (meta.length) parts.push(meta.join('｜'));
  const stat = v.stat ?? {};
  const nums = [];
  if (stat.view !== undefined) nums.push(`播放 ${humanCount(stat.view)}`);
  if (stat.danmaku !== undefined) nums.push(`弹幕 ${humanCount(stat.danmaku)}`);
  if (stat.like !== undefined) nums.push(`点赞 ${humanCount(stat.like)}`);
  if (stat.favorite !== undefined) nums.push(`收藏 ${humanCount(stat.favorite)}`);
  if (stat.coin !== undefined) nums.push(`投币 ${humanCount(stat.coin)}`);
  if (nums.length) parts.push(nums.join(' · '));
  const pages = Array.isArray(v.pages) ? v.pages : [];
  if (pages.length > 1) {
    const list = pages.slice(0, 8).map((p, i) => `${i + 1}.${String(p?.part ?? '').trim() || '（未命名）'}`).join('；');
    parts.push(`分P（共 ${pages.length}）：${list}${pages.length > 8 ? ' …' : ''}`);
  }
  const desc = String(v.desc ?? '').replace(/\s+/g, ' ').trim();
  if (desc) parts.push(`简介：${desc.slice(0, descChars)}${desc.length > descChars ? '…' : ''}`);
  if (url) parts.push(`链接：${url}`);
  return parts.join('\n');
}

/** 展开 b23.tv 短链 → 最终 URL（不下载正文） */
export async function expandShortLink(url, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  // ⚠️ validateFetchUrl 的契约是「失败抛异常、成功返回 { url, ip }」（**没有 .ok 字段**）——
  // 2026-10-12 联网实测踩过这个坑 ✗，别再写成 check.ok。
  try { await validateFetchUrl(url); } catch (error) {
    return { ok: false, reason: `短链地址校验未通过（${error?.message ?? '无效地址'}）` };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: ac.signal });
    const finalUrl = normalizeUrl(res?.url ?? '') || url;
    try { res.body?.cancel?.(); } catch { /* ignore */ }
    // 短链跳到哪儿由对方决定 → **跳转后再校验一次**（SSRF / DNS rebinding 的基本盘）
    if (finalUrl !== url) {
      try { await validateFetchUrl(finalUrl); } catch (error) {
        return { ok: false, reason: `短链跳转到的地址不可访问（${error?.message ?? '校验未通过'}）` };
      }
    }
    return { ok: true, url: finalUrl };
  } catch (error) {
    return { ok: false, reason: /abort/i.test(String(error?.name ?? error?.message)) ? '短链展开超时' : '短链展开失败（网络不通）' };
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map();        // url → { at, ok, text, reason }
const inflight = new Map();     // url → Promise

export function clearBilibiliCache() { cache.clear(); inflight.clear(); }

/**
 * 拿一段 B 站链接的摘要文本。
 * @returns {Promise<{ok:boolean, text?:string, reason?:string, cached?:boolean}>}
 */
export async function summarizeBilibili(url, {
  fetchImpl = fetch, timeoutMs = 6000, descChars = 400, cacheTtlMs = 30 * 60000
} = {}) {
  const key = normalizeUrl(url) || String(url ?? '');
  if (!key) return { ok: false, reason: '链接为空' };
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheTtlMs) return { ...hit, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    let target = key;
    let ref = bilibiliRef(target);
    if (ref?.kind === 'short') {
      const ex = await expandShortLink(target, { fetchImpl, timeoutMs });
      if (!ex.ok) return { ok: false, reason: ex.reason };
      target = ex.url;
      ref = bilibiliRef(target);
    }
    if (!ref || (ref.kind !== 'video')) {
      return { ok: false, reason: ref?.kind === 'bangumi' ? '番剧链接暂不支持（可让模型 web_fetch 试读）' : '不是 B 站视频链接' };
    }
    const q = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(String(ref.aid))}`;
    const apiUrl = `${VIEW_API}?${q}`;
    // 同 expandShortLink：validateFetchUrl 失败**抛异常**，没有 .ok
    try { await validateFetchUrl(apiUrl); } catch (error) {
      return { ok: false, reason: `接口地址校验未通过（${error?.message ?? ''}）` };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(apiUrl, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, signal: ac.signal });
      const json = await res.json().catch(() => null);
      if (!json) return { ok: false, reason: 'B站接口返回的不是 JSON（可能是代理/风控页）—— 若代理把 B 站流量走了国外节点，请给 bilibili.com / b23.tv / hdslb.com 配 DIRECT' };
      if (json.code !== 0) {
        const map = {
          '-404': '视频不存在或已删除',
          '-403': 'B站拒绝访问（可能需要登录）',
          '-400': '请求参数不对',
          // 2026-10-15 实测：代理把 B 站流量走国外节点时，B 站直接回 -412 request was banned
          //（同一天 yt-dlp 取音频也是 412，同一个原因）
          '-412': 'B站风控拒绝了请求（-412 request was banned）—— 通常是代理让 B 站走了国外节点；请在代理里给 bilibili.com / b23.tv / hdslb.com 配 DIRECT'
        };
        return { ok: false, reason: map[String(json.code)] ?? `B站接口返回 code=${json.code}` };
      }
      const text = formatVideoSummary(json.data, { descChars, url: target });
      // 把解析出来的 BV 一起返回：短链（b23.tv/xxx）里没有 BV，下游要拿它去取字幕，
      // 若只传 URL 会判成 bad-bvid（2026-10-15 实测踩过：元信息成功、字幕却没附上）
      return { ok: true, text, bvid: String(json.data?.bvid ?? '') };
    } catch (error) {
      const aborted = /abort/i.test(String(error?.name ?? error?.message));
      return { ok: false, reason: aborted ? '抓 B 站元信息超时' : '抓 B 站元信息失败（网络不通）' };
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  const result = await task;
  cache.set(key, { at: Date.now(), ...result });
  return result;
}
