import assert, { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveRuntimePaths,
  dispatchRuntimeCli,
  type RuntimeCliDependencies,
  RuntimeCliError,
  type RuntimeLifecycleFactory,
  type RuntimeLifecycleHandle,
} from './runtime-cli.ts'
import type { BackendSignal } from './backend-cli.ts'

type MutableRuntimeCliDependencies = {
  -readonly [Key in keyof RuntimeCliDependencies]: RuntimeCliDependencies[Key]
}

function deferredLifecycle(): RuntimeLifecycleHandle & {
  finish(): void
  readonly shutdowns: number
} {
  const finished = Promise.withResolvers<void>()
  let shutdowns = 0
  return {
    ready: Promise.resolve(),
    finished: finished.promise,
    finish: finished.resolve,
    get shutdowns() {
      return shutdowns
    },
    shutdown() {
      shutdowns++
      finished.resolve()
      return Promise.resolve()
    },
  }
}

function harness(
  config: unknown,
  factories: Partial<{
    mainFactory: RuntimeLifecycleFactory
    childFactory: RuntimeLifecycleFactory
  }> = {},
) {
  const listeners = new Map<BackendSignal, () => void>()
  let mainCalls = 0
  let childCalls = 0
  const dependencies: MutableRuntimeCliDependencies = {
    readTextFile: () => Promise.resolve(JSON.stringify(config)),
    mainFactory: factories.mainFactory ?? (() => {
      mainCalls++
      throw new Error('main factory should not run')
    }),
    childFactory: factories.childFactory ?? (() => {
      childCalls++
      throw new Error('child factory should not run')
    }),
    process: {
      on: (signal, listener) => listeners.set(signal, listener),
      off: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal)
      },
    },
    pathPlatform: 'posix',
    cwd: '/opt/shadow',
  }
  return {
    dependencies,
    listeners,
    mainCalls: () => mainCalls,
    childCalls: () => childCalls,
  }
}

test('server validate plans config without starting or attaching signals', async () => {
  const test = harness({
    version: 1,
    mode: 'main',
    dataDir: './state',
    localNodeId: 'main-node',
  })

  const result = await dispatchRuntimeCli(
    ['server', 'validate', '--config', 'etc/bootstrap.json'],
    test.dependencies,
  )

  assertEquals(result.started, false)
  assertEquals(result.plan.config.mode, 'main')
  assertEquals(result.paths.dataDir, '/opt/shadow/etc/state')
  assertEquals(test.mainCalls(), 0)
  assertEquals(test.childCalls(), 0)
  assertEquals(test.listeners.size, 0)
})

test('main start receives plan, paths, loopback context and shuts down once for repeated signals', async () => {
  const lifecycle = deferredLifecycle()
  let received: unknown
  const test = harness(
    {
      version: 1,
      mode: 'main',
      dataDir: '../data',
      localNodeId: 'main-node',
    },
    {
      mainFactory: (plan, paths, context) => {
        received = { plan, paths, context }
        return lifecycle
      },
    },
  )
  test.dependencies.env = {
    GATEWAY_PORT: '43123',
    SHADOW_LOOPBACK_PORT: '49999',
    WINDOWS_USE_LAUNCH_TOKEN: 'synthetic-service-token',
  }
  test.dependencies.includeSigterm = true

  const running = dispatchRuntimeCli(
    ['server', 'start', '--config', 'etc/bootstrap.json', '--service'],
    test.dependencies,
  )
  await Promise.resolve()
  await Promise.resolve()
  test.listeners.get('SIGINT')?.()
  test.listeners.get('SIGTERM')?.()
  const result = await running

  assertEquals(lifecycle.shutdowns, 1)
  assertEquals(result.started, true)
  assertEquals(received, {
    plan: result.plan,
    paths: result.paths,
    context: { loopbackPort: 43123, launchCredential: 'synthetic-service-token' },
  })
  assertEquals(test.listeners.size, 0)
})

test('child start invokes only the child lifecycle factory', async () => {
  const lifecycle = deferredLifecycle()
  let childMode: string | undefined
  let childContext: unknown
  const test = harness(
    {
      version: 1,
      mode: 'child',
      dataDir: './child-state',
      localNodeId: 'child-node',
      mainEndpoint: 'https://main.example.test',
    },
    {
      childFactory: (plan, _paths, context) => {
        childMode = plan.config.mode
        childContext = context
        lifecycle.finish()
        return lifecycle
      },
    },
  )
  test.dependencies.env = {
    GATEWAY_PORT: '43124',
    WINDOWS_USE_LAUNCH_TOKEN: 'child-launch-secret',
  }

  const result = await dispatchRuntimeCli(
    ['child', 'start', '--config', 'child/bootstrap.json'],
    test.dependencies,
  )

  assertEquals(result.started, true)
  assertEquals(childMode, 'child')
  assertEquals(childContext, {
    loopbackPort: 43124,
    launchCredential: 'child-launch-secret',
  })
  assertEquals(test.mainCalls(), 0)
})

test('service startup rejects missing control credentials before creating a runtime', async () => {
  const test = harness({
    version: 1, mode: 'main', dataDir: './state', localNodeId: 'service-main',
  })
  test.dependencies.env = { GATEWAY_PORT: '43123' }
  await assertRejects(
    () => dispatchRuntimeCli(['server', 'start', '--config', 'bootstrap.json', '--service'], test.dependencies),
    (error: unknown) => error instanceof RuntimeCliError &&
      error.code === 'environment_invalid' && error.message.includes('credential'),
  )
  assertEquals(test.mainCalls(), 0)
  assertEquals(test.listeners.size, 0)
})

test('dispatcher reports role mismatch as an actionable typed error', async () => {
  const test = harness({
    version: 1,
    mode: 'child',
    dataDir: './child-state',
    localNodeId: 'child-node',
    mainEndpoint: 'https://main.example.test',
  })

  await assertRejects(
    () =>
      dispatchRuntimeCli(
        ['server', 'validate', '--config', 'bootstrap.json'],
        test.dependencies,
      ),
    (error) => {
      assert(error instanceof RuntimeCliError)
      assert(error.message.includes('command expects mode "main" but config has mode "child"'))
      assertEquals(error.code, 'config_invalid')
      return true
    },
  )
})

test('dispatcher reports malformed JSON without including its payload', async () => {
  const secretPayload = '{"token":"super-secret"'
  const test = harness({})
  test.dependencies.readTextFile = () => Promise.resolve(secretPayload)

  await assertRejects(
    () =>
      dispatchRuntimeCli(
        ['server', 'validate', '--config', 'bootstrap.json'],
        test.dependencies,
      ),
    (error) => {
      assert(error instanceof RuntimeCliError)
      assert(error.message.includes('is not valid JSON'))
      assertEquals(error.code, 'config_json_invalid')
      assertEquals(error.message.includes('super-secret'), false)
      assertEquals(error.cause, undefined)
      return true
    },
  )
})

test('dispatcher sanitizes read and factory failures', async () => {
  const readTest = harness({})
  readTest.dependencies.readTextFile = () =>
    Promise.reject(new Error('storage token super-secret'))
  await assertRejects(
    () =>
      dispatchRuntimeCli(
        ['server', 'validate', '--config', 'bootstrap.json'],
        readTest.dependencies,
      ),
    (error) => {
      assert(error instanceof RuntimeCliError)
      assert(error.message.includes('Unable to read bootstrap configuration'))
      assertEquals(error.code, 'config_read_failed')
      assertEquals(error.message.includes('super-secret'), false)
      assertEquals(error.cause, undefined)
      return true
    },
  )

  const factoryTest = harness(
    {
      version: 1,
      mode: 'main',
      dataDir: './state',
      localNodeId: 'main-node',
    },
    {
      mainFactory: () => {
        throw new Error('credential super-secret')
      },
    },
  )
  await assertRejects(
    () =>
      dispatchRuntimeCli(
        ['server', 'start', '--config', 'bootstrap.json'],
        factoryTest.dependencies,
      ),
    (error) => {
      assert(error instanceof RuntimeCliError)
      assert(error.message.includes('Failed to create main runtime'))
      assertEquals(error.code, 'factory_failed')
      assertEquals(error.message.includes('super-secret'), false)
      assertEquals(error.cause, undefined)
      return true
    },
  )
})

test('derived paths resolve relative data directories without mutating config conventions', () => {
  assertEquals(
    deriveRuntimePaths('conf/bootstrap.json', '../state', {
      platform: 'posix',
      cwd: '/srv/shadow',
    }),
    {
      bootstrapConfigPath: '/srv/shadow/conf/bootstrap.json',
      bootstrapDirectory: '/srv/shadow/conf',
      dataDir: '/srv/shadow/state',
      mutableAgentConfigPath: '/srv/shadow/state/config/bot.config.json',
      clusterSnapshotPath: '/srv/shadow/state/cluster/registry.v1.json',
      childCredentialPath:
        '/srv/shadow/state/credentials/device-credential.v1.json',
    },
  )

  assertEquals(
    deriveRuntimePaths('conf\\bootstrap.json', '..\\state', {
      platform: 'windows',
      cwd: 'C:\\Shadow',
    }),
    {
      bootstrapConfigPath: 'C:\\Shadow\\conf\\bootstrap.json',
      bootstrapDirectory: 'C:\\Shadow\\conf',
      dataDir: 'C:\\Shadow\\state',
      mutableAgentConfigPath: 'C:\\Shadow\\state\\config\\bot.config.json',
      clusterSnapshotPath: 'C:\\Shadow\\state\\cluster\\registry.v1.json',
      childCredentialPath:
        'C:\\Shadow\\state\\credentials\\device-credential.v1.json',
    },
  )
})

test('runtime CLI module imports without reading config or registering process hooks', async () => {
  const imported = await import('./runtime-cli.ts')
  assertEquals(typeof imported.dispatchRuntimeCli, 'function')
  assertEquals(typeof imported.deriveRuntimePaths, 'function')
})
