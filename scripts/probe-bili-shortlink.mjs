// 复现 + 验证：群里那条 B 站短链现在能不能抓（这是本次事故的核心）
import { summarizeBilibili } from '../src/link-bilibili.js';
import { isFakeIpPool, isPrivateIp } from '../src/safe-fetch.js';

console.log('=== fake-ip 判定 ===');
for (const ip of ['198.18.0.1', '198.18.255.254', '198.19.0.1', '198.17.0.1', '10.0.0.1', '127.0.0.1', '1.1.1.1']) {
  console.log(`  ${ip.padEnd(16)} isFakeIpPool=${String(isFakeIpPool(ip)).padEnd(5)} isPrivateIp=${isPrivateIp(ip)}`);
}

console.log('\n=== 真实的短链（事故里那条）===');
const url = process.argv[2] || 'https://b23.tv/PCLm5xV';
const r = await summarizeBilibili(url, { timeoutMs: 15000, descChars: 400 });
console.log(`  ok=${r.ok}` + (r.ok ? '' : `  reason=${r.reason}`));
if (r.ok) {
  console.log('  —— 预取到的文本 ——');
  console.log(r.text.split('\n').map((l) => '  │ ' + l).join('\n'));
}

console.log('\n=== 对照：普通 B 站长链 ===');
const r2 = await summarizeBilibili('https://www.bilibili.com/video/BV1Cgpd6pEBR', { timeoutMs: 15000, descChars: 200 });
console.log(`  ok=${r2.ok}` + (r2.ok ? '  （长链正常 ✓）' : `  reason=${r2.reason}`));
