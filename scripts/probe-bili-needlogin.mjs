// 同一接口、同一视频：带登录态 vs 匿名 —— 证明"空数组 + need_login_subtitle"是匿名现象
import path from 'node:path';
import { createBiliAuth } from '../src/bili-auth.js';

const BV = 'BV1KZ3x6SEBb';
const auth = createBiliAuth({ stateFile: 'D:/dsh/qq-bridge/state/bili-auth.json', log: () => {} });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 先拿 aid/cid
const view = await (await auth.request(`https://api.bilibili.com/x/web-interface/view?bvid=${BV}`)).json();
const { aid, cid, title } = view.data;
console.log(`视频：${title}（aid=${aid} cid=${cid}）\n`);

const playerUrl = `https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}&bvid=${BV}`;

console.log('=== ① 带桥接登录态（我们预取时走的就是这条）===');
{
  const j = await (await auth.request(playerUrl)).json();
  const d = j.data;
  const subs = d?.subtitle?.subtitles ?? [];
  console.log(`  code=${j.code}  need_login_subtitle=${d?.need_login_subtitle}`);
  console.log(`  字幕数组长度=${subs.length}` + (subs.length ? ` → ${subs.map((s) => s.lan_doc || s.lan).join('/')}` : ''));
}

console.log('\n=== ② 同一条接口，但**不带 cookie**（模型自己 web_fetch 就是这个处境）===');
{
  const r = await fetch(playerUrl, { headers: { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${BV}` } });
  const j = await r.json();
  const d = j.data;
  const subs = d?.subtitle?.subtitles ?? [];
  console.log(`  HTTP ${r.status}  code=${j.code}  need_login_subtitle=${d?.need_login_subtitle}`);
  console.log(`  字幕数组长度=${subs.length}   ← 就是它说的"空数组 + 要求登录" ✓`);
}

console.log('\n=== ③ 桥接缓存里的真实字幕（已经喂给模型的那份）===');
{
  const fs = await import('node:fs');
  const p = `D:/dsh/qq-bridge/state/bili-subs/${BV}.json`;
  if (fs.existsSync(p)) {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log(`  ✓ 《${s.title}》${s.cues.length} 条 cue / 正文 ${s.chars} 字`);
    for (const c of s.cues.slice(0, 6)) console.log(`    [${Math.floor(c.from / 60)}:${String(Math.floor(c.from % 60)).padStart(2, '0')}] ${c.content}`);
  } else console.log('  （没有缓存）');
}
