# AGY 交接（给新会话的 agent）

> 2026-11-25 19:35 更新（第二轮）。**先读这一份**，再动手 ✓
> 目标：把「大脑」从 DSH 会话切到 **Antigravity worker**（省 API 钱），同时**保留**现有提示词管线。

---

## 1. 现状（一句话）

```
transport = "agy" ✓   v1.1 修完 5 个"看起来跑了、其实没生效"的坑 ✓   套件 76/76 ✓
worker 侧：**离线中**（Antigravity 窗口 18:47 之后就没再轮询）⇒ 现在靠 fallback 回落 DSH 撑着
```

链路：`QQ → 桥接 → buildWakePromptV2 + 消息快照 + AGY 值守说明 → 队列 → worker 取/回 → sendMessagesV2 → QQ`

- 详细契约：**[`docs/AGY_CONTRACT.md`](AGY_CONTRACT.md)**（端点/Turn/租约/错误码/日志格式）
- 它那一侧的任务包：**[`docs/AGY_WORKER_TASK.md`](AGY_WORKER_TASK.md)**

### 1.1 这一轮修掉的（都有测试/实测证据 ✓）

| # | 坑 | 现象 | 修法 |
|---|---|---|---|
| 1 | **prompt 里没有消息快照** | AGY 的 agent 没有任何 QQ 工具，只能看到"未读 8 条"+最后 30 字 ⇒ 两轮 `sent:0`、回得莫名其妙 | `deliverPromptNow` 的 agy 分叉里拼 `【本次消息快照】`（`buildWakeSnapshotV2(key,{force:true})`，force 绕过 DSH 专用的开关） |
| 2 | **`收尾已读` 从来没触发** | `readThroughSeqV2(st)` 只认 `modelSeenSeqs`，AGY 没有工具调用 ⇒ 永远是 0 ⇒ 未读只增不减 | 回合入队时把快照水位存进 `turn.readThroughSeq`，`complete` 后按它 `acknowledgeMessagesV2` + `saveSocialV2State()` |
| 3 | **心跳只按"任意人格"记** | 05:00 换班后旧人格 worker 还在每 7 秒轮询（永远 `idle:not-on-duty`），把"最近心跳"刷得很新 ⇒ 判定"值班者还在" ⇒ 新人格没人接 ⇒ **哑火且无日志** | 心跳改成 `Map<persona, at>`；fallback 只看**当前值班者**的心跳（`onDutyStale`） |
| 4 | **worker 挂在长轮询时，入队立刻唤醒它** | 落盘改写还没做完，worker 已拿到 20446 字节全文 ⇒ 后台通知截断，等于没落盘 ✗ | `enqueue({notify:false})` → 落盘 + `setPrompt` → 才 `wake(persona)` |
| 5 | **`agySweepTick` 调 `agyReleaseTurn` 是 ReferenceError** | 前者在模块作用域、后者在 `main()` 里；只有"超过重排上限"那条分支会踩到，被 catch 吞成 `sweep 失败` | 加模块级 `agyHooks.releaseTurn`，由 `main()` 注入 |

顺带修的：
- **`status` 多传的字段被静默丢掉**（`agyTransport.status()` 只认自己那几个具名参数）⇒ 扩展字段改为在端点里显式并进去
- **未读水位只在内存改** ⇒ 加 `saveSocialV2State()`，否则重启就"复活"
- **`state/agy-context-*.md` 会无限堆积** ⇒ 落盘时顺手清 24 小时前的
- **`prompt` 组装抽成 `src/agy-prompt.js`**（纯函数）+ `scripts/test-agy-prompt.mjs`（11 组断言），
  因为这段字符串拼错**不会报错**，只会在群里表现为"答非所问"✗

### 1.2 05:00 换班（原待办 #2）—— 已接线

`personaTick` 现在走 `applyPersonaSwitch()`（控制台手动切角色也走同一条 ✓）：
写角色卡 → 同步 `persona-schedule.json` 的 `onDuty` 镜像 → 重建 DSH 会话 → **AGY 模式清掉旧人格
没被认领的回合**（新值班者永远不会来取，不清就永远占着"会话繁忙"）。

- **角色卡是唯一真相**，`onDuty` 只是镜像。反过来让镜像说话会出事故：文件残留旧值 ⇒ worker 全拿
  `not-on-duty` ⇒ 哑火且没有日志线索。**实测**：手动把 `onDuty` 改成「猫娘侍从」，`status` 仍报
  `onDuty: 小鲸鱼` ✓
- 真正的 05:00 还没跑过（今天 05:00 桥接没跑）。**明天 05:00 看这条日志**：
  `[persona] 2026-11-26 05:00 切换到「猫娘侍从」…`
  ⚠️ 换过去之后 AGY 那边必须有**猫娘侍从**的 worker，否则一直是 DSH 顶着（fallback 不会哑火 ✓）

---

## 2. 关键文件地图

| 文件 | 作用 |
|---|---|
| `src/agy-transport.js` | 队列 + 长轮询 + 租约 + 重排 + `setPrompt` / `dropUnclaimed` / `wake`（**纯逻辑**，23 组回归 ✓ 改它必须先跑 `test-agy-transport.mjs`） |
| `src/agy-prompt.js` | **新**：AGY prompt 的拼装片段（快照块 / 值守覆盖说明 / 落盘短提示 / 8KB 阈值）—— 11 组回归 ✓ |
| `src/bridge.js` | 6 个 `/api/agy/*` 端点、`agyReleaseTurn()`、`agySweepTick()`、`deliverPromptNow` 的 agy 分叉 + fallback、`applyPersonaSwitch()`、按 persona 的心跳 |
| `scripts/mock-agy-worker.mjs` | 假 worker（不依赖 Antigravity 测协议 ✓）；新增 `--silent`（`replies:[]`）与 `--dump-prompt <path>` 用于**不打扰群里**的验证 |
| `scripts/agy-*.mjs` | **AGY 侧写的**（不要改 ✗）：`agy-lib` / `agy-wait-wake` / `agy-reply-and-wait` / `agy-self-test` / `agy-status` / `agy-touch` |
| `scripts/agy-tools.mjs` | **我写的**：`memory-list` / `memory-add` / `sticker` / `voice`（替代 AGY 模式下调不到的 MCP 工具） |
| `agy-plugin/**` | AGY 侧写的 Antigravity 插件/技能/agent 指令 |
| `config.json` | `transport: "agy"` ✓ / `transportFallback`（默认 true ✓ 掉线 5 分钟回落 DSH）/ `personaSchedule.personas` |

---

## 3. ⚠️ 踩过的坑（**别再犯** ✗）

1. **`loadConfig()` 是白名单式重建** ✗✗ —— 在 `config.json` 里加字段 **必须同时在 `loadConfig()` 里显式搬** ✓，
   否则进程里永远是 `undefined` ✓ 且**不报错** ✗。已踩两次（`personaSchedule`、`transport`）。
2. **`st.pendingWakeReasons` 是数组** `[{reason,seq,at}]` ✗ —— 不能 `Object.keys()`（会得到 `"0"` ✗）。
3. **定时器要真的挂上** ✗ —— `sweep()` 写了 17 组回归全绿 ✓，但**没人 setInterval 调它** ✗ ⇒ 超时永不重排 ✗。
   教训：**纯逻辑测试全绿 ≠ 功能在跑** ✓，要看有没有人调它。
   （这一轮的 #3/#5 也是同一类：**日志里一切正常，但那条分支根本没被走到** ✓）
4. **worker 的 fetch 必须带超时** ✗ —— 桥接重启会掐断长轮询 ✓，没超时脚本就**永久僵住**（进程活着但不干活 ✗）。
5. **内联 `node -e` / PowerShell 复杂表达式反复出错** ✗（引号、`??`、模板字符串）——
   **一律写文件脚本再跑** ✓（本仓库 `C:\Temp\*.mjs` 就是这么来的 ✓）。
6. **推送**：`git push` 偶发 `Connection reset` ✗ —— 先试 git 配置的代理（9674）✓，失败再 `-c http.proxy= -c https.proxy=` 直连 ✓。
7. **`log()` 会把绝对路径打码成 `***`** —— 落盘日志里看不到文件路径是**正常**的，路径在 prompt/文件系统里 ✓。
8. **改完任何 `src/**` 都要重跑 `node scripts/gen-file-index.mjs`** ✗ —— 否则 `test-foldermap-facts` 红 ✓。

---

## 4. 怎么验证（不打扰群里的做法 ✓）

```powershell
cd D:\dsh\qq-bridge
node scripts/mock-agy-worker.mjs --status                    # transport / 队列 / 心跳（看 onDutyStale）
node scripts/test-agy-transport.mjs                           # 23 组协议回归
node scripts/test-agy-prompt.mjs                              # 11 组 prompt 拼装回归
node scripts/run-offline-tests.mjs                            # 全量 76/76
Get-Content state\bridge.log -Encoding UTF8 | Select-String '\[agy\]' | Select-Object -Last 15
```

**不往群里发消息的端到端自检**（这一轮就是这么验的 ✓）：

```powershell
# ① 挂着 mock（只领一个回合，回 replies:[]，不发言）
node scripts/mock-agy-worker.mjs --persona 小鲸鱼 --silent --rounds 1 --dump-prompt state\mock-prompt.txt
# ② 另一个窗口手动唤醒（会真的入队）
$tok = (Get-Content state\console-token -Raw).Trim()
Invoke-RestMethod -Method Post -ContentType 'application/json' `
  -Body '{"key":"group:541026885","reason":"admin"}' `
  -Uri "http://127.0.0.1:3100/api/socialV2/wake?token=$tok"
# ③ 看 mock 的输出与 state\mock-prompt.txt：短提示里应有落盘路径；落盘的 .md 里应有【本次消息快照】
# ④ 日志里应出现：prompt N 字节 > 8192，已落盘 … / 收尾已读：N 条（水位 M）/ 回合完成 … 发送 0 条
```

已实测通过（2026-11-25 19:28）：
`prompt 20837 字节 → 落盘 → worker 拿到 1019 字短提示 → 快照里 8 条真实消息（seq 53260…）→ complete → 收尾已读：8 条（水位 53267）` ✓

`state/agy-worker.log` = **AGY 侧的日志**（单行 JSON ✓，我读它判断对方有没有走对 ✓）。

---

## 5. 待办（按优先级）

| # | 事 | 备注 |
|---|---|---|
| 1 | **把 AGY worker 叫起来** ✗ | 18:47 之后它就没轮询过（日志停在 `complete t-202611251836-0001`）。**现在全靠 DSH fallback 顶着 = 一直在花 API 钱** ⚠️ |
| 2 | **观察一晚** | 看 `[agy] 值班者「X」掉线（Ns 没心跳）→ 本次回落 DSH`（正常兜底）/ `收尾已读：N 条` ✓（#2 生效）/ `prompt N 字节 > 8192`（落盘生效） |
| 3 | **明天的 05:00** | 看换班日志 + 猫娘侍从有没有 worker；换班瞬间旧人格未认领回合应被清掉 |
| 4 | 生图 / 拍一拍 / 黑话提交 CLI | 价值低，按需（`agy-tools.mjs` 里加子命令即可） |
| 5 | **唤醒频率限制会直接丢消息** ⚠️ | `maxWakePerMinute: 1`：一分钟内的第二条 `@` 会被**跳过**（不是延迟），群里看起来就是"不理人"。要改就得改成"延后到窗口结束再试"，别直接丢 |

---

## 6. 协作规则（和 Antigravity 那边的 agent）

- **它只改** `agy-plugin/**`、`scripts/agy-*.mjs`；**我只改** `src/**`、`scripts/test-*.mjs`、`scripts/agy-tools.mjs`、`scripts/mock-agy-worker.mjs`、`docs/**`
- **只有我 commit/push** ✓
- 它反馈问题 → 我改 → 我重启桥接 → 它续测（已经跑过三轮，很顺 ✓）
- 卡住时的唯一通道：`state/agy-worker.log` ✓（我看不到它的窗口 ✗）
- 这一轮**不需要它改代码**：协议 v1 没变，只是桥接侧把该给的东西给全了 ✓

---

## 7. 不要做的事 ✗

1. 别把 `transport` 改回 `dsh` **除非要应急**（改回就又开始花 API 钱 ✓；fallback 已经兜住掉线了 ✓）
2. 别删 `state/agy-worker.log`（排障唯一依据 ✓）
3. 别在群里说"我在测试"（对外就是一个普通 bot ✓）
4. 别忘了 `docs/FOLDER_MAP.md`：**新增 `docs/*.md` 必须被它点到** ✓，否则 `test-foldermap-facts` 会红 ✗
5. 别在群里做"换人格/清会话"的实验 ✓ —— 手动切角色会真的换掉群里说话的人格，
   想验"镜像不敢覆盖角色卡"就直接改 `state/persona-schedule.json` 再读 `status`（这一轮就是这么验的 ✓）
