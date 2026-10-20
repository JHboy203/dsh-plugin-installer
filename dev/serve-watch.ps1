# serve-watch.ps1 - keep `tailscale serve --https=443` pointed at the LIVE DSH Web GUI.
#
# WHY THIS EXISTS
#   1) The Desktop app launches the host with `--port 0` (dsh-desktop-host hardcodes it), so the
#      GUI port changes on EVERY start. `tailscale serve` stores a fixed target -> stale -> 502.
#   2) The old one-shot fix script probed every listening port with
#      `Invoke-WebRequest http://127.0.0.1:<p>/plugin-installer/health` and accepted ANY 200.
#      On this machine the Bilibili client answers 200 on its own loopback port (22331), which is
#      LOWER than the DSH port - so the scan silently pointed ts.net at Bilibili. That is the real
#      reason the phone "sometimes shows a web page that is not DSH".
#      => every probe here must match a DSH-ONLY signature ("profileDir"/"versions.dsh"), and
#         processes whose exe lives outside the DSH install are probed last.
#
# WHAT IT DOES
#   * finds the current DSH port (cached first, then DSH-exe listeners newest-first, then the rest)
#   * reads `tailscale serve status`, and if the target != live port, re-points it
#   * runs a GLOBAL HOTKEY (default ctrl+alt+y, candidates tried in order) that forces a check now
#   * re-checks every -IntervalSec seconds, so a DSH restart heals itself with no human action
#
# RUNS ELEVATED (tailscale serve talks to an admin-only named pipe). Install it as a logon task:
#   powershell -ExecutionPolicy Bypass -File install-serve-watch.ps1
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 decodes BOM-less files as GBK; Chinese comments
# would be mis-decoded and can swallow the following line.
#
# Handy modes:
#   -StatusOnly   print the last state + log tail, no side effects
#   -Once         run exactly one check, print the JSON report, exit (no hotkey, no loop)
#   -SelfTest     register the hotkey, then POST a synthetic WM_HOTKEY to our own thread and
#                 confirm the loop handled it (proves the wiring without a human keypress)
#   -Port 55413   force the target port (skips detection)

param(
  [string]$Config = '',
  [string]$Hotkeys = '',
  [int]$IntervalSec = 0,
  [int]$Port = 0,
  [int]$MaxMinutes = 0,
  [switch]$Once,
  [switch]$StatusOnly,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($Config)) { $Config = Join-Path $ScriptDir 'serve-watch.config.json' }
$StatePath = Join-Path $ScriptDir 'serve-watch.state.json'
$LogPath = Join-Path $ScriptDir 'serve-watch.log'
$MaxLogLines = 800

function Write-Log([string]$type, [hashtable]$data) {
  try {
    $obj = [ordered]@{ at = (Get-Date).ToString('o'); type = $type; pid = $PID }
    foreach ($k in $data.Keys) { $obj[$k] = $data[$k] }
    $line = ($obj | ConvertTo-Json -Compress -Depth 6)
    Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction Stop
  } catch { }
}

function Trim-Log {
  try {
    if (-not (Test-Path $LogPath)) { return }
    $lines = Get-Content $LogPath -ErrorAction Stop
    if ($lines.Count -gt $MaxLogLines) {
      $keep = $lines[($lines.Count - $MaxLogLines)..($lines.Count - 1)]
      Set-Content -Path $LogPath -Value $keep -Encoding UTF8
    }
  } catch { }
}

function Save-State([hashtable]$state) {
  try {
    $state['at'] = (Get-Date).ToString('o')
    $tmp = $StatePath + '.tmp'
    ($state | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Path $tmp -Destination $StatePath -Force
  } catch { }
}

function Read-State {
  if (-not (Test-Path $StatePath)) { return $null }
  try { return (Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# ---------------------------------------------------------------- config

$cfg = @{ hotkeys = @('ctrl+alt+y', 'ctrl+alt+g', 'alt+shift+t'); intervalSec = 20; port = 0 }
if (Test-Path $Config) {
  try {
    $raw = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($raw.hotkeys) { $cfg.hotkeys = @($raw.hotkeys) }
    if ($raw.intervalSec) { $cfg.intervalSec = [int]$raw.intervalSec }
    if ($raw.port) { $cfg.port = [int]$raw.port }
  } catch { }
}
if (-not [string]::IsNullOrEmpty($Hotkeys)) { $cfg.hotkeys = @($Hotkeys.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
if ($IntervalSec -gt 0) { $cfg.intervalSec = $IntervalSec }
if ($Port -gt 0) { $cfg.port = $Port }
if ($Port -gt 0) { $cfg.hotkeys = $cfg.hotkeys }  # -Port only pins the target

# ---------------------------------------------------------------- tailscale

function Find-Tailscale {
  $cands = @(
    "$env:ProgramFiles\Tailscale\tailscale.exe",
    "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe",
    "$env:LOCALAPPDATA\Tailscale\tailscale.exe",
    'D:\Program Files\Tailscale\tailscale.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# Returns the port the 443 mount proxies to, or 0 when there is no proxy mount.
# $script:LastServeRaw keeps the raw text: "target parsed as 0 but serve worked" is exactly the
# case that used to be invisible, and it is the only way to tell "no config" from "regex miss".
$script:LastServeRaw = ''
function Get-ServeTarget([string]$tail) {
  $out = & $tail serve status 2>&1 | Out-String
  $script:LastServeRaw = ($out -replace '\s+', ' ').Trim()
  if ($out -match 'proxy\s+http://127\.0\.0\.1:(\d+)') { return [int]$Matches[1] }
  return 0
}

# ---------------------------------------------------------------- DSH port detection

function Test-DshHealth([int]$p) {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$p/plugin-installer/health")
    $req.Timeout = 700
    $req.ReadWriteTimeout = 700
    $req.Proxy = $null
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $sr.ReadToEnd()
    $sr.Close(); $resp.Close()
    # DSH-only signature. A plain 200 is NOT enough (see header note about the Bilibili client).
    return ($body -match '"profileDir"' -or $body -match '"versions"\s*:\s*\{\s*"dsh"')
  } catch { return $false }
}

function Get-ListenerCandidates {
  $list = New-Object System.Collections.Generic.List[object]
  try {
    $conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
  } catch { $conns = @() }
  $seen = @{}
  foreach ($c in $conns) {
    $p = [int]$c.LocalPort
    if ($p -lt 1024) { continue }
    if ($c.LocalAddress -notin @('127.0.0.1', '0.0.0.0', '::1', '::')) { continue }
    if ($seen.ContainsKey($p)) { continue }
    $seen[$p] = $true
    $exe = $null
    $started = [datetime]::MinValue
    try {
      $pr = Get-Process -Id $c.OwningProcess -ErrorAction Stop
      $exe = $pr.Path
      $started = $pr.StartTime
    } catch { }
    $isDsh = $false
    if ($exe) {
      if ($exe -match '\\DSH\\' -or $exe -match 'DeepSeek') { $isDsh = $true }
    }
    $list.Add([pscustomobject]@{ port = $p; exe = $exe; started = $started; isDsh = $isDsh })
  }
  return $list
}

# Order: cached port, then DSH-exe listeners (newest first), then everything else.
function Resolve-DshPort([int]$cached) {
  if ($cached -gt 0 -and (Test-DshHealth $cached)) { return $cached }
  $cands = Get-ListenerCandidates
  $ordered = @()
  $ordered += @($cands | Where-Object { $_.isDsh } | Sort-Object started -Descending)
  $ordered += @($cands | Where-Object { -not $_.isDsh } | Sort-Object port -Descending)
  foreach ($c in $ordered) {
    if (Test-DshHealth $c.port) { return [int]$c.port }
  }
  return 0
}

# ---------------------------------------------------------------- the check

function Invoke-Check([string]$reason, [string]$tail, [int]$cachedPort, [hashtable]$prevState) {
  $result = @{
    ok = $false; reason = $reason; port = 0; target = 0; action = 'none'; error = $null
    tailscale = $tail; at = (Get-Date).ToString('o')
  }
  # Stage tracing: "the check never finished" was invisible in the first version (a hidden task
  # session hung before the one and only log line). One line per stage answers "where" in one look.
  Write-Log 'stage' @{ step = 'check-start'; reason = $reason }
  if ([string]::IsNullOrEmpty($tail) -or -not (Test-Path $tail)) {
    $result.error = 'tailscale.exe not found'
    Write-Log 'error' @{ stage = 'check'; error = $result.error }
    return $result
  }
  $port = $cfg.port
  if ($port -le 0) { $port = Resolve-DshPort $cachedPort }
  Write-Log 'stage' @{ step = 'detected'; port = $port }
  $result.port = $port
  if ($port -le 0) {
    $result.error = 'no live DSH GUI port found'
    Write-Log 'error' @{ stage = 'detect'; error = $result.error }
    return $result
  }
  $target = 0
  try { $target = Get-ServeTarget $tail } catch { $result.error = 'serve status failed: ' + $_.Exception.Message }
  Write-Log 'stage' @{ step = 'status'; target = $target }
  $result.target = $target
  if ($target -eq $port) {
    $result.ok = $true
    $result.action = 'already-correct'
  } else {
    try {
      $out = & $tail serve --bg --https=443 "http://127.0.0.1:$port" 2>&1 | Out-String
      Start-Sleep -Milliseconds 400
      $after = Get-ServeTarget $tail
      $result.target = $after
      if ($after -eq $port) {
        $result.ok = $true
        $result.action = 'repointed'
      } else {
        $result.action = 'repoint-failed'
        $result.error = 'serve did not take effect: ' + ($out -replace '\s+', ' ').Trim()
      }
    } catch {
      $result.action = 'repoint-failed'
      $result.error = $_.Exception.Message
    }
  }
  Write-Log 'check' @{ reason = $reason; port = $port; target = $result.target; action = $result.action; ok = $result.ok; error = $result.error; raw = $script:LastServeRaw }
  return $result
}

# ---------------------------------------------------------------- modes that do not loop

if ($StatusOnly) {
  $st = Read-State
  if ($st) { $st | ConvertTo-Json -Depth 6 } else { '{"state":"none"}' }
  if (Test-Path $LogPath) {
    $tailLines = Get-Content $LogPath -ErrorAction SilentlyContinue | Select-Object -Last 8
    if ($tailLines) { '--- log tail ---'; $tailLines }
  }
  exit 0
}

# ---------------------------------------------------------------- hotkey plumbing

if (-not ('DshServeHotkey' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class DshServeHotkey {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
  [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public const int WM_HOTKEY = 0x0312;
  public const uint PM_REMOVE = 0x0001;
  public const uint MOD_ALT = 0x0001, MOD_CONTROL = 0x0002, MOD_SHIFT = 0x0004, MOD_WIN = 0x0008;
  public const uint MOD_NOREPEAT = 0x4000;

  [StructLayout(LayoutKind.Sequential)] public struct MSG {
    public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
    public uint time; public int ptX; public int ptY; public uint lPrivate;
  }

  public static int ResolveVk(string n) {
    n = n.Trim().ToLowerInvariant();
    if (n.Length == 1) {
      char c = char.ToUpperInvariant(n[0]);
      if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')) return (int)c;
    }
    if (n.Length >= 2 && n[0] == 'f') {
      int num;
      if (int.TryParse(n.Substring(1), out num) && num >= 1 && num <= 24) return 0x6F + num;
    }
    switch (n) {
      case "space": return 0x20;
      case "printscreen": return 0x2C;
      case "insert": return 0x2D;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pagedown": return 0x22;
      case "pageup": return 0x21;
      case "delete": return 0x2E;
      case "tab": return 0x09;
      default: return 0;
    }
  }

  // Returns the WM_HOTKEY count seen since the last call. The whole message pump lives in C#;
  // PowerShell only calls this and handles the returned count (no re-entrant runspace use).
  public static int Pump() {
    int fired = 0;
    MSG msg;
    while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_HOTKEY) fired++;
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
    return fired;
  }
}
"@
}

function Register-Candidates([string[]]$chords) {
  $registered = @()
  $next = 1
  foreach ($chord in $chords) {
    if ([string]::IsNullOrWhiteSpace($chord)) { continue }
    $mods = 0; $vk = 0; $bad = ''
    foreach ($tokRaw in $chord.Split('+')) {
      $tok = $tokRaw.Trim().ToLowerInvariant()
      if ($tok.Length -eq 0) { continue }
      if ($tok -eq 'ctrl' -or $tok -eq 'control') { $mods = $mods -bor 0x0002 }
      elseif ($tok -eq 'alt') { $mods = $mods -bor 0x0001 }
      elseif ($tok -eq 'shift') { $mods = $mods -bor 0x0004 }
      elseif ($tok -eq 'win' -or $tok -eq 'meta') { $mods = $mods -bor 0x0008 }
      else { $v = [DshServeHotkey]::ResolveVk($tok); if ($v -eq 0) { $bad = $tok } else { $vk = $v } }
    }
    if ($bad -ne '' -or $vk -eq 0) {
      Write-Log 'hotkey' @{ stage = 'parse'; key = $chord; ok = $false; error = 'unsupported token: ' + $bad }
      continue
    }
    $id = $next; $next++
    if ([DshServeHotkey]::RegisterHotKey([IntPtr]::Zero, $id, [uint32]($mods -bor 0x4000), [uint32]$vk)) {
      $registered += [pscustomobject]@{ key = $chord; id = $id }
      Write-Log 'hotkey' @{ stage = 'register'; key = $chord; ok = $true; id = $id }
      break
    }
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Log 'hotkey' @{ stage = 'register'; key = $chord; ok = $false; win32 = $code }
  }
  return $registered
}

# ---------------------------------------------------------------- run

$tail = Find-Tailscale
$prev = Read-State
$cached = 0
if ($prev -and $prev.port) { $cached = [int]$prev.port }

if ($Once) {
  $r = Invoke-Check 'once' $tail $cached $null
  $r | ConvertTo-Json -Depth 6
  Save-State @{ mode = 'once'; ok = $r.ok; port = $r.port; target = $r.target; action = $r.action; error = $r.error; hotkey = $null; pid = $PID }
  if ($r.ok) { exit 0 } else { exit 1 }
}

$hk = @(Register-Candidates $cfg.hotkeys)
$tid = [DshServeHotkey]::GetCurrentThreadId()
Write-Log 'start' @{ hotkeys = @($hk | ForEach-Object { $_.key }); thread = $tid; intervalSec = $cfg.intervalSec; tailscale = $tail }
Trim-Log

$state = @{
  mode = 'daemon'; pid = $PID; startedAt = (Get-Date).ToString('o'); thread = $tid
  # NOTE the @() above: Register-Candidates returns ONE object for one chord, and a bare
  # PSCustomObject has no .Count, so `$hk.Count -gt 0` was silently false -> hotkey:null in state.
  hotkey = $(if ($hk.Count -gt 0) { $hk[0].key } else { $null })
  hotkeys = @($hk | ForEach-Object { $_.key })
  intervalSec = $cfg.intervalSec; ok = $false; port = 0; target = 0; action = 'none'; error = $null
  checks = 0; heals = 0
}
Save-State $state

if ($SelfTest) {
  if ($hk.Count -eq 0) { Write-Log 'selftest' @{ ok = $false; error = 'no hotkey registered' }; 'selftest FAILED: no hotkey'; exit 2 }
  [void][DshServeHotkey]::PostThreadMessage($tid, 0x0312, [IntPtr]$hk[0].id, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 300
  $fired = [DshServeHotkey]::Pump()
  Write-Log 'selftest' @{ ok = ($fired -gt 0); fired = $fired }
  'selftest fired=' + $fired
  foreach ($h in $hk) { [void][DshServeHotkey]::UnregisterHotKey([IntPtr]::Zero, $h.id) }
  # do not leave a "daemon that never checked" state behind for the next StatusOnly reader
  $state.mode = 'selftest'
  $state.selftest = @{ fired = $fired; ok = ($fired -gt 0) }
  Save-State $state
  if ($fired -gt 0) { exit 0 } else { exit 2 }
}

$started = Get-Date
$lastCheck = [datetime]::MinValue
$running = $true

try {
  # first check immediately: after a DSH restart this heals without waiting a full interval
  while ($running) {
    $fired = 0
    try { $fired = [DshServeHotkey]::Pump() } catch { }
    $due = ((Get-Date) - $lastCheck).TotalSeconds -ge $cfg.intervalSec
    if ($fired -gt 0 -or $due) {
      $reason = 'timer'
      if ($fired -gt 0) { $reason = 'hotkey' }
      $r = Invoke-Check $reason $tail $cached $null
      $lastCheck = Get-Date
      if ($r.port -gt 0) { $cached = [int]$r.port }
      $state.checks = [int]$state.checks + 1
      if ($r.action -eq 'repointed') { $state.heals = [int]$state.heals + 1 }
      $state.ok = $r.ok; $state.port = $r.port; $state.target = $r.target
      $state.action = $r.action; $state.error = $r.error; $state.lastCheck = $r.at
      $state.lastReason = $reason
      Save-State $state
      Trim-Log
    }
    if ($MaxMinutes -gt 0 -and ((Get-Date) - $started).TotalMinutes -gt $MaxMinutes) { $running = $false }
    Start-Sleep -Milliseconds 180
  }
} finally {
  foreach ($h in $hk) { try { [void][DshServeHotkey]::UnregisterHotKey([IntPtr]::Zero, $h.id) } catch { } }
  Write-Log 'stop' @{ reason = 'exit' }
  $state.mode = 'stopped'
  Save-State $state
}
