// 好感度引擎单测：node scripts/test-affinity.mjs
import {
  DEFAULT_AFFINITY, mergeAffinityConfig, tierOf, emptyMember, recordEvent,
  applyDecay, ensureMember, formatAffinityPanel, sanitizeAffinityState, summarizeAffinity
} from '../src/affinity.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
}

const cfg = mergeAffinityConfig({});
const DAY = 86400000;

// ---- 分档边界（2026-09-27 宽量程版）----
console.log('分档：');
ok('40 → 普通群友（起始值必须是中性档）', tierOf(40, cfg).key === 'normal');
ok('99 → 普通群友', tierOf(99, cfg).key === 'normal');
ok('100 → 熟人', tierOf(100, cfg).key === 'close');
ok('299 → 熟人', tierOf(299, cfg).key === 'close');
ok('300 → 自己人', tierOf(300, cfg).key === 'inner');
ok('999 → 自己人', tierOf(999, cfg).key === 'inner');
ok('39 → 眼熟', tierOf(39, cfg).key === 'familiar');
ok('0 → 眼熟', tierOf(0, cfg).key === 'familiar');
ok('-1 → 有点烦', tierOf(-1, cfg).key === 'bother');
ok('-49 → 有点烦', tierOf(-49, cfg).key === 'bother');
ok('-50 → 梁子', tierOf(-50, cfg).key === 'grudge');
ok('-200 → 梁子', tierOf(-200, cfg).key === 'grudge');
ok('自己人给外号权限', tierOf(300, cfg).nameRule === 'nickname');
ok('梁子不给称呼', tierOf(-50, cfg).nameRule === 'avoid');

// ---- 首次互动 ----
console.log('\n计分：');
let m = emptyMember('1001', '甲', cfg);
let r = recordEvent(m, { kind: 'message', text: '你好', attention: false }, cfg);
ok('今天首次互动 +2', m.score === 42 && r.delta === 2, `score=${m.score} delta=${r.delta}`);
r = recordEvent(m, { kind: 'message', text: '在吗' }, cfg);
ok('同日普通聊天不再加分', m.score === 42, `score=${m.score}`);

// ---- 注意力（@ / 引用）每日上限 4 ----
for (let i = 0; i < 6; i += 1) recordEvent(m, { kind: 'message', text: 'x', attention: true }, cfg);
ok('@ 我 每日最多 +4', m.score === 46, `score=${m.score}（期望 42+4）`);

// ---- 发图上限 2 ----
let m2 = emptyMember('1002', '乙', cfg);
for (let i = 0; i < 5; i += 1) recordEvent(m2, { kind: 'message', text: '图', mediaCount: 1 }, cfg);
ok('发图每日最多 +2（首次 +2 另计）', m2.score === 44, `score=${m2.score}（期望 40+2+2）`);

// ---- 雷点 ----
let m3 = emptyMember('1003', '丙', cfg);
recordEvent(m3, { kind: 'message', text: '蓝色大肥鱼' }, cfg);
ok('踩雷一次 -2', m3.score === 40, `score=${m3.score}（40+2-2）`);
for (let i = 0; i < 5; i += 1) recordEvent(m3, { kind: 'message', text: '大肥鱼' }, cfg);
ok('踩雷每日最多 -4', m3.score === 38, `score=${m3.score}（期望 38）`);

// ---- 刷屏 + 日上限裁剪 ----
let m4 = emptyMember('1004', '丁', cfg);
recordEvent(m4, { kind: 'message', text: 'ojj', spamCount: 8, repeatCount: 5, avgChars: 3 }, cfg);
ok('刷屏一次 -2', m4.score === 40, `score=${m4.score}（40+2-2）`);
let m5 = emptyMember('1005', '戊', cfg);
const before = m5.score;
for (let i = 0; i < 10; i += 1) recordEvent(m5, { kind: 'message', text: '大肥鱼', spamCount: 9, repeatCount: 6, avgChars: 3 }, cfg);
ok('单日净跌幅不超过 -6', before - m5.score <= cfg.dailyDown, `跌了 ${before - m5.score}`);

// ---- 日上限（涨）----
let m6 = emptyMember('1006', '己', cfg);
for (let i = 0; i < 20; i += 1) recordEvent(m6, { kind: 'message', text: 'hi', attention: true, mediaCount: 1 }, cfg);
ok('单日净涨幅不超过 +6', m6.score - 40 <= cfg.dailyUp, `涨了 ${m6.score - 40}`);

// ---- 跨天重置 ----
let m7 = emptyMember('1007', '庚', cfg);
recordEvent(m7, { kind: 'message', text: 'hi' }, cfg);
const t1 = Date.now();
recordEvent(m7, { kind: 'message', text: 'hi', attention: true }, cfg);
const scoreDay1 = m7.score;
recordEvent(m7, { kind: 'message', text: 'hi', attention: true }, cfg, t1 + DAY);
ok('跨天后可以再次拿"首次互动"', m7.score > scoreDay1, `day1=${scoreDay1} day2=${m7.score}`);

// ---- 衰减 ----
let m8 = emptyMember('1008', '辛', cfg);
m8.score = 60;
m8.lastInteractAt = Date.now() - 10 * DAY;
const d = applyDecay(m8, cfg, Date.now());
ok('10 天不互动会衰减', d < 0, `delta=${d}`);
ok('衰减不低于 decayTo', m8.score === Math.max(cfg.decayTo, 60 - 3 * cfg.decayPerDay), `score=${m8.score}`);
let m9 = emptyMember('1009', '壬', cfg);
m9.score = 15; m9.lastInteractAt = Date.now() - 30 * DAY;
applyDecay(m9, cfg, Date.now());
ok('低分不再继续衰减', m9.score === 15, `score=${m9.score}`);

// ---- 上下限 ----
let m10 = emptyMember('1010', '癸', cfg);
m10.score = cfg.max - 1; m10.dailyDelta = 0;
recordEvent(m10, { kind: 'message', text: 'hi' }, cfg);
ok(`不超过上限 ${cfg.max}`, m10.score <= cfg.max, `score=${m10.score}`);
let m11 = emptyMember('1011', '子', cfg);
m11.score = cfg.min + 1; m11.dailyDelta = 0;
recordEvent(m11, { kind: 'message', text: '大肥鱼', spamCount: 9, repeatCount: 6, avgChars: 3 }, cfg);
ok(`不低于下限 ${cfg.min}`, m11.score >= cfg.min, `score=${m11.score}`);

// ---- 提示词面板 ----
console.log('\n提示词注入：');
const members = {};
ensureMember(members, '1001', '群友G', cfg).score = 70;
ensureMember(members, '1002', '群友A', cfg).score = 30;
ensureMember(members, '1003', '梅川 义敷', cfg).score = -5;
const panel = formatAffinityPanel(members, [{ userId: '1001' }, { userId: '1002' }, { userId: '1003' }, { userId: '9999' }], cfg);
// 断言口径修正：面板里出现的是**这次传进去的在场人名**（此前写的是真实群友昵称，
// 和 fixtures 无关，属于永远不可能成立的历史残留断言）。
ok('包含在场三人', panel.includes('群友G') && panel.includes('群友A') && panel.includes('义敷'));
ok('不含不在场的人', !panel.includes('9999'));
ok('含"绝不能说出口"约束', panel.includes('绝不能说出口'));
ok('含语气档说明', panel.includes('语气档') || panel.includes('语气要求'));

// ---- 清洗 ----
console.log('\n状态清洗：');
const clean = sanitizeAffinityState({ members: { '1': { score: 99999, name: 'x' }, bad: { score: 1 }, '2': { score: -99999 } } }, cfg);
ok('非法 id 被丢弃', !clean.members.bad);
ok('分数被夹到上限', clean.members['1'].score === cfg.max);
ok('分数被夹到下限', clean.members['2'].score === cfg.min);
ok('简报可排序', summarizeAffinity(clean.members, cfg)[0].score === cfg.max);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
