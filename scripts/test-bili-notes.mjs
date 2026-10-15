// B 站"轻记忆"（记住自己说过什么、防前后矛盾）的离线回归
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bvidOf, buildConsistencyLine, loadNotes, rememberTake, saveNotes, takeFromMessages } from '../src/bili-notes.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

console.log('取 BV 号与整理 take：');

ok('bvidOf：从各种写法里抠出 BV', () => {
  assert.equal(bvidOf('https://www.bilibili.com/video/BV1Cgpd6pEBR?share=1'), 'BV1Cgpd6pEBR');
  assert.equal(bvidOf('BV1Cgpd6pEBR'), 'BV1Cgpd6pEBR');
  assert.equal(bvidOf('https://b23.tv/abc'), '');
  assert.equal(bvidOf(''), '');
});

ok('takeFromMessages：拼句、去 URL、去 CQ 码、限长', () => {
  assert.equal(takeFromMessages(['讲的是苏联那起劫机案', '  细节挺离谱 ']), '讲的是苏联那起劫机案 细节挺离谱');
  assert.equal(takeFromMessages('看这个 https://b23.tv/x 就行'), '看这个 就行');
  assert.equal(takeFromMessages('[CQ:image,file=a.jpg]这图有意思'), '这图有意思');
  assert.equal(takeFromMessages(['']), '');
  const long = takeFromMessages(['字'.repeat(1000)], { maxChars: 100 });
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('…'));
});

console.log('\n记住 / 覆盖 / 裁剪：');

ok('rememberTake：新覆盖旧，并累计次数', () => {
  let notes = {};
  notes = rememberTake(notes, { bvid: 'BV1Cgpd6pEBR', title: '苏联版空中监狱', take: '第一次：讲劫机', at: 1000 });
  assert.equal(notes.BV1Cgpd6pEBR.take, '第一次：讲劫机');
  assert.equal(notes.BV1Cgpd6pEBR.count, 1);
  notes = rememberTake(notes, { bvid: 'BV1Cgpd6pEBR', take: '第二次：其实是机组自救', at: 2000 });
  assert.equal(notes.BV1Cgpd6pEBR.take, '第二次：其实是机组自救', '新的要覆盖旧的（只要一致性，不要流水账）');
  assert.equal(notes.BV1Cgpd6pEBR.count, 2);
  assert.equal(notes.BV1Cgpd6pEBR.title, '苏联版空中监狱', '标题缺省时保留旧的');
});

ok('rememberTake：坏输入不写入', () => {
  const notes = rememberTake({}, { bvid: 'not-a-bv', take: 'x' });
  assert.deepEqual(notes, {});
  assert.deepEqual(rememberTake({}, { bvid: 'BV1Cgpd6pEBR', take: '   ' }), {});
});

ok('rememberTake：超上限时按时间裁掉最旧的', () => {
  let notes = {};
  for (let i = 0; i < 8; i += 1) {
    notes = rememberTake(notes, { bvid: `BV1Cgpd6pE${String.fromCharCode(65 + i)}R`, take: `第 ${i} 条`, at: 1000 + i, maxEntries: 3 });
  }
  const ids = Object.keys(notes);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes('BV1Cgpd6pEHR'), '最新的必须在');
  assert.ok(!ids.includes('BV1Cgpd6pEAR'), '最旧的要被裁掉');
});

console.log('\n一致性提示：');

ok('buildConsistencyLine：没记过就不插话', () => {
  assert.equal(buildConsistencyLine({}, 'BV1Cgpd6pEBR'), '');
  assert.equal(buildConsistencyLine({ BV1Cgpd6pEBR: {} }, 'BV1Cgpd6pEBR'), '');
  assert.equal(buildConsistencyLine({ BV1Cgpd6pEBR: { take: 'x' } }, 'b23.tv/abc'), '');
});

ok('★buildConsistencyLine：记过就要摆出来 + 留"改口"的正当出口', () => {
  const notes = { BV1Cgpd6pEBR: { title: 't', take: '讲了苏联劫机案，机组自救', at: Date.now() } };
  const line = buildConsistencyLine(notes, 'https://www.bilibili.com/video/BV1Cgpd6pEBR');
  assert.match(line, /你之前对这条视频说过/);
  assert.match(line, /讲了苏联劫机案，机组自救/);
  assert.match(line, /保持一致/, '要明确要求一致');
  assert.match(line, /说错了|纠正/, '也要给出改口的路，免得为了不矛盾硬撑错话');
  assert.match(line, /上次/, '带时间，方便判断"多久以前说的"');
});

ok('存取：saveNotes/loadNotes 往返；坏文件当空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-notes-'));
  const file = path.join(dir, 'bili-notes.json');
  const notes = rememberTake({}, { bvid: 'BV1Cgpd6pEBR', take: '往返测试', at: 1234 });
  assert.equal(saveNotes(file, notes), true);
  const back = loadNotes(file);
  assert.equal(back.BV1Cgpd6pEBR.take, '往返测试');
  fs.writeFileSync(file, '{ 坏 json', 'utf8');
  assert.deepEqual(loadNotes(file), {});
  assert.deepEqual(loadNotes(path.join(dir, '不存在.json')), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n接线与口径：');

ok('源码守卫：桥接有"记录 + 注入"两处，且模块里写明 owner 的口径', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const mod = fs.readFileSync(path.join(root, 'src', 'bili-notes.js'), 'utf8');
  assert.match(mod, /不需要记得很精确/, '要把 owner 的口径写进代码，免得以后被"更精确"带跑');
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /rememberTakeIfVideo/, '发送时要记录');
  assert.match(bridge, /buildConsistencyLine/, '构建提示时要注入');
  assert.match(bridge, /bili-notes\.json/, '记忆要落在 state/ 下');
  // 精确分页那套已经按 owner 的口径放弃：提示里不该再承诺"按时间取片段"
  // （"提示文本里不出现未注册的工具名"这条由 test-bili-subtitle.mjs 断言，注释里提到不算）
  const sub = fs.readFileSync(path.join(root, 'src', 'bili-subtitle.js'), 'utf8');
  assert.ok(!/按时间取任意片段/.test(sub), '不再承诺精确分页 ✅');
  assert.ok(/不必逐句精确/.test(sub), '要明说"不必逐句精确"（owner 的口径）');
});

console.log(`\n全部通过：${n} 项断言组`);
