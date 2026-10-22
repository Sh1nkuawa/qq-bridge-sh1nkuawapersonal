// 自研心情引擎的离线回归：口径正确（心情不许因为被怼而下降）、衰减、记账门槛、注入模式
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIM_KEYS, analyzeSilence, analyzeTurn, applyMoodTurn, applySilenceMood, blankMoodState, decayMoodState,
  effectiveSilentHours, isSleepHours, markMoodInjected, moodLineFor, moodPaths, readMoodConfig, readMoodState,
  writeMoodState
} from '../src/mood.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mood-'));

console.log('口径（最重要）：');

ok('★ 被怼只会「难过」，总心情**不许**下降（作者定的口径）', () => {
  const d = analyzeTurn({ userText: '你个傻逼闭嘴' });
  assert.equal(d.moodDelta, 0, '被骂不能让心情下降');
  assert.ok(d.dims.sad > 0, '但要有点难过');
});

ok('★ 只有"对方在讲自己的难处 / 情绪很低"才允许心情下降', () => {
  assert.ok(analyzeTurn({ userText: '今天加班到现在好累' }).moodDelta < 0);
  assert.ok(analyzeTurn({ userText: '好想哭，觉得没希望' }).moodDelta <= -3);
});

ok('被夸/被谢 → 开心+甜，心情上升', () => {
  const d = analyzeTurn({ userText: '小鲸鱼你好厉害，谢谢啦' });
  assert.ok(d.moodDelta > 0);
  assert.ok(d.dims.happy > 0 && d.dims.sweet > 0);
});

ok('被叫一声 / 有人想起它 → 甜蜜', () => {
  assert.ok(analyzeTurn({ userText: '在吗 找你聊两句' }).dims.sweet > 0);
});

ok('正经提问 → 一点"被需要"的踏实（不动总心情）', () => {
  const d = analyzeTurn({ userText: '这个报错怎么解决', speechMode: 'answer' });
  assert.ok(d.dims.calm > 0);
  assert.equal(d.moodDelta, 0);
});

ok('它认真回了、对方只丢几个字 → 轻微空落（不是被冒犯）', () => {
  const d = analyzeTurn({ userText: '哦', replyText: 'x'.repeat(60) });
  assert.ok(d.dims.sad > 0);
  assert.equal(d.moodDelta, 0);
});

console.log('\n衰减：');

ok('心情按半衰期向基线回落，七情绪回 0', () => {
  const cfg = { moodBase: 70, moodFloor: 0, decayHalfHours: 12 };
  const s = readMoodState({ home: home(), now: 0 });
  s.mood = 90; s.dims.happy = 20; s.lastDecayAt = 0;
  decayMoodState(s, cfg, 12 * 3600 * 1000);   // 心情：一个半衰期；情绪：8 个半衰期（90 分钟一个）
  assert.ok(Math.abs(s.mood - 80) < 0.5, `心情期望 ~80，实际 ${s.mood}`);
  assert.ok(s.dims.happy < 0.5, `情绪 12 小时后应接近 0，实际 ${s.dims.happy}`);
});

ok('心情有下限（moodFloor）', () => {
  const h = home();
  const cfg = { ...readMoodConfig({ home: h }), moodFloor: 30, moodBase: 70 };
  writeMoodState({ ...readMoodState({ home: h, now: 0 }), mood: 31, lastDecayAt: 0 }, { home: h });
  const r = applyMoodTurn({ home: h, cfg, turn: { userText: '好想哭，觉得没希望' }, now: 1000 });
  assert.ok(r.state.mood >= 30, `不能低于下限，实际 ${r.state.mood}`);
});

console.log('\n记账与写入：');

ok('★ 变化不够大就不记时间线（同插件的"无变化不记账"）', () => {
  const h = home();
  const cfg = readMoodConfig({ home: h });
  writeMoodState(readMoodState({ home: h, now: 0 }), { home: h });
  const r = applyMoodTurn({ home: h, cfg, turn: { userText: '在吗' }, now: 1000 });   // +1 不到门槛 3
  assert.equal(r.changed, false);
  assert.equal(r.state.timeline.length, 0);
});

ok('★ 写出的 state.json 与插件 schema 兼容（字段齐全 + 7 根情绪）', () => {
  const h = home();
  const cfg = readMoodConfig({ home: h });
  writeMoodState(readMoodState({ home: h, now: 0 }), { home: h });
  applyMoodTurn({ home: h, cfg, turn: { userText: '好吧今天加班好累' }, now: 2000 });
  const p = moodPaths({ home: h }).statePath;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of ['mood', 'dims', 'lastReason', 'lastConfidence', 'injectedFor', 'lastInjectedText', 'lastInjectedAt', 'saidAt', 'lastNotedMood', 'minor', 'kind', 'updatedAt', 'lastDecayAt', 'timeline']) {
    assert.ok(k in raw, `缺字段 ${k}`);
  }
  for (const k of DIM_KEYS) assert.equal(typeof raw.dims[k], 'number', `dims.${k} 必须是数字`);
  assert.ok(!fs.readFileSync(p).slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), '不能带 BOM');
});

console.log('\n注入：');

ok('injectMode=none → 一句话都不注入', () => {
  const s = { mood: 50, lastReason: '对方在讲难处', lastConfidence: 100, lastInjectedAt: 0, updatedAt: 10, saidAt: [] };
  assert.equal(moodLineFor(s, { injectMode: 'none' }), '');
});

ok('injectMode=mood → 只说心情，且明确"别念数字"', () => {
  const s = { mood: 88, lastReason: '', lastConfidence: 100, lastInjectedAt: 0, updatedAt: 0, saidAt: [] };
  const line = moodLineFor(s, { injectMode: 'mood', injectConfidence: 60, injectPerDay: 6 });
  assert.match(line, /欢喜/);
  assert.match(line, /别念数字/);
});

ok('★ injectMode=event → 同一件事只说一次（第二次为空）', () => {
  const now = Date.now();
  const s = { mood: 60, lastReason: '对方在讲自己的难处', lastConfidence: 100, lastInjectedAt: 0, updatedAt: now - 1000, saidAt: [] };
  const cfg = { injectMode: 'event', injectConfidence: 60, injectPerDay: 6 };
  const first = moodLineFor(s, cfg, now);
  assert.match(first, /对方在讲自己的难处/);
  markMoodInjected(s, first, now);
  assert.equal(moodLineFor(s, cfg, now + 1), '', '同一件事不该说第二遍');
});

ok('每日上限生效', () => {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const s = { mood: 88, lastReason: 'x', lastConfidence: 100, lastInjectedAt: 0, updatedAt: 0, saidAt: Array.from({ length: 6 }, () => ({ at: now, day })) };
  assert.equal(moodLineFor(s, { injectMode: 'mood', injectConfidence: 60, injectPerDay: 6 }, now), '');
});

ok('可信度不够不注入（规则式恒为 100，但门槛逻辑要留）', () => {
  const s = { mood: 50, lastReason: 'x', lastConfidence: 40, lastInjectedAt: 0, updatedAt: 0, saidAt: [] };
  assert.equal(moodLineFor(s, { injectMode: 'event', injectConfidence: 60, injectPerDay: 6 }), '');
});

ok('★ 注入前必须先衰减（群里安静很久后第一次唤醒，不许按旧心情说话）', () => {
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /const before = state\.mood;[\s\S]{0,220}decayMoodState\(state, cfg\);[\s\S]{0,80}moodLineFor\(state, cfg\)/,
    '注入块必须是：读 → 衰减 → 生成注入行');
});

console.log('\n久无人理（作息窗口不算）：');

ok('作息窗口：02:00 起、10:00 止（含头不含尾）', () => {
  const at = (h, m = 0) => { const d = new Date(2026, 9, 23); d.setHours(h, m, 0, 0); return d; };
  assert.equal(isSleepHours(at(1, 59)), false);
  assert.equal(isSleepHours(at(2, 0)), true);
  assert.equal(isSleepHours(at(9, 59)), true);
  assert.equal(isSleepHours(at(10, 0)), false);
  assert.equal(isSleepHours(at(14, 0)), false);
});

ok('★ 有效沉默要扣掉作息窗口：昨日 23:00 → 今日 11:00 = 4 小时（不是 12）', () => {
  const now = new Date(2026, 9, 23, 11, 0, 0, 0);
  const last = new Date(2026, 9, 22, 23, 0, 0, 0);
  const h = effectiveSilentHours(last.getTime(), now.getTime());
  assert.ok(Math.abs(h - 4) < 0.01, `期望 4h，实际 ${h}`);
});

ok('夜里不判"被冷落"（正常人要睡觉）', () => {
  const last = new Date(2026, 9, 22, 23, 0, 0, 0).getTime();
  const at3 = new Date(2026, 9, 23, 3, 0, 0, 0).getTime();
  const r = analyzeSilence({ lastIncomingAt: last, now: at3, minSilentHours: 1 });
  assert.equal(r.apply, false);
  assert.equal(r.reason, 'sleep-hours');
});

ok('有效沉默不够 / 已经算过 → 不重复落寞', () => {
  const now = new Date(2026, 9, 23, 11, 0, 0, 0).getTime();
  const last = new Date(2026, 9, 23, 9, 30, 0, 0).getTime();   // 只隔 1.5h（且跨了 9:30-10:00 共 0.5h 作息）
  assert.equal(analyzeSilence({ lastIncomingAt: last, now, minSilentHours: 6 }).apply, false);
  // 条件都满足，但已经记过（lonelyAt 比 lastIncomingAt 新）
  const longAgo = new Date(2026, 9, 22, 12, 0, 0, 0).getTime();
  assert.equal(analyzeSilence({ lastIncomingAt: longAgo, now, minSilentHours: 6, lonelyAt: now - 1000 }).reason, 'already-counted');
});

ok('★ 落寞只降 1 点心情 + 一点难过，且同一次静默只发生一次', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-silence-'));
  const now = new Date(2026, 9, 23, 14, 0, 0, 0).getTime();
  const lastIncomingAt = new Date(2026, 9, 22, 10, 0, 0, 0).getTime();   // 很久没说话（30h，扣作息后 ~22h）
  const cfg = readMoodConfig({ home });
  writeMoodState(blankMoodState({ base: 70, now }), { home });
  const first = applySilenceMood({ home, cfg, lastIncomingAt, now });
  assert.equal(first.changed, true);
  assert.ok(first.state.mood < 70 && first.state.mood >= 69, `只该降 1 点，实际 ${first.state.mood}`);
  assert.ok(first.state.dims.sad > 0, '要有一点难过');
  const second = applySilenceMood({ home, cfg, lastIncomingAt, now: now + 1000 });
  assert.equal(second.changed, false, '同一次静默只能算一次');
  assert.equal(second.reason, 'already-counted');
});

console.log(`\n全部通过：${n} 项断言组`);
