# AGY 侧能力缺口矩阵（2026-11-25）

> 给 Antigravity 那边的 agent：这是「DSH 模式下模型能做的事」逐条对照「AGY 侧现在能不能做」。
> 三个标记：**✅ 已有** / **🟡 桥接端点有、AGY 缺 CLI（最省力的活儿）** / **🔴 桥接侧也没有（要协商）**。
> 工具名是 DSH 的 MCP 工具名；参数照 `src/mcp-snowluma-safe.js` 里同名工具的定义（那里有 JSON schema + 它调哪个端点）。

---

## 0. 先看三条鉴权规矩（踩过）

1. **调 `/api/agy/*` 只能带 `?token=<console-token>`** —— 千万别带 `x-agent-token`。
   实测：带上就是 **403**（agent 白名单里没有 `/api/agy/`），而你们的 `agy-tools.mjs` 现在正好只带 console token ✓
2. **调 `/api/socialV2/*` 建议两个都带**：`?token=<console-token>` + `x-agent-token: <prompt 里的【会话令牌】>`。
   有些端点在 reserved2 下**强制要 agent token**（下面标 ⚠️ 的），不带给 403。
3. `x-agent-token` 是**每个会话一份**（在 prompt 的【会话令牌】里），重启桥接/换角色会轮换；
   别把它写进日志、也别硬编码。

> 所以别写"一个 wrapper 永远给所有请求加两个 header"——那会把 `/api/agy/*` 打死 ✗。按前缀分。

---

## 1. ✅ 已经能用（不用管）

| 能力 | 现状 |
|---|---|
| 取回合 / 认领 / 续租 / 退回 / 完成 | `/api/agy/wait|claim|touch|requeue|complete` ✓ |
| 发文字（一条/多条，分条发） | `complete.replies[]` ✓ |
| 引用某条消息 | `complete.replyToMessageId` ✓ |
| 看群消息 | prompt 里【本次消息快照】✓（桥接塞的，不用工具） |
| 标已读 | 桥接 `complete` 后自动提交 ✓（别再找 mark_read） |
| 长 prompt | >8KB 自动落盘 + 短提示里给路径 ✓ |
| 记忆（话题/想法/印象） | `agy-tools.mjs memory-list|memory-add` ✓ |
| 发收藏表情 | `agy-tools.mjs sticker` ✓ |
| 自己的声音（日语 TTS） | `agy-tools.mjs voice` ✓（`/api/tts/speak` 不需要 agent token） |
| 联网搜索/抓网页 | Antigravity 自带 ✓ |

---

## 2. 🟡 端点现成、只缺一个 CLI（建议全部补，工作量很小）

### 2.1 行为闭环 —— **这三条最重要，因为 prompt 现在明确要求它做，而它做不到** ✗

| 能力 | 端点 | 为什么重要 |
|---|---|---|
| **设定下次唤醒条件**（潜水 5~120 分钟 / 触发条件） | `POST /api/socialV2/wake-config` `{key, config:{mode,infinite,sleepMs,triggers}, throughSeq?}` | prompt 里【当前唤醒】和"收尾用 mark_read 或 set_wake_config"都在说这个；AGY 做不到 ⇒ **它没法决定"什么时候再被叫醒"，只能被动等桥接按消息唤醒** |
| **回复前短静默**（等对方说完） | `POST /api/socialV2/wait` `{key, purpose:"reply", quietMs:10000}` | prompt 里【首回复节奏】要求；做不到就只能"看到就回"，容易抢话 |
| **沉睡前 5 分钟观察** | `POST /api/socialV2/wait` `{key, timeoutMs:300000}`（默认 purpose=messages） | prompt 里【沉睡前强制等待】是硬要求；现在 AGY 只能跳过 ⇒ 潜水行为不闭环 |

> 这三条补齐后，"潜水/等待/收尾"才算和 DSH 侧等价 ✓。
> `wait` 返回里有 `newMessages` / `quiet` / `preSleepWaitSatisfied` / `preSleepWaitRemainingMs` 等字段，
> 照 `src/mcp-qq-wait.js` 的用法照抄即可。

### 2.2 认人 / 补历史

| 工具 | 端点 | 备注 |
|---|---|---|
| `qq_get_prompt` | `GET /api/socialV2/prompt?key=` | **优先级高**：prompt 里写着"完整角色卡请调用 qq_get_prompt 查看"，AGY 现在**看不到角色卡全文** ✗ |
| `qq_get_message_detail` | `GET /api/socialV2/message-detail?key=&messageId=` | 查某条详情/发送者 |
| `qq_get_active_members` | `GET /api/socialV2/active-members?key=` | @人、认人必需（要 userId） |
| `qq_get_my_recent_messages` | `GET /api/socialV2/my-recent?key=` | 优先级低（桥接现在会把自己发的记进上下文 ✓） |
| `qq_social_state` | `GET /api/socialV2/state?key=` | 低（prompt 里已有状态摘要） |

### 2.3 表达

| 工具 | 端点 | 备注 |
|---|---|---|
| `qq_send_poke`（拍一拍） | `POST /api/socialV2/send-poke` ⚠️ `{key, targetUserId}` | 群聊必传 targetUserId |
| `qq_send_meme`（本地表情包库，141 张） | `GET /api/socialV2/meme-list?key=&tag=&query=&limit=` + `POST /api/socialV2/send-meme` `{key, path}` | 两步：先 list 拿 `path`，再 send；`tag` 支持 happy/angry/sad/shy/confused/daily |
| `qq_list_voices` + `qq_send_voice`（语音库音效） | `GET /api/socialV2/voices?key=` + `POST /api/socialV2/send-voice` ⚠️ `{key, voice}` | 和"自己的声音(TTS)"是两套 |
| `qq_generate_image`（生图） | `POST /api/socialV2/image-request` ⚠️ `{key, token:<agentToken>, prompt}` | 异步 1~4 分钟，桥接会自己发群里并 @ 人；**别催、别重复调** |
| `qq_slang_query` / `qq_slang_submit` | `GET /api/socialV2/slang/query?key=&q=` / `POST /api/socialV2/slang/submit` `{key, content, context}` | 黑话 |
| `qq_report_feedback` | `POST /api/socialV2/feedback` `{key, level, message}` | 卡住时留痕 |

### 2.4 群管理（只有 bot 是管理员时才有意义）

| 工具 | 端点 | 备注 |
|---|---|---|
| `qq_group_admin_info` | `GET /api/socialV2/admin-status?key=` ⚠️ | 先查自己是不是管理员 |
| `qq_request_mute`（提议禁言） | `POST /api/socialV2/mute-request` ⚠️ `{key, userId, reason}` | 桥接会自己核验证据，不足直接拒 |
| `qq_propose_announcement`（公告草稿） | `POST /api/socialV2/announcement/propose` ⚠️ `{key, content}` | 群主私聊「通过」才发 |

### 2.5 图 / 转发 / 视频

| 工具 | 端点 | 备注 |
|---|---|---|
| `qq_get_message_images` | `GET /api/images/message?key=&messageId=` ⚠️ | 返回图片字节；**要落到文件**再让 agent 读（见 §4.1） |
| `qq_get_forward_msg`（合并转发） | `GET /api/socialV2/forward-message?key=&id=` ⚠️ | 返回文本 + 内嵌图片 id |
| `qq_get_sticker_image` | `GET /api/socialV2/sticker-image?key=&stickerId=` | 看某张收藏表情 |
| `qq_get_self_image` | `GET /api/socialV2/self-image` | 看自己形象 |
| `qq_bili_subtitle` | `GET /api/bili/subtitle?bvid=` | 只读 |

---

## 3. 🔴 桥接侧也没有（先登记，不要自己实现）

| 能力 | 现状 | 建议 |
|---|---|---|
| **@某人**（发出去时真正 @ 到人） | `complete` 只有 `replyToMessageId`，没有 `atUserId` ✗ | 桥接加一个字段就行（一行）；要先在 `AGY_CONTRACT.md` §10 登记 |
| **余额查询**（`qq_get_balance`） | 桥接**没有** HTTP 端点：余额是在 MCP 里现算的 | 桥接加 `GET /api/socialV2/balance`，AGY 侧再加 CLI |
| **群列表 / 群成员列表 / 群历史**（`qq_list_groups` / `qq_get_group_members` / `qq_get_group_history`） | 这三个工具**直接打 OneBot**，没有 HTTP 端点 ✗ | 桥接加只读端点（`/api/agy/onebot?action=...` 白名单式） |
| **看图**（多模态） | 端点能拿到字节，但 prompt 里只有 `[图片]` 标记；模型本身看不见图 | 见 §4.1 |

---

## 4. 结构性差距（不是端点，是"能不能做到"）

### 4.1 看图

现在 prompt 里写的是"你这轮看不到图（AGY 侧没有读图通道），不要假装看过"。
**可能不用改桥接就能解决**，值得先试：

1. `GET /api/images/message?key=…&messageId=…`（⚠️ 带 `x-agent-token`）拿字节
2. 存成临时文件（比如 `state/agy-frame-<messageId>.png`，注意**别写进 state 之外**、用完删掉）
3. 用 Antigravity 的文件读取/看图能力打开它

如果 Antigravity 的 agent 能"看"图片文件 → 这条路成立，AGY 侧就能自己补齐看图；
如果只能读文本 → 那必须桥接侧做**图片转述**（把图交给一个视觉模型描述后再塞 prompt），
这条要先在 §10 登记、由桥接侧实现。

### 4.2 长上下文

AGY 每次会话的上下文是有限的。建议：靠 payload 里已经有的短提示 + 落盘文件控制单回合大小，
单回合控制在 3 分钟内、别把整段落盘文件再整个复述一遍。

---

## 5. 建议的动手顺序

1. **wake-config + wait**（§2.1）—— prompt 现在要求但做不到，补齐后"潜水/等待"才闭环
2. **prompt**（§2.2 第一条）—— 让它能看到完整角色卡
3. **message-detail / active-members**（§2.2）—— 认人、@人
4. **meme / poke / 语音库 / 生图**（§2.3）—— 表达方式对齐
5. **管理类**（§2.4）—— 只有 bot 是管理员才有意义
6. 🔴 **三项**（§3）—— 先在 `docs/AGY_CONTRACT.md` §10 登记，等桥接侧加端点

---

## 6. 一个通用 CLI 骨架（省得一条条写）

建议加 `scripts/agy-api.mjs`（**你们的文件**，随便改），一次把 🟡 全部打通：

```js
// 用法示例：
//   node scripts/agy-api.mjs call --key group:123 --session <会话令牌> \
//        --method POST --path /api/socialV2/wake-config --body '{"config":{"mode":"diving","infinite":false,"sleepMs":3600000}}'
//   node scripts/agy-api.mjs get  --key group:123 --session <会话令牌> --path /api/socialV2/prompt
//
// 规矩：/api/agy/* 只带 console token；/api/socialV2/* 两个都带（见 §0）
import fs from 'node:fs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const ROOT = 'D:/dsh/qq-bridge';
const consoleToken = fs.readFileSync(`${ROOT}/state/console-token`, 'utf8').trim();
const sessionToken = arg('session');           // prompt 里的【会话令牌】
const key = arg('key');
const method = (arg('method') ?? 'GET').toUpperCase();
const path = arg('path');
const body = arg('body');

const url = new URL('http://127.0.0.1:3100' + path);
url.searchParams.set('token', consoleToken);
if (key) url.searchParams.set('key', key);

const headers = { 'content-type': 'application/json' };
// 关键：/api/agy/* 带上 x-agent-token 会 403 ✗
if (!path.startsWith('/api/agy/') && sessionToken) headers['x-agent-token'] = sessionToken;

const res = await fetch(url, {
  method,
  headers,
  body: method === 'GET' ? undefined : (body ?? '{}'),
  signal: AbortSignal.timeout(120000)   // 必须有超时，桥接重启会掐断长请求
});
console.log(res.status, await res.text());
process.exitCode = res.ok ? 0 : 1;
```

- `wait` 这类**长请求**用 `AbortSignal.timeout(timeoutMs + 5000)`，别把进程挂死
- 每个子命令都往 `state/agy-worker.log` 记一条（格式见契约 §7），桥接侧靠它排障
- 出错时**别重试写操作**（发消息/生图/禁言），只重试读操作
