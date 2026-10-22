# qq-bridge 安装记录（本机 D:\dsh\qq-bridge）

安装时间：本次会话 · 最初目标 DSH 版本 `0.1.5-rc.1`（现已升到 `0.2.1-rc.2`，见 §16.18 / §16.24）
最近更新：**2026-10-22** —— DSH `0.2.1-rc.2` 运行中，离线套件 65/65。
分支约定（2026-10-22 起）：

- **`main`** = 当前稳定状态（每次提交后**同步快进**到这里，GitHub 首页看的就是它）；
- **`upgrade/dsh-0.2.1`** = 当前开发分支（从 `main` 切出）；
- 旧的 `upgrade/v0.1.7` **已退休并删除**（内容全在 `main`，历史见 §16.18）。

---

## 🔎 找东西从这里开始（2026-10-22）

- **要修一个具体症状** → **别通读本文**：`Select-String INSTALL_NOTES.md -Pattern '<关键词>'`。
  每节标题都带**日期**，越靠后越新；找到后**只看那一节**。
- **文档地图（哪些还有效）** → [`docs/README.md`](docs/README.md)（✅/⚠️/🗄️ 状态标记）。
- **某个文件是干嘛的** → [`docs/FILE_INDEX.md`](docs/FILE_INDEX.md)（自动生成，别手改）。
- **本文的"结论"优先于"过程"**：过程只是佐证；若结论与代码冲突，**以代码为准**，并在该节补一行更正。
- 编号约定：`16.x` 是本副本的新增/踩坑记录，按时间追加。**16.18 撞号两次**（"DSH 0.2.0 升级记录" 与
  "B 站登录态"），历史遗留，**不要改号**（外部可能已按号引用）。

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

## 十六、语音：开启「发」+ 新增「听」（2026-09-29）

owner 要求「给 bot 加语音功能」。先盘点现状，再决定动不动代码：

**现状（结论：发语音的能力早就写完了，只是关着）**
- 发送链路完整（`voice-core.js` 共享实现 + 桥接 `sendVoiceV2`/`sendVoiceForV2` + SnowLuma `record` 段），
  `audio/` 里也已经有 8 条音频；但 `config.json` 里 `tools.sendVoice=false`、`voice.enabled=false`，
  所以 MCP 连 `qq_send_voice` / `qq_list_voices` 都没注册（这条是**进程启动时**读配置决定的）。
- **收**语音一直只写成占位符 `[语音]`（`segmentsToText` / `forward.js`），AI 完全听不到内容。
- 仓库里**没有** TTS（文字转语音），SnowLuma 自带的 `get_ai_record` / `send_group_ai_record` 也没接。

**A. 打开现成的发送能力（只改配置，零代码）**
- `socialV2.tools.sendVoice: true`、`socialV2.voice.enabled: true`。
- ⚠️ **改完必须重启 DSH**（不只是重启桥接）：MCP 工具表是 `mcp-snowluma-safe.js` 启动时按配置注册的。
  在重启 DSH 之前，AI 侧不会出现这两个工具（旧会话里工具清单是缓存住的）。
- 另外 `socialV2.voice.enabled` 只关 AI 通道：`/api/voice/send`（CLI）与控制台试发面板不受它限制，
  所以「CLI 能发、AI 不能发」时先查开关与工具注册，不是内核坏了。

**C. 新增「听懂语音」（收语音 → 转写，需要代码）**
- 新增 `src/voice-transcribe.js`：`fetchPttText`（POST `/fetch_ptt_text`，只读）+
  `transcribeVoiceMessage`（空结果自动重试；一切失败折成 `{ok:false}`，**永不抛**）+
  `settleVoiceTranscript`（限时等待）+ `applyVoiceTranscript`（原地回填）。
- `src/bridge.js` 接入点：`voiceTranscribeCfg()` / `startVoiceTranscribe()` / `backfillVoiceTranscript()`；
  `segmentsToText` 新增 `recordText` 选项；`handleIncoming` 里按 `record` 段启动任务。
- 配置（`socialV2.voice`）：`transcribe: true`、`transcribeTimeoutMs: 5000`、`transcribeAttempts: 2`、
  `transcribeRetryMs: 800`、`transcribeMaxChars: 200`、`transcribeInlineWaitMs: 8000`。
- **为什么是「先入库、再原地回填」而不是「等转写好了再入库」**：`@snowluma/sdk` 的 WS 事件是
  **并发派发**的（`websocket-client.js` 里 `void this.dispatchEvent(...)`，不 await）。若在这条语音上
  等 1~3 秒，它会晚于其后到达的文本消息入库，`seq` 单调递增的假设就破了 —— AI 会看到「先被回复、
  后提问」。回填不动时序，代价只是极短时间内那条显示成 `[语音]`（唤醒合并窗口默认 8s，远大于常见的
  1~2s 识别耗时）。回填**按 messageId 反查**那条消息，不按数组下标取（并发下按下标取会张冠李戴）。
- 失败表现：识别没回来 → 重试一次；仍拿不到/纯音乐/网关不通 → 保持 `[语音]`，只写日志。
  **绝不**因转写失败丢消息、堵消息或改变发送行为。成功日志：`[voice] <key> 语音已转写（N 次尝试）：…`。

**验证到什么程度**
- `scripts/test-voice-transcribe.mjs`（新增，37 条断言：URL/鉴权/参数形状、HTTP 与 retcode 失败、
  重试、超时、reject、回填只替换第一个 `[语音]`、文字+语音共存不丢原文、200 字截断不切坏 emoji、空结果不改文本）
  → 通过；`node scripts/run-offline-tests.mjs` **44/44 通过**（新增用例已自动纳入）。
- 真机 dry-run（不发送、只解析+探测）：AI 通道 `/api/socialV2/send-voice` 传 `dryRun:true` → `200 ok`，
  `哇哦` 能模糊匹配到 `哇哦.mp3`，`../../config.json` 被边界拒绝（400）。
- 网关契约探针：假 message_id → `status:failed, retcode:100, 消息不存在或已被撤回`（与解析器一致）；
  无 token → 401。
- **待验证**：还没有**真人发来的语音**经过这条链路（本机历史状态里 0 条语音）。谁在群里发一条语音，
  看 `state/bridge.log` 有没有 `[voice] … 语音已转写` 即可确认（失败则是「语音未能转写（messageId=…）」）。

**踩到的坑（留给以后）**
1. **用管道调用 `restart.bat` 会挂住**：`cmd /c restart.bat 2>&1 | Out-String` 里，被 `start` 拉起的
   守护窗口继承了管道的 stdout，PowerShell 会一直等管道关闭 → 命令永不返回（桥接其实已经起来了）。
   正确姿势：直接双击 `restart.bat`，或 `Start-Process cmd -ArgumentList '/c','start.bat' -WorkingDirectory D:\dsh\qq-bridge`。
   处理挂住的作业时**别杀整棵进程树**（守护窗口和桥接都是它的后代），只 `Stop-Process` 那个 powershell 就行。
2. 回填时的会话状态用 `getSocialV2State(key)`，它在会话刚被 `/reset` 的极小窗口里会把空会话建回来；
   影响只是控制台多一个空会话，没有功能后果（真在意可改成 `socialV2.conversations.get(canonicalV2Key(key))`）。

**改动文件**：`src/voice-transcribe.js`（新增）、`src/bridge.js`、`scripts/test-voice-transcribe.mjs`（新增）、
`scripts/probe-voice-status.mjs`（补 transcribe 输出）、`config.json`（两个开关 + 6 个 transcribe 项）、
`config.example.json`、`README.md`、`docs/README.md`、`docs/FOLDER_MAP.md`、`docs/guides/VOICE.md`（新建，补上文档索引里一直悬空的链接）。

**还没做**（详见 `docs/guides/VOICE.md` 第五节）：TTS；SnowLuma 的 `get_ai_record` / `send_group_ai_record`；
合并转发里的语音转写（`forward.js` 的纯函数渲染仍是 `[语音]`）。

## 📋 §16 结论速查表（2026-10-22 生成）

> 下面每行 = 一个**结论**（就是那节的标题）。要细节再去看对应小节；标 🗄️ 的过程节正文在
> [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](legacy/INSTALL_NOTES-16-process-archive.md)。

| 编号 | 结论 |
| --- | --- |
| §16.2 | 让它真的会开口：预设引导 + 每轮提示注入（2026-09-29 续） |
| §16.3 | 事故：桥接「假死」7 分钟，19:17 的 @ 没人回（2026-09-29 晚） |
| §16.4 | 外部看门狗落地（16.3 的待办 #1，2026-09-29 晚） |
| §16.5 | 明日方舟日活：owner 一句话触发（2026-09-29 晚） |
| §16.6 | 终末地日活（MAAEND）：同一套引擎 + 第二个档案（2026-09-29 深夜） |
| §16.7 | 省 token 改造（方案 1~4，2026-09-30） |
| §16.9 | 政策：**系统状态提示一律不发群**（owner 2026-09-30） |
| §16.13 | 生图后端：默认走火山方舟 Agent Plan，失败回落 codex（2026-10-05） |
| §16.14 | DSH 会话归档：官方没这功能，用"搬目录"等效（2026-10-12） |
| §16.15 | 卡片链接：群友发 B 站/网页卡片 → 去读并总结（2026-10-12） |
| §16.16 | 引用图片：模型不知道你引用的是哪一条（2026-10-13） |
| §16.17 | 唤醒积压：为什么 AI 会"接几分钟前的话"（2026-10-14） |
| §16.18 | DSH 0.2.0 升级记录（2026-10-15） |
| §16.18 | B 站登录态：cookie jar 滑动续期 + 扫码自动续期（2026-10-15） |
| §16.19 | B 站字幕：抓取 + 长字幕分层精编 + 缓存分页（2026-10-15） |
| §16.20 | 踩坑：模块级 const 的 TDZ（2026-10-15） |
| §16.21 | B 站专用直连通道：DoH 拿真实 IP + SNI 直连（绕过 fake-ip 代理） 2026-10-16 |
| §16.22 | B 站字幕的"在线交付"：P1 工具结果 / P2 按需工具 / P3 兜底唤醒（2026-10-16） |
| §16.23 | B 站热评辅助理解（字幕之后再给"观众怎么看"） 2026-10-18 |
| §16.24 | DSH 0.2.1-rc.1+ 不再注册 `{{cwd}}`：preset 里留着它会让**每一轮都失败**（2026-10-18） |
| §16.25 | 误禁言：同一条消息被重复投递 100 次，刷屏判定数到 50 次（2026-10-20） |

---

### 16.2 让它真的会开口：预设引导 + 每轮提示注入（2026-09-29 续）

owner 追问「这个语音 bot 什么时候会主动调用」，查完发现答案是「**几乎永远不会**」，于是补上引导层。

**现状（为什么原来一条都不会发）**
- 桥接里**没有任何自动/定时调用语音的机制**：语音只发生在 AI 的某个回合里，由它自己决定。
- 而预设第 16 条当时写着「语音**默认是关闭的**…报『语音功能已关闭』是正常状态，**不要重试**…
  继续打字即可」—— 开关打开之后这句话反而在劝阻模型用它。
- 唤醒提示词里完全没有语音（对比贴纸/表情包都有 strategy + 清单注入），工具描述里只有一句
  「偶尔发一条即可」。**2026-09-29 实测：只改预设、不注入提示词，它一条都不发。**

**改动**
1. 预设第 16 条重写（源 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`）：「已开启 + 适合/不适合场景
   + 一段对话最多 1 条、一天最多 3 条、绝不连发 + 失败姿态（不重试/不假装发了）」，并**如实说明库里
   是音效/梗段**，不是能念台词的 TTS（`audio/` 里 8 条全是笑声/疑惑/愤怒/音乐这类）。
2. 唤醒提示新增 `【语音】` 块（`bridge.js` 的 `voiceLine`，`buildWakePromptV2` 里 `+ voiceLine +`）：
   每轮给出**实时语音库清单** + 场景 + 「今天你已发 N 条（一天最多 3 条）」，到上限就直接写「今天别再发」。
   照的是贴纸/表情包那套（`stickerLine`/`memeLine`）。开关 `voice.includeInPrompt`。
3. 配套：`recordVoiceSentV2` 给自己发出去的语音记录打 `sentVoice: true`；新增 `countVoiceSentTodayV2()`；
   配置加 `voice.includeInPrompt`（默认 true）、`voice.promptDailyMax`（默认 3，**软上限**，
   写进提示让它自己收手；硬上限仍是 `maxPerMinute`/`maxPerHour`）。
4. 契约测试更新：`scripts/test-qq-preset-contract.mjs` 原本断言旧文案「语音**默认是关闭的**」（删掉就变红），
   改成断言新的场景/频率文案，并**新增一条测试**钉住唤醒提示里的 `voiceLine` + `sentVoice` + `countVoiceSentTodayV2`
   （这三样被顺手删掉不会让任何其它测试变红）。

**生效流程（漏一步就不生效）**：改源 → `node scripts/build-agent-preset-patches.mjs` 重新生成产物
（手改产物会被 `--check` 判不一致）→ `node scripts/setup-dsh.mjs` 同步进 profile（bundle 是 junction，
改完立刻可见）→ **重启 DSH**（preset 才会被重新装载）。

**验证**：真机低噪音唤醒一次（`POST /api/socialV2/wake`，reason=replyCheck，没有产生任何群消息），
再解 DSH 会话记录（`session.v4.jsonl.zstd`，多帧 zstd）确认提示词里确实有：
「【语音】语音库现有：哎呦我去.mp3、…、呦吼吼吼.mp3。…今天你已发 0 条（一天最多 3 条）。」✅

**顺带修**：`scripts/dump-session-tail.mjs` / `probe-session-search.mjs` / `probe-affinity-prompt.mjs`
写死了 `session.v3.jsonl.zstd`，而当前 DSH 写的是 **v4** —— 这三个诊断脚本此前是**静默失效**的。
已改成「v4 优先、v3 兜底」并冒烟跑通。

### 16.3 事故：桥接「假死」7 分钟，19:17 的 @ 没人回（2026-09-29 晚）

owner 问「19.17 被 @ 后为什么没有回复」。查完的结论：**不是 AI 不回，是桥接瞎了。**

**证据链**
- SnowLuma 日志确认那条 @ 到了网关：
  `19:17:50 OK [Event] 群 [梅川 嗨丝的大父群(541026885)] | [梦想成为三角洲大神(3390867239)] @264346863 你能找到的数学学院的所有导的研究方向大概统计一下 不用太细`；
  之后 19:21:27（引用 +「回复一下」）、19:22:12「？」、19:22:26、19:22:32「我在加功能」、19:22:44 共 **6 条**都没人处理。
- 但这些消息**从未进过桥接**：`state/social-v2.json` 的 `lastIncomingAt` 停在 **19:12:16**（`lastUnreadSeq=3108`），
  最近消息里没有任何 seq>3108 的条目；`state/qq-activity.log` 在 19:13–19:23 之间也没有「消息已入未读」。
- 桥接从 **19:16:04 起整体不响应**：DSH 会话记录（`session-ced82c49`）里，模型这一轮的每个桥接类工具调用
  （`qq_wait_for_messages` / `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_social_state` /
  `qq_report_feedback`）全部 `fetch failed`，而**直连 SnowLuma** 的 `snowluma_status` / `qq_status` 正常。
  模型自己判断出「Confirmed outage」，重试约 40 秒后写了一条 feedback，并在群里说
  「群里的问答已经发出去了，但之后桥接的消息类接口整片挂了，收尾动作没做成」，19:16:42 结束回合。
- 进程**没死，是卡住**：19:17~19:18 我列进程时它还活着（PID 38560 + 守护窗口 916），
  但 `state/bridge.log` 从 19:14:29 之后**一行都没有**（既无堆栈也无退出日志）——事件循环被阻塞，
  HTTP 与 WS 一起哑掉，后面的消息自然既读不到也处理不了。
- 恢复时间：**19:23:01** 我重启桥接（杀掉卡死进程、起新实例）后才正常。owner 感知到的「被 @ 没回复」
  就是这 7 分钟。

**雪上加霜（这次的锅是我的）**：19:23:01 那次重启是我从 **DSH 会话里**跑的 `restart.bat`，
守护窗口与桥接因此挂在 DSH 的进程树上；19:26 按 owner 要求关闭 DSH 时，进程树被一起收走
（SnowLuma 日志 19:26:03 的 `read ECONNRESET` 就是桥接的 socket 被带走），桥接从此**完全离线**
（无进程、3100 无监听），直到 **19:32:51** 用桌面「启动Bot」重新拉起（PID 1952，已确认
`/api/status` 40ms 响应、SnowLuma 与 DSH 均已连接）。
👉 **教训：不要在 DSH 会话里跑 `restart.bat` / `start.bat`**（它是 DSH 的子进程，DSH 一关就一起没），
要在桌面/独立窗口里起。

**另一个真实缺口**：`D:\dsh\tools\start-bot.bat` 拉起桥接用的是
`start "qq-bridge" /D "%BR_DIR%" "%NODE%" src\bridge.js` —— **直接起 `bridge.js`，没有 `start.bat` 的
崩溃重启守护**。所以《重启后拉起Bot.md》里「它自带守护脚本 start.bat（崩溃自动重启）」只在用
`qq-bridge\start.bat` / `restart.bat` 起的时候成立；走启动器这条路，桥接卡死/崩溃后**没有任何东西
会把它拉回来**（今天就瞎了 7 分钟，19:26–19:32 又完全离线）。

**待办（建议，尚未做）**
1. **外部看门狗**（最有效）：每 30s 探一次 `http://127.0.0.1:3100/api/status`，连续 N 次超时就杀掉并重启，
   看门狗自己的日志落文件。只有进程**外面**的看门狗能救「事件循环卡死」——进程内的定时器会一起卡死。
2. 或者让启动器改走 `start.bat`（带守护循环），代价是多一个常驻 cmd 窗口。
3. 桥接内部加 WS 存活心跳（长时间无帧 → 主动探活 → 失败就 `socket.close()` 触发 SDK 重连）：
   能救「半开连接」，但救不了卡死。

**为什么没有堆栈**：进程是卡住不是崩溃，`uncaughtException` 兜底（bridge.js:13662）不会触发；
守护窗口的 stdout/stderr 也没落盘（`state/bridge-stderr.log` 仍是 18:42 那次的内容）。
要抓住下一次，得先落实第 1 条，或给 `start.bat` 加输出重定向。

**状态更新（2026-09-29 19:55 前后，另一个会话补记 —— 避免重复劳动）**

- 上面「待办 #2」**已完成**：`D:\dsh\tools\start-bot.bat` 拉起桥接已改走守护循环 ——
  `if exist "%BR_DIR%\start.bat" start "qq-bridge guard" /D "%BR_DIR%" cmd /c start.bat`
  （没有 `start.bat` 时回退原来的裸 `node src\bridge.js`）。owner 已同意多一个常驻 cmd 窗口。
  该文件是 **GBK + CRLF**，所以改动是**纯 ASCII 字节级替换**（非 ASCII 字节数 632 未变、CRLF 未变、
  按 GBK 回读中文正常），备份在 `D:\dsh\tools\start-bot.bat.bak-guard-patch`；
  两条分支都在 `tools\_lbtest` 沙盒里复刻同样的嵌套块验证过（有/无 start.bat）。
  👉 **请勿重复做 #2**；若要做，注意别按 UTF-8 重写这个 .bat。
- 覆盖范围提醒：这一步只解决「进程退出/崩溃」（守护循环 5 秒后重启）。
  **它救不了事件循环卡死**（卡死时进程还在，守护不会重启），所以**待办 #1（外部看门狗）仍是唯一对症项**，
  已约定由正在处理本节的那个会话实现。
- 另外桥接内部已加 **WS 链路看门狗**（`src/snowluma-liveness.mjs` + `scripts/test-snowluma-liveness.mjs`，
  提交 `eb77302`）：入站事件刷新存活水位，静默 5 分钟发一次 `get_status` 探活，探活失败或静默 12 分钟
  强制 `close + connect`；参数在 `socialV2.snowluma`。它只覆盖「半开连接」，与 #1 是两件事、不冲突。
- 该提交（`eb77302`）是我用 `git add -A` 收的尾，**把本节 16.3 也一起提交了**（当时没注意到有并行会话）。
  已改规矩：此后只 `git add` 明确列出的文件。

### 16.4 外部看门狗落地（16.3 的待办 #1，2026-09-29 晚）

**分工**（避免和并行会话撞车）：#2（启动器改走 `start.bat` 守护循环）与「桥接**内部** WS 链路存活看门狗」
（`src/snowluma-liveness.mjs`，提交 `eb77302`）由另一个会话完成 —— 它们覆盖「进程退出」与「半开连接」。
本节做的是**待办 #1：进程外看门狗**，它是唯一能救「事件循环整体卡死」（卡死时进程内定时器也一起卡死）的形态。

**新增**
- `scripts/watchdog-bridge.mjs`：常驻探针。默认每 30s 探一次 `http://127.0.0.1:3100/api/status`（带 `state/console-token`）。
  **只要拿到 HTTP 响应就算「活着」**（401/500 只告警，避免 console-token 不匹配把健康桥接误杀）；超时/连接失败 →
  连续 3 次（≈90s）判定「假死」，然后：
  ① **留证**：探针错误、进程 CPU/内存/线程数、`bridge.log` 末尾 8 行、中断时长 → `state/watchdog.log`
     + `state/watchdog-incident-*.json`；
  ② **杀**掉卡死进程（默认还会扫掉其它匹配 `src\bridge.js` 的残留实例，`--no-scan` 可关）；
  ③ **等** `start.bat` 守护窗口把它拉回来（5s 内），30s 没回来就自己 detached 拉 `start.bat`。
  另有：启动宽限 60s、动手后冷却 180s、单实例锁 `state/watchdog.lock`、
  暂停开关 `state/watchdog.pause`（存在时只留证不动手）、`--once`（探一次、不占锁、不动手）、`--no-kill`（观察模式）。
- `watchdog.cmd`（仓库根，**纯 ASCII**）：用 `D:\nodejs16\node.exe` 跑上面那个脚本。
- `scripts/test-watchdog-bridge.mjs`：29 条断言（参数解析／决策矩阵／探针语义（200 与 401 都算活）／日志落盘／
  `startGuard` 真能拉起标记脚本／四个注入式集成场景：桥接没了→拉守护、健康→不动手、暂停→不动手、`--once`）。
  已随 `run-offline-tests.mjs` 一起跑（**46/46 通过**）。

**部署（满足「必须脱离 DSH 进程树」）**
- `D:\dsh\tools\start-bot.bat`（**GBK + CRLF**，改动是纯 ASCII 字节级替换）在桥接块之后加了一行：
  `if exist "%BR_DIR%\watchdog.cmd" start "qq-bridge watchdog" /D "%BR_DIR%" cmd /c watchdog.cmd`
- 同时把并行会话手改进 live .bat 的 `start.bat` 守护补丁**一起写回 `make_launcher.py` 模板**，
  这样以后重新生成启动器不会把这两个补丁吃掉（生成器是 UTF-8/LF，已按它的行尾插入并通过 ast 语法自检）。
- 本次已用资源管理器（等价双击）起了一个常驻看门狗：
  `node.exe` PID 39444 ← `cmd /c watchdog.cmd`(45544) ← `explorer.exe`(11596) —— **不在 DSH 进程树里**；
  `state/watchdog.lock` = 39444，`state/watchdog.log` 里已有 `探针正常：http 200，26ms，bridge PID 5632`。
- 为什么**没**做成开机计划任务：那会打乱 owner 现有的启动顺序（DSH → 登录 QQ → 双击「启动Bot」），
  所以只挂在启动器这条路上，由 owner 自己决定要不要加计划任务。

**验证**
- 真机 `--once`（真探针、真令牌）：`探针正常：http 200，25ms，bridge PID 5632` ✅
- **隔离演练**（`%TEMP%\wd-drill`，随机端口假桥接 + 真替身进程 + `--no-scan` + `--guard-cmd` 指向标记脚本，**不碰真桥接**）
  的实际日志：
  `⚠️ 探针失败 3/3 → ❌ 判定假死（中断约 2s）→ 进程快照 cpu=0s;ws=55.6MB;threads=14 → 🔪 已终止 PID 43192
   → 🚀 已拉起守护命令 marker.cmd → ✅ 已恢复（看门狗拉起）：http 200，16ms → 🧾 事故记录：state\watchdog-incident-*.json`；
  替身进程确实被杀、incident 里 `killed:[{pid,wasAlive:true,ok:true}]`、`recovered.by='watchdog'` ✅

**踩坑（值得记）**：演练用的 `.cmd` 里写了含**中文用户名**的**字面量路径** → cmd 按 GBK 读 UTF-8 的 .cmd，
路径变乱码、`echo ... > file` 静默失败（用 `%~dp0` 展开的路径没事）。所以 `watchdog.cmd` 保持纯 ASCII
（跟 `start.bat` 同一条规矩），中文只出现在 Node 写的 `state/watchdog.log` 里。

**运维**
- 看日志：`state/watchdog.log`；出事的结构化证据：`state/watchdog-incident-*.json`。
- 不想让它动手（要手工排查时）：建空文件 `state\watchdog.pause`，删掉即恢复自动处理。
- 它是个常驻窗口：关掉窗口 = 失去这层保护（`start.bat` 只管「进程退出」，不管「卡死」）。

**未提交**：`scripts/watchdog-bridge.mjs`、`scripts/test-watchdog-bridge.mjs`、`watchdog.cmd`、`docs/FOLDER_MAP.md`
本次改动**没有 git add**（并行会话已立规矩：只 add 明确列出的文件），留给 owner 决定何时提交。

### 16.5 明日方舟日活：owner 一句话触发（2026-09-29 晚）

**需求（owner 定的，逐条对照）**：① 只有 owner 能用（这台机器登的是他的账号）；② 跑完就停、30 分钟兜底；
③ 开的是**官方 PC 端**（`ClientType=Official`），**不碰 MuMu**；④ 只保留「随叫随跑」，不做定时；
⑤ 锁屏不用管（他设了通电不锁屏）；⑥ 允许改 MAA 配置；⑦ 触发条件**只有**「@机器人 帮我做明日方舟日活」，
别的说法一律不触发。

**为什么必须提权、而桥接仍能触发它**
- 官方 PC 端带 **ACE 反作弊**（`AntiCheatExpert\ACE-Service64.exe`）以管理员身份运行；MAA 要截屏 + 发输入给它，
  必须同完整性级别 → MAA 也得管理员。中等完整性进程**既不能给高完整性窗口发输入，也不能结束它的进程**。
- 桥接是普通权限，**不自己启 MAA**：只 `schtasks /Run` 一个预先注册好的**最高权限计划任务**
  （同一账号允许，不再弹 UAC）。这是唯一既不存管理员密码、也不用第三方提权工具的正路。
- ⚠️ **绝不**把桥接整体提权（24/7 带管理员权限 + prompt injection = 灾难）。

**机器上的事实（已核对）**：MAA v6.3.0 在 `G:\MAA`；`ClientType=Official`、`StartGame=true`（MAA 自己拉起客户端）、
`BlockSleepWithScreenOn=true`（自己防息屏）、`StallTimeout=25min`；ADB `127.0.0.1:16384`（MAA 用
`G:\MuMuPlayer\nx_device\12.0\shell\adb.exe`，但这个 adb 只是工具，**不代表要开 MuMu**）；任务队列 8 项＝标准日活；
完成判据是 `G:\MAA\debug\asst.log` 里的 `AllTasksCompleted {"finished_tasks":[...]}`。
（历史：最近一次真正跑完是 9-28 15:03；9-29 21:21 那次 11 秒就退出，日志是 `skip sync_params, retry when connect`
——没连上客户端，说明"客户端就绪"必须作为前置条件。）

**新增**
- `scripts/arknights-daily.mjs`（**提权执行器**）：预检（是否提权／MAA 在不在／ADB／16384 被谁占）→ 打开 MAA
  「直接运行」或发 Link Start 热键 `Ctrl+Shift+Alt+L` → 启动 MAA（官方 PC 端由 MAA 自己拉起）→ 盯 `asst.log`
  **增量**等 `AllTasksCompleted`（成功）/`TaskChainError`（失败），**跑完即停**、最长 `timeoutSec`（默认 1800s）
  → 关 MAA、按需关 `Arknights.exe`/`PlatformProcess.exe` → 写 `state/arknights-daily.json` +
  `state/arknights-daily.log`。参数：`--dry-run`（只预检）`--prepare-maa`（只改 MAA 配置）`--timeout` `--trigger auto|hotkey`
  `--no-close-client` `--no-close-maa`；带运行锁（`state/arknights-daily.lock`）。
- `src/arknights-command.js`（纯函数，执行器与桥接共用）：命令归一 + **严格相等**判定、状态描述、结果措辞。
- `scripts/arknights-setup.ps1`（**一次性提权安装**）：注册计划任务 `qq-bridge-arknights-daily`
  （`-RunLevel Highest` + `LogonType Interactive` + `MultipleInstances IgnoreNew` + 60 分钟上限）→ 打开 MAA「直接运行」
  → 跑 `--dry-run` 自检；`-Uninstall` 卸载。
  ⚠️ 该 .ps1 必须存成 **UTF-8 with BOM + CRLF**：PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文注释会破坏语法（已踩）。
- 桥接侧（`src/bridge.js`）：`socialV2.arknights` 配置块 / `arknightsCfg()` / `readArknightsJob()` /
  `handleArknightsRequest()` / `startArknightsReporter()` / `execFileP()`；`handleIncoming` 里**确定性接管**
  （owner + 对着机器人 + 那一整句 → 入库但**不唤醒模型** → `schtasks /Run` → 回一句）；回报器每 30s 轮询状态文件，
  把结果发回**原会话**；唤醒提示里加 `【方舟日活】` 状态行（正在跑/刚跑完）。
- 预设第 24 条：告诉模型"这件事你做不到、只有那条命令会触发、别答应别假装"，被问起时看【方舟日活】那段。
- 测试：`scripts/test-arknights-command.mjs`（22 条：只认那一句；少字/多字/前后加字/换说法/命令配空都不触发）
  + `scripts/test-arknights-daily.mjs`（28 条：预检闸门、完成/出错判据、跑完即停、早退判失败、超时兜底、关进程、报告措辞）。

**需要 owner 手动做一次（我提不了权）**
```
管理员 PowerShell：
powershell -ExecutionPolicy Bypass -File D:\dsh\qq-bridge\scripts\arknights-setup.ps1
```
之后在群里 @机器人 发「帮我做明日方舟日活」即可（**只有这一句**会触发）。

**已知边界**
- 任务必须「用户已登录且未锁屏」——owner 已设通电不锁屏。
- 若 MuMu 播放器正占着 `16384`，MAA 可能连到模拟器：执行器会把端口占用者写进日志并警告（不自动杀 MuMu）。
- `trigger: auto` 会改 MAA `gui.new.json` 的 `RunDirectly=true`（改前备份 `.bak-arknights`）；不想动 MAA 配置就用 `--trigger hotkey`。
**回报是**轮询**而非推送：执行器若崩溃，超过 `timeoutSec + 10 分钟` 会有一条「好像没跑起来」的兜底消息。

### 16.5.1 修正：**必须先起官方 PC 端、等 30 秒再起 MAA**（owner 实测，2026-09-29 21:50）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.5.1。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.5.2 修正二：桌面图标只开**启动器**，要直接起游戏本体（owner 指正，2026-09-29 22:0x）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.5.2。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.5.3 修正三：PC 端走 **Win32**，ADB 警告是误报；检测成功也要打日志（2026-09-29 22:1x）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.5.3。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.6 终末地日活（MAAEND）：同一套引擎 + 第二个档案（2026-09-29 深夜）

owner 要求：「@bot 帮我做终末地日活」→ 打开游戏 → 打开 MAAEND → 跑完即停、**30 分钟兜底**；
并特别指出 **MAAEND 不需要管理员身份**。

**摸底到的事实**
- MAAEND v2.30.1 在 `G:\MAAEND`：`MaaEnd.exe`（MaaFramework + MXU 界面的 GUI，无命令行开关）+
  `maafw\MaaPiCli.exe`；配置是 `config\mxu-MaaEnd.json`（不是方舟那种 gui.new.json）。
- 它的设置里有现成的 **`settings.autoRunOnLaunch`**（= 启动即跑）和 **`hotkeys.startTasks = F10`**（兜底热键），
  以及 `webServerPort=12701`（WebSocket，纯 HTTP 探测会挂住，暂不依赖它）。
- 实例：`全套日常`（7 个任务）/ `快速日常`（6）/ `基质刷取`（2），当前 `lastActiveInstanceId` = 全套日常。
- 日志：`debug\<日期>-N.log`（GUI 日志；`autoClearLogsOnLaunch=true` → 只留当天的）+ `debug\maafw.log`（MaaFW 内核）。
- 控制器：`interface.json` 里 `Win32-Front`（`class_regex=UnityWndClass` / `window_regex=Endfield`）→ **同样没有 ADB**。
- 游戏本体：`G:\Hypergryph Launcher\games\Endfield Game\Endfield.exe`，清单是 **`requireAdministrator`**
  → **游戏要管理员，MAAEND 不要**；所以执行器仍然提权（为了静默起游戏），但把 MAAEND **降权**启动。

**改动（引擎重构 + 第二个档案）**
- 引擎从"方舟专用"改成**多档案**：`scripts/game-daily.mjs`（`DEFAULT_ARKNIGHTS` / `DEFAULT_ENDFIELD` + `PROFILES`）；
  `scripts/arknights-daily.mjs` 与 `scripts/endfield-daily.mjs` 只是薄 wrapper（**计划任务里的路径不变**，
  旧的 `test-arknights-daily.mjs` 因为 `export *` 继续有效）。
- 「启动即跑」改成**声明式补丁** `autoRunPatches`（`defaultPrepareMaa` 通用实现，改前备份 `*.bak-gamedaily`、幂等）：
  方舟 = `StartUpSettings.RunDirectly=true` + `RuntimeSettings.StartGame=false`；
  终末地 = `settings.autoRunOnLaunch=true`。
- **MAAEND 降权启动**：执行器已提权，不能再直接把 MAAEND 拉成管理员（owner 的用法是普通权限）→
  用 `explorer.exe "<MaaEnd.exe>"` 代启动，它就以中完整性跑；配置项 `maaDeElevated: true`。
- **完成判据**（终末地）：`successPatterns: ['Tasker\.Task\.Succeeded']` 计数，配 `expectedTaskCount`
  （从 `mxu-MaaEnd.json` 当前实例数出启用任务数，实测 7）+ 完成文案判据 + 30 分钟兜底；
  另有 `failurePatterns: ['Tasker\.Task\.Failed', '任务失败']`。方舟仍是 `AllTasksCompleted`。
- **多日志监听**：`maaLogDirs`（终末地 `G:\MAAEND\debug` 下所有 `.log`）+ 固定路径，逐文件按 offset 读增量。
- 工具进程名可配（`toolProcessNames`：方舟 `MAA` / 终末地 `MaaEnd`）——守卫、退出判定、收尾都用它。
- 桥接侧：新增 `socialV2.endfield`，把手写的"方舟单例"改成 `gameJobs()` 遍历（触发 `handleGameJobRequest`、
  回报 `startGameJobReporters`、提示词状态行）——所以**再加一个游戏只需加一块配置 + 一个 wrapper**。
  触发方式支持 `mode: task`（默认，`schtasks /Run` 那个最高权限任务）或 `mode: direct`（桥接直接拉执行器）。
- 安装脚本泛化：`scripts/game-daily-setup.ps1 -Profile arknights|endfield`（`arknights-setup.ps1` / `endfield-setup.ps1`
  是两个 wrapper，向后兼容），注册 `qq-bridge-endfield-daily`（最高权限 + 仅登录时运行）。
- 测试：新增 `scripts/test-endfield-daily.mjs`（档案默认值、声明式补丁幂等/备份、多日志清单、期望任务数、
  自定义判据、计数式完成、降权启动、失败判据、已在运行则拒绝）；预设契约新增一条钉住"只有 owner 那两句会触发"。
  **离线 49/49 通过。**

**需要 owner 手动做一次（我提不了权）**
```
管理员 PowerShell：
powershell -ExecutionPolicy Bypass -File D:\dsh\qq-bridge\scripts\endfield-setup.ps1
```
之后在群里 @机器人 发「帮我做终末地日活」即可（**只有这一句**）。

**已知待验证**：MAAEND「整轮跑完」的日志文案我还没见过真实样本（GUI 日志每天清空，今天只开了程序没跑任务），
所以现在主要靠「数到 7 个 `Tasker.Task.Succeeded`」收尾；第一轮跑完后请把 `state\endfield-daily.log` 与
`G:\MAAEND\debug` 里当天的日志尾巴发我，我把文案判据钉死（否则可能要等到 30 分钟兜底才收尾）。

### 16.6.1 修正：**别把 `PlatformProcess.exe` 当成"游戏在跑"**（owner 实测，2026-09-29 22:47）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.6.1。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.6.3 修正：「跑完了但 MAAEND 不退出」——期望任务数算错了（2026-09-29 深夜）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.6.3。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.6.4 修正：**日志轮转**让偏移量失效，一个事件都读不到（2026-09-29 23:53 实测）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.6.4。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.6.5 修正：单个任务失败**不该**让整轮中止（owner 实测「跑几次都中途退出」，2026-09-30）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.6.5。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.7 省 token 改造（方案 1~4，2026-09-30）

**先把钱花在哪量化**（控制台 `/api/tokens/*` + `state/tool-calls.jsonl`，近两天）：

| 指标 | 实测 |
|---|---|
| 总量 | 199 回合 / 932 步 / **¥15.12**；`avgCostPerTurn ¥0.076`、`avgCostPerStep ¥0.0162` |
| 拆解（非高峰价） | cacheMiss 4.47M → ¥4.47；cacheHit 132M → **¥2.64**（命中率 96.7% 但量大）；output 0.45M → ¥1.81 |
| 分时 | **82% 花费在高峰**（价目表 `peakMultiplier: 2`，工作日 09-12 / 14-18） |
| 每步上下文 | 群会话 **51,864 tokens/步**（最贵一轮 44 步 × 4.74M 输入 = ¥0.378） |
| 工具往返 | 392 次里 **`qq_wait_for_messages` 152 次（39%）** |
| 归属 | 群 ¥4.54（64 回合/706 步）、黑话学习 ≈¥4.5、其余是"只剩累计值的历史"（账本淘汰明细，不是外部会话） |

结论：**成本 ≈ 每步上下文 × 步数 × 回合数（再乘高峰系数）**。所以只做 1~4 这四条（**不改工具代码、不改模型**）：

**1. 削步数**
- 等待默认 30s → **10s**（`socialV2.wait.defaultMs`；桥接本来就会把新消息推进会话，长轮询是空转）
- **单轮步数上限 `turnMaxSteps: 20`**：超过就 `api.stopSessionWork()` 请求 DSH 收尾，避免再出现 44 步的回合
- 预设收紧：**"等人最多等一次"**（一轮只用一次 `qq_wait_for_messages`、20~30 秒；纯围观不等）、
  "一次发送用数组"、"mark_read 与发送同轮"、"发完不要复查"（第 25 条）

**2. 削上下文**（⚠️ 只动了"喂给模型多少"，**没动**机器人的记忆窗口 —— 见 16.7.1）
- `context.wakeMessageLimit` 12 → **8**、`wakeRecentLimit` 4 → **3**、`wakeMaxChars` 6000 → **3000**（唤醒提示内联多少）
- `sticker.promptMaxStickers` 8 → **4**、`memes.promptMaxMemes` 6 → **4**（每轮都注入的候选表）
- 预设：拉消息用小 limit（10~15）、不要一次拉一百条（图片/表情按需看那半句只是预设措辞，**没动工具代码**）
- `context.recentLimit` / `unreadLimit`：**保持 100 / 30 不变**（原计划要压到 30/15，实测发现那是机器人的
  记忆/缓冲窗口本身，压小会让人感知到"漏消息、忘掉半小时前"，而且会破坏 `test-token-economy.mjs`
  的 eviction + 水位契约 → 撤回）

**3. 减回合**
- `proactive`：间隔 30~90min → **2~3h**、`probability` 0.3 → **0.2**、新增 **`quietHours: [1,8]`**（01:00~08:00 不主动开口）
- 新增 **`autoReplyCheckOnlyWhenExpected: true`**：只有"对方在问/引用我/我之后还有未回的新消息"时才排回复检查，
  否则日志写 `跳过回复检查（没人提问/点名，也没有未回的新消息）`（这个唤醒以前大概率什么都不说，纯烧一轮）
- `errorRetry.malformedMax` 2 → **1**（一次重试就是整轮重发）

**4. 黑话学习**
- `slang.offPeakOnly: true`：**高峰时段不跑**（用 `isPeakAt()` 判，与面板同一张价目表）
- `slang.researchMinPending: 6`：**攒够 6 条候选才研究一次**（以前一有新词就开一轮会话）
- `slang.researchBatchMax: 5`：单批最多研究 5 条，别一次喂几十条

**验证口径**（改完看一天就够）：控制台 `/api/tokens/summary` 的 `avgCostPerStep`、`avgCostPerTurn`、
`cacheHitRate`，以及 `socialV2.proactive` 的下一轮安排（重启后日志实测：`已安排主动机会检查 … 约 172min 后` ✓）。
预计 1+2+3 三条能砍 **45%~60%**（稳态从 ~¥7.5/天 往 ¥2~3/天 走），黑话学习那条再单独看一天。

**没做的事**（owner 说"其它不要动"）：工具集瘦身、模型分档、缓存友好策略、每日预算告警。

### 16.7.1 撤回：`recentLimit`/`unreadLimit` 不是"喂多少"，那是**机器人的记忆窗口**（2026-09-30）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.7.1。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.8 修正：「干跑截止时间到」给 owner 重复发了很多次（2026-09-30）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.8。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.9 政策：**系统状态提示一律不发群**（owner 2026-09-30）

owner：「⏹️/⏰/⚠️ 这类系统提示加上就不太像群友了」→ 群里**不再出现任何"系统通知"**。
原本会发到群的六种，全部改走新的统一出口 `systemNotice(key, text, { ownerDm })`
（只写 `state/bridge.log` + `state/qq-activity.log`，需要 owner 知道的可走私聊）：

| 原来发到群里的 | 现在 |
|---|---|
| `⏹️ 已停止`（回合被中止，含我们自己按步数上限停的） | 只记日志（要私聊就把 `socialV2.notifyOwnerOnAbort` 设 true） |
| `⏰ 等待回答超时，已取消该请求` | 只记日志 |
| `⚠️ 我这边卡了一下，这条没处理成功，稍后再试。` | 只记日志 |
| `⚠️ 消息未被接受：…`（两处） | 只记日志 |
| `⏳ 系统服务重启中，消息已排队，恢复后自动处理。` | 只记日志 |
| `⚠️ 本条回复因疑似包含敏感信息…被安全策略拦截…`（两处） | **改私聊 owner**（安全可见性不丢，群里静默） |

顺带把**单轮步数上限 20 → 30**：本群活跃时段正常回合就能到 20~25 次工具往返，
2026-09-30 14:28 / 14:56 群里看到的那两句 `⏹️ 已停止` 就是被 20 这个值切出来的。

**保留的**（这些是被明确要求/交互触发的，不算"系统通知"）：日活回报、生图受理与失败提示、
投喂回执、管理员 `/命令` 的回执、agent 提问/审批的中继（后者只在 AI 主动提问时出现）。

防回归：契约测试新增 5 条"不许再发群" + "必须走 `systemNotice`"；`test-turn-retry.mjs` 里
"出错时群里给一句人话"那条按新政策改成"不许发群"。**离线 49/49 通过。**

### 16.10 修正：QQ 内置表情读不到（face 图片 URL 已 404，2026-09-30）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.10。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.11 真凶：DSH 校验图片 base64 的正则**爆栈**，大图被降级成文本（2026-09-30）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.11。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.12 修正：逐轮明细"最新只到第 265 轮"——按 turn 排 ≠ 按时间排（2026-10-02）

> 🗄️ **过程记录已归档** → [`docs/legacy/INSTALL_NOTES-16-process-archive.md`](../legacy/INSTALL_NOTES-16-process-archive.md) 的 §16.12。
> 结论就是上面这个标题；细节（踩了几次、怎么发现、原始日志片段）在归档里。

### 16.13 生图后端：默认走火山方舟 Agent Plan，失败回落 codex（2026-10-05）

**为什么换**：原来只有一条生图链路（`codex-image.ps1` → 本机 Codex CLI → `chatgpt.com` 的
ChatGPT 订阅后端）。它**极度依赖 VPN**：代理节点一抖就 `image generation failed: network error`，
群里那轮生图就废了（实测 `rmcp::transport::worker ... https://chatgpt.com/backend-api/ps/mcp`
反复超时，而同一时刻代理本身是活的、`curl` 经代理访问 chatgpt.com 也能通 ✓）。

**为什么第一次配 key 会 401**（踩过的坑，值得记）：Agent Plan 的**专属 API Key 只能配专属端点**。
控制台「配置模型及 Base URL → 视觉模型 → API 接入」给的是
`https://ark.cn-beijing.volces.com/api/plan/v3/images/generations`（**`/api/plan/v3`**），
我一开始按普通方舟的 `…/api/v3/…` 去打 → 一律
`AuthenticationError: The API key or AK/SK ... is missing or invalid` ✗。
控制台旁边还明确警告：**请勿使用 `…/api/v3`，接入会产生额外费用**。
（排查时可利用报错差异：去掉 `ark-` 前缀 → `The API key format is incorrect`；
只留裸 UUID → `The API key doesn't exist`；**原串格式合法但不被接受 = 端点用错了**。）

**模型与计费**（[Agent Plan 个人版 · 接入视觉模型](https://www.volcengine.com/docs/ark/agent-plan-personal-visual-models)）：
`doubao-seedream-5.0-pro`（文生图 / 单·多图生图 / 交互编辑 / 图层拆分；**不支持文生组图** ✗；
1K/1.5K/2K）与 `doubao-seedream-5.0-lite`（**即将下线** ✗；支持文生组图/流式/联网搜索；2K/3K/4K）。
套餐内按 **AFP 抵扣**（官方实践文档举例：lite 一张 ≈ 99 AFP）。实测 `pro` 出 1776×2368 一张
≈ 64s、`usage.output_tokens 16428`（**这条链是按 token 计的**），带 1 张参考图也通
（`input_images: 1` ✓）。

**改法**
1. 新增 `src/ark-image.mjs`：端点规整（整条 URL / 带 `/api` 的 base / 只给主机 三种输入都认，
   只给主机时补**完整的 `/api/plan/v3/images/generations`**，避免手滑打到会产生额外费用的 `/api/v3`）、
   请求体构造（`model`/`prompt`/`size`/`response_format: b64_json`/`watermark: false`，
   单张参考图传字符串、多张传数组）、**按字节认图片格式**（Ark 返回 JPEG，不能被 `.png` 扩展名骗）、
   后端选择 `pickImageBackend()`、以及 `generateWithArk()`。
2. `scripts/gen-image-worker.mjs` 改成**双后端**：默认 Agent Plan，失败自动回落 codex
   （`backend=codex` 可强制；缺 key/Base URL 时直接走 codex）。
   key 与 Base URL 优先取 `socialV2.image.arkApiKey/arkBaseUrl`，否则读
   `state/ark-key.txt` / `state/ark-base.txt`（都在 `.gitignore` 覆盖的 `state/` 下，**不进仓库** ✓）。
   写盘前按真实 mime 修正扩展名（`img-….png` → `.jpg`）。
3. 配置（`config.json` / `config.example.json`）：`socialV2.image.backend: 'auto'`、
   `arkModel: 'doubao-seedream-5.0-pro'`、`arkSize: '2K'`、`arkKeyFile`、`arkBaseFile`、`arkTimeoutMs`。

**回归**：新增 `scripts/test-image-backend.mjs`（13 组断言：端点规整 3 种输入 / 请求体含参考图两种形态 /
按字节认格式 / 后端选择（auto、强制 codex、没配好退回 codex）/ 成功（b64 与 url 两条路）/
失败带出服务端原文 / 参数不全不发请求 / worker 接线与扩展名修正），**离线 52/52 通过**。

**出图实测**（同一套四格漫画提示词，重新生成的那张在 `D:\dsh\out\`）：中文台词基本写对、
版式与数字（404 行 / 今天 15 轮 / 72 小时 82 轮 / lastAt 10-05 17:41 / 214 vs 291 轮）都在 ✓；
个别字会糊（`旧探针崴催输出`、清单里有一行重复）——要百分百准确就用"空气泡 + 后期贴字"。

**补丁（2026-10-12）：失败文案甩锅给 codex** ✗

owner 反馈"生图失败报的是 codex"，查日志发现**第一个拒的其实是火山方舟** ✓：

```
[07:04:43] ⚠️ Agent Plan 生图失败 HTTP 400：The request failed because the output image
           may contain sensitive information. Request id: 0217917…
[07:04:43] ⚠️ 回落 codex（原因：… sensitive information）
[07:05:09] ❌ 生图失败 code=1（132s，后端=ark）…输出: … 网络不可达：直连 chatgpt.com 失败 …
[07:05:10] 💬 图没画出来：codex 那边出错了（不是你的问题）…   ← 群里收到的就是这句 ✗
```

根因：失败原因分类只读 **codex 那半段日志**，把结论统一说成"codex" ✗ —— 而 Ark 的
内容审核拒绝和 codex 的网络失败是两回事。后果是 owner 与群友都会误判该改什么。

**改法（只改「怎么说」，不动「要不要回落」）**：新增 `src/image-failure-text.mjs`（纯函数：
`classifyArkFailure` / `classifyCodexFailure` / `buildImageFailureText` / `looksLikeModeration`），
worker 改为让两个后端的原因都如实出现，并对审核类失败补一句"换个描述、别用真人参考图
（重发原样还会被拒）" ✓。同一句失败现在长这样：

```
图没画出来：火山方舟说输出图可能含敏感内容（内容审核挡下了）；回落的 codex 也失败
（网络到 chatgpt.com 不通）。这种情况换个描述、或别用真人参考图（重发原样还会被拒）。
这次不扣次数（你那句「…」我记着，重新 @我 发一次就行）。
```

⚠️ **按 owner 决定：不改"Ark 失败后仍回落 codex"的策略**（审核类失败也照样试一次 codex）✓。

**回归**：`test-image-backend.mjs` 扩到 **18 组**（新增：两个原因都要出现且首个必须是真正先失败的
后端 / Ark 401·429·超时·网络·HTTP xxx 分类 / 只跑 codex 时保持原口径 / 审核类识别 / worker 接线
且回落策略未动）；`test-image-state.mjs` 的源码断言同步指向新模块并加一条"不再只报 codex"。
**离线 52/52 通过** ✓。

### 16.14 DSH 会话归档：官方没这功能，用"搬目录"等效（2026-10-12）

**问题**：qq-bridge 每清一次上下文就新开一个 DSH 会话，`--D-dsh-qq-bridge--` 工作区攒到 **441 个**
（全库 477 个 / 101.8 MB），DSH 的会话列表被撑满。翻遍 `dsh-web-app` / `dsh-session` / 会话 UI 包，
**没有任何 archive/归档实现** ✗。

**存储事实**（实测）：会话在 `~/.dsh/sessions/<工作区 slug>/session-<uuid>/`，里面是
`session.jsonl.zstd` + `session.v3.jsonl.zstd`；**没有中央索引文件** → "把会话目录搬走"就等于
"从界面里归档"，而且完全可逆 ✓。桥接只在 `state/sessions.json` 里记**当前那一个** session id
（`sessions["group:541026885"] = "session-c3da5e92-…"`），只有它不能动。

**做法**：新增 `scripts/archive-dsh-sessions.mjs`（默认**只预览**，`--apply` 才动手）：

```powershell
node scripts/archive-dsh-sessions.mjs --only --D-dsh-qq-bridge--          # 预览
node scripts/archive-dsh-sessions.mjs --only --D-dsh-qq-bridge-- --apply  # 真搬
node scripts/archive-dsh-sessions.mjs --restore "<manifest.json>"         # 还原
```

三条保护：① `state/sessions.json` 里记着的会话永不搬；② 最近 `--keep-days`（默认 7）天内更新过的
永不搬；③ 工作区目录里非 `session-*` 的条目（DSH 自己的工作区元数据）永不碰。搬运目标
`~/.dsh/sessions-archive/<YYYY-MM>/<工作区>/<session-id>/`，同时写 `manifest-*.json` 供还原 ✓。

**实测预览**：只处理 bot 工作区 → 可归档 **332 个 / 40.8 MB**（保留在用 1 个 + 最近 7 天 108 个）；
`--keep-days 3` → 383 个 / 47.1 MB。搬完刷新页面即可（列表若仍有缓存就重启 DSH ✓）。

**待办**（未做，属另一项改动）：查清桥接为何频繁新开会话（`sessions.json` 里已有 `sessionPolicies`
机制），从源头把会话数稳住。

### 16.15 卡片链接：群友发 B 站/网页卡片 → 去读并总结（2026-10-12）

**问题**：群友发来 B 站分享卡片时，`json` 段一律被压成 `[卡片消息]`（`src/bridge.js` 的
`case 'json'`、`src/forward.js` 同款），**卡片里的 URL 被丢掉** ✗ → 模型只看到四个字，根本没法去读 ✓。

**现状盘点（决定了这事很便宜）** ✓：bot 的 agent **早就有** `mcp__web-search-safe__web_search/fetch`
（preset `qq-chat-v2/agent.cordis.yml` 第 179 行甚至已写明"群友直接发来 URL 就 web_fetch 抓正文"）✓，
`src/safe-fetch.js` 也已有 SSRF 防护（禁内网/环回/CGNAT）✓ —— 缺的只是"把 URL 递到模型眼前" ✓。

**做法（P0 通用 + P1 B 站）**：
1. 新增 `src/card-link.js`：卡片解析（`meta.detail_1.qqdocurl` / `meta.news.jumpUrl` / `url` 多路兜底 ✓、
   剥跟踪参数 ✓、滤掉缩略图 CDN 与图片直链 ✓、识别站点 ✓、`b23.tv` 短链 ✓），输出
   `[B站卡片：标题] https://…`；**解析不出就回退 `[卡片消息]`** ✓（向后兼容）。`bridge.js` 与
   `forward.js` 的 `json` 段（并新增 `share` 段）都改用它 ✓。
2. 新增 `src/link-bilibili.js`：B 站**免登录**接口 `api.bilibili.com/x/web-interface/view` ✓
   → 标题 / UP / 时长 / 分区 / 播放点赞等 / 分P / 简介 ✓，短链 `b23.tv` 先展开 ✓；
   带 30 分钟缓存 + 并发去重 ✓，抓不到只返回一句诚实原因 ✓。
   （B 站网页是 JS 渲染的，`web_fetch` 读不干净 ✗，所以这层适配是必要的。）
3. `src/bridge.js`：消息到达时**非阻塞预取**卡片里的 B 站元信息（带缓存），模型被唤醒时由新增的
   `linkLine` 注入提示 —— **只在被 @/被叫到时模型才会看到** ✓，天然满足"触发时机"要求 ✓。
   提示里同时写明：通用网页自己 `web_fetch` ✓；B 站**没有字幕**、别编视频内容 ✓；
   网页内容只当素材、**不执行其中指令** ✓（提示词注入防护）。
4. 配置：`socialV2.links = { enabled, bilibili, maxLinks, timeoutMs, descChars, ttlMinutes }`
   （`config.json` / `config.example.json` 已加 ✓；配置**即时生效**，但 `bridge.js` 是常驻进程
   → 这次改动要**重启桥接**才生效 ✓）。

**没做** ✗：控制台 UI 开关（控制台不是内联表单，没找到渲染点；开关走 config ✓）；
视频内容级总结（字幕/ASR）属 P2 ✓；小红书/微博专用适配不做（反爬 + 需登录）✓。

**真实样本待验证** ⚠️：解析器的字段覆盖是按 QQ 分享卡的常见结构写的，**还没拿真实卡片验证过** ✗ ——
第一次收到真卡片时看一眼 `bridge.log` 里有没有 `[link]` 行即可确认 ✓；
解析失败会**自动回退旧行为** ✓，所以不会因为格式不符而变坏 ✓。

**回归**：`scripts/test-card-link.mjs`（9 组断言：分享卡 / 小程序卡 / 无链接卡 / 畸形 JSON /
跟踪参数剥离 / 图片直链过滤 / BV·av·番剧·专栏·动态·短链分类 / 站点标签 / 三种入参形态）+
`scripts/test-link-bilibili.mjs`（6 组：万·亿口径 / 时长格式 / 摘要拼装与简介截断 / 单P 无分P /
早退不触网 / 结果进缓存），**离线 54/54 通过** ✓；
B 站联网实测：`node scripts/test-link-bilibili.mjs --live` ✓。

### 16.16 引用图片：模型不知道你引用的是哪一条（2026-10-13）

**现象**（owner 反馈）：引用一张图片问 bot，它像"认不出你引用的是哪张图 / 哪种图"。

**定位**（代码 + 日志双证）：
- `segmentsToText` 的 reply 段以前只拼 `[引用 发送者：文本]`（`src/bridge.js`）→ 被引用的是
  **图片/表情**（没有文本）时只剩 `[引用 某人]` ✗：**既没有 messageId，也没说明这是图片消息** ✓；
- 于是模型只能猜：2026-10-11 22:51~22:54（本地）日志里它对 **5 个不同 id** 连调
  `qq_get_message_images`（`-1370457565` / `734759114` / `-1434040905` / `-203018135` / `501067470`）✓。

**一点澄清**：`qq_get_message_images` 返回时**本来就会标注** `[表情N]` / `[图片N]` ✓
（`src/mcp-snowluma-safe.js:1150` ✓）—— 所以"分不清种类"**不是**根因 ✗，根因是**不知道引用的是哪一条** ✓。

**改法**（新增 `src/quote-ref.js`，纯函数可测）：
1. 引用段改为 `[引用 发送者：文本｜附件：图片×N｜quotedId=…]` ✓；附件类型取自
   `messageMediaStore`（收到消息时就存的本地元数据 ✓，**不联网** ✓）；给 `segmentsToText` 增加
   `lookupMedia` 选项 ✓，`textContent` 与 `plainContent` 两处都传 ✓。
2. 唤醒提示新增 `quotedLine` ✓：最近消息里出现"引用了带附件的消息"时，把 **quotedId** 直接给模型 ✓，
   并明确写「**不要**拿其它 id 挨个试」✗（把 10-11 那个错写进提示里 ✓）；同时打一行
   `[quote] 注入引用提示：quotedId=… 附件=…` ✓，方便事后核对 ✓。
3. 配置 `socialV2.quote.enrich`（默认 true ✓；设 false 即回到旧行为 ✓）。

**没做（架构限制，如实说）**：**不能**把被引用的图片**自动塞进提示词** ✗ —— 图片只能经 MCP 工具
结果进模型 ✓。所以这里做的是"**精确告诉它该看哪一条**" ✓（效果上等价于不再猜 ✓）；
图像字节仍由 `qq_get_message_images` 拉取 ✓（元数据已在本地 ✓，返回很快 ✓）。

**回归**：`scripts/test-quote-ref.mjs` 7 组断言（附件计数 / ★图片消息必须带 quotedId 与附件 /
有文字与无附件两种形态 / 长文本截断与危险字符清理 / 文本↔解析往返 / 提示必须点名 quotedId 且禁止瞎猜 /
bridge 两处接线守卫）✓；离线全绿 ✓。

### 16.17 唤醒积压：为什么 AI 会"接几分钟前的话"（2026-10-14）

**现象**（owner 反馈）：18:44 被唤醒，接的却是 18:35 的话。

**定位（日志 + 代码双证）**：
- 事故时间线：`18:35:51 会话繁忙，暂存唤醒原因（8807）` → 期间又暂存 8808/8809 →
  `18:44:32 补发繁忙期间积压的唤醒（挑的是最早的 8807）` → 延迟 **8 分 41 秒**；
- 那 9 分钟 AI 在干什么：两次 `qq_wait_for_messages(timeoutMs=300000)`，其中一次**等满 300 秒**
  （`18:39:28 → 18:44:28`）—— 它在"等群里有人接话"，属设计行为；
- **桥接里是两条互不知情的通道** ✗：
  - 未读水位 `st.lastUnreadSeq` → **只有它能让 `qq_wait` 提前返回**（`bridge.js:7414-7416`）；
  - `st.pendingWakeReasons`（暂存唤醒原因）→ **只能等 turn 结束后补发**，不会让等待提前返回；
- 更细的两个缺口：
  - **2 秒缝隙** ✗：`purpose=messages` 的基线是"请求那一刻的未读数"（`bridge.js:7385-7386`），
    于是在"上一次等待返回 → 这一次等待建立"之间到达的消息会被当成旧消息漏掉
    （18:39:26 返回、18:39:28 新建，那条 18:39:28 的消息就被吞了）；
  - **补发挑最早 + 无过期** ✗：回放用 `shift()` 取**最早**那条，且只看"消息是否还在未读里"，
    完全不看隔了多久。

**改法（④①②；⑤ 试过又撤了，见下）**：
1. **④** `qq_wait` 期间 `pendingWakeReasons` 非空**也算"有消息"** → 立即返回，并把队列
   **交给当前回合**（清空，不再补发）；响应对应加了 `pendingWakeDelivered`；
2. **①+②** 回放改走新纯函数 `src/wake-backlog.js` 的 `pickBacklogWake()`：**丢弃超过
   `socialV2.wake.backlogTtlMs`（默认 120000ms）的**、**只补最新那条**，其余丢弃并记日志
   （被丢的**消息本身**仍在未读缓冲里，模型照样看得到 —— 所以丢弃是安全的）；
3. 入队时补记时间戳 `at`（两处暂存点都改）。

**⑤ 为什么没做（记录一次自我否决）**：原本还想把 `purpose=messages` 的基线从"请求那一刻的未读数"
换成"模型已见水位"（`readThroughSeqV2`）来堵那个 2 秒缝隙 ✗ —— 但实测它会让 `qq_wait` 在
**有未读时立刻返回** ✗，改变了等待契约，回归里 4 条 "in-flight wait …" 行为断言当场变红 ✓。
而且那条缝隙消息**当时同样进了 `pendingWakeReasons`** ✓，**④ 已经能把它交给当前回合** ✓ ——
所以 ⑤ 属于多余且危险 ✗，保持原样 ✓（源码守卫里加了断言锁死这一点 ✓）。

**回归**：新增 `scripts/test-wake-backlog.mjs`（8 组断言：空队列 / 单条 / ★只补最新 / ★TTL 丢弃 /
全过期 / 老结构兼容与坏数据过滤 / TTL 可配置与非法回落 / bridge 四处接线且旧写法已消失）✓。


### 16.18 DSH 0.2.0 升级记录（2026-10-15）

正式全局 DSH 已由 **0.1.7-rc.2 升至 0.2.0-rc.2**，继续使用现有 web profile 和自己的 fork，未合并上游。
本轮按 owner 最新要求优先确认 DSH 能打开，**不执行正式 QQ 桥接回归，也未重启 QQ 桥接进程**。
兼容源码已部署；已运行的桥接进程将在以后正常重启时载入新的协议适配。

- 插件实际变更：better-sidebar 0.22.1 → 0.26.0，pet 0.2.7 → 0.3.7，dshmarket 1.45.1 → 1.66.22，find-plugin 0.3.7 → 0.4.0。
- 按 owner 明确选择，**dsh-find-plugin 保留安装但从 profile.bundles 移除，暂不加载**，未启用版本检查豁免。
- dsh-at-file 保留原 0.7.0 Git commit；对原安装应用 settings 与 lazy codec 兼容补丁，脚本为 scripts/patch-dsh-at-file-settings.mjs。鲸鱼挂件、两套皮肤、表情包插件保持原版本。
- DSH 升级后重新应用 scripts/patch-dsh-base64.mjs；MCP 与 ACP 两处均保留线性 base64 校验。以后重新安装 DSH 或 dsh-at-file 后需重打相应补丁。
- 源码适配：队列优先读取 session/projections 并保留 session/control 回退；QQ 工具限制名单依实际安装包校对为 74 项；qq-mode-console 保留配置元数据并移除旧 settings.register 调用。未修改卡片链接、引用图片或唤醒积压业务逻辑。

**本轮正式验证范围**：全局 package.json 为 0.2.0-rc.2，3080 端口正常；通过启动令牌进入网页，关闭新版说明后主界面可用，原工作区、模型选择、皮肤与小鲸鱼挂件显示。桌面启动器使用的 D:/dsh/dsh-web.url.txt 已刷新。
配置文件 config.json、角色、模式、console-token、ark-key/base 和 DSH credentials 的 SHA256 均与切换前一致。
未发送模型提示或 QQ 消息；未运行 QQ 功能回归，不能把“网页可打开”当成 QQ、生图等功能已通过验证。隔离演练进程已停止，临时 watchdog.pause 已移除。

**备份与回滚**：D:/dsh/backups/dsh-execution-20261015-1640 下保留原 DSH runtime、完整 profile node_modules、源码与 Git bundle、会话/存储，以及切换前新备份 precut-current（state、config、profile 配置、原启动日志）。upgrade-result.json 记录实际版本与配置核对结果。
回滚时先停正式 DSH，只还原程序、插件清单/运行目录和必要兼容源码后启动旧版；QQ 插件链接需保持指向自己的 plugins 目录。不要默认覆盖升级后新增的会话、账本或 state。原 preUpgrade 目录的 rollback.ps1 包含全量 state 覆盖，不应不经检查直接运行。
本轮源码保留在工作区，尚未提交或推送，QQ 回归留待后续安排。

### 16.18 B 站登录态：cookie jar 滑动续期 + 扫码自动续期（2026-10-15）

**为什么做**：官方字幕/评论接口需要登录态，而"抄一次 SESSDATA 写进配置"会在固定
`Expires`（一般 ~30 天）后失效 —— 这就是"每过一段时间都要重弄一次"的根因。
参考项目 **dsh-bili-scroll**（MIT，`github.com/c1overzz/dsh-bili-scroll`）的 `lib/login.mjs`
与 `lib/asr.py`：我们只借它的**结论与接口参数**，代码是自己写的。

**① cookie jar 滑动续期**（`src/bili-auth.js`）：
- B 站是**滑动续期**：带有效 cookie 请求时，响应里常会再 `Set-Cookie` 一个新的（过期时间往后推）；
  所以核心动作就一句 —— **把响应里的 Set-Cookie 存回 jar**（`absorb()`），并落盘到
  `state/bili-auth.json`（gitignored）。
- 失效判据：`GET /x/web-interface/nav` → `code=-101` / `data.isLogin=false`（实测）。
- 细节坑（离线回归抓到过）：B 站登出时发的是 `Expires=Thu, 01 Jan 1970`，解析出来正好是 **0**，
  而 0 在本模块里又表示"会话级/无过期" —— 只看 `exp` 会把"删除"误判成"会话级"。
  所以 `parseSetCookie` 额外返回 `hasExpiry`，删除判断必须用它。

**② 失效自动扫码续期**（`bridge.js` 里的 `biliAuthCheck` / `biliAuthNotifyQr`）：
- 定时体检（`socialV2.links.auth.checkHours`，默认 12 小时）+ 启动后 45 秒各查一次；
- 未登录 → 生成二维码 URL **私聊 owner**（走 `sendOwnerDM` 底层通道，绕过白名单），
  同一条码 10 分钟内只打扰一次；后台每 3 秒轮询，**扫完自动落盘**并回报"已续期"；
- 控制台接口：`GET /api/bili/status`（含 `summary()`，**只给 cookie 名字与过期时间，绝不给值**）、
  `POST /api/bili/login/start`（手动重发二维码）；
- 手动入口：`node scripts/bili-login.mjs`（默认扫码）/ `--status` / `--png` / `--clear`。
- ⭐ 扫码续期的关键接口（照抄它踩过的结论）：`qrcode/generate` 拿 `qrcode_key`；
  `qrcode/poll` 的 `data.code`：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期；
  **凭证在轮询响应的 `Set-Cookie` 头里**，不在 `data.url` 里（那条 url 是别的域的游戏票）。

**回归**：`scripts/test-bili-auth.mjs` 11 组断言（解析/合并/过期删除/`summary` 不泄漏 cookie 值/
滑动续期真的写回磁盘/扫码全流程/过期与超时/源码接线与出处署名），全程不联网（fetch 注入假实现）。

**另一处教训（复用仓库已有的）**：CLI 里**不要**用 `process.exit()` —— 有挂起句柄时会在 Windows 上
触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 崩溃（`test-vision-media.mjs` 踩过），
统一用 `process.exitCode`。

### 16.19 B 站字幕：抓取 + 长字幕分层精编 + 缓存分页（2026-10-15）

**为什么做**：群友分享的 B 站视频，光有标题/简介没法"讲内容"。官方字幕能拿到正文，
但**字幕很长** —— 实测 44 分钟视频：1529 条 cue、原始 JSON 221,494 字、**正文 15,586 字**
（≈1.6 万 token），60 分钟视频能到 2 万字，直接塞进一轮群聊会把上下文打爆。所以要做分层。

**抓取（实测确认的接口链）**：
```
x/web-interface/view?bvid=                  → aid / cid / duration / title
x/player/pagelist?aid=&bvid=                → 多 P 时解析目标分 P 的 cid
x/player/wbi/v2?aid=&cid=&bvid=             → 主路径；**不需要 WBI 签名**（实测 code=0）
x/player/v2?aid=&cid=&bvid=                 → 兜底
  ├ need_login_subtitle=true                → 明确判"该字幕需登录"
  └ subtitle.subtitles[]                    → 优先 ai-zh / 任意 zh / 第一条
subtitle_url                                → 字幕 JSON（body[]：from/to/content）
```
⚠️ 两个实测坑：
- `lan` 形如 `ai-zh` 时 `ai_status` **可能不是 1**，所以"是否 AI 字幕"要两个信号一起看；
- `subtitle_url` 可能是 `//` 或 `/` 开头，都要补全。

**长字幕分层（`buildSubtitleBrief`）**：
| 档 | 触发 | 处理 |
|---|---|---|
| `raw` | 正文与稿本都放得下 | 原文进 prompt |
| `sampled` | 中等 | **按时间桶均匀抽样** + 一句**必须带的声明**："这是全片代表性抽样，要点须分布在全片前中后段，不要都堆在开头" |
| `outline` | 正文 > `outlineThreshold`（默认 12000 字） | 骨架（开头 + 结尾 + 全片抽样）+ 告诉模型"用 `qq_bili_subtitle(bvid, fromSec)` 按时间取原文" |

**长字幕适配借鉴 SmartNote 项目**（本机 `D:\SmartNote`，课程实训项目；**只借鉴思路/参数/正则，未抄代码**）：
- 稿本格式 `[mm:ss] 内容`、单条清洗去赘词（`那个/然后/就是说/其实…`）与语气词；
- 超长时按时间桶抽样、分段在 cue 边界切、提示词里声明"代表性抽样"；
- 同时**修掉它那套的两处问题**（我们离线回归抓到的）：
  1. 桶数一多，`max(64, 预算/桶数)` 的地板会让总长超预算，最后暴力截断 → **结尾段整段丢失** ✗；
     现在**桶数反过来服从预算**（每桶不足 MIN_PER_BUCKET=80 字就减桶数）✓；
  2. `outline` 模式把骨架（头 + 尾）**算在预算之外** ✗ → 预算 2500 会返回 3642 字；
     现在头/尾/抽样三段**共享同一个 injectMaxChars 预算** ✓。

**缓存与分页**：字幕原文（含时间轴）落 `state/bili-subs/<bvid>[-pN].json`（gitignored，默认 7 天）；
全文常驻缓存，进 prompt 的永远只是 ≤`injectMaxChars`（默认 2500 字）的精编稿；
模型想看细节可按 `fromSec` 分页取（`pageSubtitle` 会包含跨过起点的那一条，并给出 `nextFromSec`）。

**接线**：链接预取（`prefetchBilibiliLinks`）拿到元信息后，通过 `biliSubtitleProvider` 追加精编稿
（这样 `link-bilibili.js` 零改动）；配置 `socialV2.links.subtitle = { enabled, injectMaxChars,
outlineThreshold, cacheTtlMinutes, maxCharsHard }`。

**回归**：`scripts/test-bili-subtitle.mjs` 13 组离线断言（清洗/格式化/解析/抽样覆盖前中后段且守预算/
三档分层/骨架共享预算/分页跨界/缓存路径/未登录与坏 bvid 安全返回/出处与接线守卫）。

### 16.20 踩坑：模块级 const 的 TDZ（2026-10-15）

> 背景：曾为"记住自己对某条 B 站视频说过什么"加过一层桥接侧轻记忆（`src/bili-notes.js`），
> owner 判断**没必要**（话题一热，同一条视频会在 15 条上下文窗口里反复出现，而"记忆"这条路
> 本来就有 `qq_memory_append` 的 activeTopic/memberImpression），**已按 owner 要求撤掉** ✓。
> 但那次改动踩的坑值得留下：

把 `const BILI_NOTES_FILE = path.join(STATE_DIR, 'bili-notes.json')` 放到了文件**顶部**，
而 `STATE_DIR` 在 185 行才定义 ⇒ 模块初始化就撞 TDZ：
`ReferenceError: Cannot access 'STATE_DIR' before initialization`，
**一次打红 3 个测试**（audit-bridge / reply-wait / token-economy）。

→ 教训：**模块级 `const` 若依赖另一个模块级 `const`，必须写在它之后**。
   这类错误在"单个测试跑得通"时看不出来（只有整体 import 顺序才会暴露），所以改完要跑**全量**套件。

### 16.21 B 站专用直连通道：DoH 拿真实 IP + SNI 直连（绕过 fake-ip 代理） 2026-10-16

**问题（一因多果）**：本机代理（qiqi/mihomo，TUN + fake-ip）**全局劫持 DNS** ——
连 223.5.5.5 / 119.29.29.29 都返回 `198.18.x.x`。B 站流量因此走国外出口，B 站回
`{"code":-412,"message":"request was banned"}` ⇒ 卡片元信息预取失败 ✗、官方字幕取不到 ✗、
yt-dlp 也是 412 ✗（三个症状同一个根因）。

**为什么不在代理侧解决**：qiqi 把配置**全加密**（`mihomo.yaml` / `profiles/*.yaml` 都是单行密文），
控制台 API 未开（9090/9091/9097/6170/9095 全无响应），日志里也没有规则匹配记录
⇒ 从代码侧拿到规则/改规则都不现实。改为**我们自己的请求绕开代理**。

**方案**（`src/bili-direct.js`，只用 `node:https`，零依赖 —— 桥接跑在 Node 16 上没有全局 fetch）：
1. **DoH 解析真实 IP**：`https://223.5.5.5/resolve?name=…&type=A`（多端点依次试，结果按 host 缓存 10 分钟）；
2. **带 SNI 直连**：`https.request({ host: ip, servername: hostname, headers: { Host } })`
   —— servername 必须是域名，否则 TLS 校验/回源都不对；
3. **只对 B 站域名生效**：`bilibili.com` / `b23.tv` / `hdslb.com` / `bilivideo.com|cn`（子域算，伪装域名不算）；
4. **任何一步失败都回落**到默认 fetch（DoH 不通 / IP 连不上 / 超时 / 跳转到非 B 站域名），
   回落日志 5 分钟节流一次 —— 保证"绝不比原来更差"；
5. 返回 **fetch 兼容**对象（`ok/status/headers.get/getSetCookie/text/json/arrayBuffer`），
   这样 `bili-auth` 的 Set-Cookie 续期、`link-bilibili` 的 `json()` 都能原样复用。

**实测（关键对照 + 通道效果）**：
| 请求方式 | 结果 |
| --- | --- |
| 走代理访问 `x/web-interface/view` | **HTTP 412 request was banned** ✗ |
| DoH 解析出真实 IP（121.194.11.74）后带 SNI 直连 | **HTTP 200 正常 JSON** ✓ |
| 通道里取元信息 `b23.tv/GPk04QI` | ok ✓ bvid=BV1KZ3x6SEBb ✓ **0.6s**（含短链展开） |
| 通道里取元信息 `b23.tv/b9dEBIc` | ok ✓ bvid=BV1ARp26aEHv ✓ **0.3s** |
| 通道里取字幕（带登录态） | BV1KZ3x6SEBb **65 条/587 字** ✓、BV1ARp26aEHv **222 条/2681 字** ✓ |
| 通道日志 | **无回落记录** ✓（全程直连成功） |

**接线**：`bridge.js` 里建一次 `createBiliFetch({ log })`，然后
① `createBiliAuth({ …, fetchImpl: biliFetch })`（字幕与 player 接口都走它）；
② `summarizeBilibili(url, { …, fetchImpl: biliFetch })`（元信息与短链展开都走它）。

**回归**：`scripts/test-bili-direct.mjs` 6 组离线断言（域名判定含"伪装域名不算"、
DoH 解析与缓存命中、端点失败换下一个、非 B 站域名直通、B 站 DoH 全失败必须回落且抱怨节流、
接线与 412 证据守卫）；离线套件 **59/59**。

### 16.22 B 站字幕的"在线交付"：P1 工具结果 / P2 按需工具 / P3 兜底唤醒（2026-10-16）

**要解决的问题**：卡片到达时如果**已经有回合在跑**，那一轮的提示词早就发出去了 ⇒ 它看不到刚取好的
字幕 ⇒ 只能说"这条只有标题，等下一轮字幕到位我再说" ✗（诚实但把球踢回给群友）。

**为什么不能"推"进去**：一轮开始后，prompt 是交给 DSH 的**一次性输入**，桥接**没有任何接口**
往"正在跑的那一轮上下文"里追加文本 ✗。唯一的在线通道是**工具返回值** —— 而每一轮都会调
`qq_wait_for_messages`（长轮询）与 `qq_get_unread_messages`。
⇒ 所以把字幕塞进工具结果，正在工作的那一轮**立刻**就能拿到 ✓。
（注意：唤醒**不是**用来传数据的，它是用来"让它愿意再开口"——数据可以在线给，但"说出去"必须它自己动。
 生图能直接发群，是因为产物本身就是消息；字幕的产物是**总结**，只能由模型写。）

**P1 在线交付（主路径）**：
- 预取结果里记 `subtitleBrief / briefMode / briefChars`（**只有真的有字幕**才算 ready，
  no-subtitle / 失败都不算，免得在线交付一条空稿 ✗）；
- `/api/socialV2/wait` 的响应新增 `subtitleReady: pickReadySubtitle(key)`
  （该会话最近 10 分钟内已就绪的那条：bvid / 标题 / mode / 字数 / 精编稿全文）。

**P2 按需工具 `qq_bili_subtitle`**：
- 桥接新增只读端点 `GET /api/bili/subtitle?key=&bvid=&fromSec?=&maxChars?`：
  默认回分层精编稿；带 `fromSec` 则回从那一刻起的原文（按时间翻页 `nextFromSec`）；
- 端点自带 `agentTokenOk(key, token)` + `v2SessionAllowed(key)` 校验，并加进了
  "agent token 白名单"（那里默认拒绝，只放 AI 真正需要的面）；
- MCP 侧注册同名工具，走 `agentApi`（它会带控制台令牌），**必须把 key 一起传下去**。

**P3 兜底唤醒**：兜底改成排一个 `subtitleReady` 原因（新增提示词分支：字幕刚就绪 → 把话补上，
**已经讲过了就不用重复**）。它只是兜底：P1 能在同一轮解决时就不需要它。
⚠️ 之前两次尝试都不成立，别重犯：写在 turn/end 事件块里 ⇒ 那个块没被走到 ✗；
用 `pendingWakeKeys`（turnActive）轮询 ⇒ 热闹群里它被一直重新置上（实测连续 90 秒 true）⇒ 放弃 ✗。

**回归**：`scripts/test-bili-online.mjs`（P1 状态与字段 / P2 端点与白名单与会话校验与 MCP 传 key /
P3 独立 reason 与"不用重复"出口）。
⚠️ P2 的工具注册在 **MCP 进程**里 —— 需要**重启一次 DSH** 才会出现在模型的工具列表里。

### 16.23 B 站热评辅助理解（字幕之后再给"观众怎么看"） 2026-10-18

**为什么**：字幕告诉模型**视频讲了什么**，但群友真正想聊的常常是"大家怎么看/有没有意思"。
热评能补上气氛与争议点 —— 代价很低（3 条 ≈ 300 字），但它也**最容易误导**：
模型会把评论当成视频内容 ✗。所以注入文案**硬性**带上"观众观点、不是视频内容"的警示。

**接口实测**（2026-10-18，登录态 + DoH 直连）：
| 接口 | 结果 |
| --- | --- |
| `x/v2/reply?type=1&oid=<aid>&sort=2&ps=20&pn=1` | ✓ code=0（**不需要 WBI 签名**） |
| `x/v2/reply/main?oid=…&type=1&mode=3` | ✓ code=0，同数据 |
| `x/v2/reply/wbi/main`（不签名） | ✗ code=-403 访问权限不足 |

⇒ 用**旧版** `x/v2/reply`，`sort=2`（按热度）。字段：`member.uname` / `like` / `rcount` / `ctime` / `content.message`。

**实现**：`src/bili-comments.js`
- `cleanComment`：去 `[表情]` / URL / `@某人`、压缩空白、超长截断；
- `pickComments`：丢 <4 字、纯符号、重复的，按赞数降序取前 N（默认 3）；
- `formatCommentsBlock`：**带警示**的注入块（观众观点 / 不是视频内容 / 细节以字幕为准）；
- `fetchTopComments`：带缓存（`state/bili-comments/<bvid>.json`，TTL 60 分钟）与失败原因
  （`no-aid` / `-412` / `-403` / `api-<code>` / `empty` / `exception`），从不抛异常。

**接线**：`summarizeBilibili` 现在多返回 `aid`（评论接口的 oid，免得下游再查一次）；
`bridge.js` 的预取在**字幕之后**追加热评块；登录态用模块级探针 `biliAuthRef`
（`biliAuth` 在闭包里，与 `biliTurnActive` / `biliWakeProbe` 同一套路）。
配置：`socialV2.links.comments = { enabled, maxItems, maxCharsPer }`（默认开、3 条、每条 ≤80 字）。

**实测**（《如果给诸葛亮众多五虎上将北伐能成功吗？》）：
```
[评论·仅供参考] 《如果给诸葛亮众多五虎上将北伐能成功吗？》的热评 3 条：
（以下是**观众**说的，**不是视频内容** —— 只能用来感受气氛/争议点，绝不能当成"视频里讲了什么"来回答；被追问视频细节时以字幕为准。）
· koraのseigi：「200个关羽搁那争自己才是最强关羽咋办」 👍637
· 进狱系-天才：「其他先不管，街亭换上述任何人去守，说不定真的就匡扶汉室了」 👍134
· 不敢离开的人：「败得更快，几百个名将，占满了将位，底层的士兵看不到上升的空间…」 👍92
```
注入文本 **300 字**；回归 `scripts/test-bili-comments.mjs` 9 组。

### 16.24 DSH 0.2.1-rc.1+ 不再注册 `{{cwd}}`：preset 里留着它会让**每一轮都失败**（2026-10-18）

**症状**：升级到 0.2.1-rc.2 后 bot 在群里一个字都不发，桥接日志每一轮都是：
```
⚠️ agent 回合出错 [UNKNOWN]: unknown prompt variable "{{cwd}}" in section
   "deployment:persona-suffix"; registered variables: provider, model
```

**原因**：该 section 的内容来自 preset 的 `persona.config.suffix`，而 0.2.1 起提示词变量**只注册
`provider` / `model`**（0.2.0 时代还有 `cwd`）。原 suffix 是"Your working directory is {{cwd}}."，
对一个**没有本地工具**的 QQ 聊天人格本来也没意义 ⇒ 换成无变量的静态句。

**改哪些文件（注意"改副本没用"）**：
- 源：`dsh/agent-presets/{qq-chat,qq-chat-v2}/agent.cordis.yml`、
  `plugins/qq-agent-presets/presets/{qq-chat,qq-chat-v2}.patch.yml`；
- `~/.dsh/.agent-presets/<preset>/agent.cordis.yml` 是插件**生成的副本**，改它会被启动时覆盖 ✗；
  `~/.dsh/profiles/web/node_modules/qq-agent-presets` 是指向仓库的**链接**（改仓库即生效）。

**两个必须记住的坑**：
1. **preset 是 DSH 启动时注册进内存的** ⇒ 改完文件**必须重启 DSH** 才生效（只重启桥接没用 ✗）；
2. 0.2.1 还改了一批工具注册名（`subagent_codex`/`subagent_claude_code` 消失，新增
   `working_directory`/`terminal_*`/`session_*`/`create_worktree`）⇒ `qq-tool-restrict` 的
   本地工具黑名单要同步更新，否则那些新工具会**漏进** QQ 会话。

**验证**：重启后日志里 `unknown prompt variable` 计数不再增长；黑话学习会话能正常完成（真实回合跑通）；
`/api/status` 里 `dshReady: true`。回归：`scripts/test-qq-preset-contract.mjs` 与
`scripts/verify-dsh-015-adaptation.mjs` 的契约已改为"**值里禁止** `{{cwd}}`"。

### 16.25 误禁言：同一条消息被重复投递 100 次，刷屏判定数到 50 次（2026-10-20）

**症状**：一位群友只发了一句，就被禁言 3 分钟；记录写着
`已禁言 … 3 分钟（text-repeat ×50）`，而 `recentMessages` 的 100 条里
`messageId` 全是同一个、文本全是同一句（`seq` 各不相同）。

**原因**：同一条消息被网关/重连**重复投递**，把 100 条的记忆窗口塞满 ⇒ 判定器数到 50 ⇒ 误禁言 ✗。
`seq` 是每次入库**自增**的，拿它去重等于没去重——**`messageId` 才是稳定标识**。

**修两层（缺一不可）**：
1. `moderation.js` 的 `detectRepeat`：同文本/同图计数**先按 messageId 去重再数**（证据列表也去重）。
   效果：**真人连发 5 条**（不同 messageId）**照样命中**，而"一条消息的 100 个副本"只算 1 次；
2. `bridge.js`：`recordIncomingV2` 与拍一拍路径**入库前去重**（重复投递直接跳过，返回已有那条，
   不再重复触发 affinity/未读/唤醒）；`loadSocialV2State` 用 `dedupeRecentByMessageId` **加载自愈**。

**验证**：重启后窗口从 100 条塌回 1 条（0 组重复）；回归 `scripts/test-moderation-dedupe.mjs`
（100 条重复不命中 / 真连发 5 条命中 / 同图重复不命中 / 入库与加载守卫 / 去重语义）。

**顺带解释**：之前"bot 老接旧话、上下文里全是同一句"也是同一个根因（窗口被同一条消息塞满）。

### 16.26 说话姿态（答题态 / 闲扯态）：为什么"已读乱回"会被搜索功能压住（2026-10-23）

**现象**：人格卡里明明写着「不用有求必应，可以装傻、已读乱回、拒绝推荐」，但它在群里
**几乎总是认真回答** ✗ —— 尤其**接上搜索工具之后**更明显。

**原因**：那条规则是**负面清单**（"可以不说" = 允许 ✗ 不是状态 ✗），而模型手上有了能查的工具，
"我有答案为什么不说"就压过了人格设定 ✗。**工具的可用性 > 提示词里的许可**。

**解法**：不是两套人格 ✗（人格分裂 + 切换仍靠模型判断，等于没解决 ✗），而是
**一套人格 + 每轮由桥接判定一种"姿态"** ✓ —— 把"允许装傻"变成"**当轮就是闲聊态**" ✓。

**判定**（`src/speech-mode.js`，**确定性**、零网络、可单测）：
- 强信号 → 直接答题：点名/引用我 + 明确提问；或出现"正经问/认真问/请教/求助/在线等"；
- 明显闲聊 → 直接闲扯：纯占位（`[表情]`/`[图片]`）、≤2 字；
- 其余 → 加权：点名 +3、**疑问词 +2（>1 个再 +1）**、正经词 +2~3、
  连续追问 +2（同一人 2 分钟内第 3 次提问另有**强信号**直接答题 ✓）、长句无梗无表情 +2、管理员 +1；
  闲聊词 -2、含表情 -1、极短 -2；
- ⚠️ **问号不计分、「急」「咋」已移除**（2026-10-23 owner 指定 ✗ 太容易误伤）：
  "真的假的？""着急""咋样" 全是闲聊 ✓。问号只保留给「**点名 + 提问 ⇒ 直接答题**」这条强信号用 ✓；
- ⚠️ **@/引用它、但整条只有一个问号 ⇒ 不加也不减**（2026-10-23 owner 指定）：
  这种只是"叫它一声、丢个问号" ✓，`atSelf +3` 会把它硬拉进答题态 ✗ ⇒ 判**中性**、按闲聊兜底 ✓。
  判定在 \`isBareQuestionMark()\`（允许前置 @提及 / 引用段 / 空白 ✓，例如 \`@！？哦鲸鲸？！ ？\`）；
  注意：**带了内容就不算**（\`@bot 这个报错怎么解决\` 仍是答题 ✓）。
- `score ≥ 4` = 答题，`≤ 1` = 闲扯，中间按"有没有点名我"兜底 ✓。

> ⚠️ 踩过的坑：最初只认 `? ？ 吗 呢 吧` ⇒ "**为什么我的桥接一直重启**"（没问号）被判成闲聊 ✗。
> 中文里**没问号的提问**极常见 ⇒ 必须加**疑问词表**（为什么/怎么/如何/哪个/能不能/有没有/是什么…）。

**接线**：入库时判定一次 → 存在消息上（`msg.speech`）→ 每次唤醒对近 10 分钟最多 8 条
非自己消息做 `aggregateSpeechMode`（**任一条正经询问 ⇒ 答题态** ✓）→ `formatSpeechLine` 注入
提示词，位置在 `tokenLine` 之后、`antiAiLine` 之前 ✓。

**顺带补的一句（P0）**：`antiAiLine` 里加了
> 「**你有搜索工具，但这不代表你要当客服**：知道答案也可以只回两个字，搜到东西不等于必须倒出来。」

**实测判定**（8 条真实风格语料）：
| 消息 | 姿态 | 分数 |
| --- | --- | --- |
| @bot 这个报错怎么解决 | 答题 | 7（强信号） |
| 为什么我的桥接一直重启 | 答题 | 4 |
| 正经问一下，这配置能跑吗 | 答题 | 5（强信号） |
| @bot 你看这个 | 答题 | 3（模糊但点名） |
| 卧槽？ / 这啥啊哈哈哈 / 笑死 / 今天天气不错 | 闲扯 | 0 / -2 / -4 / 0 |

**回归**：`scripts/test-speech-mode.mjs` 15 组（强信号 / 加权 / 连续追问 / 纯梗 / 多消息合并 / 注入文案 / 信号明细）。
**调参入口**：同文件顶部的 `SERIOUS_WORDS`、`BANTER_WORDS`、`INTERROGATIVE_RE` 与阈值 4。

### 16.27 「鱼的心情」(dsh-feiyu-mood) 适配：会话 id 会变，绑定要跟过去（2026-10-23）

**现象**：插件装好、设置页也出来了，但心情**永远停在基线 70**、从不判断、也从不注入 ✗。

**根因**（读它的源码确认，不是猜）：
- 它用 `cfg.targetSession` **精确匹配** DSH 的 session id：`if (sid !== target) continue`；
- 而 `DEFAULT_SESSION = ''` ⇒ **targetSession 为空时，一个会话都不会挂** ✗（不是"全部生效"✗）；
- 我们的桥接会在「切模式 / 切角色 / 会话重置 / 看门狗解绑卡死会话」时**新建会话** ⇒ id 一变，
  它绑定的那个会话就不存在了 ⇒ 之后永远不判 ✗。

**适配**（`src/mood-bridge.js`）：`syncMoodTargetSession(sessionId)` 把 `targetSession` 改成当前会话，
桥接在 **`state.sessions[key] = sessionId` 之后**调用一次 ⇒ 每次新建会话都自动跟过去 ✓。

**跨回合继承**：心情本身（`<DSH_HOME>/feiyu-mood/state.json`）是**全局一份、跨会话共享** ✓，
换会话**不会**重置它 ✓ —— 所以这里只搬"绑定"，不搬数据 ✓。真正会丢的只有绑定 ✗，现已修好 ✓。

**写配置的几条硬约束**（都有回归）：
- **只改 `targetSession`**，其余设置（名字/模型/门槛/开关/基线）**一个字节都不动** ✓；
- 文件不存在（没装插件）⇒ **静默跳过** ✓，不建目录、不写文件 ✓；
- JSON 坏了 ⇒ **只报错、绝不覆盖** ✓（避免毁掉用户设置）；
- 原子写（临时文件 + rename）✓，避免插件正好读到半个文件；
- **UTF-8 无 BOM** ✓（带 BOM 会让 DSH 读 profile 时崩，插件作者专门警告过）；读的时候**容忍** BOM ✓。

**验证**：重启桥接后触发一轮 → 日志出现 `[mood] 已把「鱼的心情」绑定到新会话 session-… ` ✓，
插件的 `<DSH_HOME>/feiyu-mood/diag.log` 出现 `已挂心情到 session-…` ✓，随后 `state.json` 的 `timeline` 开始增长 ✓。

**回归**：`scripts/test-mood-bridge.mjs` 9 组（未装/只改一个字段/幂等/换会话/非法 id/坏 JSON 不覆盖/容忍 BOM/无 BOM 输出/接线守卫）。

### 16.28 自研心情引擎（保留「鱼的心情」的 UI）（2026-10-23）

**为什么自研**（实测结论，不是偏好）：
1. 插件的判断引擎在 **DSH 0.2.1** 上**静默失效** ✗ —— 它 `tick()` 里的
   `ctx.agents.list()` / `ctx.interval` 抛错被外层 `try` 吞掉，`diag.log` 一行不出；
   实测：`diag.log`/`state.json` 停在 01:53，而 02:02 明明跑完了一整轮 ✗。
2. 它按 **会话 id 精确匹配**（`sid !== target → continue`，而 `DEFAULT_SESSION = ''`），
   我们**频繁新建会话** ⇒ 绑定永远对不上 ✗（§16.27 的适配只能解决"绑定"，救不了引擎本身）。

**保留 UI** ✓：引擎搬到桥接，但**数据格式完全沿用插件**
（`<DSH_HOME>/feiyu-mood/state.json` 的字段与 7 根情绪键 `happy/calm/sweet/heartache/worry/sad/jealous`）
⇒ 右下角挂饰、设置页、时间线**照常显示**我们写的状态 ✓。

**引擎（`src/mood.js`，规则式、零模型调用、可单测）**：
- 口径沿用作者定的三条 ✓：心情 0~100（基线/下限读设置页）✓；
  **被怼只会「难过」，总心情绝不许因为被冒犯而下降** ✓✓；只有「对方在讲自己的难处 / 情绪很低」才允许降 ✓；
- 规则：被夸/被谢 → 开心+甜 ✓；被叫一声 → 甜 ✓；有人报喜 → 替人开心 ✓；
  对方诉苦/病了 → 心疼+担心（**允许降心情**）✓；被怼 → 只 sad、mood 0 ✓；玩梗 → 轻开心 ✓；
  正经提问 → calm（被需要）✓；认真回了但对方只丢几个字 → 轻微 sad ✓；
- 衰减：心情向基线（半衰期 = 设置页的 `decayHalfHours`）✓；七情绪向 0（90 分钟半衰期）✓；
- 记账门槛同插件（`sigMood` / `sigDim`）✓；时间线保留 40 条 ✓；
- 注入支持设置页三种模式（不告诉 / 只说心情 / 说那件事）✓ + 每日上限 `injectPerDay` ✓ +
  可信度门槛 ✓ + **event 模式同一件事只说一次** ✓。

**接线**：`buildWakePromptV2` 在 `speechLine` 之后注入 `moodLine` ✓；
`scheduleReplyCheckV2` 顶部（= 它真的发了话之后）拿"对方最后说的 + 它回的"更新心情 ✓；
并把插件自带引擎关掉（`autoJudge: false` ✓，备份 `config.json.bak-before-selfbuild` ✓）**避免双写** ✓。

**踩到的坑**：`decayMoodState` 里 `Number(x) || now` 把时间戳 **0** 当成"没有" ⇒ 永不衰减 ✗ ——
测试抓到后改成 `Number.isFinite` 判断 ✓（时间戳 0 是合法值 ✓）。

**回归**：`scripts/test-mood.mjs` 15 组（口径/衰减/下限/记账门槛/schema 兼容/三种注入模式/单次/每日上限）。

### 16.29 久无人理 → 轻微落寞（但 02:00-10:00 不算，owner 2026-10-23 指定）

**需求**：群里长时间没人说话时，它主动冒泡那一次可以带一点"落寞"；但**凌晨 2 点到早上 10 点不算**
（正常人要睡觉，不能因为没人半夜找它就难过 ✗）。

**实现**（`src/mood.js`）：
- `isSleepHours()`：`02:00 ≤ h < 10:00`（含头不含尾）；
- `effectiveSilentHours(from, now)`：总时长 **减去**与作息窗口的交集（逐日求交集，跨多少天都准）；
- `analyzeSilence()`：① 不在作息窗口；② 有效沉默 ≥ 6h；③ **这段沉默还没算过**
  （`lonelyAt >= lastIncomingAt` ⇒ `already-counted`，保证"每次静默最多一次"）；
- `applySilenceMood()`：**心情 −1、sad +1**，理由「很久没人说话了（这点落寞不承认）」，
  并把 `lonelyAt` 写回 state（额外字段，插件 schema 会忽略，不影响它的 UI 渲染）。

**触发点**：**只在 `proactiveCheck`（主动冒泡）这一种唤醒里判一次** ✓ —— 正常对话里不会无端变丧 ✓。

**注意**：作息窗口只影响"**是否感到被冷落**"，**不影响心情的自然衰减** ✓ ——
睡觉那 8 小时里心情照样向基线回稳 ✓（只是不记"被冷落"这一笔）。

**实测**：
| 场景 | 结果 |
| --- | --- |
| `isSleepHours` 01:59 / 02:00 / 09:59 / 10:00 | false / **true** / **true** / false ✓ |
| 昨日 23:00 → 今日 11:00 | 总 12h，**有效沉默 4h**（扣掉 8h 作息）✓ |
| 凌晨 03:00 判定 | `sleep-hours` ⇒ 不判 ✓ |
| 同一次静默第二次判定 | `already-counted` ⇒ 不重复扣 ✓ |
| 首次落寞 | 心情 −1（70 → 69）+ sad ✓ |

**回归**：`scripts/test-mood.mjs` 增至 21 组。
