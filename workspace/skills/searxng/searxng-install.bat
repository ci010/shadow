@echo off
:: SearXNG Docker Installer — Windows batch wrapper
:: Delegates to searxng-install.ps1 via PowerShell.
::
:: Usage:
::   searxng-install.bat
::   searxng-install.bat --port=9090
::   searxng-install.bat --dir=C:\searxng
::   searxng-install.bat --reinstall

setlocal

set PS_SCRIPT=%~dp0searxng-install.ps1
set EXTRA_ARGS=

for %%A in (%*) do (
  echo %%A | findstr /r "^--port=" >nul && (
    for /f "tokens=2 delims==" %%V in ("%%A") do set EXTRA_ARGS=%EXTRA_ARGS% -Port %%V
  )
  echo %%A | findstr /r "^--dir=" >nul && (
    for /f "tokens=2 delims==" %%V in ("%%A") do set EXTRA_ARGS=%EXTRA_ARGS% -Dir "%%V"
  )
  if /I "%%A"=="--reinstall" set EXTRA_ARGS=%EXTRA_ARGS% -Reinstall
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %EXTRA_ARGS%
if %ERRORLEVEL% NEQ 0 (
  echo [searxng-install] Installation failed with error %ERRORLEVEL%.
  exit /b %ERRORLEVEL%
)

endlocal
