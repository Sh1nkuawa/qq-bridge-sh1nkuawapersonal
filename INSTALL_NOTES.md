# qq-bridge 安装记录（本机 D:\dsh\qq-bridge）

安装时间：本次会话 · 目标 DSH 版本 `0.1.5-rc.1`
最近更新：**已合并上游 `v0.1.7`**（分支 `upgrade/v0.1.7`，适配 DSH `0.1.7-rc.2`）

---

## 〇、合并上游 v0.1.7（本次新增，先看这段）

上游 v0.1.7 是一次大改版。合并时**保留上游结构 + 重挂本副本的本地特性**，要点：

| 方面 | 上游 v0.1.7 的变化 | 本副本的处理 |
|---|---|---|
| 鉴权 | 不再从 guard 日志读 launch token；改用 `~/.dsh/.credentials.yaml` 里的浏览器会话签名密钥**离线铸造 Cookie** | 采用上游实现；本副本此前的 `dsh.authCookie` 补丁不再需要（已是死代码） |
| agent preset | preset 从 `~/.dsh/.agent-presets/<name>/` 目录改为 profile 里一条 `@deepseek-ai/dsh-agent-preset` 行；由 `plugins/qq-agent-presets/` 提供，patch 文件由 `scripts/build-agent-preset-patches.mjs` 生成 | 采用上游机制；本副本的规则（本地表情包库/卡牌图/余额/生图/关系档/投喂/群管理）重挂进 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的 **17~23 条**，改 preset 后要重新跑生成脚本 |
| 工具守卫 | `qq-tool-restrict.mjs` 权威实现移到 `plugins/qq-agent-presets/qq-tool-restrict.mjs`（preset 内文件只剩 re-export 壳） | 已把本副本的白名单前缀 `mcp__qq-wait__` 补进权威实现（否则「等待」工具会被安全边界误杀） |
| MCP 工具注册 | 新增 `TOOL_CONFIG_FLAGS` 注册期过滤（关掉的工具不注册，省 token） | 本副本的 6 个工具（`qq_send_meme` / `qq_group_admin_info` / `qq_request_mute` / `qq_propose_announcement` / `qq_generate_image` / `qq_get_balance`）已登记进该表 |
| 语音 | 新增 `qq_send_voice` / `qq_list_voices`，语音工具独立到仓库上一级 `../voice-tool/` | 语音默认**关闭**（`socialV2.voice.enabled=false`、`tools.sendVoice=false`）；本机未安装 `../voice-tool/`，因此语音相关用例（`test-voice*`、`test-console-static`、`test-encoding`、`test-snowluma-conn`）跑不了，属预期 |
| 审计测试 | `audit-bridge-harness.mjs` 重写（vm 里跑真实 bridge） | 该 harness 改成**按 bridge.js 的 import 自动注入 src/ 本地模块**，否则漏注入就会以 `xxx is not defined` 假失败 |

---

## 一、已完成 ✅

| 步骤 | 结果 |
|---|---|
| 克隆仓库 | `D:\dsh\qq-bridge`（v0.1.5，commit `dea3ce8`） |
| 安装依赖 | `npm install` → 128 包，4 秒；`postinstall` 补丁修补 `@snowluma/sdk` **13 个文件** |
| 生成配置 | `config.json`（由 `config.example.json` 生成，`sessionCwd` 指向本仓库） |
| 安装 DSH preset | `~/.dsh/.agent-presets/qq-chat`、`qq-chat-v2` ✅ |
| 挂载 MCP | `~/.dsh/profiles/web/cordis.patch.yml` 写入 3 条：`mcp-snowluma`、`mcp-snowluma-host`、`mcp-web-search-safe` ✅ |
| 注册插件 | `qq-mode-console` 已 link + 加入 profile bundles，`dsh plugin --profile web install` → OK ✅ |
| 运行模式 | `state/mode.json` → `reserved2`（二代仿真） ✅ |
| 下载 SnowLuma | `D:\dsh\snowluma`（v1.14.19 win-x64，自带 node.exe） ✅ |

**环境核对**：Node `v24.14.1`（要求 ≥22.13 ✅）· DSH `0.1.5-rc.1`（正是适配版本 ✅）· Java 17（SnowLuma 新版其实自带 Node，不需要 Java）

---

## 二、你需要做的 4 件事

### 1. 填 config.json

`D:\dsh\qq-bridge\config.json`：

```jsonc
{
  "ownerQQ": 你的QQ号,              // ← 管理员，管理命令只有它能用
  "allow": {
    "groups": [群号],               // ← 允许机器人说话的群
    "private": []
  }
}
```

> ⚠️ `allowAllWhenEmpty` 默认 `false` = 白名单为空时**不响应任何消息**（fail-closed，安全默认）。所以不填 `allow.groups` 机器人不会理人。

### 2. 启动 SnowLuma 并登录小号

双击 `D:\dsh\snowluma\launcher.bat`：

1. 首次运行会生成配置并打开 **WebUI**；
2. 在 WebUI 里**扫码登录机器人 QQ**（强烈建议小号，挂机器人有账号风险）；
3. 打开 **OneBot v11** 服务，确认端口：
   - WebSocket → `3001`（对应 `config.json` 的 `snowluma.wsUrl`）
   - HTTP → `3000`（对应 `snowluma.httpUrl`）
4. 如果给 OneBot 设了 accessToken，把它**同时**填进 `config.json` 的 `snowluma.accessToken`（HTTP 和 WS 两端必须一致，否则报 401）。

### 3. 重启 DSH（必须）

新 preset 和 MCP 工具**要重启 DSH 才生效**。

**推荐用我写的包装脚本启动**，它会自动抓取 launch token 写进配置：

```powershell
cd D:\dsh\qq-bridge
node scripts\dsh-with-token.mjs
```

它做的事：启动 `dsh web --no-open --port 3080` → 从 stdout 里抓 `?token=XXX` → 写进 `config.json` 的 `dsh.authToken`。

> **为什么要这么做**：DSH 0.1.5 的 launch token 是**进程内随机生成、只在启动 URL 里打印一次、不落盘**（见 `dsh-client-connection` 的 `processLaunchToken()`）。而 qq-bridge 的自动发现逻辑读的是 `~/.dsh/guard/logs/server-*.out.log`——当前 DSH 版本**没有这个目录**，所以自动发现必然失败，必须手动给 token。

### 4. 自检 + 启动桥接

```powershell
cd D:\dsh\qq-bridge
npm run self-test     # 验证 DSH 链路（不需要 QQ）
npm start             # 启动桥接
```

控制台：`http://127.0.0.1:3100`（模式切换、白名单、人格、黑话管理都在这里）

---

## 三、安装中踩到并修掉的坑

### 坑 1：`setup-dsh.mjs` 在中文用户名下装不上 preset

**症状**：

```
Error: EIO, Access is denied. '\\?\C:\Users\<you>\.dsh\.agent-presets\qq-chat'
    at copyDir (node:internal/fs/cp/cp-sync:145:22)
```

**原因**：Node 的 `fs.cpSync` 会构造 `\\?\` 长路径前缀，当路径含非 ASCII 字符（中文用户名）时，该前缀下的目录创建被系统拒绝。

**已修**：把 `scripts/setup-dsh.mjs` 的 `copyPreset()` 改成兼容实现（`copyTreeCompat`）：逐文件复制绕开长路径前缀，并带「先拷到 ASCII 临时目录再搬过去」的兜底。

**验证**：删掉两个 preset 目录后重跑 `node scripts/setup-dsh.mjs` → 完整重建，幂等性通过。

### 坑 2：launch token 拿不到（文档盲点）

见上文第 3 步。已提供 `scripts/dsh-with-token.mjs` 解决，另有 `scripts/probe-dsh-token.mjs` 可用来验证 token 是否有效。

---

## 四、我新增的脚本

| 脚本 | 用途 |
|---|---|
| `scripts/make-config.mjs` | 从 `config.example.json` 生成 `config.json`，并列出还需要你填的项 |
| `scripts/dsh-with-token.mjs` | **启动 DSH + 自动抓 launch token 写入配置**（解决坑 2） |
| `scripts/probe-dsh-token.mjs` | 验证一个 token 能不能换到 DSH Cookie |
| `scripts/cleanup-stale-sessions.mjs` | **清理 DSH 里堆积的孤儿 QQ 会话**：列出 QQ 会话，把不在 `state/sessions.json` 映射里的全部停掉并归档（默认只报告，加 `--apply` 才动手） |
| `scripts/forge-dsh-cookie.mjs` | 用 `~/.dsh/.credentials.yaml` 里的持久密钥离线签一个浏览器会话 Cookie |

---

## 五、还没验证的部分

- **QQ 侧真实收发**：需要你登录 SnowLuma 并填好白名单，我这边没有 QQ 账号。
- **桥接启动后的 MCP 工具是否出现在 QQ 会话里**：要等 DSH 重启后才能在 GUI 里看到 `mcp__snowluma__*` 等工具。
- **SnowLuma 的 OneBot 具体端口**：不同版本 WebUI 默认值可能不同，以你 WebUI 里显示的为准。

---

## 六、跟「卡牌表情包机器人」的关系

这是**两个独立的东西**，可以并存：

| | `qq-bridge`（本次安装） | `sts2-emoji/bot`（之前做的） |
|---|---|---|
| 作用 | DSH agent 扮演群友聊天、学黑话、管理会话 | 打中文卡名就发对应卡图 |
| 触发 | 社交状态机 + 模型判断 | **精确关键词匹配，零延迟零费用** |
| 依赖 | DSH 在线 + SnowLuma + 模型调用 | 只要 OneBot 网关（同一个 SnowLuma 可共用） |

两者都连同一个 OneBot 网关，**不会冲突**：`qq-bridge` 是 WebSocket 客户端，`sts2-emoji/bot/bot.py` 也是 WebSocket 客户端，SnowLuma 可以同时接受多个连接。

所以你可以：`qq-bridge` 负责"AI 当群友聊天"，`bot.py` 负责"打字必出卡图"。

---

## 七、修复记录：会话重复 / 等待锁死 / 生图被误杀（2026-09-25）

表现是"群里出现两个机器人"、"`qq_wait_for_messages` 一直报已有一个等待中"、"生图十分钟没出图"。
根因与修复都在 `src/bridge.js`（均带 `[qq-bridge 本地补丁]` 注释）：

| 问题 | 根因 | 修复 |
|---|---|---|
| 同一群出现两个 agent | busy 看门狗把"3 分钟无 DSH 事件"当成回合已死，解绑本地映射却**没停掉旧会话**，下次唤醒又建新会话 | 看门狗改为向 DSH 要权威状态（`session/list` 的 `running` 字段）：`running=true` 绝不打断；确认为死才清理，且**必须** `api.stopSessionWork(旧会话)` |
| 等待锁永久占用 | 等待端点的 `finishWait()` 在异常路径上跑不到 | `try/finally` 保证释放 + 超过单次等待上限的陈旧锁自动回收；`activeWaits` 改为 Map 记录起始时刻 |
| 生图被看门狗打断 | 生图期间 1~4 分钟没有任何 DSH 事件 | `/api/socialV2/image-request` 扣配额时下发"长任务租约"（`longTaskUntil`），看门狗在有租约时不判死 |
| 合法的 @ 被判过期 | 桥接自己的排队/看门狗延迟让 @ 超过 180 秒窗口 | 被 @ 唤醒时签发"生图票据"（`imageTicket`，绑定该回合、回合结束即作废），有效期从回合开始重算 |
| 每日配额按 UTC 换日 | `toISOString()` 取的是 UTC 日期（本地早上 8 点重置） | 改用本地日期 |
| DSH 里堆积几十个孤儿会话 | 上述换会话的副作用，历史会话越攒越多 | 用 `scripts/cleanup-stale-sessions.mjs --apply` 清理 |

排查用的关键事实（以后有用）：

- `session/list` 每项都带 **`running` 布尔值**，这是判断"回合还在不在跑"的唯一权威来源；靠事件静默时间猜一定会误杀长轮询/生图/长推理。
- 归档（`workspace.archiveSession`）只是把会话从 GUI 分组里隐藏，`sessions.list` 依然返回它。
- DSH 会话记录是 zstd **分帧**压缩的 `session.v3.jsonl.zstd`（一个文件几百个 frame），
  Node 24 的 `zlib.zstdDecompressSync` 一次只解第一帧，要按 `28 b5 2f fd` 魔数切帧逐帧解，否则只能解出 200 字节。

---

## 八、生图改造：等待工具拆分 + 异步出图（2026-09-25）

### 8.1 为什么要拆 `qq_wait_for_messages`

MCP 的 stdio 传输是**串行**的：同一个 MCP 服务里，一个请求处理完才处理下一个。
`qq_wait_for_messages` 是长轮询（最长 10 分钟），和生图挤在一个服务里时，
`qq_generate_image` 会被排在它后面**根本没轮到执行**（codex 日志里连一条记录都没有）。
实测证据（桥接工具日志）：

```
23:14:55 🔧 qq_wait_for_messages (90s)
23:15:38 🔧 qq_wait_for_messages (90s)   ← 上一个还没返回
23:17:08 📥 只回来一个
23:18:35 📥 另一个等待返回
23:18:37 🔧 qq_generate_image             ← 从此 3.5 分钟无任何返回，直到会话被杀
```

**改法**：新增独立 MCP 服务 `src/mcp-qq-wait.js`（只暴露这一个工具），
从 `mcp-snowluma-safe.js` 中删除同名工具，并在 `cordis.patch.yml` 里多挂一个 `mcp-qq-wait`。
工具名随之变成 `mcp__qq-wait__qq_wait_for_messages`（人设里的 4 处硬编码已同步）。

### 8.2 生图改成异步

原来 `qq_generate_image` 同步跑 codex（1~4 分钟），agent 哑在那里、还占着 MCP 队列。
现在：**扣配额 → spawn 后台 worker → 立刻返回**「已开始生成」。

- `scripts/gen-image-worker.mjs`：独立进程，负责跑 `codex-image.ps1` → 发图 →
  **@ 提要求的那位群友** → 失败时调 `/api/socialV2/image-request {action:'refund'}` 退还配额；
  全程写 `state/image-jobs.log`。
- 桥接侧新增 `action:'refund'`（图没画出来不扣次数）。
- 人设 29.2 相应改成"异步：立刻返回、后台发图并 @ 你、别催别重复调用"。

> **worker 的通知为什么走桥接发送接口，而不是直连 OneBot？**
> 因为桥接的 `/api/socialV2/send-message` 会顺手把消息记进会话的 `recentMessages`。
> 图是 worker 代发的，agent 只看到"已开始生成"，**完全不知道图已经送达**——
> 实测它以为没发出去，在群里让 owner"重新 @ 一次"（而那张图其实 90 秒前就发出去了）。
> 走桥接后 agent 下一轮就能在上下文里看到"@某某 画好了，收图"，
> 顺带还继承了白名单校验、发送频率限制和分条延迟；桥接不可用时才退回直连 OneBot。
> （桥接里原本就有一个 `/api/socialV2/record-sent` 路由**故意只返回 403**——作者不想让
> 持有会话 token 的外部调用方伪造"我说过…"的历史。这个决定被尊重，没有绕过它。）

**8.2.1 异步上线后踩的两个坑（2026-09-26 上午复盘）**

现象：01:02 的请求 01:03 就出图并发到群里了，但机器人 01:12 在群里说"十分钟了图还没出来"
（群友当场回"发出来了但你又说十分钟了图没出来"）。

1. **worker 把 agent token 放错了地方**：`/api/socialV2/send-message` 要求 token 放在
   **`x-agent-token` 请求头**（`bridge.js:3348` 会检查头是否存在），worker 当时放在 body 里 →
   每次都被 403 `reserved2 模式发送必须携带 agent token` → 退回直连 OneBot。
   消息本身发出去了（群友能看到图），但**没有经过桥接那条"顺手记进 recentMessages"的路径**，
   于是 agent 的上下文里根本没有"我发过图"的记录 → 它就自己编了句"没出图"。
   修法：worker 的 `bridgeApi` 支持附加请求头，发送时带 `{'x-agent-token': token}`。
   A/B 验证（用一条会命中敏感词过滤的消息做探针，既证明鉴权通过又不会真发消息）：
   body 放 token → `必须携带 agent token`；header 放 token → `消息含敏感信息，已阻止发送`。

2. **agent 在"图还在生成"的窗口里没有依据**：图是 1~4 分钟后由 worker 发的，
   agent 说完"已开始生成"就结束回合，这期间的唤醒它看不到任何进展 → 容易谎报/重复调用。
   修法：
   - 扣配额时在会话里记 `st.imageJob = {senderId, senderName, startedAt, expiresAt}`；
   - `buildWakePromptV2` 在它有效期内注入一段【后台正在生图】说明（"已 X 秒，画好会自动发并 @ 他，
     不要重复调用、不要说没画出来、也不要让他重新 @你"）；
   - worker 结束时回调 `/api/socialV2/image-job`（`x-agent-token` 头鉴权）清掉标记。
     这个回调**刻意不接受任何调用方文本**，只清状态——否则就成了"持有 token 就能伪造历史"的后门。

顺带：人设新增 29.5（不能改图/换脸，只能按文字画新图，别白跑一次 codex）和
29.6（别谎报"我画好了/没画出来"）。这两条属于 preset，**新会话才生效**；
而【后台正在生图】提示与工具描述是桥接/MCP 侧，改完立刻生效。

### 8.3 codex 侧的两个坑（改的是技能脚本，不在本仓库）`~/.agents/skills/codex-image/scripts/codex-image.ps1`：

1. **`-TimeoutSec` 原本是个摆设**（声明了但代码里没用），超时全靠上层 630 秒杀手。
   现在用 `Start-Job` + `Wait-Job -Timeout` 真正生效。
2. **加了网络探针**：codex 启动时会联网刷新模型列表，网络不通时它自己重试 4~5 轮、
   每轮约 4 分钟，10 分钟过去一张图都没开始画。现在先花 ≤12 秒探一次
   `chatgpt.com/backend-api/codex/models`（走 codex 要用的同一个代理），不通就立刻报
   `网络不可达：...`。实测坏代理下 **7 秒**返回，而不是等 10 分钟。

> 踩坑记录：PowerShell 5.1 读取**没有 BOM** 的 `.ps1` 会按系统 ANSI(GBK) 解码，
> 往脚本里写中文注释会把字符串字面量撑断、直接语法错误。该文件已改为 UTF-8 **with BOM**。

### 8.4 部署方式：MCP 改动不用重启，preset 改动要

profile 的 `package.json` 里 `dsh.profile.patchReload = "live"`，
官方文档说明这是"**a valid edit recomposes without restart**"。
所以只要编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

- 新增条目 → DSH 自动 spawn 新 MCP 服务（实测新进程 `mcp-qq-wait.js` 立刻出现）；
- **改动某个条目里的任意值**（例如 `toolCallTimeoutMs: 725000 → 726000`）→ DSH 会重建该 MCP 实例，
  于是它会重新读取被改过的 JS 文件 —— 这是"改完 MCP 代码不重启 DSH 也能生效"的手段。
- 桥接（`bridge.js`）**不在** DSH 插件体系里，改完仍必须重启桥接进程。

**但 preset 目录里的东西（`~/.dsh/.agent-presets/qq-chat-v2/`）不吃这一套**：

- `agent.cordis.yml`（人设文案）→ 会话创建时读取，**新建会话即生效**（可用
  `POST /api/socialV2/wake` 手动唤醒触发重建，或 `POST /api/session/rebuild`）。
- `qq-tool-restrict.mjs`（执行期工具白名单）→ 它是**插件模块**，DSH 进程内按路径缓存，
  改文件后即使新建会话也还是旧代码 —— **必须重启 DSH**。

踩过的坑：把 `qq_wait_for_messages` 拆到独立 MCP 服务后，工具名变成 `mcp__qq-wait__...`，
而 `qq-tool-restrict.mjs` 的白名单是按前缀放行的（只认 `mcp__snowluma__` / `mcp__snowluma-host__`
/ `mcp__web-search-safe__`），于是等待工具被安全边界拒绝、收尾链断掉。
已在白名单里补 `mcp__qq-wait__`；**重启 DSH 后生效**。

另一个坑：`serverName` 在同一个注册作用域内**必须唯一**，否则 DSH 直接报
`serverName "<x>" is already in use by another mcp-client instance`（见
`dsh-mcp-client/lib/index.js` 的 `ctx.effect` 预留逻辑）。所以不能靠"复用 snowluma 前缀"
来绕过白名单。

**重启 DSH 后的验收记录（2026-09-26 00:51）**：

```
[00:44:55] 🔧 mcp__qq-wait__qq_wait_for_messages          → [00:45:55] ok=True
[00:45:57] 🔧 mcp__qq-wait__qq_wait_for_messages (300s)   → [00:50:57] ok=True   ← 沉睡前观察等满 5 分钟
[00:51:01] 🔧 mcp__snowluma__qq_mark_read                 → [00:51:01] ok=True   ← 收尾成功
会话状态：mode=diving infinite=true unread=0
```

对比重启前：同一串调用每一步都是 `ok=False`（等待工具被白名单拒 → mark_read 因缺沉睡前观察被拒）。
这就是"等待工具被安全边界误杀导致收尾死锁"的完整复现与修复确认。

顺带一提：DSH 重启期间桥接是**独立存活**的，日志会打
`⚠️ DSH 不可用（重启中？），QQ 消息将入队等待` → 重连后 `DSH 已就绪`，期间 QQ 消息不丢。

### 8.5 生图开始提示："收到，画着呢"（2026-09-28，owner 反馈"开始生图时没有提示"）

- 问题：生图是异步的，受理后群里 1~4 分钟没有任何动静 —— 群友以为机器人没理他/坏了。
- 修法：受理时由**桥接确定性**回一句人设口吻的短话（模板池 `src/persona-lines.js`，`pickImageAckLine()`，
  owner 无限次时自动跳过带 `{remaining}` 的模板）；后来还加了"消息一到就立刻回执"（不等 agent 回合），
  并用 `recordSelfMessage()` 记进会话流，唤醒提示里写明"开场白已替你发过，别重复宣布"。
- 开关：`socialV2.image.ackEnabled` / `ackTemplates`；自检 `scripts/test-image-ack.mjs`、`scripts/test-persona-lines.mjs`。

### 8.6 生图"说了失败又回'正在画'"事故复盘（2026-09-28 21:07–21:10）

**现象**：机器人 21:09:00 已经发了「图没画出来…」，1 分钟后又对群友说「没耍你，正在画，等两分钟」。

**根因链**（按日志逐步定位）：

1. 21:07:15 慈膳家 发「@我 生图 眼睛必嘴巴大一倍」，**引用的是机器人自己刚发的图**（想改图）。
2. 21:07:33 worker 开跑；21:08:59 失败（86s），codex 的原话是 *"the referenced photo wasn't attached"* ——
   因为引用的那张图是**机器人自己发的**，而 worker 当初是直连 OneBot 发图的，桥接**从来没记录过它的 media**，
   于是 `collectInputImages` 取到 0 张参考图，codex 拿到"改参考图"的提示却没有图。
3. 21:09:00 worker 调 `/api/socialV2/image-job {ok:false}` → 桥接**只把 `st.imageJob` 清掉了，什么状态都没记**。
4. 唤醒提示里只有「【后台正在生图】」这一行「进行中」状态，**没有"失败了"这一行** → 失败后模型手上没有任何权威状态。
5. 群里接着骂「耍我是吧」，模型（还是个刚重建的新会话，没有历史）看到自己 1 分钟前的「画上了」+ 一条笼统的失败提示
   + 群友情绪，就编了「正在画，等两分钟」。
6. 另外 21:00:13 那条请求被判"没接上，超时了"，是**我自己在 21:03:31 重启桥接**导致的：@ 提及票据与
   `lastMention` 只在内存里（不落盘），重启即失效 —— 这条算我操作失误，不是设计问题。

**修复**：

- 桥接在 image-job 回调里记 `st.imageFail` / `st.imageDone`；唤醒提示新增
  【生图结果：失败】段，明确写"**绝对不要**说还在画/马上好/等两分钟，如实承认失败"。
- worker 失败回执改成：**分类真实原因**（没拿到参考图 / 网络不通 / 超时 / 被拒）+ 带上请求内容片段，
  不再一律写"codex 没能在超时前出图"。
- worker 成功发图后**回报 message_id + 本地路径**；桥接复制一份到 `state/generated-images/`、
  记进 `messageMediaStore` 与会话消息流（`[我发的图]`）。于是"引用我发过的图来改图"能拿到本地原图；
  若本地原图已丢，受理接口直接返回 `REF_IMAGE_LOST` 并退还配额（不烧 codex）。
- 预设新增 29.6.1：**只有**唤醒提示写着【后台正在生图】时才允许说"正在画"，看到失败不许翻案。
- 顺带把"这条算不算生图请求"的判断抽成 `src/image-ack.js#analyzeImageRequest()`，
  受理闸门与群内即时回执共用一套，避免两处不一致。

**工具**：这轮为了定位那个语法错误（自己手滑把 `findMessageMedia` 的函数头删了），写了
`scripts/check-braces.mjs`（能正确处理字符串/模板/正则的括号平衡检查）与 `scripts/trace-depth.mjs`
（定位"函数体被提前闭合"的行），以后手改大文件可以直接用；`scripts/show-recent.mjs` 用来按时间线看最近群消息。

---

**问题**：生图是异步的，受理后群里 1~4 分钟没有任何动静 —— 群友以为机器人没理他/坏了。

**修法**：受理（`consume`）的那一刻，由**桥接确定性**回一句人设口吻的短话，不经过模型
（模型可能因为回合结束/偷懒而不说，而且让它说会出现重复宣布）：

- 模板池在 `src/persona-lines.js`（新模块，禁言播报的池也集中到这里），
  `pickImageAckLine()` 随机抽一条并填 `{name}` / `{remaining}`；
  owner 无限次时自动跳过带 `{remaining}` 的模板，避免出现"还剩 次"。
- 发送走 `sendToQQ`（同一条真人化发送队列），并用 `recordSelfMessage()` 记进会话消息流，
  唤醒提示里也会写"开始那句桥接已经替你发过了，别重复宣布"。
- 开关：`socialV2.image.ackEnabled`（默认 true）/ `socialV2.image.ackTemplates`。
- 失败路径本来就有兜底：worker 画不出来会退配额 + @ 对方说明失败，所以不会出现"画着呢"之后彻底没下文。
- 自检：`node scripts/test-persona-lines.mjs`（15 组断言）、`node scripts/test-image-ack.mjs`（10 项，渲染预览不发群）。

---

## 九、搜索质量排查：不是"坏了"，是"生僻中文人名查不到 + 垃圾结果挡住了好结果"（2026-09-26）

起因：09:42 群友问某导师，机器人搜了 6 次 + 抓了 8 个页面才拿到资料，
但 owner 看输出"挺正常"，问为什么之前说搜索不行。

**实测数据（复现同一条查询）**：

```
Bing RSS  : HTTP 200，5KB，<title> 里查询传对了，
            但 item 全是《孙（汉语汉字）_百度百科》《孙姓》—— 查询被退化成"首字"
Bing HTML : HTTP 200，100KB，含 <li class="b_algo">（真正有用的结果在这里）
```

**两个独立问题**：

1. **选源顺序错了**：`bingSearch` 原本"RSS 有结果就直接返回"，而 RSS 对中文查询会返回
   200 + 一堆不相关的 item，于是真正有排序的 HTML 结果永远没机会被用上。
   → 改成 **HTML 优先**，RSS 仅兜底，并按相关性挑更好的一份。
2. **模型不知道结果是垃圾**：工具回给它一堆看起来像结果的东西（姓氏/汉字百科），
   它只能不停换关键词。→ 新增 `relevance`（0~1）与 `counts`，低于 0.5 时附 `warning`，
   明确建议"改用 web_fetch 直接抓官网/权威页面，或如实说搜不到，别继续换搜索引擎空转"。

**修复后的实测**：

| 查询 | source | relevance | 结果 |
|---|---|---|---|
| `deepseek flash 价格` | bing-html | **1.00** | 官方定价页、降价新闻 ✅ |
| `山东大学 计算机科学与技术学院 教师主页` | bing-rss | 0.90 | 机构+职位→能搜到 ✅ |
| `孙景昊 山东大学 导师 评价` | bing-rss | 0.20 | ⚠️ 附 warning（Bing 确实没有） |
| `李伟湋 南京航空航天大学` | bing-html | 0.00 | ⚠️ 附 warning |

**结论**：普通话题（产品/价格/新闻/概念/梗）搜索是好用的；**生僻中文人名/小机构**这类查询
Bing 本身返回"姓氏/汉字/地名百科"，RSS 和 HTML 都这样——这不是我们能靠解析修好的。
另外 **百度已开始返回"百度安全验证"**（抓多次后被风控），所以爬国内引擎也不可靠。

### 9.1 接上 Tavily 搜索 API（2026-09-26）

拿到 key 后加了 `tavilySearch()`，来源顺序变成 **Tavily → Bing HTML → Bing RSS**，
并且 Tavily 命中且相关性 ≥0.5 时**跳过 Bing**（省一次往返，实测 `counts:{tavily:8,html:0,rss:0}`）。

- key 存放：`config.json` 的 `webSearch.tavilyApiKey`（config.json 在 `.gitignore` 里，不入库）；
  也支持环境变量 `TAVILY_API_KEY` 覆盖。写入用 `scripts/set-tavily-key.mjs <key>`。
- 请求：`POST https://api.tavily.com/search`，`Authorization: Bearer <key>`，
  `{query, max_results:8, search_depth:'basic', include_answer:false}`（basic 每次 1 credit，免费额度 1000/月）。
- 失败/无结果自动落回 Bing；失败原因放在返回的 `tavilyError` 字段里，不会回显 key。

**接入前后对比（同一批查询）**：

| 查询 | 接入前 | 接入后 |
|---|---|---|
| `孙景昊 山东大学 导师 评价` | relevance 0.20，全是《孙（汉语汉字）_百度百科》 | **0.88~1.00，source=tavily**，第 1 条就是 `faculty.sdu.edu.cn/sunjinghao` 教师主页 |
| `李伟湋 南京航空航天大学` | relevance 0.00，全是《李（汉语汉字）》 | **1.00**，第 1 条就是南航教师主页里"李伟湋,博士,副教授,硕士生导师" |
| `deepseek flash 价格` | 1.00（Bing 本来就行） | 1.00 |
| `今天有什么科技新闻` | — | 0.88 |

> 安全提醒：这个 key 是在聊天里贴出来的，DSH 会把会话记录落盘；
> 若这份记录会被别人看到，建议去 Tavily 后台 rotate 一次，再用
> `node scripts/set-tavily-key.mjs <新key>` 写入即可（无需改代码）。

---

## 十、生图支持带图（改图 / 多图参考作画，2026-09-26）

之前是纯文字生图：`codex exec` 只吃文本，图片工具也不接受输入图，
所以"把第一张图的人物换成第二张图里的"必然失败（01:40 那次就是）。

**关键发现**：`codex exec` 有 `-i, --image <FILE>...`（把图片附加到提示词）。
实测 `-i 图1 -i 图2 "<编辑指令>"` 能做**真·多图参考**：把小红帽那张的人物与鲸鱼那张的
角色合成到同一张新插画里，连鲸鱼的粉色比基尼都准确保留。→ 这条路子是通的。

### 10.1 管道（三段）

1. **取图（桥接）**：新增 `collectInputImages(key, {senderId, messageId, quoteId})`。
   候选来源按优先级：① 本条 @ 消息自带的图；② 它引用的那条消息里的图；
   ③ 近 `pickupWindowMs`（默认 120s）内同一发送者发的图；④ 同窗口其他人的图。
   表情包不参与；最多 `maxInputImages`（默认 3）张、总字节 ≤ `maxInputImageBytes`（默认 6MB）；
   整个收集有硬预算（默认 12s，`inputFetchBudgetMs`），超时就用手上的，避免把生图请求拖超时。
   复用已有的 `findMessageMedia` + `fetchOneBotImage`（`qq_get_message_images` 那条成熟链路），
   落盘到 `%TEMP%\qq-bridge-inputs\`。
   因此 `lastMention` / 生图票据新增了 `messageId` 与 `quoteId` 两个字段。
   `/api/socialV2/image-request` 在 **consume** 那一步返回 `images: [路径]`（预检不取图，避免浪费）。
2. **传递**：MCP `qq_generate_image` 把 `images` 以 `--images-b64`（base64(JSON)）交给 worker。
3. **生图**：worker → `codex-image.ps1 -Images "a.png,b.png"` → `codex exec -i <file>`…

### 10.2 踩过的三个 PowerShell 坑（都在技能脚本里）

1. `-i <FILE>...` 是**多值**参数，会把后面的位置参数一起吃掉 → 带图时**提示词必须走 stdin**，
   否则 codex 报"没给提示词"（第一次实测就是这么失败的）。
2. `powershell.exe -File` **不允许重复写同一个参数名**（`-Images a -Images b` 报
   `ParameterAlreadyBound`），多值要写成 `-Images a,b`。
3. 但 `-File` 调用**又不会**按逗号拆分参数（逗号语法只在 PowerShell 自己的解析器里生效），
   所以脚本内部还要自己 `-split ','` 一次。
4. 附带一个：`Start-Job -ArgumentList` 会把**数组拍平**，图片列表必须以 JSON 字符串传进 job，
   否则 job 里拿到空数组（现象是 codex 回"我没有收到你提到的两张图片"）。
5. 老坑复现：每次用编辑器改这个 `.ps1` 都会丢掉 UTF-8 BOM，而 PS 5.1 读无 BOM 文件按 GBK 解码，
   中文注释会把字符串撑断 → 改完必须补 BOM（脚本内有 `[codex-image] 输入图 N 张` 诊断行，
   worker 的 `codex-*.log` 里能看到，排查"图到底传进来没有"）。

### 10.3 已验证

- 本地端到端：worker + 2 张输入图 → 177s → 1370x1148 / 2.4MB，两个角色都在。
- 参数绑定三种形态（2 张 / 1 张 / 0 张）都验证过；无图时自动回到纯文字生图。
- 人设 29.5 从"不能改图"改成"可以带图"，工具描述同步更新，公告也加了一节。
- 限制：最多 3 张；精确换脸/抠图不保证一致（人设里要求说明"参考着画"）；配额与普通生图共用。

---

## 十一、好感度（关系）系统 —— 阶段 1（2026-09-27）

与 owner 敲定的四条边界：

1. **对群友完全隐藏** —— 不提供查询工具、不做排行榜，只通过"称呼 + 语气"体现；
2. **起始 40，量程 -20~100**；
3. **允许负档（梁子）**，但只针对刷屏/复读/踩雷这类真扰人行为；
4. **这次只做"称呼 + 语气"这一层**，不动生图配额、不动唤醒优先级（留给后续阶段）。

### 11.1 算法放在独立模块（可单测）

`src/affinity.js` 是**纯函数**模块（不依赖桥接内存）：分档表、事件计分、日封顶、懒衰减、
提示词面板格式化、脏数据清洗。配套单测 `scripts/test-affinity.mjs`（33 条断言全绿）。

- 计分（**确定性**，不用模型打分——模型打分容易漂移、自我强化，还费 token）：
  - 当天首次冒泡 +2；之后普通聊天不加分（否则话多的人白拿分）
  - @ 我 / 引用我 +1（每日上限 4 次）
  - 发图或表情 +1（每日上限 2 次）
  - 踩雷点词（默认 `大肥鱼/肥鱼/死鱼/傻鱼/蠢鱼/蓝色胖子/蓝胖子`）-2（每日上限 2 次）
  - 刷屏/复读（60 秒内 ≥6 条，且重复 ≥3 条或平均长度 ≤6 字）-2（每日上限 2 次）
  - 每日净涨跌各封顶 ±6（超出只记事件不计分）
  - 闲置超过 7 天开始每天 -1，但**只掉到 20**（不互动 ≠ 讨厌，避免把潜水群友打成"有点烦"）
- 分档（2026-09-27 按 owner 要求改宽量程）：
  `≥300 自己人 / ≥100 熟人 / ≥40 普通群友（起始值落这里）/ ≥0 眼熟 / >−50 有点烦 / ≤−50 梁子`，
  量程 −200~1000，对应语气档 0~5，以及称呼规则（自己人/熟人可叫名字或外号；其余必须用群名片全称；
  梁子不叫称呼）。配合"每天最多 ±6"的细则，熟人最少 10 天满勤、自己人最少 44 天满勤，涨得很慢。
  原写法里 `有点烦 -50~-1` 与 `梁子 -50-` 在 −50 上重叠，按"越负越差"处理：−50 及以下算梁子。

### 11.2 桥接侧接线

- `scoreAffinityEvent()`：把一条群消息翻译成规则需要的字段（是否 @ 我/引用我、有没有发图、
  窗口内消息数/重复数/平均长度），然后交给 `affinity.js`。**只统计群聊**，私聊不算。
- 状态落在 `state/social-v2.json` 的 `affinity.members[QQ号]`（含 score/counters/dailyDelta/
  lastInteractAt/events 最近 20 条/外号），与既有的 `memberImpressions`（定性描述）互补。
- 唤醒提示新增 `【关系（内部参考，绝不能说出口）】` 面板：**只列当前在场的人**（近 15 分钟说过话的，
  最多 8 个），带档位、语气档、称呼要求，并明确禁止把"好感度/档位"说出口；同时顺手对在场的人做懒衰减。
- 人设新增规则 30（标题 + 30.1~30.4），说明"关系只体现在称呼和温度上、绝不透露、档位是温度不是任务"。
  注意：preset 改动**新会话才生效**，而关系面板是桥接每轮注入的，**改完立刻生效**。

### 11.3 运维入口

- `GET /api/socialV2/affinity?key=...` → 配置 + 全员表格（含今日涨跌、闲置时长、最近 3 条事件）
- `POST /api/socialV2/affinity` → `{key, userId, name?, score?|delta?, nickname?}` 手调；`action:'remove'` 删除
- 命令行：`node scripts/affinity-admin.mjs list | set <QQ> <名字> <分数> | remove <QQ>`
  （**一定要用这个脚本而不是 PowerShell 的 Invoke-RestMethod**：PS 5.1 的 `-Body` 字符串默认不走
  UTF-8，中文名字会被写成 `?? ??`——这个坑实测踩过，已把中文名字修回）

### 11.4 已验证 / 待验证

- ✅ 引擎单测 33/33；YAML 两个 preset 校验通过；关系面板已在真实会话记录里确认注入
  （`session-58f33941` 的唤醒提示里能看到档位、语气档、称呼规则与"绝不能说出口"约束）。
- ✅ 手调接口与表格输出正常（卿头 72 熟人 / owner 47 普通 / 库库 31 眼熟）。
- ⏳ **真实消息触发的记账还没跑到**（重启后群里还没人说话）：等人说话后看
  `state/bridge.log` 里的 `[affinity] 某某 +2 → 42（今天首次互动）` 这类行即可确认。
- 后续阶段（待定）：生图配额随关系浮动、唤醒优先级、主动搭话挑熟人、外号记忆与"人情账"。

---

## 十二、投喂（赞助）功能（2026-09-27）

需求："让群友付款导向 DeepSeek API 充值"。**先说清楚一个做不到的事**：DeepSeek 开放平台
没有充值 API / 兑换码 / 余额转移，只有"控制台在线充值（支付宝/微信）"和"企业对公汇款
（要求汇款方开户名与实名一致）"两条路（见官方 FAQ）。所以自动化的只能是前半段：

```
群友 → 爱发电付款 → 把订单号发群里 → 桥接核验/记账/发权益 → 私聊通知 owner → owner 手动充值
```

### 12.1 为什么用爱发电

群主收款码只能看截图（能 P、能重复发）；爱发电有开放 API，可按**订单号**查
存在性/金额/状态，权威且一张单只能用一次。签名算法照抄成熟开源实现
（`sign = md5(token + 'params' + params + 'ts' + ts + 'user_id' + user_id)`，
端点 `https://ifdian.net/api/open/query-order`）。

### 12.2 实现

- `src/feed.js`：账本（`state/feed.json`）+ 订单号解析/脱敏 + 去重 + 每人每小时限流
  + 爱发电核验 + DeepSeek 余额查询 + 水位判定。纯逻辑可单测（`scripts/test-feed.mjs`，47 条断言）。
- `src/affinity.js`：新增 `kind:'feed'` 事件，**绕过好感度每日封顶**（否则投喂 +5 会被当天聊天挤掉）。
- `src/bridge.js`：
  - 群消息入口拦截"对机器人说 + 含投喂关键词"的消息 → **异步**核验 → 回执 → 记账 → 发好感度；
    接管后**不唤醒模型**（钱的事必须确定性，避免幻觉/泄露）；
  - 每笔成功投喂**私聊 owner** 明细（金额、来源、累计）；
  - 余额水位定时检查（默认 6 小时），低于阈值（默认 ¥20）**只私聊 owner**；
  - 控制台接口 `GET/POST /api/socialV2/feed`（含 `?csv=1` 导出）。
- 人设新增规则 31：**钱的事模型不管**、绝不在群里提金额/催充值、被问到"能不能投喂"只说
  "自愿赞助，把订单号发我就行"。

### 12.3 权益规则（owner 定）

每人每天**第一笔** +5 好感度，当天后续投喂不再加；金额不影响权益（¥1 与 ¥100 一样，
刻意避免攀比）；**金额永不出现在群里**，只在私聊 owner 与控制台可见。

### 12.4 启用步骤

1. 爱发电**创作者后台 → 开发者页 `https://afdian.com/dashboard/dev`** 拿 `user_id` + `token`，建一个赞助方案；
   （注意：`afdian.net` 域名**已废弃**，DNS 都解析不出来，老教程里的这个地址打不开；现在是 `afdian.com`）
2. `node scripts/set-afdian-key.mjs <user_id> <token>`（自动写 config.json 并 `enabled: true`）；
3. 重启桥接；群友即可 `@小鲸鱼 投喂 <订单号>`；
4. 对账：`node scripts/feed-admin.mjs list`（订单号脱敏）/ `csv`（完整，对账用）。

实测（假凭据 POST 真接口）：两个域名都返回 `ec=400004 (no valid token found)`，
说明接口可达、签名与请求格式正确，只差真凭据。`feed.afdian.apiBases` 默认
`['https://afdian.com','https://ifdian.net']` 依次尝试，主域名挂了自动切备用。

**默认 `enabled: false`，未配置前完全不接管**（投喂消息照旧走模型，行为不变）。

### 12.5 入口链接：机器人一律不发（2026-09-27 owner 决定）

原本群友说"投喂"会回一个赞助页链接。**已改成绝不含链接**：机器人只回
「投喂是自愿赞助～入口找群主要，付完之后把订单号（一串数字）发我，我来核对记账。」
理由：机器人自动在群里发"收款性质外链"有风控风险（消息被拦 → 限制发送 → 被举报升级；
账号还是小号）。入口由 owner 人工给要投喂的人，机器人只做核验/记账/发权益。
单测里专门断言这条提示**不含 http 链接、不含 afdian 域名**。

### 12.6 事故：投喂成功路径静默崩溃（2026-09-27 17:43）

**现象**：owner 用真实订单投喂 ¥5，账记上了、好感度也 +5 了，但**群里没有道谢、owner 也没收到明细私聊**。

**日志**：

```
[feed] 群主 投喂入账，好感度 +5 → 54（投喂+5（不计入日封顶））
⚠️ 投喂处理异常：todayKey is not defined
```

**根因**：bridge.js 里导入时起了别名（`todayKey as feedTodayKey`、`summarize as summarizeFeed`），
但两处调用忘了改，抛 `ReferenceError`。而这两行偏偏夹在"记账之后、回复之前"，
于是异常把**群回执 + 私聊通知**一起吞掉了（账本与好感度在异常之前已完成，所以数据是对的）。
`node --check` 只查语法，查不出这种作用域错误。

**修复**：改成 `feedTodayKey()` / `summarizeFeed()`。

**防复发**：新增 `scripts/check-bridge-identifiers.mjs` —— 静态扫描"被当作函数调用但全文件没有声明/导入"
的标识符，并且**自带自测**（构造一段"别名写错"的样例，断言检查器能抓到 todayKey/summarize）。
检查器已接入日常检查；对正则字面量与模板串会有少量已知误报（脚本头部有说明）。

**验证**：
- 账本：`1 笔 / ¥5`，订单 `2026…4087`，`status=2`（已支付），已核验；
- 好感度：49 → 54（投喂 +5 绕过日封顶）；
- 私聊链路：新增 `POST /api/socialV2/feed {action:'test-notify'}` 自检接口，
  实测 `{"ok":true,"sent":true,"to":"100000001"}` —— owner 收到测试私聊，说明通知通道正常。

### 12.7 安全与合规

去重（单号一次性）、每人每小时限流（防刷 API）、日志与控制台列表脱敏、
凭据只在 gitignored 的 config.json、任何报错不回显 token/sign、不唤醒模型碰钱。
风险提示：QQ 群规不鼓励群内公开收款（建议不挂公告）；"付费换权益"若写实了可能涉及
卖服务的税务/资质问题，措辞用"投喂/赞助、不承诺对价"；群里有在校学生，不建议做诱导性档位。

---

## 十三、群公告与机器人的关系（2026-09-27 owner 决定：**机器人不读公告**）

**决定**：机器人**不**读 QQ 群公告。公告是写给群友看的，可以包含机器人不知道的内容
（owner 原话：不至于崩人设）。

**为此改掉的东西**：一开始我在人设里写了"群里已经公告过投喂（照公告说）""见公告第三节"，
这等于让模型替一份它没读过的公告代言 → 会瞎编。已改成自洽写法：

- 规则 30.2：可以自然表达"熟不熟"，但**不能泄露机制**（不提好感度/分数/档位/系统），
  且**不引用、不复述、不背诵公告**；有人让念公告就回"群里挂着呢，自己看"。
- 规则 31.1：投喂口径直接写在人设里（自愿赞助、不推荐、入口私聊问群主、不发链接），
  **不依赖公告原文**；明确"别替公告做承诺"。

**备忘（以后若想让机器人读公告，现成能力已探明）**：

- SnowLuma **支持** `_get_group_notice`（POST `{group_id}`）→ 返回
  `[{notice_id, sender_id, publish_time, message:{text}}]`；
  注意普通版 `get_group_notice` 返回 `retcode 1404 unknown action`，**只有下划线版可用**。
- 公告文本带 HTML 实体（`&#10;`→换行、`&nbsp;`→空格、`&quot;`→引号），必须解码。
- 群里有 4 条历史公告（最老是 2023 年的），取 `publish_time` 最新的那条当现行公告。
- 实现量约 40 行（取最新 + 解码 + 注入唤醒提示 + 换公告时刷新），当时写完又按 owner 要求删掉了。


## 十四、本地表情包库：把 dsh-meme 的图库接给 QQ bot（2026-09-27）

**需求**：owner 已经装了 `dsh-meme` 插件（Web 端 `send_meme`），想把那套图库也给 QQ bot 用。

**确认到的事实**（读代码 + 读日志，不是猜的）：

- `dsh-meme@0.1.40` 装在 `~/.dsh/profiles/web/node_modules/dsh-meme`，
  自带两个 pack：`dafeiyu-001`（大肥鱼鲸鱼娘 49 张）、`official-001`（Astrbot 官方梗图 92 张），
  索引是 SQLite（`index.db`，表 `memes`：`path/tag/file_name/caption/keywords`），图片全是 jpg。
- 它的 **QQ 通道依赖 `dsh-companion` 的 `companionQq.sendImage`**，桥接是独立实现，没这个服务 →
  在 QQ 会话里 `send_meme` 只能走 Web 模式（写 `[表情: 描述]` 让前端配图），QQ 侧等于不可用。
- SnowLuma 侧：`send_group_msg` / `send_private_msg` 接受 `{type:'image',data:{file:'base64://...'}}`；
  另有 `add_custom_face`（收藏表情，`file` 也支持 base64/本地路径/URL）——两条路都通，见下。

**选的路**：**本地图库 → 图片消息**（不改 QQ 账号的收藏表情）。
理由：不动 owner QQ 账号里的收藏（导入 141 张会污染/逼近收藏上限，且批量上传有风控风险），
且图片消息这条链路在「生图」功能里已经跑通、可随时撤销。

**改动**：

- `src/meme-lib.js`（新）：只读扫描图库（`node:sqlite`，失败则目录扫描降级）、情绪桶沿用 dsh-meme 的定义、
  抽样（先发没发过的、避开最近发过的）、使用统计 `state/memes.json`、提示词生成。
  目录自动探测 `~/.dsh/meme-packs` 与 `~/.dsh/profiles/*/node_modules/dsh-meme/memes`。
- `src/bridge.js`：`sendMemeV2()`（与 `sendStickerV2` 同款：reply/@ 段 + `sendChain` + 0.8~2s 停顿 + 记 `recentMessages`）、
  路由 `GET /api/socialV2/meme-list|meme-image`、`POST /api/socialV2/send-meme`、
  控制台专用 `GET /api/socialV2/meme-probe`、`POST /api/socialV2/meme-test-send`；
  唤醒提示注入 `【本地表情包库】` 段；`qq_get_prompt` 增加 `memes` 段；发送同时占用总限频。
- `src/mcp-snowluma-safe.js`：`qq_send_meme`（`action=search|view|send`）。
- 预设 `qq-chat-v2`：新增规则 26.1（本地库用法/与收藏表情分工）、工具速查补一行、token 清单补 `qq_send_meme`；
  顺手把 27.2「你没有发图能力」改成「你没有原版卡面图」，免得和新的表情库能力打架。
  （`~/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml` 与仓库 `dsh/agent-presets/...` 已同步，sha256 一致。）
- 人设 `roles/小鲸鱼.md` 加「10.1 本地表情包库」；`RULES.md`、`docs/PROJECT_GUIDE.md` 同步；
  新增 `docs/MEMES.md`。
- 控制台「二代仿真」页：工具勾选 `qq_send_meme` + memes 参数区 + 「检测图库」「发一张试试」两个按钮；
  `/api/socialV2/config` 的归一化里补 `memes` 子对象与 `sendMeme` 开关（否则控制台保存会把它丢掉）。

**已验证**：

- `node scripts/test-memes.mjs`：47 组断言（情绪映射/抽样优先级/去重/路径越界/统计落盘 + 真实图库只读自检 + 接线存在性静态检查）。
- `node scripts/meme-flow-test.mjs happy`：载入 141 张（happy 39 / confused 26 / angry 24 / daily 23 / sad 18 / shy 11），
  抽样 5 张全部能定位、读字节、识别为 jpeg。
- **真发**：`node scripts/meme-flow-test.mjs --send private:100000001 daily` → 发出 1 张，
  `message_id=1765206550`（owner 私聊收到，图片消息链路 OK）。
- **桥接重启后**（owner 选的方案：只重启桥接，不动 DSH）：
  - `node scripts/probe-bridge.mjs` → `/api/socialV2/meme-probe` 200，141 张、两个 pack、`source=index`。
  - `node scripts/test-meme-routes.mjs` → 13/13 通过：list 抽样、image 取字节（jpeg 魔数）、目录穿越被拒、
    `send-meme` 缺/假 agent token 被拒、带文字被拒、测试接口非法 key 与非白名单目标被拒、AI 不能调控制台接口、
    日志有 `[meme] 本地图库已载入 141 张`。
  - `node scripts/test-meme-prompt.mjs` → `qq_get_prompt` 的 `memes` 段正常，`enabledTools` 含 `qq_send_meme`，
    context/strategy 都注入了。
- `node scripts/check-console-ui.mjs` → 控制台控件 html/js 接线完整。

**上线步骤（已全部完成）**：

1. ✅ 桥接已重启（owner 同意下由我执行：kill 旧进程 → 新进程）→ HTTP 路由已生效。
2. ✅ **MCP 侧已重载**：owner 重启 DSH 后，DSH 重新 spawn 了 `src/mcp-snowluma-safe.js`，
   `qq_send_meme` 已进入工具列表（实测调用返回桥接的 `agent token 无效`，而不是"未知工具"）。
3. ✅ 规则文本（26.1 等）已写进预设；会话侧由唤醒提示的【本地表情包库】段兜底，老会话下次唤醒也能看到
   （`qq-tool-restrict.mjs` 不用改：白名单按 `mcp__snowluma__` 前缀放行，新工具自动可用）。

**踩坑：桥接不能用「DSH 子进程」的方式启动（2026-09-27 18:48）**

- 我先前用 harness 的 pwsh（`dsh-subprocess-local/runner.js` 的子进程）`Start-Process` 起的桥接，
  owner 一关 DSH，**桥接被一起收走了**（3100 掉线、锁文件留着旧 PID 8220）。
  DSH 关闭时会连它进程树里的后代一并清理。
- 正确做法：让桥接脱离 DSH 进程树。两种：
  1. owner 自己双击 `start.bat`（守护窗口，退出后 5 秒自动重启）；
  2. 需要由 agent 起时用 WMI 创建（父进程是 `WmiPrvSE.exe`，不在 DSH 树里）：
     ```powershell
     $cmd = 'cmd.exe /c ""D:\nodejs16\node.exe" src\bridge.js >> "D:\dsh\qq-bridge\state\bridge-stdout.log" 2>&1"'
     ([wmiclass]'Win32_Process').Create($cmd, 'D:\dsh\qq-bridge')
     ```
     验证链：`node.exe`(bridge) ← `cmd.exe` ← `WmiPrvSE.exe`。
- 重起后桥接会自己重连 DSH / SnowLuma，日志里出现 `DSH 已就绪（模式: reserved2）`。

**待验证 / 注意**：

- 上线后第一次真发：控制台「检测图库」旁边有「发一张试试」，key 填 `group:123456789`、情绪填 `happy` 即可当场验证。
- 上游 `dsh-meme` 新增图片后最多 `rescanTtlMs`（默认 5 分钟）自动生效，点「检测图库」可立即重扫。
- 若以后想反过来把图库**导入 QQ 收藏表情**：SnowLuma 的 `add_custom_face(file=base64://...)` 可用，
  但要留意收藏上限与批量上传的风控，别一次灌 141 张（该 QQ 号目前只有 6 个收藏表情）。


## 十五、群管理：禁言 + 群公告（2026-09-28）

**需求（owner 原话）**：① 群友恶意刷屏（同一个人重复同一句话/同一张图 5 次以上）或持续恶意攻击 bot 时，
禁言 1~10 分钟；② 功能更新后，**经 owner 确认** bot 可以编辑群公告展示更新内容。
**不许踢人！不许编辑群相册或群文件。**

**先确认的事实**（不是猜的）：

- SnowLuma 支持 `set_group_ban(group_id,user_id,duration)`（duration=0 解禁）与 `_send_group_notice(group_id,content,...)`；
  `_get_group_notice` 可读（群里有 4 条历史公告）。**没有**"转让群主"接口（`set_group_owner`/transfer 都不存在）。
- 群里的身份：群主是 owner（100000001），管理员是 **群友A(200000001)、群友C(200000004)**，
  机器人自己**当时是普通成员**（`role=member`，头衔"高性能bot"）→ 禁言/发公告会被 QQ 拒绝，需要 owner 设管理员。
- OneBot 图片段带稳定的 `file`（形如 `CA78D7F9…4774A.jpg`，就是图片 MD5），
  实测同一个人两次发同一张图，`file` 完全相同 → 可以直接当"同图"指纹，不用下载字节。
- owner 一度考虑"把群主转给 bot"来解决"管理员免疫"。查完结论：**不建议**（转让不可逆、SnowLuma 没有转回接口、
  平台权限全落到小号上、owner 自己会降级为管理员），改成"bot 升管理员 + owner 手动撤那两个管理员位"。

**设计要点**：

- 判定与执行全在桥接，确定性规则，纯函数放 `src/moderation.js`（55 组断言）。
- **模型没有直接禁言的工具**：`qq_request_mute` 只是"提议"，桥接按人重跑检测核验证据，不足直接 403；
  `qq_propose_announcement` 起草公告，必须 owner 私聊回"通过"（或控制台按钮）才发布。
- 动作白名单 `ADMIN_ACTIONS` 只有 `set_group_ban` / `_send_group_notice` / `_get_group_notice` / `get_group_member_info`；
  `FORBIDDEN_ACTIONS` 列了踢人/全员禁言/设管理员/改名片群名/退群/群文件/群相册/删公告，
  且单测**扫描 bridge.js、mcp-snowluma-safe.js、console.html 的源码**确保这些字符串不出现（防止以后被误加）。
- 豁免：owner / 群主 / 群管理员 / 机器人自己 / 白名单永不被禁言；每人冷却 30 分钟、每人每天 2 次、全局每小时 3 次/每天 10 次。
- 默认 `dryRun: true`：只记录 + 私聊通知 owner（每人 10 分钟最多一条），不真的禁言。
- 群公告：QQ **没有"原地编辑"**，`_send_group_notice` 是发新公告（新公告成为显示的那条，旧的留历史）；
  默认不放链接、不许 @全体、不许出现本机路径/凭据；草稿 30 分钟未批作废；同时只允许 1 份待审。
- owner 手动命令：`/禁言 <QQ> [分钟]`、`/解禁 <QQ>`、`/禁言记录`、`/公告`、`/公告通过`、`/公告拒绝`。

**改动**：新增 `src/moderation.js`、`scripts/test-moderation.mjs`、`scripts/check-preset-admin-rules.mjs`、
`scripts/probe-group-admin.mjs`、`scripts/probe-snowluma-actions.mjs`、`docs/MODERATION.md`；
`src/bridge.js`（检测钩子 / 禁言执行 / 审计 `state/moderation.json` / 待审 `state/admin-pending.json` /
owner 私聊审批 / owner 命令 / 8 个路由 / 唤醒提示【群管理】段 / `qq_get_prompt` 的 `admin` 段 / config 归一化）；
`src/mcp-snowluma-safe.js`（`qq_group_admin_info` / `qq_request_mute` / `qq_propose_announcement`）；
`public/console.html`（群管理面板 + 工具勾选）；预设规则 **32.x**（两份 preset 已同步，sha256 一致）；
人设 `roles/小鲸鱼.md` 第十三节；`RULES.md` 4.1。

**待验证 / 注意**：

- 需要 owner 在群里把机器人设为**管理员**，否则禁言/发公告会被 QQ 拒绝（桥接会跳过并私聊提醒）。
  → **2026-09-28 已完成**：`probe-group-admin.mjs` 显示 `role=admin`。
- 当前两个管理员（库库、孩八子）永远免疫 —— 今天最闹的恰好就是他们；要管只能 owner 手动。

**2026-09-28 owner 追加的三条要求 + 落地**：

1. 「禁言目标号 200000003」→ `scripts/test-mute-live.mjs 200000003 60`：
   真机 `set_group_ban` 返回 `ok:true`，随后立刻解禁也成功 → **禁言链路验证通过**（审计两条记录）。
2. 「一天后关干跑」→ 新增 `admin.dryRunUntil`：`scripts/set-admin-config.mjs --dryrun 24h` 设为
   2026-09-29 18:36 自动生效；到期由 `startAdminTimers()` 每 10 分钟检查一次，到点自动转为生效 +
   日志 + 私聊通知。**实测**：把 `dryRunUntil` 临时设成过去 → `admin-status` 立刻报 `dryRun=false`、日志出现到期提示、私聊送达（owner 可能收到一条"群管理已生效"，那是自检，配置已恢复成 24 小时后）。
3. 「禁言时可以根据人设说一句」→ `announceInGroup: true`，播报文案从 `announceTemplates`（刷屏）/
   `announceTemplatesAttack`（攻击）随机抽一条（`pickAnnounceLine()`，单测覆盖"不带脏字"），
   并给下一次唤醒留 `st.moderationNote` 小纸条（让它知道刚发生什么、可以自然接话但不要重复宣布）。

**这轮又踩到两个自己写的 bug（均已修）**：

1. `notifyOwner()` 走 `sendToQQ` → reserved2 下 `allow.private` 为空，**私聊通知全被静默拦掉**
   （投喂/余额水位/群管理通知都发不出）。新增 `sendOwnerDM()`（OneBot `send_private_msg`，目标写死 ownerQQ）。
2. `startAdminTimers()` 放在启动早期（早于 `const bot = ...`）→ 到期通知报 TDZ 错误，已挪到 bot 初始化之后。

**群公告改造（owner 要求：bot 第一人称）2026-09-28**

- 现行公告（原 502 字，owner 手发的）→ 新版 **511 字，已由桥接发布**（第 5 条公告，19:00:45，置顶、不要求成员确认收到）。
- 两处刻意偏离原文：删掉「@哦鲸鲸 投喂+订单号」（机器人自己教人打钱＝风控高发，且与人设"绝不提钱/不发链接"冲突，
  改成"问群主，我不掺和、不发链接"）；不再出现"好感度系统"字样（改成"我是个群友，不是客服"）。
- **踩坑三连**（都是真机才发现）：
  1. **owner 私聊被白名单丢掉**：reserved2 下 `allow.private` 是空的，owner 回复的「通过」在 `modeAllowed()`
     那关就被扔了（日志 `忽略未授权会话 private:100000001`），草稿一直卡在待审。修法：`handleIncoming` 开头
     就把「owner 私聊 + 审批词 / `/公告*` / `/禁言记录`」交给 `handleOwnerPrivateCommand()`（回执走 `sendOwnerDM`）。
     验证脚本 `scripts/test-owner-dm.mjs`，走控制台专用模拟接口 `/api/socialV2/owner-dm-simulate`，不需要 owner 真发消息。
  2. **QQ 公告有服务端长度上限**：603 字发布被拒（`ec=9 text length error`），511 字（1365 字节）能过，
     原公告 502 字也能发。校验默认收紧到 **600 字 / 1400 字节**，超了在提交草稿阶段就拦，不等发布失败。
  3. **发布失败要保留草稿**（改完能再批一次），发布成功才清空待审。
- 另外：我为了加载配置结束过一次桥接进程，但当时**没有守护窗口在跑**（owner 那次是用资源管理器起的），
  机器人离线约 6 分钟（18:47→18:53），随后我用 WMI 重新拉起（脱离 DSH）。以后动它前先确认有没有守护窗口。







