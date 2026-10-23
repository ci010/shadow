import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'

interface ProcessIdentity {
  pid: number
  parentPid: number
  executablePath: string
  commandLine: string
  created: string
}
interface StopContext {
  descriptor: typeof descriptor
  credentialPath: string
  wrapperPath: string
  executablePath: string
  commandLines: string[]
}
interface ProcessControl {
  inspect(pid: number): ProcessIdentity[]
  terminate(backend: ProcessIdentity, wrapper: ProcessIdentity, context: StopContext): void
}
interface StopOptions {
  read: (path: string) => Promise<string>
  request: (url: string, init: RequestInit) => Promise<Response>
  processControl: ProcessControl
  wrapperPid: number
  selfPid: number
  now: () => number
  delay: (ms: number) => Promise<void>
  graceMs: number
  requestTimeoutMs?: number
  warn: (message: string) => void
}
const require = createRequire(import.meta.url)
const { loadContext, captureBackend, createWindowsProcessControl, requestShutdown, stopService } = require('../../service/stop.cjs') as {
  loadContext(path: string, read: StopOptions['read']): Promise<StopContext>
  captureBackend(processes: ProcessIdentity[], context: StopContext, wrapperPid: number, selfPid: number, originalWrapper?: ProcessIdentity): { wrapper: ProcessIdentity; backend?: ProcessIdentity }
  createWindowsProcessControl(options: {
    systemRoot: string
    run: (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => Pick<SpawnSyncReturns<string>, 'stdout' | 'status' | 'error'>
  }): ProcessControl
  requestShutdown(context: StopContext, options: { read: StopOptions['read']; request: StopOptions['request']; timeoutMs: number }): Promise<void>
  stopService(path: string, options: StopOptions): Promise<{ outcome: 'graceful' | 'forced' }>
}

const control = 'C:\\ProgramData\\Shadow Service\\control'
const descriptorPath = `${control}\\connection.v1.json`
const credential = 's'.repeat(43)
const descriptor = {
  version: 1, serviceName: 'ShadowService', role: 'main', port: 18800,
  apiBase: 'http://127.0.0.1:18800',
  credentialPath: `${control}\\launch-token`, configPath: `${control}\\runtime-config.v1.json`,
}
const installation = {
  version: 1, executablePath: "C:\\Program Files\\O'Brien\\Shadow.exe",
  entryPath: "C:\\Program Files\\O'Brien\\resources\\backend\\dist\\src\\index.js",
  desktopSid: 'S-1-5-21-100-200-300-1001',
}
const commandLine = `"${installation.executablePath}" "${installation.entryPath}" server start --config "${descriptor.configPath}" --service`
const wrapper: ProcessIdentity = {
  pid: 100, parentPid: 1, executablePath: `${control}\\ShadowService.exe`,
  commandLine: `"${control}\\ShadowService.exe"`, created: '2026-09-16T00:00:00.0000000Z',
}
const backend: ProcessIdentity = {
  pid: 101, parentPid: 100, executablePath: installation.executablePath,
  commandLine, created: '2026-09-16T00:00:01.0000000Z',
}
const self: ProcessIdentity = {
  pid: 102, parentPid: 100, executablePath: installation.executablePath,
  commandLine: `"${installation.executablePath}" "${control}\\stop.cjs" "${descriptorPath}"`,
  created: '2026-09-16T00:00:02.0000000Z',
}
const read: StopOptions['read'] = async (path) => {
  if (path === descriptorPath) return JSON.stringify(descriptor)
  if (path === descriptor.credentialPath) return credential
  if (path === `${control}\\installation.v1.json`) return JSON.stringify(installation)
  throw new Error('Unexpected file read')
}

function fixture() {
  let clock = 0
  let snapshots = 0
  const warnings: string[] = []
  const terminated: ProcessIdentity[] = []
  const requests: RequestInit[] = []
  const options: StopOptions = {
    read, wrapperPid: 100, selfPid: 102, graceMs: 600,
    request: async (url, init) => {
      assert.equal(url, `${descriptor.apiBase}/local/v1/shutdown`)
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${credential}`)
      requests.push(init)
      return Response.json({ version: 1, accepted: true }, { status: 202 })
    },
    now: () => clock,
    delay: async (ms) => { clock += ms },
    warn: (message) => { warnings.push(message) },
    processControl: {
      inspect: (pid) => { assert.equal(pid, 100); snapshots++; return [wrapper, backend, self] },
      terminate: (candidate, parent) => { assert.deepEqual(parent, wrapper); terminated.push(candidate) },
    },
  }
  return { options, warnings, terminated, requests, snapshots: () => snapshots, clock: () => clock }
}

test('Node SCM stop authenticates shutdown, observes exit, and never kills a gracefully stopped backend', async () => {
  const state = fixture()
  let snapshots = 0
  state.options.processControl.inspect = () => ++snapshots === 1 ? [wrapper, backend, self] : [wrapper, self]
  assert.deepEqual(await stopService(descriptorPath, state.options), { outcome: 'graceful' })
  assert.equal(state.requests.length, 1)
  assert.equal(state.terminated.length, 0)
  assert.equal(state.warnings.length, 0)
})

test('Node SCM stop bounds grace and kills only its captured owned backend tree', async () => {
  const state = fixture()
  assert.deepEqual(await stopService(descriptorPath, state.options), { outcome: 'forced' })
  assert.equal(state.clock(), 600)
  assert.equal(state.requests.length, 1)
  assert.deepEqual(state.terminated, [backend])
  assert.ok(state.warnings.every((message) => !message.includes(credential)))
})

test('rejected or unavailable HTTP shutdown still reaches bounded owned-process fallback', async () => {
  for (const request of [
    async () => Response.json({ version: 1, accepted: true }, { status: 401 }),
    async () => { throw new Error(credential) },
    async () => Response.json({ version: 1, accepted: false }, { status: 202 }),
  ]) {
    const state = fixture()
    state.options.request = request
    assert.deepEqual(await stopService(descriptorPath, state.options), { outcome: 'forced' })
    assert.equal(state.clock(), 600)
    assert.deepEqual(state.terminated, [backend])
    assert.ok(state.warnings.every((message) => !message.includes(credential)))
  }
})

test('shutdown request and response-body hangs are bounded without relying on fetch cooperation', async () => {
  const context = await loadContext(descriptorPath, read)
  for (const request of [
    async () => new Promise<Response>(() => undefined),
    async () => ({
      status: 202, headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise(() => undefined),
    } as unknown as Response),
  ]) {
    await assert.rejects(requestShutdown(context, { read, request, timeoutMs: 5 }), /timed out/)
  }
})

test('PID reuse is treated as the old backend exiting, never as permission to kill its replacement', async () => {
  const state = fixture()
  let snapshots = 0
  state.options.processControl.inspect = () => [
    wrapper, ++snapshots === 1 ? backend : { ...backend, created: '2026-09-16T00:00:03.0000000Z' }, self,
  ]
  assert.deepEqual(await stopService(descriptorPath, state.options), { outcome: 'graceful' })
  assert.equal(state.terminated.length, 0)
})

test('ownership mismatch, ambiguity, and blocked CIM fail closed without broad process killing', async () => {
  const context = await loadContext(descriptorPath, read)
  for (const snapshot of [
    [{ ...wrapper, executablePath: 'C:\\other.exe' }, backend, self],
    [wrapper, backend, { ...backend, pid: 103 }, self],
    [wrapper, { ...backend, commandLine: 'unexpected' }, self],
  ]) {
    assert.throws(() => captureBackend(snapshot, context, 100, 102))
  }
  const state = fixture()
  state.options.processControl.inspect = () => { throw new Error('CIM blocked') }
  await assert.rejects(stopService(descriptorPath, state.options), /Cannot verify/)
  assert.equal(state.requests.length, 1, 'even unavailable introspection must not skip authenticated shutdown')
  assert.equal(state.clock(), 600)
  assert.equal(state.terminated.length, 0)
})

test('inline native process commands never load a script or alter execution policy; exact PID guard is rechecked', async () => {
  const invocations: Array<{ file: string; args: string[]; options: SpawnSyncOptionsWithStringEncoding }> = []
  const native = createWindowsProcessControl({
    systemRoot: 'C:\\Windows',
    run: (file, args, options) => {
      invocations.push({ file, args, options })
      return { stdout: invocations.length === 1 ? JSON.stringify([wrapper, backend, self]) : '', status: 0 }
    },
  })
  assert.deepEqual(native.inspect(100), [wrapper, backend, self])
  native.terminate(backend, wrapper, await loadContext(descriptorPath, read))
  for (const invocation of invocations) {
    assert.equal(invocation.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(invocation.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
    assert.equal(invocation.options.shell, false)
    assert.equal(invocation.options.windowsHide, true)
    assert.ok(invocation.options.timeout! <= 5000)
    assert.doesNotMatch(invocation.args.join(' '), /-ExecutionPolicy|-File|Set-ExecutionPolicy|\.ps1/i)
    assert.ok(!invocation.args.join(' ').includes(credential))
  }
  const stop = invocations[1]!.args[3]!
  assert.match(stop, /\$process\.Handle/)
  assert.match(stop, /CreationDate\.ToUniversalTime\(\)/)
  assert.match(stop, /ParentProcessId -ne 100/)
  assert.match(stop, /\/PID 101 \/T \/F/)
  assert.match(stop, /O''Brien/)
  assert.doesNotMatch(stop, /Stop-Process -Name|\/IM\b/i)

  // Parse only; never execute CIM queries, taskkill, or a service operation.
  if (process.platform === 'win32') {
    for (const invocation of invocations) {
      const encoded = Buffer.from(invocation.args[3]!, 'utf8').toString('base64')
      const command = `$tokens=$null; $errors=$null; $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); [System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object {Write-Error $_.Message}; exit 1}`
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true })
      assert.equal(result.status, 0, result.stderr)
    }
  }
})

test('native child-command failures and timeouts produce redacted errors', () => {
  for (const result of [
    { stdout: '', status: 1 },
    { stdout: '', status: null, error: new Error(credential) },
  ]) {
    const native = createWindowsProcessControl({ systemRoot: 'C:\\Windows', run: () => result })
    assert.throws(() => native.inspect(100), (error: Error) => !error.message.includes(credential))
  }
})
