---
name: qq-bot-operator
description: >-
  操作本地 D:\dsh\qq-bridge 的 AGY 传输层脚本（status / wait-wake / reply-and-wait / touch），
  用于检查按人格分流状态（默认负责猫娘侍从）、领取 QQ 唤醒回合、完整读取落盘上下文、
  发送分条回复或退回重排。当用户要求启动 QQ 值守、测试 AGY 桥接协议或排查 state/agy-worker.log / state/bridge.log 时激活此技能。
---

# QQ Bot Operator（AGY 传输层操作手册）

本技能用于通过 `D:\dsh\qq-bridge\scripts\agy-*.mjs` 与本地 qq-bridge 的 AGY 传输层交互。
协议细节以 `D:\dsh\qq-bridge\docs\AGY_CONTRACT.md` 与 `D:\dsh\qq-bridge\docs\AGY_SIDE_TASKS.md` 为准。

## 核心铁律

1. **一次只处理一个回合**：禁止并发领活；完成（`complete`）或退回（`requeue`）当前回合后再领下一条。
2. **`complete` 之后就结束了**：桥接发完回复会自动按 `readThroughSeq` 标已读，严禁额外补发“已发送”之类的确认消息。
3. **prompt 原样使用 + 落盘必读**：禁止截断或改写 `prompt`；若开头出现 `【长提示词已落盘】` 指向 `D:\dsh\qq-bridge\state\agy-context-<turnId>.md`，**必须先用文件读取工具完整通读该文件后再作答**，严禁猜内容。
4. **完整角色卡必读 + 群消息就在 `【本次消息快照】` 里 + 禁止调用 MCP `qq_*` 工具**：若会话开场未注入完整角色卡，首轮回复前**必须**先跑 `node scripts/agy-api.mjs prompt --key <key> --session <会话令牌>` 读完角色卡再发言；快照已含最新 12 条，若 `partial=true` 且需补读更早消息请用 `unread --after-seq 0 --limit 30` 或 `recent --limit 30`（绝不要交空 `[]` 等下一轮）；联网搜热点用 Antigravity 内置 `search_web`；看图用 `message-images` 落盘后 `read_file` 原生看图，没看图绝不假装看过。
5. **单回合尽量 3 分钟内完成**：长任务每 2~3 分钟用 `agy-touch.mjs` 续租。

---

## 常用命令（Windows PowerShell）

所有命令均在 `D:\dsh\qq-bridge` 下运行（当前默认 AGY 值守人格为 `猫娘侍从`，`小鲸鱼` 分流至 DSH）：

### 1. 检查按人格分流与健康状态

```powershell
node scripts/agy-status.mjs --persona 猫娘侍从
```

重点看：`onDuty`、`dutyTransport`、`personaTransport`、`onDutyWorkerSeenAt`、`onDutyStale`、`degradedUntil`（别只看 `lastWorkerSeenAt`；若 `degradedUntil` 非空说明刚触发了 10 分钟降级保护）。

### 2. 领取一个回合（推荐 `--loop --exit-on-not-on-duty` 零消耗等活）

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
node scripts/agy-wait-wake.mjs --persona 猫娘侍从 --loop --exit-on-not-on-duty --timeout-ms 90000
```

- 加 `--loop --exit-on-not-on-duty` 且**不设 `NotificationTimeoutSeconds`**：群里安静（`204`）时在 Node.js 内静默循环、**不唤醒模型（0 token）**；直到真正收到有原因的唤醒，或切班返回 `IDLE not-on-duty` / `IDLE persona-on-dsh` 时才退出。
- 不加 `--loop` 时：单次超时返回 `IDLE`。
- 返回 `AGY_TURN_META` + `AGY_PROMPT_BEGIN ... END`：已成功 `claim`，原样阅读（若含落盘路径则先完整读 `.md`）。

### 3. 提交回复（推荐 `--batch-stdin` + `@' ... '@` + UTF-8）

PowerShell 命令行参数容易吞双引号，且 Windows PowerShell 5.1 管道默认 ASCII 会把中文变成 `????`，**务必先设无 BOM UTF-8 `$OutputEncoding` 再经 stdin 传入 JSON**：

```powershell
$utf8 = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8; [Console]::OutputEncoding = $utf8
@'
{"turnId":"t-20261125-05-0001","persona":"猫娘侍从","workerId":"agy-猫娘侍从","replies":["第一句","第二句"]}
'@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
```

- **顺手领下一回合**：在命令末尾加 `--wait --timeout-ms 90000`。
- **只看不说**（桥接仍自动标已读）：传 `"replies": []`。
- **引用回复某条消息**：加 `"replyToMessageId": -1234567890`。
- **@ 某位群友**（v1.3，仅作用于第一条回复）：加 `"atUserId": "123456789"`。
- **异常退回队首（立刻退，绝不干等租约）**：发生不可恢复的模型/网络/工具错误时，**不要把半成品发到群里，也不要干等 10 分钟租约**——立刻用 `reason: "tool-error"`（或 `"timeout"`）退回，便于桥接几十秒内降级 10 分钟并由 DSH 补投；成功时绝不要 `requeue`：
  ```powershell
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = $utf8; [Console]::OutputEncoding = $utf8
  @'
  {"turnId":"t-20261125-05-0001","persona":"猫娘侍从","workerId":"agy-猫娘侍从","requeue":true,"reason":"tool-error","note":"原因说明"}
  '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
  ```

### 4. 行为闭环、完整角色卡、看图与表达（`scripts/agy-api.mjs`）

所有 `/api/socialV2/*` 与 `/api/images/*` 端点统一走 `scripts/agy-api.mjs`（自动区分鉴权前缀：`/api/agy/*` 只带 console token；`/api/socialV2/*` 双带 console token 与 `--session` 会话令牌）：

```powershell
# 补读更早未读（v1.4 快照已含最新 12 条，补读 skippedOlder 请用 --after-seq 0 或 recent）/ 查网关状态
node scripts/agy-api.mjs unread --key group:541026885 --session <会话令牌> --after-seq 0 --limit 30
node scripts/agy-api.mjs recent --key group:541026885 --session <会话令牌> --limit 30
node scripts/agy-api.mjs status

# OneBot 只读白名单（v1.3，自动不带 x-agent-token）
node scripts/agy-api.mjs group-list
node scripts/agy-api.mjs group-members --key group:541026885
node scripts/agy-api.mjs group-history --key group:541026885

# 完整角色卡（首次接班建议读一次）
node scripts/agy-api.mjs prompt --key group:541026885 --session <会话令牌>

# 行为闭环：回复前短静默 / 热聊盯人或活跃 / 主动切回潜水收尾 / 沉睡前观察
node scripts/agy-api.mjs wait-reply --key group:541026885 --session <会话令牌> --quiet-ms 10000
node scripts/agy-api.mjs wake-config --key group:541026885 --session <会话令牌> --speaker-ids <对方uid>
node scripts/agy-api.mjs wake-config --key group:541026885 --session <会话令牌> --dive
node scripts/agy-api.mjs wait-sleep --key group:541026885 --session <会话令牌> --timeout-ms 300000

# 原生看图：落盘 -> 用 read_file 看 savedFiles[].path -> 清理
node scripts/agy-api.mjs message-images --key group:541026885 --session <会话令牌> --message-id <msgId>
node scripts/agy-api.mjs cleanup-frames

# 查询本机 Antigravity 剩余额度（5 小时 / 每周百分比与重置倒计时）
node scripts/agy-api.mjs agy-quota

# 认人与表达（更多见 node scripts/agy-api.mjs help）
node scripts/agy-api.mjs active-members --key group:541026885 --session <会话令牌>
node scripts/agy-api.mjs meme-list --key group:541026885 --session <会话令牌> --tag happy --limit 8
node scripts/agy-api.mjs send-meme --key group:541026885 --session <会话令牌> --path <meme路径>
node scripts/agy-api.mjs send-poke --key group:541026885 --session <会话令牌> --target-user-id <uid>
```

### 5. 长任务租约续期（超过 2~3 分钟时）

```powershell
node scripts/agy-touch.mjs --turn-id t-20261125-05-0001 --persona 猫娘侍从 --worker-id agy-猫娘侍从
```

### 6. 查看日志与离线自检

```powershell
# 查看 worker 侧结构化日志（UTF-8 JSONL）
Get-Content D:\dsh\qq-bridge\state\agy-worker.log -Encoding UTF8 -Tail 20

# 查看桥接侧 [agy] 日志（入队/重排/收尾已读/回落 DSH）
Select-String -Path D:\dsh\qq-bridge\state\bridge.log -Pattern "\[agy\]" | Select-Object -Last 20

# 跑离线契约回归测试（不改动 config.json 与线上队列）
node scripts/agy-self-test.mjs
```

---

## 错误码与 idle 状态速查

| HTTP | 状态 / `error` | 处理方式 |
| :--- | :--- | :--- |
| `204` | （空体） | 正常空闲，立刻继续 `wait` |
| `200` | `idle: true, reason: "not-on-duty"` | 归 AGY 管但未值班，休眠 ~7s 后继续 `wait` |
| `200` | `idle: true, reason: "persona-on-dsh"` | 该人格归 DSH 管，**不要死等**，换人格或收工 |
| `404` | `turn-not-found` | 回合过期或 01:00 换班被清理，不崩溃，重新 `wait` |
| `409` | `already-claimed` / `requeued-too-many` | 已被领走或超重排上限，不崩溃，重新 `wait` |
| `409` | `transport-not-agy` | 桥接未开 AGY，停止并提示桥接侧 |
| `403` | `bad-token` | 检查 `state/console-token` 是否可读（**切勿把令牌写进日志**） |
| `500` / 网络异常 | `ECONNRESET` / `fetch-timeout` | 退避 2 秒重试；`--loop` 模式永不退出并按节流打日志 |

## 权限边界

- 只允许改动 `agy-plugin/**`、`scripts/agy-*.mjs` 与追加 `state/agy-worker.log`。
- 禁止修改 `src/**`、`config.json`、`state/*.json`，禁止执行任何 git 操作。
