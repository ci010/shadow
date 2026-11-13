import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LayerFSResources } from './resource-service.ts'
import { ManagedLayerFS } from './managed.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
test('runtime start resumes only a clean stop under the original exclusive owner', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-restart-test-'))
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const context = { projectId: 'one', sessionId: 'owner', admin: true, channel: 'web', isGroup: false, tools, signal: new AbortController().signal } as ExecutionContext
  let opens = 0
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  let fail = false
  const home = join(dir, 'home')
  const runtimeHome = join(home, 'layerfs-catalog', 'runtimes', 'test')
  const record = join(runtimeHome, 'runtime.json')
  const journal = join(projectDataPaths(runtimeHome).state, 'layerfs', 'worker-state.json')
  const installation = { apiRoot: dir, bundle: '/fixture', node: '/bin/node', distribution: 'Fixture', image: 'sha256:' + 'a'.repeat(64) }
  const services: LayerFSResources[] = []
  const create = () => {
    const service = new LayerFSResources('one', home, { installation: async () => installation,
      runtime: home => new ManagedLayerFS('one', home, () => ({ request: async action => {
        if (action === 'open') { opens++; entered?.(); if (release) await new Promise<void>(resolve => { release = resolve }); if (fail) throw new ToolOutcomeUnknownError('lost') }
        return ready
      }, close: async () => {} }), 'win32') })
    services.push(service); return service
  }
  try {
    for (const name of ['agent', 'runtime']) {
      await mkdir(join(dir, 'api', name, 'src'), { recursive: true })
      await writeFile(join(dir, 'api', name, 'package.json'), JSON.stringify({ name: '@layerfs/' + name }))
      await writeFile(join(dir, 'api', name, 'src', 'index.js'), '')
    }
    const first = create()
    await first.runtimePlan('test', context)
    await assert.rejects(first.runtimeStart('test', { ...context, sessionId: 'foreign' }), /another session/)
    assert.equal((await first.runtimeStart('test', context)).ready, true)
    assert.equal(opens, 1)
    await assert.rejects(first.runtimeStart('test', context), /already consumed/)
    await first.close()
    const second = create()
    const stopped = await second.runtimeStatus('test', context.signal)
    assert.equal(stopped.recordPhase, 'ready'); assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.ready, false)
    assert.equal(stopped.next, 'layerfs_runtime_start')
    await assert.rejects(second.runtimeContext('test', context), /not running/)
    await assert.rejects(second.runtimeStart('test', { ...context, sessionId: 'foreign' }), /another session/)
    // The old one-shot admission remains untouched and does not block clean restart.
    await writeFile(join(runtimeHome, 'start-admission.json'), 'historical admission')
    release = () => {}
    const admitted = new Promise<void>(resolve => { entered = resolve })
    const start = second.runtimeStart('test', context)
    await admitted
    const contender = create()
    await assert.rejects(contender.runtimeStart('test', context), /already admitted/)
    release!(); release = undefined
    assert.equal((await start).ready, true); assert.equal(opens, 2)
    assert.equal(await readFile(join(runtimeHome, 'start-admission.json'), 'utf8'), 'historical admission')
    await second.close()
    await rm(journal)
    await assert.rejects(create().runtimeStart('test', context), /only a confirmed/)
    await writeFile(journal, JSON.stringify({ phase: 'stopped' }))
    const lease = join(runtimeHome, 'start-lease.json')
    await writeFile(lease, 'crash-retained')
    assert.equal((await create().runtimeStatus('test', context.signal)).next, 'inspect_retained_state')
    await assert.rejects(create().runtimeStart('test', context), /already admitted/)
    assert.equal(await readFile(lease, 'utf8'), 'crash-retained')
    await rm(lease) // Synthetic fixture only; production never clears retained leases.
    for (const phase of ['starting', 'uncertain']) {
      await writeFile(journal, JSON.stringify({ phase }))
      await assert.rejects(create().runtimeStart('test', context), /only a confirmed/)
      assert.equal(opens, 2)
    }
    await writeFile(journal, JSON.stringify({ phase: 'stopped' }))
    fail = true
    await assert.rejects(create().runtimeStart('test', context), ToolOutcomeUnknownError)
    assert.equal(JSON.parse(await readFile(record, 'utf8')).phase, 'unknown')
    await assert.rejects(create().runtimeStart('test', context), /unresolved/)
    assert.equal(opens, 3)
    // Explicit no-effect errors preserve the plan instead of poisoning it.
    const noEffect = new LayerFSResources('one', home, { installation: async () => installation, runtime: () => ({ setup: async () => { throw new ToolNoEffectError('preflight') } }) as any })
    await noEffect.runtimePlan('no-effect', context)
    await assert.rejects(noEffect.runtimeStart('no-effect', context), ToolNoEffectError)
    assert.equal(JSON.parse(await readFile(join(home, 'layerfs-catalog/runtimes/no-effect/runtime.json'), 'utf8')).phase, 'planned')
    await assert.rejects(noEffect.runtimeStart('no-effect', context), /preflight/)
  } finally {
    await Promise.allSettled(services.map(service => service.close()))
    await rm(dir, { recursive: true, force: true })
  }
})
