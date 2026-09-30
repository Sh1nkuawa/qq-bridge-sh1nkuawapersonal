# 「明日方舟日活」一次性提权安装
# = game-daily-setup.ps1 -Profile arknights（保留这个文件名是为了向后兼容）
# 用法（管理员 PowerShell）：powershell -ExecutionPolicy Bypass -File D:\dsh\qq-bridge\scripts\arknights-setup.ps1
& (Join-Path $PSScriptRoot 'game-daily-setup.ps1') -Profile arknights @args
exit $LASTEXITCODE
