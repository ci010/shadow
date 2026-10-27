param(
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$previousToolchain = $env:RUSTUP_TOOLCHAIN

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'Native desktop repair requires Windows.'
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $manifest = Get-Content (Join-Path $root 'integrations\agent-desktop\Cargo.toml') -Raw
    if ($manifest -notmatch '(?m)^rust-version\s*=\s*"(\d+\.\d+(?:\.\d+)?)"') {
        throw 'Cannot read the minimum Rust version from Cargo.toml.'
    }
    $minimumRust = [version]$Matches[1]
    $toolchains = & rustup toolchain list
    if ($LASTEXITCODE -ne 0) { throw 'Cannot list installed Rust toolchains; install rustup first.' }
    $selected = $null
    foreach ($line in $toolchains) {
        $candidate = ($line -split '\s+')[0]
        if ($candidate -notmatch '-pc-windows-msvc$') { continue }
        $versionText = & rustup run $candidate rustc --version
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect installed Rust toolchain $candidate." }
        if ($versionText -match '^rustc (\d+\.\d+\.\d+)(?:\s|$)' -and [version]$Matches[1] -ge $minimumRust) {
            $selected = $candidate
            break
        }
    }
    if (-not $selected) {
        throw "Install a Windows MSVC Rust toolchain >= $minimumRust with rustup, then rerun this command."
    }
    $env:RUSTUP_TOOLCHAIN = $selected

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw 'Install Visual Studio C++ Build Tools and the Windows SDK first (vswhere.exe is missing).'
    }
    $component = if ($Arch -eq 'arm64') { 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' } else { 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' }
    $installation = & $vswhere -latest -products '*' -requires $component -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $installation) {
        throw "No Visual Studio installation with $component was found."
    }
    $vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvarsall.bat'
    if (-not (Test-Path $vcvars)) { throw "Missing MSVC environment setup: $vcvars" }
    $vcArch = if ($Arch -eq 'arm64') { 'amd64_arm64' } else { 'amd64' }
    $target = if ($Arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    $native = Join-Path $root 'integrations\agent-desktop'
    if (-not (Test-Path (Join-Path $native 'Cargo.lock'))) {
        throw 'Missing native Cargo.lock; follow integrations/agent-desktop/README.md for explicit initial lock resolution.'
    }
    if (-not (Test-Path (Join-Path $native '.upstream'))) {
        & $node (Join-Path $native 'scripts\fetch.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Fetching the pinned native sources failed.' }
    }
    Write-Host "Rebuilding agent-desktop for $Arch with $selected and MSVC."
    $builder = Join-Path $native 'scripts\build.mjs'
    & $env:ComSpec /d /c "call `"$vcvars`" $vcArch >nul && `"$node`" `"$builder`" $target"
    if ($LASTEXITCODE -ne 0) { throw 'Native desktop rebuild failed.' }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    $env:RUSTUP_TOOLCHAIN = $previousToolchain
}
