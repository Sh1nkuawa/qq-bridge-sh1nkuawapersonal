// 火山方舟 **Agent Plan**（视觉模型）生图后端。
//
// [qq-bridge 本地补丁 2026-10-05] 背景：原来只有 codex-image.ps1 一条生图链路，它依赖
// chatgpt.com（ChatGPT 订阅后端），网络/代理一抖整条就断。Agent Plan 的专属端点在国内直连
// 可用，所以生图默认走它，调不通再回落 codex（回落逻辑在 scripts/gen-image-worker.mjs）。
//
// ⚠️ 端点必须用 Agent Plan 的专属地址 `/api/plan/v3/images/generations`，
//    **不要**用普通方舟的 `/api/v3/...` —— 控制台明确警告后者会产生额外费用。
//
// ⚠️ Agent Plan 的 API Key 是**专属 key**（`ark-` 开头，40 位以上），只能配专属端点；
//    拿它去打 `/api/v3` 会 401（这是 2026-10-05 排查过的真实现象）。

import fs from 'node:fs';

export const DEFAULT_ARK_MODEL = 'doubao-seedream-5.0-pro';
export const DEFAULT_ARK_SIZE = '2K';
/** Agent Plan 的图片生成端点路径（主机由控制台给的 Base URL 决定）。 */
export const ARK_PLAN_IMAGE_PATH = '/api/plan/v3/images/generations';

/**
 * 把用户/控制台给的 Base URL 规整成可直接 POST 的端点。
 *
 * 三种输入都支持：
 *   - 整条端点：https://host/api/plan/v3/images/generations
 *   - 带 /api 前缀的 base：https://host/api/plan/v3
 *   - 只有主机：https://host
 */
export function normalizeArkEndpoint(base) {
  const raw = String(base ?? '').trim();
  if (!raw) return '';
  const trimmed = raw.replace(/\/+$/, '');
  if (/\/images\/generations$/i.test(trimmed)) return trimmed;
  if (/\/api\//i.test(trimmed)) return `${trimmed}/images/generations`;
  return `${trimmed}${ARK_PLAN_IMAGE_PATH}`;
}

/** 认图片真实格式（Ark 常返回 JPEG，别被 .png 扩展名骗了；查不动就返回 null）。 */
export function detectImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return null;
}

/** mime → 扩展名（写文件时用，保证扩展名和真实字节一致）。 */
export function extensionForMime(mime) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.png';
}

/**
 * 组装 Agent Plan 的图片生成请求体（纯函数，便于回归）。
 * images 支持：本地文件路径不会在这里读——调用方应先转成 data URI 或 URL。
 */
export function buildArkBody({ model, prompt, images = [], size, watermark = false, responseFormat = 'b64_json' } = {}) {
  const list = (Array.isArray(images) ? images : [images]).map((x) => String(x ?? '').trim()).filter(Boolean);
  const body = {
    model: String(model ?? '').trim() || DEFAULT_ARK_MODEL,
    prompt: String(prompt ?? ''),
    size: String(size ?? '').trim() || DEFAULT_ARK_SIZE,
    response_format: responseFormat,
    watermark
  };
  // 参考图：单张传字符串、多张传数组（官方两种都接受）。
  if (list.length === 1) body.image = list[0];
  else if (list.length > 1) body.image = list;
  return body;
}

/**
 * 选生图后端（纯函数）。
 * backend=auto（默认）→ 配好 Agent Plan 就用 ark，否则 codex；
 * backend=codex → 强制 codex；backend=ark → 优先 ark（失败后的回落由调用方决定）。
 */
export function pickImageBackend(imageCfg, { hasArk = false } = {}) {
  const want = String(imageCfg?.backend ?? 'auto').trim().toLowerCase();
  if (want === 'codex') return 'codex';
  if (!hasArk) return 'codex';
  return 'ark';
}

/** 把本地图片文件转成 data URI（Agent Plan 的 image 参数接受 URL 或 base64 data URI）。 */
export function fileToDataUri(file) {
  const buf = fs.readFileSync(file);
  const mime = detectImageMime(buf) ?? 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 调 Agent Plan 出图。
 * @returns {Promise<{ok:true,buffer:Buffer,mimeType:string,ms:number,usage:any}|{ok:false,status:number,message:string}>}
 */
export async function generateWithArk({
  endpoint, apiKey, model, prompt, images = [], size, timeoutMs = 300000, fetchImpl = fetch, signal
} = {}) {
  const url = normalizeArkEndpoint(endpoint);
  if (!url) return { ok: false, status: 0, message: '没有配置 Agent Plan 的 Base URL' };
  if (!String(apiKey ?? '').trim()) return { ok: false, status: 0, message: '没有配置 Agent Plan 的 API Key' };
  const body = buildArkBody({ model, prompt, images, size });
  const t0 = Date.now();
  let res;
  try {
    const ac = signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(apiKey).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac
    });
  } catch (error) {
    return { ok: false, status: 0, message: `请求失败：${error?.message ?? error}` };
  }
  let json = null;
  let text = '';
  try { text = await res.text(); json = JSON.parse(text); } catch { /* 保留 text 用于报错 */ }
  if (!res.ok) {
    const message = json?.error?.message ?? json?.message ?? text.slice(0, 300) ?? '';
    return { ok: false, status: res.status, message: message || `HTTP ${res.status}` };
  }
  const first = json?.data?.[0] ?? {};
  const ms = Date.now() - t0;
  if (first.b64_json) {
    const buffer = Buffer.from(first.b64_json, 'base64');
    return { ok: true, buffer, mimeType: detectImageMime(buffer) ?? 'image/png', ms, usage: json?.usage ?? null };
  }
  if (first.url) {
    try {
      const r2 = await fetchImpl(first.url, { signal: AbortSignal.timeout(Math.max(30000, timeoutMs)) });
      const buffer = Buffer.from(await r2.arrayBuffer());
      return { ok: true, buffer, mimeType: detectImageMime(buffer) ?? 'image/png', ms, usage: json?.usage ?? null };
    } catch (error) {
      return { ok: false, status: res.status, message: `拿到 url 但下载失败：${error?.message ?? error}` };
    }
  }
  return { ok: false, status: res.status, message: `返回里没有图片：${text.slice(0, 200)}` };
}
