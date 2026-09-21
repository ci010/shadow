import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  createRuntimeLaunchToken,
  type QuitEvent,
  registerRuntimeHostQuitLifecycle,
  resolveRuntimePaths,
  RuntimeHost,
  type RuntimeLaunchOptions,
} from './runtime-host.js'
import type {
  SidecarStartRequest,
  SidecarStatus,
  SidecarSupervisor,
} from './supervisor.js'

const fixtureRoot = resolve('fixtures', 'Shadow Desktop')
const paths = {
  executablePath: join(fixtureRoot, 'installed', 'shadow'),
  appPath: join(fixtureRoot, 'repo', 'desktop'),
  resourcesPath: join(fixtureRoot, 'installed', 'resources'),
  userDataPath: join(fixtureRoot, 'user-data'),
  packaged: true,
} as const

class DeferredSupervisor implements SidecarSupervisor {
  status: SidecarStatus = { phase: 'stopped' }
  readonly starts: SidecarStartRequest[] = []
  stopCount = 0
  private resolveStart: ((status: SidecarStatus) => void) | undefined

  start(request: SidecarStartRequest): Promise<SidecarStatus> {
    this.starts.push(request)
    this.status = { phase: 'starting', role: request.role }
    return new Promise((resolve) => {
      this.resolveStart = resolve
    })
  }

  ready(apiBase = 'http://127.0.0.1:43123'): void {
    this.status = { phase: 'ready', role: this.starts[0]!.role, apiBase }
    this.resolveStart?.(this.status)
  }

  async stop(): Promise<void> {
    this.stopCount += 1
    this.status = { phase: 'stopped' }
  }
}

function createHost(
  supervisor = new DeferredSupervisor(),
  authorizations: unknown[] = [],
) {
  let factoryCount = 0
  const host = new RuntimeHost({
    paths,
    tokenFactory: () => 'launch-token',
    onAuthorizationChanged: (authorization) => {
      authorizations.push(authorization)
    },
    supervisorFactory: () => {
      factoryCount += 1
      return supervisor
    },
  })
  return { host, supervisor, authorizations, factoryCount: () => factoryCount }
}

test('resolves packaged and development paths only from explicit inputs', () => {
  assert.deepEqual(resolveRuntimePaths(paths), {
    executablePath: paths.executablePath,
    entryPath: join(paths.resourcesPath, 'backend', 'dist', 'src', 'index.js'),
    configPath: join(paths.userDataPath, 'bootstrap', 'runtime-config.v1.json'),
  })
  assert.deepEqual(resolveRuntimePaths({ ...paths, packaged: false }), {
    executablePath: paths.executablePath,
    entryPath: join(fixtureRoot, 'repo', 'dist', 'src', 'index.js'),
    configPath: join(paths.userDataPath, 'bootstrap', 'runtime-config.v1.json'),
  })
})

test('creates unique base64url launch tokens with 256 bits of randomness', () => {
  const first = createRuntimeLaunchToken()
  const second = createRuntimeLaunchToken()
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first, second)
})

test('a crashed Child can restart instead of returning a cached ready promise', async () => {
  const { host, supervisor, factoryCount } = createHost()
  const first = host.start({ role: 'child', port: 43124 })
  supervisor.ready('http://127.0.0.1:43124')
  await first
  supervisor.status = { phase: 'failed', role: 'child', kind: 'crash', message: 'exited' }
  const retry = host.start({ role: 'child', port: 43124 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(supervisor.starts.length, 2)
  supervisor.ready('http://127.0.0.1:43124')
  assert.equal((await retry).phase, 'ready')
  assert.equal(factoryCount(), 2)
  await host.stop()
})

test('constructs one authenticated launch, publishes after ready, and clears on stop', async () => {
  const { host, supervisor, authorizations } = createHost()
  const starting = host.start({
    role: 'main',
    port: 43123,
    localExecutor: true,
  })
  assert.deepEqual(supervisor.starts, [{
    role: 'main',
    executablePath: paths.executablePath,
    entryPath: join(paths.resourcesPath, 'backend', 'dist', 'src', 'index.js'),
    configPath: join(paths.userDataPath, 'bootstrap', 'runtime-config.v1.json'),
    launchToken: 'launch-token',
    port: 43123,
    localExecutor: true,
  }])
  supervisor.ready()
  await starting
  assert.deepEqual(authorizations, [{
    apiBase: 'http://127.0.0.1:43123',
    launchToken: 'launch-token',
  }])
  assert.equal(host.apiBase, 'http://127.0.0.1:43123')
  await host.stop()
  assert.equal(supervisor.stopCount, 1)
  assert.equal(authorizations.at(-1), null)
})

test('development launch uses the repository backend and explicit user data directory', async () => {
  const supervisor = new DeferredSupervisor()
  const host = new RuntimeHost({
    paths: { ...paths, packaged: false },
    supervisorFactory: () => supervisor,
    tokenFactory: () => 'launch-token',
  })
  const starting = host.start({ role: 'main', port: 43123 })
  assert.deepEqual(supervisor.starts, [{
    role: 'main',
    executablePath: paths.executablePath,
    entryPath: join(fixtureRoot, 'repo', 'dist', 'src', 'index.js'),
    configPath: join(paths.userDataPath, 'bootstrap', 'runtime-config.v1.json'),
    launchToken: 'launch-token',
    port: 43123,
  }])
  supervisor.ready()
  await starting
  await host.stop()
})

test('rejects non-loopback readiness and clears authorization after failed start', async () => {
  const { host, supervisor, authorizations } = createHost()
  const starting = host.start({ role: 'main', port: 43123 })
  supervisor.ready('http://example.com:43123')
  await assert.rejects(starting, /invalid API origin/)
  assert.deepEqual(authorizations, [null])
  assert.equal(supervisor.stopCount, 1)
})

test('clears authorization once when the supervisor start rejects', async () => {
  const authorizations: unknown[] = []
  const supervisor: SidecarSupervisor = {
    status: { phase: 'stopped' },
    start: async () => {
      throw new Error('failed')
    },
    stop: async () => undefined,
  }
  const { host } = createHost(supervisor as DeferredSupervisor, authorizations)
  await assert.rejects(host.start({ role: 'main', port: 43123 }), /failed/)
  assert.deepEqual(authorizations, [null])
})

test('releases a failed supervisor result so a retry creates a fresh launch', async () => {
  let stopped = 0
  const failed: SidecarSupervisor = {
    status: {
      phase: 'failed',
      role: 'main',
      kind: 'port-conflict',
      message: 'busy',
    },
    start: async () => ({
      phase: 'failed',
      role: 'main',
      kind: 'port-conflict',
      message: 'busy',
    }),
    stop: async () => { stopped++ },
  }
  const ready = new DeferredSupervisor()
  const supervisors: SidecarSupervisor[] = [failed, ready]
  const host = new RuntimeHost({
    paths,
    tokenFactory: () => 'launch-token',
    supervisorFactory: () => supervisors.shift()!,
  })

  assert.equal(
    (await host.start({ role: 'main', port: 43123 })).phase,
    'failed',
  )
  assert.equal(stopped, 1)
  const retried = host.start({ role: 'main', port: 43123 })
  ready.ready()
  assert.equal((await retried).phase, 'ready')
})

test('shares concurrent starts and creates one supervisor per launch', async () => {
  const { host, supervisor, factoryCount } = createHost()
  const launch: RuntimeLaunchOptions = { role: 'child', port: 43123 }
  const first = host.start(launch)
  const second = host.start(launch)
  assert.equal(first, second)
  assert.equal(factoryCount(), 1)
  assert.equal(supervisor.starts.length, 1)
  supervisor.ready()
  await first
})

test('rejects role or configuration switching after launch starts', () => {
  const { host } = createHost()
  void host.start({ role: 'main', port: 43123 })
  assert.throws(
    () => host.start({ role: 'child', port: 43123 }),
    /cannot change while active/,
  )
  assert.throws(
    () => host.start({ role: 'main', port: 43124 }),
    /cannot change while active/,
  )
})

class FakeApp extends EventEmitter {
  quitCount = 0

  quit(): void {
    this.quitCount += 1
    this.emit('before-quit', { preventDefault() {} } satisfies QuitEvent)
  }

  requestQuit(event: QuitEvent): void {
    this.emit('before-quit', event)
  }
}

test('quit waits for one idempotent stop and does not recurse', async () => {
  const app = new FakeApp()
  let stopCount = 0
  let finishStop: (() => void) | undefined
  const host = {
    stop: () => {
      stopCount += 1
      return new Promise<void>((resolve) => {
        finishStop = resolve
      })
    },
  }
  registerRuntimeHostQuitLifecycle(app, host)
  let prevented = 0
  const event = {
    preventDefault: () => {
      prevented += 1
    },
  }
  app.requestQuit(event)
  app.requestQuit(event)
  assert.equal(prevented, 2)
  assert.equal(stopCount, 1)
  assert.equal(app.quitCount, 0)
  finishStop?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(app.quitCount, 1)
  assert.equal(stopCount, 1)
})
