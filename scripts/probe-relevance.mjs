// 诊断：为什么搜索结果不相关
import { safeFetch } from '../src/safe-fetch.js';

const q = '杀戮尖塔2 新卡';
const variants = [
  ['cn.bing.com RSS', `https://cn.bing.com/search?format=rss&q=${encodeURIComponent(q)}`],
  ['www.bing.com RSS', `https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}`],
  ['cn.bing.com HTML', `https://cn.bing.com/search?q=${encodeURIComponent(q)}`],
];

for (const [name, url] of variants) {
  try {
    const r = await safeFetch(url, 512000);
    const b = String(r.body ?? '');
    console.log(`\n${'='.repeat(60)}\n[${name}] HTTP ${r.statusCode} 长度 ${b.length}`);
    if (/<item/i.test(b)) {
      const items = b.split(/<item\b/i).slice(1, 4);
      for (const it of items) {
        const t = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const l = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
        console.log('  - 标题:', t.replace(/<!\[CDATA\[|\]\]>/g, '').trim().slice(0, 70));
        console.log('    URL :', l.trim().slice(0, 90));
      }
    } else {
      const titles = [...b.matchAll(/<h2[^>]*>([\s\S]{4,150}?)<\/h2>/gi)].slice(0, 5)
        .map((m) => m[1].replace(/<[^>]*>/g, '').trim());
      console.log('  h2 标题:', titles);
      const qs = [...b.matchAll(/q=([^"&]{4,60})/gi)].slice(0, 4).map((m) => decodeURIComponent(m[1]));
      console.log('  页面里出现的查询串:', qs);
    }
  } catch (e) {
    console.log(`\n[${name}] 失败: ${e.message}`);
  }
}
