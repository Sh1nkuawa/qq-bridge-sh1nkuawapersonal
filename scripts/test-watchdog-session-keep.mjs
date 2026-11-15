// 回归：busy 看门狗在"DSH 明确报告无运行中回合"时**不许解绑会话**。
//
// 背景（2026-11-15 定位）：src/bridge.js 的 busy 看门狗自 2026-09-29（696b81c）引入起，
// 只要「静默超阈值 + DSH 报告无运行中回合」就把会话解绑 → 下次唤醒重建会话。
// 但"DSH 说没有运行中的回合"其实是**回合正常结束**，不是卡死 ✗。
// 后果：上下文丢失、prompt cache 全 miss、DSH 里堆死会话、心情插件反复重绑（单日 4h 内 23 次）。
//
// 这个测试不跑运行时（逻辑在 bridge 闭包里），而是静态守住这段代码的形状：
//   · 必须有 `runningMap.get(mapped) === false` 的保留分支，且分支内是 continue（不解绑）
//   · 该分支必须出现在 `delete state.sessions[key]` **之前**
//   · 真正解绑的兜底逻辑仍要保留（查询失败时才用）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✅ ${name}`); };

console.log('busy 看门狗：会话保留修复');

ok('★ 存在「DSH 报告无运行中回合 ⇒ 保留会话」的分支', () => {
  assert.match(SRC, /runningMap\.get\(mapped\) === false/, '缺少保留分支');
});

ok('★ 该分支内是 continue（不是 delete 会话）', () => {
  const i = SRC.indexOf('runningMap.get(mapped) === false');
  assert.ok(i > 0, '找不到分支');
  const seg = SRC.slice(i, i + 600);
  const contIdx = seg.indexOf('continue;');
  assert.ok(contIdx > 0, '分支里没有 continue');
  const head = seg.slice(0, contIdx);
  assert.doesNotMatch(head, /delete state\.sessions/, '分支里居然在删会话 ✗');
});

ok('★ 保留分支必须早于解绑代码（先判断、后兜底）', () => {
  const keep = SRC.indexOf('runningMap.get(mapped) === false');
  // 找 watchdog 里的解绑点（注释「复活该会话」之后那句）
  const revive = SRC.indexOf('复活该会话：下条消息会重建会话');
  assert.ok(revive > 0, '找不到解绑处');
  const unbind = SRC.indexOf('delete state.sessions[key]', revive);
  assert.ok(unbind > 0, '找不到 delete state.sessions[key]');
  assert.ok(keep < unbind, '保留分支必须在解绑之前');
});

ok('兜底解绑仍然保留（查询失败时还要能自愈）', () => {
  const revive = SRC.indexOf('复活该会话：下条消息会重建会话');
  assert.ok(revive > 0, '兜底解绑被误删了');
  assert.match(SRC.slice(revive, revive + 400), /delete state\.sessions\[key\]/, '兜底里没有解绑');
});

ok('代码里写清了「为什么」和事故数据（防以后又被改回去）', () => {
  const i = SRC.indexOf('回合已正常结束（DSH 无运行中回合）');
  assert.ok(i > 0, '缺少日志文案');
  const ctx = SRC.slice(Math.max(0, i - 1400), i);
  assert.match(ctx, /回合正常结束/, '缺少原因说明');
  assert.match(ctx, /cache/i, '缺少 token 代价说明');
});

console.log(`\n全部通过：${n} 项断言组`);
