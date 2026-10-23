import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { probe } = require('../../service/probe.cjs') as {
  probe(path: string, options: {
    read: (path: string) => Promise<string>
    request: (url: string, init: RequestInit) => Promise<Response>
    delay?: (ms: number) => Promise<void>
    attempts?: number
  }): Promise<void>
}

test('packaged probe sends no credential on CLI and validates authoritative readiness', async () => {
  const token = 's'.repeat(43)
  let requests = 0
  await probe('descriptor', {
    read: async (path) => path === 'token' ? token : JSON.stringify({
      version: 1, serviceName: 'ShadowService', role: 'main', port: 18800,
      apiBase: 'http://127.0.0.1:18800', credentialPath: 'token',
    }),
    request: async (url, init) => {
      requests++
      assert.equal(url, 'http://127.0.0.1:18800/local/v1/readiness')
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`)
      assert.equal(init.redirect, 'error')
      return Response.json({ version: 1, role: 'main', status: 'ready' })
    },
  })
  assert.equal(requests, 1)
})

test('packaged readiness is bounded and rejects bad role rather than retrying or falling back', async () => {
  const read = async (path: string) => path === 'token' ? 's'.repeat(43) : JSON.stringify({
    version: 1, serviceName: 'ShadowService', role: 'main', port: 18800,
    apiBase: 'http://127.0.0.1:18800', credentialPath: 'token',
  })
  let requests = 0
  await assert.rejects(probe('descriptor', {
    read, attempts: 2, delay: async () => undefined,
    request: async () => { requests++; throw new Error('unavailable') },
  }), /timed out/)
  assert.equal(requests, 2)
  await assert.rejects(probe('descriptor', {
    read,
    request: async () => Response.json({ version: 1, role: 'child', status: 'ready' }),
  }), /mismatch/)
})

test('management script parses without running or installing any service', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['manage.ps1']) {
    const path = fileURLToPath(new URL(`../../service/${name}`, import.meta.url))
    const command = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
  }
})

test('directory DACL grants only system/admin, LocalService and explicitly selected user', { skip: process.platform !== 'win32' }, () => {
  const path = fileURLToPath(new URL('../../service/manage.ps1', import.meta.url))
  // Extract only the pure ACL constructor; never execute the management script.
  const command = `
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
    $function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-DirectoryAcl'}, $true)
    Invoke-Expression $function.Extent.Text
    $acl=New-DirectoryAcl 'ReadAndExecute' 'S-1-5-21-100-200-300-1001'
    if (-not $acl.AreAccessRulesProtected) { throw 'Inheritance must be disabled' }
    $rules=@($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 4) { throw 'Unexpected principals' }
    if (@($rules | Where-Object { $_.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544','S-1-5-19','S-1-5-21-100-200-300-1001') }).Count) { throw 'Broad access' }
    $desktop=@($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-21-100-200-300-1001' })[0]
    if (($desktop.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0) { throw 'Desktop cannot write control files' }
    $data=New-DirectoryAcl 'Modify' ''
    if (@($data.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])).Count -ne 3) { throw 'Desktop cannot read service data' }
  `
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
})

test('generated WinSW XML runs the plain Node stop helper with quoted paths and inherited Node mode', { skip: process.platform !== 'win32' }, () => {
  const path = fileURLToPath(new URL('../../service/manage.ps1', import.meta.url))
  // Evaluate only pure string/XML construction from the real installer source.
  const command = `
    $ErrorActionPreference='Stop'
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
    foreach($name in @('Escape-Xml','Quote-Argument')) {
      $fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
      Invoke-Expression $fn.Extent.Text
    }
    $DataDirectory='C:\\Service & Data'
    $control=Join-Path $DataDirectory 'control'
    $data=Join-Path $DataDirectory 'data'
    $executable='C:\\Program Files\\Shadow\\Shadow.exe'
    $entry='C:\\Program Files\\Shadow\\resources\\backend\\dist\\src\\index.js'
    $configPath=Join-Path $control 'runtime-config.v1.json'
    $descriptorPath=Join-Path $control 'connection.v1.json'
    $credentialPath=Join-Path $control 'launch-token'
    $Port=18800
    foreach($name in @('startArguments','stopScript','stopArguments','xml')) {
      $assignment=$ast.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -eq $name}, $true)
      Invoke-Expression $assignment.Extent.Text
    }
    $document=[xml]$xml
    if($document.service.stopexecutable -cne $executable) { throw 'SCM stop must use packaged Shadow.exe' }
    $expected='"C:\\Service & Data\\control\\stop.cjs" "C:\\Service & Data\\control\\connection.v1.json"'
    if($document.service.stoparguments -cne $expected) { throw 'Stop arguments must be quoted and policy independent' }
    if($document.service.stoparguments -match '\\.ps1|-File|-ExecutionPolicy') { throw 'No runtime script-policy dependency' }
    $nodeEnv=@($document.service.env | Where-Object { $_.name -eq 'ELECTRON_RUN_AS_NODE' })
    if($nodeEnv.Count -ne 1 -or $nodeEnv[0].value -ne '1') { throw 'Stop process must inherit Electron Node mode' }
  `
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
})

test('SCM resources enforce real WinSW, account/ACL isolation and authenticated bounded stopping', async () => {
  const manage = await readFile(new URL('../../service/manage.ps1', import.meta.url), 'utf8')
  const stop = await readFile(new URL('../../service/stop.cjs', import.meta.url), 'utf8')
  assert.match(manage, /<user>LocalService<\/user>/)
  assert.match(manage, /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(manage, /CreateDirectory\(\$Path, \$Acl\)/)
  assert.match(manage, /WINDOWS_USE_LAUNCH_TOKEN_FILE/)
  assert.match(manage, /<startarguments>/)
  assert.match(manage, /<stoparguments>/)
  assert.match(manage, /<stopexecutable>\$\(Escape-Xml \$executable\)<\/stopexecutable>/)
  assert.match(manage, /\$stopScript = Join-Path \$control 'stop\.cjs'/)
  assert.match(manage, /MachinePolicy\/UserPolicy/)
  assert.doesNotMatch(manage, /stop\.ps1|Set-ExecutionPolicy/)
  assert.match(manage, /Invoke-Wrapper 'install'/)
  assert.doesNotMatch(manage, /LocalSystem|schtasks|Start-Process.*-Verb\s+RunAs|chmod/i)
  assert.match(stop, /\/local\/v1\/shutdown/)
  assert.match(stop, /GRACE_MS = 25_000/)
  assert.match(stop, /CreationDate\.ToUniversalTime\(\)/)
  assert.match(stop, /\/PID \$\{backend\.pid\} \/T \/F/)
  assert.doesNotMatch(stop, /'-File'|'-ExecutionPolicy'|Set-ExecutionPolicy/)
  assert.doesNotMatch(stop, /Stop-Process -Name|taskkill.*\/IM/i)
})
