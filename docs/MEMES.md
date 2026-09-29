# 本地表情包库（memes：接入 dsh-meme 图库）

一句话：把用户已经装好的 **dsh-meme 插件图库** 接到 QQ 桥接上，让 bot 能**按情绪挑梗图、直接以图片消息发出去**。
它和「QQ 收藏表情」（`qq_send_sticker`）是两套东西：收藏表情存在 QQ 账号里，本地表情包库是磁盘上的图片文件。

## 1. 为什么需要它

`dsh-meme` 插件本身有两种发送通道：

| 通道 | 依赖 | 在 QQ 桥接下是否可用 |
| --- | --- | --- |
| Web 通道（`send_meme` 写 `[表情: 描述]`，前端配图） | DSH Web 前端 | 只在 DSH 网页会话里有意义 |
| QQ 通道（`send_meme(action=send)`） | `dsh-companion` 的 `companionQq` 服务 | ❌ 桥接是独立实现，没有这个服务 |

所以 QQ 侧的 bot 原本只能用它自己 QQ 账号里的收藏表情；插件自带的 141 张图库（`dafeiyu-001` 大肥鱼鲸鱼娘 49 张 + `official-001` 官方梗图 92 张）完全用不上。

本功能把同一份图库「翻译」成桥接自己的目录 + 工具：

- **只读**接入：不修改 `index.db`、不改图片、不改上游插件的任何设置；
- **情绪桶沿用 dsh-meme 的定义**（`happy / angry / sad / shy / confused / daily`），AI 在网页端学到的选图习惯在 QQ 侧同样成立；
- 使用统计写在自己这边（`state/memes.json`），用于「先发没发过的、避开最近发过的」，避免连着复读同一张。

## 2. 图库从哪来

按顺序自动探测（`config.json` 的 `socialV2.memes.packDirs` 为空时）：

1. `~/.dsh/meme-packs/`（dsh-meme 面板里导入/自建的用户图库）
2. `~/.dsh/profiles/{web,tui,cli,default}/node_modules/dsh-meme/memes`
3. `~/.dsh/profiles/*/node_modules/dsh-meme/memes`（其他 profile 名）

每个子目录 = 一个 pack：需要 `index.db`（用 Node 内置 `node:sqlite` 只读打开）或至少 `memes/<tag>/*.jpg|png|gif|webp`。
拿不到 SQLite 时自动退化为「目录名当 tag、文件名当描述」，不会整块失效。**绝不写回上游库。**

`index.db` 的 `memes` 表被用到的字段：`path`（相对路径）、`tag`（细分类）、`caption`（给模型看的描述）、`keywords`。

## 3. 模型侧：`qq_send_meme`

三步式（和 dsh-meme 的网页端习惯一致）：

| action | 参数 | 作用 |
| --- | --- | --- |
| `search`（默认） | `tag`（情绪，优先）/ `query`（口语词）/ `limit` | 按情绪随机抽候选，返回 `path` + `caption` + 用过几次 |
| `view` | `path` | 把图片给模型看一眼（多模态），拿不准时先看再发 |
| `send` | `path` + 可选 `replyToMessageId` / `atUserId` | 真的发出去（图片消息） |

情绪字典：

```
happy    开心（卖萌/可爱/得意/比心）
angry    生气（嫌弃/笨蛋/暴躁）
sad      难过（无语/求饶/委屈）
shy      害羞
confused 困惑惊讶（问号/震惊）
daily    日常（睡觉/干饭/上班/早上好/晚安）
```

硬规则：

- **一条消息只能是一张图，不能带文字**（和收藏表情一致）。想说话就先用 `qq_send_message` / `qq_reply` 单独发一个气泡，再单独发图。桥接侧对「带文字的图片消息」直接 400 拒绝。
- 目标必须命中 `allow.groups` / `allow.private`；私聊不能 `@`。
- 限频：`memes.maxPerMinute`（默认 3）/ `memes.maxPerHour`（默认 30），并且**同时占用总发送限频** `send.maxSendPerMinute`，防止用发图绕过刷屏保护。
- 发送顺序与文本共用 `sendChain`，并带 0.8~2 秒随机停顿，避免「文字刚发完图立刻跟上」的机械感。
- 发出的图会记进二代会话的 `recentMessages`（`[表情包:描述]`），所以 AI 知道自己发过什么，不会重复刷。

## 4. 提示词注入

唤醒提示里会多一段（仅当真的载入到图库时）：

```
【本地表情包库：真正的梗图/表情包，按需发】
- ... qq_send_meme 按情绪挑图 ...
- 两个库的分工：qq_send_sticker 是平时惯用的收藏表情；qq_send_meme 适合更具体的梗/情绪 ...
【可用表情包库】共 141 张，来自 大肥鱼(49)、官方表情包1号(92)；按情绪：happy 41 / angry 24 / ...
常用示例：
- [happy] 得意闭眼拳头，好耶，小鲸鱼娘很满意（大肥鱼）
...
```

`qq_get_prompt` 也会返回 `memes: { enabled, total, packs, moods, context, strategy }`。
两个开关：`memes.enabled`（总开关）、`memes.includeInPrompt`（是否注入上下文摘要；关掉后 AI 仍能主动调用工具）。

## 5. 配置（`config.json` → `socialV2.memes`）

```json
"memes": {
  "enabled": true,
  "packDirs": [],          // 空 = 自动探测（见 §2）
  "packs": [],             // 只启用这些 pack id；空 = 全部
  "includeInPrompt": true,
  "promptMaxMemes": 6,     // 提示词里列几张示例
  "maxPerMinute": 3,
  "maxPerHour": 30,
  "recentAvoid": 10,       // 抽样时避开最近发过的 N 张
  "maxFileBytes": 8388608,
  "rescanTtlMs": 300000    // 图库重扫间隔（新增图库后最多 5 分钟自动生效）
}
```

工具开关：`socialV2.tools.sendMeme`（默认 true）。控制台「二代仿真」页有对应的勾选框和参数区。

## 6. 控制台

- **检测图库**：强制重扫并显示图库根目录、每个 pack 的张数与来源（`index` = 读到 SQLite 索引 / `dir` = 目录扫描降级）、情绪分布、最近发过的 id。
- **发一张试试**：填会话 key（`group:123456789` / `private:QQ号`）+ 情绪，手工发一张，用来验证「图库 + 发送链路」是否通，不影响 AI 状态机。
- 两个接口都只允许控制台调用（带 agent token 的请求会被拒绝）。

## 7. 自检 / 排错

```powershell
# 纯离线自检：载入图库 → 抽样 → 定位 → 读字节校验（不需要桥接）
node scripts/meme-flow-test.mjs happy

# 真发一张（走 OneBot HTTP，需 SnowLuma 在线）
node scripts/meme-flow-test.mjs --send private:100000001 daily

# 单元测试（情绪映射/抽样/去重/路径越界/统计落盘 + 真实图库只读自检 + 接线存在性静态检查）
node scripts/test-memes.mjs

# 桥接在跑时：控制台探活 + 图库探测（只读）
node scripts/probe-bridge.mjs

# 桥接在跑时：路由验收（13 项，不会真发消息）
node scripts/test-meme-routes.mjs

# 桥接在跑时：确认唤醒提示/qq_get_prompt 真的带上了表情包库（只读）
node scripts/test-meme-prompt.mjs

# 控制台页面接线自检
node scripts/check-console-ui.mjs
```

常见症状：

| 症状 | 原因 / 处理 |
| --- | --- |
| 工具返回「本地表情包库为空」 | `packDirs` 写错、或 dsh-meme 没装；控制台点「检测图库」看探测到的根目录 |
| pack 显示 `dir` 而不是 `index` | `node:sqlite` 不可用（Node 版本太旧）或 `index.db` 缺失；此时只有 tag、没有 caption，选图会不准 |
| 抽不到某个情绪 | 该情绪池为空；工具会返回可用情绪字典，换一个 |
| 「找不到表情包 xxx」 | `path` 不是 `search` 返回的候选 id；重新 search |
| 模型老发同一张 | 检查 `state/memes.json` 是否可写（抽样靠它避开最近发过的） |

## 8. 生效方式（改完代码别忘了这一步）

| 改了什么 | 怎么生效 |
| --- | --- |
| `src/bridge.js` / `src/meme-lib.js` | **重启桥接进程**（`start.bat` 或 `node src/bridge.js`） |
| `config.json` 的 `socialV2.memes` | 重启桥接；控制台保存配置也要重启才彻底生效（`cfg` 在启动时读入） |
| `src/mcp-snowluma-safe.js`（工具定义） | 改 `~/.dsh/profiles/web/cordis.patch.yml` 里 snowluma 条目的任意值触发 MCP 实例重建（`patchReload: live`），或重启 DSH |
| preset 的 `agent.cordis.yml`（人设规则） | 新会话生效；老会话用 `POST /api/session/rebuild` 或控制台重建 |
| `public/console.html` | 浏览器刷新控制台页面即可 |
| `qq-tool-restrict.mjs` | 按前缀放行，**本次无需改动**；真要改它必须重启 DSH |

## 9. 安全边界（与项目其它部分一致）

- 图库是**只读**接入，图片路径只可能来自扫描结果，`findMeme` 只认目录内的 `id`/`rel`/绝对路径，模型无法用它读取任意文件（有测试覆盖目录穿越）。
- 发送走桥接 HTTP（`/api/socialV2/send-meme`），因此白名单、静默模式、限频、agent token 校验、会话模式隔离全部复用；MCP 侧不直接对 OneBot 发图。
- 图片来源是用户自己的本地图库，不涉及外部下载，因此不需要 SSRF 防护；单张大小上限 `maxFileBytes`（默认 8MB）。
