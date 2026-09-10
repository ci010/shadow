import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { type Config, ConfigSchema } from '../config/schema.ts'
import {
  type ProcessEntryDependencies,
  runProcessEntry,
} from './process-entry.ts'
import type { RuntimeLifecycleHandle } from './runtime-cli.ts'

type MutableProcessEntryDependencies =
  & {
    -readonly [Key in keyof ProcessEntryDependencies]:
      ProcessEntryDependencies[Key]
  }
  & {
    runtime: {
      -readonly [Key in keyof ProcessEntryDependencies['runtime']]:
        ProcessEntryDependencies['runtime'][Key]
    }
  }

const stoppedLifecycle: RuntimeLifecycleHandle = {
  ready: Promise.resolve(),
  finished: Promise.resolve(),
  shutdown: () => Promise.resolve(),
}

function config(workspace = '/mutable/workspace'): Config {
  return ConfigSchema.parse({ agent: { workspace }, channels: {}, mcp: {} })
}

function dependencies(
  bootstrap: unknown,
  overrides: Partial<ProcessEntryDependencies> = {},
): MutableProcessEntryDependencies {
  return {
    loadConfig: () => Promise.resolve(config()),
    startMainRuntime: () => stoppedLifecycle,
    startChildRuntime: () => stoppedLifecycle,
    runLegacy: () => Promise.resolve(),
    runtime: {
      readTextFile: () => Promise.resolve(JSON.stringify(bootstrap)),
      process: { on: () => {}, off: () => {} },
      pathPlatform: 'posix',
      cwd: '/srv/shadow',
      env: {},
    },
    ...overrides,
  }
}

test('process entry preserves legacy optional config routing', async () => {
  let legacyCalls = 0
  let runtimeReads = 0
  const deps = dependencies({}, {
    runLegacy: () => {
      legacyCalls++
      return Promise.resolve()
    },
  })
  deps.runtime.readTextFile = () => {
    runtimeReads++
    return Promise.resolve('{}')
  }

  const result = await runProcessEntry(
    [process.execPath, 'src/index.ts', 'bot.config.json'],
    deps,
  )

  assertEquals(result, { route: 'legacy' })
  assertEquals(legacyCalls, 1)
  assertEquals(runtimeReads, 0)
})

test('Main start loads the mutable config and preserves its workspace', async () => {
  const mutableConfig = config('/owned/by/mutable-config')
  let loadedPath: string | undefined
  let started: unknown
  const deps = dependencies({
    version: 1,
    mode: 'main',
    dataDir: './state',
    localNodeId: 'main-node',
  }, {
    loadConfig: (path) => {
      loadedPath = path
      return Promise.resolve(mutableConfig)
    },
    startMainRuntime: (receivedConfig, options) => {
      started = { config: receivedConfig, options }
      return stoppedLifecycle
    },
  })
  deps.runtime.env = { GATEWAY_PORT: '43123' }

  const result = await runProcessEntry(
    [process.execPath, 'src/index.ts', 'server', 'start', '--config', 'bootstrap.json'],
    deps,
  )

  assertEquals(result.route, 'runtime')
  assertEquals(loadedPath, '/srv/shadow/state/config/bot.config.json')
  assertEquals(started, {
    config: mutableConfig,
    options: {
      configPath: '/srv/shadow/state/config/bot.config.json',
      clusterSnapshotPath: '/srv/shadow/state/cluster/registry.v1.json',
      gateway: { port: 43123 },
    },
  })
})

test('compiled sidecar argv routes Main startup without a script argument', async () => {
  let started = false
  const deps = dependencies({
    version: 1,
    mode: 'main',
    dataDir: './state',
    localNodeId: 'main-node',
  }, {
    startMainRuntime: () => {
      started = true
      return stoppedLifecycle
    },
  })

  const result = await runProcessEntry(
    ['C:\\Shadow\\shadow.exe', 'server', 'start', '--config', 'bootstrap.json'],
    deps,
  )

  assertEquals(result.route, 'runtime')
  assertEquals(started, true)
})

test('Child validate uses the dispatcher without constructing a factory', async () => {
  let loads = 0
  const deps = dependencies({
    version: 1,
    mode: 'child',
    dataDir: './state',
    localNodeId: 'child-node',
    mainEndpoint: 'https://main.example.test',
  }, {
    loadConfig: () => {
      loads++
      return Promise.resolve(config())
    },
  })

  const result = await runProcessEntry(
    [process.execPath, 'src/index.ts', 'child', 'validate', '--config', 'bootstrap.json'],
    deps,
  )

  assertEquals(result.route, 'runtime')
  if (result.route === 'runtime') assertEquals(result.result.started, false)
  assertEquals(loads, 0)
})

test('Child start invokes only the production Child factory', async () => {
  let loads = 0
  let mainStarts = 0
  let childStart: unknown
  const deps = dependencies({
    version: 1,
    mode: 'child',
    dataDir: './state',
    localNodeId: 'child-node',
    mainEndpoint: 'https://main.example.test',
  }, {
    loadConfig: () => {
      loads++
      return Promise.resolve(config())
    },
    startMainRuntime: () => {
      mainStarts++
      return stoppedLifecycle
    },
    startChildRuntime: (receivedConfig, paths, context) => {
      childStart = { config: receivedConfig, paths, context }
      return stoppedLifecycle
    },
  })

  const result = await runProcessEntry(
    [
      process.execPath,
      'src/index.ts',
      'child',
      'start',
      '--config',
      'bootstrap.json',
    ],
    deps,
  )

  assertEquals(result.route, 'runtime')
  assertEquals(loads, 0)
  assertEquals(mainStarts, 0)
  assertEquals(
    (childStart as { config: { mode: string } }).config.mode,
    'child',
  )
  assertEquals(
    (childStart as { paths: { childCredentialPath: string } }).paths
      .childCredentialPath,
    '/srv/shadow/state/credentials/device-credential.v1.json',
  )
  assertEquals(
    (childStart as { context: unknown }).context,
    {},
  )
})

test('compiled Child argv starts Child instead of falling back to legacy Main', async () => {
  let legacyCalls = 0
  const deps = dependencies({
    version: 1,
    mode: 'child',
    dataDir: './state',
    localNodeId: 'child-node',
    mainEndpoint: 'https://main.example.test',
  }, {
    runLegacy: () => {
      legacyCalls++
      return Promise.resolve()
    },
  })

  const result = await runProcessEntry(
    ['C:\\Shadow\\shadow.exe', 'child', 'start', '--config', 'bootstrap.json'],
    deps,
  )
  assertEquals(result.route, 'runtime')
  assertEquals(legacyCalls, 0)
})
