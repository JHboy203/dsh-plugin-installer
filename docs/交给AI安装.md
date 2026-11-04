# 交给 AI：安装 dsh-plugin-installer v0.18.1

> 这份文件是写给**AI 助手**看的（也可以直接把这个文件的内容贴进对话）。
> 人类用户请关掉它，去看同目录的 `02 使用手册（先看这个）.docx`。

## 你要装什么

`dsh-plugin-installer` —— DSH（DeepSeek Harness）的「插件 / Skill 安装面板」，
纯 Node/ESM 的宿主插件 + 一个 Web 客户端 bundle（侧栏入口，文案「插件安装」）。
它自己不需要 Python、ffmpeg、Node 之外的任何东西；Node 由 DSH 自带。

- 包名 / 版本：`dsh-plugin-installer` / `0.18.1`
- 版本区间要求：`engines.dsh` = `>=0.2.1-rc.1 <0.3.0`（DSH 0.2.1 及以上、0.3.0 以下）
- 安装包内容：`install.ps1`（安装器）、`payload/`（插件运行期文件）、`uninstall.ps1`、`install.cmd`、`INSTALL-README.txt`
- 同目录另有：`*.tgz`（npm 风格包，`package/` 前缀）

## 硬约束（先看这三条，违反会把人机器搞坏）

1. **绝对不要用 `pnpm` / `npm` 装这个插件。** 那样会在 profile 里塞一份
   `@deepseek-ai/dsh-tools`，它按模块身份遮蔽宿主自带的那份，之后**每个工具调用都报
   `Cannot read properties of undefined (reading 'prepare')`**，看起来像整个 DSH 坏了。
   本包的安装路径只有两种：跑安装器，或者「直连安装」（复制目录 + 建 junction + 改 profile 的 JSON）。
2. **不要点 DSH 恢复对话框里的「禁用第三方插件并重启」。** 它会把
   `dsh.profile.bundles` 从几十项裁到 2 项，等于清空用户的插件清单。要恢复得手动写回。
3. **装完必须让用户「完全退出」DSH 再打开**（含托盘）。只关窗口不算退出；
   插件是宿主启动时加载的，热重载对 client bundle 无效。

## 首选：让用户自己双击安装包

`01 安装（双击这个）.exe`（= `dsh-plugin-installer-0.18.1-setup.exe`）就是自解压安装器：
它会自己找 profile、拷文件、建 junction、写 profile 的 `package.json`（写前备份）、体检环境。
**这条路最稳，你不需要动手。**
你只需要告诉用户三件事：双击 → 看到「安装完成！」按回车 → 完全退出 DSH 再打开。
（如果他那边被 SmartScreen 拦了：点「更多信息」→「仍要运行」；或者改走解压后的 `install.cmd`。）

## 备选：你来直连安装（等价于 install.ps1 做的事）

适用于：用户的 exe 被安全软件拦了、或者他让你「你直接装」。

前提：先确认 `<工作区>\.dsh\profiles\desktop` 存在且里面有 `package.json`（含 `dsh.profile` 字段）。

步骤（Windows PowerShell，把 `<工作区>` 换成真实路径；**不要**用 pnpm）：

```powershell
$profileDir = '<工作区>\.dsh\profiles\desktop'
$name       = 'dsh-plugin-installer'
$copyDir    = Join-Path $profileDir ('dsh-plugins\' + $name)
$linkPath   = Join-Path $profileDir ('node_modules\' + $name)

# 1) 解压 tgz → payload 目录（tgz 里是 package/ 前缀）
#    tar.exe 是 Windows 自带的；也可以用解压软件手动解
New-Item -ItemType Directory -Force -Path $copyDir | Out-Null
tar -xzf '<包所在的绝对路径>\dsh-plugin-installer-0.18.1.tgz' -C $copyDir --strip-components=1

# 2) 建目录联接（不需要管理员）
if (Test-Path $linkPath) { cmd /c rmdir "$linkPath" }
New-Item -ItemType Junction -Path $linkPath -Target $copyDir | Out-Null

# 3) 改 profile 的 package.json：dependencies + dsh.profile.bundles
#    ⚠️ 必须写成 UTF-8 **无 BOM**（带 BOM 时 Node 的 JSON.parse 直接抛）；改前先备份
Copy-Item (Join-Path $profileDir 'package.json') (Join-Path $profileDir ('package.json.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))) -Force
$json = Get-Content (Join-Path $profileDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $json.dsh.profile.bundles) { $json.dsh.profile.bundles = @() }
if (@($json.dsh.profile.bundles) -notcontains $name) { $json.dsh.profile.bundles = @($json.dsh.profile.bundles) + $name }
$json.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue ('link:' + ($copyDir -replace '\\','/')) -Force
[IO.File]::WriteAllText((Join-Path $profileDir 'package.json'), ($json | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding $false))
```

然后**让用户完全退出 DSH 再打开**（你没法替他重启，也不该去杀他的进程）。

> 也可以用安装器脚本本身当命令行工具：
> `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ProfilePath "<profile 目录>" -AutoEnv`
> —— 它做的事和上面完全一致，而且会自己备份、自己体检。**优先用它，别手搓。**

## 装完怎么验（请把结论原样告诉用户）

1. `<profile>\package.json` 的 `dependencies["dsh-plugin-installer"]` 是 `link:` 开头，
   且 `dsh.profile.bundles` 里有这个包名。
2. `<profile>\node_modules\dsh-plugin-installer` 存在，且 `(Get-Item -Force).RealPath`（或
   `fs.realpathSync`）指向 `<profile>\dsh-plugins\dsh-plugin-installer`。
   ⚠️ **Windows 的 junction 在 `lstat` 里不是 symlink**（`isSymbolicLink()` 为 false、`readlink` 抛
   `EINVAL`）—— 只能用 `realpath` 判断。
3. 用户重启后：侧栏出现「插件安装」图标；点开是「插件 / Skill 安装」面板，标题旁有版本号。
4. 顺手让用户按一次 `Ctrl+Alt+D`：这是插件自带的环境自检（任意页面生效），
   浮窗会直接说「现在重启安不安全」「有没有 dsh-tools 覆盖」。

如果宿主已经就绪（用户是**升级**安装），也可以直接用 DSH 自己的工具：
`install_hub_status` 看现状 → `install_hub_submit_request({input:"<tgz 绝对路径>"})`。
⚠️ 但这套工具**只有已经装了这个插件的机器才有**，全新安装时用不了。

## 出问题时读哪里

- 桌面：`dsh-plugin-installer-安装日志.txt` —— 安装器那一次的完整流水账。
- `03 出问题\收集报错信息（双击）.cmd` —— 一键收集环境 + 日志成一个 txt（只读，不改配置）。
  让用户双击它，然后把桌面生成的 `DSH插件安装-报错信息-*.txt` 发回来。
- 已知「整批插件加载失败」的签名：`does not provide an export named 'CallId'` /
  `Cannot read properties of undefined (reading 'prepare')` → 99% 是 profile 里多了一份
  `@deepseek-ai/dsh-tools`。把 `<profile>\node_modules\@deepseek-ai\dsh-tools` 改名挪走即可
  （**不要**用 pnpm 重装去"修复"）。

## 不要做的事（再列一遍）

- 不要 `pnpm install` / `pnpm add` / `npm i` 来装它或「修复」它。
- 不要编辑 `cordis.patch.yml` 去手工挂它 —— 这个包的 `dsh.bundle.patch` 已经指向自己的 patch 文件，
  正确做法是登记进 `dsh.profile.bundles`。
- 不要把 `payload/` 里的文件直接丢进 `node_modules` 当普通目录（那样升级会丢、也不符合 pod 约定）。
- 不要替用户重启或杀进程；告诉他怎么退（托盘右键退出 / 任务管理器结束 `DeepSeek Harness`）。
