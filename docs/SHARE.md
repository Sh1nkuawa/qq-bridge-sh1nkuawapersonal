# 把这个项目交给朋友用

> 三步：**给他干净的源码** → **他准备自己的 DSH / SnowLuma / QQ 小号** → **填 config.json 启动**。

## 一、三种给法（任选其一）

| 方式 | 命令 / 做法 | 说明 |
| --- | --- | --- |
| **① 给仓库地址** | `git clone https://github.com/Sh1nkuawa/qq-bridge-sh1nkuawapersonal.git` | 仓库若是 **public** 最省事 |
| **② 打包源码**（推荐） | `git archive --format=zip -o qq-bridge.zip HEAD` | **只含被跟踪文件** ⇒ 天然不含 state/、config.json、audio/、node_modules ✓ |
| **③ 只给上游** | 从 `Derpyu520/qq-bridge` clone，再对照本仓库的 `INSTALL_NOTES.md` 接 | 适合想从零理解的人 |

> ⚠️ **不要**直接拷整个目录（里面有 `state/` 和 `config.json`）✗ —— 那等于把**控制台令牌、会话令牌、聊天记录、你的 QQ 号**一起给出去。

## 二、绝对不能给的东西 ✗

| 路径 | 里面是什么 |
| --- | --- |
| `state/` | 控制台令牌、每会话的 agentToken、聊天记录、记忆、缓存、日志 |
| `config.json` | DSH/SnowLuma 的 token、cookie、你的 QQ 号、群白名单 |
| `audio/` | 语音库（含真人/角色音色片段） |
| `.env` | 若存在，同理 |
| `~/.dsh` | 你的 DSH profile、会话签名钥匙 |

（本仓库的 `.gitignore` 已挡住 `state/`、`audio/`、`config.json`、`.env` ✓ —— 但**手拷目录**不受它保护，务必提醒他别拷这些。）

## 三、他要准备什么

1. **Windows** + **Node 16+**（本机是 `D:\nodejs16`，全局装在 `D:\nodejs16\node_global`）
2. **DSH**：`npm i -g @deepseek-ai/dsh`，配**自己的** DeepSeek key
3. **SnowLuma**：QQ OneBot 网关（`ws://127.0.0.1:3001`），用**自己的 QQ 机器人小号**
4. **一个自己的测试群**（不要直接用你的群 ✓）
5. 复制 `config.example.json` → `config.json`，填：
   - `dsh.baseUrl` / `dsh.provider` / `dsh.model` / `dsh.authToken`（或 cookie）
   - `snowluma.wsUrl` / `snowluma.httpUrl` / `snowluma.accessToken` / `snowluma.httpToken`
   - `ownerQQ`（他自己的 QQ）
   - `allow.groups` / `allow.private`（他的测试群/号）
   - `consolePort` 若冲突就改（默认 3100）

## 四、启动顺序

1. 起 **DSH**（自己拉起来，别让桥接代劳）
2. 起 **SnowLuma** 网关
3. 双击 **`start.bat`**（桥接；控制台 `http://127.0.0.1:3100`）
4. 看 `state/bridge.log`：应出现 `SnowLuma 已连接` / `DSH 已就绪` / `机器人昵称: …`

## 五、语音功能（可选，且有版权注意）

- `src/tts.js` 需要本地 **GPT-SoVITS** + 一个**音色模型**；模型**不随项目分发** ✗（`<DSH_HOME>/feiyu-mood` 与 `D:\AI\gsv` 都是本机私有）
- 角色音色属于**版权灰区**：**自用可以**；**不要把模型文件发给别人** ✗；**绝不要用真人（非公众人物）的声纹** ✗
- 没有模型时：语音合成会**明确报错并拒绝发语音**（不降级 ✓）—— 其余功能不受影响

## 六、他大概率会踩的坑（提前说）

1. **人设 / 预设是在 DSH 启动时注册的** ⇒ 改了要**重启 DSH**；
2. **`.bat` 必须纯 ASCII 或无 BOM** ⇒ 带 BOM 会被 cmd 读成乱码（`chcp` 变 `01`、`cd` 变 `\AI\gsv`）；
3. **`.ps1` 必须 UTF-8 带 BOM 或纯 ASCII**；
4. **`state/` 权限收紧**要管理员权限（`icacls`），否则会警告"本机其他用户可读令牌"；
5. **看门狗**：`start.bat` 那个窗口别关，桥接假死时靠它拉起；
6. **别在同一台机器上跑两份**（QQ 小号会互踢、控制台端口冲突）。
