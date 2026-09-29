// 本机离线回归总入口：顺序跑 scripts/test-*.mjs，跳过依赖外部环境的用例
// （桥接 3100 在线 / OneBot / 仓库上一级 ../voice-tool / Playwright / 聚合器本身）。
//
// 用法：
//   node scripts/run-offline-tests.mjs             # 全跑
//   node scripts/run-offline-tests.mjs memes image # 只跑文件名含关键词的
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SKIP = new Set([
  'test-admin-routes.mjs',       // 需要桥接 3100 在线
  'test-owner-dm.mjs',           // 需要桥接 3100 在线
  'test-mute-live.mjs',          // 需要桥接 + OneBot，会真的禁言
  'test-console.mjs',            // 需要桥接 3100 在线
  'test-meme-routes.mjs',        // 需要桥接 3100 在线
  'test-image-ack.mjs',          // 需要桥接 3100 在线
  'test-meme-prompt.mjs',        // 需要桥接 3100 在线
  'test-onebot-connection.mjs',  // 需要 OneBot
  'test-dsh-v2-wait.mjs',        // 端到端：需要桥接 + DSH
  'test-mux-reconnect.mjs',      // 需要 DSH 事件流
  'test-voice.mjs',              // 需要仓库上一级 ../voice-tool（本机未安装）
  'test-voice-gui.mjs',          // 同上
  'test-voice-system.mjs',       // 同上
  'test-console-static.mjs',     // 同上（读 ../voice-tool/public/voice.html）
  'test-console-encoding.mjs',   // 同上
  'test-encoding.mjs',           // 同上（检查语音工具的启动器 .cmd）
  'test-snowluma-conn.mjs',      // 同上
  'test-console-ui.mjs',         // 需要 Playwright（未安装）
  'test-audit.mjs',              // 聚合器：会连带跑上面那些依赖外部环境的用例
]);

const filters = process.argv.slice(2);
const files = fs.readdirSync('scripts')
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .filter((f) => !SKIP.has(f))
  .filter((f) => (!filters.length || filters.some((k) => f.includes(k))))
  .sort();

const results = [];
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['scripts/' + f], { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const ms = Date.now() - started;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  results.push({ f, ok, ms });
  console.log(`${ok ? '✅' : '❌'} ${f}  (${(ms / 1000).toFixed(1)}s)${r.error ? ' ' + r.error.message : ''}`);
  if (!ok) {
    const lines = out.trim().split('\n');
    const at = lines.findIndex((l) => /Error|❌|not defined/.test(l));
    const from = at < 0 ? Math.max(0, lines.length - 12) : Math.max(0, at - 1);
    console.log('   ↳ ' + lines.slice(from, from + 12).join('\n     '));
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n=== 汇总：${results.length - bad.length}/${results.length} 通过（跳过 ${SKIP.size} 个依赖外部环境的用例）===`);
if (bad.length) console.log('失败：' + bad.map((b) => b.f).join('、'));
process.exit(bad.length ? 1 : 0);
