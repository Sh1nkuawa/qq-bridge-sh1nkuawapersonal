// 真机验证字幕模块：抓取 → 分层精编 → 分页 → 缓存命中
import path from 'node:path';
import { createBiliAuth } from '../src/bili-auth.js';
import { buildSubtitleBrief, fetchSubtitle, pageSubtitle } from '../src/bili-subtitle.js';

const ROOT = 'D:/dsh/qq-bridge';
const auth = createBiliAuth({ stateFile: path.join(ROOT, 'state', 'bili-auth.json'), log: (m) => console.log('  ' + m) });
const BV = process.argv[2] || 'BV1Cgpd6pEBR';   // 44 分钟、1529 条 cue、正文 14058 字

console.log(`=== 抓字幕 ${BV}（首次会下载并缓存）===`);
const t0 = Date.now();
const r = await fetchSubtitle(BV, { auth, cacheDir: path.join(ROOT, 'state', 'bili-subs'), log: (m) => console.log('  ' + m) });
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s  ok=${r.ok}  cached=${r.cached ?? false}` + (r.ok ? '' : `  reason=${r.reason} ${r.message ?? ''}`));
if (!r.ok) process.exitCode = 1;
else {
  const s = r.subtitle;
  console.log(`  标题：${s.title}`);
  console.log(`  时长 ${s.duration}s（${Math.round(s.duration / 60)} 分）  语言 ${s.lan}(${s.lanDoc})  AI=${s.ai}`);
  console.log(`  cue ${s.cues.length} 条，正文 ${s.chars} 字`);
  console.log(`  缓存文件：${path.join(ROOT, 'state', 'bili-subs', BV + '.json')}`);

  console.log('\n=== 分层精编（不同 injectMaxChars）===');
  for (const budget of [2500, 6000, 20000]) {
    const b = buildSubtitleBrief(s, { injectMaxChars: budget, outlineThreshold: 12000 });
    console.log(`  预算 ${String(budget).padStart(5)} → mode=${b.mode.padEnd(8)} 取 ${String(b.usedChars).padStart(5)} 字 / 正文 ${b.totalChars} 字  抽样 ${b.buckets} 段`);
  }
  const brief = buildSubtitleBrief(s, { injectMaxChars: 2500, outlineThreshold: 12000 });
  console.log('\n  —— 进 prompt 的那段（前 500 字）——');
  console.log(brief.text.slice(0, 500).split('\n').map((l) => '  │ ' + l).join('\n'));
  console.log('  —— 结尾 200 字 ——');
  console.log(brief.text.slice(-200).split('\n').map((l) => '  │ ' + l).join('\n'));

  console.log('\n=== 分页（从第 10 分钟取 1200 字）===');
  const page = pageSubtitle(s, { fromSec: 600, maxChars: 1200 });
  console.log(`  from=${page.fromSec}s next=${page.nextFromSec}s 取 ${page.returnedChars} 字 / 全文 ${page.totalChars} 字`);
  console.log(page.text.slice(0, 300).split('\n').map((l) => '  │ ' + l).join('\n'));

  console.log('\n=== 再抓一次（应为缓存命中）===');
  const t1 = Date.now();
  const r2 = await fetchSubtitle(BV, { auth, cacheDir: path.join(ROOT, 'state', 'bili-subs'), log: () => {} });
  console.log(`  耗时 ${Date.now() - t1}ms  cached=${r2.cached}  cue ${r2.subtitle?.cues?.length}`);
}
