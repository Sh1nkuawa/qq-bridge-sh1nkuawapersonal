// 语音服务（GPT-SoVITS API）的按需生命周期管理。
//
// owner 2026-10-24 要求：
//   · 需要时由**桥接拉起**（不用手动开 ✓）
//   · **30 分钟没人用就自动关**（把 4.2 GB 显存放出来 ✓）
//   · 起不来 ⇒ 拒绝发语音（不做任何降级 ✓）
//
// 关键设计：
//   · **直接 spawn python**（不是 start-tts.bat）⇒ 我们持有真实 PID，能精确杀掉 ✓；
//   · detached + unref：桥接重启/退出不会连带杀死它 ✓（但我们会记录 PID 以便关闭）；
//   · 探测用 HTTP /docs（2 秒超时），连不上=没起；
//   · 拉起后**轮询等待就绪**（默认最多 90 秒，加载模型约 40 秒）；
//   · 空闲检查每 2 分钟跑一次（unref，不阻塞进程退出）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_IDLE_MINUTES = 30;
const PORTS = { port: 9880 };

function loadServiceConfig({ stateDir = 'state' } = {}) {
  const base = {
    gsvRoot: 'D:\\AI\\gsv\\GPT-SoVITS-v2pro-20250604',
    pythonRel: 'runtime\\python.exe',
    apiRel: 'api_v2.py',
    configRel: 'GPT_SoVITS\\configs\\tts_infer_shinku.yaml',
    host: '127.0.0.1',
    port: 9880,
    startupTimeoutMs: 120000,
    idleMinutes: DEFAULT_IDLE_MINUTES,
    logFile: 'D:\\AI\\gsv\\tts-service.log'
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'tts.json'), 'utf8').replace(/^\uFEFF/, ''));
    return { ...base, ...(raw.service ?? {}) , ...(raw.idleMinutes ? { idleMinutes: Number(raw.idleMinutes) } : {}) };
  } catch { return base; }
}

async function probeUp(host, port, timeoutMs = 2000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}/docs`, { signal: ctl.signal }).finally(() => clearTimeout(t));
    return res.ok || res.status === 404;   // 有响应就说明在听
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个服务管理器。
 * @param {object} opts { log, stateDir, now, probe, spawner, killer }（后三个可注入，便于测试）
 */
export function createTtsService({
  log = () => {},
  stateDir = 'state',
  now = () => Date.now(),
  probe = probeUp,
  spawner = null,
  killer = null,
  sleeper = sleep
} = {}) {
  const cfg = loadServiceConfig({ stateDir });
  const stateFile = path.join(stateDir, 'tts-service.json');
  // ⚠️ 2026-10-24 踩过：lastUsedAt 原来只在内存里 ⇒ 桥接一重启就归零
  // ⇒ checkIdle 认为"从没用过" ⇒ 空闲自动关**永远不会触发** ✗（日志实测 0 条）。
  // 所以持久化：重启后接着算。
  let lastUsedAt = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      return Number(raw?.lastUsedAt) || 0;
    } catch { return 0; }
  })();
  let childPid = null;
  let idleTimer = null;
  let starting = null;

  const isUp = () => probe(cfg.host, cfg.port);

  function spawnDefault() {
    const py = path.join(cfg.gsvRoot, cfg.pythonRel);
    if (!fs.existsSync(py)) throw new Error(`找不到 Python：${py}`);
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    const out = fs.openSync(cfg.logFile, 'a');
    const child = spawn(py, ['-u', '-I', cfg.apiRel, '-a', cfg.host, '-p', String(cfg.port), '-c', cfg.configRel], {
      cwd: cfg.gsvRoot,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true
    });
    child.unref();
    return child;
  }

  async function killDefault(pid) {
    if (!pid) return;
    const { spawnSync } = await import('node:child_process');
    try { spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, timeout: 15000 }); } catch { /* ignore */ }
  }

  function touch() {
    lastUsedAt = now();
    try { fs.writeFileSync(stateFile, JSON.stringify({ pid: childPid, lastUsedAt, touchedAt: lastUsedAt }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
    return lastUsedAt;
  }

  /** 空闲到点就关（由定时器调用） */
  async function checkIdle() {
    if (!lastUsedAt) return { stopped: false, reason: 'never-used' };
    const idleMs = now() - lastUsedAt;
    if (idleMs < (Number(cfg.idleMinutes) || DEFAULT_IDLE_MINUTES) * 60000) return { stopped: false, reason: 'still-recent', idleMs };
    if (!(await isUp())) { childPid = null; return { stopped: false, reason: 'already-down' }; }
    log(`[tts] 已空闲 ${Math.round(idleMs / 60000)} 分钟（阈值 ${cfg.idleMinutes}）⇒ 关闭语音服务，收回显存`);
    const pid = childPid;
    childPid = null;
    if (pid) await (killer ?? killDefault)(pid);
    else await (killer ?? killDefault)(await findPidByPort(cfg.port));
    return { stopped: true, idleMs };
  }

  function scheduleIdleCheck() {
    if (idleTimer) return;
    idleTimer = setInterval(() => { void checkIdle(); }, 2 * 60 * 1000);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  /**
   * 确保服务在跑：已在听就直接复用；没在听就拉起来并等到就绪。
   * @returns {{ok:boolean, started?:boolean, error?:string}}
   */
  async function ensureRunning() {
    if (await isUp()) { touch(); scheduleIdleCheck(); return { ok: true, started: false }; }
    if (starting) return starting;   // 并发调用只拉起一次
    starting = (async () => {
      try {
        log('[tts] 语音服务未启动 ⇒ 正在拉起（首次约需 40 秒）');
        const child = (spawner ?? spawnDefault)(cfg);
        childPid = child?.pid ?? null;
        if (childPid) { try { fs.writeFileSync(stateFile, JSON.stringify({ pid: childPid, startedAt: now(), lastUsedAt }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
        const deadline = now() + (Number(cfg.startupTimeoutMs) || 120000);
        while (now() < deadline) {
          await sleeper(2500);
          if (await isUp()) { log('[tts] 语音服务已就绪'); touch(); scheduleIdleCheck(); return { ok: true, started: true }; }
        }
        return { ok: false, error: `语音服务启动超时（${Math.round((Number(cfg.startupTimeoutMs) || 120000) / 1000)} 秒）` };
      } catch (error) {
        return { ok: false, error: `语音服务启动失败：${error?.message ?? error}` };
      } finally { starting = null; }
    })();
    return starting;
  }

  return { ensureRunning, touch, checkIdle, isUp, cfg, _state: () => ({ lastUsedAt, childPid }) };
}

/** 按端口找 PID（Windows netstat 兜底） */
export async function findPidByPort(port, { runner = null } = {}) {
  const { spawnSync } = await import('node:child_process');
  try {
    const r = spawnSync('netstat', ['-ano'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    const line = String(r.stdout ?? '').split(/\r?\n/).find((l) => l.includes(`:${port}`) && /LISTENING/i.test(l));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}
