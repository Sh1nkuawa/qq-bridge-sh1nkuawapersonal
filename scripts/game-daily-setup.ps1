# 游戏日活：**一次性**提权安装（必须用管理员身份运行本脚本）
#
# 支持两个档案：
#   -Profile arknights （默认）→ 计划任务 qq-bridge-arknights-daily  → scripts\arknights-daily.mjs
#   -Profile endfield          → 计划任务 qq-bridge-endfield-daily   → scripts\endfield-daily.mjs
#
# 干三件事：
#   ① 注册计划任务（最高权限 + 只在用户登录时运行）
#      —— 桥接是普通权限，只有 schtasks /Run 这个任务才能不弹 UAC 地以管理员身份起游戏
#      （终末地的 MAAEND 自己不需要管理员，但官方 PC 端 Endfield.exe 需要；执行器会把 MAAEND 降权启动）
#   ② 把工具调成「启动即跑」：方舟 = gui.new.json 的 RunDirectly；终末地 = mxu-MaaEnd.json 的 autoRunOnLaunch
#      （改前都会备份成 *.bak-gamedaily；工具必须先关掉）
#   ③ 跑一次 --dry-run 自检，把路径/权限/连接方式打出来
#
# 用法（管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File D:\dsh\qq-bridge\scripts\game-daily-setup.ps1 -Profile endfield
# 参数：
#   -Profile arknights|endfield   装哪个档案（默认 arknights）
#   -SkipToolConfig               不改工具配置（改用热键触发）
#   -Uninstall                    只删除该档案的计划任务
param(
  [ValidateSet('arknights', 'endfield')][string]$Profile = 'arknights',
  [switch]$SkipToolConfig,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

$meta = @{
  arknights = @{ Task = 'qq-bridge-arknights-daily'; Runner = 'scripts\arknights-daily.mjs'; Label = '明日方舟日活' }
  endfield  = @{ Task = 'qq-bridge-endfield-daily';  Runner = 'scripts\endfield-daily.mjs';  Label = '终末地日活' }
}[$Profile]
$TaskName = $meta.Task

# ── 提权检查 ────────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Say '[X] 需要管理员权限：请右键开始菜单 -> 终端(管理员) / Windows PowerShell(管理员)，再跑本脚本。' 'Red'
  Say '    （这一步只需做一次；之后桥接用普通权限触发任务即可，不会再弹 UAC。）'
  exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repo $meta.Runner
$node = 'D:\nodejs16\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Say '[X] 找不到 node.exe' 'Red'; exit 1 }
if (-not (Test-Path $runner)) { Say "[X] 找不到 $runner" 'Red'; exit 1 }

Say "档案: $Profile（$($meta.Label)）"
Say "仓库: $repo"
Say "node : $node"

# ── 卸载 ────────────────────────────────────────────────────────────────────
if ($Uninstall) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say "[OK] 已删除计划任务 $TaskName" 'Green'
  } catch {
    Say "[!] 删除失败（可能本来就不存在）：$($_.Exception.Message)" 'Yellow'
  }
  exit 0
}

# ── 工具必须先关掉（它退出时会把整份配置写回去，会覆盖我们刚改的设置）──────────
$toolProcess = if ($Profile -eq 'endfield') { 'MaaEnd' } else { 'MAA' }
$running = Get-Process -Name $toolProcess -ErrorAction SilentlyContinue
if ($running) {
  Say "[X] 检测到 $toolProcess 正在运行（PID $($running.Id -join ', ')）：请先关掉它再跑本脚本。" 'Red'
  Say '    原因：它退出时会保存整份配置，会把「启动即跑」这个设置覆盖回去。' 'Red'
  if (-not $SkipToolConfig) { exit 1 }
  Say '    （你带了 -SkipToolConfig，所以只是提醒，继续注册任务。）' 'Yellow'
}

# ── 注册计划任务 ────────────────────────────────────────────────────────────
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$runner`"" -WorkingDirectory $repo
# LogonType Interactive = 「只在用户登录时运行」：必须这样，工具要截屏和发输入，跑在会话里才行
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 60) -MultipleInstances IgnoreNew -StartWhenAvailable
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(10)   # 触发只靠手动/桥接，这个只是占位
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
Say "[OK] 计划任务已注册：$TaskName（最高权限 + 仅登录时运行）" 'Green'
$runAs = (Get-ScheduledTask -TaskName $TaskName).Principal
Say ("     用户/登录方式/权限: {0} / {1} / {2}" -f $runAs.UserId, $runAs.LogonType, $runAs.RunLevel)

# ── 工具调成「启动即跑」──────────────────────────────────────────────────────
if (-not $SkipToolConfig) {
  Say "正在设置「启动即跑」（$($meta.Label)；要求对应工具已关闭）..."
  & $node $runner --prepare-maa --profile $Profile
} else {
  Say '（-SkipToolConfig：跳过改工具配置，将用热键触发）' 'Yellow'
}

# ── 自检（dry-run：只预检，不启动游戏/工具）─────────────────────────────────
Say ''
Say '===== 自检（dry-run，不会启动游戏或工具）====='
& $node $runner --dry-run
Say ''
Say "下一步：让 owner 在群里 @机器人 发「$(if ($Profile -eq 'endfield') { '帮我做终末地日活' } else { '帮我做明日方舟日活' })」即可（只有这一句话会触发）。" 'Cyan'
Say "日志：$repo\state\$(if ($Profile -eq 'endfield') { 'endfield' } else { 'arknights' })-daily.log" 'Cyan'
