# fix-tailscale-serve.ps1  (ASCII only on purpose: PowerShell 5.1 reads BOM-less
# files as GBK, and Chinese comments would swallow the following lines.)
#
# Purpose: DSH Desktop picks a RANDOM port on every start (--port 0), so the
# existing `tailscale serve --https=443` target goes stale and the ts.net URL
# answers 502. This script finds the live DSH Web GUI port, then re-points
# tailscale serve at it.
#
# Run it AS ADMINISTRATOR (tailscale serve needs the admin-only named pipe):
#   Right-click -> "Run with PowerShell"   (Windows will ask for UAC)
#   or:  powershell -ExecutionPolicy Bypass -File .\fix-tailscale-serve.ps1
#
# Optional: -Port 7060 to force a port, -Funnel to expose to the public
# internet instead of only the tailnet (Funnel needs HTTPS enabled in the
# tailnet policy).

param(
    [int]$Port = 0,
    [switch]$Funnel,
    [switch]$StatusOnly
)

$ErrorActionPreference = 'Stop'

function Find-Tailscale {
    $candidates = @(
        "$env:ProgramFiles\Tailscale\tailscale.exe",
        "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe",
        "$env:LOCALAPPDATA\Tailscale\tailscale.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "tailscale.exe not found. Install Tailscale first."
}

function Test-DshGui([int]$p) {
    try {
        # A bare 200 is NOT a DSH signature. Measured 2026-10-20: the Bilibili client answers 200
        # on its own loopback port (22331) for ANY path, and 22331 < the real GUI port - so the
        # old "first 200 wins" scan silently pointed ts.net at Bilibili. Require DSH-only keys.
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$p/plugin-installer/health")
        $req.Timeout = 800
        $req.ReadWriteTimeout = 800
        $req.Proxy = $null
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd()
        $sr.Close(); $resp.Close()
        return ($body -match '"profileDir"' -or $body -match '"versions"\s*:\s*\{\s*"dsh"')
    } catch { return $false }
}

$tail = Find-Tailscale

if ($StatusOnly) {
    & $tail serve status
    exit 0
}

if ($Port -le 0) {
    # 1) Preferred: the plugin-installer health route, but only with a DSH-only signature.
    $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1') -and $_.LocalPort -gt 1024 }
    $rows = @()
    $seenPort = @{}
    foreach ($c in $listening) {
        if ($seenPort.ContainsKey($c.LocalPort)) { continue }
        $seenPort[$c.LocalPort] = $true
        $exe = $null; $started = [datetime]::MinValue
        try { $pr = Get-Process -Id $c.OwningProcess -ErrorAction Stop; $exe = $pr.Path; $started = $pr.StartTime } catch { }
        $isDsh = ($exe -and ($exe -match '\\DSH\\' -or $exe -match 'DeepSeek'))
        $rows += [pscustomobject]@{ port = [int]$c.LocalPort; isDsh = $isDsh; started = $started; exe = $exe }
    }
    $ordered = @($rows | Where-Object { $_.isDsh } | Sort-Object started -Descending) +
               @($rows | Where-Object { -not $_.isDsh } | Sort-Object port -Descending)
    Write-Host "Scanning $($rows.Count) listening ports for the DSH Web GUI (DSH process first) ..."
    foreach ($r in $ordered) {
        if (Test-DshGui $r.port) { $Port = $r.port; break }
    }
}

if ($Port -le 0) {
    # 2) Fallback: the health route may not exist yet; ask the shell instead.
    Write-Host "No port answered /plugin-installer/health; falling back to the DSH process."
    $dshPids = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -like '*\DSH\*') } |
        Select-Object -ExpandProperty Id
    if ($dshPids.Count -eq 0) { throw "No DSH process found. Is DeepSeek Harness running?" }
    $guess = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $dshPids -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' } |
        Select-Object -First 1
    if (-not $guess) { throw "DSH is running but no loopback listener was found." }
    $Port = $guess.LocalPort
}

Write-Host "DSH Web GUI port: $Port"

if ($Funnel) {
    & $tail funnel --bg --https=443 "http://127.0.0.1:$Port"
} else {
    & $tail serve --bg --https=443 "http://127.0.0.1:$Port"
}
$code = $LASTEXITCODE

Write-Host ""
& $tail serve status
Write-Host ""
if ($code -eq 0) {
    Write-Host "OK. Open the ts.net URL on your phone:"
    $dns = (& $tail status --json | ConvertFrom-Json).Self.DNSName
    if ($dns) {
        $dns = $dns.TrimEnd('.')
        Write-Host ("  https://" + $dns + "/")
        if ($Funnel) { Write-Host "  (Funnel: also reachable from the public internet)" }
    }
    Write-Host ""
    Write-Host "NOTE: DSH picks a new random port on every start."
    Write-Host "      One-shot fix: run this script again after a restart."
    Write-Host "      Permanent fix: run dev\install-serve-watch.ps1 once (admin)."
    Write-Host "      It registers a logon task + global hotkey (default Ctrl+Alt+Y) that"
    Write-Host "      re-points serve whenever the GUI port changes."
} else {
    Write-Host "tailscale exited with code $code"
}
