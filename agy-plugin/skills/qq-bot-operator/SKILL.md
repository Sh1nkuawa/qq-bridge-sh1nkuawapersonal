---
name: qq-bot-operator
description: >-
  操作本地 D:\dsh\qq-bridge 的 AGY 传输层脚本（status / wait-wake / reply-and-wait / touch），
  用于检查桥接健康状态、领取 QQ 唤醒回合、发送分条回复或退回重排。当用户要求启动 QQ 值守、
  测试 AGY 桥接协议或排查 state/agy-worker.log 时激活此技能。
---

# QQ Bot Operator（AGY 传输层操作手册）

本技能用于通过 `D:\dsh\qq-bridge\scripts\agy-*.mjs` 与本地 qq-bridge 的 AGY 传输层交互。
协议细节以 `D:\dsh\qq-bridge\docs\AGY_CONTRACT.md` 为唯一权威。

## 三条铁律

1. **一次只处理一个回合**：禁止并发领活；完成（`complete`）或退回（`requeue`）当前回合后再领下一条。
2. **`complete` 之后就结束了**：回话成功即已通过桥接发往 QQ，严禁额外补发“已发送”之类的确认消息。
3. **prompt 原样使用**：禁止截断、改写或给 `prompt` 加前言；若 `prompt` 指向 `state/agy-context-<turnId>.md`（>8KB 落盘文件），使用文件读取工具原样通读。

---

## 常用命令（Windows PowerShell）

所有命令均在 `D:\dsh\qq-bridge` 下运行：

### 1. 检查传输层健康状态

```powershell
node scripts/agy-status.mjs --persona 小鲸鱼
```

### 2. 领取一个回合

```powershell
node scripts/agy-wait-wake.mjs --persona 小鲸鱼 --timeout-ms 90000
```

- 返回 `IDLE`：204 正常空闲，可立刻再轮询。
- 返回 `IDLE not-on-duty`：当前非值班人格，脚本已休眠约 7 秒，继续轮询且不要退出。
- 返回 `AGY_TURN_META` + `AGY_PROMPT_BEGIN ... END`：已成功 `claim`，按原文处理。

### 3. 提交回复（推荐 `--batch-stdin` + `@' ... '@`）

PowerShell 命令行参数容易吞双引号，**务必优先使用 here-string 经标准输入传入 JSON**：

```powershell
@'
{"turnId":"t-20261125-05-0001","persona":"小鲸鱼","workerId":"agy-小鲸鱼","replies":["第一句","第二句"]}
'@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
```

- **顺手领下一回合**：在命令末尾加 `--wait --timeout-ms 90000`。
- **只标已读不说话**：传 `"replies": []`。
- **引用回复某条消息**：加 `"replyToMessageId": -1234567890`。
- **拒答 / 工具报错退回队首**（绝不把半成品发到群里）：
  ```powershell
  @'
  {"turnId":"t-20261125-05-0001","persona":"小鲸鱼","workerId":"agy-小鲸鱼","requeue":true,"reason":"tool-error","note":"原因说明"}
  '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
  ```

### 4. 长任务租约续期（超过 2~3 分钟时）

默认租约 10 分钟；看图、长上下文分析或复杂工具调用期间，每 2~3 分钟续租一次：

```powershell
node scripts/agy-touch.mjs --turn-id t-20261125-05-0001 --persona 小鲸鱼 --worker-id agy-小鲸鱼
```

### 5. 查看 worker 日志与跑离线自检

```powershell
# 查看最近 20 条结构化日志（UTF-8 JSONL）
Get-Content D:\dsh\qq-bridge\state\agy-worker.log -Tail 20

# 跑离线契约回归测试（不改动 config.json 与线上队列）
node scripts/agy-self-test.mjs
```

---

## 错误码处理速查

| HTTP | `error` | 处理方式 |
| :--- | :--- | :--- |
| `204` | （空体） | 正常空闲，立刻继续 `wait` |
| `200` | `idle: true, reason: "not-on-duty"` | 休眠 5~10 秒后继续 `wait`，不要退出 |
| `404` | `turn-not-found` | 回合已过期/不存在，不崩溃，重新 `wait` |
| `409` | `already-claimed` / `requeued-too-many` | 已被领走或超重排上限，不崩溃，重新 `wait` |
| `409` | `transport-not-agy` | 桥接侧未切到 `transport: "agy"`，停止并提示桥接侧切换 |
| `403` | `bad-token` | 检查 `state/console-token` 是否可读（**切勿把令牌写进日志**） |
| `500` | `internal` | 退避 5 秒重试；连续 5 次失败后停下排查 `state/agy-worker.log` |

## 权限边界

- 只允许改动 `agy-plugin/**`、`scripts/agy-*.mjs` 与追加 `state/agy-worker.log`。
- 禁止修改 `src/**`、`config.json`、`state/*.json`，禁止执行任何 git 操作。
