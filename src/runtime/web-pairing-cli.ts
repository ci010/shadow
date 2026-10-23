import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { NodeProtectedKeyCommandRunner } from '../cluster/protected-device-key-stores.ts'

export type PairOptions = { connection: string } | { url: string; credentialFile: string }

export function parsePairArguments(args: readonly string[]): PairOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag || !['--connection', '--url', '--credential-file'].includes(flag) || !value || values.has(flag)) {
      throw new Error('Use --connection <absolute descriptor> or --url <loopback origin> --credential-file <absolute file>')
    }
    values.set(flag, value)
  }
  if (values.size === 1 && values.has('--connection')) {
    return { connection: requireLocalPath(values.get('--connection')) }
  }
  if (values.size === 2 && values.has('--url') && values.has('--credential-file')) {
    return { url: requireLoopbackOrigin(values.get('--url')), credentialFile: requireLocalPath(values.get('--credential-file')) }
  }
  throw new Error('Select exactly one connection source; credentials must never be supplied as arguments')
}

export async function loadPairConnection(options: PairOptions): Promise<{ apiBase: string; token: string }> {
  try {
    let apiBase: string
    let credentialPath: string
    let protection: string | undefined
    if ('connection' in options) {
      if (process.platform === 'win32') await assertProtectedWindowsFile(options.connection)
      const descriptor = parseConnectionDescriptor(JSON.parse((await readBoundedLocalFile(options.connection)).toString('utf8')))
      apiBase = descriptor.apiBase
      credentialPath = descriptor.credentialPath
      if ('credentialProtection' in descriptor) protection = descriptor.credentialProtection
    } else {
      apiBase = requireLoopbackOrigin(options.url)
      credentialPath = requireLocalPath(options.credentialFile)
    }
    if ((protection === 'windows-dpapi-current-user' && process.platform !== 'win32')
      || (protection === 'unix-owner-only' && process.platform === 'win32')) throw new Error('Unsupported protection')
    if (process.platform === 'win32') await assertProtectedWindowsFile(credentialPath)
    let bytes = await readBoundedLocalFile(credentialPath, protection === 'windows-dpapi-current-user' ? 16_384 : 1024)
    if (protection === 'windows-dpapi-current-user') bytes = await unprotectCredential(bytes)
    return { apiBase, token: requireLaunchToken(bytes.toString('utf8')) }
  } catch {
    throw new Error('Cannot load the connection or protected credential. Check its path, permissions, and desktop readiness.')
  }
}

export async function createWebPairing(
  connection: { apiBase: string; token: string },
  request: typeof fetch = fetch,
): Promise<string> {
  try {
    const apiBase = requireLoopbackOrigin(connection.apiBase)
    const token = requireLaunchToken(connection.token)
    const response = await request(`${apiBase}/local/v1/web-pairing`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok || !response.body) throw new Error('Pairing request failed')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 4096) throw new Error('Invalid pairing response')
        chunks.push(part.value)
      }
    } finally { await reader.cancel() }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (result.version !== 1 || requireLoopbackOrigin(result.url) !== apiBase
      || typeof result.code !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/u.test(result.code)
      || result.code.includes(token) || typeof result.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()
      || Date.parse(result.expiresAt) > Date.now() + 5 * 60_000 + 5000) throw new Error('Invalid pairing response')
    return `Open ${apiBase}/\nOne-use pairing code: ${result.code}\nExpires: ${new Date(result.expiresAt).toISOString()}\n`
  } catch {
    // Do not surface response bodies, transport errors, or filesystem contents.
    throw new Error('Could not create a Web pairing code. Ensure the selected Main is ready and the launch credential is valid.')
  }
}

export async function runWebPair(args: readonly string[], output: (text: string) => void = console.log): Promise<void> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output([
      'Usage:',
      '  web pair --connection <absolute connection descriptor>',
      '  web pair --url http://127.0.0.1:<port> --credential-file <absolute protected credential file>',
      '',
      'Source checkout: pnpm web:pair <options>',
      'Only literal loopback HTTP origins are accepted. Never pass a credential as an argument.',
      'The command prints the browser URL and a short-lived one-use pairing code, not the launch credential.',
    ].join('\n'))
    return
  }
  const options = parsePairArguments(args)
  output(await createWebPairing(await loadPairConnection(options)))
}

function requireLocalPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)
    || /[\u0000-\u001f]/u.test(value)
    || (process.platform === 'win32' && (!/^[A-Za-z]:\\/u.test(value) || value.slice(2).includes(':')))) {
    throw new Error('An absolute local file path is required')
  }
  return value
}

function requireLoopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('A loopback HTTP origin is required')
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      && (value === url.origin || value === `${url.origin}/`)) return url.origin
  } catch { /* report only a safe validation error */ }
  throw new Error('A canonical loopback HTTP origin is required')
}

interface PairConnectionDescriptor {
  apiBase: string
  credentialPath: string
  credentialProtection?: 'windows-dpapi-current-user' | 'unix-owner-only'
}

function parseConnectionDescriptor(value: unknown): PairConnectionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection descriptor')
  const data = value as Record<string, unknown>
  if (data.version !== 1 || requireLoopbackOrigin(data.apiBase) !== data.apiBase) throw new Error('Invalid connection descriptor')
  const credentialPath = requireLocalPath(data.credentialPath)
  if (data.kind === 'desktop') {
    if (Object.keys(data).length !== 6
      || (data.credentialProtection !== 'windows-dpapi-current-user' && data.credentialProtection !== 'unix-owner-only')
      || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))
      || new Date(data.expiresAt).toISOString() !== data.expiresAt
      || Date.parse(data.expiresAt) <= Date.now() || Date.parse(data.expiresAt) > Date.now() + 5 * 60_000) {
      throw new Error('Invalid or expired desktop connection descriptor')
    }
    return { apiBase: data.apiBase as string, credentialPath, credentialProtection: data.credentialProtection }
  }
  if (Object.keys(data).length !== 7 || data.serviceName !== 'ShadowService' || data.role !== 'main'
    || !Number.isSafeInteger(data.port) || (data.port as number) < 1 || (data.port as number) > 65535
    || Number(new URL(data.apiBase as string).port || '80') !== data.port) throw new Error('Invalid service connection descriptor')
  requireLocalPath(data.configPath)
  return { apiBase: data.apiBase as string, credentialPath }
}

async function readBoundedLocalFile(path: string, maximum = 16_384): Promise<Buffer> {
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
  } finally { await file.close() }
}

function requireLaunchToken(value: string): string {
  const token = value.trim()
  if (!/^[A-Za-z0-9_-]{43,256}$/u.test(token)) throw new Error('Invalid launch credential')
  return token
}

async function runCredentialCommand(script: string, input: string): Promise<string> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = await new NodeProtectedKeyCommandRunner().run(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);'
        + '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference="Stop";' + script],
    Buffer.from(input), AbortSignal.timeout(10_000))
  if (!result.success || result.stdout.length > 16_384) throw new Error('Protected credential could not be read')
  return Buffer.from(result.stdout).toString('utf8').trim()
}

async function unprotectCredential(bytes: Buffer): Promise<Buffer> {
  const result = await runCredentialCommand([
    '[void][Reflection.Assembly]::LoadWithPartialName("System.Security")',
    '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
    '$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join(';'), bytes.toString('base64'))
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(result) || result.length === 0) {
    throw new Error('Invalid Windows protected credential')
  }
  return Buffer.from(result, 'base64')
}

async function assertProtectedWindowsFile(path: string): Promise<void> {
  const result = await runCredentialCommand([
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
