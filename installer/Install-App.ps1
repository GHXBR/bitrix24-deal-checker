#requires -Version 5.1
<#
.SYNOPSIS
  Установщик «Проверка сделок Битрикс24» для Windows.
  Скачивает приложение с GitHub, по желанию — Node.js, создаёт ярлыки.
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Repo = 'GHXBR/bitrix24-deal-checker'
$Branch = 'main'
$AppName = 'Проверка сделок Битрикс24'
$DefaultDir = Join-Path $env:LOCALAPPDATA 'Bitrix24-Deal-Checker'

function Write-Log([string]$msg) {
  if ($script:logBox -and !$script:logBox.IsDisposed) {
    $script:logBox.AppendText(("[{0}] {1}`r`n" -f (Get-Date -Format 'HH:mm:ss'), $msg))
    $script:logBox.SelectionStart = $script:logBox.TextLength
    $script:logBox.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
  }
}

function Test-NodeInstalled {
  try {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $true }
  } catch {}
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $true } }
  return $false
}

function Get-LatestNodeLtsZipUrl {
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -Headers @{ 'User-Agent' = 'bitrix24-deal-checker-installer' }
  $lts = $index | Where-Object { $_.lts -ne $false -and $_.lts } | Select-Object -First 1
  if (-not $lts) { throw 'Не удалось определить LTS Node.js' }
  $ver = $lts.version
  return @{
    Version = $ver
    Url     = "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip"
  }
}

function Expand-ZipSafe([string]$zip, [string]$dest) {
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Path $dest | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
}

function Install-PortableNode([string]$appDir) {
  Write-Log 'Скачиваю Node.js LTS (portable)...'
  $info = Get-LatestNodeLtsZipUrl
  Write-Log ("Версия Node: {0}" -f $info.Version)
  $tmp = Join-Path $env:TEMP ("node-lts-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'node.zip'
  Invoke-WebRequest -Uri $info.Url -OutFile $zip -UseBasicParsing
  $extract = Join-Path $tmp 'extract'
  Expand-ZipSafe $zip $extract
  $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
  if (-not $inner) { throw 'Архив Node.js пуст' }
  $runtime = Join-Path $appDir 'runtime\node'
  if (Test-Path $runtime) { Remove-Item -Recurse -Force $runtime }
  New-Item -ItemType Directory -Path (Split-Path $runtime) -Force | Out-Null
  Move-Item $inner.FullName $runtime
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  $nodeExe = Join-Path $runtime 'node.exe'
  if (-not (Test-Path $nodeExe)) { throw 'node.exe не найден после распаковки' }
  Write-Log ("Node.js установлен: {0}" -f $nodeExe)
  return $nodeExe
}

function Find-Node([string]$appDir) {
  $portable = Join-Path $appDir 'runtime\node\node.exe'
  if (Test-Path $portable) { return $portable }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($c in @((Join-Path ${env:ProgramFiles} 'nodejs\node.exe'), 'C:\Program Files\nodejs\node.exe')) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

function Get-NpmCmd([string]$nodeExe) {
  $dir = Split-Path -Parent $nodeExe
  $npmCmd = Join-Path $dir 'npm.cmd'
  if (Test-Path $npmCmd) { return $npmCmd }
  return 'npm.cmd'
}

function Get-LocalRepoRoot {
  if (-not $PSScriptRoot) { return $null }
  $candidate = Split-Path -Parent $PSScriptRoot
  if ((Test-Path (Join-Path $candidate 'start.js')) -and (Test-Path (Join-Path $candidate 'package.json'))) {
    return $candidate
  }
  return $null
}

function Save-AppVersionMeta([string]$appDir) {
  try {
    $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers @{
      'User-Agent' = 'bitrix24-deal-checker-installer'
      Accept       = 'application/vnd.github+json'
    }
    $meta = @{
      commit      = [string]$commit.sha
      installedAt = (Get-Date).ToString('o')
      message     = ([string]$commit.commit.message -split "`n")[0]
      date        = [string]$commit.commit.committer.date
    }
    $meta | ConvertTo-Json | Set-Content -Path (Join-Path $appDir '.app-version.json') -Encoding UTF8
    Write-Log ("Версия: {0}" -f $meta.commit.Substring(0, 7))
  } catch {
    Write-Log ("Не удалось записать версию: {0}" -f $_.Exception.Message)
  }
}

function Install-AppFiles([string]$appDir, [string]$sourceDir) {
  New-Item -ItemType Directory -Path $appDir -Force | Out-Null
  $tmp = Join-Path $env:TEMP ("b24-preserve-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp | Out-Null

  $preserve = @('.browser-profile', 'results', 'runtime')
  foreach ($name in $preserve) {
    $src = Join-Path $appDir $name
    if (Test-Path $src) {
      Move-Item $src (Join-Path $tmp $name) -Force
    }
  }

  Get-ChildItem $appDir -Force | Where-Object {
    $_.Name -notin @('.browser-profile', 'results', 'runtime')
  } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  $skip = @('node_modules', '.git', '.browser-profile', 'results', 'runtime', '.update-tmp')
  Get-ChildItem $sourceDir -Force | Where-Object { $_.Name -notin $skip } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $appDir $_.Name) -Recurse -Force
  }

  foreach ($name in $preserve) {
    $bak = Join-Path $tmp $name
    if (Test-Path $bak) {
      $dest = Join-Path $appDir $name
      if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item $bak $dest -Force
    }
  }

  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Save-AppVersionMeta -appDir $appDir
  Write-Log ("Приложение установлено в: {0}" -f $appDir)
}

function Install-AppFromGitHub([string]$appDir) {
  Write-Log 'Скачиваю приложение с GitHub...'
  $tmp = Join-Path $env:TEMP ("b24-deal-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'repo.zip'
  $url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  $extract = Join-Path $tmp 'extract'
  Expand-ZipSafe $zip $extract
  $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
  if (-not $inner) { throw 'Архив репозитория пуст' }

  Install-AppFiles -appDir $appDir -sourceDir $inner.FullName
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

function Build-GuiExe([string]$appDir) {
  $script = Join-Path $appDir 'scripts\build-gui.ps1'
  if (-not (Test-Path $script)) { throw "Не найден $script" }
  Write-Log 'Собираю мини-приложение (exe)...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $script
  if ($LASTEXITCODE -ne 0 -and -not (Test-Path (Join-Path $appDir 'Проверка сделок.exe'))) {
    throw 'Не удалось собрать GUI exe'
  }
  Write-Log 'Мини-приложение готово.'
}

function Install-Dependencies([string]$appDir, [string]$nodeExe) {
  Write-Log 'Ставлю npm-зависимости...'
  $npm = Get-NpmCmd $nodeExe
  $p = Start-Process -FilePath $npm -ArgumentList @('install', '--no-fund', '--no-audit') -WorkingDirectory $appDir -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ne 0) { throw "npm install завершился с кодом $($p.ExitCode)" }

  Write-Log 'Ставлю Chromium для Playwright...'
  $npx = Join-Path (Split-Path $nodeExe) 'npx.cmd'
  if (-not (Test-Path $npx)) { $npx = 'npx.cmd' }
  $p2 = Start-Process -FilePath $npx -ArgumentList @('playwright', 'install', 'chromium') -WorkingDirectory $appDir -Wait -PassThru -NoNewWindow
  if ($p2.ExitCode -ne 0) { Write-Log 'Предупреждение: playwright install chromium вернул ошибку — можно поставить при первом запуске.' }
}

function New-AppShortcut([string]$lnkPath, [string]$target, [string]$workDir) {
  $dir = Split-Path -Parent $lnkPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($lnkPath)
  $s.TargetPath = $target
  $s.WorkingDirectory = $workDir
  $s.WindowStyle = 1
  $s.Description = $AppName
  $s.Save()
}

function Invoke-Install {
  param(
    [string]$AppDir,
    [bool]$WantNode,
    [bool]$WantDesktop,
    [bool]$WantStart,
    [bool]$FromLocal
  )

  $script:installBtn.Enabled = $false
  $script:browseBtn.Enabled = $false
  try {
    if ([string]::IsNullOrWhiteSpace($AppDir)) { throw 'Укажите папку установки' }
    New-Item -ItemType Directory -Path $AppDir -Force | Out-Null

    if ($FromLocal) {
      $local = Get-LocalRepoRoot
      if (-not $local) { throw 'Локальный репозиторий не найден рядом с установщиком' }
      Write-Log ("Копирую из локальной папки: {0}" -f $local)
      Install-AppFiles -appDir $AppDir -sourceDir $local
    } else {
      Install-AppFromGitHub -appDir $AppDir
    }

    $nodeExe = $null
    if ($WantNode) {
      $nodeExe = Install-PortableNode -appDir $AppDir
    } else {
      $nodeExe = Find-Node -appDir $AppDir
      if (-not $nodeExe) {
        Write-Log 'Node.js не найден — скачиваю portable автоматически.'
        $nodeExe = Install-PortableNode -appDir $AppDir
      } else {
        Write-Log ("Использую Node.js: {0}" -f $nodeExe)
      }
    }

    # PATH на время установки (portable)
    $nodeDir = Split-Path -Parent $nodeExe
    $env:Path = "$nodeDir;" + $env:Path

    Install-Dependencies -appDir $AppDir -nodeExe $nodeExe
    Build-GuiExe -appDir $AppDir

    $exe = Join-Path $AppDir 'Проверка сделок.exe'
    if (-not (Test-Path $exe)) { throw 'Не найден exe мини-приложения' }

    if ($WantDesktop) {
      $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($AppName + '.lnk')
      New-AppShortcut -lnkPath $desk -target $exe -workDir $AppDir
      Write-Log "Ярлык на рабочем столе: $desk"
    }
    if ($WantStart) {
      $startDir = Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs\$AppName"
      $startLnk = Join-Path $startDir ($AppName + '.lnk')
      New-AppShortcut -lnkPath $startLnk -target $exe -workDir $AppDir
      Write-Log "Ярлык в Пуск: $startLnk"
    }

    Write-Log 'Готово.'
    [System.Windows.Forms.MessageBox]::Show(
      "Установка завершена.`n`nЗапуск: «$AppName»",
      'Установщик',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null

    if ([System.Windows.Forms.MessageBox]::Show(
        'Открыть приложение сейчас?',
        'Установщик',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
      ) -eq [System.Windows.Forms.DialogResult]::Yes) {
      Start-Process -FilePath $exe -WorkingDirectory $AppDir
    }
  }
  catch {
    Write-Log ("Ошибка: {0}" -f $_.Exception.Message)
    [System.Windows.Forms.MessageBox]::Show(
      $_.Exception.Message,
      'Ошибка установки',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  }
  finally {
    $script:installBtn.Enabled = $true
    $script:browseBtn.Enabled = $true
  }
}

# ---- UI ----
$cCanvas = [System.Drawing.Color]::FromArgb(236, 241, 247)
$cCanvas2 = [System.Drawing.Color]::FromArgb(221, 230, 240)
$cSurface = [System.Drawing.Color]::White
$cInk = [System.Drawing.Color]::FromArgb(22, 32, 48)
$cMuted = [System.Drawing.Color]::FromArgb(90, 106, 128)
$cLine = [System.Drawing.Color]::FromArgb(205, 216, 230)
$cAccent = [System.Drawing.Color]::FromArgb(14, 116, 168)
$cLogBg = [System.Drawing.Color]::FromArgb(28, 37, 52)
$cLogFg = [System.Drawing.Color]::FromArgb(214, 224, 236)
$cGhost = [System.Drawing.Color]::FromArgb(246, 249, 252)

function New-FlatButton([string]$text, [bool]$primary) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Height = 42
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderSize = 0
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $b.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
  if ($primary) {
    $b.BackColor = $cAccent
    $b.ForeColor = [System.Drawing.Color]::White
    $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(8, 96, 142)
  } else {
    $b.BackColor = $cGhost
    $b.ForeColor = $cInk
    $b.FlatAppearance.BorderSize = 1
    $b.FlatAppearance.BorderColor = $cLine
    $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(234, 240, 247)
  }
  return $b
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Установка — Проверка сделок"
$form.Size = New-Object System.Drawing.Size(780, 640)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size(700, 580)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.BackColor = $cCanvas
$form.Add_Paint({
  param($sender, $e)
  $rect = $sender.ClientRectangle
  $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $cCanvas, $cCanvas2, 120.0)
  $e.Graphics.FillRectangle($br, $rect)
  $br.Dispose()
  $accentBr = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, 8, $rect.Height)),
    $cAccent,
    [System.Drawing.Color]::FromArgb(56, 168, 196),
    90.0
  )
  $e.Graphics.FillRectangle($accentBr, 0, 0, 8, $rect.Height)
  $accentBr.Dispose()
})

$brand = New-Object System.Windows.Forms.Label
$brand.Text = 'Проверка сделок'
$brand.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 22)
$brand.ForeColor = $cInk
$brand.AutoSize = $true
$brand.Location = New-Object System.Drawing.Point(32, 24)
$brand.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($brand)

$sub = New-Object System.Windows.Forms.Label
$sub.Text = 'Установщик · скачает приложение с GitHub и подготовит ярлыки'
$sub.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$sub.ForeColor = $cMuted
$sub.AutoSize = $true
$sub.Location = New-Object System.Drawing.Point(34, 68)
$sub.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($sub)

$card = New-Object System.Windows.Forms.Panel
$card.BackColor = $cSurface
$card.Location = New-Object System.Drawing.Point(32, 110)
$card.Size = New-Object System.Drawing.Size(700, 250)
$card.Anchor = 'Top,Left,Right'
$card.Add_Paint({
  param($sender, $e)
  $pen = New-Object System.Drawing.Pen($cLine)
  $e.Graphics.DrawRectangle($pen, 0, 0, $sender.Width - 1, $sender.Height - 1)
  $pen.Dispose()
})
$form.Controls.Add($card)

$pathLabel = New-Object System.Windows.Forms.Label
$pathLabel.Text = 'ПАПКА УСТАНОВКИ'
$pathLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 8.5)
$pathLabel.ForeColor = $cMuted
$pathLabel.AutoSize = $true
$pathLabel.Location = New-Object System.Drawing.Point(22, 18)
$pathLabel.BackColor = $cSurface
$card.Controls.Add($pathLabel)

$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Text = $DefaultDir
$pathBox.BorderStyle = 'FixedSingle'
$pathBox.Font = New-Object System.Drawing.Font('Segoe UI', 10.5)
$pathBox.Location = New-Object System.Drawing.Point(22, 42)
$pathBox.Width = 540
$pathBox.Anchor = 'Top,Left,Right'
$pathBox.BackColor = [System.Drawing.Color]::FromArgb(250, 252, 255)
$pathBox.ForeColor = $cInk
$card.Controls.Add($pathBox)

$script:browseBtn = New-FlatButton 'Обзор' $false
$script:browseBtn.Width = 100
$script:browseBtn.Height = 32
$script:browseBtn.Location = New-Object System.Drawing.Point(575, 40)
$script:browseBtn.Anchor = 'Top,Right'
$script:browseBtn.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Папка установки'
  $dlg.SelectedPath = $pathBox.Text
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $pathBox.Text = $dlg.SelectedPath
  }
})
$card.Controls.Add($script:browseBtn)

$optsLabel = New-Object System.Windows.Forms.Label
$optsLabel.Text = 'ПАРАМЕТРЫ'
$optsLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 8.5)
$optsLabel.ForeColor = $cMuted
$optsLabel.AutoSize = $true
$optsLabel.Location = New-Object System.Drawing.Point(22, 88)
$optsLabel.BackColor = $cSurface
$card.Controls.Add($optsLabel)

$nodeExists = Test-NodeInstalled
$chkNode = New-Object System.Windows.Forms.CheckBox
$chkNode.Text = if ($nodeExists) {
  'Скачать Node.js в папку приложения (в системе уже есть)'
} else {
  'Скачать Node.js (~50 МБ, нужен для работы)'
}
$chkNode.Checked = -not $nodeExists
$chkNode.AutoSize = $true
$chkNode.ForeColor = $cInk
$chkNode.Location = New-Object System.Drawing.Point(22, 114)
$chkNode.BackColor = $cSurface
$card.Controls.Add($chkNode)

$chkDesktop = New-Object System.Windows.Forms.CheckBox
$chkDesktop.Text = 'Ярлык на рабочем столе'
$chkDesktop.Checked = $true
$chkDesktop.AutoSize = $true
$chkDesktop.ForeColor = $cInk
$chkDesktop.Location = New-Object System.Drawing.Point(22, 144)
$chkDesktop.BackColor = $cSurface
$card.Controls.Add($chkDesktop)

$chkStart = New-Object System.Windows.Forms.CheckBox
$chkStart.Text = 'Ярлык в меню Пуск'
$chkStart.Checked = $true
$chkStart.AutoSize = $true
$chkStart.ForeColor = $cInk
$chkStart.Location = New-Object System.Drawing.Point(260, 144)
$chkStart.BackColor = $cSurface
$card.Controls.Add($chkStart)

$localRepo = Get-LocalRepoRoot
$chkLocal = $null
if ($localRepo) {
  $chkLocal = New-Object System.Windows.Forms.CheckBox
  $chkLocal.Text = 'Взять файлы из этой папки проекта (не скачивать с GitHub)'
  $chkLocal.Checked = $true
  $chkLocal.AutoSize = $true
  $chkLocal.ForeColor = $cInk
  $chkLocal.Location = New-Object System.Drawing.Point(22, 174)
  $chkLocal.BackColor = $cSurface
  $card.Controls.Add($chkLocal)
}

$script:installBtn = New-FlatButton 'Установить' $true
$script:installBtn.Width = 150
$script:installBtn.Location = New-Object System.Drawing.Point(22, 200)
$script:installBtn.Add_Click({
  $fromLocal = $false
  if ($chkLocal -and $chkLocal.Checked) { $fromLocal = $true }
  Invoke-Install -AppDir $pathBox.Text.Trim() -WantNode $chkNode.Checked -WantDesktop $chkDesktop.Checked -WantStart $chkStart.Checked -FromLocal $fromLocal
})
$card.Controls.Add($script:installBtn)

$cancelBtn = New-FlatButton 'Закрыть' $false
$cancelBtn.Width = 110
$cancelBtn.Location = New-Object System.Drawing.Point(184, 200)
$cancelBtn.Add_Click({ $form.Close() })
$card.Controls.Add($cancelBtn)

$logCard = New-Object System.Windows.Forms.Panel
$logCard.BackColor = $cSurface
$logCard.Location = New-Object System.Drawing.Point(32, 378)
$logCard.Size = New-Object System.Drawing.Size(700, 200)
$logCard.Anchor = 'Top,Bottom,Left,Right'
$logCard.Add_Paint({
  param($sender, $e)
  $pen = New-Object System.Drawing.Pen($cLine)
  $e.Graphics.DrawRectangle($pen, 0, 0, $sender.Width - 1, $sender.Height - 1)
  $pen.Dispose()
})
$form.Controls.Add($logCard)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Text = 'ХОД УСТАНОВКИ'
$logLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 8.5)
$logLabel.ForeColor = $cMuted
$logLabel.AutoSize = $true
$logLabel.Location = New-Object System.Drawing.Point(22, 14)
$logLabel.BackColor = $cSurface
$logCard.Controls.Add($logLabel)

$script:logBox = New-Object System.Windows.Forms.TextBox
$script:logBox.Multiline = $true
$script:logBox.ScrollBars = 'Vertical'
$script:logBox.ReadOnly = $true
$script:logBox.BorderStyle = 'None'
try {
  $script:logBox.Font = New-Object System.Drawing.Font('Cascadia Mono', 9.5)
} catch {
  $script:logBox.Font = New-Object System.Drawing.Font('Consolas', 9.5)
}
$script:logBox.BackColor = $cLogBg
$script:logBox.ForeColor = $cLogFg
$script:logBox.Location = New-Object System.Drawing.Point(18, 40)
$script:logBox.Width = 664
$script:logBox.Height = 142
$script:logBox.Anchor = 'Top,Bottom,Left,Right'
$logCard.Controls.Add($script:logBox)

Write-Log 'Отметьте нужные пункты и нажмите «Установить».'
Write-Log "Репозиторий: https://github.com/$Repo"

[void]$form.ShowDialog()
