import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const scriptPath = fileURLToPath(new URL('../../service/manage.ps1', import.meta.url))

function runSyntheticPreflight(body: string): void {
  // Extract functions only. All filesystem/ACL/SCM commands are synthetic stubs;
  // no machine installation, profile, application ACL, or policy is inspected.
  const command = `
    $ErrorActionPreference='Stop'
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
    foreach($name in @('Get-AbsoluteLocalPath','Assert-ServiceReadableAcl','Assert-MachineWideApplication')) {
      $fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
      Invoke-Expression $fn.Extent.Text
    }
    $script:items=@{}
    $script:aclOverrides=@{}
    $script:aclReads=New-Object 'Collections.Generic.List[string]'
    $script:enumerated=New-Object 'Collections.Generic.List[string]'
    $script:mutations=0
    function New-SyntheticAcl([string]$Principal='S-1-5-32-545',[string]$Rights='ReadAndExecute',[string]$Type='Allow') {
      $acl=New-Object Security.AccessControl.DirectorySecurity
      $acl.SetAccessRuleProtection($true,$false)
      $sid=New-Object Security.Principal.SecurityIdentifier($Principal)
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,$Rights,$Type)))
      $admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admins,'FullControl','Allow')))
      return $acl
    }
    $script:standardAcl=New-SyntheticAcl
    function Add-Item([string]$Path,[IO.FileAttributes]$Attributes) {
      $script:items[$Path]=[pscustomobject]@{FullName=$Path;Attributes=$Attributes}
    }
    function Test-Path([string]$LiteralPath,[string]$PathType) {
      if(-not $script:items.ContainsKey($LiteralPath)){return $false}
      if($PathType -eq 'Leaf'){return (($script:items[$LiteralPath].Attributes -band [IO.FileAttributes]::Directory) -eq 0)}
      return $true
    }
    function Get-Item([string]$LiteralPath,[switch]$Force) {
      if(-not $script:items.ContainsKey($LiteralPath)){throw 'Unexpected synthetic filesystem lookup'}
      return $script:items[$LiteralPath]
    }
    function Get-ChildItem([string]$LiteralPath,[switch]$Force) {
      $script:enumerated.Add($LiteralPath)
      return @($script:items.Values | Where-Object {(Split-Path -Parent $_.FullName) -ieq $LiteralPath})
    }
    function Get-Acl([string]$LiteralPath) {
      $script:aclReads.Add($LiteralPath)
      if($script:aclOverrides.ContainsKey($LiteralPath)){return $script:aclOverrides[$LiteralPath]}
      if(-not $script:items.ContainsKey($LiteralPath)){throw 'Unexpected synthetic ACL lookup'}
      return $script:standardAcl
    }
    function Set-Acl { $script:mutations++; throw 'Preflight must not modify ACLs' }
    function New-ProtectedDirectory { $script:mutations++; throw 'Preflight must not create data' }
    function Invoke-Wrapper { $script:mutations++; throw 'Preflight must not invoke SCM' }
    function Get-CimInstance { throw 'Preflight must not inspect live SCM state' }
    function Expect-Rejection([scriptblock]$Operation,[string]$Message) {
      try { & $Operation | Out-Null } catch {
        if($_.Exception.Message -notmatch $Message){throw "Wrong preflight failure: $($_.Exception.Message)"}
        return
      }
      throw 'Expected preflight rejection'
    }
    ${body}
    if($script:mutations -ne 0){throw 'Unexpected mutation'}
  `
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
}

test('machine-wide preflight rejects current-user/custom/lookalike roots before ACL access or mutations', { skip: process.platform !== 'win32' }, () => {
  runSyntheticPreflight(`
    foreach($root in @(
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\Shadow',
      'D:\\Shadow',
      'C:\\Program Files Evil\\Shadow',
      'C:\\Program Files (x86)\\Shadow',
      'C:\\Program Files'
    )) {
      Expect-Rejection {Assert-MachineWideApplication $root 'C:\\Program Files'} 'All Users'
    }
    if($script:aclReads.Count -ne 0 -or $script:enumerated.Count -ne 0){throw 'Unsupported root must fail before application ACL traversal'}
  `)
})

test('service application ACL evaluation accepts standard RX and rejects deny, insufficient and writable custom ACLs', { skip: process.platform !== 'win32' }, () => {
  runSyntheticPreflight(`
    Assert-ServiceReadableAcl (New-SyntheticAcl) 'synthetic'
    Assert-ServiceReadableAcl (New-SyntheticAcl 'S-1-5-19') 'synthetic'
    Expect-Rejection {Assert-ServiceReadableAcl (New-SyntheticAcl 'S-1-5-19' 'ReadAndExecute' 'Deny') 'synthetic'} 'deny'
    Expect-Rejection {Assert-ServiceReadableAcl (New-SyntheticAcl 'S-1-5-19' 'Read') 'synthetic'} 'read/execute'
    Expect-Rejection {Assert-ServiceReadableAcl (New-SyntheticAcl 'S-1-5-32-545' 'Modify') 'synthetic'} 'writable'
    Expect-Rejection {Assert-ServiceReadableAcl (New-SyntheticAcl 'S-1-5-21-100-200-300-1001' 'ReadAndExecute') 'synthetic'} 'read/execute'
    Expect-Rejection {Assert-ServiceReadableAcl (New-Object Security.AccessControl.DirectorySecurity) 'synthetic'} 'empty'
    if($script:aclReads.Count -ne 0){throw 'Pure ACL evaluator must not read real ACLs'}
  `)
})

test('full synthetic package preflight covers backend dependencies and helpers without traversing reparse points', { skip: process.platform !== 'win32' }, () => {
  runSyntheticPreflight(`
    $root='C:\\Program Files\\Shadow'
    foreach($directory in @(
      'C:\\Program Files', $root, "$root\\resources", "$root\\resources\\backend",
      "$root\\resources\\backend\\dist", "$root\\resources\\backend\\dist\\src",
      "$root\\resources\\backend\\node_modules", "$root\\resources\\service"
    )) { Add-Item $directory ([IO.FileAttributes]::Directory) }
    foreach($file in @(
      'Shadow.exe','resources\\backend\\dist\\src\\index.js',
      'resources\\backend\\node_modules\\dependency.cjs',
      'resources\\service\\ShadowService.exe','resources\\service\\manage.ps1',
      'resources\\service\\stop.cjs','resources\\service\\probe.cjs'
    )) { Add-Item "$root\\$file" ([IO.FileAttributes]::Normal) }
    $verified=Assert-MachineWideApplication $root 'C:\\Program Files'
    if($verified -cne $root){throw 'Wrong canonical application root'}
    foreach($required in @(
      "$root\\Shadow.exe", "$root\\resources\\backend\\dist\\src\\index.js",
      "$root\\resources\\backend\\node_modules\\dependency.cjs",
      "$root\\resources\\service\\stop.cjs", "$root\\resources\\service\\probe.cjs"
    )) { if(-not $script:aclReads.Contains($required)){throw 'Missing executable/dependency/helper ACL inspection'} }

    $script:aclOverrides["$root\\resources\\backend\\node_modules\\dependency.cjs"]=New-SyntheticAcl 'S-1-5-19' 'ReadAndExecute' 'Deny'
    Expect-Rejection {Assert-MachineWideApplication $root 'C:\\Program Files'} 'deny'
    $script:aclOverrides.Clear()
    $script:aclOverrides['C:\\Program Files']=New-SyntheticAcl 'S-1-5-19' 'Read'
    Expect-Rejection {Assert-MachineWideApplication $root 'C:\\Program Files'} 'read/execute'
    $script:aclOverrides.Clear()

    $link="$root\\resources\\backend\\linked"
    Add-Item $link ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)
    Expect-Rejection {Assert-MachineWideApplication $root 'C:\\Program Files'} 'reparse'
    if($script:enumerated.Contains($link)){throw 'Must never follow an application junction'}
  `)
})

test('installer preflight precedes every top-level data/SCM branch and saved executable is checked before start', async () => {
  const source = await readFile(scriptPath, 'utf8')
  const preflight = source.indexOf('$applicationRoot = Assert-MachineWideApplication')
  const dataSelection = source.indexOf('$DataDirectory = Get-AbsoluteLocalPath $DataDirectory')
  const scmRead = source.indexOf('$existing = Get-OwnedService')
  const dataCreation = source.indexOf('New-ProtectedDirectory $DataDirectory $readAcl')
  assert.ok(preflight > 0 && preflight < dataSelection && preflight < scmRead && preflight < dataCreation)
  for (const action of ['Status', 'Stop', 'Uninstall', 'Start']) {
    assert.ok(preflight < source.indexOf(`if ($Action -eq '${action}')`))
  }
  const start = source.slice(source.indexOf("if ($Action -eq 'Start')"), source.indexOf('if (-not $DesktopUser)'))
  assert.ok(start.indexOf('$install.executablePath -ine $executable') < start.indexOf("Invoke-Wrapper 'start'"))
  assert.match(source, /SpecialFolder\]::ProgramFiles/)
  assert.match(source, /Is64BitProcess/)
})
