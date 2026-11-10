@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Проверка сделок Битрикс24

if exist "%~dp0Проверка сделок.exe" (
  start "" "%~dp0Проверка сделок.exe"
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js не найден.
  echo Запустите Установить.bat или установите LTS с https://nodejs.org
  echo.
  pause
  exit /b 1
)

node start.js
echo.
pause
