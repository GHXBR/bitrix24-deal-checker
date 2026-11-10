# Собирает GUI и установщик.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
& (Join-Path $here 'build-gui.ps1')
& (Join-Path $here 'build-installer.ps1')
Write-Host ''
Write-Host 'Собрано:'
Write-Host '  Проверка сделок.exe  — мини-приложение'
Write-Host '  Установить.exe       — загрузчик для коллег'
