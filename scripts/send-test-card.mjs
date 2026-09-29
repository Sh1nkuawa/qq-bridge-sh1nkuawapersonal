// 发一张卡图到指定群，验证网关发图链路（用本地文件的 base64，兼容性最好）
import fs from 'node:fs';
import path from 'node:path';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const GROUP_ID = Number(process.env.QQ_GROUP) || 123456789;
const CARD = 'D:/dsh/sts2-emoji/cards_en_png/ACROBATICS.png';

const cfg = JSON.parse(fs.readFileSync('D:/dsh/qq-bridge/config.json', 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;
const url = new URL(wsUrl);
url.searchParams.set('access_token', accessToken);

const client = new SnowLumaWebSocketClient({
  url: url.toString(), accessToken, webSocket: globalThis.WebSocket, requestTimeoutMs: 20000,
});
await client.connect();
console.log('已连接 OneBot ✅');

const info = await client.getLoginInfo();
console.log('发送账号:', info.user_id, '/', info.nickname);

const buf = fs.readFileSync(CARD);
const b64 = `base64://${buf.toString('base64')}`;
console.log(`卡图: ${path.basename(CARD)}  ${(buf.length / 1024).toFixed(1)} KB`);

// OneBot v11：send_group_msg，message 为数组段
const res = await client.sendGroupMessage(GROUP_ID, [{ type: 'image', data: { file: b64 } }]);
console.log('\n[发送结果]');
console.log(JSON.stringify(res, null, 2).slice(0, 500));

try { client.close?.(); } catch {}
process.exit(0);
