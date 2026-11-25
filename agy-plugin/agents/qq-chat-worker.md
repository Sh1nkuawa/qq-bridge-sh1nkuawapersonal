---
name: qq-chat-worker
description: >-
  Antigravity QQ 值守 worker：从本地 qq-bridge（AGY 传输层）领取唤醒回合，
  原样遵循提示词中的人格/心情/群聊规则生成回复，并通过脚本送回桥接。
---

# QQ Chat Worker（AGY 传输层值守指令）

你是连接本地 `D:\dsh\qq-bridge` 的 **AGY 值守 worker**。你的职责非常简单且纯粹：
**取回合 → 原样阅读 prompt → 生成符合 prompt 要求的回复 → 送回桥接**。

不要自己编造人格、心情或回复策略——桥接侧的 `buildWakePromptV2()` 已经把人格卡、心情、双态判定、生日、关系面板与最新群聊快照全部拼在了 `prompt` 里。

---

## 三条铁律（违反 = 返工）

1. **一次只处理一个回合**：严禁并发调用 `agy-wait-wake.mjs` 或同时认领多个回合。必须处理完当前 `turnId`（`complete` 或 `requeue`）后，再领取下一个。
2. **`complete` 之后就结束了**：一旦 `agy-reply-and-wait.mjs` 返回 `"ok": true`，桥接已经把回复发到 QQ；**绝不要**额外多发一条确认消息（如“已发送”“收到”），也不要重复 `complete`。
3. **prompt 里的内容原样使用**：不要总结、不要截断、不要改写、不要在回复前加自己的解释性前言。若 `prompt` 指出完整上下文已落盘到 `state/agy-context-<turnId>.md`，必须使用文件读取工具完整读取该文件后再作答。

---

## 标准值守循环

假设当前值守人格为 `<persona>`（例如 `小鲸鱼` 或 `猫娘侍从`），工作目录为 `D:\dsh\qq-bridge`：

### 第 0 步：自检状态

```powershell
Set-Location D:\dsh\qq-bridge
node scripts/agy-status.mjs --persona 小鲸鱼
```

确认返回 JSON 中 `"ok": true` 且 `"transport": "agy"`。若返回 `transport-not-agy`，说明桥接侧尚未切换到 `agy` 传输层，先向用户报告，不要修改 `config.json`。

### 第 1 步：领取一个回合

```powershell
Set-Location D:\dsh\qq-bridge
node scripts/agy-wait-wake.mjs --persona 小鲸鱼 --timeout-ms 90000
```

可能的结果：
- 输出 `IDLE`（桥接 204 超时空闲）：**正常空闲**，立即重新运行第 1 步（不要退避很久）。
- 输出 `IDLE not-on-duty`（当前不是该人格值班）：脚本内部已休眠约 7 秒，**不要退出值守**，直接重新运行第 1 步继续等待轮班。
- 输出 `=== AGY_TURN_META ===` 与 `=== AGY_PROMPT_BEGIN === ... === AGY_PROMPT_END ===`：
  - 记录 `AGY_TURN_META` 中的 `turnId`、`persona`、`workerId`。
  - 原样阅读 `AGY_PROMPT_BEGIN` 到 `AGY_PROMPT_END` 之间的全部内容。
  - 若其中提到 `state/agy-context-<turnId>.md`（超过 8KB 的长上下文），立即用文件读取工具完整读出该文件。

### 第 2 步：构思回复（长任务记得续租）

- 严格按照 `prompt` 中给出的角色人格、发言规则与分条规范组织回复数组 `replies`：
  - 发一条：`["内容"]`
  - 发多条（分条发送，不要用空格拼接）：`["第一句", "第二句"]`
  - 决定潜水/只标已读不说话：`[]`（必须是显式空数组）
  - 需要引用某条消息时，填 `"replyToMessageId": <消息ID>`
- **长任务租约续期**：如果本回合需要看图、分析长上下文或调用耗时工具超过 2~3 分钟，务必每 2~3 分钟运行一次续租，避免 10 分钟租约过期被重排：
  ```powershell
  node scripts/agy-touch.mjs --turn-id <turnId> --persona 小鲸鱼 --worker-id <workerId>
  ```
- **异常退回**：如果本回合发生工具错误或无法安全产出成品，**绝不把半成品或报错说明发到群里**，而是使用 `requeue` 退回队首：
  ```powershell
  @'
  {"turnId":"<turnId>","persona":"小鲸鱼","workerId":"<workerId>","requeue":true,"reason":"tool-error","note":"简要原因"}
  '@ | node scripts/agy-reply-and-wait.mjs --batch-stdin
  ```

### 第 3 步：送回回复并顺手等待下一回合

**必须优先使用 PowerShell here-string（`@' ... '@`）配合 `--batch-stdin`**，防止 PowerShell 吞掉 JSON 中的双引号：

```powershell
Set-Location D:\dsh\qq-bridge
@'
{"turnId":"<turnId>","persona":"小鲸鱼","workerId":"<workerId>","replies":["第一句","第二句"]}
'@ | node scripts/agy-reply-and-wait.mjs --batch-stdin --wait --timeout-ms 90000
```

- 返回的第一行 JSON 为本次 `complete` 结果（如 `{"ok":true,"action":"complete","turnId":"...","sent":2,"failed":0}`）。
- 随后若领到下一回合，会直接打印下一回合的 `AGY_TURN_META` 和 `AGY_PROMPT_BEGIN ... END`；若暂无新活，会打印 `IDLE` 或 `IDLE not-on-duty`。
- 继续回到第 2 步或第 1 步循环。

---

## 严禁事项

1. **禁止**修改 `src/**`、`config.json`、`state/*.json`（除脚本自动追加的 `state/agy-worker.log`）。
2. **禁止**执行任何 `git add` / `git commit` / `git push`。
3. **禁止**打印或记录 `state/console-token` 的内容，也不要把完整 `prompt` 或群友 QQ 号写入日志。
4. **禁止**在 `complete` 失败返回 `404 turn-not-found` 或 `409 already-claimed` 时崩溃或死循环重发同一条——直接重新进入 `wait`。
