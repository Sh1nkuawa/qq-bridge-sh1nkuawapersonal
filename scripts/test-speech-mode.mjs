// 说话姿态判定的离线回归：用真实群聊风格的话验证阈值
import assert from 'node:assert/strict';
import { aggregateSpeechMode, classifySpeechIntent, formatSpeechLine, SPEECH_MODE, scoreSpeechIntent } from '../src/speech-mode.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const NOW = Date.UTC(2026, 9, 23, 4, 0, 0);

const m = (text, over = {}) => ({ text, plain: text, userId: '1', time: NOW - 1000, isSelf: false, ...over });

console.log('正经询问 → 答题态：');

ok('★ 点名 + 明确提问 ⇒ 答题态', () => {
  const r = classifySpeechIntent(m('@！？哦鲸鲸？！ 这个报错怎么解决', { atSelf: true }), { now: NOW });
  assert.equal(r.mode, SPEECH_MODE.ANSWER, r.reason);
});

ok('★ 出现"正经问/认真问/求助/在线等" ⇒ 直接答题态', () => {
  for (const t of ['正经问一下，这个报错怎么回事', '认真问，这配置能跑吗', '求助，麦克风没声音', '在线等，急']) {
    assert.equal(classifySpeechIntent(m(t), { now: NOW }).mode, SPEECH_MODE.ANSWER, t);
  }
});

ok('长句 + 疑问词 + 无梗 ⇒ 答题态（"能不能/怎么" 这类）', () => {
  for (const t of ['为什么我的桥接一直重启', '哪个牌子的显示器拖尾轻一点']) {
    const r = classifySpeechIntent(m(t), { now: NOW });
    assert.equal(r.mode, SPEECH_MODE.ANSWER, `${t} → ${r.reason} score=${r.score}`);
  }
});

ok('★ 问号不再计分（owner 2026-10-23 指定）：光有"吗/？"不会进答题态', () => {
  // 这是按 owner 要求**故意**放宽的：宁可漏成闲聊，也不要"真的假的？"就开答
  const r = classifySpeechIntent(m('这个配置能跑 deepseek 吗'), { now: NOW });
  assert.equal(r.mode, SPEECH_MODE.BANTER, `问号→不计分，本句只剩长度分：${r.reason} score=${r.score}`);
});

ok('★ 误伤词已移除：问号 / 急 / 咋 单独出现都判闲扯', () => {
  for (const t of ['真的假的？', '卧槽？', '急', '咋样', '咋整啊']) {
    const r = classifySpeechIntent(m(t), { now: NOW });
    assert.equal(r.mode, SPEECH_MODE.BANTER, `${t} → ${r.reason} score=${r.score}`);
  }
});

ok('★★ @/引用它但只有一个问号 ⇒ 不加不减（中性），按闲聊兜底', () => {
  // owner 2026-10-23 指定：这种只是"叫一声丢个问号"，不该被 atSelf+3 拉进答题态
  const cases = [
    ['?', { atSelf: true }],
    ['？', { atSelf: true }],
    ['？？？', { atSelf: true }],
    ['@！？哦鲸鲸？！ ？', { atSelf: true }],
    ['[引用 某人：这是啥] ？', { quoteTargetIsSelf: true }]
  ];
  for (const [t, over] of cases) {
    const r = classifySpeechIntent(m(t, over), { now: NOW });
    assert.equal(r.score, 0, `${t} 应该中性（score=0），实际 ${r.score}`);
    assert.equal(r.mode, SPEECH_MODE.BANTER, `${t} → ${r.reason}`);
    assert.ok(r.signals.includes('0 只有问号（不计分）'), `${t} 信号里应写明中性：${JSON.stringify(r.signals)}`);
  }
  // 只有问号**不是**中性豁免：带了内容就正常判
  assert.equal(classifySpeechIntent(m('@bot 这个报错怎么解决', { atSelf: true }), { now: NOW }).mode, SPEECH_MODE.ANSWER);
  assert.equal(classifySpeechIntent(m('@bot 你看这个', { atSelf: true }), { now: NOW }).mode, SPEECH_MODE.ANSWER);
});

ok('管理员发话 ⇒ 至少不会因为"像闲聊"被误判（点名时必答题）', () => {
  const r = classifySpeechIntent(m('@bot 帮我看下这个日志', { atSelf: true }), { now: NOW, ownerQQ: '1' });
  assert.equal(r.mode, SPEECH_MODE.ANSWER);
});

ok('连续追问（同一人 2 分钟内第 2 问）⇒ 加分成答题态', () => {
  const recent = [m('第一个问题？', { time: NOW - 60000 }), m('第二个问题？', { time: NOW - 30000 })];
  const r = classifySpeechIntent(m('第三个问题？', { time: NOW - 1000 }), { now: NOW, recent });
  assert.equal(r.mode, SPEECH_MODE.ANSWER, r.reason);
});

console.log('\n闲聊 → 闲扯态：');

ok('★ 纯梗/表情/极短 ⇒ 闲扯态', () => {
  for (const t of ['哈哈哈哈', '草', '[图片]', '[表情502]', '笑死', '好耶', '在吗']) {
    assert.equal(classifySpeechIntent(m(t), { now: NOW }).mode, SPEECH_MODE.BANTER, t);
  }
});

ok('★ 带梗的问句（"卧槽？"/"这啥啊哈哈哈"）⇒ 闲扯态', () => {
  for (const t of ['卧槽？', '这啥啊哈哈哈', '真的假的'] ) {
    assert.equal(classifySpeechIntent(m(t), { now: NOW }).mode, SPEECH_MODE.BANTER, t);
  }
});

ok('模糊句（没点名、没正经词）⇒ 按闲聊处理', () => {
  const r = classifySpeechIntent(m('今天天气不错'), { now: NOW });
  assert.equal(r.mode, SPEECH_MODE.BANTER, `${r.reason} score=${r.score}`);
});

ok('模糊句 + 点名 ⇒ 答（宁可认真）', () => {
  const r = classifySpeechIntent(m('@bot 你来评评理', { atSelf: true }), { now: NOW });
  assert.equal(r.mode, SPEECH_MODE.ANSWER, r.reason);
});

console.log('\n多消息合并：');

ok('★ 只要有一条正经询问 ⇒ 整轮答题态', () => {
  const msgs = [m('哈哈哈'), m('正经问，这个怎么弄')];
  assert.equal(aggregateSpeechMode(msgs, { now: NOW }).mode, SPEECH_MODE.ANSWER);
});

ok('全是闲聊 ⇒ 闲扯态', () => {
  const msgs = [m('笑死'), m('草'), m('[图片]')];
  assert.equal(aggregateSpeechMode(msgs, { now: NOW }).mode, SPEECH_MODE.BANTER);
});

ok('空列表 ⇒ 闲扯态（不硬塞答题）', () => {
  assert.equal(aggregateSpeechMode([], { now: NOW }).mode, SPEECH_MODE.BANTER);
});

console.log('\n注入文案：');

ok('★ 闲扯态必须写明"知道答案也可以不回/只说两个字"', () => {
  const line = formatSpeechLine(SPEECH_MODE.BANTER);
  assert.match(line, /知道答案/);
  assert.match(line, /可以不回|只说两个字/);
  assert.match(line, /1~10 字/);
});

ok('答题态要求"准而短、不升华、不列点"', () => {
  const line = formatSpeechLine(SPEECH_MODE.ANSWER);
  assert.match(line, /不列点/);
  assert.match(line, /升华/);
  assert.match(line, /客服/);
});

ok('打分函数给出可调试的信号明细', () => {
  const { score, signals } = scoreSpeechIntent(m('@bot 这个报错怎么解决', { atSelf: true }), { now: NOW });
  assert.ok(score >= 4, `score=${score}`);
  assert.ok(signals.some((s) => s.includes('点名')), JSON.stringify(signals));
  assert.ok(signals.some((s) => /问号|疑问词/.test(s)), JSON.stringify(signals));
});

console.log(`\n全部通过：${n} 项断言组`);
