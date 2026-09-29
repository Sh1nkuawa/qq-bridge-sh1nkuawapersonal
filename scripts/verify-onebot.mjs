// 用官方 SDK 通过 OneBot WebSocket 验证：登录的是哪个号、群列表、能否发消息（只读调用，不发送）
import fs from 'node:fs';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const cfg = JSON.parse(fs.readFileSync('D:/dsh/qq-bridge/config.json', 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;

console.log('wsUrl =', wsUrl, ' token =', accessToken ? `已配置(长度 ${accessToken.length})` : '空');

// 带上 token：先试 query 参数（OneBot 通用做法）
const url = new URL(wsUrl);
url.searchParams.set('access_token', accessToken);

const client = new SnowLumaWebSocketClient({
  url: url.toString(),
  accessToken,
  webSocket: globalThis.WebSocket,
  requestTimeoutMs: 10000,
});

try {
  await client.connect();
  console.log('[ws] 已连接 ✅');
} catch (e) {
  console.error('[ws] 连接失败:', e.message);
  process.exit(1);
}

async function call(name, fn) {
  try {
    const r = await fn();
    console.log(`\n[${name}]`);
    console.log(JSON.stringify(r, null, 2).slice(0, 700));
    return r;
  } catch (e) {
    console.log(`\n[${name}] 失败: ${e.message}`);
    return null;
  }
}

await call('get_login_info', () => client.getLoginInfo());
await call('get_group_list', () => client.getGroupList());
await call('get_friend_list', () => client.getFriendList());
await call('get_status', () => client.getStatus());

try { client.close?.(); } catch {}
process.exit(0);
