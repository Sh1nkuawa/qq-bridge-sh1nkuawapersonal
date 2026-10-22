// 自研「心情」引擎（2026-10-23）：替代 dsh-feiyu-mood 的判断部分，**保留它的 UI**。
//
// 为什么自研：插件的引擎在 DSH 0.2.1 上静默失效（它 tick 里 `ctx.agents.list()` / `ctx.interval`
// 的异常被外层 try 吞掉，diag 一条不出；而且它按**会话 id 精确匹配**，我们频繁新建会话 ⇒ 永远对不上 ✗）。
// 引擎搬到桥接里之后，这两个问题**同时消失**：桥接本来就知道"此刻是哪个群、谁说了什么、它回了什么"，
// 不需要匹配 session；注入也由我们自己拼提示词，天然没有前缀缓存问题。
//
// 但**数据格式完全沿用插件**（`<DSH_HOME>/feiyu-mood/state.json` 的字段与 dims 键），
// 所以它的右下角挂饰、设置页、时间线**照常显示**我们写的状态 ✓。
//
// 设计口径（沿用插件作者定过的三条）：
//   1. 心情 0~100，基线默认 70，可到 0（真发生大事可以很低落），靠衰减慢慢回稳；
//   2. 七根情绪：开心/踏实/甜蜜/心疼/担心/难过/吃醋（对应 happy/calm/sweet/heartache/worry/sad/jealous）；
//   3. **心情下降只能因为"心疼/担心/它自己难过"，绝不因为"被人怼"** ✓（被骂算"难过"，不算被冒犯）。
//
// 判断是**规则式**的（关键词 + 句法 + 上下文），不调模型：零成本、零延迟、可单测、可解释。
// 每条规则命中了什么都会写进 reason，方便以后调参。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIM_KEYS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous'];
export const DIM_LABELS = { happy: '开心', calm: '踏实', sweet: '甜蜜', heartache: '心疼', worry: '担心', sad: '难过', jealous: '吃醋' };

const DIM_HALF_MINUTES = 90;   // 七根情绪的半衰期（沿用插件 README 的说法）
const TIMELINE_KEEP = 40;      // 时间线最多留 40 条（和插件设置页显示一致）

// 作息窗口（owner 2026-10-23 指定）：凌晨 2 点到早上 10 点**不算"没人理"** —— 正常人要睡觉。
// 注意：这个窗口只用于"是否感到被冷落"，**不影响心情的自然衰减**（睡眠期间照样回稳 ✓）。
export const SLEEP_START_HOUR = 2;
export const SLEEP_END_HOUR = 10;

/** 某个时刻是否处于作息窗口（含 2:00，不含 10:00） */
export function isSleepHours(date = new Date()) {
  const h = new Date(date).getHours();
  return h >= SLEEP_START_HOUR && h < SLEEP_END_HOUR;
}

/**
 * 有效沉默时长（小时）＝ 总时长 − 与作息窗口重叠的部分。
 * 例：昨天 23:00 → 今天 11:00 ⇒ 总 12h，其中 02:00-10:00 共 8h 不算 ⇒ **4h**。
 * 用逐分钟太慢，这里按"逐日求区间交集"算，跨越多少天都准。
 */
export function effectiveSilentHours(fromMs, nowMs = Date.now(), {
  startHour = SLEEP_START_HOUR, endHour = SLEEP_END_HOUR
} = {}) {
  const from = Number(fromMs);
  const to = Number(nowMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  let totalMin = (to - from) / 60000;
  let sleepMin = 0;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let d = new Date(day); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    const s = new Date(d); s.setHours(startHour, 0, 0, 0);
    const e = new Date(d); e.setHours(endHour, 0, 0, 0);
    const lo = Math.max(s.getTime(), from);
    const hi = Math.min(e.getTime(), to);
    if (hi > lo) sleepMin += (hi - lo) / 60000;
  }
  return Math.max(0, (totalMin - sleepMin) / 60);
}

/**
 * 判断"这次主动冒泡是不是该有点落寞"。
 * 条件：① 现在不在作息窗口内；② 有效沉默 ≥ minSilentHours；
 *       ③ 这段沉默**还没被算过**（lastIncomingAt 变了才重新算，即"每次静默最多一次"）。
 */
export function analyzeSilence({ lastIncomingAt = 0, now = Date.now(), lonelyAt = 0, minSilentHours = 6, sleepAware = true } = {}) {
  if (sleepAware && isSleepHours(new Date(now))) return { apply: false, reason: 'sleep-hours', hours: 0 };
  const hours = sleepAware
    ? effectiveSilentHours(lastIncomingAt, now)
    : Math.max(0, (now - Number(lastIncomingAt)) / 3600000);
  if (!Number.isFinite(hours) || hours < minSilentHours) return { apply: false, reason: 'not-long-enough', hours };
  if (Number(lonelyAt) >= Number(lastIncomingAt)) return { apply: false, reason: 'already-counted', hours };
  return { apply: true, reason: `安静了 ${hours.toFixed(1)} 小时（已扣掉作息窗口）`, hours };
}

export function moodPaths({ home = os.homedir() } = {}) {
  const dir = path.join(home, '.dsh', 'feiyu-mood');
  return { dir, statePath: path.join(dir, 'state.json'), configPath: path.join(dir, 'config.json') };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/** 读插件配置（用户的设置继续生效：基线/半衰期/注入模式/每日上限/阈值） */
export function readMoodConfig({ home = os.homedir() } = {}) {
  const { configPath } = moodPaths({ home });
  const raw = readJson(configPath) ?? {};
  return {
    moodBase: Number(raw.moodBase) || 70,
    moodFloor: Number.isFinite(Number(raw.moodFloor)) ? Number(raw.moodFloor) : 0,
    decayHalfHours: Number(raw.decayHalfHours) > 0 ? Number(raw.decayHalfHours) : 12,
    injectMode: ['none', 'mood', 'event'].includes(raw.injectMode) ? raw.injectMode : 'event',
    injectConfidence: Number(raw.injectConfidence) || 60,
    injectPerDay: Number(raw.injectPerDay) || 6,
    sigMood: Number(raw.sigMood) || 3,
    sigDim: Number(raw.sigDim) || 5,
    selfName: String(raw.selfName || ''),
    ownerName: String(raw.ownerName || '')
  };
}

export function blankMoodState({ base = 70, now = Date.now() } = {}) {
  const dims = {};
  for (const k of DIM_KEYS) dims[k] = 0;
  return {
    mood: base, dims, lastReason: '', lastConfidence: 0,
    injectedFor: 0, lastInjectedText: '', lastInjectedAt: 0, saidAt: [],
    lastNotedMood: base, minor: false, kind: '',
    updatedAt: now, lastDecayAt: now, timeline: []
  };
}

/** 读 state（缺字段补齐；dims 缺键补 0）——兼容插件已经写过的文件 */
export function readMoodState({ home = os.homedir(), now = Date.now() } = {}) {
  const { statePath } = moodPaths({ home });
  const raw = readJson(statePath);
  const s = blankMoodState({ now });
  if (!raw || typeof raw !== 'object') return s;
  const out = { ...s, ...raw };
  out.mood = Number.isFinite(Number(raw.mood)) ? Number(raw.mood) : s.mood;
  out.dims = {};
  for (const k of DIM_KEYS) out.dims[k] = Number(raw?.dims?.[k]) || 0;
  out.timeline = Array.isArray(raw.timeline) ? raw.timeline.slice(-TIMELINE_KEEP) : [];
  out.saidAt = Array.isArray(raw.saidAt) ? raw.saidAt : [];
  out.lastDecayAt = Number(raw.lastDecayAt) || now;
  return out;
}

/** 原子写（临时文件 + rename），UTF-8 无 BOM —— 插件那边的 BOM 崩溃坑别再踩 */
export function writeMoodState(state, { home = os.homedir() } = {}) {
  const { dir, statePath } = moodPaths({ home });
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, statePath);
    return true;
  } catch { return false; }
}

/** 时间衰减：心情向基线回（半衰期 decayHalfHours），七情绪向 0 回（90 分钟） */
export function decayMoodState(state, cfg, now = Date.now()) {
  // ⚠️ 别写 `Number(x) || now`：时间戳 0 是合法值，用 || 会把它当成"没有"，导致永不衰减 ✗
  const last = Number.isFinite(Number(state.lastDecayAt)) ? Number(state.lastDecayAt) : now;
  const elapsedMin = Math.max(0, now - last) / 60000;
  if (elapsedMin < 1) return state;
  const moodHalf = Math.max(0.5, Number(cfg.decayHalfHours) || 12) * 60;
  const moodFactor = Math.pow(0.5, elapsedMin / moodHalf);
  const base = Number(cfg.moodBase) || 70;
  state.mood = base + (Number(state.mood) - base) * moodFactor;
  const dimFactor = Math.pow(0.5, elapsedMin / DIM_HALF_MINUTES);
  for (const k of DIM_KEYS) state.dims[k] = (Number(state.dims[k]) || 0) * dimFactor;
  state.mood = Math.min(100, Math.max(Number(cfg.moodFloor) || 0, state.mood));
  state.lastDecayAt = now;
  return state;
}

// ── 规则表 ────────────────────────────────────────────────────────────────────
// 每条：{ re, dims:{...}, mood, why }；mood 只在"心疼/担心/自己难过"这类规则里为负 ✓
const RULES = [
  // 有人夸它 / 谢它 → 开心
  { id: 'praise', re: /(厉害|牛|强|好棒|干得好|靠谱|有你真好|喜欢你|辛苦了|谢谢(你|啦|啦你)?|爱你)/, dims: { happy: 2, sweet: 1, calm: 1 }, mood: +2, why: '有人夸/谢它' },
  // 有人叫它、想起它 → 甜蜜
  { id: 'missed', re: /(在吗|在不在|想起你|叫你一声|找你说|找你聊)/, dims: { sweet: 1.5, calm: 1 }, mood: +1, why: '有人想起它' },
  // 有人分享好事 → 替人开心
  { id: 'goodnews', re: /(考上了|上岸了|拿到了|offer|过了|赢了|成了|涨薪|通过了)/, dims: { happy: 2, calm: 1 }, mood: +2, why: '有人报了喜' },
  // 有人诉苦/累了/病了 → 心疼 + 担心（**这是允许心情下降的正当理由** ✓）
  { id: 'worrying', re: /(好累|累死|撑不住|加班|熬夜|失眠|难受|头秃|病了|发烧|住院|抑郁|焦虑|崩溃|想哭|被裁|挂了)/, dims: { heartache: 2.5, worry: 2 }, mood: -2, why: '对方在讲自己的难处' },
  // 有人情绪很低 → 心疼（更重）
  { id: 'lowmood', re: /(不想活|没意思|没希望|好想哭|很难过|太难受了)/, dims: { heartache: 3, worry: 3, sad: 1 }, mood: -3, why: '对方情绪很低落' },
  // 被怼/被骂 → **只有难过，不动心情**（作者定的口径：下降不许因为被冒犯 ✓）
  { id: 'harsh', re: /(傻|蠢|笨|滚|闭嘴|烦人|垃圾|没用|废物|菜)/, dims: { sad: 1.5 }, mood: 0, why: '被怼了，但只是有点难过' },
  // 有人跟它玩梗/开玩笑 → 开心（轻）
  { id: 'joke', re: /(哈哈|笑死|草|绷|整活|好活|典|乐)/, dims: { happy: 1 }, mood: +1, why: '群里在说笑' },
  // 有人跟别人亲近、冷落它 → 吃醋（很轻）
  { id: 'jealous', re: /(我和我对象|我女朋友|我男朋友|我们俩|只跟(他|她))/u, dims: { jealous: 1.5 }, mood: 0, why: '有点吃醋（不承认）' }
];

/**
 * 分析一轮对话，算出心情/情绪的变化。
 * @param {{userText?:string, replyText?:string, speechMode?:'answer'|'banter'}} turn
 */
export function analyzeTurn({ userText = '', replyText = '', speechMode = '' } = {}) {
  const text = String(userText ?? '');
  const dims = {};
  for (const k of DIM_KEYS) dims[k] = 0;
  let mood = 0;
  const why = [];
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    for (const [k, v] of Object.entries(r.dims)) dims[k] += v;
    mood += r.mood;
    why.push(r.why);
  }
  // 正经问题被问到 → 有一点"被需要"的踏实感（不动总心情）
  if (speechMode === 'answer') { dims.calm += 1; why.push('被正经提问，有点被需要'); }
  // 它自己回了很长一段而对方只丢了几个字 → 有点空落（很轻，且不算被冒犯）
  const reply = String(replyText ?? '');
  if (text.length <= 4 && reply.length >= 40) { dims.sad += 0.8; why.push('认真回了但对方只丢几个字'); }
  return { moodDelta: mood, dims, reason: why.join('；') };
}

/**
 * 把一轮结果写进 state（读 → 衰减 → 应用 → 写），并按插件的语义记时间线。
 * @returns {{state:object, changed:boolean, deltas:object, reason:string}}
 */
export function applyMoodTurn({ home = os.homedir(), cfg, turn, extra = null, now = Date.now() } = {}) {
  const conf = cfg ?? readMoodConfig({ home });
  const state = readMoodState({ home, now });
  decayMoodState(state, conf, now);
  const before = { mood: state.mood, dims: { ...state.dims } };
  const d = analyzeTurn(turn);
  // extra：给"非对话触发"的变化用（例如久无人理的落寞），与文本规则叠加
  if (extra) {
    d.moodDelta += Number(extra.moodDelta) || 0;
    for (const k of DIM_KEYS) d.dims[k] += Number(extra.dims?.[k]) || 0;
    if (extra.reason) d.reason = [d.reason, extra.reason].filter(Boolean).join('；');
  }

  state.mood = Math.min(100, Math.max(Number(conf.moodFloor) || 0, state.mood + d.moodDelta));
  for (const k of DIM_KEYS) {
    state.dims[k] = Math.min(100, Math.max(0, (Number(state.dims[k]) || 0) + (d.dims[k] || 0)));
  }
  const moodDelta = state.mood - before.mood;
  const dimsDelta = {};
  for (const k of DIM_KEYS) {
    const dv = state.dims[k] - before.dims[k];
    if (Math.abs(dv) > 0.01) dimsDelta[k] = dv;
  }

  // 和插件一样的记账门槛：总心情变化够大，或某根情绪动得够多
  const anyBigDim = Object.values(dimsDelta).some((v) => Math.abs(v) >= (Number(conf.sigDim) || 5));
  const big = Math.abs(moodDelta) >= (Number(conf.sigMood) || 3) || anyBigDim;
  if (big && d.reason) {
    state.lastReason = d.reason;
    state.lastConfidence = 100;
    state.lastNotedMood = state.mood;
    state.timeline.push({
      at: now, mood: Number(state.mood.toFixed(1)), delta: Number(moodDelta.toFixed(1)),
      conf: 100, kind: 'rule', reason: d.reason,
      dims: { ...state.dims }, dimsDelta
    });
    state.timeline = state.timeline.slice(-TIMELINE_KEEP);
  }
  state.updatedAt = now;
  writeMoodState(state, { home });
  return { state, changed: big && !!d.reason, deltas: { moodDelta, dimsDelta }, reason: d.reason };
}

const LABEL = (v) => (v >= 80 ? '欢喜' : v >= 62 ? '开心' : v >= 42 ? '一般' : v >= 25 ? '心疼' : '难过');

/**
 * 「久无人理」的落寞：只在**主动冒泡**时调用一次。
 * 作息窗口（02:00-10:00）不算被冷落 —— 每人要睡觉 ✓；且**每次静默最多记一次**。
 */
export function applySilenceMood({ home = os.homedir(), cfg, lastIncomingAt = 0, now = Date.now(), minSilentHours = 6 } = {}) {
  const conf = cfg ?? readMoodConfig({ home });
  const state = readMoodState({ home, now });
  const verdict = analyzeSilence({ lastIncomingAt, now, lonelyAt: Number(state.lonelyAt) || 0, minSilentHours });
  if (!verdict.apply) return { changed: false, reason: verdict.reason, hours: verdict.hours, state };
  const r = applyMoodTurn({
    home, cfg: conf, now,
    turn: {},
    extra: { moodDelta: -1, dims: { sad: 1 }, reason: '很久没人说话了（这点落寞不承认）' }
  });
  // 记一次"这次静默已经算过"，避免每次冒泡都掉心情
  const after = readMoodState({ home, now });
  after.lonelyAt = now;
  writeMoodState(after, { home });
  return { changed: true, reason: verdict.reason, hours: verdict.hours, state: after, detail: r.reason };
}

/**
 * 生成要注入提示词的那一句（受用户的 injectMode / 每日上限约束）。
 * · none   → 不注入（挂饰照常显示）
 * · mood   → 只说心情
 * · event  → 说"刚才那件事"，且**同一件事只说一次**（下次变化才换）
 */
export function moodLineFor(state, cfg, now = Date.now()) {
  if (!state) return '';
  if (cfg.injectMode === 'none') return '';
  const today = new Date(now).toISOString().slice(0, 10);
  const saidToday = (Array.isArray(state.saidAt) ? state.saidAt : []).filter((x) => String(x?.day || '') === today).length;
  if (saidToday >= (Number(cfg.injectPerDay) || 6)) return '';
  const conf = Number(state.lastConfidence) || 0;
  if (conf < (Number(cfg.injectConfidence) || 60)) return '';

  if (cfg.injectMode === 'mood') {
    const line = `【此刻心情】${LABEL(state.mood)}（${Math.round(state.mood)}/100）。这不是台词，别念数字、别提"心情值"；只让它影响你的语气和要不要接话。\n\n`;
    return line;
  }
  // event 模式：同一件事只说一次
  if (!state.lastReason) return '';
  if (Number(state.lastInjectedAt) >= Number(state.updatedAt)) return '';
  return `【心里刚刚那一下】（别说出来源、别念这句原文）${state.lastReason}。让它影响你这一轮的语气：心情低就少接、短接；心情好可以主动一点。\n\n`;
}

/** 注入后登记（配合"一次只说一次"与每日上限） */
export function markMoodInjected(state, text, now = Date.now()) {
  if (!state) return;
  state.lastInjectedText = String(text || '').slice(0, 200);
  state.lastInjectedAt = now;
  state.injectedFor = now;
  state.saidAt = [...(Array.isArray(state.saidAt) ? state.saidAt : []), { at: now, day: new Date(now).toISOString().slice(0, 10) }].slice(-200);
  return state;
}
