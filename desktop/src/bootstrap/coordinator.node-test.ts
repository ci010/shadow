import assert from 'node:assert/strict'
import test from 'node:test'
import type { BootstrapStateStorage } from './storage.js'
import type { RuntimeConfigWriter } from './runtime-config.js'
import { BootstrapCoordinator, type MainRuntimeHost } from './coordinator.js'
import type { LaunchProfileStore, MainLaunchProfile } from './launch-profile.js'
import { createWizardState, transitionWizard, type WizardState } from '../wizard/state-machine.js'

class MemoryStorage implements BootstrapStateStorage {
  constructor(private state: WizardState | null) {}
  load = async () => this.state
  save = async (state: WizardState) => { this.state = state }
  clear = async () => { this.state = null }
}

const readyHost: MainRuntimeHost = { start: async () => ({ phase: 'ready' }) }
const readyInitializer = { initialize: async () => undefined }
const readyReader = { readMain: async () => ({ version: 1, mode: 'main', dataDir: 'C:\\data', localNodeId: 'local-node-id' } as const) }

class MemoryLaunchProfiles implements LaunchProfileStore {
  constructor(private profile: MainLaunchProfile | null = null) {}
  load = async () => this.profile
  save = async (profile: MainLaunchProfile) => { this.profile = profile }
}

function createCoordinator(
  storage: BootstrapStateStorage,
  host: MainRuntimeHost = readyHost,
  profiles: LaunchProfileStore = new MemoryLaunchProfiles(),
) {
  return new BootstrapCoordinator(
    storage,
    { writeMain: async () => undefined },
    readyInitializer,
    host,
    profiles,
    readyReader,
  )
}

function mainDirectoryState(): WizardState {
  return transitionWizard(createWizardState(), { type: 'select-role', mode: 'main' })
}

function mainLaunchState(): WizardState {
  let state: WizardState = mainDirectoryState()
  for (const type of ['data-directory-selected', 'main-initialized', 'provider-configured', 'local-capabilities-selected'] as const) {
    state = transitionWizard(state, { type })
  }
  return state
}

test('directory selections are one-shot and failed writes do not advance state', async () => {
  const storage = new MemoryStorage(mainDirectoryState())
  let writes = 0
  const writer: RuntimeConfigWriter = { writeMain: async () => { writes += 1; throw new Error('C:\\secret') } }
  const coordinator = new BootstrapCoordinator(storage, writer, readyInitializer, readyHost, new MemoryLaunchProfiles(), readyReader)
  coordinator.registerDirectorySelection('opaque', 'C:\\private')

  const failed = await coordinator.commitMainDirectory('opaque')
  assert.deepEqual(failed, { ok: false, code: 'write-failed', state: mainDirectoryState() })
  const reused = await coordinator.commitMainDirectory('opaque')
  assert.deepEqual(reused, { ok: false, code: 'invalid-selection', state: mainDirectoryState() })
  assert.equal(writes, 1)
})

test('commit rejects the wrong role or step without consuming the selection', async () => {
  const storage = new MemoryStorage(createWizardState())
  const paths: string[] = []
  const coordinator = new BootstrapCoordinator(storage, { writeMain: async (path) => { paths.push(path) } }, readyInitializer, readyHost, new MemoryLaunchProfiles(), readyReader)
  coordinator.registerDirectorySelection('opaque', 'C:\\private')
  assert.equal((await coordinator.commitMainDirectory('opaque')).ok, false)
  await storage.save(mainDirectoryState())
  assert.equal((await coordinator.commitMainDirectory('opaque')).ok, true)
  assert.deepEqual(paths, ['C:\\private'])
})

test('launch advances only on ready and remains retryable after failure', async () => {
  const storage = new MemoryStorage(mainLaunchState())
  let attempts = 0
  const host: MainRuntimeHost = {
    start: async (options) => {
      assert.deepEqual(options, { role: 'main', localExecutor: true, port: 43123 })
      attempts += 1
      if (attempts === 1) throw new Error('token=secret path=C:\\private')
      return { phase: 'ready' }
    },
  }
  const coordinator = createCoordinator(storage, host)
  const failed = await coordinator.launchMain({ localExecutor: true, port: 43123 })
  assert.deepEqual(failed, { ok: false, code: 'launch-failed', state: mainLaunchState() })
  const succeeded = await coordinator.launchMain({ localExecutor: true, port: 43123 })
  assert.equal(succeeded.ok, true)
  assert.equal(succeeded.state.step, 'complete')
})

test('generic dispatch rejects privileged transitions', async () => {
  const coordinator = new BootstrapCoordinator(
    new MemoryStorage(mainDirectoryState()),
    { writeMain: async () => undefined },
    readyInitializer,
    readyHost,
    new MemoryLaunchProfiles(),
    readyReader,
  )
  await assert.rejects(coordinator.dispatch({ type: 'data-directory-selected' }), /dedicated bootstrap command/)
  await assert.rejects(coordinator.dispatch({ type: 'main-initialized' }), /dedicated bootstrap command/)
  await assert.rejects(coordinator.dispatch({ type: 'sidecar-ready' }), /dedicated bootstrap command/)
})

test('Main initialization advances only after a successful durable config write', async () => {
  const initial = transitionWizard(mainDirectoryState(), { type: 'data-directory-selected' })
  const storage = new MemoryStorage(initial)
  let attempts = 0
  const coordinator = new BootstrapCoordinator(
    storage,
    { writeMain: async () => undefined },
    { initialize: async () => { attempts += 1; if (attempts === 1) throw new Error('C:\\private') } },
    readyHost,
    new MemoryLaunchProfiles(),
    readyReader,
  )

  assert.deepEqual(await coordinator.initializeMain(), {
    ok: false,
    code: 'write-failed',
    state: initial,
  })
  const succeeded = await coordinator.initializeMain()
  assert.equal(succeeded.ok, true)
  assert.equal(succeeded.state.step, 'configure-provider')
  assert.equal(JSON.stringify([succeeded]).includes('private'), false)
})

test('Main initialization rejects the wrong step without writing', async () => {
  let writes = 0
  const coordinator = new BootstrapCoordinator(
    new MemoryStorage(mainDirectoryState()),
    { writeMain: async () => undefined },
    { initialize: async () => { writes += 1 } },
    readyHost,
    new MemoryLaunchProfiles(),
    readyReader,
  )
  assert.deepEqual(await coordinator.initializeMain(), {
    ok: false,
    code: 'invalid-state',
    state: mainDirectoryState(),
  })
  assert.equal(writes, 0)
})

test('concurrent directory commits serialize deterministically and redact private values', async () => {
  const storage = new MemoryStorage(mainDirectoryState())
  const coordinator = new BootstrapCoordinator(
    storage,
    { writeMain: async () => undefined },
    readyInitializer,
    readyHost,
    new MemoryLaunchProfiles(),
    readyReader,
  )
  coordinator.registerDirectorySelection('first', 'C:\\private\\first')
  coordinator.registerDirectorySelection('second', 'C:\\private\\second')

  const [first, second] = await Promise.all([
    coordinator.commitMainDirectory('first'),
    coordinator.commitMainDirectory('second'),
  ])

  assert.equal(first.ok, true)
  assert.deepEqual(second, { ok: false, code: 'invalid-state', state: first.state })
  const publicOutput = JSON.stringify([first, second])
  assert.equal(publicOutput.includes('private'), false)
  assert.equal(publicOutput.includes('first'), false)
  assert.equal(publicOutput.includes('second'), false)
})

test('launch persists the profile before starting the host', async () => {
  const events: string[] = []
  const profiles: LaunchProfileStore = {
    load: async () => null,
    save: async () => { events.push('profile') },
  }
  const host: MainRuntimeHost = {
    start: async () => { events.push('start'); return { phase: 'ready' } },
  }
  const result = await createCoordinator(new MemoryStorage(mainLaunchState()), host, profiles)
    .launchMain({ localExecutor: false, port: 43123 })
  assert.equal(result.ok, true)
  assert.deepEqual(events, ['profile', 'start'])
})

test('ensureRuntime resumes Main from launch or complete with the frozen safe context', async () => {
  const profile = { version: 1, role: 'main', port: 43123, localExecutor: true } as const
  const starts: unknown[] = []
  const host: MainRuntimeHost = {
    start: async (options) => {
      starts.push(options)
      return { phase: 'ready', apiBase: 'http://127.0.0.1:43123' }
    },
  }
  const profiles = new MemoryLaunchProfiles(profile)
  const launchCoordinator = createCoordinator(new MemoryStorage(mainLaunchState()), host, profiles)
  const result = await launchCoordinator.ensureRuntime()
  assert.deepEqual(result, {
    ok: true,
    context: {
      version: 1,
      mode: 'main',
      localNodeId: 'local-node-id',
      mainConnection: 'connected',
      mainLatencyMs: null,
      uiScopes: ['chat:read', 'chat:write', 'knowledge:read', 'main:admin', 'nodes:admin', 'audit:read'],
      apiBase: 'http://127.0.0.1:43123',
    },
  })
  assert.deepEqual(starts, [profile])

  const complete = transitionWizard(mainLaunchState(), { type: 'sidecar-ready' })
  assert.equal((await createCoordinator(new MemoryStorage(complete), host, profiles).ensureRuntime()).ok, true)
})

test('ensureRuntime returns only stable redacted failure codes', async () => {
  assert.deepEqual(await createCoordinator(new MemoryStorage(mainDirectoryState())).ensureRuntime(), {
    ok: false,
    code: 'invalid-state',
  })
  assert.deepEqual(await createCoordinator(new MemoryStorage(mainLaunchState())).ensureRuntime(), {
    ok: false,
    code: 'profile-missing',
  })

  const profiles = new MemoryLaunchProfiles({ version: 1, role: 'main', port: 43123, localExecutor: true })
  const host: MainRuntimeHost = { start: async () => { throw new Error('token=secret C:\\private\\profile.json') } }
  const failure = await createCoordinator(new MemoryStorage(mainLaunchState()), host, profiles).ensureRuntime()
  assert.deepEqual(failure, { ok: false, code: 'runtime-unavailable' })
  assert.equal(JSON.stringify(failure).includes('secret'), false)
  assert.equal(JSON.stringify(failure).includes('private'), false)
})