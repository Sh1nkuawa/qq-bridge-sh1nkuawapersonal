// 真机探针：① 登录态 ② 滑动续期有没有发生 ③ 字幕接口真实返回形状
import fs from 'node:fs';
import path from 'node:path';
import { createBiliAuth } from '../src/bili-auth.js';

const ROOT = 'D:/dsh/qq-bridge';
const auth = createBiliAuth({ stateFile: path.join(ROOT, 'state', 'bili-auth.json'), log: (m) => console.log('  ' + m) });

const before = auth._jar().SESSDATA;
console.log('=== ① 登录态 ===');
console.log('  落盘里的 SESSDATA 过期时间：' + (before?.exp ? new Date(before.exp).toLocaleString() : '(无)'));
const st = await auth.status({ force: true });
console.log(`  nav：loggedIn=${st.loggedIn} code=${st.code} uname=${st.uname} mid=${st.mid}`);
const after = auth._jar().SESSDATA;
console.log('  滑动续期：' + (after && before && after.exp !== before.exp
  ? `✓ 发生了（过期时间 ${new Date(before.exp).toLocaleString()} → ${new Date(after.exp).toLocaleString()}）`
  : (after ? '（这次没有续期，值/时间未变）' : '✗ 没有 SESSDATA')));
console.log('  摘要：' + JSON.stringify(auth.summary()));

if (!st.loggedIn) { console.log('\n未登录，后面不用测了'); process.exitCode = 1; }
else {
  console.log('\n=== ② 字幕接口真实形状 ===');
  // 从排行榜挑几个视频（有 CC/AI 字幕的概率高一些）
  let list = [];
  try {
    const r = await auth.request('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all');
    const j = await r.json();
    list = (j.data?.list ?? []).slice(0, 4);
  } catch (e) { console.log('  排行榜失败：' + e.message); }

  for (const v of list) {
    const bvid = v.bvid;
    process.stdout.write(`\n  [${bvid}] ${String(v.title).slice(0, 28)} (${Math.round(v.duration / 60)}分)\n`);
    try {
      const view = await (await auth.request(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)).json();
      const d = view.data;
      if (!d) { console.log('    view 失败 code=' + view.code); continue; }
      let cid = d.cid;
      if (d.pages?.length > 1) {
        const pg = await (await auth.request(`https://api.bilibili.com/x/player/pagelist?aid=${d.aid}&bvid=${bvid}`)).json();
        cid = pg.data?.[0]?.cid ?? cid;
        console.log(`    多P：${d.pages.length} 个分P，取第一个 cid=${cid}`);
      }
      const p = await auth.request(`https://api.bilibili.com/x/player/wbi/v2?aid=${d.aid}&cid=${cid}&bvid=${bvid}`);
      const pj = await p.json();
      const pd = pj.data;
      console.log(`    player/v2  HTTP=${p.status} code=${pj.code} need_login_subtitle=${pd?.need_login_subtitle}`);
      const subs = pd?.subtitle?.subtitles ?? [];
      console.log(`    字幕条数=${subs.length}` + (subs.length ? '：' + subs.map((s) => `${s.lan}(${s.lan_doc}${s.ai_status === 1 ? ',AI' : ''})`).join(' / ') : ''));
      if (subs.length) {
        const pick = subs.find((s) => s.ai_status === 1 && /zh/i.test(s.lan)) ?? subs.find((s) => /zh/i.test(s.lan)) ?? subs[0];
        let url = pick.subtitle_url ?? '';
        if (url.startsWith('//')) url = 'https:' + url;
        else if (url.startsWith('/')) url = 'https://api.bilibili.com' + url;
        const raw = await (await auth.request(url)).text();
        let body = null;
        try { body = JSON.parse(raw); } catch { /* */ }
        const cues = body?.body ?? [];
        const text = cues.map((c) => c.content).join('');
        console.log(`    ★ 选中 ${pick.lan}(${pick.lan_doc})：${cues.length} 条 cue，原始 ${raw.length} 字，正文 ${text.length} 字`);
        if (cues.length) {
          console.log(`      首条：[${Math.floor(cues[0].from / 60)}:${String(Math.floor(cues[0].from % 60)).padStart(2, '0')}] ${String(cues[0].content).slice(0, 60)}`);
          console.log(`      末条：[${Math.floor(cues.at(-1).from / 60)}:${String(Math.floor(cues.at(-1).from % 60)).padStart(2, '0')}] ${String(cues.at(-1).content).slice(0, 60)}`);
        }
        break;   // 拿到一个带字幕的就够了
      }
    } catch (e) { console.log('    异常：' + String(e.message).slice(0, 100)); }
  }
  console.log('\n=== ③ 第三次 nav：再看续期是否持续 ===');
  const afterSave = auth._jar().SESSDATA?.exp;
  await auth.status({ force: true });
  const nowExp = auth._jar().SESSDATA?.exp;
  console.log('  SESSDATA 过期时间：' + (nowExp ? new Date(nowExp).toLocaleString() : '(无)') + (nowExp !== afterSave ? '  ← 又续了 ✓' : '  （未变）'));
  console.log('  落盘文件：' + fs.existsSync(path.join(ROOT, 'state', 'bili-auth.json')));
}
