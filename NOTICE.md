# 来源与署名（NOTICE）

本仓库是 **`qq-bridge` 的个人衍生副本**，用于本机部署与版本控制。

## 上游项目

| 项 | 内容 |
| --- | --- |
| 原仓库 | <https://github.com/Derpyu520/qq-bridge> |
| 原作者 | **Derpyu520**（GitHub） |
| 本副本基于 | 版本 `v0.1.5`，上游提交 `dea3ce8`（2026-09-18） |
| 上游 README | 见本仓库 `README.md` / `README.en.md`（保留原文与其中的作者链接） |

原始的架构、协议适配、控制台、MCP 安全子集、preset 体系等绝大部分代码来自原作者 Derpyu520，**版权归原作者**。
本副本只在其之上做了下列增改（详见 `INSTALL_NOTES.md` 与 `docs/`）：

- 群管理（禁言 + 群公告，含干跑、审计、owner 审批）→ `src/moderation.js`、`docs/MODERATION.md`
- 本地表情包库（接入 `dsh-meme` 图库）→ `src/meme-lib.js`、`docs/MEMES.md`
- 好感度（关系）系统 → `src/affinity.js`、`docs/AFFINITY.md`
- 投喂（赞助）核验 → `src/feed.js`、`docs/FEED.md`
- 生图回执 / 失败状态口径 / 引用自己发的图改图 → `src/image-ack.js`、`src/persona-lines.js`、`scripts/gen-image-worker.mjs`
- 一批自检与运维脚本 → `scripts/test-*.mjs`、`scripts/probe-*.mjs`、`scripts/check-*.mjs`

## 许可证状态

**上游自 v0.1.7 起采用 MIT 许可证**：

```
MIT License
Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors
```

本副本基于 `v0.1.5`（当时上游尚无 LICENSE 文件），现已把上游这份 `LICENSE` 一并放入本仓库，
以符合 MIT「随副本保留版权与许可声明」的要求。

- 上游代码版权归 **Derpyu520 and qq-bridge / QSH contributors**，按 MIT 授权使用、修改与再分发；
- 本副本作者新增的文件（上文列出的那些）同样以 MIT 提供，但需保留上游版权声明；
- 若日后升级到上游 `v0.1.7`，请直接沿用上游 `LICENSE` 与本文件。

## 不要提交的东西

`.gitignore` 已排除 `config.json`、`state/`、`*.log` 等本机运行数据（内含 QQ 令牌、群号、会话内容、API key）。
部署本副本时请照做：**凭据只留在本地 `config.json`，不要提交**。
