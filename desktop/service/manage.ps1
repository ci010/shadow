#requires -Version 5.1
<#
.SYNOPSIS
Explicit, administrator-operated ShadowService lifecycle (Windows PowerShell 5.1).
.DESCRIPTION
No operation is run automatically by the desktop or installer. Install creates a NEW
dedicated data directory, ACL-protected credentials, bootstrap, and real SCM service.
It does not start the service. Service management requires the All Users installation
under native Program Files, with standard readable/executable application ACLs.
Per-user LocalAppData installs remain supported for desktop sidecar mode only.
The application tree is checked before any service/data mutation; unsupported custom
ACLs, deny entries, writable shared application files, and reparse points are rejected.
No application/profile ACL is changed to make a rejected installation work.
Do not uninstall/move that application while the
service is installed; stop, update the application, then Reinstall.

The specific LOCAL Windows user named by -DesktopUser receives the service bearer credential: this
grants administrative access to the local backend, not merely a read-only UI.
No existing Home/configuration is imported. Uninstall preserves ALL service data,
credentials, logs, and connection files. Reinstall reuses that explicit directory
and its identity/port; it does not start the service. Remove retained data manually
only after backup and after checking no service uses it.

Session 0 interactive browser/capture capabilities are NOT supported by this setup.
Additional tool executables must be installed for LocalService, not only a user's PATH.
Run Get-Help .\manage.ps1 -Full for examples. No elevation is initiated by this script.
These manual -File commands require an administrator-approved execution policy
that permits this management script. Inspect Get-ExecutionPolicy -List if blocked;
organization MachinePolicy/UserPolicy takes precedence over process-local settings.
This script neither changes policy nor promises to bypass organizational controls.
The SCM stop path does NOT execute a .ps1 file: Shadow.exe runs plain stop.cjs in
Node mode. Its bounded native PowerShell -Command process inspection needs CIM and
taskkill access for LocalService. If application-control policy blocks those native
tools, installation requires administrator remediation; ownership checks never fall
back to unsafe process-name killing. SCM lifecycle behavior must be validated in a VM.
.EXAMPLE
powershell.exe -NoProfile -File "C:\Program Files\Shadow\resources\service\manage.ps1" -Action Install -DataDirectory "C:\ProgramData\ShadowService" -DesktopUser "COMPUTER\Alice" -Port 18800
.EXAMPLE
powershell.exe -NoProfile -File "C:\Program Files\Shadow\resources\service\manage.ps1" -Action Start -DataDirectory "C:\ProgramData\ShadowService"
.EXAMPLE
& "C:\Program Files\Shadow\Shadow.exe" --service-connection="C:\ProgramData\ShadowService\control\connection.v1.json"
.EXAMPLE
powershell.exe -NoProfile -File "C:\Program Files\Shadow\resources\service\manage.ps1" -Action Stop -DataDirectory "C:\ProgramData\ShadowService"
.EXAMPLE
powershell.exe -NoProfile -File "C:\Program Files\Shadow\resources\service\manage.ps1" -Action Uninstall -DataDirectory "C:\ProgramData\ShadowService"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Reinstall', 'Start', 'Stop', 'Status', 'Uninstall')]
    [string] $Action,
    [Parameter(Mandatory = $true)]
    [string] $DataDirectory,
    [string] $DesktopUser,
    [ValidateRange(1024, 65535)]
    [int] $Port = 18800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ServiceName = 'ShadowService'

function Get-AbsoluteLocalPath([string] $Path) {
    # Percent expansion is performed by WinSW; quotes/control chars can alter arguments.
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f"%]' -or $Path.Contains('..')) {
        throw 'Paths must be full local drive paths without quotes, percent expansion, or parent segments.'
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full.Length -le 3) { throw 'A drive root cannot be a service directory.' }
    $cursor = $full
    while ($cursor.Length -gt 3) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Service and application paths cannot contain reparse points.'
            }
        }
        $cursor = Split-Path -Parent $cursor
    }
    return $full
}

function Assert-ServiceReadableAcl($Acl, [string] $Path) {
    $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -eq 0) {
        throw "Unsupported empty application ACL: $Path. Repair/reinstall the All Users application with standard Program Files permissions."
    }
    $readPrincipals = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-6', 'S-1-5-19')
    $privilegedPrincipals = @(
        'S-1-5-18', 'S-1-5-32-544',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    )
    $writeMask = [int][Security.AccessControl.FileSystemRights]::Write -bor
        [int][Security.AccessControl.FileSystemRights]::Delete -bor
        [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [int][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [int][Security.AccessControl.FileSystemRights]::TakeOwnership
    $granted = 0
    foreach ($rule in $rules) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            throw "Unsupported deny/custom application ACL: $Path. Ask your administrator to repair the All Users installation; service setup does not change application permissions."
        }
        $sid = $rule.IdentityReference.Value
        if ($sid -notin $privilegedPrincipals -and ([int]$rule.FileSystemRights -band $writeMask) -ne 0) {
            throw "Unsupported writable application ACL: $Path. Service binaries must use protected, administrator-owned Program Files permissions."
        }
        if ($sid -in $readPrincipals) { $granted = $granted -bor [int]$rule.FileSystemRights }
    }
    $required = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute
    if (($granted -band $required) -ne $required) {
        throw "LocalService read/execute permissions cannot be established for $Path. Reinstall for All Users with standard Program Files ACLs; do not grant access to a user profile."
    }
}

function Assert-MachineWideApplication([string] $ApplicationRoot, [string] $NativeProgramFiles) {
    $ApplicationRoot = Get-AbsoluteLocalPath $ApplicationRoot
    $NativeProgramFiles = Get-AbsoluteLocalPath $NativeProgramFiles
    if (-not $ApplicationRoot.StartsWith($NativeProgramFiles + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Windows service mode requires an All Users Shadow installation under native Program Files. The current-user/custom installation remains usable in desktop sidecar mode. Reinstall for All Users; no service or data was changed.'
    }
    $requiredFiles = @(
        'Shadow.exe', 'resources\backend\dist\src\index.js',
        'resources\service\ShadowService.exe', 'resources\service\manage.ps1',
        'resources\service\probe.cjs', 'resources\service\stop.cjs'
    )
    foreach ($relative in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $ApplicationRoot $relative) -PathType Leaf)) {
            throw "Incomplete All Users installation: $relative. Repair/reinstall Shadow before managing the service."
        }
    }
    # Check traversal ACLs through Program Files and any nested installation parents.
    $ancestor = Split-Path -Parent $ApplicationRoot
    while ($ancestor.Length -ge $NativeProgramFiles.Length) {
        Assert-ServiceReadableAcl (Get-Acl -LiteralPath $ancestor) $ancestor
        if ($ancestor -ieq $NativeProgramFiles) { break }
        $ancestor = Split-Path -Parent $ancestor
    }
    # Electron DLLs, backend dependencies, and both control helpers must all remain
    # usable by LocalService. Inspect one directory level at a time: never follow
    # a junction/symlink while recursively checking an installation.
    $pending = New-Object 'Collections.Generic.Queue[string]'
    $pending.Enqueue($ApplicationRoot)
    while ($pending.Count -gt 0) {
        $current = $pending.Dequeue()
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Unsupported application reparse point: $current. Use a complete, non-linked All Users installation."
        }
        Assert-ServiceReadableAcl (Get-Acl -LiteralPath $current) $current
        if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
            foreach ($child in Get-ChildItem -LiteralPath $current -Force) {
                $pending.Enqueue($child.FullName)
            }
        }
    }
    return $ApplicationRoot
}

function New-DirectoryAcl([string] $ServiceRights, [string] $DesktopSid) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-19', $ServiceRights))) {
        $sid = New-Object Security.Principal.SecurityIdentifier($entry[0])
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, $entry[1], 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($DesktopSid) {
        $sid = New-Object Security.Principal.SecurityIdentifier($DesktopSid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    }
    return $acl
}

function New-ProtectedDirectory([string] $Path, $Acl) {
    # This overload atomically supplies the DACL; use Windows PowerShell, not pwsh.
    [IO.Directory]::CreateDirectory($Path, $Acl) | Out-Null
    Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Write-Json([string] $Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
}

function Escape-Xml([string] $Value) { return [Security.SecurityElement]::Escape($Value) }
function Quote-Argument([string] $Value) { return '"' + $Value + '"' }

function Invoke-Wrapper([string] $Command) {
    $process = Start-Process -FilePath $script:Wrapper -ArgumentList $Command -PassThru -NoNewWindow
    try {
        if (-not $process.WaitForExit(60000)) {
            $process.Kill()
            throw "WinSW $Command timed out. Check SCM state before retrying; data has been preserved."
        }
        if ($process.ExitCode -ne 0) { throw "WinSW $Command failed (exit $($process.ExitCode)). Data has been preserved." }
    } finally { $process.Dispose() }
}

function Get-OwnedService {
    $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($null -ne $service) {
        $actual = $service.PathName.Trim().Trim('"')
        if ($actual -ine $script:Wrapper) {
            throw 'The fixed service name is already used by a different installation. Refusing to modify it.'
        }
        if ($service.StartName -notin @('NT AUTHORITY\LocalService', 'NT AUTHORITY\LOCAL SERVICE')) {
            throw 'Service account mismatch. Refusing to operate on an unexpected service.'
        }
    }
    return $service
}

function Stop-OwnedService {
    $service = Get-OwnedService
    if ($null -eq $service) { throw 'ShadowService is not installed.' }
    if ($service.State -ne 'Stopped') {
        Invoke-Wrapper 'stop'
        $controller = Get-Service -Name $ServiceName
        $controller.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
    }
}

if ($PSVersionTable.PSEdition -ne 'Desktop' -or [Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'Run this script with Windows PowerShell 5.1 (powershell.exe), not pwsh.'
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open Windows PowerShell as Administrator explicitly. This script never elevates itself.'
}
if (-not [Environment]::Is64BitProcess) {
    throw 'Use 64-bit Windows PowerShell 5.1 for the native Program Files All Users service installation.'
}

# This gate precedes all data-directory creation, SCM calls, and install/start/stop
# branches. It only inspects packaged application files; it never grants access.
$resources = Split-Path -Parent $PSScriptRoot
try {
    $applicationRoot = Assert-MachineWideApplication (Split-Path -Parent $resources) ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))
} catch {
    throw "All Users service preflight failed before any service/data changes. Repair/reinstall under native Program Files using administrator-approved standard application permissions. Details: $($_.Exception.Message)"
}
$executable = Get-AbsoluteLocalPath (Join-Path $applicationRoot 'Shadow.exe')
$entry = Get-AbsoluteLocalPath (Join-Path $resources 'backend\dist\src\index.js')
$sourceWrapper = Get-AbsoluteLocalPath (Join-Path $PSScriptRoot 'ShadowService.exe')

$DataDirectory = Get-AbsoluteLocalPath $DataDirectory
if ($DataDirectory -ieq $applicationRoot -or $DataDirectory.StartsWith($applicationRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The writable service data directory must be outside the protected application installation (for example C:\ProgramData\ShadowService). No service or data was changed.'
}
$control = Join-Path $DataDirectory 'control'
$data = Join-Path $DataDirectory 'data'
$script:Wrapper = Join-Path $control 'ShadowService.exe'
$descriptorPath = Join-Path $control 'connection.v1.json'
$configPath = Join-Path $control 'runtime-config.v1.json'
$credentialPath = Join-Path $control 'launch-token'
foreach ($path in @(
    $control, $data, $script:Wrapper, $descriptorPath, $configPath, $credentialPath,
    (Join-Path $control 'installation.v1.json'), (Join-Path $control 'ShadowService.xml'),
    (Join-Path $control 'stop.cjs'), (Join-Path $control 'probe.cjs'),
    (Join-Path $DataDirectory 'logs'), (Join-Path $data 'config'),
    (Join-Path $data 'config\bot.config.json'), (Join-Path $data 'workspace'), (Join-Path $data 'auth')
)) { Get-AbsoluteLocalPath $path | Out-Null }
$existing = Get-OwnedService

if ($Action -eq 'Status') {
    if ($null -eq $existing) { Write-Output 'ShadowService is not installed.'; exit 0 }
    Write-Output ("ShadowService: " + $existing.State)
    exit 0
}
if ($Action -eq 'Stop') { Stop-OwnedService; exit 0 }
if ($Action -eq 'Uninstall') {
    if ($null -eq $existing) { throw 'ShadowService is not installed; retained files were not changed.' }
    Stop-OwnedService
    Invoke-Wrapper 'uninstall'
    Write-Output 'Service removed. Data, credentials, logs, and descriptor were preserved.'
    exit 0
}
if ($Action -eq 'Start') {
    if ($null -eq $existing) { throw 'ShadowService is not installed.' }
    $install = Get-Content -LiteralPath (Join-Path $control 'installation.v1.json') -Raw | ConvertFrom-Json
    if ($install.version -ne 1 -or $install.executablePath -ine $executable -or $install.entryPath -ine $entry) {
        throw 'The retained service refers to a different application installation. Use Reinstall from the verified All Users package before starting.'
    }
    if ($existing.State -ne 'Running') { Invoke-Wrapper 'start' }
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $install.executablePath (Join-Path $control 'probe.cjs') $descriptorPath
    if ($LASTEXITCODE -ne 0) { throw 'SCM service started, but authenticated readiness failed. Check protected logs; no desktop fallback will be launched.' }
    Write-Output 'ShadowService is ready.'
    exit 0
}

if (-not $DesktopUser) { throw '-DesktopUser is required for Install/Reinstall (explicitly grants backend administration).' }
$desktopSid = (New-Object Security.Principal.NTAccount($DesktopUser)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($null -eq (Get-CimInstance Win32_UserAccount -Filter "SID='$desktopSid' AND LocalAccount=True")) {
    throw 'DesktopUser must identify a specific local Windows user, not a group or service account.'
}
foreach ($required in @($executable, $entry, $sourceWrapper, (Join-Path $PSScriptRoot 'stop.cjs'), (Join-Path $PSScriptRoot 'probe.cjs'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Packaged service resource is missing: $required" }
}
if ($Action -eq 'Install') {
    if ($null -ne $existing) { throw 'ShadowService is already installed. Use Reinstall explicitly.' }
    if (Test-Path -LiteralPath $DataDirectory) { throw 'Install requires a new directory. No existing data will be adopted; use Reinstall only for a prior service installation.' }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $DataDirectory) -PathType Container)) {
        throw 'The parent of the new service directory must already exist.'
    }
} else {
    foreach ($required in @($descriptorPath, $configPath, $credentialPath, (Join-Path $control 'installation.v1.json'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'Reinstall requires the complete retained service installation.' }
    }
    $saved = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    if ($saved.version -ne 1 -or $saved.serviceName -ne $ServiceName -or $saved.role -ne 'main' -or
        $saved.configPath -ine $configPath -or $saved.credentialPath -ine $credentialPath -or
        $saved.apiBase -ne "http://127.0.0.1:$($saved.port)" -or $saved.port -lt 1024 -or $saved.port -gt 65535) {
        throw 'Retained service descriptor does not match this installation.'
    }
    if ($PSBoundParameters.ContainsKey('Port') -and $Port -ne $saved.port) { throw 'Reinstall cannot silently change the saved port.' }
    $Port = $saved.port
    $bootstrap = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($bootstrap.version -ne 1 -or $bootstrap.mode -ne 'main' -or $bootstrap.dataDir -ine $data -or -not $bootstrap.localNodeId) {
        throw 'Retained bootstrap does not match this service data directory.'
    }
    $savedInstall = Get-Content -LiteralPath (Join-Path $control 'installation.v1.json') -Raw | ConvertFrom-Json
    if ($savedInstall.desktopSid -ne $desktopSid) { throw 'Reinstall cannot silently change the authorized desktop account.' }
    if ($null -ne $existing) { Stop-OwnedService; Invoke-Wrapper 'uninstall' }
}

$readAcl = New-DirectoryAcl 'ReadAndExecute' $desktopSid
$writeAcl = New-DirectoryAcl 'Modify' ''
New-ProtectedDirectory $DataDirectory $readAcl
New-ProtectedDirectory $control $readAcl
New-ProtectedDirectory $data $writeAcl
New-ProtectedDirectory (Join-Path $DataDirectory 'logs') $writeAcl
New-ProtectedDirectory (Join-Path $data 'config') $writeAcl
New-ProtectedDirectory (Join-Path $data 'workspace') $writeAcl
New-ProtectedDirectory (Join-Path $data 'auth') $writeAcl

Copy-Item -LiteralPath $sourceWrapper -Destination $script:Wrapper -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stop.cjs') -Destination $control -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'probe.cjs') -Destination $control -Force
if ($Action -eq 'Install') {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [IO.File]::WriteAllText($credentialPath, $token, (New-Object Text.UTF8Encoding($false)))
    $token = $null
    Write-Json $configPath @{ version = 1; mode = 'main'; dataDir = $data; localNodeId = [Guid]::NewGuid().ToString() }
    Write-Json (Join-Path $data 'config\bot.config.json') @{
        agent = @{ workspace = (Join-Path $data 'workspace'); sessionStorage = 'sqlite' }
        channels = @{ web = @{ enabled = $true } }
        providers = @{ copilot = @{} }
    }
    Write-Json $descriptorPath @{
        version = 1; serviceName = $ServiceName; role = 'main'; apiBase = "http://127.0.0.1:$Port"
        port = $Port; credentialPath = $credentialPath; configPath = $configPath
    }
}
Write-Json (Join-Path $control 'installation.v1.json') @{
    version = 1; executablePath = $executable; entryPath = $entry; desktopSid = $desktopSid
}
$startArguments = (Quote-Argument $entry) + ' server start --config ' + (Quote-Argument $configPath) + ' --service'
$stopScript = Join-Path $control 'stop.cjs'
$stopArguments = (Quote-Argument $stopScript) + ' ' + (Quote-Argument $descriptorPath)
$xml = @"
<service>
  <id>ShadowService</id>
  <name>Shadow headless backend</name>
  <description>Opt-in headless Main backend. Desktop attachment does not own this service.</description>
  <executable>$(Escape-Xml $executable)</executable>
  <startarguments>$(Escape-Xml $startArguments)</startarguments>
  <stopexecutable>$(Escape-Xml $executable)</stopexecutable>
  <stoparguments>$(Escape-Xml $stopArguments)</stoparguments>
  <workingdirectory>$(Escape-Xml $data)</workingdirectory>
  <env name="ELECTRON_RUN_AS_NODE" value="1"/>
  <env name="WINDOWS_USE_LAUNCH_TOKEN_FILE" value="$(Escape-Xml $credentialPath)"/>
  <env name="GATEWAY_PORT" value="$Port"/>
  <env name="GITHUB_COPILOT_TOKEN_DIR" value="$(Escape-Xml (Join-Path $data 'auth'))"/>
  <env name="GITHUB_COPILOT_ACCESS_TOKEN_FILE" value="access-token"/>
  <env name="GITHUB_COPILOT_API_KEY_FILE" value="api-key.json"/>
  <env name="GITHUB_COPILOT_MODELS_CACHE_FILE" value="models.json"/>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Automatic</startmode>
  <delayedAutoStart/>
  <stoptimeout>35sec</stoptimeout>
  <onfailure action="restart" delay="10sec"/>
  <onfailure action="restart" delay="30sec"/>
  <onfailure action="none"/>
  <resetfailure>1hour</resetfailure>
  <logpath>$(Escape-Xml (Join-Path $DataDirectory 'logs'))</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
</service>
"@
[IO.File]::WriteAllText((Join-Path $control 'ShadowService.xml'), $xml, (New-Object Text.UTF8Encoding($false)))
foreach ($name in @('ShadowService.exe', 'ShadowService.xml', 'stop.cjs', 'probe.cjs',
    'launch-token', 'runtime-config.v1.json', 'connection.v1.json', 'installation.v1.json')) {
    $file = Get-Item -LiteralPath (Join-Path $control $name) -Force
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Control files cannot be reparse points.' }
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-19', 'ReadAndExecute'), @($desktopSid, 'ReadAndExecute'))) {
        $sid = New-Object Security.Principal.SecurityIdentifier($entry[0])
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $entry[1], 'Allow')))
    }
    Set-Acl -LiteralPath $file.FullName -AclObject $acl
}
Invoke-Wrapper 'install'
Write-Output "Installed but not started. Use -Action Start -DataDirectory `"$DataDirectory`"."
Write-Output "Desktop opt-in: Shadow.exe --service-connection=`"$descriptorPath`""
