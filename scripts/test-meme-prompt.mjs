// 只读验收：确认唤醒提示/Prompt 里真的带上了「本地表情包库」段落。
// 用法：node scripts/test-meme-prompt.mjs
// 说明：用 state/social-v2.json 里会话自己的 agent token 调一次 qq_get_prompt；
//      只打印 memes 段摘要，不打印 token，也不触发任何发送。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = Number(cfg.consolePort) || 3100;
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));

const key = process.argv[2] || Object.keys(state.conversations ?? {})[0];
const conv = state.conversations?.[key];
if (!conv) { console.error(`state 里没有会话 ${key}`); process.exit(1); }
const token = conv.agentToken;
if (!token) { console.error(`${key} 没有 agent token（该会话可能还没被唤醒过）`); process.exit(1); }
let consoleToken = String(cfg.consoleToken || '').trim();
if (!consoleToken) {
  try { consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}

const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/prompt?key=${encodeURIComponent(key)}`, {
  // 控制台鉴权中间件对所有请求生效，MCP 也是同时带 x-console-token + x-agent-token。
  headers: { 'x-agent-token': token, ...(consoleToken ? { 'x-console-token': consoleToken } : {}) },
  signal: AbortSignal.timeout(20000)
});
const body = await res.json().catch(() => null);
console.log(`## qq_get_prompt（${key}）HTTP ${res.status}`);
if (!body?.ok) { console.error('调用失败：', body); process.exit(1); }

const m = body.memes ?? {};
console.log('memes.enabled =', m.enabled, '| total =', m.total);
console.log('packs =', JSON.stringify(m.packs ?? []));
console.log('moods =', JSON.stringify(m.moods ?? []));
console.log('\n--- context ---\n' + String(m.context ?? '').slice(0, 900));
console.log('\n--- strategy ---\n' + String(m.strategy ?? '').slice(0, 700));

const tick = (name, cond) => console.log(`  ${cond ? '✅' : '❌'} ${name}`);
console.log('');
tick('enabledTools 含 qq_send_meme', (body.enabledTools ?? []).includes('qq_send_meme'));
tick('memes.total > 0', Number(m.total) > 0);
tick('context 含「可用表情包库」', String(m.context ?? '').includes('可用表情包库'));
tick('strategy 含 qq_send_meme 用法', String(m.strategy ?? '').includes('qq_send_meme'));
tick('strategy 说明与收藏表情分工', String(m.strategy ?? '').includes('qq_send_sticker'));
process.exit(0);
