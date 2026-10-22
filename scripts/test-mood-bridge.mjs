// mood-bridge（鱼的心情适配）的离线回归：只改 targetSession、不碰别的、坏文件不覆盖
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moodConfigPath, readMoodTargetSession, syncMoodTargetSession } from '../src/mood-bridge.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mood-bridge-'));
const writeCfg = (home, cfg) => {
  const p = moodConfigPath({ home });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return p;
};
const SID = 'session-82e1cef4-ec79-4cb6-a35f-e8fb75552bf7';

console.log('基本行为：');

ok('没装插件（文件不存在）⇒ 静默跳过，不建目录也不写文件', () => {
  const home = tmpHome();
  const r = syncMoodTargetSession(SID, { home });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-installed');
  assert.equal(fs.existsSync(moodConfigPath({ home })), false);
});

ok('★ 写入 targetSession，且其它设置一个都不动', () => {
  const home = tmpHome();
  const before = {
    targetSession: '', selfName: '伙伴', ownerName: '用户', judgeModel: 'x',
    moodBase: 70, decayHalfHours: 12, injectMode: 'event', injectConfidence: 60, autoJudge: true
  };
  writeCfg(home, before);
  const r = syncMoodTargetSession(SID, { home });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const after = JSON.parse(fs.readFileSync(moodConfigPath({ home }), 'utf8'));
  assert.equal(after.targetSession, SID);
  for (const k of Object.keys(before)) {
    if (k === 'targetSession') continue;
    assert.deepEqual(after[k], before[k], `${k} 不该被改`);
  }
});

ok('★ 幂等：已经是这个会话 ⇒ changed=false，且不重写文件', () => {
  const home = tmpHome();
  const p = writeCfg(home, { targetSession: SID, autoJudge: true });
  const mtime = fs.statSync(p).mtimeMs;
  const r = syncMoodTargetSession(SID, { home });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(fs.statSync(p).mtimeMs, mtime);
});

ok('换会话时能跟过去（模拟桥接新建 session）', () => {
  const home = tmpHome();
  writeCfg(home, { targetSession: SID });
  const SID2 = 'session-e6817d22-d227-4a79-a887-c25770e5921c';
  assert.equal(syncMoodTargetSession(SID2, { home }).changed, true);
  assert.equal(readMoodTargetSession({ home }).target, SID2);
});

console.log('\n边界：');

ok('★ 非法 session id ⇒ 不写文件', () => {
  const home = tmpHome();
  const p = writeCfg(home, { targetSession: 'old' });
  for (const bad of ['', 'abc', 'session-', '../../evil']) {
    const r = syncMoodTargetSession(bad, { home });
    assert.equal(r.ok, false, `${bad} 不该成功`);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).targetSession, 'old');
  }
});

ok('★ JSON 坏了 ⇒ 只报错、绝不覆盖（否则毁掉用户设置）', () => {
  const home = tmpHome();
  const p = moodConfigPath({ home });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ 这不是 JSON', 'utf8');
  const r = syncMoodTargetSession(SID, { home });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-json');
  assert.equal(fs.readFileSync(p, 'utf8'), '{ 这不是 JSON');
});

ok('文件带 BOM 也能读（容忍别人手改过）', () => {
  const home = tmpHome();
  const p = moodConfigPath({ home });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '\uFEFF' + JSON.stringify({ targetSession: '', autoJudge: true }), 'utf8');
  const r = syncMoodTargetSession(SID, { home });
  assert.equal(r.ok, true);
  const after = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(after.targetSession, SID);
});

ok('输出文件是 UTF-8 无 BOM + 保留末尾换行', () => {
  const home = tmpHome();
  writeCfg(home, { targetSession: '' });
  syncMoodTargetSession(SID, { home });
  const buf = fs.readFileSync(moodConfigPath({ home }));
  assert.notDeepEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF], '不能带 BOM');
  assert.equal(buf.toString('utf8').endsWith('\n'), true);
});

console.log('\n接线：');

ok('★ 桥接在建会话后调用它（源码守卫）', () => {
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /from '\.\/mood-bridge\.js'/, '要 import 适配模块');
  assert.match(bridge, /syncMoodTargetSession\(sessionId/, '建会话后要同步');
  // 调用必须发生在 state.sessions[key] = sessionId 之后（否则会话还没记上）
  const iAssign = bridge.indexOf('state.sessions[key] = sessionId;');
  const iSync = bridge.indexOf('syncMoodTargetSession(sessionId');
  assert.ok(iAssign > 0 && iSync > iAssign, '同步点要在会话登记之后');
});

console.log(`\n全部通过：${n} 项断言组`);
