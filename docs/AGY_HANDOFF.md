# AGY 交接（给新会话的 agent）

> 2026-11-25 由上一个会话整理。**先读这一份**，再动手 ✓
> 目标：把「大脑」从 DSH 会话切到 **Antigravity worker**（省 API 钱），同时**保留**现有提示词管线。

---

## 1. 现状（一句话）

```
transport = "agy" 已上线 ✓   验收 7 条全绿 ✓   fallback 已兜底 ✓   套件 75/75 ✓
```

链路：`QQ → 桥接 → buildWakePromptV2 拼 prompt → 队列 → worker 取/回 → sendMessagesV2 → QQ`

- 详细契约：**[`docs/AGY_CONTRACT.md`](AGY_CONTRACT.md)**（端点/Turn/租约/错误码/日志格式）
- 它那一侧的任务包：**[`docs/AGY_WORKER_TASK.md`](AGY_WORKER_TASK.md)**

---

## 2. 关键文件地图

| 文件 | 作用 |
|---|---|
| `src/agy-transport.js` | 队列 + 长轮询 + 租约 + 重排（**纯逻辑**，17 组回归 ✓ 改它必须先跑 `test-agy-transport.mjs`） |
| `src/bridge.js` | 6 个 `/api/agy/*` 端点（搜 `action === '`）、`agyReleaseTurn()`、`agySweepTick()`、`deliverPromptNow` 里的 **agy 分叉 + fallback** |
| `scripts/mock-agy-worker.mjs` | 假 worker（不依赖 Antigravity 测协议 ✓） |
| `scripts/agy-*.mjs` | **AGY 侧写的**（不要改 ✗）：`agy-lib` / `agy-wait-wake` / `agy-reply-and-wait` / `agy-self-test` / `agy-status` / `agy-touch` |
| `scripts/agy-tools.mjs` | **我写的**：`memory-list` / `memory-add` / `sticker` / `voice` 四个子命令（替代 AGY 模式下调不到的 MCP 工具） |
| `agy-plugin/**` | AGY 侧写的 Antigravity 插件/技能/agent 指令 |
| `config.json` | `transport: "agy"` ✓ / `transportFallback`（默认 true ✓ 掉线 5 分钟回落 DSH）/ `personaSchedule.personas`（角色→模型映射） |

---

## 3. ⚠️ 今天踩过的坑（**别再犯** ✗）

1. **`loadConfig()` 是白名单式重建** ✗✗ —— 在 `config.json` 里加字段 **必须同时在 `loadConfig()` 里显式搬** ✓，
   否则进程里永远是 `undefined` ✓ 且**不报错** ✗。已踩两次（`personaSchedule`、`transport`）。
2. **`st.pendingWakeReasons` 是数组** `[{reason,seq,at}]` ✗ —— 不能 `Object.keys()`（会得到 `"0"` ✗）。
3. **定时器要真的挂上** ✗ —— `sweep()` 写了 17 组回归全绿 ✓，但**没人 setInterval 调它** ✗ ⇒ 超时永不重排 ✗。
   教训：**纯逻辑测试全绿 ≠ 功能在跑** ✓，要看有没有人调它。
4. **worker 的 fetch 必须带超时** ✗ —— 桥接重启会掐断长轮询 ✓，没超时脚本就**永久僵住**（进程活着但不干活 ✗）。
5. **内联 `node -e` / PowerShell 复杂表达式反复出错** ✗（引号、`??`、模板字符串）——
   **一律写文件脚本再跑** ✓（本仓库 `C:\Temp\*.mjs` 就是这么来的 ✓）。
6. **推送**：`git push` 偶发 `Connection reset` ✗ —— 先试 git 配置的代理（9674）✓，失败再 `-c http.proxy= -c https.proxy=` 直连 ✓。

---

## 4. 怎么验证（三条命令）

```powershell
cd D:\dsh\qq-bridge
node scripts/mock-agy-worker.mjs --status                    # transport / 队列 / 心跳
node scripts/agy-tools.mjs memory-list --key group:541026885 # 端点自检
Get-Content state\bridge.log -Encoding UTF8 | Select-String '\[agy\]' | Select-Object -Last 15
```

`state/agy-worker.log` = **AGY 侧的日志**（单行 JSON ✓，我读它判断对方有没有走对 ✓）。

---

## 5. 待办（按优先级）

| # | 事 | 备注 |
|---|---|---|
| 1 | **观察一晚** | 看有没有 `值班 worker 离线 → 回落 DSH` ✗（worker 不稳）/ `收尾已读：N 条` ✓（#2 生效） |
| 2 | **05:00 换班接上** ✗ | 现在 `personaTick` 仍走"换角色卡 + 重建会话" ✗；AGY 模式下应该只改 `onDuty` 或直接改角色卡（**不需要重建会话** ✓，因为没有会话 ✗） |
| 3 | 生图 / 拍一拍 / 黑话提交 CLI ✗ | 价值低，按需 |
| 4 | prompt >8KB 落盘（契约 §4） | 优化项：AGY 后台通知约 10KB 会截断 ✗ |

---

## 6. 协作规则（和 Antigravity 那边的 agent）

- **它只改** `agy-plugin/**`、`scripts/agy-*.mjs`；**我只改** `src/**`、`scripts/test-*.mjs`、`scripts/agy-tools.mjs`、`docs/**`
- **只有我 commit/push** ✓
- 它反馈问题 → 我改 → 我重启桥接 → 它续测（已经跑过两轮，很顺 ✓）
- 卡住时的唯一通道：`state/agy-worker.log` ✓（我看不到它的窗口 ✗）

---

## 7. 不要做的事 ✗

1. 别把 `transport` 改回 `dsh` **除非要应急**（改回就又开始花 API 钱 ✓；fallback 已经兜住掉线了 ✓）
2. 别删 `state/agy-worker.log`（排障唯一依据 ✓）
3. 别在群里说"我在测试"（对外就是一个普通 bot ✓）
4. 别忘了 `docs/FOLDER_MAP.md`：**新增 `docs/*.md` 必须被它点到** ✓，否则 `test-foldermap-facts` 会红 ✗
