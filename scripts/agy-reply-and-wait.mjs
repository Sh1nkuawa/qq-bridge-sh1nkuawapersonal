// agy-reply-and-wait.mjs —— 把 agent 写好的回复送回桥接，并可选顺手领下一个回合
//
// 契约见 docs/AGY_CONTRACT.md v1，任务说明见 docs/AGY_WORKER_TASK.md。
//
// 推荐用法（PowerShell 用 here-string + --batch-stdin，避免吞双引号）：
//   @'
//   {"turnId":"t-20261125-05-0001","persona":"小鲸鱼","replies":["第一句","第二句"]}
//   '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
//
// 顺手领下一个回合（加 --wait）：
//   @'
//   {"turnId":"t-20261125-05-0001","persona":"小鲸鱼","replies":["收到"]}
//   '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin --wait
//
// 静默已读（不说话）：
//   @'
//   {"turnId":"t-20261125-05-0001","persona":"小鲸鱼","replies":[]}
//   '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
//
// 退回重排（模型拒答/工具出错，绝不把半成品发到群里）：
//   @'
//   {"turnId":"t-20261125-05-0001","persona":"小鲸鱼","requeue":true,"reason":"tool-error","note":"读图失败"}
//   '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
//
// 也支持 --batch <json>、--batch-file <path> 或直接命令行参数：
//   node scripts/agy-reply-and-wait.mjs --turn-id t-... --persona 小鲸鱼 --reply "第一句" --reply "第二句"

import fs from 'node:fs';
import {
  apiPost,
  appendWorkerLog,
  argOf,
  formatClaimedTurnStdout,
  hasFlag,
  manyOf,
  readConsoleToken,
  readStdinUtf8,
  resolveBaseUrl,
  resolvePersona,
  resolveWorkerId,
  waitAndClaimOne
} from './agy-lib.mjs';

function parseBatchJson(rawText, sourceLabel) {
  const trimmed = String(rawText ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new Error(`${sourceLabel} 为空`);
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('batch 必须是 JSON 对象');
    }
    return parsed;
  } catch (err) {
    throw new Error(`${sourceLabel} JSON 解析失败: ${err.message}`);
  }
}

async function loadInput() {
  const useStdin = hasFlag('batch-stdin');
  const batchFile = argOf('batch-file');
  const batchInline = argOf('batch');

  let batch = null;
  if (useStdin) {
    const stdinText = await readStdinUtf8();
    batch = parseBatchJson(stdinText, 'stdin');
  } else if (batchFile) {
    const fileText = fs.readFileSync(batchFile, 'utf8');
    batch = parseBatchJson(fileText, batchFile);
  } else if (batchInline != null) {
    batch = parseBatchJson(batchInline, '--batch');
  } else {
    batch = {};
  }

  const turnId = String(batch.turnId ?? argOf('turn-id') ?? '').trim();
  const persona = resolvePersona(batch.persona ?? argOf('persona'));
  const workerId = resolveWorkerId(persona, batch.workerId ?? argOf('worker-id'));
  const isRequeue = Boolean(batch.requeue) || hasFlag('requeue');
  const requeueReason = String(batch.reason ?? argOf('requeue-reason') ?? 'manual');
  const requeueNote = String(batch.note ?? argOf('requeue-note') ?? '');

  let replies;
  if (Array.isArray(batch.replies)) {
    replies = batch.replies.map((x) => String(x ?? ''));
  } else if (Array.isArray(batch.reply)) {
    replies = batch.reply.map((x) => String(x ?? ''));
  } else if (typeof batch.reply === 'string') {
    replies = [batch.reply];
  } else if (hasFlag('silent')) {
    replies = [];
  } else {
    const cliReplies = manyOf('reply');
    if (cliReplies.length > 0) {
      replies = cliReplies;
    } else {
      replies = undefined;
    }
  }

  const replyToRaw = batch.replyToMessageId ?? argOf('reply-to');
  const replyToMessageId = replyToRaw != null && replyToRaw !== '' ? Number(replyToRaw) : undefined;
  const meta = batch.meta && typeof batch.meta === 'object' ? batch.meta : undefined;

  return {
    turnId,
    persona,
    workerId,
    isRequeue,
    requeueReason,
    requeueNote,
    replies,
    replyToMessageId: Number.isFinite(replyToMessageId) ? replyToMessageId : undefined,
    meta
  };
}

const baseUrl = resolveBaseUrl(argOf('base-url'));
const shouldWaitNext = hasFlag('wait') && !hasFlag('no-wait');
const loop = hasFlag('loop');
const timeoutMs = Number(argOf('timeout-ms', '90000')) || 90000;
const notOnDutySleepMs = argOf('not-on-duty-sleep-ms') != null
  ? Number(argOf('not-on-duty-sleep-ms'))
  : 7000;
const errorBackoffMs = argOf('error-backoff-ms') != null
  ? Number(argOf('error-backoff-ms'))
  : 5000;

let input;
try {
  input = await loadInput();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: 'bad-request', message: err.message }));
  process.exit(1);
}

let token;
try {
  token = readConsoleToken(argOf('token-file'));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: 'token-unavailable', message: err.message }));
  process.exit(1);
}

if (!input.turnId) {
  console.error(JSON.stringify({ ok: false, error: 'bad-request', message: '缺少 turnId' }));
  process.exit(1);
}

let actionOutcome = null;

if (input.isRequeue) {
  const res = await apiPost({
    baseUrl,
    token,
    pathname: '/api/agy/requeue',
    payload: {
      turnId: input.turnId,
      reason: input.requeueReason,
      note: input.requeueNote
    }
  });

  if (res.http === 200 && res.body?.ok) {
    appendWorkerLog({
      workerId: input.workerId,
      persona: input.persona,
      event: 'requeue',
      extra: {
        turnId: input.turnId,
        reason: input.requeueReason,
        attempts: res.body.attempts ?? null,
        ok: true
      },
      secretToken: token
    });
    actionOutcome = {
      ok: true,
      action: 'requeue',
      turnId: input.turnId,
      attempts: res.body.attempts ?? null
    };
  } else {
    const errCode = String(res.body?.error ?? `http-${res.http}`);
    appendWorkerLog({
      workerId: input.workerId,
      persona: input.persona,
      event: 'error',
      extra: { where: 'requeue', turnId: input.turnId, http: res.http, error: errCode },
      secretToken: token
    });
    actionOutcome = {
      ok: false,
      action: 'requeue',
      turnId: input.turnId,
      http: res.http,
      error: errCode
    };
  }
} else {
  if (input.replies === undefined) {
    console.error(JSON.stringify({
      ok: false,
      error: 'empty-replies-disallowed',
      message: '缺少 replies 数组（若只标已读不说话，请显式传 "replies": [] 或 --silent）'
    }));
    process.exit(1);
  }

  const payload = {
    turnId: input.turnId,
    persona: input.persona,
    workerId: input.workerId,
    replies: input.replies,
    ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {})
  };

  const res = await apiPost({
    baseUrl,
    token,
    pathname: '/api/agy/complete',
    payload
  });

  if (res.http === 200 && res.body?.ok) {
    appendWorkerLog({
      workerId: input.workerId,
      persona: input.persona,
      event: 'complete',
      extra: {
        turnId: input.turnId,
        sent: res.body.sent ?? 0,
        failed: res.body.failed ?? 0,
        ok: true
      },
      secretToken: token
    });
    actionOutcome = {
      ok: true,
      action: 'complete',
      turnId: input.turnId,
      sent: res.body.sent ?? 0,
      failed: res.body.failed ?? 0
    };
  } else {
    const errCode = String(res.body?.error ?? `http-${res.http}`);
    appendWorkerLog({
      workerId: input.workerId,
      persona: input.persona,
      event: 'error',
      extra: { where: 'complete', turnId: input.turnId, http: res.http, error: errCode },
      secretToken: token
    });
    actionOutcome = {
      ok: false,
      action: 'complete',
      turnId: input.turnId,
      http: res.http,
      error: errCode
    };
  }
}

console.log(JSON.stringify(actionOutcome));

// 404/409（例如假 turnId 或已被回收）脚本不崩溃；若带 --wait 则顺手继续等下一回合
const recoverableCompleteMiss =
  !actionOutcome.ok && (actionOutcome.http === 404 || actionOutcome.http === 409) &&
  actionOutcome.error !== 'transport-not-agy';

if (!shouldWaitNext) {
  process.exitCode = actionOutcome.ok || recoverableCompleteMiss ? 0 : 1;
} else if (!actionOutcome.ok && !recoverableCompleteMiss) {
  process.exitCode = 1;
} else {
  const next = await waitAndClaimOne({
    baseUrl,
    token,
    persona: input.persona,
    workerId: input.workerId,
    timeoutMs,
    afterTurnId: input.turnId,
    loop,
    notOnDutySleepMs,
    errorBackoffMs
  });

  if (next.status === 'idle') {
    console.log(next.reason && next.reason !== 'timeout' ? `IDLE ${next.reason}` : 'IDLE');
    process.exitCode = 0;
  } else if (next.status === 'claimed') {
    process.stdout.write(`${formatClaimedTurnStdout({
      turn: next.turn,
      leaseUntil: next.leaseUntil,
      workerId: input.workerId
    })}\n`);
    process.exitCode = 0;
  } else {
    console.error(JSON.stringify({
      ok: false,
      where: 'wait-after-reply',
      http: next.http ?? 0,
      error: next.error ?? 'unknown-error'
    }));
    process.exitCode = 1;
  }
}
