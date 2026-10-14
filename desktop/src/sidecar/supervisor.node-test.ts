import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { StartupDiagnosticEntry } from './startup-diagnostics.js'
import {
  FakeSidecarSupervisor,
  NodeSidecarSupervisor,
  type SidecarChildProcess,
  type SidecarClock,
  type SidecarLogEntry,
  type SidecarReadinessResult,
  type SidecarStartRequest,
  type SidecarSpawn,
} from './supervisor.js'

const request: SidecarStartRequest = {
  role: 'child',
  executablePath: 'C:\\Shadow\\Shadow.exe',
  entryPath: 'C:\\Shadow\\resources\\backend\\dist\\src\\index.js',
  configPath: 'C:\\Users\\test\\bootstrap.json',
  launchToken: 'test-token',
  port: 43123,
}

test('fake sidecar records explicit startup inputs and reaches readiness', async () => {
  const supervisor = new FakeSidecarSupervisor()
  assert.deepEqual(await supervisor.start(request), {
    phase: 'ready',
    role: 'child',
    apiBase: 'http://127.0.0.1:43123',
  })
  assert.deepEqual(supervisor.starts, [request])
  await supervisor.stop()
  assert.deepEqual(supervisor.status, { phase: 'stopped' })
  assert.equal(supervisor.stopCount, 1)
})

test('fake sidecar exposes classified startup failures', async () => {
  const supervisor = new FakeSidecarSupervisor({
    phase: 'failed',
    role: 'child',
    kind: 'main-unreachable',
    message: 'Main did not answer readiness probe',
  })
  assert.equal((await supervisor.start(request)).phase, 'failed')
})

class FakeStream extends EventEmitter {
  write(message: string): void {
    this.emit('data', message)
  }
}

class FakeChild extends EventEmitter implements SidecarChildProcess {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly signals: NodeJS.Signals[] = []
  exitOnTerminate = true

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGKILL' || this.exitOnTerminate) queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }

  exit(code: number): void {
    this.emit('exit', code, null)
  }
}

class ManualClock implements SidecarClock {
  currentTime = 0
  readonly timers: Array<{ callback: () => void; at: number }> = []

  now(): number {
    return this.currentTime
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = { callback, at: this.currentTime + delayMs }
    this.timers.push(timer)
    return timer
  }

  clearTimeout(handle: unknown): void {
    const index = this.timers.indexOf(handle as (typeof this.timers)[number])
    if (index >= 0) this.timers.splice(index, 1)
  }

  advance(delayMs: number): void {
    this.currentTime += delayMs
    const due = this.timers.filter((timer) => timer.at <= this.currentTime)
    for (const timer of due) {
      this.clearTimeout(timer)
      timer.callback()
    }
  }
}

test('early exit reports safe backend error metadata assembled across output chunks', async () => {
  const child = new FakeChild()
  const entries: StartupDiagnosticEntry[] = []
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: () => new Promise(() => {}),
    diagnosticSink: entry => entries.push(entry),
  })
  const starting = supervisor.start(request)
  child.stderr.write('Type')
  child.stderr.write(`Error: private configuration\n    at start (C:\\private\\dist\\src\\index.js:12:3)\n  code: 'ERR_INVALID_ARG_TYPE'\n`)
  child.exit(1)
  await starting
  const failed = entries.find(entry => entry.event === 'failed')
  assert.deepEqual(failed?.backendError, {
    name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', frames: ['dist/src/index.js:12:3'],
  })
  assert.doesNotMatch(JSON.stringify(entries), /private|configuration/)
})

function harness(probeResults: SidecarReadinessResult[] = [{ ready: true }]) {
  const child = new FakeChild()
  const calls: Array<{ executablePath: string; args: readonly string[]; options: Parameters<SidecarSpawn>[2] }> = []
  const spawn: SidecarSpawn = (executablePath, args, options) => {
    calls.push({ executablePath, args, options })
    return child
  }
  let probeIndex = 0
  const supervisor = new NodeSidecarSupervisor({
    spawn,
    readinessProbe: async () => probeResults[Math.min(probeIndex++, probeResults.length - 1)]!,
    environment: { EXISTING_ENV: 'preserved' },
    readinessPollIntervalMs: 10,
    readinessTimeoutMs: 25,
    stopTimeoutMs: 10,
  })
  return { child, calls, supervisor }
}

test('production child sidecar uses the exact child startup contract', async () => {
  const { calls, supervisor } = harness()
  assert.deepEqual(await supervisor.start(request), {
    phase: 'ready',
    role: 'child',
    apiBase: 'http://127.0.0.1:43123',
  })
  assert.equal(calls[0]?.executablePath, request.executablePath)
  assert.deepEqual(calls[0]?.args, [request.entryPath, 'child', 'start', '--config', request.configPath])
  assert.deepEqual(calls[0]?.options.env, {
    EXISTING_ENV: 'preserved',
    ELECTRON_RUN_AS_NODE: '1',
    GATEWAY_PORT: '43123',
    WINDOWS_USE_LAUNCH_TOKEN: request.launchToken,
  })
  assert.equal(calls[0]?.options.shell, false)
  assert.equal(calls[0]?.options.windowsHide, true)
})

test('production main sidecar uses the exact server startup contract with local executor', async () => {
  const { calls, supervisor } = harness()
  const mainRequest: SidecarStartRequest = {
    ...request,
    role: 'main',
    localExecutor: true,
  }

  assert.equal((await supervisor.start(mainRequest)).phase, 'ready')
  assert.equal(calls[0]?.executablePath, mainRequest.executablePath)
  assert.deepEqual(calls[0]?.args, [
    mainRequest.entryPath,
    'server',
    'start',
    '--config', mainRequest.configPath,
    '--local-executor',
  ])
  assert.deepEqual(calls[0]?.options.env, {
    EXISTING_ENV: 'preserved',
    ELECTRON_RUN_AS_NODE: '1',
    GATEWAY_PORT: '43123',
    WINDOWS_USE_LAUNCH_TOKEN: mainRequest.launchToken,
  })
  assert.equal(calls[0]?.options.shell, false)
})

test('production child sidecar rejects local executor as configuration error', async () => {
  const { calls, supervisor } = harness()

  assert.partialDeepStrictEqual(await supervisor.start({ ...request, localExecutor: true }), {
    phase: 'failed',
    role: 'child',
    kind: 'configuration-error',
    message: 'Local executor is only valid for main sidecars',
  })

  assert.deepEqual(calls, [])
})

test('production sidecar requires a backend module before spawning Electron', async () => {
  const { calls, supervisor } = harness()
  assert.partialDeepStrictEqual(await supervisor.start({ ...request, entryPath: '' }), {
    phase: 'failed',
    role: 'child',
    kind: 'configuration-error',
    message: 'Backend entry path is required',
  })
  assert.deepEqual(calls, [])
})

test('production sidecar classifies exit before readiness', async () => {
  const child = new FakeChild()
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: () => new Promise(() => undefined),
  })
  const starting = supervisor.start(request)
  child.exit(12)
  assert.partialDeepStrictEqual(await starting, {
    phase: 'failed',
    role: 'child',
    kind: 'early-exit',
    message: 'Sidecar exited before readiness with code 12',
  })
})

test('production sidecar times out bounded readiness polling', async () => {
  const child = new FakeChild()
  const clock = new ManualClock()
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: false }),
    clock,
    readinessPollIntervalMs: 10,
    readinessTimeoutMs: 25,
  })
  const starting = supervisor.start(request)
  for (const elapsed of [10, 10, 10]) {
    while (clock.timers.length === 0) await Promise.resolve()
    clock.advance(elapsed)
  }
  assert.equal((await starting).phase, 'failed')
  assert.equal(supervisor.status.phase === 'failed' && supervisor.status.kind, 'readiness-timeout')
})

test('production sidecar enforces its deadline when a readiness probe hangs', async () => {
  const child = new FakeChild()
  const clock = new ManualClock()
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: () => new Promise(() => undefined),
    clock,
    readinessTimeoutMs: 25,
  })
  const starting = supervisor.start(request)
  while (clock.timers.length === 0) await Promise.resolve()
  clock.advance(25)

  assert.deepEqual(await starting, {
    phase: 'failed',
    role: 'child',
    kind: 'readiness-timeout',
    message: 'Sidecar was not ready within 25ms',
    elapsedMs: 25,
  })
})

test('production sidecar places credentials and gateway port only in the environment', async () => {
  const { calls, supervisor } = harness()
  await supervisor.start(request)
  assert.equal(calls[0]?.options.env?.WINDOWS_USE_LAUNCH_TOKEN, request.launchToken)
  assert.equal(calls[0]?.options.env?.GATEWAY_PORT, String(request.port))
  assert.equal(calls[0]?.args.includes(request.launchToken), false)
  assert.equal(calls[0]?.args.includes(String(request.port)), false)
})

test('production sidecar shares a concurrent start', async () => {
  const child = new FakeChild()
  let spawnCount = 0
  let finishProbe: ((result: SidecarReadinessResult) => void) | undefined
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => {
      spawnCount += 1
      return child
    },
    readinessProbe: () => new Promise((resolve) => { finishProbe = resolve }),
  })
  const first = supervisor.start(request)
  const second = supervisor.start(request)
  assert.equal(first, second)
  assert.equal(spawnCount, 1)
  finishProbe?.({ ready: true })
  assert.equal((await first).phase, 'ready')
})

test('production sidecar requests authenticated shutdown and exits without SIGTERM', async () => {
  const child = new FakeChild()
  let shutdownRequest: { readonly apiBase: string; readonly launchToken: string } | undefined
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: true }),
    authenticatedShutdownRequest: async (received) => {
      shutdownRequest = received
      queueMicrotask(() => child.exit(0))
    },
  })
  await supervisor.start(request)

  await supervisor.stop()

  assert.deepEqual(shutdownRequest, {
    apiBase: 'http://127.0.0.1:43123',
    launchToken: request.launchToken,
  })
  assert.deepEqual(child.signals, [])
})

test('production sidecar falls back to SIGTERM when authenticated shutdown fails', async () => {
  const child = new FakeChild()
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: true }),
    authenticatedShutdownRequest: async () => { throw new Error('request failed') },
  })
  await supervisor.start(request)

  await supervisor.stop()

  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('production sidecar bounds a hanging authenticated shutdown before SIGTERM', async () => {
  const child = new FakeChild()
  const clock = new ManualClock()
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: true }),
    authenticatedShutdownRequest: () => new Promise(() => undefined),
    clock,
    shutdownGraceTimeoutMs: 7,
  })
  await supervisor.start(request)

  const stopping = supervisor.stop()
  while (clock.timers.length === 0) await Promise.resolve()
  clock.advance(6)
  assert.deepEqual(child.signals, [])
  clock.advance(1)
  await stopping

  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('production sidecar does not log a token from authenticated shutdown failure', async () => {
  const child = new FakeChild()
  const logs: SidecarLogEntry[] = []
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: true }),
    authenticatedShutdownRequest: async () => { throw new Error(`failed with ${request.launchToken}`) },
    logSink: (entry) => logs.push(entry),
  })
  await supervisor.start(request)

  await supervisor.stop()

  assert.equal(JSON.stringify(logs).includes(request.launchToken), false)
  assert.match(logs.at(-1)?.message ?? '', /falling back to SIGTERM/)
})

test('production sidecar forces stop after graceful timeout and stop is idempotent', async () => {
  const child = new FakeChild()
  child.exitOnTerminate = false
  const clock = new ManualClock()
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: true }),
    authenticatedShutdownRequest: async () => undefined,
    clock,
    shutdownGraceTimeoutMs: 5,
    stopTimeoutMs: 10,
  })
  await supervisor.start(request)
  const first = supervisor.stop()
  const second = supervisor.stop()
  assert.equal(first, second)
  while (clock.timers.length === 0) await Promise.resolve()
  clock.advance(5)
  while (clock.timers.length === 0) await Promise.resolve()
  clock.advance(10)
  await first
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(supervisor.status, { phase: 'stopped' })
})

test('diagnostics distinguish timeout from early exit with safe role, duration and exit code', async () => {
  for (const kind of ['early-exit', 'readiness-timeout'] as const) {
    const child = new FakeChild()
    const clock = new ManualClock()
    const entries: StartupDiagnosticEntry[] = []
    const logs: SidecarLogEntry[] = []
    const supervisor = new NodeSidecarSupervisor({
      spawn: () => child,
      readinessProbe: () => new Promise(() => undefined),
      clock,
      readinessTimeoutMs: 25,
      diagnosticSink: entry => entries.push(entry),
      logSink: entry => logs.push(entry),
    })
    const starting = supervisor.start(request)
    child.stdout.write(`authorization: Bearer ${request.launchToken}\nprivate chat body\n`)
    child.stderr.write('secret-config-path and provider-key')
    clock.advance(kind === 'early-exit' ? 7 : 25)
    if (kind === 'early-exit') child.exit(12)
    const result = await starting
    assert.equal(result.phase === 'failed' && result.kind, kind)
    assert.deepEqual(entries.map(entry => entry.event), ['starting', 'spawned', 'failed'])
    assert.deepEqual(entries.at(-1), {
      timestamp: kind === 'early-exit' ? '1970-01-01T00:00:00.007Z' : '1970-01-01T00:00:00.025Z',
      role: 'child', event: 'failed', elapsedMs: kind === 'early-exit' ? 7 : 25, kind,
      ...(kind === 'early-exit' ? { exitCode: 12 } : {}),
    })
    assert.doesNotMatch(JSON.stringify([entries, logs, result]), /test-token|private chat|secret-config|provider-key/)
    if (kind === 'readiness-timeout') assert.deepEqual(child.signals, ['SIGTERM'])
    await supervisor.stop()
  }
})

test('raw output is bounded and only its allowlisted error code reaches a log sink', async () => {
  const child = new FakeChild()
  const logs: unknown[] = []
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child, readinessProbe: () => new Promise(() => undefined),
    diagnosticSink: entry => logs.push(entry), logSink: entry => logs.push(entry),
  })
  const starting = supervisor.start(request)
  child.stderr.write(`private-${'x'.repeat(10_000)}\nEADDR`)
  child.stderr.write('INUSE secret-token')
  child.exit(1)
  assert.equal((await starting as { kind: string }).kind, 'port-conflict')
  assert.doesNotMatch(JSON.stringify(logs), /private-|secret-token/)
  assert.match(JSON.stringify(logs), /"code":"EADDRINUSE"/)
})

test('spawn and readiness exceptions cannot leak credentials in failures or diagnostics', async () => {
  const secret = 'synthetic-private-key'
  const entries: unknown[] = []
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => { throw new Error(secret) },
    readinessProbe: async () => ({ ready: false }),
    diagnosticSink: entry => entries.push(entry),
  })
  const status = await supervisor.start(request)
  assert.equal(status.phase === 'failed' && status.kind, 'spawn-error')
  assert.doesNotMatch(JSON.stringify([status, entries]), /synthetic-private-key/)

  const child = new FakeChild()
  const second = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: false, failure: { kind: 'configuration-error', message: secret } }),
    diagnosticSink: entry => entries.push(entry),
  })
  const failure = await second.start(request)
  assert.doesNotMatch(JSON.stringify([failure, entries]), /synthetic-private-key/)
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('diagnostic write failures cannot break startup or shutdown', async () => {
  const child = new FakeChild()
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: async () => ({ ready: true }),
    diagnosticSink: () => { throw new Error('disk failure') },
  })
  assert.equal((await supervisor.start(request)).phase, 'ready')
  await supervisor.stop()
  assert.equal(supervisor.status.phase, 'stopped')
})

test('repeated probe exceptions emit one safe diagnostic per attempt', async () => {
  const child = new FakeChild()
  const entries: StartupDiagnosticEntry[] = []
  let probes = 0
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child, readinessPollIntervalMs: 1,
    readinessProbe: async () => {
      if (++probes < 4) throw new Error('synthetic-private-token')
      return { ready: true }
    },
    diagnosticSink: entry => entries.push(entry),
  })
  assert.equal((await supervisor.start(request)).phase, 'ready')
  assert.equal(entries.filter(entry => entry.event === 'probe-error').length, 1)
  assert.doesNotMatch(JSON.stringify(entries), /synthetic-private-token/)
  await supervisor.stop()
})

test('supervisor captures whitelisted backend startup phases but not raw output or post-ready markers', async () => {
  const child = new FakeChild()
  const entries: StartupDiagnosticEntry[] = []
  let ready!: (value: SidecarReadinessResult) => void
  const supervisor = new NodeSidecarSupervisor({
    spawn: () => child,
    readinessProbe: () => new Promise(resolve => { ready = resolve }),
    diagnosticSink: entry => entries.push(entry),
  })
  const starting = supervisor.start(request)
  const marker = '[startup] ' + JSON.stringify({
    version: 1, component: 'project', projectId: 'private-project',
    phase: 'config', status: 'completed', elapsedMs: 12, durationMs: 9,
  }) + '\n'
  child.stdout.write('credential=private-key\n')
  child.stdout.write(marker.slice(0, 15))
  child.stdout.write(marker.slice(15))
  ready({ ready: true })
  await starting
  child.stdout.write(marker)
  const backend = entries.filter(entry => entry.event === 'backend-phase')
  assert.equal(backend.length, 1)
  assert.equal(backend[0]?.backend?.phase, 'config')
  assert.equal(backend[0]?.backend?.projectOrdinal, 1)
  assert.doesNotMatch(JSON.stringify(entries), /private-project|private-key|credential/)
  await supervisor.stop()
})
test('occupied port fails before spawning or probing an unrelated runtime', async () => {
  const entries: StartupDiagnosticEntry[] = []
  const supervisor = new NodeSidecarSupervisor({
    isPortOccupied: async port => { assert.equal(port, request.port); return true },
    spawn: () => { assert.fail('must not spawn on occupied port') },
    readinessProbe: async () => { assert.fail('must not send launch token to existing listener') },
    diagnosticSink: entry => entries.push(entry),
  })
  assert.partialDeepStrictEqual(await supervisor.start(request), {
    phase: 'failed', kind: 'port-conflict',
  })
  await supervisor.stop()
  assert.deepEqual(entries.map(entry => entry.event), ['starting', 'failed', 'stopped'])
})

test('free port preflight preserves backend launch and authenticated readiness', async () => {
  const child = new FakeChild()
  let spawned = false
  const supervisor = new NodeSidecarSupervisor({
    isPortOccupied: async () => false,
    spawn: () => { spawned = true; return child },
    readinessProbe: async (_apiBase, token) => {
      assert.equal(spawned, true)
      assert.equal(token, request.launchToken)
      return { ready: true }
    },
  })
  assert.equal((await supervisor.start(request)).phase, 'ready')
  await supervisor.stop()
})

for (const occupied of [false, true]) {
  test(`stop during pending port preflight prevents spawn (occupied=${occupied})`, async () => {
    let resolvePreflight!: (occupied: boolean) => void
    const supervisor = new NodeSidecarSupervisor({
      isPortOccupied: () => new Promise<boolean>(resolve => { resolvePreflight = resolve }),
      spawn: () => { assert.fail('must not spawn after stop') },
      readinessProbe: async () => { assert.fail('must not probe after stop') },
    })
    const starting = supervisor.start(request)
    assert.equal(supervisor.status.phase, 'starting')
    await supervisor.stop()
    resolvePreflight(occupied)
    assert.deepEqual(await starting, { phase: 'stopped' })
    assert.deepEqual(supervisor.status, { phase: 'stopped' })
  })
}


test('armed development capture preloads before the entrypoint without a network inspector', async () => {
  for (const enabled of [false, true]) {
    const child = new FakeChild()
    let actualArgs: readonly string[] = []
    const supervisor = new NodeSidecarSupervisor({
      environment: { SHADOW_DESKTOP_DEV_IPC: enabled ? '1' : '0', SHADOW_STARTUP_PROFILE_DIR: 'local-profile-directory' },
      spawn: (_executable, args) => { actualArgs = args; return child },
      readinessProbe: async () => ({ ready: true }),
    })
    assert.equal((await supervisor.start(request)).phase, 'ready')
    if (enabled) {
      assert.equal(actualArgs[0], '--import')
      assert.ok(actualArgs[1])
      assert.match(actualArgs[1], /startup-profile-preload\.js$/)
      assert.equal(actualArgs[2], request.entryPath)
    } else assert.equal(actualArgs[0], request.entryPath)
    assert.ok(!actualArgs.some(arg => arg.startsWith('--inspect')))
    await supervisor.stop()
  }
})
