// 日文 TTS：把文本合成为语音文件，放进语音库目录（现有 qq_send_voice 直接可发）。
//
// 引擎：**只有** GPT-SoVITS v2Pro 本地 API（二阶堂真红模型，http://127.0.0.1:9880/tts）。
// ⚠️ owner 2026-10-24 明确要求：**不做降级**。API 起不来 / 出错 ⇒ 直接拒绝发语音，
//    绝不悄悄换成别的音色（那会"声线突然变了个人"✗）。
//
// 其它约束：
//   · **只接受日文**：文本里至少要有假名，否则拒绝（不让日文模型硬读中文）✓；
//   · 按 文本 哈希缓存：同一句不重复合成 ✓；
//   · 输出落在 `<voiceDir>/tts/` 之内 ⇒ 满足"AI 只能发语音库里的文件"的安全边界 ✓；
//   · 出错**明确返回 error**（上层原样告诉用户"这次没法发语音"）✓。

import crypto from 'node:crypto';
import { createTtsService } from './tts-service.js';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_API = 'http://127.0.0.1:9880/tts';
const MAX_TEXT_CHARS = 200;

// 语音服务（GPT-SoVITS API）按需拉起 + 空闲自动关闭（默认 30 分钟）
let service = null;
function getService() {
  if (!service) service = createTtsService({ log: (m) => console.log(m) });
  return service;
}


/** 是否像日文（至少一个假名） */
export function looksJapanese(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return /[\u3040-\u30FF\uFF66-\uFF9F]/.test(s);
}

/** 日文字符占比（平假名/片假名/汉字/长音/标点） */
export function japaneseRatio(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const ja = (s.match(/[\u3040-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F\u30FC\u3001\u3002]/g) || []).length;
  return ja / s.length;
}

export function ttsCacheKey(text) {
  return crypto.createHash('sha1').update(`shinku|${text}`).digest('hex').slice(0, 16);
}

/** 读配置（默认值 + 可选的 state/tts.json 覆盖） */
export function loadTtsConfig({ stateDir = 'state' } = {}) {
  const base = {
    apiUrl: DEFAULT_API,
    refAudio: '',
    promptText: '',
    promptLang: 'ja',
    apiTimeoutMs: 180000
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'tts.json'), 'utf8').replace(/^\uFEFF/, ''));
    return { ...base, ...raw };
  } catch { return base; }
}

/** 调 GPT-SoVITS 的 /tts，返回音频 Buffer */
export async function synthGptSoVits(text, { apiUrl = DEFAULT_API, refAudio, promptText, promptLang = 'ja', apiTimeoutMs = 180000 } = {}) {
  if (!refAudio || !fs.existsSync(refAudio)) throw new Error(`参考音频不存在：${refAudio || '(未配置)'}（state/tts.json 的 refAudio）`);
  if (!promptText) throw new Error('未配置参考文本（state/tts.json 的 promptText）');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), apiTimeoutMs);
  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        text,
        text_lang: 'ja',
        ref_audio_path: refAudio,
        prompt_text: promptText,
        prompt_lang: promptLang,
        text_split_method: 'cut5',
        batch_size: 1,
        media_type: 'wav',
        streaming_mode: false
      }),
      signal: ctl.signal
    });
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (/abort/i.test(msg)) throw new Error(`GPT-SoVITS 超时（${Math.round(apiTimeoutMs / 1000)} 秒）`);
    throw new Error(`连不上 GPT-SoVITS（${apiUrl}）：API 可能没启动 —— ${msg}`);
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`GPT-SoVITS 返回 ${res.status}：${(await res.text()).slice(0, 150)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`GPT-SoVITS 返回的音频太小（${buf.length} 字节）`);
  return buf;
}

/**
 * 合成日文语音（只走 GPT-SoVITS；失败直接报错，不降级）。
 * @returns {{ok:true, file:string, cached:boolean, bytes?:number} | {ok:false, error:string}}
 */
export async function synthesizeJapanese(text, { voiceDir = 'audio', cfg = {} } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return { ok: false, error: '文本为空' };
  if (clean.length > MAX_TEXT_CHARS) return { ok: false, error: `文本过长（${clean.length} > ${MAX_TEXT_CHARS} 字）` };
  if (!looksJapanese(clean)) return { ok: false, error: '只接受日文（文本里至少要有假名）；请让 AI 写日文再发' };

  const conf = { ...loadTtsConfig(), ...cfg };
  // 需要时才拉起（空闲 30 分钟会自动关，见 tts-service.js）
  const ensured = await getService().ensureRunning();
  if (!ensured.ok) return { ok: false, error: ensured.error || '语音服务没能启动' };
  const dir = path.join(voiceDir, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ja-${ttsCacheKey(clean)}.wav`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) { getService().touch(); return { ok: true, file, cached: true }; }

  try {
    const buf = await synthGptSoVits(clean, conf);
    fs.writeFileSync(file, buf);
    getService().touch();
    return { ok: true, file, cached: false, bytes: buf.length };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
