// persona-lines.js 单元测试：桥接"替机器人说的话"（禁言播报 / 生图开始提示）。
// 运行：node scripts/test-persona-lines.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ANNOUNCE_TEMPLATES,
  DEFAULT_ANNOUNCE_TEMPLATES_ATTACK,
  DEFAULT_IMAGE_ACK_TEMPLATES,
  pickTemplateLine,
  pickImageAckLine
} from '../src/persona-lines.js';
import { DEFAULT_ADMIN_CFG, pickAnnounceLine } from '../src/moderation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let count = 0;
const ok = (label, fn) => { fn(); count++; console.log('  ok -', label); };

console.log('模板池基本约束');
ok('三个池都非空且无重复', () => {
  for (const [name, pool] of [['刷屏', DEFAULT_ANNOUNCE_TEMPLATES], ['攻击', DEFAULT_ANNOUNCE_TEMPLATES_ATTACK], ['生图', DEFAULT_IMAGE_ACK_TEMPLATES]]) {
    assert.ok(pool.length >= 3, `${name}池至少 3 条，实际 ${pool.length}`);
    assert.equal(new Set(pool).size, pool.length, `${name}池有重复`);
  }
});
ok('都带占位符（否则文案会变成死的）', () => {
  assert.ok(DEFAULT_ANNOUNCE_TEMPLATES.every((t) => t.includes('{name}') && t.includes('{minutes}')));
  assert.ok(DEFAULT_IMAGE_ACK_TEMPLATES.every((t) => t.includes('{name}') || t.includes('画')));
  assert.ok(DEFAULT_IMAGE_ACK_TEMPLATES.some((t) => t.includes('{remaining}')));
});
ok('播报文案不带脏字、不威胁', () => {
  const all = [...DEFAULT_ANNOUNCE_TEMPLATES, ...DEFAULT_ANNOUNCE_TEMPLATES_ATTACK, ...DEFAULT_IMAGE_ACK_TEMPLATES];
  for (const t of all) {
    assert.doesNotMatch(t, /傻|蠢|滚|垃圾|去死/, `模板含不该有的词：${t}`);
  }
});

console.log('pickTemplateLine');
ok('随机抽取并填充变量', () => {
  assert.equal(pickTemplateLine(['A {name} {minutes}'], { name: '甲', minutes: 3 }), 'A 甲 3');
  assert.equal(pickTemplateLine(['x'], {}, () => 0), 'x');
});
ok('空池返回空串（调用方自己回落）', () => {
  assert.equal(pickTemplateLine([], { name: '甲' }), '');
  assert.equal(pickTemplateLine(null, {}), '');
});
ok('random 越界也不会崩', () => {
  assert.equal(pickTemplateLine(['a', 'b'], {}, () => 0.999999), 'b');
});

console.log('pickImageAckLine');
ok('正常渲染：带名字、不说"还剩次"这种残缺话', () => {
  const cfg = { ackEnabled: true, ackTemplates: DEFAULT_IMAGE_ACK_TEMPLATES };
  const withRemaining = pickImageAckLine(cfg, { name: '甲', remaining: 4, random: () => 0.999 });
  assert.match(withRemaining, /甲/);
  assert.match(withRemaining, /4/);
  const owner = pickImageAckLine(cfg, { name: '甲', remaining: null, isOwner: true, random: () => 0.999 });
  assert.doesNotMatch(owner, /还剩|remaining/, 'owner 无限次时不能出现剩余次数');
  assert.match(owner, /甲/);
});
ok('ackEnabled=false 时返回空串（能关）', () => {
  assert.equal(pickImageAckLine({ ackEnabled: false }, { name: '甲' }), '');
});
ok('自定义模板优先于内置', () => {
  assert.equal(pickImageAckLine({ ackTemplates: ['自定义 {name}'] }, { name: '乙', random: () => 0 }), '自定义 乙');
});
ok('内置池能抽满多条不同文案（不是一条死文案）', () => {
  const cfg = {};
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(pickImageAckLine(cfg, { name: '甲', remaining: 3, random: () => i / 60 }));
  assert.ok(seen.size >= 4, `应能抽出多条，实际 ${seen.size}`);
});

console.log('与 moderation 的禁言播报共用同一套池');
ok('DEFAULT_ADMIN_CFG 用的是 persona-lines 的池', () => {
  assert.deepEqual(DEFAULT_ADMIN_CFG.announceTemplates, DEFAULT_ANNOUNCE_TEMPLATES);
  assert.deepEqual(DEFAULT_ADMIN_CFG.announceTemplatesAttack, DEFAULT_ANNOUNCE_TEMPLATES_ATTACK);
});
ok('禁言播报仍能正常渲染（回归）', () => {
  const line = pickAnnounceLine({}, { name: '甲', minutes: 3, random: () => 0 });
  assert.match(line, /甲/);
  assert.match(line, /3/);
  const atk = pickAnnounceLine({}, { name: '乙', minutes: 5, kind: 'attack', random: () => 0.9 });
  assert.match(atk, /乙/);
});

console.log('接线存在性');
ok('bridge 在受理生图后调用 sendImageAck', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /void sendImageAck\(key, \{/);
  assert.match(bridge, /async function sendImageAck\(/);
  assert.match(bridge, /recordSelfMessage\(key, line, \{ imageAck: true \}\)/);
});
ok('唤醒提示会告诉模型"开场白已经替你发过了"', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /开始那句桥接已经替你发过了/);
});
ok('config.json 里有 image.ackEnabled 与模板', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.equal(cfg.socialV2.image.ackEnabled, true);
  assert.ok(Array.isArray(cfg.socialV2.image.ackTemplates) && cfg.socialV2.image.ackTemplates.length >= 3);
});

console.log(`\n全部通过：${count} 项断言组`);
