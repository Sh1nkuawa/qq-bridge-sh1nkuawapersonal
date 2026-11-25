# AGY 侧待办（给 Antigravity 里的 agent）

> 2026-11-25 19:57 由桥接侧（DSH）写。**这份是给"你"的工单**，看完就能动手 ✓
> 背景：桥接侧这一轮修了 5 个"看着跑了其实没生效"的坑，并把传输层改成**按人格分流**
> （小鲸鱼 → DSH，猫娘侍从 → AGY）。协议仍是 **v1**，你不需要改协议代码；
> 但有三件事必须知道，否则你会以为"桥接坏了"或"我该继续等"。

---

## 0. 先看两行，决定你现在该不该干活

```powershell
Set-Location D:\dsh\qq-bridge
node scripts/agy-status.mjs --persona 猫娘侍从
```

看返回里的这两个字段（**新加的**）：

| 字段 | 含义 | 你该做什么 |
|---|---|---|
| `onDuty` | 现在谁值班 | 只有 `猫娘侍从` 时 AGY 才有活 |
| `dutyTransport` | 值班者走哪条传输层 | `"dsh"` ⇒ **今晚没你的活，别慌**；`"agy"` ⇒ 你该在值守 |
| `personaTransport` | 每个人格去哪儿 | `{"小鲸鱼":"dsh","猫娘侍从":"agy"}` |

**当前实际状态（19:57）**：`onDuty=小鲸鱼`、`dutyTransport=dsh`。
也就是说——**小鲸鱼的活全部走 DSH，AGY 这边今晚一条活都不会有**，直到明天 05:00 换班到猫娘侍从。
所以：**你现在把「猫娘侍从」的 worker 起来是"就位"**，它会一直拿到 `IDLE not-on-duty`，
那是正常的，不是坏了 ✓

> 想今晚就测 AGY 这条路？**别自己改 config**（那是桥接侧的文件 ✗）。
> 让桥接侧（DSH 那边）把值班者切到猫娘侍从：`POST /api/role {"role":"猫娘侍从"}`，或者等 05:00 ✓

---

## 1. 你要做的三件事（按优先级）

### ① 起 **猫娘侍从** 的 worker（不是小鲸鱼 ✗）

```powershell
Set-Location D:\dsh\qq-bridge
node scripts/agy-wait-wake.mjs --persona 猫娘侍从 --timeout-ms 90000
```

- **小鲸鱼的 worker 可以关掉了**：它的活被分流到 DSH，你轮小鲸鱼只会拿到
  `IDLE persona-on-dsh`（新加的理由，见 §2.5），纯属空转 ✓
- 起 worker 前也可以先 `agy-status.mjs` 看一眼 `dutyTransport`，避免整夜空转

### ② 确认你的 agent 指令覆盖了这两条（`agy-plugin/agents/qq-chat-worker.md` 是**你的文件**，我们不改 ✗）

1. **prompt 里带了【本次消息快照】** —— 群消息就在里面，**不要**去找工具查、**不要**说"我看不到消息" ✓
   （你的 agent md 里已经写了"人格/心情/快照都拼在 prompt 里"，现在这句终于名副其实 ✓）
2. **prompt 里带了【AGY 值守模式】** —— 明确写着"你没有任何 qq_* 工具，不要调用"。
   这条由**桥接侧的 prompt** 兜住（不用你改代码 ✓），但建议你在 agent md 里也补一句
   "看到 qq_* 工具名不要调用"，双重保险 —— 因为 prompt 其他地方还有写给 DSH 模型看的
   "用 qq_wait_for_messages / qq_mark_read / qq_set_wake_config" 字样，容易误读 ✗

### ③ 长 prompt 落盘后，**先读文件再回**

当 prompt 开头是：

```
【长提示词已落盘】
本轮完整上下文 20701 字节，超过单条通知的上限（约 10KB 会截断），已写到：
D:\dsh\qq-bridge\state\agy-context-t-202611251932-0001.md

请**先用文件读取工具把上面这个文件完整读一遍**……
```

必须用文件读取工具把那个 `.md` **完整读完**再作答 ✓

- 路径是**绝对路径**，直接照抄，不用自己拼 ✓
- 落盘文件里才是完整的人格卡 / 心情 / 消息快照；短提示里只有元信息 ✗
- 不读就回 = 你在猜内容（这就是之前两轮 `sent:0` / 答非所问的原因 ✗）

---

## 2. 桥接侧这一轮改了什么（你只需要知道这些行为）

### 2.1 prompt 结构（顺序固定）

```
【当前角色】【会话令牌】【本轮姿态】…【语音】【表情包】…（原来的东西都在 ✓）
【本次消息快照】 {"messages":[…],"recent":[…],"readThroughSeq":53275,"partial":true}
以上是本轮桥接替你取到的群消息 —— 你没有查询消息的工具，也不用去查…
【AGY 值守模式 · 覆盖上面的工具说明】
你这一轮没有任何 QQ 工具……把这一轮要发到群里的内容写成 JSON 字符串数组，交给 scripts/agy-reply-and-wait.mjs
```

- `partial=true` = 还有更多未读没塞进来，**下一轮会再给**，别这一轮追着问 ✓
- 有人发图片/表情时，**你这轮看不到图**（AGY 侧没有读图通道），prompt 里已经写明"不要假装看过" ✓
  需要看图支持的话走 §6 的变更请求，别自己实现 ✗

### 2.2 已读水位是桥接自动提交的

- `complete` 之后桥接会按这个回合的 `readThroughSeq` 自动标已读，日志形如
  `[agy] group:541026885 收尾已读：8 条（水位 53275）` ✓
- 所以：**不要去调 `qq_mark_read`**（你没有这个工具），也不用在 replies 里解释 ✓
- `replies: []` 就是"只看不说" —— 桥接照样会标已读 ✓

### 2.3 租约与重排（没变，但要注意实测数据）

- 租约 **10 分钟**；超过没 `complete` ⇒ 桥接重排（`attempts+1`），重排 2 次后丢弃
- 实测教训：今天（11-25）18:31 与 18:47 两轮在 Antigravity 里**想了 12 分钟**，先被重排了一次才 complete ✗
- 做法：**单回合尽量 3 分钟内出结果**；真的要看图/长任务，每 2~3 分钟跑一次
  `node scripts/agy-touch.mjs --turn-id <turnId> --persona 猫娘侍从 --worker-id <workerId>`

### 2.4 05:00 换班会清掉旧人格的待办

- 换班时桥接会把**旧人格还没被认领的回合**直接丢掉（新值班者永远不会来取，留着只会把会话锁成 busy）
- 所以你可能在换班那一刻拿到 `404 turn-not-found` / `409 already-claimed`：
  **那是正常的**，重新 `wait` 就行，**不要**重发同一个 `turnId` ✗
- 换班后 `personaTransport` 不变，但 `onDuty` 会变 ⇒ 你的 worker 会从 `IDLE not-on-duty`
  变成真正领到活（或者反过来）

### 2.5 新的 idle 理由：`persona-on-dsh`

```
IDLE persona-on-dsh     ← 你不归 AGY 管，这位人格被分流给 DSH 了
IDLE not-on-duty        ← 你归 AGY 管，但现在不是你的班
```

两种都**不是错误**，都继续轮询 ✓（worker 脚本已经按通用 idle 处理，会睡 7 秒再来）
区分它们的意义：`persona-on-dsh` 说明"这个 persona 再等也不会有活"，你可以考虑换 persona 或收工 ✓

### 2.6 `status` 多了几个字段（你的 `agy-status.mjs` 原样打印，不用改）

```json
"onDuty": "小鲸鱼",
"dutyTransport": "dsh",
"personaTransport": { "小鲸鱼": "dsh", "猫娘侍从": "agy" },
"onDutyWorkerSeenAt": 1795607559706,   // 当前值班者的最近心跳
"onDutyStale": false,                  // 值班者是否算掉线（>5 分钟没心跳）
"workerSeenByPersona": { "小鲸鱼": 1795607559706 }
```

⚠️ 心跳是**按 persona** 记的：你轮 `猫娘侍从` 不会让 `小鲸鱼` 的心跳变新。
自检时看 `onDutyWorkerSeenAt` / `onDutyStale`，**别看 `lastWorkerSeenAt`**（它是任意人格的，会骗人）✓

---

## 3. 验收（你自己跑一遍，全 ✓ 就算接上了）

> 前提：让桥接侧把值班者切到猫娘侍从（或等 05:00），否则你没有活可领。

1. `node scripts/agy-status.mjs --persona 猫娘侍从` → `dutyTransport: "agy"` ✓
2. `node scripts/agy-wait-wake.mjs --persona 猫娘侍从` → 空转时稳定输出 `IDLE` /
   `IDLE not-on-duty`，**不退出、不刷屏** ✓
3. 群里有人 @ 一次 → 你拿到回合，`AGY_PROMPT_BEGIN/END` 之间有
   **【本次消息快照】** + **【AGY 值守模式】** ✓
4. 若 prompt 以【长提示词已落盘】开头 → 你能读到那个 `.md` 并完整读完 ✓
5. 回两条 → 群里**真的分两条**收到（不是空格拼接）✓
6. `replies: []` → 群里没消息，但桥接日志出现 `收尾已读：N 条` ✓
7. 手写一个假 `turnId` → `404`，脚本不崩 ✓
8. 卡到 11 分钟 → 回合被重排（`attempts:1`），群里有**没有**半成品 ✓
9. 轮一个被分流的人格（小鲸鱼）→ 稳定拿到 `IDLE persona-on-dsh` ✓

---

## 4. 明确不要做的事 ✗

1. **不要改** `src/**`、`config.json`、`state/*.json`（除 `state/agy-worker.log`）✗
2. **不要** `git add/commit/push` —— 只有桥接侧提交 ✓
3. **不要**把令牌、完整 prompt、群友 QQ 号写进日志 ✗
4. **不要**自己拼上下文/摘要 prompt，也不要截断它 ✓
5. **不要**在 `complete` 之后再补一句"已发送" ✓（群里会看到你自言自语）
6. **不要**因为看到 prompt 里的 `qq_*` 工具名就去试着调用 ✗
   —— 那是 DSH 侧的模型才有；你这边没有，调用只会浪费时间与被判失败
7. **不要**在长 prompt 落盘时"猜内容" —— 必须先读文件 ✓
8. **不要**在 `persona-on-dsh` 时死等 —— 换个 persona 或收工 ✓

---

## 5. 你唯一需要看的两处日志

| 位置 | 谁写 | 用途 |
|---|---|---|
| `state/agy-worker.log` | **你**（单行 JSON，追加） | 桥接侧靠它判断你有没有走对 ✓ 格式见契约 §7 |
| `state/bridge.log` | 桥接侧 | 你也能读：搜 `[agy]` 能看到入队/重排/收尾已读/回落 DSH ✓ |

想确认"桥接是不是真的把我当值班者"，看 `bridge.log` 里这两行：

```
[agy] 唤醒入队 t-…（猫娘侍从 / group:… / atMention / 1500 字节）等 worker 认领
[agy] 回合完成 t-…（猫娘侍从）发送 2 条，失败 0 条
```

---

## 6. 要改桥接侧的东西？走变更请求，别自己动手

- 在 `docs/AGY_CONTRACT.md` §10 里**登记一行**（日期 / 提出方 / 想怎样 / 为什么）✓
- 桥接侧改完 → 重启 → 你在 `state/bridge.log` 里看到生效 → 续测 ✓
- 目前**已知还没做的**（不用你提，桥接侧记着）：
  1. 生图 / 拍一拍 / 黑话提交的 CLI（`agy-tools.mjs` 现在只有 `memory-*` / `sticker` / `voice`）
  2. **AGY 侧看图**：现在 prompt 会老实说"看不到图"，要真能看就得桥接侧把图下载/转述后带进 prompt

---

## 7. 一句话总结

**把「猫娘侍从」的 worker 起来，等 05:00（或让桥接侧手动切班）开始领活；
prompt 里现在什么都有了（快照 + 明确禁止调 qq_* 工具 + 长内容落盘路径），
照着 prompt 说人话、用 `agy-reply-and-wait.mjs` 把话送回去就行 ✓**
