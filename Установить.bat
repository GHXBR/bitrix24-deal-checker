@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Установка — Проверка сделок Битрикс24

where powershell >nul 2>&1
if errorlevel 1 (
  echo PowerShell не найден. Нужна Windows 10/11.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\Install-App.ps1"
if errorlevel 1 (
  echo.
  echo Установка завершилась с ошибкой.
  pause
)
