// 按核实过的号写入两个项目的白名单配置
import fs from 'node:fs';

const OWNER_QQ = Number(process.env.OWNER_QQ) || 100000001;
const GROUP_ID = Number(process.env.QQ_GROUP) || 123456789;

// ---- 1) qq-bridge ----
const bPath = 'D:/dsh/qq-bridge/config.json';
const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
b.ownerQQ = OWNER_QQ;
b.allow.groups = [GROUP_ID];
b.allow.private = [];
// 保持 fail-closed：白名单非空时才放行
b.allowAllWhenEmpty = false;
fs.writeFileSync(bPath, JSON.stringify(b, null, 2) + '\n', 'utf8');
console.log('[qq-bridge] 已写入');
console.log('   ownerQQ        =', b.ownerQQ);
console.log('   allow.groups   =', JSON.stringify(b.allow.groups));
console.log('   allowAllWhenEmpty =', b.allowAllWhenEmpty);
console.log('   snowluma.wsUrl =', b.snowluma.wsUrl);
console.log('   snowluma.accessToken =', b.snowluma.accessToken ? `已配置(${b.snowluma.accessToken.length}位)` : '(空)');

// ---- 2) 卡牌表情包机器人 ----
const cPath = 'D:/dsh/sts2-emoji/bot/config.json';
const c = JSON.parse(fs.readFileSync(cPath, 'utf8'));
c.groups = [GROUP_ID];
c.prefix = c.prefix ?? '';            // 保持原样，不擅自改动触发方式
fs.writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n', 'utf8');
console.log('\n[sts2-emoji/bot] 已写入');
console.log('   groups   =', JSON.stringify(c.groups));
console.log('   prefix   =', JSON.stringify(c.prefix), c.prefix ? '' : '(空 = 直接打卡名即出图)');
console.log('   exact    =', c.exact);
console.log('   card_dir =', c.card_dir);
