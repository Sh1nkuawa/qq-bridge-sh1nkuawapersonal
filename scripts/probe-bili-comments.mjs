// 探测 B 站评论接口：哪些在"登录态 + DoH 直连"下可用
import { createBiliAuth } from '../src/bili-auth.js';
import { createBiliFetch } from '../src/bili-direct.js';

const biliFetch = createBiliFetch({ log: () => {} });
const auth = createBiliAuth({ stateFile: 'D:/dsh/qq-bridge/state/bili-auth.json', log: () => {}, fetchImpl: biliFetch });

const BVID = 'BV1KZ3x6SEBb';   // 诸葛亮五虎上将那条（91 秒，字幕 587 字）

async function getJson(path) {
  const r = await auth.request(`https://api.bilibili.com${path}`, {
    headers: { Referer: `https://www.bilibili.com/video/${BVID}/`, Origin: 'https://www.bilibili.com' }
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, j, text };
}

// 先拿 aid
const view = await getJson(`/x/web-interface/view?bvid=${BVID}`);
const aid = view.j?.data?.aid;
console.log(`视频: ${view.j?.data?.title ?? '?'}`);
console.log(`aid: ${aid}  （评论接口要 oid=aid）\n`);

const TRIES = [
  ['旧版热评 v2/reply?sort=2', `/x/v2/reply?type=1&oid=${aid}&sort=2&ps=10&pn=1`],
  ['旧版热评 v2/reply?sort=1(按时间)', `/x/v2/reply?type=1&oid=${aid}&sort=1&ps=10&pn=1`],
  ['新版主评论 v2/reply/main', `/x/v2/reply/main?oid=${aid}&type=1&mode=3&next=0&ps=10`],
  ['新版主评论 v2/reply/wbi/main(不签名)', `/x/v2/reply/wbi/main?oid=${aid}&type=1&mode=3&next=0&ps=10&plat=1`]
];

for (const [label, path] of TRIES) {
  try {
    const { status, j } = await getJson(path);
    if (!j) { console.log(`  ✗ ${label} → HTTP ${status} 非 JSON`); continue; }
    const code = j.code;
    // 旧版：data.replies[]；新版：data.replies[] / data.top_replies[]
    const list = j.data?.replies ?? j.data?.top_replies ?? [];
    const plain = (list[0]?.content?.message ?? '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`  ${code === 0 ? '✓' : '✗'} ${label}`);
    console.log(`      code=${code} ${j.message ?? ''} 条数=${list.length}  ${list[0] ? `首条「${plain}」(赞${list[0].like ?? '?'})` : ''}`);
    if (code === 0 && list.length) {
      console.log('      → 可用字段样例: ' + JSON.stringify({
        rpid: list[0].rpid, like: list[0].like, rcount: list[0].rcount,
        uname: list[0].member?.uname, mid: list[0].member?.mid,
        ctime: list[0].ctime, text: plain
      }));
    }
  } catch (e) {
    console.log(`  ✗ ${label} → 异常 ${String(e.message).slice(0, 60)}`);
  }
  await new Promise((r) => setTimeout(r, 600));
}
