import assert from 'node:assert/strict'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join, relative, resolve } from 'node:path'

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
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: join(scratch, 'profile', 'roaming'),
    LOCALAPPDATA: join(scratch, 'profile', 'local'),
    ELECTRON_RUN_AS_NODE: '1',
    WINDOWS_USE_LAUNCH_TOKEN: token,
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
  }
}

export function backendCommand(packagedRoot: string, bootstrap: string): { executable: string; args: string[] } {
  return {
    executable: join(packagedRoot, 'Shadow.exe'),
    args: [
      join(packagedRoot, 'resources', 'backend', 'dist', 'src', 'index.js'),
      'server', 'start', '--config', bootstrap, '--service',
    ],
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

export async function verifyRendererArtifacts(packagedRoot: string): Promise<void> {
  const renderer = join(packagedRoot, 'resources', 'app-dist')
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

export async function prepareRendererSmoke(packagedRoot: string, scratch: string, fixture: string) {
  const resources = join(packagedRoot, 'resources')
  const originalArchive = join(resources, 'acceptance-production.asar')
  // The verified production archive stays byte-for-byte intact. Only this disposable copy gets a synthetic entry.
  await rename(join(resources, 'app.asar'), originalArchive)
  const entry = join(resources, 'app')
  await mkdir(entry)
  await writeFile(join(entry, 'package.json'), JSON.stringify({ name: 'shadow-packaged-acceptance', version: '0.0.0', main: 'fixture.cjs' }))
  await writeFile(join(entry, 'fixture.cjs'), fixture)
  const control = join(scratch, 'renderer-control')
  return {
    executable: join(packagedRoot, 'Shadow.exe'),
    args: [
      `--acceptance-assets=${join(resources, 'app-dist')}`,
      `--acceptance-preload=${join(originalArchive, 'dist', 'preload.cjs')}`,
      `--acceptance-profile=${join(scratch, 'renderer-profile')}`,
      `--acceptance-control=${control}`,
    ],
    control,
  }
}

export function rendererEnvironment(scratch: string): NodeJS.ProcessEnv {
  const env = isolatedEnvironment(scratch, '', 0)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.WINDOWS_USE_LAUNCH_TOKEN
  delete env.GATEWAY_PORT
  delete env.GATEWAY_HOST
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

export function backendResourceReport(identity: ProcessIdentity) {
  assert.ok(Number.isFinite(identity.workingSetBytes) && identity.workingSetBytes! > 0, 'Backend working set unavailable')
  assert.ok(Number.isFinite(identity.cpuSeconds) && identity.cpuSeconds! >= 0, 'Backend cumulative CPU time unavailable')
  return {
    pid: identity.pid,
    workingSetBytes: identity.workingSetBytes,
    cumulativeCpuSeconds: identity.cpuSeconds,
    label: 'Actual backend PID sample; Windows working set and lifetime CPU time, not CPU utilization or a memory budget. Descendants excluded.',
  }
}

export function descendants(snapshot: ProcessIdentity[], root: ProcessIdentity): ProcessIdentity[] {
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
  assert.equal(process.platform, 'win32')
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
  const current = await snapshotProcesses(remainingBudget(deadline, 10_000))
  if (!current.some((value) => value.pid === identity.pid && value.created === identity.created)) return
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  await runCommand(executable, ['/PID', String(identity.pid), '/T', '/F'], {}, remainingBudget(deadline, 8_000), `Terminate owned process tree ${identity.pid}`)
}
