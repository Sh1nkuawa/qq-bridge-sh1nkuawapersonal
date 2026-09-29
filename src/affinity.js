// affinity.js — 群友好感度（关系）引擎：**纯函数**，不依赖桥接内存，方便单测。
//
// 设计原则（与 owner 敲定）：
//   1) 分数只是内部量化，**对群友完全隐藏** —— 只通过"称呼 + 语气"体现出来；
//   2) 起始 40（普通群友），量程 -20 ~ 100；允许负档（梁子），但只针对刷屏/复读/恶意；
//   3) 客观分由桥接按确定性规则累计（可复现、可解释、防刷），每日涨跌封顶；
//   4) 阶段 1 只驱动"称呼 + 语气"，不动配额/唤醒优先级（那些留给后续阶段）。
//
// 为什么不用模型打分：模型打分容易漂移与自我强化，且每轮都要花 token。
// 先用确定性规则跑起来，等表看起来合理了再考虑加"有上限的模型微调"。

export const DEFAULT_AFFINITY = {
  enabled: true,
  start: 40,
  // 量程拉开：分档阈值高（自己人 300+），配合"每天最多 ±6"的细则，涨得慢、也难得掉到底。
  // 两端留足余量，等于让"自己人"和"梁子"都是开区间档。
  min: -200,
  max: 1000,
  // 每日净变化封顶（超出部分只记事件、不计分）
  dailyUp: 6,
  dailyDown: 6,
  // 多久没互动开始衰减、衰减下限（不互动≠讨厌，所以只掉到 decayTo）
  decayAfterDays: 7,
  decayTo: 20,
  decayPerDay: 1,
  // 踢到雷点的词（触碰机器人的明确雷点，例如人设里的"蓝色大肥鱼"）
  rudeKeywords: ['大肥鱼', '肥鱼', '死鱼', '傻鱼', '蠢鱼', '蓝色胖子', '蓝胖子'],
  // 刷屏判定：窗口内消息数 >= spamCount 且（重复内容 >= spamRepeat 或 平均长度 <= spamShortChars）
  spamWindowMs: 60000,
  spamCount: 6,
  spamRepeat: 3,
  spamShortChars: 6,
  // 单类事件每日计分上限
  caps: { attention: 4, share: 2, rude: 2, spam: 2 },
  // 互动事件的有效窗口：超过这个时间没说话，重新算"今天第一次"
  activeWindowMs: 10 * 60 * 1000
};

export function mergeAffinityConfig(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const out = { ...DEFAULT_AFFINITY, ...src };
  out.caps = { ...DEFAULT_AFFINITY.caps, ...(src.caps && typeof src.caps === 'object' ? src.caps : {}) };
  if (!Array.isArray(out.rudeKeywords)) out.rudeKeywords = [...DEFAULT_AFFINITY.rudeKeywords];
  return out;
}

/** 分档表：分数 → {key,label,toneLevel,nameRule}
 *  边界与 start(40) 对齐 —— 40 必须落在最中性的"普通群友"，
 *  否则新成员一进来就是"眼熟/客气"语气，等于默认冷脸。
 *  2026-09-27 按 owner 要求改为宽量程：自己人 300+ / 熟人 100~299 / 普通群友 40~99 /
 *  眼熟 0~39 / 有点烦 -49~-1 / 梁子 ≤-50（原写法 -50 归属有歧义，按"越负越差"处理）。 */
export function tierOf(score, cfg = DEFAULT_AFFINITY) {
  const s = Number(score);
  if (!Number.isFinite(s)) return tierOf(cfg.start, cfg);
  if (s >= 300) return { key: 'inner', label: '自己人', toneLevel: 0, nameRule: 'nickname' };
  if (s >= 100) return { key: 'close', label: '熟人', toneLevel: 1, nameRule: 'nickname' };
  if (s >= 40) return { key: 'normal', label: '普通群友', toneLevel: 2, nameRule: 'full' };
  if (s >= 0) return { key: 'familiar', label: '眼熟', toneLevel: 3, nameRule: 'full' };
  if (s > -50) return { key: 'bother', label: '有点烦', toneLevel: 4, nameRule: 'full' };
  return { key: 'grudge', label: '梁子', toneLevel: 5, nameRule: 'avoid' };
}

/** 语气档位说明（注入提示词用；必须简短、可执行） */
export const TONE_RULES = [
  '0 自己人：亲昵、互损、主动找他说话；可以起外号、可以拿他开玩笑，被怼了可以怼回去。',
  '1 熟人：随意、爱开玩笑、愿意接话和帮忙；可以直接叫名字。',
  '2 普通群友：正常聊天，不冷不热；不主动献殷勤，也不故意冷落。',
  '3 眼熟：客气、简短；不主动找他搭话，问他事就正常答。',
  '4 有点烦：敷衍、少接话（可以已读乱回、装没看见）；但不骂人、不人身攻击。',
  '5 梁子：冷淡、能推就推；最多阴阳一句，绝不说难听话、不主动攻击。'
];

function todayKey(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyMember(userId, name, cfg = DEFAULT_AFFINITY) {
  const now = Date.now();
  return {
    userId: String(userId),
    name: String(name ?? ''),
    score: Number(cfg.start),
    counters: {},
    dailyDelta: 0,
    dailyDate: todayKey(now),
    lastInteractAt: 0,
    lastScoreAt: 0,
    events: [],
    nickname: ''
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function bumpCounter(member, day, kind) {
  if (!member.counters || typeof member.counters !== 'object') member.counters = {};
  const key = `${day}:${kind}`;
  member.counters[key] = (Number(member.counters[key]) || 0) + 1;
  return member.counters[key];
}

function getCounter(member, day, kind) {
  if (!member.counters || typeof member.counters !== 'object') return 0;
  return Number(member.counters[`${day}:${kind}`]) || 0;
}

function pruneCounters(member, keepDay) {
  if (!member.counters || typeof member.counters !== 'object') return;
  const next = {};
  for (const [k, v] of Object.entries(member.counters)) {
    if (k.startsWith(`${keepDay}:`)) next[k] = v;
  }
  member.counters = next;
}

/**
 * 处理一天翻页：重置每日额度。
 * 同一天内如果距上次互动超过 activeWindowMs，允许重新触发一次"今天第一次互动"加成。
 */
function rollDayIfNeeded(member, cfg, now) {
  const day = todayKey(now);
  if (member.dailyDate !== day) {
    member.dailyDate = day;
    member.dailyDelta = 0;
    pruneCounters(member, day);
  }
  return day;
}

/** 懒衰减：长期不互动的人慢慢回落，但只掉到 decayTo（不互动≠讨厌） */
export function applyDecay(member, cfg, now) {
  const c = mergeAffinityConfig(cfg);
  const last = Number(member.lastInteractAt) || 0;
  if (!last) return 0;
  const idleDays = Math.floor((now - last) / 86400000);
  if (idleDays <= c.decayAfterDays) return 0;
  const shouldBe = Math.max(c.decayTo, member.score - (idleDays - c.decayAfterDays) * c.decayPerDay);
  const target = Math.max(shouldBe, c.min);
  if (target >= member.score) return 0;
  const delta = target - member.score;
  member.score = target;
  member.lastScoreAt = now;
  return delta;
}

/**
 * 记一次事件并结算分数（确定性）。
 * event: { kind, text?, mediaCount?, repeatCount?, sameSenderRecent?, sinceBotMsgMs? }
 * 返回 { delta, reasons: [] }
 */
export function recordEvent(member, event, cfg, now = Date.now()) {
  const c = mergeAffinityConfig(cfg);
  if (!c.enabled) return { delta: 0, reasons: [] };
  const day = rollDayIfNeeded(member, c, now);
  const reasons = [];
  let raw = 0;

  const kind = String(event?.kind ?? '');
  const text = String(event?.text ?? '');
  const firstToday = getCounter(member, day, 'first') === 0;

  const add = (d, why) => { raw += d; reasons.push(`${why}${d >= 0 ? '+' : ''}${d}`); };

  if (kind === 'message') {
    // 今天第一次冒泡：算"愿意跟我说话"，但之后普通聊天不再加分（否则话多的人白拿分）
    if (firstToday) {
      bumpCounter(member, day, 'first');
      add(2, '今天首次互动');
    }
    // @ 我 / 引用我：注意力信号，有每日上限
    if (event?.attention) {
      const n = bumpCounter(member, day, 'attention');
      if (n <= c.caps.attention) add(1, '主动找我');
    }
    // 发图/表情：分享行为，有每日上限
    if (Number(event?.mediaCount) > 0) {
      const n = bumpCounter(member, day, 'share');
      if (n <= c.caps.share) add(1, '发图/表情');
    }
    // 触碰雷点词
    const hitRude = c.rudeKeywords.find((w) => w && text.includes(w));
    if (hitRude) {
      const n = bumpCounter(member, day, 'rude');
      if (n <= c.caps.rude) add(-2, `踩雷（${hitRude}）`);
    }
    // 刷屏/复读
    const isSpam = Number(event?.spamCount) >= c.spamCount
      && (Number(event?.repeatCount) >= c.spamRepeat || Number(event?.avgChars) <= c.spamShortChars);
    if (isSpam) {
      const n = bumpCounter(member, day, 'spam');
      if (n <= c.caps.spam) add(-2, '刷屏/复读');
    }
  }

  if (kind === 'feed') {
    // 投喂（爱发电订单核验通过后由桥接调用）。按 owner 定的规则：每人每天第一笔 +dailyAffinity，
    // 之后当天不再加。**刻意绕过每日封顶** —— 否则投喂的 +5 会被当天聊天/发图的日常分挤掉
    // （比如先聊了 +2，投喂就只剩 +4），那 owner 定的"投喂 +5"就不成立了。
    const bonus = Math.max(0, Number(event?.affinity) || 0);
    if (bonus > 0) {
      raw += bonus;
      reasons.push(`投喂+${bonus}（不计入日封顶）`);
    }
  }

  if (kind === 'left') {
    // 主动退群/被踢（保留给后续阶段使用）
    add(-c.dailyDown, '离开群聊');
  }

  // 每日封顶（只影响分数，不影响 counters 记录）。
  // kind='feed' 的加分在 raw 里，但下面这行会把总量一起裁 —— 所以投喂单独走"不裁剪"路径。
  const bypassCap = kind === 'feed';
  const capped = bypassCap
    ? (member.score + raw > c.max ? c.max - member.score : raw)
    : clamp(member.dailyDelta + raw, -c.dailyDown, c.dailyUp) - member.dailyDelta;
  if (!bypassCap && capped !== raw) reasons.push(`日上限裁剪 ${raw >= 0 ? '+' : ''}${raw}→${capped >= 0 ? '+' : ''}${capped}`);
  if (!bypassCap) member.dailyDelta += capped;
  const before = member.score;
  member.score = clamp(member.score + capped, c.min, c.max);
  member.lastScoreAt = now;
  if (kind === 'message') member.lastInteractAt = now;
  if (event?.name) member.name = String(event.name);
  // 事件日志（最近 20 条，便于排查"这分怎么来的"）
  if (!Array.isArray(member.events)) member.events = [];
  member.events.push({ at: now, kind, delta: member.score - before, reasons: reasons.join(';') });
  if (member.events.length > 20) member.events = member.events.slice(-20);

  return { delta: member.score - before, reasons, score: member.score, tier: tierOf(member.score, c) };
}

/** 在已有成员表上取（或创建）某人 */
export function ensureMember(members, userId, name, cfg = DEFAULT_AFFINITY) {
  const id = String(userId ?? '').trim();
  if (!id) return null;
  if (!members || typeof members !== 'object') return null;
  if (!members[id]) members[id] = emptyMember(id, name, mergeAffinityConfig(cfg));
  if (name) members[id].name = String(name);
  return members[id];
}

/** 把活跃成员的关系注入提示词（只给当前在场的人，省 token 也不泄露全表） */
export function formatAffinityPanel(members, activeList, cfg = DEFAULT_AFFINITY) {
  const c = mergeAffinityConfig(cfg);
  if (!c.enabled) return '';
  const list = Array.isArray(activeList) ? activeList : [];
  const rows = [];
  const usedTones = new Set();
  for (const item of list) {
    const id = String(item?.userId ?? '').trim();
    if (!id) continue;
    const m = members?.[id];
    if (!m) continue;
    const tier = tierOf(m.score, c);
    usedTones.add(tier.toneLevel);
    const nameHint = tier.nameRule === 'nickname'
      ? '可以叫得亲近一点（名字/外号）'
      : (tier.nameRule === 'avoid' ? '不叫称呼，用"那位"之类带过' : '必须用他的群名片全称');
    const nick = m.nickname ? `，你给他起的外号是"${m.nickname}"` : '';
    rows.push(`- ${m.name || id}：${tier.label}（语气档 ${tier.toneLevel}；${nameHint}${nick}）`);
  }
  if (!rows.length) return '';
  const tones = TONE_RULES.filter((r) => usedTones.has(Number(r.slice(0, 1))));
  return '【关系（内部参考，绝不能说出口）】\n'
    + rows.join('\n') + '\n'
    + '对应语气要求：\n' + tones.map((t) => `- ${t}`).join('\n') + '\n'
    + '注意：这套分档是内部状态，**不要**对群友提"好感度/关系分/档位"这类字眼，也不要说"你是熟人/有点烦"。只体现在你怎么叫他们、以及说话的温度上。\n\n';
}

/** 读盘时的字段清洗（防脏数据） */
export function sanitizeAffinityState(raw, cfg = DEFAULT_AFFINITY) {
  const c = mergeAffinityConfig(cfg);
  const out = { members: {}, updatedAt: Number(raw?.updatedAt) || 0 };
  const src = raw && typeof raw.members === 'object' && raw.members ? raw.members : {};
  for (const [id, val] of Object.entries(src)) {
    if (!/^\d+$/.test(id)) continue;
    if (!val || typeof val !== 'object') continue;
    const score = clamp(Number(val.score) || c.start, c.min, c.max);
    out.members[id] = {
      userId: id,
      name: String(val.name ?? '').slice(0, 40),
      score,
      counters: (val.counters && typeof val.counters === 'object') ? val.counters : {},
      dailyDelta: Number(val.dailyDelta) || 0,
      dailyDate: String(val.dailyDate ?? ''),
      lastInteractAt: Number(val.lastInteractAt) || 0,
      lastScoreAt: Number(val.lastScoreAt) || 0,
      events: Array.isArray(val.events) ? val.events.slice(-20) : [],
      nickname: String(val.nickname ?? '').slice(0, 20)
    };
  }
  return out;
}

/** 控制台/日志用的简报 */
export function summarizeAffinity(members, cfg = DEFAULT_AFFINITY) {
  const c = mergeAffinityConfig(cfg);
  const rows = Object.values(members || {})
    .map((m) => ({ name: m.name || m.userId, score: m.score, tier: tierOf(m.score, c).label, last: m.lastInteractAt }))
    .sort((a, b) => b.score - a.score);
  return rows;
}

/**
 * 把所有成员重置回起始分（owner 要求"全部归 40"时用）。
 * 不只是改分数：今日涨跌额度、各类计数器、事件记录也一并清空 ——
 * 否则今天的日封顶还占着，重置完当天也涨不上去。
 * 保留：名字/昵称、lastInteractAt（衰减基准）。返回被重置的人数。
 */
export function resetAllMembers(members, cfg = DEFAULT_AFFINITY, now = Date.now()) {
  const c = mergeAffinityConfig(cfg);
  const day = todayKey(now);
  let count = 0;
  for (const m of Object.values(members || {})) {
    if (!m || typeof m !== 'object') continue;
    m.score = Number(c.start);
    m.counters = {};
    m.dailyDelta = 0;
    m.dailyDate = day;
    m.lastScoreAt = now;
    m.events = [{ at: now, kind: 'reset', delta: 0, reasons: `全部重置回 ${c.start}` }];
    count += 1;
  }
  return count;
}
