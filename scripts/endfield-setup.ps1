# 「明日方舟：终末地日活」一次性提权安装
# = game-daily-setup.ps1 -Profile endfield
# 用法（管理员 PowerShell）：powershell -ExecutionPolicy Bypass -File D:\dsh\qq-bridge\scripts\endfield-setup.ps1
& (Join-Path $PSScriptRoot 'game-daily-setup.ps1') -Profile endfield @args
exit $LASTEXITCODE
