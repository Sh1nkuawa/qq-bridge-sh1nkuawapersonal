// 直接探测各搜索引擎的可用性（不经 MCP）
import { safeFetch } from '../src/safe-fetch.js';

const q = '杀戮尖塔2 新卡';
const targets = [
  ['bing-rss', `https://cn.bing.com/search?format=rss&q=${encodeURIComponent(q)}`],
  ['bing-html', `https://cn.bing.com/search?q=${encodeURIComponent(q)}`],
  ['ddg-html', `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`],
  ['ddg-lite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`],
  ['mojeek', `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`],
];

for (const [name, url] of targets) {
  try {
    const r = await safeFetch(url, 512000);
    const body = String(r.body ?? '');
    const isRss = /<rss|<feed|<item\b/i.test(body);
    const itemCount = (body.match(/<item\b/gi) || []).length;
    const bAlgo = (body.match(/b_algo/gi) || []).length;
    const resultLink = (body.match(/result__a/gi) || []).length;
    const ddgLink = (body.match(/result-link/gi) || []).length;
    console.log(`\n[${name}] HTTP ${r.statusCode}  长度 ${body.length}`);
    console.log(`   RSS=<item> ${itemCount} 个 | b_algo ${bAlgo} 个 | ddg result__a ${resultLink} 个 | ddg lite ${ddgLink} 个`);
    console.log('   前 200 字符:', body.slice(0, 200).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`\n[${name}] 失败: ${e.message}`);
  }
}
