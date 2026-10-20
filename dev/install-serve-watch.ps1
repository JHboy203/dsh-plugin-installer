# install-serve-watch.ps1 - register (or remove) the logon task that keeps ts.net pointed at DSH.
#
# Needs Administrator: `tailscale serve` talks to an admin-only named pipe, so the watcher itself
# must run elevated. A logon task with RunLevel Highest gives that WITHOUT a UAC click at logon.
#
#   powershell -ExecutionPolicy Bypass -File install-serve-watch.ps1
#   powershell -ExecutionPolicy Bypass -File install-serve-watch.ps1 -Remove
#   powershell -ExecutionPolicy Bypass -File install-serve-watch.ps1 -Hotkeys "ctrl+alt+y|ctrl+alt+g"
#   powershell -ExecutionPolicy Bypass -File install-serve-watch.ps1 -ProbeOnly
#
# ASCII only (Windows PowerShell 5.1 reads BOM-less files as GBK).

param(
  [string]$TaskName = 'DshServeWatch',
  [string]$Hotkeys = '',
  [int]$IntervalSec = 0,
  [switch]$Remove,
  [switch]$StatusOnly,
  [switch]$ProbeOnly
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Watcher = Join-Path $ScriptDir 'serve-watch.ps1'
$ConfigPath = Join-Path $ScriptDir 'serve-watch.config.json'
$StatePath = Join-Path $ScriptDir 'serve-watch.state.json'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Self-Elevate {
  # Relaunch elevated and keep this console quiet. ConsentPromptBehaviorAdmin=0 on this box means
  # this happens silently; on a normal box the user sees one UAC prompt.
  # NOTE: $PSCommandPath (script scope), not $MyInvocation.MyCommand.Path - inside a function the
  # latter resolves to the function, and its .Path is empty -> only `powershell.exe` would launch.
  $arg = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
  if (-not [string]::IsNullOrEmpty($Hotkeys)) { $arg += ' -Hotkeys "{0}"' -f $Hotkeys }
  if ($IntervalSec -gt 0) { $arg += ' -IntervalSec {0}' -f $IntervalSec }
  if ($Remove) { $arg += ' -Remove' }
  if ($StatusOnly) { $arg += ' -StatusOnly' }
  if ($ProbeOnly) { $arg += ' -ProbeOnly' }
  Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $arg | Out-Null
  exit 0
}

if (-not (Test-Admin)) { Self-Elevate }

if ($StatusOnly) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { 'task: not installed' } else {
    $i = Get-ScheduledTaskInfo -TaskName $TaskName
    'task: installed  state=' + $t.State + '  lastRun=' + $i.LastRunTime + '  lastResult=' + $i.LastTaskResult
  }
  if (Test-Path $StatePath) { '--- state ---'; Get-Content $StatePath -Raw -Encoding UTF8 }
  exit 0
}

if ($Remove) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    'removed task ' + $TaskName
  } else { 'no such task' }
  # also stop a foreground instance started by hand
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*serve-watch.ps1*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; 'killed pid ' + $_.ProcessId } catch { } }
  exit 0
}

if (-not (Test-Path $Watcher)) { throw "watcher not found: $Watcher" }

# config file (only rewritten when the caller asked for a specific key / interval)
if (-not [string]::IsNullOrEmpty($Hotkeys) -or $IntervalSec -gt 0) {
  $cfg = @{ hotkeys = @('ctrl+alt+y', 'ctrl+alt+g', 'alt+shift+t'); intervalSec = 20; port = 0 }
  if (Test-Path $ConfigPath) {
    try {
      $old = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($old.hotkeys) { $cfg.hotkeys = @($old.hotkeys) }
      if ($old.intervalSec) { $cfg.intervalSec = [int]$old.intervalSec }
      if ($old.port) { $cfg.port = [int]$old.port }
    } catch { }
  }
  if (-not [string]::IsNullOrEmpty($Hotkeys)) { $cfg.hotkeys = @($Hotkeys.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  if ($IntervalSec -gt 0) { $cfg.intervalSec = $IntervalSec }
  ($cfg | ConvertTo-Json -Depth 5) | Set-Content -Path $ConfigPath -Encoding UTF8
  'wrote config: ' + $ConfigPath
}

if ($ProbeOnly) {
  # one elevated check without touching the task: proves detection + re-point works
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Watcher -Once
  exit $LASTEXITCODE
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $Watcher)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
# The first check has to scan listeners and shell out to tailscale twice; give it up to ~12s and
# report the state file it wrote (a missing state file is itself the signal that it did not start).
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $StatePath) { break }
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$report = [ordered]@{
  task = $TaskName
  state = (Get-ScheduledTask -TaskName $TaskName).State
  lastResult = $info.LastTaskResult
  watcher = $Watcher
  config = $(if (Test-Path $ConfigPath) { Get-Content $ConfigPath -Raw -Encoding UTF8 } else { '(defaults)' })
  stateFile = $(if (Test-Path $StatePath) { (Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json) } else { $null })
}
$report | ConvertTo-Json -Depth 6
