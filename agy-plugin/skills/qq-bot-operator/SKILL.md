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
4. **群消息就在 `【本次消息快照】` 里，禁止调用任何 `qq_*` 工具**：AGY 侧没有任何 `qq_*` 工具（不要调 `qq_wait_for_messages` / `qq_mark_read` / `qq_set_wake_config` / `qq_get_prompt` / `qq_send_message` 等）；遇到图片/表情当前无看图通道，不要假装看过。
5. **单回合尽量 3 分钟内完成**：长任务每 2~3 分钟用 `agy-touch.mjs` 续租。

---

## 常用命令（Windows PowerShell）

所有命令均在 `D:\dsh\qq-bridge` 下运行（当前默认 AGY 值守人格为 `猫娘侍从`，`小鲸鱼` 分流至 DSH）：

### 1. 检查按人格分流与健康状态

```powershell
node scripts/agy-status.mjs --persona 猫娘侍从
```

重点看：`onDuty`、`dutyTransport`、`personaTransport`、`onDutyWorkerSeenAt`、`onDutyStale`（别只看 `lastWorkerSeenAt`）。

### 2. 领取一个回合

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
node scripts/agy-wait-wake.mjs --persona 猫娘侍从 --timeout-ms 90000
```

- 返回 `IDLE`：204 正常空闲，可立刻再轮询（或加 `--loop` 持续待命）。
- 返回 `IDLE not-on-duty`：归 AGY 管但当前未轮到该人格值班，脚本已休眠约 7 秒，继续轮询不要退出。
- 返回 `IDLE persona-on-dsh`：该人格已被分流给 DSH，**不要死等**，换归属 AGY 的人格或收工。
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
- **拒答 / 异常退回队首**（绝不把半成品发到群里）：
  ```powershell
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = $utf8; [Console]::OutputEncoding = $utf8
  @'
  {"turnId":"t-20261125-05-0001","persona":"猫娘侍从","workerId":"agy-猫娘侍从","requeue":true,"reason":"tool-error","note":"原因说明"}
  '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
  ```

### 4. 长任务租约续期（超过 2~3 分钟时）

```powershell
node scripts/agy-touch.mjs --turn-id t-20261125-05-0001 --persona 猫娘侍从 --worker-id agy-猫娘侍从
```

### 5. 查看日志与离线自检

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
| `404` | `turn-not-found` | 回合过期或 05:00 换班被清理，不崩溃，重新 `wait` |
| `409` | `already-claimed` / `requeued-too-many` | 已被领走或超重排上限，不崩溃，重新 `wait` |
| `409` | `transport-not-agy` | 桥接未开 AGY，停止并提示桥接侧 |
| `403` | `bad-token` | 检查 `state/console-token` 是否可读（**切勿把令牌写进日志**） |
| `500` / 网络异常 | `ECONNRESET` / `fetch-timeout` | 退避 2 秒重试；`--loop` 模式永不退出并按节流打日志 |

## 权限边界

- 只允许改动 `agy-plugin/**`、`scripts/agy-*.mjs` 与追加 `state/agy-worker.log`。
- 禁止修改 `src/**`、`config.json`、`state/*.json`，禁止执行任何 git 操作。
