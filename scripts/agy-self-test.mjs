// agy-self-test.mjs —— AGY worker CLI 端到端契约自检（零外部依赖，不修改 config.json 或线上队列）
//
// 原理：
//   - 在 127.0.0.1:0 启一个临时 HTTP 测试服务器，内部直接调用真实 ../src/agy-transport.js 的 createAgyTransport()
//   - 用子进程真实执行 scripts/agy-status.mjs、agy-wait-wake.mjs、agy-reply-and-wait.mjs、agy-touch.mjs
//   - 覆盖 docs/AGY_CONTRACT.md §8 与 docs/AGY_WORKER_TASK.md §2/§4 的所有核心场景与日志脱敏约束

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgyTransport } from '../src/agy-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const TEST_TOKEN = 'test-secret-token-never-log-me-9f8e7d6c';
const TEST_SESSION_TOKEN = 'test-session-agent-token-never-log-me-1a2b3c';
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-worker-selftest-'));
const testLogPath = path.join(tmpDir, 'agy-worker.log');

let fakeNow = Date.now();
const transport = createAgyTransport({
  leaseMs: 10 * 60 * 1000,
  maxAttempts: 2,
  now: () => fakeNow
});

let onDuty = '小鲸鱼';
let lastWorkerSeenAt = 0;
let lastCompleteAt = 0;
const sentBatches = [];
let injectDropCount = 0;
let injectHangCount = 0;

function readReqBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const sendJson = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary' && req.method === 'POST') {
    if (req.headers['x-codeium-csrf-token'] !== 'mock-ls-csrf-secret') return sendJson({ ok: false, error: 'bad-csrf' }, 403);
    return sendJson({
      response: {
        groups: [{
          displayName: 'Gemini Models',
          description: 'Gemini 4 Hydrogen',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: new Date(Date.now() + 3600000).toISOString() },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: new Date(Date.now() + 86400000 * 3).toISOString() }
          ]
        }]
      }
    });
  }
  const supplied = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
  if (supplied !== TEST_TOKEN) {
    return sendJson({ ok: false, error: 'bad-token' }, 403);
  }
  // 模拟桥接鉴权规矩（AGY_FEATURE_GAPS §0）：/api/agy/* 带 x-agent-token 一律 403
  if (url.pathname.startsWith('/api/agy/') && req.headers['x-agent-token']) {
    return sendJson({ ok: false, error: 'agent-token-forbidden-on-agy' }, 403);
  }
  // 模拟 /api/socialV2/* 与 /api/images/* 端点供 agy-api.mjs 测试
  if (url.pathname === '/api/socialV2/prompt' && req.method === 'GET') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    return sendJson({ ok: true, key: url.searchParams.get('key'), prompt: '完整角色卡：猫娘侍从测试全文' });
  }
  if (url.pathname === '/api/socialV2/wake-config' && req.method === 'POST') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    const body = await readReqBody(req);
    return sendJson({ ok: true, key: body.key, wakeConfig: body.config });
  }
  if (url.pathname === '/api/socialV2/wait' && req.method === 'POST') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    const body = await readReqBody(req);
    return sendJson({ ok: true, key: body.key, purpose: body.purpose, quiet: true, newMessages: [] });
  }
  if (url.pathname === '/api/socialV2/unread' && req.method === 'GET') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
    return sendJson({
      ok: true,
      key: url.searchParams.get('key'),
      unreadCount: 2,
      messages: [{ seq: afterSeq + 1, text: '@bot 在吗', atSelf: true }],
      readThroughSeq: afterSeq + 1
    });
  }
  if (url.pathname === '/api/socialV2/recent' && req.method === 'GET') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    return sendJson({ ok: true, key: url.searchParams.get('key'), messages: [{ seq: 100, text: '历史测试' }], readThroughSeq: 100 });
  }
  if (url.pathname === '/api/socialV2/memory-remove' && req.method === 'POST') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    const body = await readReqBody(req);
    return sendJson({ ok: true, key: body.key, removed: body.content || body.target });
  }
  if (url.pathname === '/api/socialV2/memory-clear' && req.method === 'POST') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    const body = await readReqBody(req);
    return sendJson({ ok: true, key: body.key, category: body.category || 'all' });
  }
  if (url.pathname === '/api/status' && req.method === 'GET') {
    return sendJson({ ok: true, snowlumaConnected: true });
  }
  if (url.pathname === '/api/images/message' && req.method === 'GET') {
    if (req.headers['x-agent-token'] !== TEST_SESSION_TOKEN) return sendJson({ ok: false, error: 'bad-agent-token' }, 403);
    return sendJson({
      ok: true,
      messageId: url.searchParams.get('messageId'),
      images: [{ index: 1, kind: 'image', mimeType: 'image/png', data: TINY_PNG_B64 }]
    });
  }
  if (!url.pathname.startsWith('/api/agy/')) {
    return sendJson({ ok: false, error: 'not-found' }, 404);
  }
  const action = url.pathname.slice('/api/agy/'.length);

  if (req.method === 'GET' && action === 'status') {
    return sendJson(transport.status({ onDuty, lastWorkerSeenAt, lastCompleteAt, transport: 'agy' }));
  }

  if (req.method === 'GET' && action === 'onebot') {
    const obAction = String(url.searchParams.get('action') ?? '');
    const groupId = String(url.searchParams.get('groupId') ?? '');
    return sendJson({ ok: true, action: obAction, groupId, data: [{ group_id: 541026885 }] });
  }

  if (req.method === 'GET' && action === 'wait') {
    if (injectDropCount > 0) {
      injectDropCount -= 1;
      req.socket.destroy();
      return;
    }
    if (injectHangCount > 0) {
      injectHangCount -= 1;
      // 模拟服务端卡死不回包，验证客户端 fetch 硬超时 + 退避重试
      return;
    }
    const persona = String(url.searchParams.get('persona') ?? '').trim();
    if (!persona) return sendJson({ ok: false, error: 'bad-request' }, 400);
    if (persona === '分流到DSH人格') {
      return sendJson({ ok: true, idle: true, reason: 'persona-on-dsh', transport: 'dsh' });
    }
    const got = await transport.wait({
      persona,
      workerId: String(url.searchParams.get('workerId') ?? ''),
      timeoutMs: Number(url.searchParams.get('timeoutMs')) || 1500,
      onDuty
    });
    lastWorkerSeenAt = fakeNow;
    if (!got) {
      res.writeHead(204);
      res.end();
      return;
    }
    return sendJson(got);
  }

  const body = await readReqBody(req);
  if (req.method === 'POST' && action === 'claim') {
    const r = transport.claim({
      turnId: body.turnId,
      persona: body.persona,
      workerId: body.workerId,
      onDuty
    });
    if (r.ok) lastWorkerSeenAt = fakeNow;
    return sendJson(r.ok ? { ok: true, turn: r.turn, leaseUntil: r.leaseUntil } : { ok: false, error: r.error }, r.http ?? 200);
  }
  if (req.method === 'POST' && action === 'touch') {
    const r = transport.touch({ turnId: body.turnId, workerId: body.workerId });
    return sendJson(r.ok ? { ok: true, leaseUntil: r.leaseUntil } : { ok: false, error: r.error }, r.http ?? 200);
  }
  if (req.method === 'POST' && action === 'requeue') {
    const r = transport.requeue({ turnId: body.turnId, reason: body.reason, note: body.note });
    return sendJson(r.ok ? { ok: true, attempts: r.attempts } : { ok: false, error: r.error }, r.http ?? 200);
  }
  if (req.method === 'POST' && action === 'complete') {
    if (!Array.isArray(body.replies)) {
      return sendJson({ ok: false, error: 'empty-replies-disallowed' }, 400);
    }
    const replies = body.replies.map((x) => String(x ?? '')).filter(Boolean);
    const r = transport.complete({ turnId: body.turnId, workerId: body.workerId });
    if (!r.ok) return sendJson({ ok: false, error: r.error }, r.http ?? 200);
    if (replies.length) {
      sentBatches.push({
        turnId: r.turn.turnId,
        key: r.turn.key,
        replies,
        replyToMessageId: body.replyToMessageId ?? null,
        atUserId: body.atUserId ?? null
      });
    }
    lastCompleteAt = fakeNow;
    return sendJson({ ok: true, sent: replies.length, failed: 0 });
  }
  return sendJson({ ok: false, error: 'unknown-agy-action' }, 404);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

function runScript(scriptName, args = [], stdinText = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', scriptName), ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGY_BRIDGE_URL: baseUrl,
        AGY_CONSOLE_TOKEN: TEST_TOKEN,
        AGY_LOG_PATH: testLogPath,
        AGY_NO_LOCK: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const outChunks = [];
    const errChunks = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout running ${scriptName}`));
    }, 20000);
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8')
      });
    });
    if (stdinText != null) child.stdin.write(stdinText, 'utf8');
    child.stdin.end();
  });
}

function parseTurnOutput(stdout) {
  const metaMatch = stdout.match(/=== AGY_TURN_META ===\n([^\n]+)\n=== AGY_PROMPT_BEGIN ===\n([\s\S]*)\n=== AGY_PROMPT_END ===/);
  assert.ok(metaMatch, `Unexpected turn stdout:\n${stdout}`);
  return {
    meta: JSON.parse(metaMatch[1]),
    prompt: metaMatch[2]
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  [PASS] ${name}`);
}

try {
  // 1. status
  await test('1. agy-status.mjs 返回 transport=agy', async () => {
    const r = await runScript('agy-status.mjs', ['--persona', '小鲸鱼', '--log']);
    assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.transport, 'agy');
    assert.equal(data.onDuty, '小鲸鱼');
  });

  // 2. 204 idle
  await test('2. agy-wait-wake.mjs 收到 204 返回 IDLE 且退出 0', async () => {
    const r = await runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--timeout-ms', '1000']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'IDLE');
  });

  // 3. not-on-duty idle
  await test('3. 非值班人格收到 IDLE not-on-duty 且不崩溃', async () => {
    const r = await runScript('agy-wait-wake.mjs', ['--persona', '猫娘侍从', '--not-on-duty-sleep-ms', '50']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'IDLE not-on-duty');
  });

  // 4. Verbatim prompt (>9KB) + touch + multi-line replies via --batch-stdin
  await test('4. 原样输出 >9KB prompt + touch 续租 + 分两条发送（不拼空格）', async () => {
    const longPrompt = `【唤醒头】\n${'测试行A1234567890\n'.repeat(600)}【尾部标记】`;
    assert.ok(Buffer.byteLength(longPrompt, 'utf8') > 9000);
    const enq = transport.enqueue({
      persona: '小鲸鱼',
      key: 'group:541026885',
      reason: 'mention',
      prompt: longPrompt,
      readThroughSeq: 47253
    });

    const w = await runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--timeout-ms', '2000']);
    assert.equal(w.status, 0, w.stderr);
    const parsed = parseTurnOutput(w.stdout);
    assert.equal(parsed.meta.turnId, enq.turnId);
    assert.equal(parsed.prompt, longPrompt);

    // 续租
    const t0 = parsed.meta.leaseUntil;
    fakeNow += 120 * 1000;
    const touchRes = await runScript('agy-touch.mjs', [
      '--turn-id', parsed.meta.turnId,
      '--persona', '小鲸鱼',
      '--worker-id', parsed.meta.workerId
    ]);
    assert.equal(touchRes.status, 0, touchRes.stderr);
    const touchData = JSON.parse(touchRes.stdout);
    assert.equal(touchData.ok, true);
    assert.ok(touchData.leaseUntil > t0);

    // 分两条发送 + replyToMessageId + atUserId（v1.3）
    const batch = JSON.stringify({
      turnId: parsed.meta.turnId,
      persona: '小鲸鱼',
      workerId: parsed.meta.workerId,
      replies: ['第一句带 "引号" 测试', '第二句独立发出'],
      replyToMessageId: -1234567890,
      atUserId: '123456789',
      meta: { rounds: 1 }
    });
    const rep = await runScript('agy-reply-and-wait.mjs', ['--batch-stdin'], batch);
    assert.equal(rep.status, 0, rep.stderr);
    const repData = JSON.parse(rep.stdout);
    assert.equal(repData.ok, true);
    assert.equal(repData.sent, 2);
    assert.equal(repData.failed, 0);

    const lastSent = sentBatches.at(-1);
    assert.deepEqual(lastSent.replies, ['第一句带 "引号" 测试', '第二句独立发出']);
    assert.equal(lastSent.replyToMessageId, -1234567890);
    assert.equal(lastSent.atUserId, '123456789');
  });

  // 5. Empty replies [] = mark read only
  await test('5. 空 replies=[] 只标已读不说话（sent=0）', async () => {
    const enq = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '安静看群' });
    const w = await runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--timeout-ms', '2000']);
    assert.equal(w.status, 0);
    const { meta } = parseTurnOutput(w.stdout);
    assert.equal(meta.turnId, enq.turnId);

    const beforeCount = sentBatches.length;
    const rep = await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin'],
      JSON.stringify({ turnId: meta.turnId, persona: '小鲸鱼', workerId: meta.workerId, replies: [] })
    );
    assert.equal(rep.status, 0, rep.stderr);
    const repData = JSON.parse(rep.stdout);
    assert.equal(repData.ok, true);
    assert.equal(repData.sent, 0);
    assert.equal(sentBatches.length, beforeCount);
  });

  // 6. Fake turnId -> 404 without crashing
  await test('6. 假 turnId 返回 404 turn-not-found 且脚本不崩溃', async () => {
    const rep = await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin'],
      JSON.stringify({ turnId: 't-does-not-exist-9999', persona: '小鲸鱼', replies: ['测试'] })
    );
    assert.equal(rep.status, 0, rep.stderr);
    const repData = JSON.parse(rep.stdout);
    assert.equal(repData.ok, false);
    assert.equal(repData.http, 404);
    assert.equal(repData.error, 'turn-not-found');
  });

  // 7. Reply-and-wait chains directly into next turn
  await test('7. agy-reply-and-wait.mjs --wait 完成后直接领取下一回合', async () => {
    const t1 = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '第一回合提示' });
    const t2 = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '第二回合提示' });

    const w1 = await runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--timeout-ms', '2000']);
    const p1 = parseTurnOutput(w1.stdout);
    assert.equal(p1.meta.turnId, t1.turnId);

    const rw = await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin', '--wait', '--timeout-ms', '2000'],
      JSON.stringify({ turnId: t1.turnId, persona: '小鲸鱼', workerId: p1.meta.workerId, replies: ['回复1'] })
    );
    assert.equal(rw.status, 0, rw.stderr);
    const firstNewline = rw.stdout.indexOf('\n');
    const completeJson = JSON.parse(rw.stdout.slice(0, firstNewline));
    assert.equal(completeJson.ok, true);
    assert.equal(completeJson.sent, 1);

    const p2 = parseTurnOutput(rw.stdout.slice(firstNewline + 1));
    assert.equal(p2.meta.turnId, t2.turnId);
    assert.equal(p2.prompt, '第二回合提示');

    // 收尾 t2
    const c2 = await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin'],
      JSON.stringify({ turnId: t2.turnId, persona: '小鲸鱼', workerId: p2.meta.workerId, replies: ['回复2'] })
    );
    assert.equal(c2.status, 0);
  });

  // 8. Requeue & 11-minute lease expiry requeue (attempts=1, no half-finished send)
  await test('8. requeue 与 11 分钟租约过期自动重排（attempts=1，无半成品发出）', async () => {
    const t = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '超长任务测试' });
    const w = await runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--timeout-ms', '2000']);
    const parsed = parseTurnOutput(w.stdout);
    assert.equal(parsed.meta.attempts, 0);

    const sentBefore = sentBatches.length;
    // 模拟卡 11 分钟
    fakeNow += 11 * 60 * 1000;
    const swept = transport.sweep();
    assert.equal(swept.length, 1);
    assert.equal(swept[0].turnId, t.turnId);
    assert.equal(swept[0].requeued, true);
    assert.equal(swept[0].attempts, 1);
    assert.equal(sentBatches.length, sentBefore);

    // 重新领取并验证 attempts=1，然后手动 requeue
    const w2 = await runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--timeout-ms', '2000']);
    const parsed2 = parseTurnOutput(w2.stdout);
    assert.equal(parsed2.meta.turnId, t.turnId);
    assert.equal(parsed2.meta.attempts, 1);

    const req = await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin'],
      JSON.stringify({ turnId: t.turnId, persona: '小鲸鱼', requeue: true, reason: 'tool-error', note: '模拟重试' })
    );
    assert.equal(req.status, 0, req.stderr);
    const reqData = JSON.parse(req.stdout);
    assert.equal(reqData.ok, true);
    assert.equal(reqData.attempts, 2);
    assert.equal(sentBatches.length, sentBefore);

    // 清理队里遗留的 t
    const w3 = await runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--timeout-ms', '2000']);
    const p3 = parseTurnOutput(w3.stdout);
    await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin'],
      JSON.stringify({ turnId: p3.meta.turnId, persona: '小鲸鱼', workerId: p3.meta.workerId, replies: [] })
    );
  });

  // 9. Concurrent claim conflict (409 already-claimed) recovery
  await test('9. 并发抢活出现 409 already-claimed 时自动重新 wait 不崩溃', async () => {
    const t1 = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '被抢走的回合' });
    const t2 = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '下一个回合' });

    const [a, b] = await Promise.all([
      runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--worker-id', 'agy-worker-A', '--timeout-ms', '2000']),
      runScript('agy-wait-wake.mjs', ['--persona', '小鲸鱼', '--worker-id', 'agy-worker-B', '--timeout-ms', '2000'])
    ]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    const pa = parseTurnOutput(a.stdout);
    const pb = parseTurnOutput(b.stdout);
    const ids = new Set([pa.meta.turnId, pb.meta.turnId]);
    assert.deepEqual(ids, new Set([t1.turnId, t2.turnId]));
  });

  // 10. #7: ECONNRESET mid-wait recovery (bridge restart)
  await test('10. #7 桥接重启掐断连接（ECONNRESET）时退避重试且自动恢复领活', async () => {
    injectDropCount = 2;
    const t = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '断线重连后领到的回合' });
    const w = await runScript('agy-wait-wake.mjs', [
      '--persona', '小鲸鱼',
      '--loop',
      '--timeout-ms', '2000',
      '--error-backoff-ms', '100',
      '--log-error-every', '2'
    ]);
    assert.equal(w.status, 0, w.stderr);
    const parsed = parseTurnOutput(w.stdout);
    assert.equal(parsed.meta.turnId, t.turnId);
    assert.equal(parsed.prompt, '断线重连后领到的回合');

    const c = await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin'],
      JSON.stringify({ turnId: t.turnId, persona: '小鲸鱼', workerId: parsed.meta.workerId, replies: [] })
    );
    assert.equal(c.status, 0);
  });

  // 11. #7: Stalled long-poll hard fetch timeout recovery
  await test('11. #7 服务端假死挂起时触发 fetch 硬超时并自动重连领活', async () => {
    injectHangCount = 1;
    const t = transport.enqueue({ persona: '小鲸鱼', key: 'group:541026885', prompt: '超时重连后领到的回合' });
    const w = await runScript('agy-wait-wake.mjs', [
      '--persona', '小鲸鱼',
      '--loop',
      '--timeout-ms', '1000',
      '--fetch-grace-ms', '300',
      '--error-backoff-ms', '100',
      '--log-error-every', '1'
    ]);
    assert.equal(w.status, 0, w.stderr);
    const parsed = parseTurnOutput(w.stdout);
    assert.equal(parsed.meta.turnId, t.turnId);

    const c = await runScript(
      'agy-reply-and-wait.mjs',
      ['--batch-stdin'],
      JSON.stringify({ turnId: t.turnId, persona: '小鲸鱼', workerId: parsed.meta.workerId, replies: [] })
    );
    assert.equal(c.status, 0);
  });

  // 12. persona-on-dsh exits cleanly even in --loop mode
  await test('12. persona-on-dsh 在 --loop 模式下立即返回 IDLE persona-on-dsh 不死等', async () => {
    const r = await runScript('agy-wait-wake.mjs', [
      '--persona', '分流到DSH人格',
      '--loop',
      '--timeout-ms', '2000'
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'IDLE persona-on-dsh');
  });

  // 13. --loop --exit-on-not-on-duty exits immediately on shift change
  await test('13. --loop --exit-on-not-on-duty 在非值班时立即返回 IDLE not-on-duty 以便会话下班', async () => {
    const t0 = Date.now();
    const r = await runScript('agy-wait-wake.mjs', [
      '--persona', '猫娘侍从',
      '--loop',
      '--exit-on-not-on-duty',
      '--not-on-duty-sleep-ms', '5000',
      '--timeout-ms', '2000'
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'IDLE not-on-duty');
    assert.ok(Date.now() - t0 < 3000, '应立即退出，不应等待 5000ms 休眠');
  });

  // 14. agy-api.mjs: prefix auth guard + wake-config --dive + wait-reply + prompt
  await test('14. agy-api.mjs 分前缀鉴权（/api/agy 不带 agent token，/api/socialV2 双带）与收尾闭环', async () => {
    // 即使传了 --session，访问 /api/agy/status 也绝不能带 x-agent-token（否则会 403）
    const agyCall = await runScript('agy-api.mjs', [
      'get', '--path', '/api/agy/status', '--session', TEST_SESSION_TOKEN
    ]);
    assert.equal(agyCall.status, 0, `stdout=${agyCall.stdout} stderr=${agyCall.stderr}`);
    assert.equal(JSON.parse(agyCall.stdout).transport, 'agy');

    // wake-config --dive
    const wc = await runScript('agy-api.mjs', [
      'wake-config', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--dive'
    ]);
    assert.equal(wc.status, 0, `stdout=${wc.stdout} stderr=${wc.stderr}`);
    const wcData = JSON.parse(wc.stdout);
    assert.equal(wcData.ok, true);
    assert.equal(wcData.wakeConfig.mode, 'diving');
    assert.equal(wcData.wakeConfig.infinite, true);
    assert.equal(wcData.wakeConfig.triggers.anyMessage, false);
    assert.deepEqual(wcData.wakeConfig.triggers.speakerIds, []);

    // wake-config --active --speaker-ids
    const wca = await runScript('agy-api.mjs', [
      'wake-config', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--active', '--speaker-ids', '123456,789012'
    ]);
    assert.equal(wca.status, 0, `stdout=${wca.stdout} stderr=${wca.stderr}`);
    const wcaData = JSON.parse(wca.stdout);
    assert.equal(wcaData.wakeConfig.mode, 'active');
    assert.equal(wcaData.wakeConfig.triggers.anyMessage, true);
    assert.deepEqual(wcaData.wakeConfig.triggers.speakerIds, ['123456', '789012']);

    // wait-reply
    const wr = await runScript('agy-api.mjs', [
      'wait-reply', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--quiet-ms', '10000'
    ]);
    assert.equal(wr.status, 0, wr.stderr);
    assert.equal(JSON.parse(wr.stdout).purpose, 'reply');

    // prompt（完整角色卡）
    const pr = await runScript('agy-api.mjs', [
      'prompt', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN
    ]);
    assert.equal(pr.status, 0, pr.stderr);
    assert.ok(JSON.parse(pr.stdout).prompt.includes('完整角色卡'));
  });

  // 15. agy-api.mjs: message-images PNG decode + cleanup-frames
  await test('15. agy-api.mjs message-images 自动落盘 PNG 供 read_file 看图并支持 cleanup-frames', async () => {
    const imgRes = await runScript('agy-api.mjs', [
      'message-images', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--message-id', 'selftest999'
    ]);
    assert.equal(imgRes.status, 0, `stdout=${imgRes.stdout} stderr=${imgRes.stderr}`);
    const data = JSON.parse(imgRes.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.savedFiles.length, 1);
    const savedPath = data.savedFiles[0].path;
    assert.ok(fs.existsSync(savedPath), `未落盘: ${savedPath}`);
    const buf = fs.readFileSync(savedPath);
    assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], '落盘文件不是合法 PNG');

    const clean = await runScript('agy-api.mjs', ['cleanup-frames']);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(fs.existsSync(savedPath), false, 'cleanup-frames 未删除临时图片');
  });

  // 16. agy-api.mjs: agy-quota reads local Antigravity LS quota summary
  await test('16. agy-api.mjs agy-quota 读取 Antigravity 5h/周剩余额度且不泄漏 CSRF', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'agy-api.mjs'), 'agy-quota'], {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
        ANTIGRAVITY_CSRF_TOKEN: 'mock-ls-csrf-secret',
        AGY_LOG_PATH: testLogPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const code = await new Promise((resolve) => child.on('close', resolve));
    const stdout = Buffer.concat(out).toString('utf8');
    assert.equal(code, 0, `stdout=${stdout} stderr=${Buffer.concat(err).toString('utf8')}`);
    const data = JSON.parse(stdout);
    assert.equal(data.ok, true);
    assert.equal(data.groups[0].buckets[0].remainingPct, 75);
    assert.ok(data.summary.includes('75.0%'));
  });

  // 17. agy-api.mjs: unread/recent + v1.3 onebot + memory-remove/clear + status
  await test('17. agy-api.mjs 支持 unread/recent、onebot(不带 agent token)、memory 删清与 status', async () => {
    const ur = await runScript('agy-api.mjs', [
      'unread', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--after-seq', '53363', '--limit', '30'
    ]);
    assert.equal(ur.status, 0, `stdout=${ur.stdout} stderr=${ur.stderr}`);
    const urData = JSON.parse(ur.stdout);
    assert.equal(urData.ok, true);
    assert.equal(urData.readThroughSeq, 53364);

    const rc = await runScript('agy-api.mjs', [
      'recent', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--limit', '10'
    ]);
    assert.equal(rc.status, 0, rc.stderr);
    assert.equal(JSON.parse(rc.stdout).ok, true);

    // 即使传入 --session，onebot 走 /api/agy/onebot 也绝不能带 x-agent-token
    const ob = await runScript('agy-api.mjs', [
      'group-members', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN
    ]);
    assert.equal(ob.status, 0, `stdout=${ob.stdout} stderr=${ob.stderr}`);
    const obData = JSON.parse(ob.stdout);
    assert.equal(obData.action, 'get_group_member_list');
    assert.equal(obData.groupId, '541026885');

    const mr = await runScript('agy-api.mjs', [
      'memory-remove', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--category', 'activeTopic', '--content', '旧话题'
    ]);
    assert.equal(mr.status, 0, mr.stderr);
    assert.equal(JSON.parse(mr.stdout).ok, true);

    const mc = await runScript('agy-api.mjs', [
      'memory-clear', '--key', 'group:541026885', '--session', TEST_SESSION_TOKEN, '--category', 'pendingThought'
    ]);
    assert.equal(mc.status, 0, mc.stderr);
    assert.equal(JSON.parse(mc.stdout).category, 'pendingThought');

    const st = await runScript('agy-api.mjs', ['status']);
    assert.equal(st.status, 0, st.stderr);
    assert.equal(JSON.parse(st.stdout).snowlumaConnected, true);
  });

  // 18. Log format & secret redaction check
  await test('18. 日志为合法单行 JSON，含断线/恢复事件且严禁包含令牌或完整 prompt', async () => {
    const rawLog = fs.readFileSync(testLogPath, 'utf8');
    assert.ok(!rawLog.includes(TEST_TOKEN), '日志泄漏了测试令牌！');
    assert.ok(!rawLog.includes(TEST_SESSION_TOKEN), '日志泄漏了会话令牌！');
    assert.ok(!rawLog.includes('mock-ls-csrf-secret'), '日志泄漏了 LS CSRF 令牌！');
    assert.ok(!rawLog.includes('测试行A1234567890'), '日志泄漏了 prompt 内容！');
    const lines = rawLog.trim().split('\n');
    assert.ok(lines.length >= 8, `日志条目过少: ${lines.length}`);
    let sawWaitError = false;
    let sawRecovered = false;
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.equal(typeof obj.at, 'number');
      assert.equal(typeof obj.workerId, 'string');
      assert.equal(typeof obj.persona, 'string');
      assert.equal(typeof obj.event, 'string');
      assert.equal('token' in obj, false);
      assert.equal('prompt' in obj, false);
      if (obj.event === 'error' && obj.where === 'wait') sawWaitError = true;
      if (obj.event === 'recovered') sawRecovered = true;
    }
    assert.ok(sawWaitError, '未记录 wait 断线 error 日志');
    assert.ok(sawRecovered, '未记录断线后 recovered 恢复日志');
  });

  console.log(`\n[ALL PASS] ${passed}/${passed} 项 AGY worker 契约测试通过`);
} finally {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
