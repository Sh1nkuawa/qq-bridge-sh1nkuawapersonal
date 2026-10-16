// 决定性验证：走"B 站专用通道（DoH 直连）"，元信息 + 字幕还能不能拿到
import path from 'node:path';
import { createBiliFetch } from '../src/bili-direct.js';
import { summarizeBilibili } from '../src/link-bilibili.js';
import { createBiliAuth } from '../src/bili-auth.js';
import { fetchSubtitle } from '../src/bili-subtitle.js';

const logs = [];
const biliFetch = createBiliFetch({ log: (m) => logs.push(m) });

console.log('=== ① 元信息（用直连通道）===');
for (const url of ['https://b23.tv/GPk04QI', 'https://b23.tv/b9dEBIc']) {
  const t0 = Date.now();
  const r = await summarizeBilibili(url, { timeoutMs: 15000, descChars: 120, fetchImpl: biliFetch });
  console.log(`  ${url} → ok=${r.ok} bvid=${r.bvid ?? '-'} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.ok) console.log('      ' + String(r.text).split('\n').slice(0, 2).join(' | ').slice(0, 130));
  else console.log('      reason=' + r.reason);
}

console.log('\n=== ② 字幕（登录态 + 直连通道）===');
const auth = createBiliAuth({
  stateFile: 'D:/dsh/qq-bridge/state/bili-auth.json',
  log: () => {},
  fetchImpl: biliFetch
});
const st = await auth.status({ force: true });
console.log(`  nav: loggedIn=${st.loggedIn} uname=${st.uname}`);
for (const bv of ['BV1KZ3x6SEBb', 'BV1ARp26aEHv']) {
  const s = await fetchSubtitle(bv, { auth, cacheDir: 'D:/dsh/qq-bridge/state/bili-subs', force: true, log: () => {} });
  console.log(`  ${bv} → ${s.ok ? `✓ ${s.subtitle.cues.length} 条 cue / 正文 ${s.subtitle.chars} 字` : `✗ ${s.reason} ${s.message ?? ''}`}`);
}

if (logs.length) {
  console.log('\n=== 通道日志（有回落才会出现）===');
  for (const l of logs.slice(0, 6)) console.log('  ' + l);
} else {
  console.log('\n=== 通道日志：无（说明全程直连成功，没有回落）✓ ===');
}
