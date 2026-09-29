// 测不同 UA / 请求头下各引擎能否返回结果
import { safeFetch } from '../src/safe-fetch.js';

const q = '杀戮尖塔2 新卡';
const eq = encodeURIComponent(q);

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cases = [
  ['bing-rss +桌面上网UA', `https://cn.bing.com/search?format=rss&q=${eq}`, { 'user-agent': UA_DESKTOP, accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' }],
  ['bing-html +桌面上网UA', `https://cn.bing.com/search?q=${eq}`, { 'user-agent': UA_DESKTOP, accept: 'text/html,application/xhtml+xml' }],
  ['baidu', `https://www.baidu.com/s?wd=${eq}`, { 'user-agent': UA_DESKTOP }],
  ['sogou', `https://www.sogou.com/web?query=${eq}`, { 'user-agent': UA_DESKTOP }],
  ['so360', `https://www.so.com/s?q=${eq}`, { 'user-agent': UA_DESKTOP }],
];

for (const [name, url, headers] of cases) {
  try {
    const r = await safeFetch(url, 512000, { headers });
    const b = String(r.body ?? '');
    console.log(`\n[${name}] HTTP ${r.statusCode} 长度 ${b.length}`);
    console.log(`   item ${(b.match(/<item\b/gi) || []).length} | b_algo ${(b.match(/b_algo/gi) || []).length} | baidu结果 ${(b.match(/result c-container/gi) || []).length} | h3 ${(b.match(/<h3/gi) || []).length}`);
    // 找几条可见标题
    const titles = [...b.matchAll(/<h[23][^>]*>([\s\S]{4,120}?)<\/h[23]>/gi)].slice(0, 4).map((m) => m[1].replace(/<[^>]*>/g, '').trim());
    if (titles.length) console.log('   标题样例:', titles.slice(0, 4));
    else console.log('   前 160:', b.slice(0, 160).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`\n[${name}] 失败: ${e.message}`);
  }
}
