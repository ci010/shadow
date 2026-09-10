@echo off
:: Docker Desktop Installer — Windows batch wrapper
:: Delegates to docker-install.ps1 via PowerShell.
::
:: Usage:
::   docker-install.bat              (WSL-2 backend)
::   docker-install.bat --accept     (pass -AcceptLicense)
::   docker-install.bat --hyper-v    (use Hyper-V backend)

setlocal

set PS_SCRIPT=%~dp0docker-install.ps1
set EXTRA_ARGS=

for %%A in (%*) do (
  if /I "%%A"=="--accept"   set EXTRA_ARGS=%EXTRA_ARGS% -AcceptLicense
  if /I "%%A"=="--hyper-v"  set EXTRA_ARGS=%EXTRA_ARGS% -Backend hyper-v
  if /I "%%A"=="--windows"  set EXTRA_ARGS=%EXTRA_ARGS% -Backend windows
  if /I "%%A"=="--service"  set EXTRA_ARGS=%EXTRA_ARGS% -AlwaysRunService
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %EXTRA_ARGS%
if %ERRORLEVEL% NEQ 0 (
  echo [docker-install] Installation failed with error %ERRORLEVEL%.
  exit /b %ERRORLEVEL%
)

endlocal
