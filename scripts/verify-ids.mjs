// 核实 ownerQQ / 群号：查机器人账号、好友、群列表、指定群是否存在
import fs from 'node:fs';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const cfg = JSON.parse(fs.readFileSync('D:/dsh/qq-bridge/config.json', 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;
const url = new URL(wsUrl);
url.searchParams.set('access_token', accessToken);

const client = new SnowLumaWebSocketClient({
  url: url.toString(), accessToken, webSocket: globalThis.WebSocket, requestTimeoutMs: 10000,
});
await client.connect();
console.log('已连接 OneBot ✅\n');

const info = await client.getLoginInfo();
console.log('机器人账号 :', info.user_id, '/', info.nickname);

const friends = await client.getFriendList();
console.log('好友数     :', friends.length);
for (const f of friends) console.log(`   ${f.user_id}  ${f.nickname}${f.remark ? ' (备注:' + f.remark + ')' : ''}`);

const groups = await client.getGroupList();
console.log('\n机器人所在群 :', groups.length);
for (const g of groups) console.log(`   ${g.group_id}  ${g.group_name}  ${g.member_count}人`);

// 指定群号逐一核实
const want = [123456789, 200000010];
console.log('\n指定群号核实：');
for (const gid of want) {
  const known = groups.find((g) => String(g.group_id) === String(gid));
  if (known) {
    console.log(`   ${gid} ✅ 机器人在这个群（${known.group_name}，${known.member_count}人）`);
  } else {
    try {
      const gi = await client.getGroupInfo(gid);
      console.log(`   ${gid} ⚠️ 不在列表里，但接口能查到：`, JSON.stringify(gi).slice(0, 200));
    } catch (e) {
      console.log(`   ${gid} ❌ 查不到 / 机器人不在这个群（${e.message}）`);
    }
  }
}

// 群成员里找主号
console.log('\n主号 100000001 相关：');
const isFriend = friends.some((f) => String(f.user_id) === '100000001');
console.log('   是机器人好友吗 :', isFriend ? '是' : '否');
for (const g of groups) {
  try {
    const members = await client.getGroupMemberList(g.group_id);
    const hit = members.find((m) => String(m.user_id) === '100000001');
    console.log(`   在群 ${g.group_id}(${g.group_name}) 里 : ${hit ? '是，昵称/名片=' + (hit.card || hit.nickname) : '否'}`);
  } catch (e) {
    console.log(`   群 ${g.group_id} 成员查询失败: ${e.message}`);
  }
}

try { client.close?.(); } catch {}
process.exit(0);
