// 只读：列出 SnowLuma 支持的群相关动作，确认有没有"转让群主"之类的接口。
import fs from 'node:fs';

const t = fs.readFileSync('D:/dsh/snowluma/config-CEQwQxHY.js', 'utf8');
const names = [...t.matchAll(/name:\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(names)];
const groups = uniq.filter((n) => /group/.test(n));
console.log(`与群相关的动作（共 ${groups.length}）：`);
console.log(groups.join('\n'));
console.log('\n含 owner/transfer 的动作:', uniq.filter((n) => /owner|transfer/.test(n)).join(', ') || '(无)');
console.log('撤回/文件/相册相关:', uniq.filter((n) => /delete_msg|file|album|photo/.test(n)).join(', ') || '(无)');
