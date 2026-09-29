// voice-transcribe（收到语音 → 转写文本）纯函数 + 假网关回归测试：不依赖 SnowLuma / DSH / QQ。
// 用法：node scripts/test-voice-transcribe.mjs
import {
  VOICE_PLACEHOLDER,
  buildVoiceTranscript,
  fetchPttText,
  transcribeVoiceMessage,
  settleVoiceTranscript,
  applyVoiceTranscript
} from '../src/voice-transcribe.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── buildVoiceTranscript ─────────────────────────────────────────────────
assert('转写标签保留 [语音] 前缀（AI 要知道对方是"说"的）',
  buildVoiceTranscript('你好呀') === `${VOICE_PLACEHOLDER} 转写：你好呀`);
assert('空白折叠成单空格', buildVoiceTranscript(' 你好\n\n  呀 ') === `${VOICE_PLACEHOLDER} 转写：你好 呀`);
assert('空转写返回空串（调用方据此保持占位符）', buildVoiceTranscript('   ') === '');
assert('null 安全', buildVoiceTranscript(null) === '');

// ── fetchPttText：假 fetch ────────────────────────────────────────────────
function fakeFetch(handler) {
  return async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    const r = await handler(url, init, body);
    return {
      ok: r.ok !== false,
      status: r.status ?? (r.ok === false ? 500 : 200),
      json: async () => r.body ?? {}
    };
  };
}

const okGateway = fakeFetch(async (url, init, body) => ({
  body: { status: 'ok', retcode: 0, data: { text: `说的是${body.message_id}` } }
}));

const r1 = await fetchPttText('12345', { httpUrl: 'http://127.0.0.1:3000/', accessToken: 'tok', fetchImpl: okGateway });
assert('成功路径解析 data.text', r1.ok === true && r1.text === '说的是12345');

// 请求形状：去掉尾斜杠、带 Bearer、body 用 message_id
let seen = null;
await fetchPttText('777', {
  httpUrl: 'http://127.0.0.1:3000',
  accessToken: 'secret',
  fetchImpl: async (url, init) => {
    seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'x' } }) };
  }
});
assert('URL 拼接去尾斜杠', seen.url === 'http://127.0.0.1:3000/fetch_ptt_text', seen.url);
assert('带 Bearer token', seen.auth === 'Bearer secret');
assert('参数是 message_id', seen.body.message_id === '777');

const httpFail = await fetchPttText('1', { httpUrl: 'http://x', fetchImpl: fakeFetch(async () => ({ ok: false, status: 401, body: { message: 'unauthorized' } })) });
assert('HTTP 失败折成 ok:false（不抛）', httpFail.ok === false && /401/.test(httpFail.error));

const retcodeFail = await fetchPttText('1', { httpUrl: 'http://x', fetchImpl: fakeFetch(async () => ({ body: { status: 'failed', retcode: 100, message: '消息中不包含语音' } })) });
assert('retcode 非 0 折成 ok:false', retcodeFail.ok === false && retcodeFail.error.includes('不包含语音'), retcodeFail.error);

const thrown = await fetchPttText('1', { httpUrl: 'http://x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
assert('网络异常折成 ok:false', thrown.ok === false && thrown.error === 'ECONNREFUSED');

assert('缺 httpUrl 直接失败', (await fetchPttText('1', { fetchImpl: okGateway })).ok === false);
assert('缺 message_id 直接失败', (await fetchPttText('', { httpUrl: 'http://x', fetchImpl: okGateway })).ok === false);

// ── transcribeVoiceMessage：重试 ─────────────────────────────────────────
let calls = 0;
const flaky = fakeFetch(async () => {
  calls += 1;
  // 第一次：QQ 的识别还没回来（空文本）；第二次：有了
  return calls === 1
    ? { body: { status: 'ok', retcode: 0, data: { text: '' } } }
    : { body: { status: 'ok', retcode: 0, data: { text: '第二次才拿到' } } };
});
const slept = [];
const rt = await transcribeVoiceMessage({
  messageId: '9', httpUrl: 'http://x', attempts: 2, retryDelayMs: 5,
  fetchImpl: flaky, sleepImpl: async (ms) => { slept.push(ms); }
});
assert('空结果会重试并最终成功', rt.ok === true && rt.text === '第二次才拿到' && rt.attempts === 2, JSON.stringify(rt));
assert('重试之间确实等了', slept.length === 1 && slept[0] === 5);

let alwaysEmpty = 0;
const emptyGw = fakeFetch(async () => { alwaysEmpty += 1; return { body: { status: 'ok', retcode: 0, data: { text: '' } } }; });
const re = await transcribeVoiceMessage({ messageId: '9', httpUrl: 'http://x', attempts: 3, retryDelayMs: 0, fetchImpl: emptyGw, sleepImpl: async () => {} });
assert('一直空 → 失败且尝试次数正确', re.ok === false && re.attempts === 3 && alwaysEmpty === 3, JSON.stringify(re));

let failCalls = 0;
const errGw = fakeFetch(async () => { failCalls += 1; return { ok: false, status: 500, body: {} }; });
const rf = await transcribeVoiceMessage({ messageId: '9', httpUrl: 'http://x', attempts: 2, retryDelayMs: 0, fetchImpl: errGw, sleepImpl: async () => {} });
assert('网关一直报错 → 失败且带错误信息', rf.ok === false && failCalls === 2 && /500/.test(rf.error), JSON.stringify(rf));

// ── settleVoiceTranscript：限时等待 ──────────────────────────────────────
const s1 = await settleVoiceTranscript(Promise.resolve({ ok: true, text: '快' }), { timeoutMs: 500 });
assert('已完成的转写直接返回', s1.ok === true && s1.text === '快');

const s2 = await settleVoiceTranscript(new Promise((resolve) => setTimeout(() => resolve({ ok: true, text: '慢' }), 1000)), { timeoutMs: 60 });
assert('超时返回失败而不是抛', s2.ok === false && /超时/.test(s2.error), JSON.stringify(s2));

const s3 = await settleVoiceTranscript(Promise.reject(new Error('boom')), { timeoutMs: 500 });
assert('任务 reject 也被折成 ok:false', s3.ok === false && s3.error === 'boom');

const s4 = await settleVoiceTranscript(null, { timeoutMs: 50 });
assert('没有任务时返回失败', s4.ok === false);

// ── applyVoiceTranscript：原地回填 ───────────────────────────────────────
const onlyVoice = { text: '[语音]', plain: '[语音]', tail: '[语音]', messageId: '1', sender: '甲' };
assert('只有语音 → 回填成功', applyVoiceTranscript(onlyVoice, { ok: true, text: '晚上好', attempts: 1 }) === true);
assert('回填保留 [语音] 前缀', onlyVoice.text === '[语音] 转写：晚上好', onlyVoice.text);
assert('plain/tail 同步回填', onlyVoice.plain === onlyVoice.text && onlyVoice.tail === onlyVoice.text);
assert('记下 voice 元信息', onlyVoice.voice?.ok === true && onlyVoice.voice.text === '晚上好');
assert('其它字段不动', onlyVoice.messageId === '1' && onlyVoice.sender === '甲');

const mixed = { text: '听这个[语音]', plain: '听这个[语音]', tail: '听这个[语音]' };
applyVoiceTranscript(mixed, { ok: true, text: '我唱首歌', attempts: 1 });
assert('文字+语音共存：不丢原来的文字', mixed.text === '听这个[语音] 转写：我唱首歌', mixed.text);

const twoVoices = { text: '[语音][语音]', plain: '[语音][语音]', tail: '[语音][语音]' };
applyVoiceTranscript(twoVoices, { ok: true, text: '第一段', attempts: 1 });
assert('多段语音只替换第一个（不复制转写）', twoVoices.text === '[语音] 转写：第一段[语音]', twoVoices.text);

const failedMsg = { text: '[语音]', plain: '[语音]', tail: '[语音]' };
assert('失败时不改文本', applyVoiceTranscript(failedMsg, { ok: false, error: '识别为空', attempts: 2 }) === false);
assert('失败时文本保持占位符', failedMsg.text === '[语音]' && failedMsg.plain === '[语音]');
assert('失败时也留下原因', failedMsg.voice?.ok === false && failedMsg.voice.error === '识别为空');

const longMsg = { text: `[语音]${'啊'.repeat(300)}`, plain: '[语音]', tail: '[语音]' };
applyVoiceTranscript(longMsg, { ok: true, text: '长'.repeat(400), attempts: 1 });
assert('回填后按 200 字截断', longMsg.text.length <= 200, String(longMsg.text.length));
assert('截断不产生孤立高代理', !/[\uD800-\uDBFF]$/.test(longMsg.text));

const emojiMsg = { text: '[语音]', plain: '[语音]', tail: '[语音]' };
applyVoiceTranscript(emojiMsg, { ok: true, text: '😀'.repeat(300), attempts: 1 });
assert('emoji 长文本截断后无断裂代理对', (() => {
  for (let i = 0; i < emojiMsg.text.length; i++) {
    const c = emojiMsg.text.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) return i + 1 < emojiMsg.text.length && emojiMsg.text.charCodeAt(i + 1) >= 0xDC00 && emojiMsg.text.charCodeAt(i + 1) <= 0xDFFF;
  }
  return true;
})());

assert('applyVoiceTranscript 对非对象入参返回 false', applyVoiceTranscript(null, { ok: true, text: 'x' }) === false);
assert('空转写不改文本', (() => {
  const m = { text: '[语音]', plain: '[语音]', tail: '[语音]' };
  return applyVoiceTranscript(m, { ok: true, text: '   ' }) === false && m.text === '[语音]';
})());

// ── 消息里没有 [语音] 时的兜底（原文被截断等）────────────────────────────
const noMarker = { text: '很长的一段文字', plain: '很长的一段文字', tail: '很长的一段文字' };
applyVoiceTranscript(noMarker, { ok: true, text: '补上', attempts: 1 });
assert('找不到占位符时追加而不是丢弃', noMarker.text === '很长的一段文字 [语音] 转写：补上', noMarker.text);

// ── 超时：卡住的网关调用必须在预算内失败返回（不能把消息链路挂住）───────────
const hangFetch = (url, init) => new Promise((resolve, reject) => {
  const signal = init?.signal;
  // 没有 signal 就真的永远挂着 —— 这条用例会超时失败，正好暴露「超时静默失效」。
  if (!signal) return;
  if (signal.aborted) return reject(new Error('aborted'));
  signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
});
const t0 = Date.now();
const timedOut = await fetchPttText('1', { httpUrl: 'http://x', timeoutMs: 120, fetchImpl: hangFetch });
const elapsed = Date.now() - t0;
assert('挂住的请求在预算内失败返回（超时有效）', timedOut.ok === false && elapsed < 1500, `elapsed=${elapsed}ms err=${timedOut.error}`);

console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
