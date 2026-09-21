import {
  deepEqual as assertEquals,
  rejects as assertRejects,
  strictEqual as assertStrictEquals,
} from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import {
  type ChildRuntimeDependencies,
  type ChildRuntimeService,
  type ChildRuntimeTimers,
  type MainConnection,
  startChildRuntime,
} from './child-runtime.ts'

const config: ChildBootstrapConfigV1 = {
  version: 1,
  mode: 'child',
  dataDir: './child-data',
  localNodeId: 'child-node',
  mainEndpoint: 'https://main.example.test',
}

test('Child runtime starts injected services in dependency order before readiness', async () => {
  const events: string[] = []
  const service = recordingService(events)
  const connector = {
    ...service('main-connector'),
    connect: () => {
      events.push('connect:main')
      return Promise.resolve({
        disconnected: new Promise<void>(() => {}),
        close: () => Promise.resolve(),
      })
    },
  }

  const runtime = startChildRuntime(config, {
    nodeIdentity: service('node-identity'),
    localExecutors: service('local-executors'),
    mainConnector: connector,
    localControl: service('local-control'),
  })

  await runtime.ready
  assertEquals(events, [
    'start:node-identity',
    'start:local-executors',
    'start:main-connector',
    'start:local-control',
    'connect:main',
  ])

  await runtime.shutdown()
  await runtime.finished
  assertEquals(events.slice(-4), [
    'stop:local-control',
    'stop:main-connector',
    'stop:local-executors',
    'stop:node-identity',
  ])
})

test('Child runtime works without a local control listener or placeholder services', async () => {
  const events: string[] = []
  const service = recordingService(events)
  const active = controlledConnection()
  const runtime = startChildRuntime(config, {
    nodeIdentity: service('node-identity'),
    localExecutors: service('local-executors'),
    mainConnector: {
      ...service('main-connector'),
      connect: () => Promise.resolve(active.connection),
    },
  })

  await runtime.ready
  await until(active.observed)
  await runtime.shutdown()
  await runtime.finished
  assertEquals(active.closeCalls(), 1)
  assertEquals(events, [
    'start:node-identity',
    'start:local-executors',
    'start:main-connector',
    'stop:main-connector',
    'stop:local-executors',
    'stop:node-identity',
  ])
})

test('Child runtime reconnects after disconnect with capped exponential backoff', async () => {
  const timers = new ControlledTimers()
  const connections = [controlledConnection(), controlledConnection()]
  let attempts = 0
  const dependencies = dependenciesWith({
    connect: () => Promise.resolve(connections[attempts++].connection),
  })
  const runtime = startChildRuntime(config, dependencies, {
    timers,
    reconnect: { initialDelayMs: 10, maxDelayMs: 15, multiplier: 2 },
  })

  await runtime.ready
  assertEquals(attempts, 1)
  connections[0].disconnect.resolve()
  await until(() => timers.delays.length === 1)
  assertEquals(timers.delays, [10])

  timers.releaseNext()
  await until(() => attempts === 2)
  connections[1].disconnect.resolve()
  await until(() => timers.delays.length === 2)
  assertEquals(timers.delays, [10, 10])

  await runtime.shutdown()
})

test('Child runtime shutdown aborts reconnect backoff', async () => {
  const timers = new ControlledTimers()
  let attempts = 0
  const dependencies = dependenciesWith({
    connect: () => {
      attempts++
      return Promise.reject(new Error('Main offline'))
    },
  })
  const runtime = startChildRuntime(config, dependencies, { timers })

  await runtime.ready
  await until(() => timers.delays.length === 1)
  await runtime.shutdown()
  await runtime.finished

  assertEquals(attempts, 1)
  assertEquals(timers.pending, 0)
})

test('Child runtime caps backoff across consecutive connection failures', async () => {
  const timers = new ControlledTimers()
  const runtime = startChildRuntime(
    config,
    dependenciesWith({
      connect: () => Promise.reject(new Error('Main offline')),
    }),
    {
      timers,
      reconnect: { initialDelayMs: 10, maxDelayMs: 15, multiplier: 2 },
    },
  )

  await runtime.ready
  await until(() => timers.delays.length === 1)
  timers.releaseNext()
  await until(() => timers.delays.length === 2)
  timers.releaseNext()
  await until(() => timers.delays.length === 3)

  assertEquals(timers.delays, [10, 15, 15])
  await runtime.shutdown()
})

test('Child runtime rolls back a partial start in reverse order', async () => {
  const events: string[] = []
  const service = recordingService(events)
  const dependencies = dependenciesWith({}, service)
  dependencies.localControl = {
    start: () => {
      events.push('start:local-control')
      return Promise.reject(new Error('local control startup failed'))
    },
    shutdown: () => Promise.resolve(),
  }

  const runtime = startChildRuntime(config, dependencies)
  await assertRejects(
    () => runtime.ready,
    (error) => error instanceof Error && error.message.includes('local control startup failed'),
  )
  await runtime.finished

  assertEquals(events, [
    'start:node-identity',
    'start:local-executors',
    'start:main-connector',
    'start:local-control',
    'stop:main-connector',
    'stop:local-executors',
    'stop:node-identity',
  ])
})

test('Child runtime shutdown is idempotent and closes the active connection', async () => {
  const active = controlledConnection()
  const runtime = startChildRuntime(
    config,
    dependenciesWith({ connect: () => Promise.resolve(active.connection) }),
  )
  await runtime.ready
  await until(active.observed)

  const first = runtime.shutdown()
  const second = runtime.shutdown()
  assertStrictEquals(first, second)
  await Promise.all([first, second, runtime.finished])
  assertEquals(active.closeCalls(), 1)
})

test('Child runtime module is import-safe and excludes brain, channel, cron, and Electron imports', async () => {
  const imported = await import('./child-runtime.ts')
  assertEquals(typeof imported.startChildRuntime, 'function')

  const source = await readFile(
    new URL('./child-runtime.ts', import.meta.url),
    'utf8',
  )
  for (
    const forbidden of [
      '/providers/',
      '/sessions/',
      '/memory/',
      '/wiki/',
      '/channels/',
      '/cron/',
      'electron',
    ]
  ) {
    assertEquals(source.toLowerCase().includes(forbidden), false)
  }
})

test('pending approval keeps local readiness and retries into real connected then offline state', async () => {
  const timers = new ControlledTimers()
  const connection = controlledConnection()
  const states: Array<{ state: string; error: string | null }> = []
  let attempts = 0
  const runtime = startChildRuntime(config, dependenciesWith({
    connect: async () => {
      if (++attempts === 1) throw new Error('Main challenge request failed with status 401')
      return connection.connection
    },
  }), { timers, connectionChanged: (state, error) => states.push({ state, error }) })
  await runtime.ready
  await until(() => timers.delays.length === 1)
  assertEquals(states.map(value => value.state), ['connecting', 'offline'])
  assertEquals(states[1].error?.includes('not authorized'), true)
  timers.releaseNext()
  await until(connection.observed)
  assertEquals(states.at(-1), { state: 'connected', error: null })
  connection.disconnect.resolve()
  await until(() => timers.delays.length === 2)
  assertEquals(states.at(-1)?.state, 'offline')
  await runtime.shutdown()
})

function recordingService(events: string[]) {
  return (name: string): ChildRuntimeService => ({
    start: () => {
      events.push(`start:${name}`)
      return Promise.resolve()
    },
    shutdown: () => {
      events.push(`stop:${name}`)
      return Promise.resolve()
    },
  })
}

function dependenciesWith(
  connector: Partial<ChildRuntimeDependencies['mainConnector']> = {},
  service = recordingService([]),
): ChildRuntimeDependencies & { localControl: ChildRuntimeService } {
  return {
    nodeIdentity: service('node-identity'),
    localExecutors: service('local-executors'),
    mainConnector: {
      ...service('main-connector'),
      connect: () => Promise.reject(new Error('Main offline')),
      ...connector,
    },
    localControl: service('local-control'),
  }
}

function controlledConnection(): {
  connection: MainConnection
  disconnect: PromiseWithResolvers<void>
  closeCalls(): number
  observed(): boolean
} {
  const disconnect = Promise.withResolvers<void>()
  let closes = 0
  let observed = false
  return {
    disconnect,
    connection: {
      get disconnected() {
        observed = true
        return disconnect.promise
      },
      close: () => {
        closes++
        disconnect.resolve()
        return Promise.resolve()
      },
    },
    closeCalls: () => closes,
    observed: () => observed,
  }
}

class ControlledTimers implements ChildRuntimeTimers {
  readonly delays: number[] = []
  readonly #waiters: Array<PromiseWithResolvers<void>> = []

  get pending(): number {
    return this.#waiters.length
  }

  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    this.delays.push(delayMs)
    const waiter = Promise.withResolvers<void>()
    this.#waiters.push(waiter)
    signal.addEventListener('abort', () => {
      const index = this.#waiters.indexOf(waiter)
      if (index >= 0) this.#waiters.splice(index, 1)
      waiter.reject(signal.reason)
    }, { once: true })
    return waiter.promise
  }

  releaseNext(): void {
    this.#waiters.shift()?.resolve()
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}
