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
  "meta": { "rounds": 3, "note": "自由填写，仅记日志" }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `replies` | ✓ | **字符串数组** = 分条发送；空数组 = 只标已读、不说话 ✓ |
| `replyToMessageId` | ✗ | 要引用某条消息时给（QQ messageId，可为负） |
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
  "lastWorkerSeenAt": 1794809500000,
  "lastCompleteAt": 1794809000000,
  "leaseSec": 600,
  "version": 1
}
```
worker 每轮可打这一条做自检 ✓（`lastWorkerSeenAt` 超过 5 分钟 = 值班者可能掉线 ✓）。

### 3.6 `POST /api/agy/touch` — 续租（可选）

`{ "turnId": "..." }` → `{ "ok": true, "leaseUntil": ... }`

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

> ⚠️ 若 `prompt` 超过 **8KB**（Antigravity 后台通知约 10KB 会截断 ✗），桥接会**自动**把长内容落到
> `state/agy-context-<turnId>.md`，并把 `prompt` 换成"短提示 + 该文件路径" ✓。worker 只需照原文输出 ✓。

---

## 5. 值班（persona）语义

- 桥接维护 `current-on-duty`（`state/persona-schedule.json` 里的 `onDuty` 字段）✓
- **每天 05:00（北京时间）** 只改这一个字段 ✓ —— **不写角色卡、不重建会话** ✓
- 非值班 worker：`wait` 返回 `idle: true, reason: "not-on-duty"` ✓，**继续轮询** ✓
- 值班者掉线（`lastWorkerSeenAt` > 5 分钟）→ 桥接按 `config.transport.fallback` 处理：
  - `"dsh"`（默认）→ 该回合回落给 DSH 处理 ✓（保证不哑火 ✓）
  - `"none"` → 只在日志与 `status` 里告警 ✓

---

## 6. 错误码汇总

| HTTP | error | worker 动作 |
|---|---|---|
| 204 | —（空体） | 立刻再 `wait` ✓ |
| 200 | `idle:true, reason:"not-on-duty"` | 5~10 秒后再 `wait` ✓ |
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
| — | — | — | — |
