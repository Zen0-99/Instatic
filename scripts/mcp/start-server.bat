@echo off

REM Kill any existing process on port 9876
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :9876') do taskkill /PID %%a /F 2>nul

REM Small delay to ensure port is released
timeout /t 1 /nobreak >nul

cd /d "%~dp0..\.."
bun run "scripts\mcp\server.ts"
