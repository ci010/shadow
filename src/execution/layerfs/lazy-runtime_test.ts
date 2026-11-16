import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { LayerFSResources } from './resource-service.ts'
import { ManagedLayerFS, ManagedRuntimeError, type Deployment } from './managed.ts'
import { branchWorkspace } from './workspace-identity.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

// Source-level SDK boundary fixtures: no subprocesses, listeners, WSL or Docker.
const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
async function fixture() {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-lazy-test-'))
  const home = join(dir, 'home'), services: LayerFSResources[] = []
  const image = (id: string) => 'sha256:' + (id === 'A' ? 'a' : 'b').repeat(64)
  const installation = { apiRoot: dir, bundle: '/fixture', node: '/bin/node', distribution: 'Fixture', image: image('A') }
  for (const name of ['agent', 'runtime']) {
    await mkdir(join(dir, 'api', name, 'src'), { recursive: true })
    await writeFile(join(dir, 'api', name, 'package.json'), JSON.stringify({ name: '@layerfs/' + name }))
    await writeFile(join(dir, 'api', name, 'src', 'index.js'), '')
  }
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const owner = { projectId: 'one', sessionId: 'setup-session', channel: 'web', admin: true, isGroup: false, tools, signal: new AbortController().signal } as ExecutionContext
  const agent = { ...owner, sessionId: 'task-session', channel: 'task', admin: false, tools: { executionMode: 'task' } } as ExecutionContext
  const homeOf = (id: string) => join(home, 'layerfs-catalog/runtimes', id)
  const record = (id: string) => join(homeOf(id), 'runtime.json')
  const state = (id: string) => join(projectDataPaths(homeOf(id)).state, 'layerfs/worker-state.json')
  const launches: { id: string; action: string; deployment: Deployment }[] = []
  const commands: { id: string; action: string; image: string }[] = []
  const closes: string[] = []
  let hook: ((id: string, action: string) => Promise<void>) | undefined
  const create = () => {
    const service = new LayerFSResources('one', home, { installation: async () => installation,
      runtime: runtimeHome => {
        const id = basename(runtimeHome)
        return new ManagedLayerFS('one', runtimeHome, () => ({ request: async (action, input) => {
          if (action === 'open' || action === 'recover_open') {
            launches.push({ id, action, deployment: input as Deployment })
            await hook?.(id, action)
          }
          if (action === 'configuration') await hook?.(id, action)
          if (action === 'configuration') return { sdkModule: join(dir, 'api/agent/src/index.js'), env: {
            LAYERFS_HOME: '/fixture/' + id, LAYERFS_DOCKER: '/var/run/docker.sock', LAYERFS_IMAGE: image(id), LAYERFS_DAEMON: '/sealed/layerfs-daemon',
            LAYERFS_VOLUME: 'volume-' + id, LAYERFS_STORE_PATH: '/fixture/' + id + '/store.sqlite', LAYERFS_CONTAINER_PREFIX: 'fixture-', LAYERFS_WORKER_ENDPOINT: join(runtimeHome, 'endpoint.json'),
          } }
          return ready
        }, close: async () => { closes.push(id) } }), 'win32')
      },
      bridge: async (config, project, action, args) => {
        // Synthetic ordinary-operation guard: activation must not bypass or erase it.
        try { if (await readFile(String(args.journal), 'utf8') === 'UNKNOWN') throw new ToolOutcomeUnknownError('retained branch operation') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        commands.push({ id: project, action, image: config.env.LAYERFS_IMAGE })
        return JSON.stringify({ ok: true, result: { text: 'hello', code: 0 } })
      },
    })
    services.push(service); return service
  }
  const seed = create()
  const bindings = new Map<string, string>()
  for (const id of ['A', 'B']) {
    installation.image = image(id)
    await seed.runtimePlan(id, owner); await seed.runtimeStart(id, owner)
    const resource = seed.catalog.register({ name: id, runtimeId: id, layerfsProject: id, image: image(id), baselineRef: 'aa', source: { repository: 'https://example.com/' + id, commit: 'c'.repeat(40) } })
    for (const branch of ['first', 'second']) {
      const binding = branchWorkspace(id, branch, { ownerProject: 'one', runtimeId: id, resourceId: resource.revision })
      seed.catalog.bindWorkspace(binding); bindings.set(id + ':' + branch, binding)
    }
  }
  await seed.close(); launches.length = 0; closes.length = 0
  const args = (id = 'A', branch = 'first') => ({ workspace: bindings.get(id + ':' + branch)!, path: '/README.md' })
  return { dir, home, owner, agent, create, launches, commands, closes, args, homeOf, record, state, image,
    hook: (value: typeof hook) => { hook = value },
    async cleanup() { await Promise.allSettled(services.map(service => service.close())); await rm(dir, { recursive: true, force: true }) },
  }
}

function gate() {
  let release!: () => void, enter!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { release, entered, async hold() { enter(); await waiting } }
}

test('workspace first use lazily activates only its runtime; concurrent sessions share admission, not session ownership', async () => {
  const f = await fixture(), held = gate()
  try {
    const service = f.create(), catalog = service.catalog.list()
    assert.equal((await service.runtimeStatus('A', f.agent.signal)).phase, 'stopped')
    assert.equal(f.launches.length, 0, 'discovery/status/catalog construction never starts runtimes')
    await assert.rejects(service.runtimeStart('A', f.agent), ToolNoEffectError)
    await assert.rejects(service.runtimeRecover('A', f.agent), ToolNoEffectError)
    await assert.rejects(service.runtimeContext('A', f.agent), ToolNoEffectError)
    f.hook(async id => { if (id === 'A') await held.hold() })
    const first = service.execute('read', f.args(), f.agent)
    await held.entered
    const second = service.execute('search', { ...f.args('A', 'second'), handler: 'glob', query: '*' }, { ...f.agent, sessionId: 'another-task' })
    await assert.rejects(service.runtimeStart('A', f.owner), /already admitted/)
    assert.equal(f.launches.length, 1); assert.equal(f.commands.length, 0)
    // Runtime B is independent of A's activation, even with a different image.
    await service.execute('read', f.args('B'), f.agent)
    assert.deepEqual(f.launches.map(value => value.id), ['A', 'B'])
    assert.deepEqual(f.commands.map(value => value.id), ['B'])
    held.release(); await Promise.all([first, second])
    await service.execute('write', { ...f.args(), content: 'new' }, f.agent)
    await service.execute('exec', { ...f.args(), command: 'echo hello' }, f.agent)
    assert.equal(f.launches.length, 2, 'healthy attached runtime reused, not restarted per operation')
    assert.deepEqual(f.launches.map(value => value.action), ['open', 'open'])
    assert.notEqual(f.launches[0].deployment.settings.home, f.launches[1].deployment.settings.home)
    assert.notEqual(f.launches[0].deployment.settings.image, f.launches[1].deployment.settings.image)
    for (const launch of f.launches) assert.equal(launch.deployment.settings.sweep, false)
    for (const command of f.commands) assert.equal(command.image, f.image(command.id))
    assert.deepEqual(service.catalog.list(), catalog)
    assert.equal(JSON.parse(await readFile(f.record('A'), 'utf8')).owner, 'setup-session')
  } finally { held.release(); await f.cleanup() }
})

test('lazy recovery preserves branch uncertainty, admissions and runtime binding; invalid callers cannot trigger it', async () => {
  const f = await fixture()
  try {
    const service = f.create()
    await writeFile(f.state('A'), JSON.stringify({ phase: 'running' })) // Synthetic backend-loss evidence.
    const saved = await readFile(f.record('A'), 'utf8')
    const admission = join(projectDataPaths(f.homeOf('A')).state, 'layerfs/runtime/shadow-init-admissions/A.json')
    const journal = join(f.home, 'layerfs-catalog/operations/A/A.jsonl')
    for (const file of [admission, journal]) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'UNKNOWN') }
    for (const patch of [{ projectId: 'other' }, { recoveringToolCall: true }, { remoteWorkdir: {} }, { signal: AbortSignal.abort(new Error('cancelled before dispatch')) }]) {
      await assert.rejects(service.execute('read', f.args(), { ...f.agent, ...patch } as ExecutionContext))
    }
    const resource = service.catalog.list()[0]
    const forged = branchWorkspace('A', 'forged', { ownerProject: 'one', runtimeId: 'A', resourceId: resource.revision })
    await assert.rejects(service.execute('read', { ...f.args(), workspace: forged }, f.agent), /forged/)
    await assert.rejects(service.execute('status', f.args(), f.agent), /not running/)
    await assert.rejects(service.execute('read', { resourceId: resource.revision, path: '/README.md' }, f.agent), /not running/)
    assert.equal(f.launches.length, 0)
    await assert.rejects(service.execute('read', f.args(), f.agent), /retained branch operation/)
    assert.deepEqual(f.launches.map(value => [value.id, value.action]), [['A', 'recover_open']])
    assert.equal(f.commands.length, 0)
    assert.equal(await readFile(admission, 'utf8'), 'UNKNOWN'); assert.equal(await readFile(journal, 'utf8'), 'UNKNOWN')
    assert.equal(await readFile(f.record('A'), 'utf8'), saved)
    assert.equal(service.catalog.hasWorkspace(f.args().workspace), true)
    assert.equal((await service.runtimeStatus('B', f.agent.signal)).phase, 'stopped')
  } finally { await f.cleanup() }
})

test('lazy activation refuses uncertain/planned startup, retained leases and foreign installation; no recovery replay after lost receipt', async () => {
  const f = await fixture()
  try {
    const service = f.create(), saved = await readFile(f.record('A'), 'utf8')
    for (const phase of ['planned', 'starting', 'unknown']) {
      await writeFile(f.record('A'), JSON.stringify({ ...JSON.parse(saved), phase }))
      await assert.rejects(service.execute('read', f.args(), f.agent), /not settled/)
    }
    await writeFile(f.record('A'), saved)
    for (const phase of ['starting', 'recovering', 'uncertain']) {
      await writeFile(f.state('A'), JSON.stringify({ phase }))
      await assert.rejects(service.execute('read', f.args(), f.agent), /unresolved/)
    }
    await rm(f.state('A'))
    await assert.rejects(service.execute('read', f.args(), f.agent), /unresolved/)
    await writeFile(f.state('A'), JSON.stringify({ phase: 'running' }))
    const lease = join(f.homeOf('A'), 'start-lease.json')
    await writeFile(lease, 'retained')
    await assert.rejects(service.execute('read', f.args(), f.agent), /retained outside/)
    assert.equal(await readFile(lease, 'utf8'), 'retained'); await rm(lease) // Synthetic fixture only.
    await writeFile(f.record('A'), JSON.stringify({ ...JSON.parse(saved), installation: { ...JSON.parse(saved).installation, distribution: 'Other' } }))
    await assert.rejects(service.execute('read', f.args(), f.agent), /installation identity/)
    await writeFile(f.record('A'), saved)
    assert.equal(f.launches.length, 0)
    f.hook(async () => { throw new ManagedRuntimeError('RecoveryOwnerLive') })
    await assert.rejects(service.execute('read', f.args(), f.agent), /RecoveryOwnerLive/)
    assert.equal(await readFile(f.record('A'), 'utf8'), saved)
    assert.equal(JSON.parse(await readFile(f.state('A'), 'utf8')).phase, 'running')
    f.hook(async () => { throw new ToolOutcomeUnknownError('lost activation receipt') })
    await assert.rejects(service.execute('read', f.args(), f.agent), /lost activation/)
    await assert.rejects(service.execute('read', f.args(), f.agent), /not settled/)
    assert.equal(f.launches.length, 2); assert.equal(f.commands.length, 0)
    assert.equal(JSON.parse(await readFile(f.state('A'), 'utf8')).phase, 'uncertain')
    assert.equal(JSON.parse(await readFile(f.record('A'), 'utf8')).phase, 'unknown')
  } finally { await f.cleanup() }
})

test('cancelled waiter does not cancel shared admitted activation; shutdown drains activation without dispatching workspace commands', async () => {
  const f = await fixture(), held = gate(), pending = gate()
  try {
    const service = f.create(), controller = new AbortController()
    f.hook(async id => { if (id === 'A') await held.hold() })
    const first = service.execute('read', f.args(), { ...f.agent, signal: controller.signal })
    const cancelled = assert.rejects(first, /cancelled observation/)
    await held.entered
    const second = service.execute('read', f.args('A', 'second'), f.agent)
    controller.abort(new Error('cancelled observation')); await cancelled
    assert.equal(f.launches.length, 1)
    held.release(); await second
    assert.equal(f.commands.length, 1)
    f.hook(async id => { if (id === 'B') await pending.hold() })
    const read = service.execute('read', f.args('B'), f.agent)
    const refused = assert.rejects(read, /shutting down/)
    await pending.entered
    const closing = service.close()
    await assert.rejects(service.execute('read', f.args(), f.agent), /shutting down/)
    assert.equal(f.closes.length, 0)
    pending.release(); await Promise.all([closing, refused])
    assert.equal(f.commands.length, 1)
    assert.deepEqual([...f.closes].sort(), ['A', 'B'])
    assert.equal(JSON.parse(await readFile(f.state('B'), 'utf8')).phase, 'stopped')
  } finally { held.release(); pending.release(); await f.cleanup() }
})


test('workspace call waits for an explicit start already underway instead of dispatching or starting again', async () => {
  const f = await fixture(), held = gate()
  try {
    const service = f.create()
    f.hook(async () => held.hold())
    const explicit = service.runtimeStart('A', f.owner)
    await held.entered
    const read = service.execute('read', f.args(), f.agent)
    assert.equal(f.commands.length, 0)
    held.release(); await Promise.all([explicit, read])
    assert.equal(f.launches.length, 1); assert.equal(f.commands.length, 1)
    assert.equal(f.launches[0].id, 'A')
  } finally { held.release(); await f.cleanup() }
})


test('shutdown during configuration prevents subsequent workspace bridge dispatch', async () => {
  const f = await fixture(), held = gate()
  try {
    const service = f.create()
    // Activate first, then pause specifically after activation at configuration.
    await service.execute('read', f.args(), f.agent)
    f.commands.length = 0
    f.hook(async (_id, action) => { if (action === 'configuration') await held.hold() })
    const read = service.execute('write', { ...f.args(), content: 'must not dispatch' }, f.agent)
    const refused = assert.rejects(read, /shutting down/)
    await held.entered
    const closing = service.close()
    held.release(); await Promise.all([closing, refused])
    assert.equal(f.commands.length, 0)
    assert.equal(f.launches.length, 1)
  } finally { held.release(); await f.cleanup() }
})
