# close-dsh.ps1 - started by the QQ agent on user request: wait a bit, then stop the DSH web process.
# The user restarts DSH manually afterwards. Keep this file ASCII-only:
# Windows PowerShell 5.1 mis-parses UTF-8 (no BOM) scripts containing non-ASCII text and exits silently.
$log = 'D:\dsh\qq-bridge\state\restart-dsh.log'
function W([string]$m) {
    $line = "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $m"
    Add-Content -Path $log -Value $line -Encoding UTF8
}

W 'close-dsh: scheduled, waiting 10s so the last chat message can be persisted...'
Start-Sleep -Seconds 10

$dsh = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'dsh' -and $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match 'web' }
if (-not $dsh) {
    W 'close-dsh: no running DSH web process found (already closed?)'
} else {
    foreach ($p in $dsh) {
        W "close-dsh: stopping DSH PID $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 4
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*qq-bridge*src*mcp-*' }
foreach ($p in $left) {
    W "close-dsh: cleaning leftover MCP child PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 3
$portUp = Test-NetConnection 127.0.0.1 -Port 3080 -InformationLevel Quiet -WarningAction SilentlyContinue
$bridge = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp*' }).ProcessId
$onebot = Test-NetConnection 127.0.0.1 -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue
W "close-dsh: done. DSH 3080 listening=$portUp ; OneBot 3000=$onebot ; bridge PID=$bridge (bridge is standalone, keeps running and waits for DSH)"
W 'close-dsh: please restart DSH (dsh web), then reopen this session.'
