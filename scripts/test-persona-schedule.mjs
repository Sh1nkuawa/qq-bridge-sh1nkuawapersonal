// 每日人格轮换的离线回归：窗口、忙碌延后、不补切、幂等、轮换顺序
import assert from 'node:assert/strict';
import { beijingParts, dayKey, indexOfRole, parseSwitchAt, shouldSwitch } from '../src/persona-schedule.js';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✅ ${name}`); };

/** 北京时间的某个时刻 → 时间戳 */
const bj = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm);

const ROT = ['小鲸鱼', '猫娘侍从'];
const base = { switchAt: '05:00', windowMinutes: 30, rotation: ROT, index: 0 };

console.log('时间与解析：');

ok('beijingParts 按 UTC+8', () => {
  const p = beijingParts(bj(2026, 11, 16, 5, 0));
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 11, 16, 5, 0]);
});

ok('dayKey 补零', () => {
  assert.equal(dayKey(beijingParts(bj(2026, 1, 5, 5, 0))), '2026-01-05');
});

ok('parseSwitchAt 合法/非法', () => {
  assert.deepEqual(parseSwitchAt('05:00'), { hour: 5, minute: 0 });
  assert.equal(parseSwitchAt('24:00'), null);
  assert.equal(parseSwitchAt('5点'), null);
});

console.log('\n该不该切：');

ok('★ 04:59 不切（还没到点）', () => {
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 16, 4, 59), lastSwitchedDay: '2026-11-15' });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'before-window');
});

ok('★ 05:00 准点切，切到下一个角色', () => {
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 16, 5, 0), lastSwitchedDay: '2026-11-15' });
  assert.equal(r.due, true);
  assert.equal(r.name, '猫娘侍从');
  assert.equal(r.index, 1);
  assert.equal(r.day, '2026-11-16');
});

ok('★ 05:20 仍在窗口内 ⇒ 补上（当天还没切过）', () => {
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 16, 5, 20), lastSwitchedDay: '2026-11-15' });
  assert.equal(r.due, true);
});

ok('★★ 05:31 超出窗口 ⇒ 当天放弃（owner：不补切）', () => {
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 16, 5, 31), lastSwitchedDay: '2026-11-15' });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'outside-window');
});

ok('★★ 09:00 起桥接（错过了 05:00）⇒ 不切', () => {
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 16, 9, 0), lastSwitchedDay: '2026-11-15' });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'outside-window');
});

ok('★ 这一轮还在跑 ⇒ busy，等下一分钟', () => {
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 16, 5, 5), lastSwitchedDay: '2026-11-15', busy: true });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'busy');
});

ok('★ 今天已经切过 ⇒ 幂等（重启也不会重复切）', () => {
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 16, 5, 10), lastSwitchedDay: '2026-11-16' });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'already-switched');
});

ok('轮换会绕回（两人表：0→1→0）', () => {
  const r1 = shouldSwitch({ ...base, now: bj(2026, 11, 16, 5, 0), lastSwitchedDay: '2026-11-15', index: 0 });
  assert.equal(r1.index, 1);
  const r2 = shouldSwitch({ ...base, now: bj(2026, 11, 17, 5, 0), lastSwitchedDay: '2026-11-16', index: 1 });
  assert.equal(r2.index, 0);
  assert.equal(r2.name, '小鲸鱼');
});

ok('配置不完整时安静跳过', () => {
  assert.equal(shouldSwitch({ now: bj(2026, 11, 16, 5, 0), rotation: ['只有一个'] }).reason, 'no-rotation');
  assert.equal(shouldSwitch({ now: bj(2026, 11, 16, 5, 0), rotation: ROT, switchAt: 'xx' }).reason, 'bad-switch-at');
});

console.log('\n起始 index：');

ok('按当前角色算起始位置（保证下一次真的换人）', () => {
  assert.equal(indexOfRole(ROT, '小鲸鱼'), 0);
  assert.equal(indexOfRole(ROT, '猫娘侍从'), 1);
  assert.equal(indexOfRole(ROT, '不存在的角色'), 0);
});

ok('★★ 脱节场景：state.index 说在 0（小鲸鱼），实际角色是猫娘侍从 ⇒ 下一个必须是小鲸鱼', () => {
  // 复现 2026-11-17 事故：手动切换不更新 state.index，
  // 导致 05:00 算出的"下一个"正好等于当前角色 ⇒ 空转，看起来像"没切换"。
  const actual = '猫娘侍从';
  const idx = indexOfRole(ROT, actual);   // 以**实际角色**为准 = 1
  const r = shouldSwitch({ ...base, now: bj(2026, 11, 17, 5, 0), lastSwitchedDay: '2026-11-16', index: idx });
  assert.equal(r.due, true);
  assert.notEqual(r.name, actual, '不能切到当前角色（那等于没切）');
  assert.equal(r.name, '小鲸鱼');
});

console.log(`\n全部通过：${n} 项断言组`);
