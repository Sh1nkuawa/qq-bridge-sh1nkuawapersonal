// 生日模块的离线回归：北京时区、闰年 2/29、去重、补发、提示词
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beijingParts, birthdayPromptLine, isValidMonthDay, loadBirthdays, markSent, saveBirthdays,
  shouldTickNow, todaysBirthdays
} from '../src/birthday.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
/** 造一个"北京时间 YYYY-MM-DD HH:mm"对应的时间戳 */
const bj = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm);

console.log('北京时间与判定：');

ok('beijingParts 按 UTC+8 换算', () => {
  const p = beijingParts(bj(2026, 10, 26, 0, 0));
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 10, 26, 0, 0]);
});

ok('★ 今天是他的生日 → 命中', () => {
  const list = { '100000001': { name: '小明', month: 10, day: 26 } };
  const hit = todaysBirthdays(list, bj(2026, 10, 26, 0, 0));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, '小明');
});

ok('不是今天 → 不命中', () => {
  const list = { '100000001': { name: '小明', month: 10, day: 26 } };
  assert.equal(todaysBirthdays(list, bj(2026, 10, 27)).length, 0);
});

ok('★ 同一年只发一次（lastSentYear 去掉重）', () => {
  const list = { '100000001': { name: '小明', month: 10, day: 26, lastSentYear: 2026 } };
  assert.equal(todaysBirthdays(list, bj(2026, 10, 26)).length, 0);
  // 到了下一年要能再发
  assert.equal(todaysBirthdays(list, bj(2027, 10, 26)).length, 1);
});

ok('★ 闰年 2/29：闰年当天算，平年默认按 2/28', () => {
  const list = { '100000002': { name: '小红', month: 2, day: 29 } };
  assert.equal(todaysBirthdays(list, bj(2028, 2, 29)).length, 1, '2028 是闰年');
  assert.equal(todaysBirthdays(list, bj(2028, 2, 28)).length, 0);
  assert.equal(todaysBirthdays(list, bj(2027, 2, 28)).length, 1, '平年按 2/28');
  assert.equal(todaysBirthdays(list, bj(2027, 3, 1)).length, 0);
});

ok('日期校验（含 2/30 这种非法值）', () => {
  assert.equal(isValidMonthDay(10, 26), true);
  assert.equal(isValidMonthDay(2, 29), true);
  assert.equal(isValidMonthDay(2, 30), false);
  assert.equal(isValidMonthDay(13, 1), false);
  assert.equal(isValidMonthDay(4, 31), false);
});

console.log('\n触发时机：');

ok('★ 0 点整 ⇒ midnight', () => {
  const r = shouldTickNow(bj(2026, 10, 26, 0, 0));
  assert.equal(r.due, true);
  assert.equal(r.reason, 'midnight');
});

ok('★ 0 点之后 ⇒ catch-up（当天补发）', () => {
  const r = shouldTickNow(bj(2026, 10, 26, 9, 30));
  assert.equal(r.due, true);
  assert.equal(r.reason, 'catch-up');
});

ok('关掉补发 ⇒ 0 点后不触发', () => {
  assert.equal(shouldTickNow(bj(2026, 10, 26, 9, 30), { catchUp: false }).due, false);
});

console.log('\n存取与提示词：');

ok('loadBirthdays 文件不存在 ⇒ 空对象；saveBirthdays 能原子写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bday-'));
  assert.deepEqual(loadBirthdays({ stateDir: dir }), {});
  const list = { '100000001': { name: '小明', month: 10, day: 26 } };
  assert.equal(saveBirthdays(list, { stateDir: dir }), true);
  assert.deepEqual(loadBirthdays({ stateDir: dir }), list);
  assert.ok(!fs.readFileSync(path.join(dir, 'birthdays.json')).slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), '不能带 BOM');
});

ok('markSent 记年份', () => {
  const list = { '100000001': { name: '小明', month: 10, day: 26 } };
  markSent(list, '100000001', 2026);
  assert.equal(list['100000001'].lastSentYear, 2026);
});

ok('★ 提示词：@ 他 + 不提名字 + qq_speak + 日语硬要求', () => {
  const line = birthdayPromptLine({ name: '小明', userId: '100000001', age: 20 }, { key: 'group:123456789' });
  assert.match(line, /100000001/, '要带 QQ 号用于 @');
  assert.match(line, /atUserId/);
  assert.match(line, /qq_speak/);
  assert.match(line, /日语/);
  assert.match(line, /不要写.*名字/, '明确要求不提名字（群名片会变）');
  assert.doesNotMatch(line, /小明/, '提示词里不该再出现名字');
});

ok('★ 同一天两人 ⇒ 一人一组、按顺序（1 先 2 后）', () => {
  const line = birthdayPromptLine([
    { name: '甲', userId: '100000001' },
    { name: '乙', userId: '100000002' }
  ], { key: 'group:123456789' });
  assert.match(line, /2 位/);
  assert.match(line, /1\. QQ 100000001/);
  assert.match(line, /2\. QQ 100000002/);
  assert.ok(line.indexOf('100000001') < line.indexOf('100000002'), '第一个要排在前面');
  assert.match(line, /不要合并/);
  assert.match(line, /等这一次返回后/);
  assert.doesNotMatch(line, /甲|乙/, '不该出现名字');
});

console.log(`\n全部通过：${n} 项断言组`);
