# DSH 插件安装面板 · 报错信息收集器（只读）
#
# 它做什么：把「要定位问题需要的那些事实」收集成**一个 txt**，放到桌面。
# 它不做什么：不联网、不改任何配置、不需要管理员、不删东西。
#
# 用法（给用户看的）：
#   双击同目录的「收集报错信息（双击）.cmd」，等 10~30 秒，桌面会多一个 txt。
#
# 用法（给 AI 看的）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File collect-diagnostics.ps1
#   可选：-Out <输出文件路径>  -NoPause

param(
	[string]$Out = '',
	[switch]$NoPause
)

$ErrorActionPreference = 'Continue'
$script:Lines = New-Object System.Collections.ArrayList
$script:Stamp = (Get-Date)
$script:PluginName = 'dsh-plugin-installer'
$script:CollectorVer = '1.0'

function L([string]$text) { [void]$script:Lines.Add([string]$text) }
function Section([string]$title) {
	L ''
	L ('──────── ' + $title + ' ────────')
}
function TryRead([string]$path, [int]$maxLines = 400) {
	if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
	try {
		$fi = Get-Item -LiteralPath $path -Force
		if ($fi.PSIsContainer) { return $null }
		if ($fi.Length -gt 8MB) { return '(文件超过 8MB，跳过：' + $path + ')' }
		$all = @(Get-Content -LiteralPath $path -Encoding UTF8 -ErrorAction Stop)
		if ($all.Count -gt $maxLines) {
			return ('(只保留最后 ' + $maxLines + ' 行，共 ' + $all.Count + ' 行)' + "`r`n" + (($all[($all.Count - $maxLines)..($all.Count - 1)]) -join "`r`n"))
		}
		return ($all -join "`r`n")
	} catch {
		return '(读不了：' + $_.Exception.Message + ')'
	}
}
function TryTail([string]$path, [int]$n = 80) {
	if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
	try { return (@(Get-Content -LiteralPath $path -Tail $n -Encoding UTF8 -ErrorAction Stop) -join "`r`n") } catch { return '(读不了：' + $_.Exception.Message + ')' }
}

# ── profile 定位（与安装器同一套候选，找不到就扫两层盘）───────────────────────
function Get-ProfileInfo([string]$dir) {
	$pkg = Join-Path $dir 'package.json'
	if (-not (Test-Path -LiteralPath $pkg)) { return $null }
	try { $json = Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
	if (-not $json.dsh -or -not $json.dsh.profile) { return $null }
	return [pscustomobject]@{ Dir = $dir; Pkg = $pkg; Json = $json; Name = (Split-Path $dir -Leaf) }
}
function Add-ProfileDir($list, $seen, [string]$profilesDir) {
	if (-not (Test-Path -LiteralPath $profilesDir)) { return }
	foreach ($d in @(Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue)) {
		if ($seen.ContainsKey($d.FullName)) { continue }
		$info = Get-ProfileInfo $d.FullName
		if ($info) { $seen[$d.FullName] = $true; [void]$list.Add($info) }
	}
}
function Find-Profiles {
	$found = New-Object System.Collections.ArrayList
	$seen = @{}
	$cands = New-Object System.Collections.ArrayList
	if ($env:DSH_PROFILE) { [void]$cands.Add((Join-Path $env:DSH_PROFILE 'profiles')) }
	$p = $PSScriptRoot
	for ($i = 0; $i -lt 8 -and $p; $i++) {
		[void]$cands.Add((Join-Path $p '.dsh\profiles'))
		$parent = Split-Path $p -Parent
		if (-not $parent -or $parent -eq $p) { break }
		$p = $parent
	}
	foreach ($r in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA)) {
		if (-not $r) { continue }
		[void]$cands.Add((Join-Path $r '.dsh\profiles'))
		[void]$cands.Add((Join-Path $r 'dsh\profiles'))
	}
	foreach ($c in $cands) { Add-ProfileDir $found $seen $c }
	if ($found.Count -eq 0) {
		$skip = @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin',
			'System Volume Information', 'Recovery', 'PerfLogs', 'node_modules')
		foreach ($drv in @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
			if (-not $drv.Root) { continue }
			foreach ($a in @(Get-ChildItem -LiteralPath $drv.Root -Directory -ErrorAction SilentlyContinue)) {
				if ($skip -contains $a.Name -or $a.Name.StartsWith('.')) { continue }
				foreach ($b in @(Get-ChildItem -LiteralPath $a.FullName -Directory -ErrorAction SilentlyContinue)) {
					Add-ProfileDir $found $seen (Join-Path $b.FullName '.dsh\profiles')
				}
			}
		}
	}
	return , $found
}

# ── DSH 本体：进程 / 版本 / 安装位置 ─────────────────────────────────────────
function Get-DshFacts {
	$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
		$_.ProcessName -eq 'DeepSeek Harness' -or $_.ProcessName -eq 'DSH' -or $_.ProcessName -eq 'dsh'
	})
	$exe = ''
	if ($procs.Count -gt 0) {
		foreach ($pr in $procs) {
			try { if ($pr.Path -and (Test-Path -LiteralPath $pr.Path)) { $exe = $pr.Path; break } } catch { }
		}
	}
	if (-not $exe) {
		$roots = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}, 'D:\', 'C:\', 'E:\')
		$tails = @('DSH\DeepSeek Harness.exe', 'DeepSeek Harness\DeepSeek Harness.exe',
			'Programs\DSH\DeepSeek Harness.exe', 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
		foreach ($r in $roots) {
			if (-not $r) { continue }
			foreach ($t in $tails) {
				$c = Join-Path $r $t
				if (Test-Path -LiteralPath $c) { $exe = $c; break }
			}
			if ($exe) { break }
		}
	}
	if (-not $exe) {
		try {
			foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
					'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
				$hit = Get-ItemProperty $key -ErrorAction SilentlyContinue |
					Where-Object { $_.DisplayName -like '*Harness*' -or $_.DisplayName -like '*DSH*' } |
					Select-Object -First 1
				if ($hit -and $hit.InstallLocation) {
					$c = Join-Path $hit.InstallLocation 'DeepSeek Harness.exe'
					if (Test-Path -LiteralPath $c) { $exe = $c; break }
				}
			}
		} catch { }
	}
	$ver = ''
	if ($exe) { try { $ver = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion } catch { } }
	return [pscustomobject]@{ Procs = $procs; Exe = $exe; Version = $ver }
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
$desk = [Environment]::GetFolderPath('Desktop')
if (-not $Out) {
	if ($desk -and (Test-Path -LiteralPath $desk)) {
		$Out = Join-Path $desk ('DSH插件安装-报错信息-' + $script:Stamp.ToString('yyyyMMdd-HHmmss') + '.txt')
	} else {
		$dir = Join-Path $env:LOCALAPPDATA 'DSH-plugin-installer-diag'
		New-Item -ItemType Directory -Force -Path $dir | Out-Null
		$Out = Join-Path $dir ('DSH插件安装-报错信息-' + $script:Stamp.ToString('yyyyMMdd-HHmmss') + '.txt')
	}
}

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  DSH 插件安装面板 · 报错信息收集' -ForegroundColor Cyan
Write-Host '  （只读：不改你的任何设置，不联网）' -ForegroundColor DarkGray
Write-Host '============================================' -ForegroundColor Cyan

# 1) 头
L '================ DSH 插件安装面板 · 报错信息 ================'
L ('生成时间 : ' + $script:Stamp.ToString('yyyy-MM-dd HH:mm:ss'))
L ('收集器   : v' + $script:CollectorVer)
L ''
L '【怎么用这个文件】'
L '  1. 在下面的「用户描述」里补两句人话（想做什么 + 看到什么），也可以不写。'
L '  2. 把整个文件发出去：拖进 DSH 的对话框，或者发给帮你装插件的人。'
L '  3. 文件里可能有你的提问片段（在最后的日志尾巴里），发之前可以自己扫一眼、删掉敏感行。'
L '  4. 除敏感内容外，请别修改、别截断其它部分。'
L ''
L '【用户描述】（请在这里补一句，没有就留空）'
L '  我想做什么：'
L '  我看到了什么：'

# 2) 本机
Section '1. 这台电脑'
try {
	L ('Windows  : ' + [Environment]::OSVersion.VersionString)
	L ('计算机名 : ' + $env:COMPUTERNAME)
	L ('用户名   : ' + $env:USERNAME)
	L ('系统语言 : ' + (Get-Culture).Name)
	L ('PowerShell: ' + $PSVersionTable.PSVersion.ToString())
	$isAdmin = $false
	try {
		$id = [Security.Principal.WindowsIdentity]::GetCurrent()
		$pr = New-Object Security.Principal.WindowsPrincipal($id)
		$isAdmin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
	} catch { }
	L ('管理员   : ' + $isAdmin)
} catch { L ('(读取失败：' + $_.Exception.Message + ')') }

# 3) DSH
Section '2. DSH 本体'
$dsh = Get-DshFacts
try {
	L ('进程数   : ' + $dsh.Procs.Count)
	foreach ($pr in $dsh.Procs) {
		$pp = ''
		try { $pp = $pr.Path } catch { }
		L ('  · PID ' + $pr.Id + '  ' + $pr.ProcessName + '  ' + $pp)
	}
	if ($dsh.Exe) {
		L ('程序路径 : ' + $dsh.Exe)
		L ('文件版本 : ' + $dsh.Version + '   ← 这个插件要求 0.2.1 及以上、0.3.0 以下')
	} else {
		L '程序路径 : (没找到，可能装在非常规位置)'
	}
} catch { L ('(读取失败：' + $_.Exception.Message + ')') }

# 4) 工作区 / profile
Section '3. DSH 工作区与 profile'
$profiles = Find-Profiles
L ('找到 profile：' + $profiles.Count + ' 个')
$primary = $null
if ($profiles.Count -gt 0) {
	$primary = @($profiles | Where-Object { $_.Name -eq 'desktop' })[0]
	if (-not $primary) { $primary = $profiles[0] }
}
foreach ($pf in $profiles) {
	L ''
	L ('— profile：' + $pf.Dir)
	try {
		$bundles = @()
		if ($pf.Json.dsh.profile.bundles) { $bundles = @($pf.Json.dsh.profile.bundles) }
		L ('  bundles 条数 : ' + $bundles.Count + $(if ($bundles.Count -lt 5) { '   ← 少于 5 项，可能是被恢复对话框裁过' } else { '' }))
		$dep = ''
		try { if ($pf.Json.dependencies.$script:PluginName) { $dep = [string]$pf.Json.dependencies.$script:PluginName } } catch { }
		L ('  本插件依赖  : ' + $(if ($dep) { $dep } else { '(没有登记)' }))
		$listed = ($bundles -contains $script:PluginName)
		L ('  本插件在 bundles : ' + $listed)
		# 带 BOM 的 package.json 会让 Node 直接读不出来
		try {
			$bytes = [IO.File]::ReadAllBytes($pf.Pkg)
			L ('  package.json : ' + $bytes.Length + ' 字节 · BOM=' + ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF))
		} catch { }
		# 已知坑：profile 里多一份 dsh-tools
		$poll = Join-Path $pf.Dir 'node_modules\@deepseek-ai\dsh-tools'
		L ('  dsh-tools 覆盖 : ' + (Test-Path -LiteralPath $poll) + $(if (Test-Path -LiteralPath $poll) { '   ← 这个会导致"每个工具都报 prepare undefined"' } else { '' }))
		# 本插件落地形态
		$copy = Join-Path $pf.Dir ('dsh-plugins\' + $script:PluginName)
		$link = Join-Path $pf.Dir ('node_modules\' + $script:PluginName)
		if (Test-Path -LiteralPath $copy) {
			$n = @(Get-ChildItem -LiteralPath $copy -Recurse -File -ErrorAction SilentlyContinue).Count
			$ver = ''
			try { $ver = (Get-Content -LiteralPath (Join-Path $copy 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
			L ('  插件文件 : 在（' + $n + ' 个文件，版本 ' + $ver + '）')
		} else { L '  插件文件 : 不在 dsh-plugins 下（可能是别的安装方式）' }
		if (Test-Path -LiteralPath $link) {
			$it = Get-Item -LiteralPath $link -Force
			$tgt = ''
			try { $tgt = (@($it.Target) -join ',') } catch { }
			$resolves = Test-Path -LiteralPath (Join-Path $link 'package.json')
			L ('  node_modules 链接 : 在 · 类型=' + $it.LinkType + ' · 目标=' + $(if ($tgt) { $tgt } else { '?' }) + ' · 能解析=' + $resolves)
		} else { L '  node_modules 链接 : 不在（DSH 找不到这个包）' }
		# 数据目录（只列名字与大小，不读内容：里面可能有自定义来源与本机路径）
		$dataDir = Join-Path $copy 'data'
		if (Test-Path -LiteralPath $dataDir) {
			$names = @(Get-ChildItem -LiteralPath $dataDir -ErrorAction SilentlyContinue | ForEach-Object {
				$_.Name + $(if ($_.PSIsContainer) { '\' } else { ' (' + $_.Length + 'B)' })
			})
			L ('  data\ : ' + ($names -join ' | '))
		}
		# 历史备份（说明改过什么）
		$bak = @(Get-ChildItem -LiteralPath $pf.Dir -Filter 'package.json.bak*' -ErrorAction SilentlyContinue).Count
		$patchBak = @(Get-ChildItem -LiteralPath $pf.Dir -Filter 'cordis.patch.yml.bak*' -ErrorAction SilentlyContinue).Count
		L ('  历史备份 : package.json.bak* ' + $bak + ' 个 · cordis.patch.yml.bak* ' + $patchBak + ' 个')
	} catch { L ('  (读取失败：' + $_.Exception.Message + ')') }
}
if ($profiles.Count -eq 0) {
	L ''
	L '（一个 profile 都没找到。如果 DSH 确实装了，请在「设置」里看一下工作区在哪。）'
}

# 5) 安装日志
Section '4. 安装日志（桌面）'
$logName = $script:PluginName + '-安装日志.txt'
$logPath = ''
if ($desk -and (Test-Path -LiteralPath $desk)) { $logPath = Join-Path $desk $logName }
if ($logPath -and (Test-Path -LiteralPath $logPath)) {
	L ('文件：' + $logPath)
	L ''
	$txt = TryRead $logPath 500
	L $txt
} else {
	L ('没找到 ' + $logName + '（可能还没跑过安装器，或者桌面路径被重定向了）')
	$alt = Join-Path $env:LOCALAPPDATA ($script:PluginName + '\安装日志.txt')
	if (Test-Path -LiteralPath $alt) { L ('另找到：' + $alt); L (TryRead $alt 500) }
}

# 6) DSH 自己的日志（能找到才写，只取尾巴）
Section '5. DSH 日志尾巴（可能有你的提问片段）'
$logDirs = New-Object System.Collections.ArrayList
foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
	if (-not $base) { continue }
	foreach ($sub in @('DSH Desktop\logs', 'DSH Desktop Beta\logs', 'dsh\logs', 'DSH\logs')) {
		$d = Join-Path $base $sub
		if (Test-Path -LiteralPath $d) { [void]$logDirs.Add($d) }
	}
}
foreach ($b in @($env:APPDATA)) {
	if (-not $b) { continue }
	foreach ($d in @(Get-ChildItem -LiteralPath $b -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*DSH*' -or $_.Name -like '*ds*h*' })) {
		$ld = Join-Path $d.FullName 'logs'
		if (Test-Path -LiteralPath $ld) { [void]$logDirs.Add($ld) }
	}
}
# 工作区自己的 .dsh\logs（新版把宿主日志放这儿的情况）
if ($primary) {
	try {
		$ws = Split-Path (Split-Path $primary.Dir -Parent) -Parent
		$ld2 = Join-Path $ws '.dsh\logs'
		if (Test-Path -LiteralPath $ld2) { [void]$logDirs.Add($ld2) }
	} catch { }
}
if ($logDirs.Count -eq 0) {
	L '（没找到 DSH 的日志目录 —— 不同版本位置不一样，不影响定位）'
} else {
	foreach ($d in @($logDirs | Select-Object -Unique)) {
		L ''
		L ('— 目录：' + $d)
		$err = @(Get-ChildItem -LiteralPath $d -Filter '*.error.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
		$all = @(Get-ChildItem -LiteralPath $d -Filter '*.log' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*.error.log' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
		if ($err.Count -gt 0) {
			$age = ((Get-Date) - $err[0].LastWriteTime).TotalDays
			L ('  最近 error.log：' + $err[0].Name + '（' + $err[0].LastWriteTime.ToString('yyyy-MM-dd HH:mm') + '）' + $(if ($age -gt 7) { '   ← 不是最近写的，可能来自旧版 DSH' } else { '' }))
			$t = TryTail $err[0].FullName 60
			if ($t) { L ((($t -split "`n") | ForEach-Object { '    ' + $_ }) -join "`r`n") }
		} else { L '  没有 *.error.log' }
		if ($all.Count -gt 0) {
			$age2 = ((Get-Date) - $all[0].LastWriteTime).TotalDays
			L ('  最近 log：' + $all[0].Name + '（' + $all[0].LastWriteTime.ToString('yyyy-MM-dd HH:mm') + '）' + $(if ($age2 -gt 7) { '   ← 不是最近写的，可能来自旧版 DSH' } else { '' }))
			$t2 = TryTail $all[0].FullName 60
			if ($t2) { L ((($t2 -split "`n") | ForEach-Object { '    ' + $_ }) -join "`r`n") }
		} else { L '  没有 *.log' }
	}
}

# 7) 环境与本机上容易埋雷的东西
Section '6. 环境（与本插件相关）'
try {
	L ('PATH 里的 node : ' + (@(Get-Command node -ErrorAction SilentlyContinue).Source -join ', '))
	L ('PATH 里的 npm  : ' + (@(Get-Command npm -ErrorAction SilentlyContinue).Source -join ', '))
	L ('PATH 里的 pnpm : ' + (@(Get-Command pnpm -ErrorAction SilentlyContinue).Source -join ', ') + '   ← 有它不代表要用它；本插件绝不走 pnpm')
	L ('PATH 里的 tar  : ' + (@(Get-Command tar -ErrorAction SilentlyContinue).Source -join ', ') + '   ← 解压 .tgz 用它（Windows 10 1803+ 自带）')
	L ('PATH 里的 7z   : ' + (@(Get-Command 7z -ErrorAction SilentlyContinue).Source -join ', '))
} catch { L ('(读取失败：' + $_.Exception.Message + ')') }

# 8) 收尾
Section '7. 结束'
L ('收集完成于：' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
L ''
L '（这份文件由 dsh-plugin-installer 的只读收集器生成：不联网、不改配置、不需要管理员。）'

try {
	$enc = New-Object System.Text.UTF8Encoding($true)
	[IO.File]::WriteAllText($Out, ($script:Lines -join "`r`n"), $enc)
} catch {
	Write-Host ('[X] 写文件失败：' + $_.Exception.Message) -ForegroundColor Red
	if (-not $NoPause) { Read-Host '按回车关闭' | Out-Null }
	exit 1
}

Write-Host ''
Write-Host '  ✅ 收集完成' -ForegroundColor Green
Write-Host ('     文件在：' + $Out) -ForegroundColor Cyan
Write-Host ''
Write-Host '  下一步：把这个 txt 发出去（拖进 DSH 对话框 / 发给帮你装的人）。' -ForegroundColor Yellow
Write-Host '  发之前可以先打开看一眼，删掉你不想给别人看的行。' -ForegroundColor DarkGray
Write-Host ''
if (-not $NoPause) { Read-Host '按回车关闭' | Out-Null }
exit 0
