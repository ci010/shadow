import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
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

  assert.deepEqual(await supervisor.start({ ...request, localExecutor: true }), {
    phase: 'failed',
    role: 'child',
    kind: 'configuration-error',
    message: 'Local executor is only valid for main sidecars',
  })

  assert.deepEqual(calls, [])
})

test('production sidecar requires a backend module before spawning Electron', async () => {
  const { calls, supervisor } = harness()
  assert.deepEqual(await supervisor.start({ ...request, entryPath: '' }), {
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
  assert.deepEqual(await starting, {
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