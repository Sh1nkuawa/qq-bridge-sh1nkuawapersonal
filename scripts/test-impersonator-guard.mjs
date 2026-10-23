// 冒名守卫的离线回归：只认"像 bot 名"的组合、正确生成新名片、护栏齐全
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_PREFIX, decideRename, looksLikeBotName, normalizeName, pickDisguiseCard, tailOfName
} from '../src/impersonator-guard.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

console.log('归一化与判定：');

ok('归一化：全角→半角、去符号/空白', () => {
  assert.equal(normalizeName('！？鲸鲸？！'), '鲸鲸');
  assert.equal(normalizeName('ＷＨＡＬＥ　哦鲸'), 'whale哦鲸');
});

ok('★ 只认「像 bot 名」的组合，不认单独的 哦 / 鲸', () => {
  for (const card of ['！？鲸鲸？！', '鲸鲸', '哦鲸', '小哦鲸鲸', '哦鲸鲸？']) {
    assert.equal(looksLikeBotName(card).hit, true, `${card} 应该命中`);
  }
  for (const card of ['哦豁', '鲸落', '哦哦哦', '梅川 鲸鱼', '库库']) {
    assert.equal(looksLikeBotName(card).hit, false, `${card} 不该命中（会误伤）`);
  }
});

ok('生成新名片：「冒名·」+ 原昵称尾部', () => {
  assert.equal(pickDisguiseCard('！？鲸鲸？！'), '冒名·鲸鲸');
  assert.equal(pickDisguiseCard('哦鲸鲸鲸鲸'), '冒名·鲸鲸鲸鲸');
  assert.ok(pickDisguiseCard('哦鲸'.repeat(20)).length <= 20);
  assert.equal(tailOfName('！？鲸鲸？！'), '鲸鲸');
});

console.log('\n护栏：');

const base = { card: '！？鲸鲸？！', userId: '123', now: NOW };

ok('★ 不改 bot 自己 / 群主 / 管理员', () => {
  assert.equal(decideRename({ ...base, isSelf: true }).rename, false);
  assert.equal(decideRename({ ...base, isOwner: true }).rename, false);
  assert.equal(decideRename({ ...base, isAdmin: true }).rename, false);
});

ok('正常人不动', () => {
  assert.equal(decideRename({ ...base, card: '梅川 库库' }).rename, false);
});

ok('★ 冒名者会被改，且说明原因', () => {
  const r = decideRename(base);
  assert.equal(r.rename, true);
  assert.equal(r.newCard, '冒名·鲸鲸');
  assert.match(r.reason, /像 bot 名/);
});

ok('★ 幂等：已经是「冒名·」的不再改；同一个人的同一张名片只改一次', () => {
  assert.equal(decideRename({ ...base, card: '冒名·鲸鲸' }).rename, false);
  const done = new Set(['123|鲸鲸']);
  assert.equal(decideRename({ ...base, done }).rename, false);
});

ok('★ 每小时上限（默认 5）', () => {
  const recentRenameAt = Array.from({ length: 5 }, (_, i) => NOW - i * 1000);
  const r = decideRename({ ...base, userId: '999', recentRenameAt });
  assert.equal(r.rename, false);
  assert.match(r.reason, /上限/);
  // 一小时前的旧记录不算
  const old = Array.from({ length: 5 }, () => NOW - 2 * 3600 * 1000);
  assert.equal(decideRename({ ...base, userId: '999', recentRenameAt: old }).rename, true);
});

ok('自定义前缀/标记也能用（给以后调参）', () => {
  const r = decideRename({ ...base, card: '鲸鲸鲸', prefix: '假·' });
  assert.equal(r.newCard, '假·鲸鲸鲸');
});


console.log('\n接线位置（踩过两次坑）：');

ok('★ 钩子必须在 appendSocialV2Message 里，且只用 key 判断（kind 不存在 ⇒ ReferenceError）', () => {
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const iMsg = bridge.indexOf('function appendSocialV2Message(');
  const iPoke = bridge.indexOf('function appendSocialV2Poke(');
  assert.ok(iMsg > 0 && iPoke > iMsg, '找不到两个入库函数');
  const iHook = bridge.indexOf('void guardImpersonatorRename(key, msg)', iMsg);
  assert.ok(iHook > iMsg && iHook < iPoke, '钩子必须在消息入库函数里（上次落到拍一拍里 ✗）');
  assert.ok(!bridge.includes("if (kind === 'group') void guardImpersonatorRename"), '不许用 kind 判断（那个函数里没有它 ✗）');
  assert.match(bridge, /String\(key\)\.startsWith\('group:'\)\) void guardImpersonatorRename/, '要用 key 判断群');
});

console.log(`\n全部通过：${n} 项断言组`);
