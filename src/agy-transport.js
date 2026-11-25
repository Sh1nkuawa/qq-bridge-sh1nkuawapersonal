// AGY 传输层：唤醒队列 + 租约 + 重排（纯逻辑，不碰 bridge.js 内部）
//
// 契约见 docs/AGY_CONTRACT.md v1。设计要点：
//   · prompt 由桥接侧（buildWakePromptV2）拼好塞进队列 —— worker 只负责取/送，不改写 ✗
//   · 按 persona 分区：非值班者的 wait 立刻返回 idle，不占队列
//   · 认领即租约（默认 10 分钟）：超时未 complete 自动重排，最多 2 次后丢弃（绝不发半成品 ✗）
//   · 长轮询：wait 挂起直到有活或超时，返回 null 表示"没事，继续轮询"

export const AGY_ERRORS = {
  ALREADY_CLAIMED: 'already-claimed',
  TURN_NOT_FOUND: 'turn-not-found',
  NOT_ON_DUTY: 'not-on-duty',
  REQUEUED_TOO_MANY: 'requeued-too-many',
  TURN_NOT_CLAIMED: 'turn-not-claimed',
  EMPTY_REPLIES: 'empty-replies-disallowed'
};

export function createAgyTransport({
  leaseMs = 10 * 60 * 1000,
  maxAttempts = 2,
  maxQueue = 50,
  now = () => Date.now()
} = {}) {
  let seq = 0;
  /** turnId -> turn */
  const turns = new Map();
  /** persona -> turnId[]（队首在前） */
  const queues = new Map();
  /** 正在等活的 worker：{ persona, workerId, resolve, timer } */
  const waiters = new Set();
  const stats = { enqueued: 0, claimed: 0, completed: 0, requeued: 0, dropped: 0, expired: 0 };

  const q = (persona) => {
    if (!queues.has(persona)) queues.set(persona, []);
    return queues.get(persona);
  };

  function makeTurnId(at) {
    seq += 1;
    const d = new Date(at + 8 * 3600 * 1000); // 北京时间
    const stamp = d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
    return `t-${stamp}-${String(seq).padStart(4, '0')}`;
  }

  /** 入队。返回 turn（含 prompt）。队列超长时丢最旧的（与 DSH 路线一致）。 */
  function enqueue({ persona, key, reason = 'replyCheck', prompt = '', readThroughSeq = null, meta = null } = {}) {
    const at = now();
    const turn = {
      turnId: makeTurnId(at),
      persona: String(persona),
      key: String(key ?? ''),
      reason: String(reason),
      createdAt: at,
      attempts: 0,
      prompt: String(prompt),
      readThroughSeq: readThroughSeq == null ? null : Number(readThroughSeq),
      meta
    };
    const list = q(turn.persona);
    list.push(turn);
    while (list.length > maxQueue) {
      const dropped = list.shift();
      turns.delete(dropped.turnId);
      stats.dropped += 1;
    }
    turns.set(turn.turnId, turn);
    stats.enqueued += 1;
    // 唤醒一个等着这个 persona 的 worker
    for (const w of waiters) {
      if (w.persona === turn.persona) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(snapshot(turn));
        break;
      }
    }
    return snapshot(turn);
  }

  function snapshot(turn) {
    return turn ? { ...turn, prompt: turn.prompt } : null;
  }

  /** 长轮询取活：有活立即返回；否则挂起到 timeoutMs 返回 null。 */
  function wait({ persona, workerId = '', timeoutMs = 90000, onDuty = null } = {}) {
    const p = String(persona);
    // 不是值班者：立刻告诉它 idle（worker 应 5~10 秒后再来）
    if (onDuty && onDuty !== p) {
      return Promise.resolve({ idle: true, reason: AGY_ERRORS.NOT_ON_DUTY, onDuty });
    }
    const list = q(p);
    if (list.length) return Promise.resolve(snapshot(list[0]));

    const cap = Math.min(Math.max(Number(timeoutMs) || 90000, 1000), 120000);
    return new Promise((resolve) => {
      const w = { persona: p, workerId, resolve, timer: null };
      w.timer = setTimeout(() => {
        waiters.delete(w);
        resolve(null);
      }, cap);
      waiters.add(w);
    });
  }

  /** 认领：从队首移除并加租约（幂等：重复认领返回 already-claimed）。 */
  function claim({ turnId, persona, workerId = '', onDuty = null } = {}) {
    const id = String(turnId ?? '');
    const turn = turns.get(id);
    if (!turn) return { ok: false, http: 404, error: AGY_ERRORS.TURN_NOT_FOUND };
    if (onDuty && onDuty !== turn.persona) return { ok: false, http: 403, error: AGY_ERRORS.NOT_ON_DUTY };
    if (persona && String(persona) !== turn.persona) return { ok: false, http: 403, error: AGY_ERRORS.NOT_ON_DUTY };
    if (turn.workerId) return { ok: false, http: 409, error: AGY_ERRORS.ALREADY_CLAIMED };
    const list = q(turn.persona);
    const idx = list.findIndex((t) => t.turnId === id);
    if (idx >= 0) list.splice(idx, 1);
    turn.workerId = String(workerId ?? '');
    turn.leaseUntil = now() + leaseMs;
    stats.claimed += 1;
    return { ok: true, turn: snapshot(turn), leaseUntil: turn.leaseUntil };
  }

  /** 续租（看图/长任务时用）。 */
  function touch({ turnId, workerId = null } = {}) {
    const turn = turns.get(String(turnId ?? ''));
    if (!turn) return { ok: false, http: 404, error: AGY_ERRORS.TURN_NOT_FOUND };
    if (!turn.workerId) return { ok: false, http: 409, error: AGY_ERRORS.TURN_NOT_CLAIMED };
    if (workerId != null && turn.workerId && String(workerId) !== turn.workerId) {
      return { ok: false, http: 409, error: AGY_ERRORS.ALREADY_CLAIMED };
    }
    turn.leaseUntil = now() + leaseMs;
    return { ok: true, leaseUntil: turn.leaseUntil };
  }

  /** 回话成功：出队、清租约。返回 turn（调用方负责真正发 QQ）。 */
  function complete({ turnId, workerId = null } = {}) {
    const turn = turns.get(String(turnId ?? ''));
    if (!turn) return { ok: false, http: 404, error: AGY_ERRORS.TURN_NOT_FOUND };
    if (!turn.workerId) return { ok: false, http: 409, error: AGY_ERRORS.TURN_NOT_CLAIMED };
    if (workerId != null && String(workerId) !== turn.workerId) {
      return { ok: false, http: 409, error: AGY_ERRORS.ALREADY_CLAIMED };
    }
    turns.delete(turn.turnId);
    stats.completed += 1;
    return { ok: true, turn };
  }

  /** 退回队首（拒答/超时/工具失败），attempts+1；超过上限则丢弃。 */
  function requeue({ turnId, reason = 'manual', note = '' } = {}) {
    const id = String(turnId ?? '');
    const turn = turns.get(id);
    if (!turn) return { ok: false, http: 404, error: AGY_ERRORS.TURN_NOT_FOUND };
    turn.attempts += 1;
    turn.workerId = '';
    turn.leaseUntil = 0;
    turn.lastRequeue = { reason, note, at: now() };
    if (turn.attempts > maxAttempts) {
      turns.delete(id);
      stats.dropped += 1;
      return { ok: false, http: 409, error: AGY_ERRORS.REQUEUED_TOO_MANY, attempts: turn.attempts };
    }
    const list = q(turn.persona);
    list.unshift(turn);
    stats.requeued += 1;
    return { ok: true, turn: snapshot(turn), attempts: turn.attempts };
  }

  /** 回收超时租约（bridge 每分钟调一次）。 */
  function sweep() {
    const t = now();
    const touched = [];
    for (const turn of [...turns.values()]) {
      if (turn.workerId && turn.leaseUntil && t > turn.leaseUntil) {
        stats.expired += 1;
        const r = requeue({ turnId: turn.turnId, reason: 'lease-expired' });
        touched.push({ turnId: turn.turnId, requeued: r.ok, error: r.error ?? null, attempts: r.attempts ?? turn.attempts });
      }
    }
    return touched;
  }

  function hasWork(persona) {
    const list = queues.get(String(persona));
    return Boolean(list && list.length);
  }

  function status({ onDuty = null, lastWorkerSeenAt = null, lastCompleteAt = null, transport = 'agy' } = {}) {
    const queue = {};
    for (const [p, list] of queues) queue[p] = list.length;
    let claimed = 0;
    for (const t of turns.values()) if (t.workerId) claimed += 1;
    return {
      ok: true,
      transport,
      onDuty,
      queue,
      claimed,
      leaseSec: Math.round(leaseMs / 1000),
      maxAttempts,
      lastWorkerSeenAt,
      lastCompleteAt,
      stats: { ...stats },
      version: 1
    };
  }

  function pending(persona = null) {
    if (persona == null) return [...turns.values()].filter((t) => !t.workerId).length;
    return (queues.get(String(persona)) ?? []).length;
  }

  function reset() {
    turns.clear();
    queues.clear();
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(null); }
    waiters.clear();
  }

  return { enqueue, wait, claim, complete, requeue, touch, sweep, status, hasWork, pending, reset, snapshot };
}
