# install.ps1 —— 将 agy-plugin 安装到 Antigravity 全局插件目录
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\agy-plugin\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\agy-plugin\install.ps1 -Uninstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\agy-plugin\install.ps1 -TargetDir "C:\custom\path"
#
# 说明：
#   - 仅复制插件文件到 %USERPROFILE%\.gemini\config\plugins\qq-bridge-worker
#   - 绝不修改 ~/.gemini/config/config.json（启用/禁用请在 Antigravity Plugins 界面操作）

[CmdletBinding()]
param(
  [string]$TargetDir = (Join-Path $env:USERPROFILE ".gemini\config\plugins\qq-bridge-worker"),
  [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Uninstall) {
  if (Test-Path $TargetDir) {
    Remove-Item -Path $TargetDir -Recurse -Force
    Write-Output "[OK] 已卸载插件目录：$TargetDir"
  } else {
    Write-Output "[i] 插件目录不存在，无需卸载：$TargetDir"
  }
  exit 0
}

$RequiredFiles = @(
  "plugin.json",
  "agents\qq-chat-worker.md",
  "skills\qq-bot-operator\SKILL.md"
)

foreach ($rel in $RequiredFiles) {
  $srcPath = Join-Path $SourceDir $rel
  if (-not (Test-Path $srcPath)) {
    throw "缺少必需插件文件：$srcPath"
  }
}

$parentDir = Split-Path -Parent $TargetDir
if (-not (Test-Path $parentDir)) {
  New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
}

if (-not (Test-Path $TargetDir)) {
  New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

# 原地覆盖更新，避免正在运行的 sidecar 进程占用目录 CWD 导致 Remove-Item 报文件占用
$ItemsToCopy = @("plugin.json", "mcp_config.json", "agents", "skills", "sidecars")
foreach ($item in $ItemsToCopy) {
  $src = Join-Path $SourceDir $item
  if (Test-Path $src) {
    if (Test-Path $src -PathType Container) {
      $dst = Join-Path $TargetDir $item
      if (-not (Test-Path $dst)) {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
      }
      Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    } else {
      Copy-Item -Path $src -Destination (Join-Path $TargetDir $item) -Force
    }
  }
}

Write-Output "[OK] 已安装 qq-bridge-worker 插件到：$TargetDir"
Write-Output "[i] 包含组件："
Write-Output "    - plugin.json"
Write-Output "    - mcp_config.json"
Write-Output "    - agents\qq-chat-worker.md"
Write-Output "    - skills\qq-bot-operator\SKILL.md"
Write-Output "    - sidecars\agy-duty-watcher\ (自动切 AGY 开新会话)"
Write-Output "[i] 后续步骤：在 Antigravity 的 Customizations / Plugins 页面确认 qq-bridge-worker 已启用；如需自动开新会话，请在 Sidecars 设置中启用「AGY QQ 值守自动开会话」并绑定 geminiqq 项目。"
