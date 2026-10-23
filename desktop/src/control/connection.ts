import { spawn } from 'node:child_process'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { normalizeLoopbackOrigin } from '../runtime-authorization.js'
import { parseServiceConnectionDescriptor } from '../service/connection.js'

export const CONNECTION_MAX_BYTES = 16_384
export const CONNECTION_LEASE_MS = 5 * 60_000
export type CredentialProtection = 'windows-dpapi-current-user' | 'unix-owner-only'

export interface DesktopConnectionDescriptor {
  version: 1
  kind: 'desktop'
  apiBase: string
  credentialPath: string
  credentialProtection: CredentialProtection
  expiresAt: string
}

export function requireLocalPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)
    || /[\u0000-\u001f]/u.test(value)
    || (process.platform === 'win32' && (!/^[A-Za-z]:\\/u.test(value) || value.slice(2).includes(':')))) {
    throw new Error('An absolute local file path is required')
  }
  return value
}

export function requireLoopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('A loopback HTTP origin is required')
  const origin = normalizeLoopbackOrigin(value)
  if (origin === null || (value !== origin && value !== `${origin}/`)) {
    throw new Error('A canonical loopback HTTP origin is required')
  }
  return origin
}

export function parseConnectionDescriptor(value: unknown, now = Date.now()): DesktopConnectionDescriptor | ReturnType<typeof parseServiceConnectionDescriptor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection descriptor')
  const data = value as Record<string, unknown>
  if (data.kind !== 'desktop') return parseServiceConnectionDescriptor(value)
  if (Object.keys(data).length !== 6 || data.version !== 1
    || requireLoopbackOrigin(data.apiBase) !== data.apiBase
    || (data.credentialProtection !== 'windows-dpapi-current-user' && data.credentialProtection !== 'unix-owner-only')
    || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))
    || new Date(data.expiresAt).toISOString() !== data.expiresAt
    || Date.parse(data.expiresAt) <= now || Date.parse(data.expiresAt) > now + CONNECTION_LEASE_MS) {
    throw new Error('Invalid or expired desktop connection descriptor')
  }
  requireLocalPath(data.credentialPath)
  return data as unknown as DesktopConnectionDescriptor
}

export async function readBoundedLocalFile(path: string, maximum = CONNECTION_MAX_BYTES): Promise<Buffer> {
  requireLocalPath(path)
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error('Invalid control file')
  if (process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.())) {
    throw new Error('Control files must be owned by the current user and owner-only')
  }
  const file = await open(path, 'r')
  try {
    const current = await file.stat()
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size > maximum) {
      throw new Error('Control file changed')
    }
    const bytes = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > maximum) throw new Error('Control file is too large')
    return bytes.subarray(0, length)
  } finally {
    await file.close()
  }
}

export function requireLaunchToken(value: string): string {
  const token = value.trim()
  if (!/^[A-Za-z0-9_-]{43,256}$/u.test(token)) throw new Error('Invalid launch credential')
  return token
}

export type PowerShellRunner = (script: string, input: string) => Promise<string>

export const runPowerShell: PowerShellRunner = async (script, input) => {
  const powershellDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  const executable = join(powershellDirectory, 'powershell.exe')
  return await new Promise<string>((resolve, reject) => {
    const command = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);'
      + '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' + script
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal: AbortSignal.timeout(10_000),
      // Do not inherit incompatible PowerShell 7 modules from the parent shell.
      env: { ...process.env, PSModulePath: join(powershellDirectory, 'Modules') },
    })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > CONNECTION_MAX_BYTES) { child.kill(); return }
      chunks.push(chunk)
    })
    child.stdin.on('error', () => {})
    child.once('error', () => reject(new Error('Windows credential protection is unavailable')))
    child.once('close', (code) => {
      if (code !== 0 || size > CONNECTION_MAX_BYTES) reject(new Error('Windows credential protection failed'))
      else resolve(Buffer.concat(chunks).toString('utf8').trim())
    })
    child.stdin.end(input)
  })
}

export async function dpapi(
  operation: 'Protect' | 'Unprotect',
  bytes: Buffer,
  run: PowerShellRunner = runPowerShell,
): Promise<Buffer> {
  const result = await run([
    '$ErrorActionPreference="Stop"',
    '[void][Reflection.Assembly]::LoadWithPartialName("System.Security")',
    '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
    `$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join(';'), bytes.toString('base64'))
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(result) || result.length === 0) {
    throw new Error('Invalid Windows protected credential')
  }
  return Buffer.from(result, 'base64')
}

export async function assertProtectedWindowsFile(path: string, run: PowerShellRunner = runPowerShell): Promise<void> {
  const result = await run([
    '$ErrorActionPreference="Stop"',
    '$path=[Console]::In.ReadToEnd()',
    'if(([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "Invalid file"}',
    '$acl=[IO.File]::GetAccessControl($path)',
    '$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$allowed=@($user,"S-1-5-18","S-1-5-19","S-1-5-32-544")',
    'if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw "Invalid owner"}',
    '$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
    'if($rules.Count -eq 0){throw "Empty ACL"}',
    'foreach($rule in $rules){if($rule.AccessControlType -eq "Allow" -and $rule.IdentityReference.Value -notin $allowed){throw "Broad ACL"}}',
    '[Console]::Out.Write("ok")',
  ].join(';'), requireLocalPath(path))
  if (result !== 'ok') throw new Error('Credential file permissions are not restricted')
}
