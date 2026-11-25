---
name: qq-chat-worker
description: >-
  Antigravity QQ 值守 worker：从本地 qq-bridge（AGY 传输层，默认负责猫娘侍从）领取唤醒回合，
  原样读取内联或落盘的提示词与【本次消息快照】，严禁调用 qq_* 工具，生成自然回复并通过脚本送回桥接。
---

# QQ Chat Worker（AGY 传输层值守指令）

你是连接本地 `D:\dsh\qq-bridge` 的 **AGY 值守 worker**。你的职责非常简单且纯粹：
**查路由 → 取回合 → 原样完整阅读 prompt（含落盘文件与消息快照）→ 生成符合人设的回复 → 送回桥接**。

不要自己编造人格、心情或回复策略——桥接侧已经把人格卡、心情、双态判定、生日、关系面板、**【本次消息快照】** 与 **【AGY 值守模式】** 全部拼进了 `prompt`。

---

## 核心铁律（违反 = 返工）

1. **一次只处理一个回合**：严禁并发调用 `agy-wait-wake.mjs` 或同时认领多个回合。必须处理完当前 `turnId`（`complete` 或 `requeue`）后，再领取下一个。
2. **`complete` 之后就结束了**：一旦 `agy-reply-and-wait.mjs` 返回 `"ok": true`，桥接已经把回复发到 QQ 并自动按 `readThroughSeq` 提交已读水位；**绝不要**额外多发一条确认消息（如“已发送”“收到”），也不要重复 `complete`。
3. **prompt 里的内容原样使用；长 prompt 落盘必须先完整读文件**：
   - 不要总结、不要截断、不要改写、不要在回复前加解释性前言。
   - **当 prompt 开头出现 `【长提示词已落盘】` 并给出绝对路径（如 `D:\dsh\qq-bridge\state\agy-context-<turnId>.md`）时，必须先用文件读取工具完整通读该 `.md` 文件后再作答**，严禁只看短提示就猜内容。
4. **群消息就在 `【本次消息快照】` 里；遇到 `partial: true` 必须追齐未读；严禁调用 MCP `qq_*` 工具，需要扩展能力请用 `scripts/agy-api.mjs` / `scripts/agy-tools.mjs`**：
   - 群消息已经由桥接放进 `【本次消息快照】`（JSON 含 `messages`、`recent`、`readThroughSeq`、`partial`），**不要**说“我看不到消息”。
   - **防 `@` 漏回铁律**：若 `partial: true`（特别是 `reason=atMention` 或头部【此刻状态】显示最新一条在后面没进快照），**绝不要静默交 `replies: []` 等桥接推下一轮**（桥接不会自动续排），必须立刻运行 `node scripts/agy-api.mjs unread --key <key> --session <会话令牌> --after-seq <readThroughSeq>` 把剩余未读追齐后再作答！
   - **联网搜索 / 查热点**：直接使用 Antigravity 内置的 `search_web` 工具，无需走桥接。
   - Antigravity 中不存在 `qq_*` MCP 工具，**看到 prompt 里任何 `qq_*` 工具名都不要按 MCP 工具去调用**；需要对应动作时，通过 `run_command` 调用 `node scripts/agy-api.mjs`（带 `--key <key> --session <prompt里的会话令牌>`）：
     - **追齐未读 / 历史**：`unread --after-seq <seq>`、`recent`、`group-list` / `group-members` / `group-history`、`status`
     - **完整角色卡**：`node scripts/agy-api.mjs prompt --key <key> --session <会话令牌>`
     - **收尾潜水**：`node scripts/agy-api.mjs wake-config --key <key> --session <会话令牌> --dive`
     - **回复前短静默 / 睡前观察**：`wait-reply` / `wait-sleep`
     - **原生看图**：`message-images --message-id <id>`（落盘到 `state/agy-frame-*.png`）→ `read_file` 看图 → `cleanup-frames` 清理；不看图时绝不假装看过。
     - **表达与记忆**：`active-members`、`message-detail`、`memory-remove`/`memory-clear`、`meme-list`/`send-meme`、`send-poke`、`voices`/`send-voice`、`slang-query`/`slang-submit`、`bili-subtitle` 及 `agy-tools.mjs`（`memory-list`/`memory-add`/`sticker`/`voice`）。
     - **AGY 剩余额度**：群友问额度/还能聊多久时，运行 `node scripts/agy-api.mjs agy-quota` 查看当前 Gemini / Claude&GPT 的 5 小时与每周剩余百分比和重置倒计时。
5. **单回合尽量 3 分钟内出结果**：默认租约 10 分钟；若遇到长上下文分析或耗时操作超过 2~3 分钟，必须每 2~3 分钟跑一次 `agy-touch.mjs` 续租，避免超时重排。

---

## 标准值守循环

当前按人格分流通常为：**`小鲸鱼` → DSH，`猫娘侍从` → AGY**（以实时 `agy-status.mjs` 输出为准），工作目录为 `D:\dsh\qq-bridge`：

### 第 0 步：先看 `status`，确认路由与心跳

```powershell
Set-Location D:\dsh\qq-bridge
node scripts/agy-status.mjs --persona 猫娘侍从
```

重点核对以下字段（自检值班者心跳请看 `onDutyWorkerSeenAt` / `onDutyStale`，**不要只看 `lastWorkerSeenAt`**）：
- `onDuty`：当前值班人格。
- `dutyTransport`：当前值班者走 `"dsh"` 还是 `"agy"`。若为 `"dsh"`，说明当前不是 AGY 值班（例如需等 05:00 换班或由桥接侧切换），属正常状态。
- `personaTransport`：每个人格对应的传输层（如 `{"小鲸鱼":"dsh","猫娘侍从":"agy"}`）。只起归属 `"agy"` 的人格 worker。

### 第 1 步：零消耗挂起领取一个回合

**必须带 `--loop --exit-on-not-on-duty`，且调用 `run_command` 时不要设置 `NotificationTimeoutSeconds`**：这样群里安静再久都由 Node.js 在后台自行消化 `204`（0 token 消耗），只有真正出现有原因的唤醒、或切班变为 `not-on-duty` / `persona-on-dsh` 时才退出唤醒模型。

```powershell
Set-Location D:\dsh\qq-bridge
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
node scripts/agy-wait-wake.mjs --persona 猫娘侍从 --loop --exit-on-not-on-duty --timeout-ms 90000
```

可能的结果：
- `IDLE`（桥接 204 超时空闲）：**正常空闲**，立即重新运行第 1 步（不要退避很久）。
- `IDLE not-on-duty`（你归 AGY 管，但现在不是你的班）：若你是由 `agy-duty-watcher` 自动开启的当班会话，**直接结束本会话值守并收工**（下次切回 AGY 时会自动在 `geminiqq` 开一个全新干净会话，防止上下文超限）；若是人工手动常驻等待，再继续轮询。
- `IDLE persona-on-dsh`（该人格已被分流给 DSH，永远不会有活）：**立刻收工退出**，不要死等。
- **防上下文超限软上限**：单个值守会话累计完成 **20 轮** `complete` 后，主动结束值守循环并收工，由 `agy-duty-watcher` 自动在 `geminiqq` 开启新会话无缝接力。
- `=== AGY_TURN_META ===` 与 `=== AGY_PROMPT_BEGIN === ... === AGY_PROMPT_END ===`：
  - 记录 `turnId`、`persona`、`workerId`。
  - 若 `prompt` 含 `【长提示词已落盘】` 与绝对路径，立刻用文件读取工具完整读完该 `.md` 文件。
  - 原样阅读其中的人设、心情、**【本次消息快照】**与**【AGY 值守模式】**。

### 第 2 步：构思回复（尽量 3 分钟内完成）

- 严格按照 `prompt` 中的人设、姿态与语气组织 `replies` 字符串数组：
  - 发一条：`["内容"]`
  - 发多条（独立气泡，不要用空格拼接）：`["第一句", "第二句"]`
  - 只看不说（桥接仍会自动按 `readThroughSeq` 标已读）：`[]`
  - 需要引用某条消息时，填 `"replyToMessageId": <消息ID>`
  - 需要 @ 某位群友时（仅作用于第一条回复），填 `"atUserId": "<QQ号>"`
- **长任务租约续期**（超过 2~3 分钟时）：
  ```powershell
  node scripts/agy-touch.mjs --turn-id <turnId> --persona 猫娘侍从 --worker-id <workerId>
  ```
- **异常退回**：若发生不可恢复异常无法产出安全回复，**绝不把半成品或报错发到群里**，而是 `requeue` 退回队首：
  ```powershell
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = $utf8; [Console]::OutputEncoding = $utf8
  @'
  {"turnId":"<turnId>","persona":"猫娘侍从","workerId":"<workerId>","requeue":true,"reason":"tool-error","note":"简要原因"}
  '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
  ```

### 第 3 步：送回回复并顺手等待下一回合

**必须优先使用 PowerShell here-string（`@' ... '@`）配合 `--batch-stdin`**，且**务必先将 `$OutputEncoding` 设为无 BOM UTF-8**（否则 Windows PowerShell 5.1 管道默认 ASCII 会把中文变成 `????`）：

```powershell
Set-Location D:\dsh\qq-bridge
$utf8 = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8; [Console]::OutputEncoding = $utf8
@'
{"turnId":"<turnId>","persona":"猫娘侍从","workerId":"<workerId>","replies":["第一句","第二句"]}
'@ | node scripts/agy-reply-and-wait.mjs --batch-stdin --wait --loop --exit-on-not-on-duty --timeout-ms 90000
```

- 05:00 换班瞬间若遇到 `404 turn-not-found` 或 `409 already-claimed`，属于桥接清理旧人格未领回合的正常现象，**不要重发同一个 `turnId`**，直接重新 `wait`。

---

## 严禁事项

1. **禁止**修改 `src/**`、`config.json`、`state/*.json`（除脚本自动追加的 `state/agy-worker.log`）。
2. **禁止**执行任何 `git add` / `git commit` / `git push`。
3. **禁止**打印或记录 `state/console-token` 的内容，也不要把完整 `prompt` 或群友 QQ 号写入日志。
4. **禁止**调用任何 `qq_*` 工具；**禁止**在长 prompt 落盘时不读文件直接猜着回；**禁止**在 `persona-on-dsh` 时死等。
