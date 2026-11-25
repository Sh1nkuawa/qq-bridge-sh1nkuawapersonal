# AGY worker 任务包（交给 Antigravity 那边的 agent）

> 你（Antigravity 里的 agent）要做的是**一半的活**：桥接侧（`src/**`）由 DSH 那边负责，
> 你只做 **`agy-plugin/**` 和 `scripts/agy-*.mjs`**。
> 契约在 **[`docs/AGY_CONTRACT.md`](AGY_CONTRACT.md)** —— 先读它，再动手。

---

## 0. 一句话目标

群里有消息时，桥接会把「唤醒提示词」放进队列；**你要在 Antigravity 窗口里跑一个脚本，
把活取出来、交给模型、再把模型的话送回去**。提示词里的东西（人格/心情/消息快照）
**原样使用，不要改写、不要截断** ✗。

---

## 1. 先做什么（按顺序，不要跳）

### 第 1 步：跑通 mock（不碰 Antigravity）

桥接侧已经有 `scripts/mock-agy-worker.mjs`（假 worker）✓ —— **先读它**，
把它当成"协议的可执行文档"，确认你理解了 `wait → claim → complete` 的节奏 ✓。

```powershell
# 桥接侧需要先把 config.json 的 transport 改成 "agy" 并重启（DSH 那边会做）
node scripts/mock-agy-worker.mjs --status
node scripts/mock-agy-worker.mjs --persona 小鲸鱼 --rounds 2
```

### 第 2 步：写两个脚本（你的主要交付）

| 文件 | 作用 | 关键要求 |
|---|---|---|
| `scripts/agy-wait-wake.mjs` | 领一个回合，**把 prompt 原样打印到标准输出**（供 Antigravity 的 `run_command` 捕获）| 单次调用只处理**一个**回合；无活（204）就打印 `IDLE` 并退出 |
| `scripts/agy-reply-and-wait.mjs` | 把 agent 写好的回复**送回**桥接，然后可以顺手再领下一个 | 支持 `--batch <json>` 与 `--batch-stdin`（PowerShell 吞引号 ✗，stdin 更稳 ✓）|
| `scripts/agy-status.mjs`（小） | 打 `GET /api/agy/status` | 供你自检 |

**日志**：一律追加到 `state/agy-worker.log`，格式见契约 §7 ✓（单行 JSON）

### 第 3 步：`agy-plugin/`

```
agy-plugin/
  plugin.json          插件声明
  install.ps1          安装（把技能/命令挂进 Antigravity）
  mcp_config.json      （如需要）
  agents/qq-chat-worker.md      agent 的指令：循环「跑 wait → 看 prompt → 写回复 → 跑 reply」
  skills/qq-bot-operator/SKILL.md   技能说明（含"一次只处理一个回合""别多发确认消息"）
```

`agents/qq-chat-worker.md` 里要写清楚**三条铁律**：

1. **一次只处理一个回合** ✓（不要并发领）
2. **`complete` 之后就结束了** ✓ —— 不要额外再发一句"已发送" ✗
3. **prompt 里的内容原样使用** ✓ —— 不总结 ✗、不截断 ✗、不加自己的前言 ✗

---

## 2. 必须处理的四个已知坑（我们踩过 ✓）

| 坑 | 现象 | 做法 |
|---|---|---|
| **Antigravity 后台通知 ~10KB 截断** | 长 prompt 中间被裁掉 ✗ | 桥接已把 >8KB 的 prompt 落盘到 `state/agy-context-<turnId>.md` ✓（2026-11-25 起真的生效）；worker 拿到的会是**短提示 + 文件路径**，让模型自己 `view_file` 读 ✓ |
| **PowerShell 吞双引号** | `--batch '{"reply":[...]}'` 里的引号消失 ✗ | 优先 `--batch-stdin` + 这里 문서 `@' ... '@` 原样传 ✓（我们移植了他们的三层兜底思路 ✓）|
| **同一回合被领两次** | 两条重复回复 ✗ | `claim` 返回 `409 already-claimed` ⇒ **立刻重新 `wait`** ✓，不要报错退出 |
| **租约过期** | 长任务（看图/生图）超过 10 分钟 ✗ | 每 2~3 分钟 `POST /api/agy/touch` ✓ 续期 |

---

## 3. 不该做的（违反 = 返工 ✗）

1. **不要** `git add/commit/push` ✗（只有 DSH 那边提交）
2. **不要**改 `src/**`、`config.json`、`state/*.json`（除 `agy-worker.log`）✗
3. **不要**把令牌、完整 prompt、群友 QQ 号写进日志 ✗
4. **不要**在 `204`（正常空闲）时退避很久 ✗ —— 5~10 秒后再轮询 ✓
5. **不要**在非值班时退出 ✗ —— `idle: not-on-duty` 是正常状态 ✓，继续轮询 ✓
6. **不要**自己判断"这句话该不该发" ✗ —— 那是桥接的**双态判定**与**人格**已经在 prompt 里说清楚了 ✓

---

## 4. 验收（跑通 = 这 6 条全 ✓，见契约 §8）

1. `GET /api/agy/status` 返回 `transport: "agy"` ✓
2. 空转不刷屏不退出（`wait` 间隔 5~10 秒）✓
3. 群里 @ 一次 → 你取到回合 → 回 1 条 → **群里真的收到** ✓
4. 回两条 → **真的分两条发** ✓（不是空格拼接 ✗）
5. 假 `turnId` → `404`，脚本不崩 ✓
6. 卡 11 分钟 → 回合被**重排**（`attempts:1`）✓，且**没有半成品发到群里** ✓

---

## 5. 卡住时怎么和我对齐

1. 把现象写进 `state/agy-worker.log`（**这是唯一通道** ✓ —— 我看不了你的窗口 ✗）
2. 需要契约变更（加字段/加端点）→ 在 `docs/AGY_CONTRACT.md` §10「变更请求」里**登记一行** ✓
   （你只登记 ✓，不要自己改端点实现 ✗）
3. 不要试图改桥接侧来"适配"你的实现 ✗ —— 契约是唯一依据 ✓

---

## 6. 现状（DSH 那边已经做完的）

- ✅ `src/agy-transport.js`：队列 + 长轮询 + 租约 + 重排上限 + 落盘改写 + 换班清队列（23 组回归 ✓）
- ✅ `src/agy-prompt.js`：AGY 版 prompt 拼装（消息快照 / 值守覆盖说明 / 落盘短提示，11 组回归 ✓）
- ✅ `bridge.js` 6 个端点已接（`status/wait/claim/touch/requeue/complete` ✓），
  由 `config.transport === "agy"` 控制 ✓（默认 `dsh` 不受影响 ✓）
- ✅ `scripts/mock-agy-worker.mjs`：假 worker，可直接跑通协议 ✓
- ✅ `scripts/agy-wait-wake.mjs` ✓、`scripts/agy-reply-and-wait.mjs` ✓、`agy-plugin/**` ✓
- ⏳ **现在只差一件：把值守 worker 跑起来**（2026-11-25 18:47 之后它就停了，
  桥接只能回落 DSH 顶着，等于还在花 API 钱 ⚠️）。起来之后不用改代码，
  照 `agy-plugin/agents/qq-chat-worker.md` 的循环跑就行 ✓
- ⏳ 之后（不阻塞你）：把 `qq_speak` / 表情 / 生图 / 记忆封成 CLI ✓ —— 前三个已有
  （`scripts/agy-tools.mjs` 的 `voice` / `sticker` / `memory-*`），生图还没做 ✓
