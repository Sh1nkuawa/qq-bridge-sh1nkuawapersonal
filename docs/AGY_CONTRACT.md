# AGY 传输层契约（bridge ↔ worker）

> 版本 **v1**（2026-11-25 起草）
> 目的：让"大脑"从 **DSH 会话** 换成 **Antigravity worker**，同时**完整保留**我们现有的提示词管线
> （人格卡、心情、双态判定、生日、黑话、关系面板）。
> 一句话：**提示词还是我们拼，只是由 worker 来消费和回话。**

---

## 0. 边界（先讲清楚，避免互相踩）

| 谁 | 可以改 | 不可以改 |
|---|---|---|
| **桥接侧（DSH agent）** | `src/**`、`scripts/test-*.mjs`、`scripts/mock-agy-worker.mjs`、`docs/**`、`config*.json` | `agy-plugin/**`、`scripts/agy-*.mjs` |
| **AGY 侧（Antigravity worker）** | `agy-plugin/**`、`scripts/agy-*.mjs`、`state/agy-worker.log` | `src/**`、`bridge.js`、`config.json`、`state/*.json`、**任何 git 操作** |

- **只有桥接侧 commit / push** ✓
- AGY 侧只**写文件** + **跑脚本** + **写日志** ✓
- 双方都不改对方的目录；需要对方改动时，写进本文件的「变更请求」一节 ✓

---

## 1. 架构

```
QQ ⇄ SnowLuma ⇄ 桥接（我们）
                    │
                    ├─ ① 组装唤醒：buildWakePromptV2()（人格/心情/双态/生日/快照）  ← 不变 ✓
                    ├─ ② 放进本地队列（带 persona 标签）
                    │
                    │  worker 长轮询 GET /api/agy/wait?persona=<X>
                    ├─ ③ ──────────────────────────────►  Antigravity worker（窗口里跑脚本）
                    │                                          │
                    │ ④ POST /api/agy/claim {turnId, persona}  │  认领（校验值班者）
                    │ ⑤ POST /api/agy/complete {turnId, replies}│  回话
                    └─ ⑥ sendMessagesV2() 真发给 QQ              ┘
```

**关键设计**：worker **不需要**知道人格卡、心情、群消息历史 —— 它只做三件事：
**取 → 交给 agent → 送回来**。所有"想什么"的东西都在 ①③ 的 prompt 文本里 ✓。

---

## 2. 认证

所有 `/api/agy/*` 都要求控制台令牌（和现有控制台一致）：

```
?token=<console-token>            // 或 header: x-console-token: <console-token>
```

令牌在 `state/console-token`。**worker 不得把令牌写进日志** ✗。

---

## 3. 端点

### 3.1 `GET /api/agy/wait` — 取活（长轮询）

| 参数 | 必填 | 说明 |
|---|---|---|
| `persona` | ✓ | worker 的人格名（`小鲸鱼` / `猫娘侍从`）；大小写与空格敏感 |
| `workerId` | ✓ | worker 自报身份，用于日志与防重复认领；建议 `agy-<persona>-<pid>` |
| `timeoutMs` | ✗ | 长轮询上限，默认 `90000`，最大 `120000` |
| `afterTurnId` | ✗ | 只要比这个新的回合（防重复拿同一条） |

**有活** → `200` + Turn（见 §4）
**没活**（超时）→ `204 No Content`，**响应体为空**（worker 直接再轮询，别当错误）
**人格不是当前值班者** → `200` + `{ "ok": true, "idle": true, "reason": "not-on-duty" }`
 —— worker 应**继续轮询**（每 5~10 秒一次），**不要退出** ✓

### 3.2 `POST /api/agy/claim` — 认领（幂等）

请求：
```json
{ "turnId": "t-20261125-05-0001", "persona": "小鲸鱼", "workerId": "agy-小鲸鱼-4242" }
```

响应：
```json
{ "ok": true, "turn": { ...完整 Turn... }, "leaseUntil": 1794809999999 }
```

失败：
| HTTP | `error` | 含义 / worker 该怎么办 |
|---|---|---|
| `409` | `already-claimed` | 已被别的 worker 认领 → 重新 `wait` ✓ |
| `404` | `turn-not-found` | 过期被回收 → 重新 `wait` ✓ |
| `403` | `not-on-duty` | 你不是值班者 → 重新 `wait` ✓ |
| `409` | `requeued-too-many` | 这条已重排 2 次 → 放弃它，重新 `wait` ✓ |

**租约**：认领后 `leaseUntil`（默认 **10 分钟**）。中途可 `POST /api/agy/touch {turnId}` 续期（看图/长任务时用）。
超时未 `complete` → 桥接自动重排（最多 2 次），并记日志 ✓。

### 3.3 `POST /api/agy/complete` — 回话

请求：
```json
{
  "turnId": "t-20261125-05-0001",
  "persona": "小鲸鱼",
  "workerId": "agy-小鲸鱼-4242",
  "replies": ["第一句", "第二句"],
  "replyToMessageId": -1234567890,
  "atUserId": "123456789",
  "meta": { "rounds": 3, "note": "自由填写，仅记日志" }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `replies` | ✓ | **字符串数组** = 分条发送；空数组 = 只标已读、不说话 ✓ |
| `replyToMessageId` | ✗ | 要引用某条消息时给（QQ messageId，可为负） |
| `atUserId` | ✗ | **真的 @ 到某个人**（QQ 号，5~12 位数字）；只作用于**第一条** replies。脏值（非纯数字/长度不对）会被**静默丢弃**（当没传）——绝不把奇怪的值塞进 OneBot 的 at 段 ✗ |
| `meta` | ✗ | 只进日志，不发给 QQ |

响应：`{ "ok": true, "sent": 2, "failed": 0 }`
失败：`400 empty-replies-disallowed`（`replies` 缺失）、`409 turn-not-claimed`、`404 turn-not-found`

### 3.4 `POST /api/agy/requeue` — 退回

```json
{ "turnId": "...", "reason": "refusal|timeout|tool-error|manual", "note": "..." }
```
把该回合退回**队首**并 `attempts+1` ✓ —— 用于"模型拒答/输出越界/工具失败"时**不发出去、重新来一次** ✓。
超过 2 次 → 桥接记日志并丢弃该唤醒 ✓（**绝不把半成品发到群里** ✗）。

### 3.5 `GET /api/agy/status` — 健康

```json
{
  "ok": true,
  "transport": "agy",
  "onDuty": "小鲸鱼",
  "queue": { "小鲸鱼": 0, "猫娘侍从": 1 },
  "claimed": 0,
  "lastWorkerSeenAt": 1794809500000,
  "onDutyWorkerSeenAt": 1794809500000,
  "onDutyStale": false,
  "workerSeenByPersona": { "小鲸鱼": 1794809500000 },
  "lastCompleteAt": 1794809000000,
  "leaseSec": 600,
  "version": 1
}
```
worker 每轮可打这一条做自检 ✓

| 字段 | 含义 |
|---|---|
| `lastWorkerSeenAt` | **任意**人格的最近心跳（旧字段，保留兼容） |
| `onDutyWorkerSeenAt` | **当前值班者**的最近心跳（`null` = 从没见过） |
| `onDutyStale` | 值班者是否算掉线（>5 分钟没心跳）—— fallback 就是看这个 |
| `workerSeenByPersona` | 每个 persona 各自的最近心跳 |

> ⚠️ 只看 `lastWorkerSeenAt` 会被骗：05:00 换班后旧人格的 worker 还在每 7 秒轮询（永远拿到
> `idle: not-on-duty`），它会把"最近心跳"一直刷新 ⇒ 看起来"值班者还在"，其实新值班者根本没起来 ✗。
> 所以判定**必须按当前值班者的 persona** 看。

### 3.6 `POST /api/agy/touch` — 续租（可选）

`{ "turnId": "..." }` → `{ "ok": true, "leaseUntil": ... }`

### 3.7 `GET /api/agy/onebot` — 只读 OneBot 查询（2026-11-25 v1.3 新增）

补齐那三个**直连 OneBot、原本没有 HTTP 端点**的只读工具：

```
GET /api/agy/onebot?action=get_group_list
GET /api/agy/onebot?action=get_group_member_list&groupId=541026885
GET /api/agy/onebot?action=get_group_msg_history&groupId=541026885&messageSeq=53200
```

| 项 | 说明 |
|---|---|
| 允许的 action | **只有三个**：`get_group_list` / `get_group_member_list` / `get_group_msg_history`（白名单；其它 action → `400 action-not-allowed`）|
| 鉴权 | 和其它 `/api/agy/*` 一样：**只认控制台令牌**（`?token=` 或 `x-console-token`）；**带 `x-agent-token` 会 403** ✗ |
| 白名单 | 群号必须过 `config.allow`/`deny`；不在白名单 → `403` |
| 返回 | `{ ok, action, data }`；`get_group_list` 已按白名单过滤，`get_group_member_list` 只留 `{user_id, nickname, card}` |
| 写操作 | **一个都没有** ✓（禁言/改名/踢人/公告都有自己的端点，不在这里）|
| 失败 | `502` + `error`（常见原因：SnowLuma 没实现该动作 / 群没加入 / OneBot 掉线）|

> `get_group_msg_history` 是否可用取决于 SnowLuma 有没有实现这个动作 —— 没实现就是 502，
> **不是**你参数传错了 ✓

---

## 4. Turn 对象

```json
{
  "turnId": "t-20261125-05-0001",
  "persona": "小鲸鱼",
  "key": "group:541026885",
  "reason": "replyCheck",
  "createdAt": 1794809400000,
  "attempts": 0,
  "prompt": "……完整的唤醒提示词（人格卡 + 心情 + 快照 + 令牌 + 工具说明）……",
  "readThroughSeq": 47253
}
```

**`prompt` 是最终文本，worker 原样交给 agent 即可** ✓（不要自己截断 ✗、不要自己加前缀 ✗）。

`prompt` 里包含的东西（2026-11-25 起 ✓）：

1. 人格卡摘要、心情、双态判定（答题态/闲扯态）、生日、关系面板、黑话表 —— 全部来自 `buildWakePromptV2()`
2. **【本次消息快照】** —— 本轮要给模型看的未读消息（JSON，含 `readThroughSeq`）。
   ⚠️ AGY 那边的 agent **没有任何 QQ 工具**（没有 MCP），群消息**只能**靠这一段带过去；
   没有它模型只会看到"未读 N 条"，回什么全靠猜 ✗
3. **【AGY 值守模式】** —— 明确告诉模型：上面提到的 `qq_*` 是 DSH 侧的 MCP 工具，**不要调用**；
   扩展动作（角色卡全文 / 等人 / 收尾潜水 / 看图 / 表情包 / 拍一拍…）改用 `scripts/agy-api.mjs`；
   它只要把这一轮要说的话写成 `replies` 数组交给 `agy-reply-and-wait.mjs` ✓
   （v1.3 起：不再说"你没有任何工具 / 看不到图"—— AGY 侧已经有 CLI 和看图通道了 ✓）

`readThroughSeq` 就是这个回合的已读水位：worker `complete` 之后，桥接会**自动**按它把已读水位
提交掉（AGY 侧没有 `qq_mark_read`）。所以 worker 不需要、也没办法自己标已读 ✓

> ⚠️ 若 `prompt` 超过 **8KB**（Antigravity 后台通知约 10KB 会截断 ✗），桥接会**自动**把长内容落到
> `state/agy-context-<turnId>.md`，并把 `prompt` 换成"短提示 + 该文件路径 +【AGY 值守模式】" ✓。
> worker 只需照原文输出，agent 会 `view_file` 读那个文件 ✓ —— 注意**落盘路径就在 prompt 里**，
> 不用自己拼。<br>桥接侧自检日志会打：`[agy] prompt N 字节 > 8192，已落盘 …`。

---

## 5. 值班（persona）语义

- **角色卡是唯一真相**：`state/current-role.json` 的 `role` 就是当前值班者 ✓
- `state/persona-schedule.json` 的 `onDuty` 只是桥接写出去的**镜像**（方便人看），不参与判定 ✓
  —— 让镜像参与判定会出事故：文件一残留旧值，worker 全部拿到 `not-on-duty` ⇒ 哑火且无日志线索 ✗
- **每天 05:00（北京时间）** 换班：写角色卡 + 同步 `onDuty` + 重建 DSH 会话（AGY 模式下通常没有会话）
  + **清掉旧人格还没被认领的回合**（新值班者永远不会去取它们；不清就永远占着"会话繁忙" ✗）
- 手动切换（`POST /api/role`）与 05:00 自动轮换走**同一条路径** ✓

### 5.1 按人格分流传输层（2026-11-25 起 ✓）

"用不用 AGY"不是全局开关，而是**看值班者是谁**：

```json
{
  "transport": "agy",
  "personaSchedule": {
    "rotation": ["小鲸鱼", "猫娘侍从"],
    "personas": {
      "小鲸鱼":   { "provider": "deepseek-official", "model": "deepseek-flash", "transport": "dsh" },
      "猫娘侍从": { "provider": "google", "model": "gemini-4-hydrogen", "transport": "agy" }
    }
  }
}
```

| 规则（顺序即优先级） | 结果 |
|---|---|
| 全局 `transport` 不是 `agy` | 一律 `dsh`（persona 写 `agy` 也不越过全局开关） |
| persona 显式写了 `dsh` / `agy` | 听它的 |
| 没写 / 写错 | 跟随全局 |

- 判定实现在 `src/persona-transport.js`（纯函数，`scripts/test-persona-transport.mjs` 10 组回归 ✓）
- `status` 里能直接看到现状：`dutyTransport`（这一位现在走哪边）、`personaTransport`（每个人格的去向）
- **被分流到 DSH 的人格**：AGY 这边永远不会有它的 turn；它的 worker `wait` 会拿到
  `200 + {idle: true, reason: "persona-on-dsh", transport: "dsh"}` —— 那是"这位不归你管"，
  worker 照常歇几秒再轮询即可（或者干脆别起这个 worker）✓
- 分流到 AGY 的人格掉线时**仍然**按下面的 fallback 回落 DSH ✓

- 非值班 worker：`wait` 返回 `idle: true, reason: "not-on-duty"` ✓，**继续轮询** ✓
  （它的轮询同时是"我还活着"的心跳，但**只记在它自己的人格名下**）
- 值班者掉线（该 persona 的 `onDutyWorkerSeenAt` > 5 分钟）：
  - `transportFallback: "dsh"`（默认）→ 该回合回落给 DSH 处理 ✓（保证不哑火 ✓）
  - `"none"` → 只在日志与 `status` 里告警 ✓
  - 同时 sweep 会把"挂了 5 分钟没人认领"的回合清掉并释放繁忙标记（消息**不标已读**，
    下一条唤醒回落 DSH 时还带着它们 ✓）

---

## 6. 错误码汇总

| HTTP | error | worker 动作 |
|---|---|---|
| 204 | —（空体） | 立刻再 `wait` ✓ |
| 200 | `idle:true, reason:"not-on-duty"` | 5~10 秒后再 `wait` ✓ |
| 200 | `idle:true, reason:"persona-on-dsh"` | 这一位人格被配置成走 DSH（见 §5.1）⇒ 别等它，歇一下再轮询 ✓ |
| 400 | `bad-request` | 修参数，**别重试同样请求** |
| 403 | `not-on-duty` / `bad-token` | 重新 `wait` / 检查令牌 |
| 404 | `turn-not-found` | 重新 `wait` ✓ |
| 409 | `already-claimed` / `requeued-too-many` | 重新 `wait` ✓ |
| 500 | `internal` | 退避 5 秒再 `wait` ✓，连续 5 次把日志写清楚 ✓ |

---

## 7. worker 日志格式（我靠这个配合你 ✓）

**路径**：`state/agy-worker.log`（单行 JSON，UTF-8 无 BOM，**追加**写）

```json
{"at":1794809412345,"workerId":"agy-小鲸鱼-4242","persona":"小鲸鱼","event":"wait","ms":1200}
{"at":1794809416000,"workerId":"…","persona":"小鲸鱼","event":"claim","turnId":"t-…","ok":true}
{"at":1794809420000,"workerId":"…","persona":"小鲸鱼","event":"complete","turnId":"t-…","sent":2,"failed":0}
{"at":1794809421000,"workerId":"…","persona":"小鲸鱼","event":"error","where":"claim","http":409,"error":"already-claimed"}
```

必带字段：`at`、`workerId`、`persona`、`event` ✓
**禁止**写：令牌 ✗、完整 prompt ✗（太长 ✗）、群友 QQ 号 ✗（只写 `key` ✓）

---

## 8. 验收清单（跑通 = 这 6 条全 ✓）

1. `GET /api/agy/status` 返回 `transport: "agy"` ✓
2. worker 空转时不刷屏、不退出 ✓（日志里 `wait` 间隔 5~10 秒 ✓）
3. 群里 @ 一次 → worker 取到 turn ✓ → 回 1 条 → **群里真的收到** ✓
4. 回两条时**分两条发** ✓（不是空格拼接 ✗）
5. 手写一个 **不存在的 turnId** → `404` ✓，worker 不崩 ✓
6. 人为让 worker 卡 11 分钟 → 回合被**重排** ✓（`attempts:1` ✓），且**没有半成品发到群里** ✓

> 2026-11-25 追加的三条（都是"看着跑了其实没生效"那一类）：
>
> 7. turn 的 `prompt` 里**真的有【本次消息快照】**，且 JSON 里的消息就是群里那几条 ✓
> 8. `prompt` >8KB 时 worker 拿到的是**短提示 + 落盘路径**，落盘的 `.md` 里有完整上下文 ✓
> 9. `complete` 之后日志出现 `收尾已读：N 条（水位 M）`，且 `unread` 真的变少（重启后不复活）✓

---

## 9. 禁止事项（违反 = 返工 ✗）

1. 不要自己拼或改写 `prompt`（人格/心情都在里面 ✓）
2. 不要把 `prompt` 或令牌写进日志 ✗
3. 不要 `git add/commit/push` ✗
4. 不要改 `config.json` / `state/*.json`（除 `agy-worker.log`）✗
5. 不要"多发一条确认消息"（`complete` 已经发过了）✗
6. 不要在 `wait` 拿到 `204` 时退避很久 ✗（那是**正常空闲**，立刻再轮询 ✓）

---

## 10. 变更请求（双方在这里登记）

| 日期 | 提出方 | 内容 | 状态 |
|---|---|---|---|
| 2026-11-25 | 桥接侧 | **v1.1 无协议变更，只加字段/行为**：`status` 增加 `onDutyWorkerSeenAt` / `onDutyStale` / `workerSeenByPersona`；`turn.readThroughSeq` 现在真的会填（worker `complete` 后桥接自动提交已读）；`prompt` 必带【本次消息快照】+【AGY 值守模式】；>8KB 自动落盘 `state/agy-context-<turnId>.md`；05:00 换班会清掉旧人格未认领的回合 | ✅ 已上线（worker 无需改代码） |
| 2026-11-25 | 桥接侧 | **v1.2 按人格分流**：`config.personaSchedule.personas[名字].transport` 可把某个人格钉到 `dsh` 或 `agy`（owner：小鲸鱼走 DSH、猫娘走 AGY）。`status` 增加 `dutyTransport` / `personaTransport`；`wait` 新增 idle 理由 `persona-on-dsh` | ✅ 已上线（worker 无需改代码；见到 `persona-on-dsh` 就是"这位不归你管"） |
| 2026-11-25 | AGY 侧 | **`POST /api/agy/complete` 增加可选 `atUserId` 字段**：透传给 `sendMessagesV2`，让群聊回复能真正 @ 到指定群友（对应 `AGY_FEATURE_GAPS.md` §3） | ✅ 已上线（v1.3）：脏值静默丢弃；只作用于第一条 replies |
| 2026-11-25 | AGY 侧 | **新增只读 OneBot 白名单端点**（如 `GET /api/agy/onebot?action=get_group_list\|get_group_member_list\|get_group_msg_history`）：补齐群列表/群成员/群历史只读查询（对应 `AGY_FEATURE_GAPS.md` §3） | ✅ 已上线（v1.3，见 §3.7）：只放三个只读动作 + 群白名单 |
| 2026-11-25 | AGY 侧 | **同步【AGY 值守模式】prompt 措辞**：AGY 侧已落地 `scripts/agy-api.mjs`（涵盖 `wake-config`/`wait-reply`/`wait-sleep`/`prompt`/表情包/拍一拍/**`message-images` 落盘配合 `read_file` 原生看图**、以及本机 **`agy-quota`** 查 Antigravity 5h/周剩余额度，不再需要桥接侧做视觉转述或 DeepSeek 余额代理）。建议将 prompt 中「看不到图 / 没有任何工具」改表述为「无 MCP `qq_*` 工具，需扩展动作/看图/收尾潜水时使用 `scripts/agy-api.mjs`」避免指令冲突 | ✅ 已上线（v1.3）：`src/agy-prompt.js` 已改成"没有 MCP 的 qq_* 工具 + 用 agy-api.mjs 扩展"；看图改为 `message-images` 落盘再读，不再说"看不到图"；余额不再代做（AGY 侧用 `agy-quota`）|
