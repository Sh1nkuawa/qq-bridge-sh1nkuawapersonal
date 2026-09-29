<#
.SYNOPSIS
    Generate an image with the local Codex CLI (uses your ChatGPT subscription - no API key).

.DESCRIPTION
    Runs `codex exec` with an image-generation instruction, then finds the newest PNG that
    Codex wrote under ~/.codex/generated_images and copies it to the requested output path.

    The Codex image backend lives on chatgpt.com, which is blocked on some networks, so this
    script routes through a local HTTP proxy (auto-detected from the Windows system proxy).

.PARAMETER Prompt
    What the image should be. Be dense and art-directed.

.PARAMETER Out
    Output file path for the PNG (e.g. D:\pics\cat.png).

.PARAMETER Proxy
    Proxy URL. Defaults to the Windows system proxy; pass '' to force a direct connection.

.PARAMETER TimeoutSec
    How long to let codex run. Default 600.

.EXAMPLE
    .\codex-image.ps1 -Prompt "a cute flat-vector blue whale mascot, white background" -Out D:\pics\whale.png
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Prompt,
    [Parameter(Mandatory = $true, Position = 1)][string]$Out,
    [string]$Proxy,
    [int]$TimeoutSec = 600,
    # Driver (agent) model that reads the prompt and calls the image tool.
    [string]$Model = 'gpt-6-sol',
    # Reasoning effort for that driver model: minimal|low|medium|high|xhigh|ultra|max.
    [string]$ReasoningEffort = 'high',
    # 参考图/待编辑图片（可选）。传了就走"改图/多图参考"模式：
    # codex exec -i <file> 把图片附加到提示词上，图片工具就能引用它们。
    # 注意：-i 是可重复的多值参数（<FILE>...），会把后面的位置参数也吃掉，
    # 所以带图时提示词必须走 stdin（实测：直接放位置参数会变成"没给提示词"）。
    [string[]]$Images = @()
)

$ErrorActionPreference = 'Stop'

# --- resolve proxy (default: Windows system proxy, e.g. mihomo/clash) ---
if (-not $PSBoundParameters.ContainsKey('Proxy')) {
    try {
        $reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -eq 1 -and $reg.ProxyServer) {
            $srv = ($reg.ProxyServer -split ';')[0]
            if ($srv -notmatch '^https?://') { $srv = 'http://' + $srv }
            $Proxy = $srv
        }
    } catch { }
}
if ($Proxy) {
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    Write-Verbose "Using proxy $Proxy"
}

# --- locate the Codex CLI ---
$cli = Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Recurse -Filter 'codex.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $cli) { throw 'codex.exe not found under %LOCALAPPDATA%\OpenAI\Codex\bin. Install the Codex app first.' }

# --- snapshot existing generated images so we can spot the new one ---
$genDir = Join-Path $env:USERPROFILE '.codex\generated_images'
$before = @{}
if (Test-Path $genDir) {
    Get-ChildItem $genDir -Recurse -File -Filter '*.png' -ErrorAction SilentlyContinue |
        ForEach-Object { $before[$_.FullName] = $true }
}

# A FIXED working dir: codex registers its cwd as a trusted project in config.toml, so a
# random dir per run would accumulate junk `[projects.'...']` entries.
$work = Join-Path $env:USERPROFILE '.codex-image-work'
New-Item -ItemType Directory -Path $work -Force | Out-Null

# 过滤掉不存在的图，避免 codex 因为一个坏路径整体失败。
# 注意：powershell.exe -File 调用时**不会**按逗号拆分数组参数（逗号语法只在 PowerShell 自己的
# 解析器里生效），所以 "-Images a.png,b.png" 到手的是一个字符串，必须在这里自己再拆一次。
$rawImages = @()
foreach ($item in @($Images)) {
    foreach ($part in ([string]$item -split ',')) {
        $t = $part.Trim().Trim('"')
        if ($t) { $rawImages += $t }
    }
}
$images = @($rawImages | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { [System.IO.Path]::GetFullPath($_) })
if ($rawImages.Count -gt 0 -and $images.Count -eq 0) {
    throw "传了 -Images 但文件都不存在（$($rawImages -join ', ')）"
}

if ($images.Count -gt 0) {
    $instruction = @"
Use the image generation tool to EDIT / re-compose the attached image(s) and nothing else: $Prompt

The attached images are provided as references (in the order given). Rules:
- Generate exactly one image that actually uses the attached reference image(s);
  keep the referenced subjects/characters recognizable (same look, colors, outfit).
- Follow the instruction above for what to change or combine.
- Do NOT run shell commands, do NOT try to save or copy the file yourself, and do NOT read
  or write any project files. Just call the image generation tool once and then stop.
"@
} else {
    $instruction = @"
Use the image generation tool to create this image and nothing else: $Prompt

Rules: generate exactly one image. Do NOT run shell commands, do NOT try to save or copy
the file yourself, and do NOT read or write any project files. Just call the image
generation tool once and then stop.
"@
}

Write-Verbose 'Running codex exec (this can take a few minutes)...'

# --- preflight: 先探一次 chatgpt.com 是否真的通（走 codex 将要用的同一个代理）---
# 背景：codex exec 启动时会联网刷新模型列表，网络不通时它会自己重试好几轮，
# 每轮约 4 分钟，最后 10 分钟过去一张图都没开始画。这里先用一次 12 秒的
# HTTPS 请求把"网络不通"这种情况快速判掉，报错清楚、也不再白等。
function Test-ChatGptReachable {
    param([string]$ProxyUrl)
    $probeUrl = 'https://chatgpt.com/backend-api/codex/models?client_version=0'
    $attempts = 2
    $lastWhy = ''
    for ($i = 1; $i -le $attempts; $i++) {
        $splat = @{ Uri = $probeUrl; TimeoutSec = 12; UseBasicParsing = $true; ErrorAction = 'Stop' }
        if ($ProxyUrl) { $splat['Proxy'] = $ProxyUrl }
        try {
            $null = Invoke-WebRequest @splat
            return @{ ok = $true; why = '' }
        } catch {
            # 收到 HTTP 响应（哪怕是 401/403）就说明链路是通的，只是没带凭据。
            $resp = $null
            try { $resp = $_.Exception.Response } catch { }
            if ($resp) { return @{ ok = $true; why = "HTTP $([int]$resp.StatusCode)" } }
            $lastWhy = $_.Exception.Message
            if ($i -lt $attempts) { Start-Sleep -Seconds 2 }
        }
    }
    return @{ ok = $false; why = $lastWhy }
}

$reach = Test-ChatGptReachable -ProxyUrl $Proxy
$via = if ($Proxy) { "代理 $Proxy" } else { '直连' }
if (-not $reach.ok) {
    throw "网络不可达：$via 访问 chatgpt.com 失败（$($reach.why)）。本次没有生成图片；请检查代理节点/网络后重试。"
}
Write-Verbose "chatgpt.com 可达（$via）"

# codex writes progress to stderr; with ErrorActionPreference=Stop PowerShell would treat
# that as fatal, so relax it just for this call.
# 同时真正落实 -TimeoutSec：超时就掐掉，否则 codex 能在网络重试里空转十分钟。
$effortOverride = 'model_reasoning_effort="' + $ReasoningEffort + '"'
# 诊断用：这行会随 worker 的重定向落进 codex-*.log，用于排查"图到底传进来没有"
Write-Output "[codex-image] 输入图 $($images.Count) 张：$($images -join ' | ')"
# 注意：Start-Job 的 -ArgumentList 会把数组**拍平**，所以图片列表必须序列化成 JSON 字符串传进去，
# 否则 job 里拿到的是空数组（实测踩过：codex 回复"我没有收到你提到的两张图片"）。
$imagesJson = @($images) | ConvertTo-Json -Compress
$job = Start-Job -ArgumentList $cli, $work, $Model, $effortOverride, $instruction, $imagesJson -ScriptBlock {
    param($cliPath, $workDir, $modelName, $effort, $instructionText, $imagesJson)
    $ErrorActionPreference = 'Continue'
    $imagePaths = @()
    if ($imagesJson) { try { $imagePaths = @($imagesJson | ConvertFrom-Json) } catch { $imagePaths = @() } }
    $argv = @(
        'exec', '--skip-git-repo-check',
        '--cd', $workDir,
        '-m', $modelName,
        '-c', $effort,
        '-c', 'approval_policy="never"',
        '-c', 'sandbox_mode="workspace-write"'
    )
    foreach ($p in $imagePaths) { $argv += @('-i', $p) }
    if ($imagePaths.Count -gt 0) {
        # 带图时提示词必须走 stdin：-i 是多值参数，会把它后面的位置参数一起吃掉。
        $instructionText | & $cliPath @argv 2>&1 | Out-String
    } else {
        & $cliPath @argv $instructionText 2>&1 | Out-String
    }
}
$finished = Wait-Job $job -Timeout $TimeoutSec
if (-not $finished) {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    # 兜底：job 被终止后，它启动的 codex.exe 可能还挂着，按启动时间找出来掐掉。
    Get-Process codex -ErrorAction SilentlyContinue |
        Where-Object { $_.StartTime -gt (Get-Date).AddSeconds(-1 * ($TimeoutSec + 30)) } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { } }
    throw "codex 超时（${TimeoutSec}s 内没出图）。网络/代理可能不稳；本次没有生成图片。"
}
$log = (Receive-Job $job | Out-String)
Remove-Job $job -Force -ErrorAction SilentlyContinue
Write-Verbose $log

# --- find the newly generated PNG (strict: must not exist in our snapshot) ---
$all = Get-ChildItem $genDir -Recurse -File -Filter '*.png' -ErrorAction SilentlyContinue
$new = $all | Where-Object { -not $before.ContainsKey($_.FullName) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $new) {
    throw "No NEW image was produced by codex. codex output:`n$log"
}

# --- copy to the requested path ---
$outFull = [System.IO.Path]::GetFullPath($Out)
$parent = Split-Path $outFull -Parent
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
Copy-Item $new.FullName $outFull -Force

Write-Output $outFull
