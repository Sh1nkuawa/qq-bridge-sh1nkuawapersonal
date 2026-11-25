# AGY 交接（给新会话的 agent）

> 2026-11-25 19:35 更新（第二轮）。**先读这一份**，再动手 ✓
> 目标：把「大脑」从 DSH 会话切到 **Antigravity worker**（省 API 钱），同时**保留**现有提示词管线。

---

## 1. 现状（一句话）

```
按人格分流已上线 ✓  小鲸鱼 → DSH   猫娘侍从 → AGY（**已实测跑通** ✓ 见 §1.3）
transport = "agy" ✓   v1.1 修完 6 个"看起来跑了、其实没生效"的坑 ✓
v1.3 已对接 AGY 侧在契约 §10 登记的三条（@人 / 只读 OneBot / prompt 措辞）✓   套件 77/77 ✓
当前值班：**猫娘侍从**（2026-11-25 20:40 手动切过去做实测；05:00 会自动切回小鲸鱼）
worker：**在线**（AGY 侧新增了 duty-watcher sidecar 自动拉会话，见 §1.4）
```

### 1.6 v1.5（2026-11-26 01:0x）—— 热聊窗口

**问题**（owner 明确要求，AGY 侧在契约 §10 登记）：bot 回完一句就结束回合、群停在 `diving`
⇒ 群友接着聊（不带 @/关键词）**再也唤不醒它**。00:08 实测：`@bot` 回复后 87 秒，
owner 追问「看看你的功能点是否正常」——零唤醒，对话断掉。

**实现**（§5.2 有完整规则表）：

- `st.hotChatUntil` **滑动窗口**：每次成功发言（`sent > 0`）刷新到 `now + 5min`
  （本群已实测：01:04:03 发 2 条 → 窗口设上，还剩 257s）
- 窗口内普通消息也能唤醒，新理由 `hotChat`（优先级 45）
- 显式潜水（`wake-config` 判定 sleeping）**清空**窗口
- 窗口内限流放宽到 `hotChatMaxWakePerMinute`（默认 3）
- `hotChatUntil` **落盘**（重启后仍然"刚聊起来"）
- AGY `complete` 在 `sent>0` 后补调 `scheduleReplyCheckV2`（对齐 DSH）
- `recommendedKeywords` 加「猫娘」「侍从」
- 纯逻辑在 `src/hot-chat.js` + `scripts/test-hot-chat.mjs`（7 组回归）
- 配置：`socialV2.wake.hotChatWindowMs`（默认 300000，**0 = 关闭**）、`hotChatMaxWakePerMinute`

> 还没在群里看到一次真实 `hotChat` 唤醒样本（验收时群里 2 分钟没人说话）。
> **下次有人接着聊**时，日志里应该出现 `[reserved2] 唤醒 group:… （hotChat）` —— 看到这行才算闭环。✓

### 1.5 v1.3（2026-11-25 22:0x）

AGY 侧在 `docs/AGY_CONTRACT.md` §10 登记了三条，桥接侧全部落地：

1. `POST /api/agy/complete` 增加可选 **`atUserId`**（真的 @ 到人）：5~12 位纯数字，脏值**静默丢弃**，
   只作用于第一条 replies。规范化在 `src/agy-transport.js` 的 `complete()`，有回归 ✓
2. 新增 **`GET /api/agy/onebot`**（见契约 §3.7）：白名单只有
   `get_group_list` / `get_group_member_list` / `get_group_msg_history` 三个**只读**动作，
   群号必须过 `config.allow/deny`，没有任何写操作。**实测三个都通**（`get_group_msg_history` 也能用 ✓）
3. **prompt 措辞同步**：AGY 侧已落地 `scripts/agy-api.mjs`（20+ 子命令，涵盖 wake-config / wait /
   prompt / 表情包 / 拍一拍 / 生图 / **`message-images` 落盘 + 原生读图** / `agy-quota`），
   所以【AGY 值守模式】不再说"你没有任何工具 / 看不到图"（旧事实会和 CLI 打架 ✗），
   改成"没有 MCP 的 qq_* 工具；扩展动作走 `node scripts/agy-api.mjs`"。
   预算：覆盖说明 1007 字、落盘短提示 1341 字（< 2500 上限 ✓）
4. 余额查询**不做**了：AGY 人格跑 Gemini，报 DeepSeek 余额本来就不对路，AGY 侧用 `agy-quota` ✓

### 1.3 2026-11-25 20:40–20:50 的 AGY 实测（真跑通了）

手动 `POST /api/role {"role":"猫娘侍从"}` 切班后：

| 时间 | 回合 | 结果 |
|---|---|---|
| 20:41:33 | `admin` 主动唤醒 | `prompt 21031 字节 → 落盘 → worker 认领 → 28s 完成 → 发送 0 条`（8 条未读都是群友斗嘴、没人找它，选择潜水 ✓）+ `收尾已读：8 条` |
| 20:43:59 | `atMention` 唤醒 | `20670 字节 → 落盘 → 14s → 发送 1 条` ✓ |
| 20:49:51 | `atMention` 唤醒（重启后） | `19264 字节 → 落盘 → 16s → 发送 1 条`（"捞起来了，11g下啥了"）+ `收尾已读：3 条` |

- 切班时 `rebuilt:["group:541026885"]`、`droppedTurns:0`、`persona-schedule.json` 的 `onDuty` 同步成猫娘 ✓
- 桥接重启**不会**把 worker 弄死：20:48:11 重启，worker 20:48:34 自动接回（`stale=false`）✓
- ⚠️ 顺手发现第 6 个坑（见下表）：AGY 回合发完话**没把自己发的消息记回上下文**

### 1.4 AGY 侧新交付（他们的文件，我只负责提交 ✓）

- `agy-plugin/sidecars/agy-duty-watcher/`（`sidecar.json` + `watcher.mjs`，312 行）：
  每 10 秒读 `/api/agy/status`，**`dutyTransport` 切到 `agy`（05:00 换班或手动切班）或上一轮值守会话轮满下班时**，
  就在 `geminiqq` 项目里自动开一个干净会话当 worker（默认 Gemini 4 Hydrogen Medium），
  保证上下文不超限。它**只读** `config.json` / `state/console-token`，不改桥接侧文件 ✓
- `agy-plugin/agents/qq-chat-worker.md`、`agy-plugin/skills/**`、`install.ps1`、`plugin.json` 同步更新
- `scripts/agy-lib.mjs`、`scripts/agy-self-test.mjs` 小改（适配新的 idle 理由 / 自检）
- 这些都是他们写的，**2026-11-25 21:0x 随我的修复一起提交**（commit `8884951`，因为规则是"只有桥接侧 commit"✓）

> ⚠️ 现在的实际效果：**猫娘当班 ⇒ AGY**（省钱 ✓）；小鲸鱼当班 ⇒ DSH（照旧花钱，owner 的选择）。
> 想切回小鲸鱼：`POST /api/role {"role":"小鲸鱼"}`（**注意 PowerShell 会把中文角色名弄乱**，
> 用 `node -e` 写文件脚本发，别用 `Invoke-RestMethod` 内联中文 ✗）。

### 1.0 按人格分流（owner 2026-11-25 追加）

```json
"personaSchedule": { "personas": {
  "小鲸鱼":   { "transport": "dsh" },
  "猫娘侍从": { "transport": "agy" }
}}
```

- 规则：全局 `transport` 不是 `agy` ⇒ 一律 DSH；persona 显式写了就听它的；没写就跟随全局
- 实现：`src/persona-transport.js`（纯函数，10 组回归 ✓）+ `deliverPromptNow` 开头按值班者判定
- `status` 能直接看：`dutyTransport`（这一位现在走哪边）、`personaTransport`（每个人格的去向）
- 想改：只改 `config.json` 的 `personas[名字].transport` 并重启（**不用改代码** ✓）

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
| 6 | **自己发的消息没记回上下文** | 其他所有发送路径都会 `recordSentMessagesV2` + 更新 `lastAiReplyAt`，只有 AGY 的 `complete` 漏了 ⇒ 下一轮 prompt 的【最近对话】里没有自己刚说的话、「你上次发言 N 分钟前」永远不对、心情/回复检查全基于陈旧状态 | `complete` 发送成功后补记录（实测 20:50 那条已进 `recentMessages`、`lastAiReplyAt` 同步） |

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
| `src/persona-transport.js` | **新**：按人格分流（小鲸鱼 dsh / 猫娘 agy）的纯判定 + 路由表 —— 10 组回归 ✓ |
| `src/bridge.js` | 6 个 `/api/agy/*` 端点、`agyReleaseTurn()`、`agySweepTick()`、`deliverPromptNow`（分流 + 快照 + 落盘 + fallback）、`applyPersonaSwitch()`、按 persona 的心跳 |
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
9. **`cfg` 是 `main()` 里的局部变量** ✗✗ —— 模块作用域的函数**不能**引用它（我会写成 `cfg?.x`，
   可选链救不了未声明的标识符 ✗）。2026-11-25 把 `personaTransportOf` 放到模块级，`test-audit-bridge`
   直接 `cfg is not defined`；生产里则是**每次唤醒都 ReferenceError**，而且只在真的唤醒时才炸。
   放 `main()` 里面、或把值当参数传进去 ✓
10. **`test-dsh-auth.mjs` 偶发红** —— 它真的去打本地 DSH 铸 Cookie；全量跑时偶尔和别的用例撞车。
   单独跑 `node scripts/run-offline-tests.mjs dsh-auth` 通常就绿 ✓（别当成自己改坏了）
11. **绝对不要用 PowerShell 的 `Get-Content -Raw | Set-Content` 去改源码** ✗✗
    （2026-11-25 踩过：`bridge.js` 被按 GBK 整份重写，3521 行中文全乱码，`node --check` 直接报
    "Invalid or unexpected token"。只能 `git checkout -- <file>` 回 HEAD 再重做改动。）
    改代码只用编辑器/edit 工具；批量文本替换用 node 脚本（`fs.readFileSync`/`writeFileSync` 都是 UTF-8 ✓）
12. **重启桥接会掐断 AGY worker 的长轮询** ⚠️ —— 他们的脚本会重试几次（日志 `error ECONNRESET/ECONNREFUSED`
    → `recovered`），但 **Antigravity 那边的对话可能就此结束**，之后要人工/侧车重开值守会话。
    2026-11-25 一晚踩了三次（22:20 自己接回，22:57 那次没回来）。所以：
    **改动攒着一次重启**，别改一处重启一次；重启后**立刻**看 `status.workerSeenByPersona` 有没有新心跳，
    没有就提醒 owner 在 Antigravity 重开；队列里没人认领的回合会在 5 分钟后被 sweep 丢弃（消息留在未读）✓

---

## 4. 怎么验证（不打扰群里的做法 ✓）

```powershell
cd D:\dsh\qq-bridge
node scripts/mock-agy-worker.mjs --status                    # transport / 队列 / 心跳 / dutyTransport / personaTransport
node scripts/test-agy-transport.mjs                           # 23 组协议回归
node scripts/test-agy-prompt.mjs                              # 11 组 prompt 拼装回归
node scripts/test-persona-transport.mjs                       # 10 组"谁走 DSH / 谁走 AGY"分流回归
node scripts/run-offline-tests.mjs                            # 全量 77/77
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

已实测通过（2026-11-25 19:28 / 19:32 两次，最终版代码）：
`prompt 20701 字节 → 落盘 → worker 拿到 1002 字短提示 → 落盘文件里有 8 条真实消息快照
（seq 53260…）→ complete → 收尾已读：8 条（水位 53275）` ✓

> 判断"真的生效"看这几行，别只看进程活着：
> `[agy] 值班者「X」掉线（Ns 没心跳）→ 本次回落 DSH` / `[agy] prompt N 字节 > 8192，已落盘 …` /
> `[agy] 收尾已读：N 条（水位 M）`。这三行 2026-11-25 之前**一行都不会出现**（就是那几个坑）。

`state/agy-worker.log` = **AGY 侧的日志**（单行 JSON ✓，我读它判断对方有没有走对 ✓）。

---

## 5. 待办（按优先级）

| # | 事 | 备注 |
|---|---|---|
| 1 | **给猫娘侍从起 AGY worker** ✗ | 小鲸鱼的活已经分流到 DSH（worker 拿到 `persona-on-dsh`，正常）；**只有猫娘当班时 AGY 才真的省钱**，而它现在没有 worker ⇒ 猫娘一当班就回落 DSH |
| 2 | **观察一晚** | 看 `[agy] 值班者「X」掉线（Ns 没心跳）→ 本次回落 DSH`（正常兜底）/ `[agy] 值班者「小鲸鱼」按 persona 配置走 DSH`（分流生效，每人格只打一次）/ `收尾已读：N 条` / `prompt N 字节 > 8192` |
| 3 | **明天的 05:00** | 换成猫娘侍从之后：`status` 的 `dutyTransport` 应该变成 `agy`；有 worker 就进队列，没有就回落 DSH（不哑火 ✓） |
| 4 | 生图 / 拍一拍 / 黑话提交 CLI | 价值低，按需（`agy-tools.mjs` 里加子命令即可） |
| 5 | **唤醒频率限制会直接丢消息** ⚠️ | `maxWakePerMinute: 1`：一分钟内的第二条 `@` 会被**跳过**（不是延迟），群里看起来就是"不理人"。要改就得改成"延后到窗口结束再试"，别直接丢 |

---

## 6. 协作规则（和 Antigravity 那边的 agent）

- **它只改** `agy-plugin/**`、`scripts/agy-*.mjs`；**我只改** `src/**`、`scripts/test-*.mjs`、`scripts/agy-tools.mjs`、`scripts/mock-agy-worker.mjs`、`docs/**`
- **只有我 commit/push** ✓
- 它反馈问题 → 我改 → 我重启桥接 → 它续测（已经跑过三轮，很顺 ✓）
- 卡住时的唯一通道：`state/agy-worker.log` ✓（我看不到它的窗口 ✗）
- 这一轮**不需要它改代码**：协议仍是 v1（只加了字段和一个 idle 理由）✓
  ⚠️ 唯一要它知道的新情况：小鲸鱼的人格被分流到 DSH，它的 worker 轮 `小鲸鱼` 时会一直拿到
  `idle: persona-on-dsh` —— **那是正常的**，不是被踢下线 ✓

---

## 7. 不要做的事 ✗

1. 别把 `transport` 改回 `dsh` **除非要应急**（改回就又开始花 API 钱 ✓；fallback 已经兜住掉线了 ✓）
2. 别删 `state/agy-worker.log`（排障唯一依据 ✓）
3. 别在群里说"我在测试"（对外就是一个普通 bot ✓）
4. 别忘了 `docs/FOLDER_MAP.md`：**新增 `docs/*.md` 必须被它点到** ✓，否则 `test-foldermap-facts` 会红 ✗
5. 别在群里做"换人格/清会话"的实验 ✓ —— 手动切角色会真的换掉群里说话的人格，
   想验"镜像不敢覆盖角色卡"就直接改 `state/persona-schedule.json` 再读 `status`（这一轮就是这么验的 ✓）
