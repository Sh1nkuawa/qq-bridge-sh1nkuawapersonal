// mock-agy-worker.mjs —— 假 worker：不依赖 Antigravity，用来验证桥接侧 AGY 端点
//
// 用途：在真实的 Antigravity worker 写好之前，先把桥接侧协议跑通（契约 §8 的 6 条验收）。
// 用法（先临时把 config.json 的 transport 改成 "agy"，再重启桥接）：
//   node scripts/mock-agy-worker.mjs --persona 小鲸鱼 --rounds 3
//   node scripts/mock-agy-worker.mjs --persona 小鲸鱼 --reply "第一条" --reply "第二条"
//   node scripts/mock-agy-worker.mjs --status
//
// 它做的事：status → wait（长轮询）→ claim → 「假装想了 1 秒」→ complete → 记日志
// 钉在 state/agy-worker.log（与真 worker 同格式，方便用同一套日志看）

import fs from 'node:fs';
import path from 'node:path';

const argOf = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const manyOf = (name) => {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
};

const base = 'http://127.0.0.1:3100';
const tok = fs.readFileSync('D:/dsh/qq-bridge/state/console-token', 'utf8').trim();
const persona = argOf('persona', '小鲸鱼');
const workerId = argOf('workerId', `mock-${persona}-${process.pid}`);
const rounds = Number(argOf('rounds', '1')) || 1;
const repliesArg = manyOf('reply');
const LOG = 'D:/dsh/qq-bridge/state/agy-worker.log';

const log = (event, extra = {}) => {
  const line = JSON.stringify({ at: Date.now(), workerId, persona, event, ...extra });
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { /* ignore */ }
  console.log('  ' + line.slice(0, 200));
};

const url = (p, qs = {}) => {
  const u = new URL(base + p);
  u.searchParams.set('token', tok);
  for (const [k, v] of Object.entries(qs)) if (v != null) u.searchParams.set(k, String(v));
  return u;
};

async function getJson(p, qs) {
  const r = await fetch(url(p, qs), { signal: AbortSignal.timeout(130000) });
  if (r.status === 204) return { http: 204, body: null };
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { http: r.status, body };
}
async function postJson(p, body) {
  const r = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { http: r.status, body: j };
}

const mode = process.argv.includes('--status') ? 'status' : 'run';
if (mode === 'status') {
  const s = await getJson('/api/agy/status');
  console.log('  status → ' + JSON.stringify(s.body));
  process.exit(s.http === 200 ? 0 : 1);
}

for (let i = 1; i <= rounds; i += 1) {
  const w = await getJson('/api/agy/wait', { persona, workerId, timeoutMs: 60000 });
  log('wait', { http: w.http, idle: w.body?.idle ?? false, reason: w.body?.reason ?? null });

  if (w.http === 204) { console.log('  （空闲，本轮结束）'); continue; }
  if (!w.body?.turnId) { console.log('  （idle：不是值班者）'); await new Promise((r) => setTimeout(r, 5000)); continue; }

  const turn = w.body;
  console.log(`  取到 ${turn.turnId}（${turn.key} / ${turn.reason}）prompt ${String(turn.prompt).length} 字符`);

  const c = await postJson('/api/agy/claim', { turnId: turn.turnId, persona, workerId });
  log('claim', { turnId: turn.turnId, ok: c.body?.ok ?? false, http: c.http });
  if (!c.body?.ok) continue;

  await new Promise((r) => setTimeout(r, 1000)); // 假装在"想"

  const replies = repliesArg.length ? repliesArg : [`[mock] 收到，这是第 ${i} 轮`];
  const done = await postJson('/api/agy/complete', { turnId: turn.turnId, persona, workerId, replies, meta: { mock: true } });
  log('complete', { turnId: turn.turnId, ok: done.body?.ok ?? false, sent: done.body?.sent ?? 0, failed: done.body?.failed ?? 0, http: done.http });
}
console.log('  完成，日志：state/agy-worker.log');
