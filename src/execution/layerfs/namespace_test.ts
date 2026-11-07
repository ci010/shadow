import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { ManagedLayerFS, ManagedRuntimeError, managedLayerFS, closeManagedLayerFS, type Deployment, type ManagedDriver } from './managed.ts'
import { ReadTool } from '../../tools/read.ts'
import { LayerFSNamespaces } from './namespace.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { ToolOutcomeUnknownError, ToolNoEffectError, toolResultText } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { BootstrapRun } from './bootstrap-command.ts'
import { layerfsName } from './bridge.ts'

const signal = () => new AbortController().signal
const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false, activeCalls: 0 }
const inactive: BootstrapRun = async command => ({ code: 0, stdout: Buffer.from(command.file === 'powershell.exe' ? '0' : command.args.includes('--running') ? '' : 'FixtureWSL\r\n'), stderr: Buffer.alloc(0) })
async function fixture(work: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), '.layerfs-namespace-test-')), home = join(root, 'home'), state = join(home, 'state', 'layerfs')
  const oldFiles = new Map<string, string>()
  const deployments: Deployment[] = [], calls: string[] = []
  let current: Deployment | undefined, imported = false, failImport = false, activeCalls = 0
  let service: ManagedLayerFS | undefined
  try {
    await mkdir(join(home, 'config'), { recursive: true }); await mkdir(join(state, 'runtime', '.runtime'), { recursive: true })
    const apiRoot = join(root, 'api'); await mkdir(join(apiRoot, 'api', 'agent', 'src'), { recursive: true })
    await writeFile(join(apiRoot, 'api', 'agent', 'src', 'index.js'), `export const LayerFS={open:async project=>({project:{list_branches:async()=>({project,volume:process.env.LAYERFS_VOLUME})},workspace:{exec:async(_ws,_command,_message,sinks)=>{await new Promise(r=>sinks.stdout.write('namespace:'+project,r));return {code:0}}},close:async()=>{}})}`)
    const profile = JSON.stringify({ version: 1, projectId: 'p', approvedRootWorker: true, installation: { apiRoot, bundle: '/fixture/build', image: 'sha256:' + 'a'.repeat(64), distribution: 'FixtureWSL', node: '/fixture/node' } })
    oldFiles.set(join(home, 'config', 'layerfs-managed.json'), profile)
    oldFiles.set(join(state, 'worker-state.json'), JSON.stringify({ phase: 'uncertain' }))
    oldFiles.set(join(state, 'import-state.json'), JSON.stringify({ stage: 'failed', code: 'ImportDeadline' }))
    oldFiles.set(join(state, 'runtime', '.runtime', 'init-failures.jsonl'), JSON.stringify({ project: { name: layerfsName('p') }, code: 'Failed', message: 'Project(Deadline) PRIVATE_KEY' }) + '\n')
    for (const [path, content] of oldFiles) await writeFile(path, content)
    const factory = (): ManagedDriver => ({ async request(action, input: any, _signal, progress) {
      calls.push(action)
      if (action === 'open') { current = input as Deployment; deployments.push(current); imported = false; return { ...ready, activeCalls } }
      if (action === 'status') return { ...ready, activeCalls }
      if (action === 'import_status') return { stage: 'not_started' }
      if (action === 'create') {
        if (failImport) { progress?.({ stage: 'failed', code: 'ImportDeadline', endedAt: Date.now() }); throw new ManagedRuntimeError('ImportDeadline') }
        imported = true; return { kind: 'Initialized', project: current!.project }
      }
      if (action === 'configuration') {
        if (!imported) throw new ManagedRuntimeError('NotInitialized')
        const s = current!.settings, volume = `${s.containerPrefix}store`
        return { sdkModule: current!.sdkModule, env: { LAYERFS_HOME: s.wsl.home, LAYERFS_DOCKER: '/var/run/docker.sock', LAYERFS_IMAGE: s.image, LAYERFS_DAEMON: s.bundle + '/layerfs-daemon',
          LAYERFS_VOLUME: volume, LAYERFS_STORE_PATH: `/var/lib/docker/volumes/${volume}/_data/global/store.sqlite`, LAYERFS_CONTAINER_PREFIX: s.containerPrefix, LAYERFS_WORKER_ENDPOINT: join(s.home, 'worker', 'endpoint.json') } }
      }
      throw Error('Unexpected fixture request')
    }, async close() { calls.push('close') } })
    service = managedLayerFS('p', home, () => new ManagedLayerFS('p', home, factory, 'win32'))
    await work({ root, home, state, oldFiles, service, factory, calls, deployments, setActive: (n: number) => { activeCalls = n }, setFailure: () => { failImport = true } })
  } finally { if (service) await closeManagedLayerFS('p', home); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('approved quarantine preserves old evidence, selects disjoint identities, blocks stale mounts and survives reload', async () => {
  await fixture(async f => {
    const plan = await f.service.importRecoveryPlan(signal())
    const recovery = await f.service.recoverImport(plan.fingerprint, 'web:owner', signal(), inactive)
    assert.equal(recovery.status, 'quarantined'); assert.equal(recovery.workerStarted, false); assert.equal(recovery.imported, false)
    assert.notEqual(recovery.project, layerfsName('p')); assert.match(recovery.namespace, /^[a-f0-9]{32}$/)
    assert.deepEqual(f.calls, [], 'Quarantine cannot load the SDK or start a worker')
    for (const [path, content] of f.oldFiles) assert.equal(await readFile(path, 'utf8'), content)
    const status = await f.service.namespaceStatus()
    assert.equal(status.quarantined.records[0].namespace, 'legacy'); assert.equal(status.quarantined.records[0].importCode, 'ImportDeadline')
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_KEY/)
    assert.equal((await f.service.importStatus(signal())).stage, 'not_started')
    await assert.rejects(f.service.connect(signal(), undefined, 'legacy'), /namespace changed/)
    await assert.rejects(f.service.create(join(f.root, 'stale-source'), signal(), 300000, 'legacy'), /namespace changed/)
    await assert.rejects(f.service.configuration(signal(), 'legacy'), /namespace changed/)
    assert.deepEqual(f.calls, [])
    await f.service.connect(signal())
    assert.equal(f.deployments[0].project, recovery.project)
    assert.equal(f.deployments[0].settings.home, join(f.state, 'generations', recovery.namespace, 'runtime'))
    await f.service.create(join(f.root, 'reviewed-source'), signal())
    const tool = new LayerFSTool('p', f.home, f.service)
    const context = { projectId: 'p', sessionId: 'web:owner', signal: signal() } as ExecutionContext
    const result = JSON.parse(toolResultText(await tool.execute({ action: 'branches', namespace: recovery.namespace }, context)))
    assert.equal(result.result.project, recovery.project)
    const newMount = 'layerfs:' + Buffer.from(JSON.stringify({ project: recovery.project, sandbox: '1', path: '/workspaces/1' })).toString('base64url')
    const read = await new ReadTool(f.home).execute({ workspace: newMount, path: 'index.ts' }, { ...context, resolveToolTarget: async () => { throw Error('Must not fall back to host') } })
    assert.equal(JSON.parse(toolResultText(read)).result.stdout.text, `namespace:${recovery.project}`)
    const oldMount = 'layerfs:' + Buffer.from(JSON.stringify({ project: layerfsName('p'), sandbox: '1', path: '/workspaces/1' })).toString('base64url')
    await assert.rejects(tool.execute({ action: 'read', workspace: oldMount, path: 'index.ts' }, context), /another Project/)
    await assert.rejects(tool.execute({ action: 'connect', namespace: 'legacy' }, context), /not active/)
    await f.service.close()
    const fresh = new ManagedLayerFS('p', f.home, f.factory, 'win32')
    try {
      assert.equal((await fresh.namespaceInfo()).namespace, recovery.namespace)
      assert.equal((await fresh.describe()).phase, 'stopped')
      await fresh.connect(signal())
      assert.deepEqual(f.deployments[1], f.deployments[0])
    } finally { await fresh.close() }
    for (const [path, content] of f.oldFiles) assert.equal(await readFile(path, 'utf8'), content)
  })
})

for (const reason of ['changed-evidence', 'active-helper', 'foreign-lock']) test(`namespace selection refuses ${reason} and leaves original files/pointer intact`, async () => {
  await fixture(async f => {
    const plan = await f.service.importRecoveryPlan(signal())
    if (reason === 'changed-evidence') await writeFile(join(f.state, 'import-state.json'), JSON.stringify({ stage: 'unknown', code: 'OUTCOME_UNKNOWN' }))
    if (reason === 'foreign-lock') await writeFile(join(f.state, 'namespace-recovery.lock'), 'foreign-owner')
    const probe: BootstrapRun = reason === 'active-helper' ? async () => ({ code: 0, stdout: Buffer.from('1'), stderr: Buffer.alloc(0) }) : inactive
    await assert.rejects(f.service.recoverImport(plan.fingerprint, 'web:owner', signal(), probe), reason === 'active-helper' ? ToolOutcomeUnknownError : ToolNoEffectError)
    await assert.rejects(lstat(join(f.state, 'active-generation.json')), { code: 'ENOENT' })
    assert.equal(await readFile(join(f.state, 'worker-state.json'), 'utf8'), f.oldFiles.get(join(f.state, 'worker-state.json')))
    assert.deepEqual(f.calls, [])
    if (reason === 'foreign-lock') assert.equal(await readFile(join(f.state, 'namespace-recovery.lock'), 'utf8'), 'foreign-owner')
  })
})

test('owned worker must prove zero active calls before graceful close; quarantine never force-kills it', async () => {
  for (const active of [0, 1]) await fixture(async f => {
    await writeFile(join(f.state, 'worker-state.json'), JSON.stringify({ phase: 'stopped' }))
    await rm(join(f.state, 'import-state.json')) // Synthetic fixture only, before this worker exists.
    await f.service.connect(signal()); f.setFailure()
    await assert.rejects(f.service.create(join(f.root, 'source'), signal()), ManagedRuntimeError)
    f.setActive(active)
    const plan = await f.service.importRecoveryPlan(signal())
    if (active) {
      await assert.rejects(f.service.recoverImport(plan.fingerprint, 'web:owner', signal(), inactive), /not confirmed idle/)
      assert.equal(f.calls.includes('close'), false)
    } else {
      const recovery = await f.service.recoverImport(plan.fingerprint, 'web:owner', signal(), inactive)
      assert.equal(recovery.status, 'quarantined'); assert.equal(f.calls.filter((x: string) => x === 'close').length, 1)
    }
  })
})

test('shutdown waits for quarantine and blocks selecting a fresh namespace', async () => {
  await fixture(async f => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const plan = await f.service.importRecoveryPlan(signal())
    let first = true
    const probe: BootstrapRun = async (command, abort) => { if (first) { first = false; entered.resolve(); await release.promise }; return inactive(command, abort) }
    const recovering = f.service.recoverImport(plan.fingerprint, 'web:owner', signal(), probe)
    await entered.promise
    let stopped = false
    const closing = f.service.close().then(() => { stopped = true })
    await Promise.resolve(); assert.equal(stopped, false)
    release.resolve()
    await assert.rejects(recovering, ToolOutcomeUnknownError); await closing
    await assert.rejects(lstat(join(f.state, 'active-generation.json')), { code: 'ENOENT' })
    assert.deepEqual(f.calls, [])
  })
})

test('malformed, foreign or dangling active namespaces never fall back to legacy', async () => {
  await fixture(async f => {
    for (const pointer of [{ version: 1, projectId: 'other', namespace: 'a'.repeat(32) }, { version: 1, projectId: 'p', namespace: '../escape' }, { version: 1, projectId: 'p', namespace: 'a'.repeat(32) }]) {
      await writeFile(join(f.state, 'active-generation.json'), JSON.stringify(pointer))
      await assert.rejects(new LayerFSNamespaces('p', f.home).current(), ToolOutcomeUnknownError)
    }
    assert.deepEqual(f.calls, [])
  })
})

test('pointer loss after selection and interrupted preparation cannot revive legacy on restart', async () => {
  for (const selected of [false, true]) await fixture(async f => {
    // Even a reusable-looking legacy worker marker must not permit fallback.
    await writeFile(join(f.state, 'worker-state.json'), JSON.stringify({ phase: 'stopped' }))
    if (selected) {
      const plan = await f.service.importRecoveryPlan(signal())
      await f.service.recoverImport(plan.fingerprint, 'web:owner', signal(), inactive)
      await rm(join(f.state, 'active-generation.json')) // Simulated pointer loss, fixture only.
    } else {
      const store = new LayerFSNamespaces('p', f.home)
      await store.prepare(store.reference(), { ownerSessionId: 'web:owner', evidence: 'stopped_distribution', priorFingerprint: 'a'.repeat(64), importStage: 'failed', importCode: 'ImportDeadline' })
      store.endPreparation() // Simulated process loss before the pointer commit.
    }
    let starts = 0
    const fresh = new ManagedLayerFS('p', f.home, () => { starts++; return f.factory() }, 'win32')
    await assert.rejects(fresh.namespaceInfo(), ToolOutcomeUnknownError)
    await assert.rejects(fresh.connect(signal()), ToolOutcomeUnknownError)
    assert.equal(starts, 0)
    await fresh.close()
    assert.equal(JSON.parse(await readFile(join(f.state, 'worker-state.json'), 'utf8')).phase, 'stopped')
  })
})

test('successive quarantines retain a bounded history chain and distinct project/home identities', async () => {
  await fixture(async f => {
    const firstPlan = await f.service.importRecoveryPlan(signal())
    const first = await f.service.recoverImport(firstPlan.fingerprint, 'web:owner', signal(), inactive)
    f.setFailure(); await f.service.connect(signal())
    await assert.rejects(f.service.create(join(f.root, 'reviewed-source'), signal()), ManagedRuntimeError)
    const retained = await readFile(join(f.state, 'generations', first.namespace, 'import-state.json'), 'utf8')
    const secondPlan = await f.service.importRecoveryPlan(signal())
    const second = await f.service.recoverImport(secondPlan.fingerprint, 'web:owner', signal(), inactive)
    assert.notEqual(first.namespace, second.namespace); assert.notEqual(first.project, second.project)
    assert.equal(await readFile(join(f.state, 'generations', first.namespace, 'import-state.json'), 'utf8'), retained)
    const history = (await f.service.namespaceStatus()).quarantined
    assert.deepEqual(history.records.map((r: any) => r.namespace), [first.namespace, 'legacy'])
    assert.equal(history.truncated, false)
    await f.service.connect(signal())
    assert.notEqual(f.deployments[0].settings.wsl.home, f.deployments[1].settings.wsl.home)
    assert.notEqual(f.deployments[0].settings.containerPrefix, f.deployments[1].settings.containerPrefix)
  })
})
