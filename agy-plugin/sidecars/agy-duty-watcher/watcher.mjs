// watcher.mjs —— Antigravity Plugin Sidecar：监听 qq-bridge 的 AGY 值班切换并在 geminiqq 自动开新会话
//
// 目标：
//   1. 每 10 秒检查 GET http://127.0.0.1:<consolePort>/api/agy/status
//   2. 每当 dutyTransport 切到 "agy"（无论是 05:00 定时换班还是手动 POST /api/role 切换），
//      或当前处于 AGY 值班但没有活跃值守会话（例如上一会话满 20 轮主动下班防上下文超限）时，
//      在 geminiqq 项目下开启一个全新干净的 Antigravity 对话（默认 model="flash" = Gemini 4 Hydrogen Medium）。
//   3. 绝不修改桥接侧 src/**、config.json、state/*.json；绝不打印 console-token。
//
// 支持测试模式：
//   node watcher.mjs --once --dry-run

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRIDGE_ROOT = process.env.AGY_BRIDGE_ROOT || 'D:\\dsh\\qq-bridge';
const PROJECT_ID = process.env.AGY_PROJECT_ID || 'b95c8587-da33-48a1-a23a-dc49a11276c7';
const MODEL = process.env.AGY_MODEL || 'flash';
const POLL_MS = Math.max(3000, Number(process.env.AGY_POLL_MS) || 10000);
const RESPAWN_COOLDOWN_MS = Math.max(30000, Number(process.env.AGY_RESPAWN_COOLDOWN_MS) || 180000);
const BRIDGE_RECOVER_GRACE_MS = Math.max(10000, Number(process.env.AGY_BRIDGE_RECOVER_GRACE_MS) || 35000);
const WORKER_TAG = 'qq-duty-worker';
const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '';
const STATE_FILE = DATA_DIR ? path.join(DATA_DIR, 'watcher-state.json') : '';

function log(event, extra = {}) {
  const entry = { at: Date.now(), sidecar: 'agy-duty-watcher', event, ...extra };
  console.log(JSON.stringify(entry));
}

function readBridgeConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolveBridgeUrl() {
  if (process.env.AGY_BRIDGE_URL) return process.env.AGY_BRIDGE_URL.replace(/\/+$/, '');
  const cfg = readBridgeConfigSafe();
  const port = Number(cfg?.consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

function readConsoleToken() {
  if (process.env.AGY_CONSOLE_TOKEN) return process.env.AGY_CONSOLE_TOKEN.trim();
  const tokPath = path.join(BRIDGE_ROOT, 'state', 'console-token');
  try {
    const t = fs.readFileSync(tokPath, 'utf8').trim();
    if (t) return t;
  } catch { /* ignore */ }
  const cfg = readBridgeConfigSafe();
  return String(cfg?.consoleToken ?? '').trim();
}

function loadState() {
  if (!STATE_FILE) return { lastDutyTransport: null, lastOnDuty: null, lastSpawnAt: 0, lastConversationId: null };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastDutyTransport: null, lastOnDuty: null, lastSpawnAt: 0, lastConversationId: null };
  }
}

function saveState(st) {
  if (!STATE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
  } catch { /* ignore */ }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        accept: 'application/json',
        connection: 'close',
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    const text = await resp.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { http: resp.status, body };
  } catch (err) {
    return { http: 0, body: { ok: false, error: err?.cause?.code || err?.name || 'network-error' } };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBridgeStatus() {
  const token = readConsoleToken();
  if (!token) return { http: 0, body: { ok: false, error: 'missing-token' } };
  const base = resolveBridgeUrl();
  return fetchJsonWithTimeout(`${base}/api/agy/status`, {
    method: 'GET',
    headers: { 'x-console-token': token }
  }, 10000);
}

function getLsConfig() {
  const addr = String(process.env.ANTIGRAVITY_LS_ADDRESS ?? '').trim();
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN ?? '').trim();
  return addr && csrf ? { addr, csrf } : null;
}

async function hasRunningWorkerConversation(persona) {
  const ls = getLsConfig();
  if (!ls) return null; // 未知（无 LS 环境变量，退回依赖 bridge 心跳判断）
  const r = await fetchJsonWithTimeout(
    `http://${ls.addr}/product.v1.ConversationService/ListConversations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-antigravity-csrf-token': ls.csrf
      },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        tags: [WORKER_TAG, persona],
        pageSize: 10
      })
    },
    10000
  );
  if (r.http !== 200 || !Array.isArray(r.body?.conversations)) return null;
  const active = r.body.conversations.find((c) => c?.state?.runState === 'RUN_STATE_RUNNING');
  return active ? active.id : false;
}

function buildDutyPrompt(persona, triggerReason) {
  return [
    `现在由你接班执行「${persona}」的 QQ 值守任务（触发原因：${triggerReason}）。`,
    `请严格遵守 D:\\geminiqq\\.agents\\rules\\AGENTS.md 与 qq-bot-operator 规范：`,
    `1. 工作目录切换到 D:\\dsh\\qq-bridge，先跑 node scripts/agy-status.mjs --persona ${persona} 确认 dutyTransport 为 "agy"。`,
    `2. 领活与回话后等待一律使用 --loop --exit-on-not-on-duty --timeout-ms 90000，且调用 run_command 时不要设置 NotificationTimeoutSeconds（确保群里安静时 0 次唤醒模型、0 token 消耗，直到下一次有原因的真实唤醒或切班退出）。`,
    `3. 串行处理单个回合：若提示【长提示词已落盘】，先完整 read_file 读完 .md 再作答；严禁调用任何 qq_* 工具；PowerShell 管道传 JSON 前先设无 BOM UTF-8 $OutputEncoding。`,
    `4. 当脚本返回 IDLE not-on-duty 或 IDLE persona-on-dsh 时，立刻结束值守并收工。`,
    `5. 为防止上下文超限，本会话累计完成 20 轮 complete 后请主动结束值守并收工，由侧车自动拉起新会话无缝接力。`
  ].join('\n');
}

function formatBeijingStamp(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(5, 16);
}

async function spawnFreshConversation(persona, triggerReason) {
  const promptText = buildDutyPrompt(persona, triggerReason);
  const title = `${persona} QQ值守 (${formatBeijingStamp(Date.now())})`;

  if (DRY_RUN) {
    log('dry-run-spawn', { persona, triggerReason, projectId: PROJECT_ID, model: MODEL, title });
    return { ok: true, method: 'dry-run', conversationId: 'dry-run-id' };
  }

  // 优先走官方 ConversationService/CreateConversation（可显式指定 projectId、title、tags、model）
  const ls = getLsConfig();
  if (ls) {
    const r = await fetchJsonWithTimeout(
      `http://${ls.addr}/product.v1.ConversationService/CreateConversation`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-antigravity-csrf-token': ls.csrf
        },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          title,
          model: MODEL,
          tags: [WORKER_TAG, persona],
          prompt: [{ text: promptText }]
        })
      },
      15000
    );
    if (r.http === 200 && r.body?.conversation?.id) {
      return { ok: true, method: 'conversation-service', conversationId: r.body.conversation.id };
    }
    log('create-conversation-fallback', { http: r.http, error: r.body?.error ?? r.body?.code ?? 'unknown' });
  }

  // 回落到 Antigravity Sidecar 内置的 agentapi new-conversation（依赖 sidecar 绑定的 projectId）
  const proc = spawnSync('agentapi', ['new-conversation', '--', promptText], {
    encoding: 'utf8',
    timeout: 20000,
    shell: process.platform === 'win32'
  });
  if (proc.status === 0) {
    return { ok: true, method: 'agentapi', conversationId: String(proc.stdout || '').trim() || null };
  }
  return {
    ok: false,
    method: 'agentapi',
    error: String(proc.stderr || proc.error?.message || `exit-${proc.status}`).trim().slice(0, 300)
  };
}

function workerLockPath(persona) {
  const safe = Buffer.from(String(persona ?? 'default'), 'utf8').toString('hex');
  return path.join(os.tmpdir(), `agy-worker-active-${safe}.json`);
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function hasLiveLocalWorker(persona) {
  try {
    const raw = fs.readFileSync(workerLockPath(persona), 'utf8');
    const info = JSON.parse(raw);
    if (info && isPidAlive(info.pid)) {
      return Number(info.pid);
    }
  } catch { /* ignore */ }
  return null;
}

const state = loadState();
let consecutiveErrors = 0;
let bridgeRecoveredAt = 0;

async function tick() {
  const res = await fetchBridgeStatus();
  if (res.http !== 200 || !res.body?.ok) {
    consecutiveErrors += 1;
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      log('bridge-status-error', { http: res.http, error: res.body?.error ?? 'unknown', consecutiveErrors });
    }
    return;
  }
  if (consecutiveErrors > 0) {
    // 桥接刚重启恢复时，内存里的 workerSeenByPersona 会短暂清零；留出宽限期等已有 worker 自动重连，绝不误判重开会话
    bridgeRecoveredAt = Date.now();
    log('bridge-recovered', { afterErrors: consecutiveErrors, graceMs: BRIDGE_RECOVER_GRACE_MS });
    consecutiveErrors = 0;
  }

  const st = res.body;
  const dutyTransport = String(st.dutyTransport ?? (st.transport === 'agy' ? 'agy' : 'dsh'));
  const onDuty = String(st.onDuty ?? '').trim();
  const prevTransport = state.lastDutyTransport;
  const prevOnDuty = state.lastOnDuty;

  if (dutyTransport !== 'agy' || !onDuty) {
    if (prevTransport !== dutyTransport || prevOnDuty !== onDuty) {
      log('duty-not-agy', { dutyTransport, onDuty });
      state.lastDutyTransport = dutyTransport;
      state.lastOnDuty = onDuty;
      saveState(state);
    } else if (ONCE) {
      log('idle-not-agy', { dutyTransport, onDuty });
    }
    return;
  }

  const switchedIntoAgy = prevTransport !== 'agy' || prevOnDuty !== onDuty;
  const now = Date.now();
  const inBridgeRecoverGrace = bridgeRecoveredAt > 0 && (now - bridgeRecoveredAt) < BRIDGE_RECOVER_GRACE_MS;
  const liveLocalPid = hasLiveLocalWorker(onDuty);

  // 本地已有活着的 agy-wait-wake 进程在轮询该人格 ⇒ 绝不重复拉起第二个会话
  if (liveLocalPid) {
    if (switchedIntoAgy) {
      state.lastDutyTransport = dutyTransport;
      state.lastOnDuty = onDuty;
      saveState(state);
    }
    if (ONCE) log('skip-spawn-live-pid', { persona: onDuty, pid: liveLocalPid });
    return;
  }

  const sinceLastSpawn = now - (state.lastSpawnAt || 0);
  const queueDepth = Number(st.queue?.[onDuty] ?? 0);
  const workerSeenAt = Number(st.workerSeenByPersona?.[onDuty] ?? st.onDutyWorkerSeenAt ?? 0);
  const workerAgeMs = workerSeenAt > 0 ? now - workerSeenAt : Infinity;
  const workerMissingOrStale = Boolean(st.onDutyStale) || workerAgeMs > 180000;

  let triggerReason = null;
  if (switchedIntoAgy) {
    triggerReason = prevTransport === null ? 'watcher-startup-on-agy' : `switch:${prevTransport || 'none'}->agy`;
  } else if (inBridgeRecoverGrace) {
    if (ONCE) log('skip-spawn-recover-grace', { persona: onDuty, remainMs: BRIDGE_RECOVER_GRACE_MS - (now - bridgeRecoveredAt) });
    return;
  } else if (sinceLastSpawn >= RESPAWN_COOLDOWN_MS && (workerMissingOrStale || queueDepth > 0)) {
    const runningId = await hasRunningWorkerConversation(onDuty);
    if (runningId) {
      if (ONCE) log('worker-already-running', { persona: onDuty, conversationId: runningId });
      return;
    }
    triggerReason = workerMissingOrStale ? 'worker-stale-or-rotated' : 'pending-queue-no-worker';
  }

  if (!triggerReason) {
    if (ONCE) log('already-active', { persona: onDuty, workerAgeMs: Number.isFinite(workerAgeMs) ? workerAgeMs : null });
    return;
  }

  // 即使刚切换，也再查一次避免同人格已有正在跑的新会话
  const existingRunning = await hasRunningWorkerConversation(onDuty);
  if (existingRunning) {
    log('skip-spawn-running-exists', { persona: onDuty, conversationId: existingRunning, triggerReason });
    state.lastDutyTransport = dutyTransport;
    state.lastOnDuty = onDuty;
    saveState(state);
    return;
  }

  const spawned = await spawnFreshConversation(onDuty, triggerReason);
  if (spawned.ok) {
    log('spawned-fresh-conversation', {
      persona: onDuty,
      triggerReason,
      method: spawned.method,
      conversationId: spawned.conversationId
    });
    state.lastDutyTransport = dutyTransport;
    state.lastOnDuty = onDuty;
    state.lastSpawnAt = now;
    state.lastConversationId = spawned.conversationId;
    saveState(state);
  } else {
    log('spawn-failed', { persona: onDuty, triggerReason, method: spawned.method, error: spawned.error });
  }
}

log('started', { projectId: PROJECT_ID, model: MODEL, pollMs: POLL_MS, once: ONCE, dryRun: DRY_RUN });

if (ONCE) {
  await tick();
} else {
  while (true) {
    try {
      await tick();
    } catch (err) {
      log('tick-uncaught', { error: err?.message ?? String(err) });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
