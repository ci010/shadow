import assert from 'node:assert/strict'
import { DataLayoutController } from './data-layout-controller.js'
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
  for (const type of ['data-directory-selected', 'main-initialized', 'provider-configured'] as const) {
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

test('ensureRuntime preserves safe failure diagnostics and saved setup across retry', async () => {
  const state = transitionWizard(mainLaunchState(), { type: 'sidecar-ready' })
  const storage = new MemoryStorage(state)
  let attempts = 0
  const coordinator = createCoordinator(storage, {
    start: async () => ++attempts === 1
      ? { phase: 'failed', role: 'main', kind: 'readiness-timeout', elapsedMs: 15000, message: 'private-key' }
      : { phase: 'ready', apiBase: 'http://127.0.0.1:43123' },
  }, new MemoryLaunchProfiles({ version: 1, role: 'main', localExecutor: false, port: 43123 }))
  assert.deepEqual(await coordinator.ensureRuntime(), {
    ok: false, code: 'runtime-unavailable',
    failure: { role: 'main', kind: 'readiness-timeout', elapsedMs: 15000 },
  })
  assert.deepEqual(await storage.load(), state)
  assert.equal((await coordinator.ensureRuntime()).ok, true)
  assert.deepEqual(await storage.load(), state)
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
// Both entry points converge on RuntimeHost; profiles are deliberately not migrated.
test('development overrides wizard and saved production ports without rewriting profiles', async () => {
  const { RuntimeHost } = await import('../sidecar/runtime-host.js')
  for (const packaged of [false, true]) {
    const starts: number[] = []
    const host = new RuntimeHost({
      paths: { executablePath: 'node', appPath: '.', resourcesPath: '.', userDataPath: '.', packaged },
      environment: { SHADOW_DESKTOP_DEV_IPC: '1' },
      supervisorFactory: () => ({
        status: { phase: 'stopped' },
        start: async (request) => {
          starts.push(request.port)
          return { phase: 'ready', role: request.role, apiBase: `http://127.0.0.1:${request.port}` }
        },
        stop: async () => undefined,
      }),
    })
    const profile = { version: 1, role: 'main', port: 43123, localExecutor: true } as const
    let saves = 0
    const profiles: LaunchProfileStore = {
      load: async () => profile,
      save: async (saved) => { saves++; assert.deepEqual(saved, profile) },
    }
    const coordinator = createCoordinator(new MemoryStorage(mainLaunchState()), host, profiles)
    assert.equal((await coordinator.launchMain({ port: 43123, localExecutor: true })).ok, true)
    assert.equal(saves, 1)
    // A new host exercises the saved-profile resume rather than cached startup.
    await host.stop()
    const resumedHost = new RuntimeHost({
      paths: { executablePath: 'node', appPath: '.', resourcesPath: '.', userDataPath: '.', packaged },
      environment: { SHADOW_DESKTOP_DEV_IPC: '1' },
      supervisorFactory: () => ({
        status: { phase: 'stopped' },
        start: async (request) => {
          starts.push(request.port)
          return { phase: 'ready', role: request.role, apiBase: `http://127.0.0.1:${request.port}` }
        },
        stop: async () => undefined,
      }),
    })
    const resumed = createCoordinator(new MemoryStorage(mainLaunchState()), resumedHost, profiles)
    const result = await resumed.ensureRuntime()
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.context.apiBase, `http://127.0.0.1:${packaged ? 43123 : 43124}`)
    assert.deepEqual(starts, packaged ? [43123, 43123] : [43124, 43124])
    assert.equal(saves, 1)
    assert.equal(profile.port, 43123)
    await resumedHost.stop()
  }
})

test('Main role preference survives setup reload, launch retry and later runtime restart', async () => {
  const storage = new MemoryStorage(null)
  const profiles = new MemoryLaunchProfiles()
  let attempts = 0
  const starts: unknown[] = []
  const host: MainRuntimeHost = { start: async options => {
    starts.push(options)
    if (++attempts === 1) throw new Error('retry launch')
    return { phase: 'ready', apiBase: 'http://127.0.0.1:43123' }
  } }
  let coordinator = createCoordinator(storage, host, profiles)
  await coordinator.dispatch({ type: 'select-role', mode: 'main', localExecutor: false })
  coordinator = createCoordinator(storage, host, profiles)
  assert.equal((await coordinator.load() as { localExecutor?: boolean }).localExecutor, false)
  coordinator.registerDirectorySelection('main-folder', 'C:\\test-main')
  assert.equal((await coordinator.commitMainDirectory('main-folder')).ok, true)
  assert.equal((await coordinator.initializeMain()).ok, true)
  assert.equal((await coordinator.dispatch({ type: 'provider-configured' })).step, 'launch-main')
  // Persisted selection is authoritative even if a stale renderer sends the old default.
  assert.equal((await coordinator.launchMain({ localExecutor: true, port: 43123 })).ok, false)
  assert.equal((await coordinator.launchMain({ localExecutor: true, port: 43123 })).ok, true)
  assert.equal((await coordinator.ensureRuntime()).ok, true)
  assert.deepEqual(starts, [
    { role: 'main', localExecutor: false, port: 43123 },
    { role: 'main', localExecutor: false, port: 43123 },
    { version: 1, role: 'main', localExecutor: false, port: 43123 },
  ])
  assert.deepEqual(await profiles.load(), { version: 1, role: 'main', localExecutor: false, port: 43123 })
})

function mainProviderState(): WizardState {
  return transitionWizard(transitionWizard(mainDirectoryState(), { type: 'data-directory-selected' }), { type: 'main-initialized' })
}

test('prepareProvider starts the authenticated host and exposes only safe context without completing setup', async () => {
  const { RuntimeHost } = await import('../sidecar/runtime-host.js')
  const { RuntimeStartup } = await import('./runtime-startup.js')
  const state = mainProviderState()
  const storage = new MemoryStorage(state)
  const profiles = new MemoryLaunchProfiles()
  let launches = 0
  let authorized: unknown
  let status: import('../sidecar/supervisor.js').SidecarStatus = { phase: 'stopped' }
  const host = new RuntimeHost({
    paths: { executablePath: 'node', appPath: '.', resourcesPath: '.', userDataPath: '.', packaged: true },
    tokenFactory: () => 'synthetic-private-launch-token',
    onAuthorizationChanged: authorization => { authorized = authorization },
    supervisorFactory: () => ({
      get status() { return status },
      start: async request => {
        launches++
        assert.deepEqual(await profiles.load(), { version: 1, role: 'main', port: 43123, localExecutor: false })
        status = { phase: 'ready', role: request.role, apiBase: 'http://127.0.0.1:43123' }
        return status
      },
      stop: async () => undefined,
    }),
  })
  const coordinator = createCoordinator(storage, host, profiles)
  const startup = new RuntimeStartup(() => coordinator.ensureRuntime(), () => host.status)
  const result = await startup.start(() => coordinator.prepareProvider({ port: 43123, localExecutor: false }))
  assert.deepEqual(result, {
    ok: true,
    context: {
      version: 1, mode: 'main', localNodeId: 'local-node-id', mainConnection: 'connected', mainLatencyMs: null,
      uiScopes: ['chat:read', 'chat:write', 'knowledge:read', 'main:admin', 'nodes:admin', 'audit:read'],
      apiBase: 'http://127.0.0.1:43123',
    },
  })
  assert.deepEqual(authorized, { apiBase: 'http://127.0.0.1:43123', launchToken: 'synthetic-private-launch-token' })
  assert.equal(JSON.stringify(result).includes('token'), false)
  assert.deepEqual(await startup.current(), result)
  assert.deepEqual(await storage.load(), state)
  // A reload and stale default options reuse the profile and the same backend.
  assert.deepEqual(await coordinator.ensureRuntime(), result)
  assert.deepEqual(await coordinator.prepareProvider({ port: 43124, localExecutor: true }), result)
  assert.deepEqual(await storage.load(), state)
  await coordinator.dispatch({ type: 'provider-configured' })
  assert.equal((await coordinator.launchMain({ port: 43124, localExecutor: true })).ok, true)
  assert.equal((await coordinator.load()).step, 'complete')
  assert.equal(launches, 1)
  await host.stop()
})

test('prepareProvider failures retain setup and safe diagnostics, then retry with saved localExecutor', async () => {
  const initial = mainProviderState()
  assert.equal(initial.mode, 'main')
  const state = { ...initial, mode: 'main' as const, localExecutor: false }
  const storage = new MemoryStorage(state)
  const profiles = new MemoryLaunchProfiles()
  let attempts = 0
  const coordinator = createCoordinator(storage, {
    start: async options => {
      assert.equal(options.localExecutor, false)
      if (++attempts === 1) return { phase: 'failed', role: 'main', kind: 'readiness-timeout', elapsedMs: 15000, message: 'private-token' }
      if (attempts === 2) throw new Error('C:\\private token=secret')
      return { phase: 'ready', apiBase: 'http://127.0.0.1:43123' }
    },
  }, profiles)
  assert.deepEqual(await coordinator.prepareProvider({ port: 43123, localExecutor: true }), {
    ok: false, code: 'runtime-unavailable', failure: { role: 'main', kind: 'readiness-timeout', elapsedMs: 15000 },
  })
  assert.deepEqual(await profiles.load(), { version: 1, role: 'main', port: 43123, localExecutor: false })
  assert.deepEqual(await storage.load(), state)
  assert.deepEqual(await coordinator.prepareProvider({ port: 43123, localExecutor: true }), { ok: false, code: 'runtime-unavailable' })
  assert.deepEqual(await storage.load(), state)
  assert.equal((await coordinator.ensureRuntime()).ok, true)
  assert.deepEqual(await storage.load(), state)
})

test('prepareProvider rejects early Main, complete and every Child step without config writes or starts', async () => {
  const child = transitionWizard(createWizardState(), { type: 'select-role', mode: 'child' })
  for (const state of [
    createWizardState(), mainDirectoryState(),
    transitionWizard(mainDirectoryState(), { type: 'data-directory-selected' }),
    transitionWizard(mainLaunchState(), { type: 'sidecar-ready' }),
    ...(['enter-pairing-offer', 'verify-fingerprint', 'name-device', 'choose-capabilities', 'launch-child', 'complete'] as const)
      .map(step => ({ ...child, mode: 'child' as const, step })),
  ]) {
    const unexpected = async (): Promise<never> => { assert.fail('invalid state must have no side effects') }
    const storage = new MemoryStorage(state)
    const coordinator = new BootstrapCoordinator(storage, { writeMain: unexpected }, { initialize: unexpected },
      { start: unexpected }, { load: unexpected, save: unexpected }, { readMain: unexpected })
    assert.deepEqual(await coordinator.prepareProvider({ port: 43123, localExecutor: true }), { ok: false, code: 'invalid-state' })
    assert.deepEqual(await storage.load(), state)
  }
})

test('prepareProvider resumes legacy launch-main without requiring a profile or advancing its state', async () => {
  const state = mainLaunchState()
  const storage = new MemoryStorage(state)
  const profiles = new MemoryLaunchProfiles()
  const coordinator = createCoordinator(storage, { start: async () => ({ phase: 'ready', apiBase: 'http://127.0.0.1:43123' }) }, profiles)
  assert.equal((await coordinator.prepareProvider({ port: 43123, localExecutor: false })).ok, true)
  assert.deepEqual(await storage.load(), state)
  assert.deepEqual(await profiles.load(), { version: 1, role: 'main', localExecutor: false, port: 43123 })
})

test('provider preparation cannot bypass durable profile failures or overwrite a saved Child profile', async () => {
  for (const profiles of [
    { load: async () => null, save: async () => { throw new Error('private path') } },
    { load: async () => { throw new Error('private path') }, save: async () => assert.fail('must not overwrite unreadable profile') },
    { load: async () => ({ version: 1, role: 'child', port: 43124 } as const), save: async () => assert.fail('must not overwrite Child profile') },
  ]) {
    const state = mainProviderState()
    const storage = new MemoryStorage(state)
    const coordinator = createCoordinator(storage, { start: async () => assert.fail('must not start without a saved Main profile') }, profiles)
    assert.deepEqual(await coordinator.prepareProvider({ port: 43123, localExecutor: true }), { ok: false, code: 'runtime-unavailable' })
    assert.deepEqual(await storage.load(), state)
  }
  assert.deepEqual(await createCoordinator(new MemoryStorage(mainProviderState())).ensureRuntime(), { ok: false, code: 'profile-missing' })
})


test('selected legacy directory is gated before config or initialization writes and continues after explicit upgrade', async () => {
  let ready = false, writes = 0, initialized = 0, starts = 0
  const roots: string[] = []
  const gate = new DataLayoutController(async root => { roots.push(root); return { status: ready ? 'ready' : 'migration-required' } }, async root => { assert.equal(root, 'C:\\legacy'); ready = true })
  const coordinator = new BootstrapCoordinator(new MemoryStorage(mainDirectoryState()),
    { writeMain: async () => { writes++ } }, { initialize: async () => { initialized++ } },
    { start: async () => { starts++; return { phase: 'ready' } } }, new MemoryLaunchProfiles(), readyReader, () => 'C:\\default', undefined, gate)
  coordinator.registerDirectorySelection('legacy', 'C:\\legacy')
  assert.equal((await coordinator.commitMainDirectory('legacy')).ok, false)
  assert.equal(writes + initialized + starts, 0)
  assert.equal((await coordinator.dataLayoutStatus())?.dataDir, 'C:\\legacy')
  assert.equal((await coordinator.upgradeDataLayout()).status, 'ready')
  assert.equal((await coordinator.commitMainDirectory('legacy')).ok, true)
  assert.equal((await coordinator.initializeMain()).ok, true)
  assert.equal(writes, 1)
  assert.equal(initialized, 1)
  assert.ok(roots.every(root => root === 'C:\\legacy'))
})

test('complete legacy profile is detected before backend starts; upgraded profile continues', async () => {
  let ready = false, starts = 0
  const state = transitionWizard(mainLaunchState(), { type: 'sidecar-ready' })
  const gate = new DataLayoutController(async () => ({ status: ready ? 'ready' : 'migration-required' }), async () => { ready = true })
  const coordinator = new BootstrapCoordinator(new MemoryStorage(state), { writeMain: async () => { throw Error('unexpected write') } }, readyInitializer,
    { start: async () => { starts++; return { phase: 'ready', apiBase: 'http://127.0.0.1:43123' } } },
    new MemoryLaunchProfiles({ version: 1, role: 'main', port: 43123, localExecutor: true }), readyReader, undefined, undefined, gate)
  assert.equal((await coordinator.ensureRuntime()).ok, false)
  assert.equal(starts, 0)
  await coordinator.upgradeDataLayout()
  assert.equal((await coordinator.ensureRuntime()).ok, true)
  assert.equal(starts, 1)
})


test('role switch waits for in-flight runtime start, freezes later writes and never starts the target in-process', async () => {
  const storage = new MemoryStorage({ version: 1, revision: 4, mode: 'main', step: 'complete' })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const coordinator = createCoordinator(storage, { start: async () => {
    order.push('start'); await pending; order.push('ready'); return { phase: 'ready', apiBase: 'http://127.0.0.1:43123' }
  } }, new MemoryLaunchProfiles({ version: 1, role: 'main', port: 43123, localExecutor: false }))
  const starting = coordinator.ensureRuntime()
  const switching = coordinator.switchRole('child', async current => { assert.equal(current, 'main'); order.push('stop'); order.push('commit-pointer') })
  const later = coordinator.clear()
  release()
  await starting
  await switching
  await assert.rejects(later, /switch is in progress/)
  assert.deepEqual(order, ['start', 'ready', 'stop', 'commit-pointer'])
  assert.equal((await storage.load())?.mode, 'main')
  await assert.rejects(coordinator.ensureRuntime(), /switch is in progress/)
})

test('failed role stop/commit retains original state and requires reopening rather than spawning concurrent writers', async () => {
  const storage = new MemoryStorage({ version: 1, revision: 4, mode: 'child', step: 'enter-pairing-offer' })
  const coordinator = createCoordinator(storage)
  await assert.rejects(coordinator.switchRole('main', async () => { throw new Error('stop failed') }), /stop failed/)
  assert.equal((await storage.load())?.mode, 'child')
  await assert.rejects(coordinator.clear(), /switch is in progress/)
})
