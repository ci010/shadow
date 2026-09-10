#Requires -Version 5.1
<#
.SYNOPSIS
  Docker Desktop Installer for Windows
.DESCRIPTION
  Downloads the latest Docker Desktop installer and installs it silently via CLI.
.PARAMETER AcceptLicense
  Accept the Docker Subscription Service Agreement non-interactively.
.PARAMETER Backend
  Backend to use: wsl-2 (default), hyper-v, or windows.
.PARAMETER AlwaysRunService
  Install with --always-run-service (for non-admin user environments).
.EXAMPLE
  .\docker-install.ps1 -AcceptLicense
  .\docker-install.ps1 -AcceptLicense -Backend hyper-v
#>
param(
  [switch]$AcceptLicense,
  [ValidateSet('wsl-2', 'hyper-v', 'windows')]
  [string]$Backend = 'wsl-2',
  [switch]$AlwaysRunService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Log { param([string]$Msg) Write-Host "[docker-install] $Msg" }
function Die { param([string]$Msg) Write-Error "[docker-install] ERROR: $Msg"; exit 1 }

# ── Architecture ──────────────────────────────────────────────────────────────

$Arch = $env:PROCESSOR_ARCHITECTURE   # AMD64 | ARM64
Log "Detected arch: $Arch"

$ExeUrl = if ($Arch -eq 'ARM64') {
  'https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe'
} else {
  'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
}

# ── WSL update ────────────────────────────────────────────────────────────────

Log "Updating WSL..."
try {
  wsl --update 2>&1 | Out-Null
  Log "WSL updated."
} catch {
  Log "WSL update failed or WSL not installed — continuing."
}

# ── Download ──────────────────────────────────────────────────────────────────

$ExePath = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
Log "Downloading $ExeUrl"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $ExeUrl -OutFile $ExePath -UseBasicParsing
Log "Saved to $ExePath"

# ── Install ───────────────────────────────────────────────────────────────────

$InstallArgs = @('install', "--backend=$Backend")
if ($AcceptLicense)    { $InstallArgs += '--accept-license' }
if ($AlwaysRunService) { $InstallArgs += '--always-run-service' }

Log "Running installer: $ExePath $($InstallArgs -join ' ')"
$proc = Start-Process -FilePath $ExePath -ArgumentList $InstallArgs -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  Die "Installer exited with code $($proc.ExitCode)"
}

Remove-Item -Force $ExePath
Log "Windows installation complete."

# ── Optional: add current user to docker-users ────────────────────────────────

$CurrentUser = $env:USERNAME
Log "Adding '$CurrentUser' to docker-users group..."
try {
  net localgroup docker-users $CurrentUser /add 2>&1 | Out-Null
  Log "Done. Log out and back in for group membership to take effect."
} catch {
  Log "Could not add user to docker-users (may already be a member or insufficient rights)."
}

# ── Done ──────────────────────────────────────────────────────────────────────

Log ""
Log "Verify installation with:"
Log "  docker version"
Log "  docker run hello-world"
