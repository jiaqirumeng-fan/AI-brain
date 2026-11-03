@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PORT=8123

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:%PORT%/'"

where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto :eof
)

echo.
echo  [!] 没有找到 Python 或 Node。
echo      可以直接双击 index.html 打开，但浏览器可能不允许本地保存。
echo.
pause
