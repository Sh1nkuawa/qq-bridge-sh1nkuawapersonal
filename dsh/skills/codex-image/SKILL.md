---
name: codex-image
description: Use this skill when the user asks to generate, create, draw, render, or make an image, picture, illustration, icon, logo, poster, wallpaper, or artwork. Generates images with the local Codex CLI using the user's existing ChatGPT subscription (no OpenAI API key required).
environments:
  - local
---
# Generate images via Codex (ChatGPT subscription, no API key)

This skill turns a text prompt into a PNG by driving the local **Codex CLI**'s built-in
`image_generation` tool. It reuses the machine's existing ChatGPT/Codex login, so it needs
**no `OPENAI_API_KEY` and incurs no per-image API billing**.

## When to use

Use it whenever the user wants a picture produced — "生成一张图", "画一个图标", "make me a
logo", "give me an illustration of …", "生成壁纸", and so on.

Do **not** use it for editing an existing photo's pixels with deterministic tools (crop,
resize, format conversion) — use normal image tooling for that.

## How to run

Call the wrapper script with a dense, art-directed prompt and an absolute output path:

```powershell
& "$env:USERPROFILE\.agents\skills\codex-image\scripts\codex-image.ps1" `
    -Prompt "<detailed description of the image>" `
    -Out "D:\path\to\output.png"
```

On success the script prints the final absolute path. Then **read the PNG back**
(`read_image`) to confirm it matches what the user asked for before presenting it.

### Parameters

| Parameter | Meaning |
|---|---|
| `-Prompt` | Required. What to draw. Be specific about subject, style, colors, composition, background, and aspect/whitespace. |
| `-Out` | Required. Absolute path for the PNG. Parent folders are created automatically. |
| `-Proxy` | Optional. Defaults to the Windows system proxy (auto-detected). Pass `-Proxy ''` to force a direct connection. |
| `-TimeoutSec` | Optional. Default 600. |
| `-Model` | Optional. Driver (agent) model that reads the prompt and calls the image tool. Default `gpt-6-sol`. Siblings available in this Codex build: `gpt-6-astra`, `gpt-6-luna`, `gpt-6-pro`, `gpt-5.6-sol`. |
| `-ReasoningEffort` | Optional. Default `high`. One of `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`, `max`. |

### Which model does what

- The **driver model** (`-Model`, default `gpt-6-sol`) is the agent that interprets your prompt
  and invokes the tool. It does not paint anything itself.
- The **actual image model** is Codex's built-in `image_gen` (the app's "imagegen" generation),
  running server-side; Codex's CLI image path is documented internally as defaulting to
  `gpt-image-2`, with `gpt-image-1.5` used as the fallback for transparent backgrounds.
- Everything is billed to the user's **ChatGPT subscription** — no API key, no per-image API cost.

## Important notes

- **It is slow.** Expect roughly 1–4 minutes per image. Run it as a background job and poll,
  rather than blocking a short foreground call.
- **The Codex image backend lives on `chatgpt.com`**, which is blocked on some networks.
  That is why the script routes through the local proxy. If generation fails with a timeout,
  check that the proxy (e.g. mihomo/clash) is actually running.
- **Output is a PNG**, typically 1254×1254. The wrapper copies it from Codex's own
  `~/.codex/generated_images/<session>/` directory to `-Out`.
- The script **fails loudly** (throws) instead of silently returning a stale image.
- Requires the Codex app to be installed and logged in with ChatGPT
  (`codex login status` should say `Logged in using ChatGPT`).
- Write prompts in the same language the user used, but art-directed English prompts often
  work best for this backend.

## Example

```powershell
& "$env:USERPROFILE\.agents\skills\codex-image\scripts\codex-image.ps1" `
    -Prompt "A cute flat-vector mascot of a deep blue whale, friendly, minimal, white background, product logo style" `
    -Out "D:\pics\whale.png"
```
