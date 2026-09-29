# upgrade-dsh-017.ps1
# Stop DSH, upgrade the global @deepseek-ai/dsh to 0.1.7-rc.2, re-run scripts/setup-dsh.mjs
# (installs the new-style agent-preset patch + plugin links), then restart DSH and the
# bridge guard window, and finally run the offline verification.
#
# Why a detached script: stopping DSH kills the running agent session, so the whole
# sequence has to survive its own parent. It is launched through WMI (Win32_Process.Create),
# which detaches it from the DSH process tree.
#
# ASCII-only on purpose: Windows PowerShell 5.1 mis-parses UTF-8-without-BOM scripts that
# contain non-ASCII text and dies silently.
param(
  [string]$Target = '0.1.7-rc.2',
  [switch]$SkipBackup,
  # Wait this long before touching DSH: stopping DSH kills the running agent session,
  # so the current chat turn needs a moment to finish writing its reply.
  # (Keep this file ASCII-only: PS 5.1 mis-parses UTF-8-without-BOM files that contain
  #  non-ASCII text, and a mangled byte can even swallow the following newline.)
  [int]$GraceSeconds = 45
)

$ErrorActionPreference = 'Continue'
$root = 'D:\dsh\qq-bridge'
$node = 'D:\nodejs16\node.exe'
$npm = 'D:\nodejs16\npm.cmd'
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$env:DSH_HOME = $dshHome
$env:Path = "D:\nodejs16;D:\nodejs16\node_global;$env:Path"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $root "state\dsh-upgrade-$stamp.log"
$result = Join-Path $root "state\dsh-upgrade-$stamp-RESULT.txt"
$script:checks = New-Object System.Collections.ArrayList
# setup-dsh.mjs / verify-*.mjs are invoked with relative paths below, so pin the workdir first.
Set-Location $root

function W([string]$m) {
  $line = "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $m"
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Assert([string]$name, [bool]$ok, [string]$detail = '') {
  $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
  [void]$script:checks.Add("[$mark] $name" + $(if ($detail) { " -- $detail" } else { '' }))
  W "$mark $name$(if ($detail) { " -- $detail" })"
}

function Run([string]$exe, [string[]]$cmdArgs, [string]$label) {
  W "RUN $label : $exe $($cmdArgs -join ' ')"
  $out = & $exe @cmdArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  Add-Content -Path $log -Value $out -Encoding UTF8
  W "$label exit=$code"
  return @{ code = $code; out = $out }
}

function PortOpen([int]$port, [int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-NetConnection 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

W "=== DSH upgrade to $Target (stamp $stamp) ==="
W "DSH_HOME=$env:DSH_HOME"
if ($GraceSeconds -gt 0) {
  W "grace: waiting $GraceSeconds s before touching DSH (let the current chat turn finish)"
  Start-Sleep -Seconds $GraceSeconds
}

# ---- 0. record current versions ------------------------------------------------
$dshPkg = 'D:\nodejs16\node_global\node_modules\@deepseek-ai\dsh\package.json'
$beforeVersion = ''
try { $beforeVersion = (Get-Content $dshPkg -Raw | ConvertFrom-Json).version } catch { $beforeVersion = 'unknown' }
$nodeVer = (& $node -v) 2>&1 | Out-String
W "before: dsh=$beforeVersion node=$($nodeVer.Trim())"

# ---- 1. backup ----------------------------------------------------------------
if (-not $SkipBackup) {
  $bk = Run 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scripts\backup-before-upgrade.ps1')) 'backup'
  Assert 'backup-before-upgrade.ps1' ($bk.code -eq 0) "exit=$($bk.code)"
} else {
  Assert 'backup-before-upgrade.ps1' $true 'skipped by -SkipBackup'
}

# ---- 2. stop the bridge guard window and the bridge ---------------------------
$guards = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' }
foreach ($g in $guards) { W "stopping bridge guard PID $($g.ProcessId)"; Stop-Process -Id $g.ProcessId -Force -ErrorAction SilentlyContinue }
$bridges = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }
foreach ($b in $bridges) { W "stopping bridge PID $($b.ProcessId)"; Stop-Process -Id $b.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$stillBridge = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }
Assert 'bridge stopped' (-not $stillBridge)

# ---- 3. stop DSH + its MCP children ------------------------------------------
$dshProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match ' web' -and $_.CommandLine -match 'dsh' }
foreach ($p in $dshProcs) { W "stopping DSH PID $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5
$mcp = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*qq-bridge*src*mcp-*' }
foreach ($p in $mcp) { W "stopping leftover MCP child PID $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
$port3080Free = -not (Test-NetConnection 127.0.0.1 -Port 3080 -InformationLevel Quiet -WarningAction SilentlyContinue)
Assert 'DSH stopped (3080 free)' $port3080Free

# ---- 4. npm install -g @deepseek-ai/dsh@<Target> ------------------------------
$inst = Run $npm @('install', '-g', "@deepseek-ai/dsh@$Target") 'npm-install'
$afterVersion = ''
try { $afterVersion = (Get-Content $dshPkg -Raw | ConvertFrom-Json).version } catch { $afterVersion = 'unknown' }
W "after: dsh=$afterVersion"
Assert "dsh installed = $Target" ($afterVersion -eq $Target) "exit=$($inst.code) version=$afterVersion"

# ---- 5. re-install the DSH side (presets / MCP / plugin links) ---------------
$setup = Run $node @('scripts\setup-dsh.mjs') 'setup-dsh'
Assert 'setup-dsh.mjs' ($setup.code -eq 0) "exit=$($setup.code)"

# ---- 6. start DSH ------------------------------------------------------------
$binJs = 'D:\nodejs16\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
W "starting DSH: $node $binJs web --no-open"
Start-Process -FilePath $node -ArgumentList @($binJs, 'web', '--no-open') -WorkingDirectory 'D:\dsh' -WindowStyle Hidden
$dshUp = PortOpen 3080 180
Assert 'DSH listening on 3080' $dshUp

# ---- 7. offline verification against the running DSH -------------------------
if ($dshUp) {
  $verify = Run $node @('scripts\verify-agent-presets-017.mjs') 'verify-presets'
  Assert 'verify-agent-presets-017.mjs' ($verify.code -eq 0) "exit=$($verify.code)"
  $adapt = Run $node @('scripts\verify-dsh-015-adaptation.mjs') 'verify-adaptation'
  Assert 'verify-dsh-015-adaptation.mjs' ($adapt.code -eq 0) "exit=$($adapt.code)"
} else {
  Assert 'verify-agent-presets-017.mjs' $false 'skipped: DSH not up'
}

# ---- 8. start the bridge guard window ---------------------------------------
W 'starting bridge guard window (start.bat, minimized)'
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'start.bat') -WorkingDirectory $root -WindowStyle Minimized
$bridgeUp = PortOpen 3100 180
Assert 'bridge console listening on 3100' $bridgeUp

# ---- 9. summary --------------------------------------------------------------
$failCount = ($script:checks | Where-Object { $_.StartsWith('[FAIL]') }).Count
$header = @(
  "DSH upgrade run $stamp",
  "target=$Target  before=$beforeVersion  after=$afterVersion",
  "log: $log",
  ''
)
Set-Content -Path $result -Value ($header + $script:checks + @('', "failures: $failCount")) -Encoding UTF8
W "=== DONE (failures: $failCount) -> $result ==="
