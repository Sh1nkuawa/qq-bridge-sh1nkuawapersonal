# 升级前完整备份：仓库运行数据 + preset + DSH 配置 + git bundle
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-before-upgrade.ps1
$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = "D:\dsh\qq-bridge-backup-$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$log = Join-Path $dest 'backup.log'
function W([string]$m) {
  $line = "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $m"
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

W "备份目录：$dest"

# 1) 仓库运行数据（config.json / state/ 全量 —— 凭据、会话、审计都在这）
Copy-Item 'D:\dsh\qq-bridge\config.json' $dest -Force
Copy-Item 'D:\dsh\qq-bridge\config.example.json' $dest -Force
Copy-Item 'D:\dsh\qq-bridge\state' (Join-Path $dest 'state') -Recurse -Force
W "已备份 config.json / config.example.json / state/（$((Get-ChildItem (Join-Path $dest 'state') -Recurse -File | Measure-Object).Count) 个文件）"

# 2) git 全量 bundle（含所有分支与 tag，可完整还原仓库）
Push-Location 'D:\dsh\qq-bridge'
git bundle create (Join-Path $dest 'repo-all.bundle') --all 2>&1 | ForEach-Object { W "git bundle: $_" }
git rev-parse HEAD 2>&1 | ForEach-Object { W "当前 HEAD: $_" }
Pop-Location

# 3) 真正生效的 preset（新会话读这份）+ 工具白名单
$presets = Join-Path $env:USERPROFILE '.dsh\.agent-presets'
if (Test-Path $presets) {
  Copy-Item $presets (Join-Path $dest 'agent-presets') -Recurse -Force
  W "已备份 ~/.dsh/.agent-presets（含 $(Get-ChildItem $presets -Directory | Measure-Object | Select-Object -ExpandProperty Count) 个 preset）"
}

# 4) DSH 侧配置（升级 DSH 可能重置 profile 的 package.json / bundle 条目）
$web = Join-Path $env:USERPROFILE '.dsh\profiles\web'
Copy-Item (Join-Path $web 'package.json') (Join-Path $dest 'web-package.json') -Force
Copy-Item (Join-Path $web 'cordis.patch.yml') (Join-Path $dest 'web-cordis.patch.yml') -Force
Copy-Item (Join-Path $env:USERPROFILE '.dsh\settings.yaml') (Join-Path $dest 'settings.yaml') -Force
if (Test-Path (Join-Path $web 'node_modules')) {
  (Get-ChildItem (Join-Path $web 'node_modules') -Directory | Select-Object -ExpandProperty Name) | Set-Content (Join-Path $dest 'web-node_modules-list.txt') -Encoding UTF8
}
W "已备份 DSH 配置（web/package.json、web/cordis.patch.yml、settings.yaml、profile 依赖清单）"

# 5) 记录版本信息，便于回滚
@(
  "DSH 版本: $((Get-Content 'D:\nodejs16\node_global\node_modules\@deepseek-ai\dsh\package.json' -Raw | ConvertFrom-Json).version)",
  "node: $(node -v)",
  "npm: $(npm -v)",
  "桥接 package.json 版本: $((Get-Content 'D:\dsh\qq-bridge\package.json' -Raw | ConvertFrom-Json).version)",
  "备份时间: $stamp"
) | Set-Content (Join-Path $dest 'versions.txt') -Encoding UTF8
Get-Content (Join-Path $dest 'versions.txt') | ForEach-Object { W $_ }

$size = (Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
W ("备份完成，共 {0:N2} MB" -f $size)
W "恢复提示：git clone repo-all.bundle 可还原仓库；state/ 与 config.json 直接拷回 qq-bridge/ 即可。"
