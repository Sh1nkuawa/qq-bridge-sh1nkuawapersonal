// B 站字幕：清洗 / 时间桶抽样 / 分层精编 / 分页 的离线回归（不联网）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSubtitleBrief, buildTimestampedScript, cleanCueContent, fetchSubtitle,
  formatMmSs, pageSubtitle, parseSubtitleBody, plainText, sampleByTimeBuckets, subtitleCachePath
} from '../src/bili-subtitle.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const okAsync = async (name, fn) => { await fn(); n++; console.log(`  ✅ ${name}`); };

/** 造 n 条 cue，覆盖 totalSec 秒 */
function makeCues(n, totalSec, textLen = 30) {
  const cues = [];
  for (let i = 0; i < n; i += 1) {
    const from = (totalSec * i) / n;
    cues.push({ from, to: from + totalSec / n, content: `第${i}句` + '字'.repeat(Math.max(0, textLen - 3)) });
  }
  return cues;
}

console.log('清洗与格式化：');

ok('cleanCueContent：去 HTML / 赘词短语 / 语气词 / 叠标点', () => {
  assert.equal(cleanCueContent('<b>你好</b>世界'), '你好 世界');
  assert.equal(cleanCueContent('这个，然后我们，其实就这样'), '这个，我们，就这样');
  assert.equal(cleanCueContent('嗯，今天天气不错'), '今天天气不错');
  assert.equal(cleanCueContent('真的吗？？？'), '真的吗？');
  assert.equal(cleanCueContent(''), '');
  assert.equal(cleanCueContent(null), '');
});

ok('formatMmSs：跨小时也能看懂', () => {
  assert.equal(formatMmSs(0), '0:00');
  assert.equal(formatMmSs(9), '0:09');
  assert.equal(formatMmSs(65), '1:05');
  assert.equal(formatMmSs(2620), '43:40');
  assert.equal(formatMmSs(3600), '1:00:00');
  assert.equal(formatMmSs(5400), '1:30:00');
});

ok('parseSubtitleBody：真实字幕 JSON 形状', () => {
  const json = JSON.stringify({ body: [
    { from: 0, to: 2.5, content: '开场白' },
    { from: 2.5, to: 5, content: '<i>带标签</i>' },
    { from: 5, content: '缺 to 字段' },
    { from: 6, to: 7, content: '   ' }
  ] });
  const cues = parseSubtitleBody(json);
  assert.equal(cues.length, 3, '空内容那条要被丢掉');
  assert.equal(cues[1].content, '带标签');
  assert.equal(cues[2].to, 5, 'To 缺失时回落成 from');
  assert.deepEqual(parseSubtitleBody('不是 json'), []);
  assert.deepEqual(parseSubtitleBody('{}'), []);
});

console.log('\n时间桶抽样（长字幕适配的核心）：');

ok('短稿不抽样，原样返回', () => {
  const cues = makeCues(10, 20, 10);
  const r = sampleByTimeBuckets(cues, 100000);
  assert.equal(r.sampled, false);
  assert.equal(r.text, buildTimestampedScript(cues));
});

ok('★长稿抽样：覆盖全片前中后段，且不超预算', () => {
  const cues = makeCues(1200, 2400, 40);       // 2400 秒、1200 条、每句 40 字
  const full = buildTimestampedScript(cues);
  assert.ok(full.length > 20000, '这稿要足够长才有意义');
  const r = sampleByTimeBuckets(cues, 2500);
  assert.equal(r.sampled, true);
  assert.ok(r.text.length <= 2500, `抽样稿必须守住预算，实际 ${r.text.length}`);
  assert.ok(r.buckets >= 6, `桶数至少 6，实际 ${r.buckets}`);
  // 前中后都要有：开头、约一半、结尾的时间戳都该出现
  const hasNear = (sec, tol = 260) => {
    const re = /\[(\d+):(\d+)\]/g;
    let m;
    while ((m = re.exec(r.text))) {
      const t = Number(m[1]) * 60 + Number(m[2]);
      if (Math.abs(t - sec) <= tol) return true;
    }
    return false;
  };
  assert.ok(hasNear(0, 60), '要有开头段');
  assert.ok(hasNear(1200), '要有中段');
  assert.ok(hasNear(2400, 120), '要有结尾段');
});

ok('没有时间轴时退化为截断（不崩）', () => {
  const cues = [{ from: 0, to: 0, content: 'x'.repeat(5000) }];
  const r = sampleByTimeBuckets(cues, 100);
  assert.equal(r.sampled, true);
  assert.ok(r.text.length <= 100);
});

console.log('\n分层精编：');

ok('短字幕 → raw（原文，无抽样声明）', () => {
  const s = { bvid: 'BV1x', title: '标题', duration: 300, cues: makeCues(30, 300, 20) };
  const b = buildSubtitleBrief(s, { injectMaxChars: 2500 });
  assert.equal(b.mode, 'raw');
  assert.ok(b.text.includes('[字幕全文]'));
  assert.ok(!b.text.includes('代表性抽样'), '原文稿不该出现抽样声明');
});

ok('★中等字幕 → sampled，且必须声明"这是全片代表性抽样"', () => {
  const s = { bvid: 'BV1y', title: '标题', duration: 1200, cues: makeCues(600, 1200, 40) };
  const b = buildSubtitleBrief(s, { injectMaxChars: 2500, outlineThreshold: 100000 });
  assert.equal(b.mode, 'sampled');
  assert.ok(b.text.includes('代表性抽样'), '★ 必须声明，否则模型会把亮点全堆在开头');
  assert.ok(/不要都集中在开头|分布在全片/.test(b.text));
  assert.ok(b.buckets >= 6);
});

ok('★超长字幕 → outline，且总长（含骨架）守住 injectMaxChars', () => {
  const s = { bvid: 'BV1z', title: '超长视频', duration: 5400, cues: makeCues(3000, 5400, 40) };
  const b = buildSubtitleBrief(s, { injectMaxChars: 2500, outlineThreshold: 12000 });
  assert.equal(b.mode, 'outline');
  assert.ok(b.text.includes('骨架'));
  // owner 的口径（2026-10-15）：不需要精确分页，只要总结前后一致 ⇒ 提示里明说“不必逐句精确”，
  // 且不许承诺“按时间取片段”，也不许出现尚未注册的工具名
  assert.ok(b.text.includes('不必逐句精确'), '要按 owner 口径说明“不必精确”');
  assert.ok(!/按时间取任意片段/.test(b.text), '不再承诺精确分页');
  assert.ok(!/qq_bili_subtitle/.test(b.text), '★ 工具还没注册前，提示里不能出现它的名字');
  assert.ok(b.text.includes('[开头]') && b.text.includes('[结尾]') && b.text.includes('[全片抽样]'));
  // ★ 这里钉住实测踩到的 bug：不把骨架算进预算时，预算 2500 会返回 3642 字
  assert.ok(b.text.length <= 2560, `骨架+抽样必须守住预算，实际 ${b.text.length}`);
  assert.ok(b.usedChars <= 2500, `usedChars 也要守预算，实际 ${b.usedChars}`);
});

console.log('\n分页与缓存：');

ok('pageSubtitle：按时间取一段，并给出 nextFromSec', () => {
  const cues = makeCues(600, 1200, 40);
  const p = pageSubtitle({ bvid: 'BV1', cues }, { fromSec: 600, maxChars: 900 });
  assert.ok(p.text.length <= 900);
  // 会包含"跨过起点的那一条"（[9:58] 那句的 to 正好是 10:00），所以允许略早于 600s
  const m0 = p.text.match(/^\[(?:(\d+):)?(\d+):(\d+)\]/);
  const firstT = m0 ? (Number(m0[1] ?? 0) * 3600 + Number(m0[2]) * 60 + Number(m0[3])) : -1;
  assert.ok(firstT <= 600 && firstT >= 560, `应从 10:00 附近开始（含跨界条），实际 ${p.text.slice(0, 14)}`);
  assert.ok(p.nextFromSec > 600 && p.nextFromSec <= 1200);
  assert.equal(p.totalChars, plainText(cues).length);
  const head = pageSubtitle({ bvid: 'BV1', cues }, { fromSec: 0, maxChars: 100 });
  assert.ok(head.returnedChars <= 100);
});

ok('subtitleCachePath：分 P 各自一个文件', () => {
  assert.equal(subtitleCachePath('C:/x', 'BV1abc', 1), path.join('C:/x', 'BV1abc.json'));
  assert.equal(subtitleCachePath('C:/x', 'BV1abc', 3), path.join('C:/x', 'BV1abc-p3.json'));
});

await okAsync('fetchSubtitle：bvid 不合法 / 未登录 都能安全返回（不发网络请求）', async () => {
  const r1 = await fetchSubtitle('not-a-bvid', { auth: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'bad-bvid');
  const r2 = await fetchSubtitle('BV1Cgpd6pEBR', { auth: { status: async () => ({ loggedIn: false }) }, cacheDir: 'C:/tmp-none' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'no-login');
});

console.log('\n出处与接线：');

ok('事故复盘守卫：412 要说清原因、提示要覆盖 b23.tv 短链', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const link = fs.readFileSync(path.join(root, 'src', 'link-bilibili.js'), 'utf8');
  // 2026-10-15 事故：代理把 B 站流量走国外节点 → B 站回 -412 request was banned，
  // 当时只报"接口返回不是 JSON"，模型只好去搜第三方；现在必须给出可操作的原因。
  assert.match(link, /'-412'/, '要单独识别 -412 风控');
  assert.match(link, /request was banned/, '要把 B 站的原话带上');
  assert.match(link, /DIRECT/, '要给出"让 B 站走直连"的处置建议');
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /短链（b23\.tv/, '提示里要点名短链也算 B 站');
  // ★ 2026-10-15 事故：b23.tv 短链里没有 BV，字幕 provider 只收到 URL 就判 bad-bvid
  //（元信息明明已经解析出真 BV）。现在 summarizeBilibili 要把 bvid 一起返回，预取要优先用它。
  assert.match(link, /bvid: String\(json\.data\?\.bvid/, 'summarizeBilibili 必须把解析出的 BV 一起返回');
  assert.match(bridge, /biliSubtitleProvider\(r\.bvid \|\| url\)/, '预取要优先把真 BV 传给字幕 provider');
  assert.match(bridge, /如实说读不到/, '读不到时要如实说，而不是去试第三方');
});

ok('源码守卫：借鉴出处署名 + 桥接接线都在', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const mod = fs.readFileSync(path.join(root, 'src', 'bili-subtitle.js'), 'utf8');
  assert.match(mod, /SmartNote/, '必须写明借鉴来源');
  assert.match(mod, /wbi\/v2/, '主路径要用 wbi/v2');
  assert.match(mod, /need_login_subtitle/, '要能识别"该字幕需登录"');
  assert.match(mod, /ai-zh|ai_status/, '要优先 AI 中文字幕');
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /biliSubtitleProvider/, 'bridge 要注册字幕 provider');
  assert.match(bridge, /fetchSubtitle\(/, 'bridge 要调用抓取');
  assert.match(bridge, /bili-subs/, '缓存要落在 state/bili-subs');
});

console.log(`\n全部通过：${n} 项断言组`);
