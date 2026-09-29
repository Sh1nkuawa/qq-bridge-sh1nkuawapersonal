// 本地表情包链路自检（不依赖桥接进程）。
//
// 用法：
//   node scripts/meme-flow-test.mjs                       # 离线自检：载入图库/抽样/找图/读字节
//   node scripts/meme-flow-test.mjs --send private:100000001 [tag]
//                                                        # 真发一张到指定会话（走 OneBot HTTP）
//
// 说明：--send 用的是与桥接 sendMemeV2 相同的图片段格式（base64:// + image 段），
// 用来验证“图库能选到图 + QQ 能把本地图发出去”。桥接自己的 HTTP 路由（限频/白名单/
// 记录）需要桥接运行时才能测，控制台里有「检测图库 / 发一张试试」按钮。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeMemeConfig,
  defaultPackDirs,
  scanMemePacks,
  buildMemeCatalog,
  sampleMemes,
  findMeme,
  loadMemeStats,
  emptyMemeStats,
  MEME_MOODS
} from '../src/meme-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function mimeOf(filePath, buf) {
  const ext = path.extname(filePath).toLowerCase();
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return `未知(${ext || '无扩展名'})`;
}

const args = process.argv.slice(2);
const sendIdx = args.indexOf('--send');
const sendKey = sendIdx >= 0 ? String(args[sendIdx + 1] ?? '').trim() : '';
const tag = String(args.find((a) => !a.startsWith('--') && a !== sendKey) ?? 'happy').trim() || 'happy';

const cfg = readJson(path.join(ROOT, 'config.json'));
const mc = mergeMemeConfig(cfg.socialV2?.memes);
console.log('== 配置 ==');
console.log(JSON.stringify({
  enabled: mc.enabled,
  packDirs: mc.packDirs.length ? mc.packDirs : '(自动探测)',
  packs: mc.packs.length ? mc.packs : '(全部)',
  promptMaxMemes: mc.promptMaxMemes,
  maxPerMinute: mc.maxPerMinute,
  maxPerHour: mc.maxPerHour,
  recentAvoid: mc.recentAvoid
}, null, 2));

const dirs = mc.packDirs.length ? mc.packDirs : defaultPackDirs();
console.log('\n== 图库 ==');
console.log('根目录:', dirs.join(' | ') || '(无)');
const packs = scanMemePacks(dirs, { allowIds: mc.packs });
console.log('pack:', packs.map((p) => `${p.id}=${p.rows.length}(${p.source})`).join(' ') || '(无)');
const catalog = buildMemeCatalog(packs, mc);
console.log('可用图片总数:', catalog.length);
const moodCounts = {};
for (const m of catalog) moodCounts[m.mood || '?'] = (moodCounts[m.mood || '?'] || 0) + 1;
console.log('情绪分布:', JSON.stringify(moodCounts));
if (!catalog.length) { console.error('\n❌ 图库为空，无法继续'); process.exit(1); }

console.log(`\n== 抽样 tag=${tag} ==`);
const statsFile = path.join(ROOT, 'state', 'memes.json');
const stats = fs.existsSync(statsFile) ? loadMemeStats(statsFile) : emptyMemeStats();
const sampled = sampleMemes(catalog, { tag, query: args.includes('--query') ? args[args.indexOf('--query') + 1] : '', limit: 5, stats });
console.log('情绪解析:', sampled.mood || '(失败)', '| 该情绪池:', sampled.total);
if (!sampled.mood || !sampled.memes.length) { console.error('❌ 抽样失败'); process.exit(1); }
for (const [i, m] of sampled.memes.entries()) {
  console.log(`  ${i + 1}. ${m.id} | [${m.tag}] ${m.caption} | ${(m.size / 1024).toFixed(0)}KB`);
}

// 逐张校验：能按 id 找回来、文件可读、字节像图片
let bad = 0;
for (const m of sampled.memes) {
  const back = findMeme(catalog, m.id);
  const buf = back ? fs.readFileSync(back.abs) : Buffer.alloc(0);
  const mime = buf.length ? mimeOf(back.abs, buf) : '空';
  const okFlag = Boolean(back) && buf.length > 0 && mime.startsWith('image/');
  if (!okFlag) bad++;
  console.log(`  ${okFlag ? '✓' : '✗'} ${m.id} → ${mime}, ${buf.length} 字节`);
}
if (bad) { console.error(`❌ 有 ${bad} 张校验失败`); process.exit(1); }
console.log('✅ 图库 / 抽样 / 定位 / 字节读取全部正常');

if (!sendKey) {
  console.log('\n（未传 --send，跳过真实发送。要真发一张：node scripts/meme-flow-test.mjs --send private:<QQ> happy）');
  process.exit(0);
}

// 真实发送：与桥接 sendMemeV2 相同的图片段格式
const pick = sampled.memes[0];
const buf = fs.readFileSync(pick.abs);
const m = /^(group|private):(\d+)$/.exec(sendKey);
if (!m) { console.error(`❌ key 格式应为 group:群号 或 private:QQ号，收到：${sendKey}`); process.exit(1); }
const isPrivate = m[1] === 'private';
const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.httpToken || cfg.snowluma?.accessToken || '';
const params = isPrivate
  ? { user_id: Number(m[2]), message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }] }
  : { group_id: Number(m[2]), message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }] };
console.log(`\n== 真实发送 → ${sendKey} ==`);
console.log(`选用：${pick.id}（${pick.caption}），${(buf.length / 1024).toFixed(0)}KB`);
const res = await fetch(`${httpUrl}/${isPrivate ? 'send_private_msg' : 'send_group_msg'}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(params),
  signal: AbortSignal.timeout(60000)
});
const body = await res.json().catch(() => ({}));
if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
  console.error(`❌ 发送失败：HTTP ${res.status} ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`✅ 已发送，message_id=${body.data?.message_id}`);
