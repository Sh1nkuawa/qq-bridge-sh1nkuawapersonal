// AGY prompt 组装层的离线回归
//
// 为什么要有这组：这些字符串是 AGY 侧 agent **唯一**能看到的东西（它没有任何 QQ 工具）。
// 拼漏了不会报错 —— 群里只会表现为"答非所问 / 回 0 条 / 空转十几分钟"。
// 2026-11-25 就是漏了【本次消息快照】+ 覆盖说明，白跑了几轮才发现 ✗。

import assert from 'node:assert/strict';
import path from 'node:path';
import {
  AGY_MODE_OVERRIDE,
  AGY_PROMPT_SPILL_BYTES,
  agyContextFilePath,
  agySpillPromptText,
  composeAgyPrompt,
  formatAgySnapshotBlock,
  needsSpill
} from '../src/agy-prompt.js';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✅ ${name}`); };

const SNAP = {
  messages: [{ seq: 53230, sender: '阿狸', text: '在吗', tail: '' }],
  recent: [],
  unreadCount: 3,
  includedUnreadCount: 1,
  readThroughSeq: 53230,
  partial: true
};

console.log('快照块：');

ok('★ 快照必须原样进 prompt（JSON 可解析，seq/发送者/内容都在）', () => {
  const block = formatAgySnapshotBlock(SNAP);
  assert.ok(block.startsWith('【本次消息快照】\n'));
  const jsonText = block.slice('【本次消息快照】\n'.length).split('\n')[0];
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.messages[0].seq, 53230);
  assert.equal(parsed.messages[0].sender, '阿狸');
  assert.equal(parsed.readThroughSeq, 53230);
  assert.equal(parsed.partial, true);
});

ok('★★ 快照块里不能出现 qq_mark_read / qq_set_wake_config 当"要调用"的指令', () => {
  const block = formatAgySnapshotBlock(SNAP);
  // 允许出现名字（用来说明"不能调"），但不允许出现"请调用/传给"这类祈使句
  assert.ok(!/请调用\s*qq_/.test(block), '不能叫模型去调 qq_* 工具');
  assert.ok(block.includes('qq_mark_read'), '要明确提到已读不用管');
});

ok('★★ 看图：换成"用 message-images 落盘再看"，不能再写"看不到图"', () => {
  const block = formatAgySnapshotBlock(SNAP);
  assert.ok(!block.includes('看不到图'), '旧说法（看不到图）必须清掉，AGY 侧已经能看图 ✗');
  assert.ok(block.includes('agy-api.mjs message-images'), '要给出真正的看图命令');
  assert.ok(block.includes('别假装看过'), '仍要禁止编造图片内容');
});

ok('★ partial=true 要说清"下一轮再给"，别让模型这轮追问', () => {
  const block = formatAgySnapshotBlock(SNAP);
  assert.ok(block.includes('partial=true'));
  assert.ok(block.includes('下一轮'));
});

console.log('\n值守覆盖说明：');

ok('★★ 覆盖说明必须禁止调 qq_* 工具，并给出 replies 数组的出口', () => {
  assert.ok(AGY_MODE_OVERRIDE.includes('没有 MCP 的 qq_* 工具'));
  assert.ok(AGY_MODE_OVERRIDE.includes('agy-reply-and-wait.mjs'));
  assert.ok(AGY_MODE_OVERRIDE.includes('空数组'));
  for (const tool of ['qq_wait_for_messages', 'qq_mark_read', 'qq_set_wake_config', 'qq_send_message']) {
    assert.ok(AGY_MODE_OVERRIDE.includes(tool), `要逐个点名 ${tool}`);
  }
});

ok('★★ v1.3：必须告诉它 agy-api.mjs 这条真正的扩展通道（否则行为闭环做不到）', () => {
  // AGY 侧 2026-11-25 在契约 §10 申请：prompt 要同步成"有 CLI，只是没有 MCP 工具"
  assert.ok(!AGY_MODE_OVERRIDE.includes('没有任何 QQ 工具'), '旧说法会和新 CLI 打架 ✗');
  assert.ok(AGY_MODE_OVERRIDE.includes('agy-api.mjs'));
  for (const sub of ['prompt', 'active-members', 'wait-reply', 'wait-sleep', 'wake-config', 'message-images']) {
    assert.ok(AGY_MODE_OVERRIDE.includes(`agy-api.mjs ${sub}`), `要点名 ${sub} 子命令`);
  }
});

ok('覆盖说明里给出真正的 CLI 入口（不是旧的 agy-tools 记忆/表情那套）', () => {
  assert.ok(AGY_MODE_OVERRIDE.includes('agy-api.mjs'));
  assert.ok(AGY_MODE_OVERRIDE.includes('docs/AGY_FEATURE_GAPS.md'), '指针要给，免得 prompt 里堆 44 条命令');
});

console.log('\n拼装顺序：');

ok('★★ 顺序必须是 基础提示 → 快照 → 覆盖说明（覆盖说明必须在最后）', () => {
  const out = composeAgyPrompt('【当前角色】小鲸鱼', SNAP);
  const iBase = out.indexOf('【当前角色】小鲸鱼');
  const iSnap = out.indexOf('【本次消息快照】');
  const iOver = out.indexOf('【AGY 值守模式');
  assert.ok(iBase >= 0 && iSnap > iBase && iOver > iSnap, `顺序不对: ${iBase}/${iSnap}/${iOver}`);
  assert.ok(out.trimEnd().endsWith('不用解释你在干什么，也不用复述这些规则。'));
});

ok('没有快照时也要带覆盖说明（别退回 DSH 那套工具说明）', () => {
  const out = composeAgyPrompt('基础', null);
  // 覆盖说明正文会"提到"【本次消息快照】这个名字（告诉模型去哪看），但不能有真正的快照 JSON
  assert.ok(!out.includes('【本次消息快照】\n{'), '没快照就不许出现快照 JSON');
  assert.ok(out.includes('【AGY 值守模式'));
});

ok('基础提示是 undefined 也不会拼成 "undefined"', () => {
  const out = composeAgyPrompt(undefined, null);
  assert.ok(!out.includes('undefined'));
  assert.ok(out.startsWith('【AGY 值守模式') || out.startsWith('\n\n【AGY 值守模式'));
});

console.log('\n落盘：');

ok('★★ 阈值按 UTF-8 字节算（中文 3 字节/字，不能用 .length）', () => {
  const cjk = '鲸'.repeat(3000);          // 3000 字 ≈ 9000 字节 > 8KB，但 .length 只有 3000
  assert.ok(needsSpill(cjk), '中文超 8KB 必须判定为需要落盘');
  assert.ok(!needsSpill('a'.repeat(AGY_PROMPT_SPILL_BYTES)), '正好等于阈值不需要落盘');
  assert.ok(needsSpill('a'.repeat(AGY_PROMPT_SPILL_BYTES + 1)));
});

ok('★ 落盘路径在 state 下、带 turnId、不含危险字符', () => {
  const file = agyContextFilePath(path.join('D:', 'dsh', 'qq-bridge', 'state'), 't-20261125-0500-0001');
  assert.equal(path.basename(file), 'agy-context-t-20261125-0500-0001.md');
  assert.ok(file.includes('state'));
  const weird = agyContextFilePath('state', '../../evil/../x');
  // 关键是**文件名里**不许再有分隔符：否则 ../../ 就能跳出 state/
  const base = path.basename(weird);
  assert.ok(!base.includes('/') && !base.includes('\\'), `不许路径穿越: ${base}`);
  assert.equal(path.dirname(weird), 'state');
});

ok('★★ 落盘后的短提示必须带路径 + turnId + 覆盖说明（否则 agent 不知道怎么回）', () => {
  const file = path.join('state', 'agy-context-t-1.md');
  const turn = { turnId: 't-1', persona: '小鲸鱼', key: 'group:541026885', reason: 'atMention' };
  const short = agySpillPromptText(file, turn, 12345);
  assert.ok(short.includes(file), '必须给文件路径');
  assert.ok(short.includes('t-1') && short.includes('小鲸鱼') && short.includes('group:541026885'));
  assert.ok(short.includes('12345'), '要告诉 agent 原文有多长');
  assert.ok(short.includes('【AGY 值守模式'));
  assert.ok(short.length < 2500, `短提示自己不能再超长（现在 ${short.length} 字）`);
});

console.log(`\n全部通过：${n} 项断言组`);
