# boot-guard.ps1 — guarded boot for DeepSeek Harness (Windows).
#
# Snapshots every profile, starts `dsh web`, health-checks it, and on failure
# kills the tree, rolls back to the last good snapshot and retries once.
# On first-attempt failure it also writes an incident report + pending marker
# (the guard plugin then auto-triggers analysis in the next session).
#
# Wire it into your launcher so the harness starts through this script:
#   powershell -NoProfile -ExecutionPolicy Bypass -File boot-guard.ps1
#
# On success the script stays attached to the server tree (Wait-Process), so
# launchers that kill the tree on window close keep their close-to-quit
# semantics; launchers that detach keep the server resident.
#
# ASCII only: runs with Windows PowerShell 5.1 (no BOM).

param(
    [int]$FirstWaitSec = 60,
    [int]$RetryWaitSec = 30,
    [int]$Port = 3080,
    [string]$Profile = "web",
    [string]$HarnessRoot = "",
    [string]$ServerArgs = ""
)

$ErrorActionPreference = "Continue"

# Force UTF-8 end-to-end for log files. Windows PowerShell 5.1's
# Add-Content/Set-Content default to the system ANSI code page (GBK on zh-CN)
# and decode native-child stdout with the console codepage, so Chinese in the
# guard CLI output becomes mojibake in the logs and incident reports. Pinning
# both sides to UTF-8 keeps every log valid UTF-8. The script file itself
# stays ASCII (PS 5.1 parses it as ANSI), only the log output is UTF-8.
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

if (-not $HarnessRoot) { $HarnessRoot = Split-Path -Parent $PSScriptRoot }
$HarnessRoot = $HarnessRoot.Trim().TrimEnd([char]34, [char]39, [char]92)  # strip stray quote/trailing slash
if (-not $env:DSH_HOME -or $env:DSH_HOME.Trim() -eq "") {
    $env:DSH_HOME = Join-Path $HarnessRoot ".dsh-home"
}

# Locate the guard CLI shipped inside the installed package.
$cli = Join-Path $env:DSH_HOME ("profiles\" + $Profile + "\node_modules\dsh-plugin-guard\scripts\guard-cli.js")
if (-not (Test-Path $cli)) {
    $cli = Join-Path $HarnessRoot "node_modules\dsh-plugin-guard\scripts\guard-cli.js"
}

$logDir = Join-Path $env:DSH_HOME "guard\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$bootLog = Join-Path $logDir ("boot-" + $stamp + ".log")
$serverOut = Join-Path $logDir ("server-" + $stamp + ".out.log")
$serverErr = Join-Path $logDir ("server-" + $stamp + ".err.log")
$statusFile = Join-Path $logDir "last-boot.txt"

function Log([string]$msg) {
    Add-Content -Path $bootLog -Value ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg) -Encoding UTF8
}
function Set-Status([string]$status, [string]$note) {
    ("{0} {1} {2} {3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $status, $note, "(log: $stamp)") |
        Set-Content -Path $statusFile -Encoding UTF8
}
function Test-Health {
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/") -TimeoutSec 3 -UseBasicParsing
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch { return $false }
}
function Invoke-Guard([string[]]$cliArgs) {
    $out = & node $cli @cliArgs 2>&1 | Out-String
    if ($out) { foreach ($line in ($out -split "`r?`n")) { if ($line.Trim()) { Log ("  [guard] " + $line.Trim()) } } }
    return $out
}
function Is-Alive([System.Diagnostics.Process]$p) {
    if ($null -eq $p) { return $false }
    try { $p.Refresh() } catch {}
    return (-not $p.HasExited)
}
function Wait-Healthy([int]$seconds, [System.Diagnostics.Process]$proc) {
    # Returns "ok" (healthy), "crashed" (the server process already exited, so
    # roll back immediately instead of waiting out the timeout), or "timeout"
    # (still running but never became healthy within $seconds).
    # The crash branch requires BOTH an unhealthy check AND a dead process, so
    # a server that hands off to a detached healthy child is never rolled back.
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Health) { return "ok" }
        if (-not (Is-Alive $proc)) { return "crashed" }
        Start-Sleep -Milliseconds 250
    }
    return "timeout"
}
function Start-Server([string]$outLog, [string]$errLog) {
    $dshCmd = Join-Path $HarnessRoot "node_modules\.bin\dsh.cmd"
    if (-not (Test-Path $dshCmd)) { $dshCmd = "dsh.cmd" }
    $cmdLine = '"' + $dshCmd + '" web'
    if ($ServerArgs.Trim() -ne "") { $cmdLine = $cmdLine + " " + $ServerArgs.Trim() }
    $p = Start-Process -FilePath "cmd.exe" `
        -ArgumentList '/d', '/s', '/c', $cmdLine `
        -WorkingDirectory $HarnessRoot `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -WindowStyle Hidden `
        -PassThru
    return $p
}
function Stop-ServerTree($p) {
    if ($p -and -not $p.HasExited) {
        try { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch {}
        try { $p.Kill() } catch {}
    }
}

Log "=== boot guard start ==="
if (Test-Health) { Log "already healthy"; Set-Status "OK" "already-running"; exit 0 }

$null = Invoke-Guard @("snapshot", "--tag", "pre-boot", "--reason", "automatic snapshot before boot")

$proc = Start-Server $serverOut $serverErr
Log "started server (pid $($proc.Id))"
$boot = Wait-Healthy $FirstWaitSec $proc
if ($boot -eq "ok") {
    Log "boot ok on first attempt"
    Set-Status "OK" "first-attempt"
    Wait-Process -Id $proc.Id
    Log "server tree exited; boot guard done"
    exit 0
}
Log "server not healthy ($boot) after up to $FirstWaitSec s; stopping and rolling back"
Stop-ServerTree $proc

$null = Invoke-Guard @("rollback", "--good")

$proc2 = Start-Server $serverOut $serverErr
Log "restarted server (pid $($proc2.Id))"
$retry = Wait-Healthy $RetryWaitSec $proc2
if ($retry -eq "ok") { Set-Status "OK" "rolled-back-retry" }
else { Stop-ServerTree $proc2; Set-Status "FAILED" ("boot-failed (" + $retry + ")") }

$null = Invoke-Guard @("incident", "--kind", "boot-failure")

if ($retry -eq "ok") { Wait-Process -Id $proc2.Id; Log "server tree exited; boot guard done"; exit 0 }
exit 1
