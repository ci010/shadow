import assert from 'node:assert/strict'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopTarget, type DesktopTarget } from './desktop-target.ts'

export function sanitizeLog(value: unknown, secrets: readonly string[] = [], limit = 12_000): string {
  let text = String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .slice(-limit)
}

export async function bounded<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function isolatedEnvironment(scratch: string, token: string, port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: scratch,
    TMP: scratch,
    TMPDIR: scratch,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, 'profile', 'config'),
    XDG_CACHE_HOME: join(scratch, 'profile', 'cache'),
    XDG_DATA_HOME: join(scratch, 'profile', 'data'),
    USERPROFILE: scratch,
    APPDATA: join(scratch, 'profile', 'roaming'),
    LOCALAPPDATA: join(scratch, 'profile', 'local'),
    ELECTRON_RUN_AS_NODE: '1',
    WINDOWS_USE_LAUNCH_TOKEN: token,
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '*',
  }
}

export function relocatedPackageRoot(scratch: string, target: DesktopTarget = desktopTarget()): string {
  return join(scratch, target.platform === 'darwin' ? 'Shadow.app' : 'application')
}

export function assertMacIconEncoding(icon: Buffer): void {
  assert.ok(icon.length >= 8 && icon.toString('ascii', 0, 4) === 'icns', 'Invalid ICNS header')
  assert.equal(icon.readUInt32BE(4), icon.length, 'Invalid ICNS file length')
  const entries = new Map<string, Buffer>()
  for (let offset = 8; offset < icon.length;) {
    assert.ok(offset + 8 <= icon.length, 'Truncated ICNS entry header')
    const type = icon.toString('ascii', offset, offset + 4)
    const length = icon.readUInt32BE(offset + 4)
    assert.ok(length > 8 && offset + length <= icon.length, `Invalid ICNS entry length: ${type}`)
    assert.ok(!entries.has(type), `Duplicate ICNS entry: ${type}`)
    entries.set(type, icon.subarray(offset + 8, offset + length))
    offset += length
  }
  // PNG in icp4/icp5/icp6 renders as noise in Finder (electron-builder#9980).
  for (const type of ['icp4', 'icp5', 'icp6']) {
    assert.ok(!entries.has(type), `Unsupported macOS icon encoding: ${type}; rebuild with electron-builder >=26.16.0`)
  }
  for (const type of ['ic04', 'ic05']) {
    const payload = entries.get(type)
    assert.ok(payload && payload.length > 4 && payload.toString('ascii', 0, 4) === 'ARGB',
      `macOS small icon ${type} must use ARGB encoding`)
  }
}

export async function createVerificationDirectory(parent = tmpdir()): Promise<string> {
  // macOS /var is an OS alias; generated data paths must use /private/var.
  return mkdtemp(join(await realpath(parent), 'shadow-packaged-acceptance-'))
}

export function backendCommand(
  packagedRoot: string, bootstrap: string, target: DesktopTarget = desktopTarget(),
): { executable: string; args: string[] } {
  return {
    executable: join(packagedRoot, target.executableRelativePath),
    args: [
      join(packagedRoot, target.resourcesRelativePath, 'backend', 'dist', 'src', 'index.js'),
      'server', 'start', '--config', bootstrap, '--service',
    ],
  }
}

export function packagedEvalCommand(
  packagedRoot: string, script: string, target: DesktopTarget = desktopTarget(),
): { executable: string; args: string[] } {
  const runtime = join(packagedRoot, target.resourcesRelativePath, 'backend', 'dist', 'src', 'script-runtime', 'runtime.js')
  return {
    executable: join(packagedRoot, target.executableRelativePath),
    args: ['--input-type=module', '-e', `
      import { readFile } from 'node:fs/promises';
      import { dirname } from 'node:path';
      const { executeScript } = await import(process.argv[1]);
      const filename = process.argv[2];
      const result = await executeScript({
        code: await readFile(filename, 'utf8'), filename, cwd: dirname(filename),
        args: [], entry: 'run', policy: { kind: 'host' },
        signal: AbortSignal.timeout(10_000), timeoutMs: 10_000, env: process.env,
      });
      console.log('SHADOW_PACKAGED_EVAL_RESULT=' + JSON.stringify({ result: result.value }));
    `, pathToFileURL(runtime).href, script],
  }
}

export function serviceEnvironment(scratch: string, credentialFile: string, port: number): NodeJS.ProcessEnv {
  assert.ok(isAbsolute(credentialFile), 'Service smoke credential path must be absolute')
  const env = isolatedEnvironment(scratch, '', port)
  delete env.WINDOWS_USE_LAUNCH_TOKEN
  env.WINDOWS_USE_LAUNCH_TOKEN_FILE = credentialFile
  return env
}

export interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export function startProcess(executable: string, args: string[], options: SpawnOptions, secrets: string[] = [], outputLimit = 24_000) {
  const child = spawn(executable, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  // Keep the raw tail private: secrets split across pipe chunks must still be redacted.
  let tail = ''
  const capture = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-outputLimit) }
  child.stdout!.on('data', capture)
  child.stderr!.on('data', capture)
  let result: ProcessResult | undefined
  let spawnError: Error | undefined
  child.on('error', (error) => { spawnError = error })
  const completion = new Promise<ProcessResult>((done) => {
    child.once('close', (code, signal) => {
      result = { code, signal, error: spawnError }
      done(result)
    })
  })
  return {
    child,
    completion,
    result: () => result,
    logs: () => sanitizeLog(tail, secrets, outputLimit),
  }
}

export type ManagedProcess = ReturnType<typeof startProcess>

export async function waitForOutput(process: ManagedProcess, marker: string, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (process.logs().includes(marker)) return
    if (process.result() || process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(`Process exited before ${marker}:\n${process.logs()}`)
    }
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`Process output ${marker} timed out:\n${process.logs()}`)
}

export async function waitSuccessful(process: ManagedProcess, milliseconds: number, label: string): Promise<void> {
  const result = await bounded(process.completion, milliseconds, label)
  if (result.error || result.code !== 0 || result.signal) {
    throw new Error(`${label} failed (code ${result.code}, signal ${result.signal}): ${result.error?.message ?? ''}\n${process.logs()}`)
  }
}

export async function terminateProcess(child: ChildProcess, milliseconds = 5_000): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((done) => child.once('close', () => done()))
  child.kill('SIGKILL')
  await bounded(closed, milliseconds, `Terminate process ${child.pid}`)
}

export async function runCommand(
  executable: string, args: string[], options: SpawnOptions, milliseconds: number, label: string, secrets: string[] = [], outputLimit = 24_000,
): Promise<string> {
  const process = startProcess(executable, args, options, secrets, outputLimit)
  try {
    await waitSuccessful(process, milliseconds, label)
    return process.logs()
  } finally {
    await terminateProcess(process.child)
  }
}

export async function fetchBounded(
  url: string, init: RequestInit = {}, milliseconds = 3_000,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), milliseconds)
  try {
    return await bounded((async () => {
      const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > 2_000_000) throw new Error(`Response exceeds 2MB: ${new URL(url).pathname}`)
            chunks.push(value)
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
      }
      return { status: response.status, body: Buffer.concat(chunks).toString('utf8') }
    })(), milliseconds + 100, `HTTP ${new URL(url).pathname}`)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function waitReady(
  origin: string, headers: Record<string, string>, process: ManagedProcess, milliseconds = 45_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds
  let last = 'No response'
  while (Date.now() < deadline) {
    const result = process.result()
    if (result || process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(`Backend exited before readiness (code ${result?.code ?? process.child.exitCode}):\n${process.logs()}`)
    }
    try {
      const response = await fetchBounded(`${origin}/local/v1/readiness`, { headers }, Math.min(500, deadline - Date.now()))
      last = `HTTP ${response.status}`
      if (response.status === 200) {
        assert.equal(JSON.parse(response.body).status, 'ready')
        return
      }
      if (response.status === 401 || response.status === 403) throw new Error(`Readiness authentication rejected: ${last}`)
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof DOMException) && !String(error).includes('timed out')) throw error
      last = String(error)
    }
    await new Promise((done) => setTimeout(done, Math.min(100, Math.max(0, deadline - Date.now()))))
  }
  throw new Error(`Backend readiness timed out: ${last}\n${process.logs()}`)
}

export async function reservePort(): Promise<number> {
  const server = createServer()
  return bounded(new Promise<number>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to reserve loopback port'))
        return
      }
      server.close((error) => error ? reject(error) : done(address.port))
    })
  }), 5_000, 'Reserve port').finally(() => { if (server.listening) server.close() })
}

export function assertOutsideRepository(directory: string, repository: string): void {
  const path = relative(resolve(repository), resolve(directory))
  assert.ok(path && (path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)),
    'Packaged acceptance must relocate the entire application outside the repository')
}

export async function verifyRendererArtifacts(packagedRoot: string, target: DesktopTarget = desktopTarget()): Promise<void> {
  const renderer = join(packagedRoot, target.resourcesRelativePath, 'app-dist')
  const html = await readFile(join(renderer, 'index.html'), 'utf8')
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1]!).filter((path) => path.startsWith('./assets/') || path.startsWith('/assets/') || path.startsWith('assets/'))
  assert.ok(assets.some((path) => /\.js(?:[?#]|$)/.test(path)), 'Renderer HTML lacks a bundled JavaScript entry')
  for (const asset of assets) {
    const path = resolve(renderer, asset.replace(/^\.?\//, '').split(/[?#]/)[0]!)
    const relativePath = relative(renderer, path)
    assert.ok(!relativePath.startsWith('..') && !isAbsolute(relativePath), 'Renderer asset escapes package')
    assert.ok((await stat(path)).size > 0, `Empty renderer asset: ${relativePath}`)
  }
}

export async function prepareRendererSmoke(
  packagedRoot: string, scratch: string, fixture: string, target: DesktopTarget = desktopTarget(),
) {
  const resources = join(packagedRoot, target.resourcesRelativePath)
  const originalArchive = join(resources, 'acceptance-production.asar')
  // The verified production archive stays byte-for-byte intact. Only this disposable copy gets a synthetic entry.
  await rename(join(resources, 'app.asar'), originalArchive)
  const entry = join(resources, 'app')
  await mkdir(entry)
  await writeFile(join(entry, 'package.json'), JSON.stringify({ name: 'shadow-packaged-acceptance', version: '0.0.0', main: 'fixture.cjs' }))
  await writeFile(join(entry, 'fixture.cjs'), fixture)
  const control = join(scratch, 'renderer-control')
  return {
    executable: join(packagedRoot, target.executableRelativePath),
    args: [
      `--acceptance-assets=${join(resources, 'app-dist')}`,
      `--acceptance-preload=${join(originalArchive, 'dist', 'preload.cjs')}`,
      `--acceptance-profile=${join(scratch, 'renderer-profile')}`,
      `--acceptance-control=${control}`,
    ],
    control,
  }
}

export function rendererSignatureCommands(
  packagedRoot: string, scratch: string, target: DesktopTarget = desktopTarget(),
): Array<{ executable: string; args: string[] }> {
  if (target.platform !== 'darwin') return []
  assert.equal(resolve(packagedRoot), resolve(relocatedPackageRoot(scratch, target)), 'Only the disposable renderer bundle may be re-signed')
  // The synthetic entry changes the resource seal. Keep nested binaries and JIT entitlements intact.
  return [
    {
      executable: '/usr/bin/codesign',
      args: ['--force', '--sign', '-', '--timestamp=none',
        '--preserve-metadata=identifier,entitlements,requirements,flags,runtime', packagedRoot],
    },
    { executable: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', packagedRoot] },
  ]
}

export function rendererEnvironment(scratch: string, target: DesktopTarget = desktopTarget()): NodeJS.ProcessEnv {
  const env = isolatedEnvironment(scratch, '', 0)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.WINDOWS_USE_LAUNCH_TOKEN
  delete env.GATEWAY_PORT
  delete env.GATEWAY_HOST
  if (target.platform === 'linux') {
    env.DISPLAY = process.env.DISPLAY
    env.XAUTHORITY = process.env.XAUTHORITY
  }
  return env
}

export const nodeModeProbe = `
let guiApis = false;
try { const electron = require('electron'); guiApis = !!(electron.app || electron.BrowserWindow); } catch {}
const report = {
  electron: process.versions.electron,
  node: process.versions.node,
  processType: process.type ?? null,
  guiApis,
  memoryUsage: process.memoryUsage(),
  label: 'Electron Node runtime baseline only; not backend RSS or a memory budget'
};
console.log('SHADOW_NODE_PROBE=' + JSON.stringify(report));
if (!report.electron || report.processType !== null || guiApis) process.exitCode = 1;
`

export interface ProcessIdentity {
  pid: number
  parentPid: number
  created: string
  gui: boolean
  workingSetBytes?: number
  cpuSeconds?: number
}

export function backendResourceReport(identity: ProcessIdentity, platform = process.platform) {
  assert.ok(Number.isFinite(identity.workingSetBytes) && identity.workingSetBytes! > 0, 'Backend working set unavailable')
  assert.ok(Number.isFinite(identity.cpuSeconds) && identity.cpuSeconds! >= 0, 'Backend cumulative CPU time unavailable')
  return {
    pid: identity.pid,
    workingSetBytes: identity.workingSetBytes,
    cumulativeCpuSeconds: identity.cpuSeconds,
    label: `Actual backend PID sample; ${platform === 'win32' ? 'Windows working set' : 'POSIX resident set'} and lifetime CPU time, not CPU utilization or a memory budget. Descendants excluded.`,
  }
}

export function descendants(snapshot: ProcessIdentity[], root: ProcessIdentity): ProcessIdentity[] {
  // A departed/reused parent PID cannot establish ownership of newly observed processes.
  if (!snapshot.some(value => value.pid === root.pid && value.created === root.created)) return []
  const result: ProcessIdentity[] = []
  const queue = [root]
  const seen = new Set([root.pid])
  for (const parent of queue) {
    for (const process of snapshot) {
      if (process.parentPid !== parent.pid || seen.has(process.pid) || process.created < parent.created) continue
      seen.add(process.pid)
      queue.push(process)
      result.push(process)
    }
  }
  return result
}

export async function snapshotProcesses(milliseconds = 10_000): Promise<ProcessIdentity[]> {
  if (process.platform !== 'win32') {
    assert.ok(process.platform === 'darwin' || process.platform === 'linux', 'Unsupported process census platform')
    // Never return/log other applications' command lines, including on ps failure.
    let text: string
    const outputLimit = 4_000_000
    try {
      text = await runCommand('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,rss=,time=,args='],
        { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' } }, milliseconds, 'POSIX process census', [], outputLimit)
    } catch {
      throw new Error('POSIX process census failed')
    }
    assert.ok(text.length < outputLimit, 'POSIX process census exceeded output limit')
    return parsePosixProcesses(text)
  }
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `@(
    Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $null -ne $_.CreationDate } | ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        created = $_.CreationDate.ToUniversalTime().ToString('o')
        gui = [bool]($_.CommandLine -match '--type=(renderer|gpu-process|utility)' )
        workingSetBytes = [double]$_.WorkingSetSize
        cpuSeconds = (([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000000)
      }
    }
  ) | ConvertTo-Json -Compress`
  // Do not export command lines: they may belong to other applications or contain credentials.
  const text = await runCommand(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {}, milliseconds, 'Process census', [], 1_000_000)
  const parsed: unknown = JSON.parse(text)
  assert.ok(Array.isArray(parsed), 'Invalid process census')
  for (const value of parsed) {
    assert.ok(value && Number.isInteger(value.pid) && Number.isInteger(value.parentPid) &&
      typeof value.created === 'string' && typeof value.gui === 'boolean' &&
      Number.isFinite(value.workingSetBytes) && value.workingSetBytes >= 0 &&
      Number.isFinite(value.cpuSeconds) && value.cpuSeconds >= 0, 'Invalid process identity')
  }
  return parsed as ProcessIdentity[]
}

export function remainingBudget(deadline: number, maximum: number): number {
  const remaining = Math.min(maximum, deadline - Date.now())
  assert.ok(remaining > 0, 'Process cleanup deadline exceeded')
  return remaining
}

export async function killWindowsTree(identity: ProcessIdentity, deadline = Date.now() + 18_000): Promise<void> {
  assert.equal(process.platform, 'win32')
  const current = await snapshotProcesses(remainingBudget(deadline, 10_000))
  if (!current.some((value) => value.pid === identity.pid && value.created === identity.created)) return
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  await runCommand(executable, ['/PID', String(identity.pid), '/T', '/F'], {}, remainingBudget(deadline, 8_000), `Terminate owned process tree ${identity.pid}`)
}

export function parsePosixProcesses(text: string): ProcessIdentity[] {
  const seen = new Set<number>()
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    assert.ok(match, 'Invalid POSIX process census row')
    const [, pidText, parentText, started, rss, time, command = ''] = match
    const pid = Number(pidText)
    const parentPid = Number(parentText)
    const timestamp = Date.parse(`${started} UTC`)
    const cpu = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(time!)
    assert.ok(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parentPid) &&
      !seen.has(pid) && Number.isFinite(timestamp) && cpu, 'Invalid POSIX process identity')
    const [, days, hours, minutes, seconds] = cpu
    const cpuSeconds = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
    const workingSetBytes = Number(rss) * 1024
    assert.ok(Number.isSafeInteger(workingSetBytes) && Number.isFinite(cpuSeconds), 'Invalid POSIX process metrics')
    seen.add(pid)
    return {
      pid, parentPid, created: new Date(timestamp).toISOString(),
      gui: /(?:^|\s)--type=(?:renderer|gpu-process|utility)(?:\s|$)/.test(command),
      workingSetBytes, cpuSeconds,
    }
  })
}

interface PosixProcessControl {
  snapshot(milliseconds: number): Promise<ProcessIdentity[]>
  signal(pid: number, signal: NodeJS.Signals): void
}

export async function killPosixTree(
  identity: ProcessIdentity, deadline = Date.now() + 18_000,
  control: PosixProcessControl = { snapshot: snapshotProcesses, signal: (pid, signal) => { process.kill(pid, signal) } },
): Promise<void> {
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 1 && identity.pid !== process.pid, 'Unsafe owned process PID')
  const matches = (value: ProcessIdentity, owned: ProcessIdentity) => value.pid === owned.pid && value.created === owned.created
  const initial = await control.snapshot(remainingBudget(deadline, 10_000))
  if (!initial.some(value => matches(value, identity))) return
  const owned = [...descendants(initial, identity).reverse(), identity]
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const value of owned) {
      assert.ok(value.pid > 1 && value.pid !== process.pid, 'Unsafe owned process PID')
      const current = await control.snapshot(remainingBudget(deadline, 10_000))
      if (!current.some(candidate => matches(candidate, value))) continue
      try { control.signal(value.pid, signal) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
    const settleDeadline = Math.min(deadline, Date.now() + (signal === 'SIGTERM' ? 1_000 : 5_000))
    do {
      const current = await control.snapshot(remainingBudget(deadline, 10_000))
      if (!current.some(value => owned.some(candidate => matches(value, candidate)))) return
      if (Date.now() >= settleDeadline) break
      await new Promise(done => setTimeout(done, Math.min(100, settleDeadline - Date.now())))
    } while (Date.now() < settleDeadline)
  }
  const remaining = await control.snapshot(remainingBudget(deadline, 10_000))
  assert.ok(!remaining.some(value => owned.some(candidate => matches(value, candidate))), 'Owned POSIX processes survived cleanup')
}

export async function killProcessTree(identity: ProcessIdentity, deadline?: number): Promise<void> {
  if (process.platform === 'win32') await killWindowsTree(identity, deadline)
  else await killPosixTree(identity, deadline)
}
