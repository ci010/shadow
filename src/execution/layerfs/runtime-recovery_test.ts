import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LayerFSResources } from './resource-service.ts'
import { branchWorkspace } from './workspace-identity.ts'
import { ManagedLayerFS, ManagedRuntimeError, type Deployment } from './managed.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
// Synthetic SDK boundary: these tests never start WSL/Docker or edit live state.
test('explicit owner recovery preserves identity, admissions and uncertain operations; start remains stopped-only', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-recovery-test-'))
  const home = join(dir, 'home'), runtimeHome = join(home, 'layerfs-catalog/runtimes/test')
  const journal = join(projectDataPaths(runtimeHome).state, 'layerfs/worker-state.json')
  const record = join(runtimeHome, 'runtime.json'), lease = join(runtimeHome, 'start-lease.json')
  const installation = { apiRoot: dir, bundle: '/fixture', node: '/bin/node', distribution: 'Fixture', image: 'sha256:' + 'a'.repeat(64) }
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const context = { projectId: 'one', channel: 'web', admin: true, isGroup: false, tools, cwd: home, signal: new AbortController().signal, sessionId: 'web:test' } as ExecutionContext
  const deployments: Deployment[] = [], actions: string[] = []
  const services: LayerFSResources[] = []
  let fail: Error | undefined, gate: Promise<void> | undefined, entered: (() => void) | undefined
  const create = () => {
    const service = new LayerFSResources('one', home, { installation: async () => installation,
      runtime: home => new ManagedLayerFS('one', home, () => ({ request: async (action, input) => {
        actions.push(action)
        if (action === 'open' || action === 'recover_open') {
          deployments.push(input as Deployment); entered?.(); if (gate) await gate; if (fail) throw fail
        }
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
    const original = create()
    await original.runtimePlan('test', context)
    await assert.rejects(original.runtimeRecover('test', context), /previously ready/)
    await original.runtimeStart('test', context)
    await assert.rejects(original.runtimeRecover('test', context), /no attached owner/)
    const initial = await readFile(record, 'utf8')
    // Emulate backend loss by opening a fresh service over synthetic retained running state.
    const recovered = create()
    const status = await recovered.runtimeStatus('test', context.signal)
    assert.equal(status.ready, false); assert.equal(status.recoveryCandidate, true)
    assert.equal(status.next, 'layerfs_runtime_recover')
    await assert.rejects(recovered.runtimeStart('test', context), /only a confirmed/)
    await assert.rejects(recovered.runtimeContext('test', context), /not running/)
    for (const patch of [{ admin: false }, { projectId: 'two' }, { channel: 'a2a' }, { isGroup: true }, { tools: { executionMode: 'task' } }, { tools: { executionMode: 'session' } }, { scriptInvocation: true }, { recoveringToolCall: true }, { remoteWorkdir: {} }]) {
      await assert.rejects(recovered.runtimeRecover('test', { ...context, ...patch } as ExecutionContext), ToolNoEffectError)
    }
    await assert.rejects(recovered.runtimeRecover('test', { ...context, signal: AbortSignal.abort(new Error('before admission')) }), /before admission/)
    for (const patch of [{ projectId: 'two' }, { runtimeId: 'other' }]) {
      await writeFile(record, JSON.stringify({ ...JSON.parse(initial), ...patch }))
      await assert.rejects(recovered.runtimeRecover('test', context), /identity mismatch/)
    }
    await writeFile(record, JSON.stringify({ ...JSON.parse(initial), installation: { ...installation, distribution: 'Changed' } }))
    await assert.rejects(recovered.runtimeRecover('test', context), /installation identity/)
    await writeFile(record, initial)
    for (const phase of ['starting', 'unknown']) {
      await writeFile(record, JSON.stringify({ ...JSON.parse(initial), phase }))
      await assert.rejects(recovered.runtimeRecover('test', context), /unresolved/)
    }
    await writeFile(record, initial)
    for (const phase of ['starting', 'recovering', 'uncertain', 'stopped']) {
      await writeFile(journal, JSON.stringify({ phase }))
      await assert.rejects(recovered.runtimeRecover('test', context), /no attached owner/)
    }
    await rm(journal)
    await assert.rejects(recovered.runtimeRecover('test', context), /no attached owner/)
    await writeFile(journal, JSON.stringify({ phase: 'running' }))
    await writeFile(lease, 'crash-retained startup')
    await assert.rejects(recovered.runtimeRecover('test', context), /already admitted/)
    assert.equal(await readFile(lease, 'utf8'), 'crash-retained startup')
    await rm(lease) // Remove only this synthetic fixture's intentionally blocking evidence.
    assert.equal(deployments.length, 1)
    const retained = [join(runtimeHome, 'start-admission.json'), join(projectDataPaths(runtimeHome).state, 'layerfs/runtime/shadow-init-admissions/project.json'), join(home, 'layerfs-catalog/operations/test/project.jsonl'), join(home, 'layerfs-catalog/operations/test/project.jsonl.lock')]
    for (const file of retained) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'unknown operation must remain byte-identical') }
    const resource = recovered.catalog.register({ name: 'existing', runtimeId: 'test', layerfsProject: 'project', image: installation.image, baselineRef: 'a'.repeat(64), source: { repository: 'https://example.com/repo.git', commit: 'b'.repeat(40) } })
    const binding = branchWorkspace('project', 'existing-branch', { ownerProject: 'one', runtimeId: 'test', resourceId: resource.revision })
    recovered.catalog.bindWorkspace(binding)
    const catalogBefore = recovered.catalog.list()
    // Proven no-dispatch receipts preserve retryable owner-loss evidence, not a false stop.
    fail = new ManagedRuntimeError('RecoveryOwnerLive')
    await assert.rejects(recovered.runtimeRecover('test', context), /RecoveryOwnerLive/)
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).phase, 'running')
    assert.equal(await readFile(record, 'utf8'), initial)
    fail = undefined
    let release!: () => void
    gate = new Promise<void>(resolve => { release = resolve })
    const admitted = new Promise<void>(resolve => { entered = resolve })
    const recovery = recovered.runtimeRecover('test', { ...context, sessionId: 'another-direct-owner' })
    await admitted
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).phase, 'recovering')
    await assert.rejects(create().runtimeRecover('test', context), /already admitted/)
    await assert.rejects(create().runtimeStart('test', context), /already admitted/)
    await assert.rejects(recovered.runtimeContext('test', context), /Only a ready/)
    release(); gate = undefined; entered = undefined
    assert.equal((await recovery).ready, true)
    assert.equal(JSON.parse(await readFile(record, 'utf8')).owner, context.sessionId)
    for (const deployment of deployments) assert.deepEqual(deployment, deployments[0])
    assert.equal(deployments[0].settings.sweep, false)
    assert.deepEqual(recovered.catalog.list(), catalogBefore)
    assert.deepEqual(recovered.catalog.get(resource.revision), resource)
    assert.equal(recovered.catalog.hasWorkspace(binding), true)
    assert.equal(create().catalog.hasWorkspace(binding), true)
    for (const file of retained) assert.equal(await readFile(file, 'utf8'), 'unknown operation must remain byte-identical')
    assert.ok(actions.every(action => ['open', 'recover_open', 'status'].includes(action)), 'no Init, mount, repair or resource dispatch')
    await assert.rejects(recovered.runtimeRecover('test', context), /no attached owner/)
    await recovered.close()
    assert.equal((await create().runtimeStart('test', context)).ready, true, 'clean-stop restart unchanged')
    // Lost/aborted recovery receipts retain unknown, even after graceful helper
    // close. Each iteration explicitly seeds an independent synthetic scenario.
    for (const failure of ['lost', 'abort']) {
      await writeFile(record, initial); await writeFile(journal, JSON.stringify({ phase: 'running' }))
      const lost = create(), controller = new AbortController()
      if (failure === 'lost') fail = new ToolOutcomeUnknownError('lost recovery receipt')
      else {
        fail = undefined
        entered = () => controller.abort(new Error('observation aborted after admission'))
      }
      await assert.rejects(lost.runtimeRecover('test', { ...context, signal: controller.signal }), /lost recovery receipt|observation aborted/)
      entered = undefined
      await lost.close()
      assert.equal(JSON.parse(await readFile(journal, 'utf8')).phase, 'uncertain')
      assert.equal(JSON.parse(await readFile(record, 'utf8')).phase, 'unknown')
      await assert.rejects(create().runtimeRecover('test', context), /unresolved/)
      await assert.rejects(create().runtimeStart('test', context), /unresolved/)
      for (const file of retained) assert.equal(await readFile(file, 'utf8'), 'unknown operation must remain byte-identical')
    }
  } finally {
    await Promise.allSettled(services.map(service => service.close()))
    await rm(dir, { recursive: true, force: true })
  }
})
