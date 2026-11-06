import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ManagedLayerFS, type ManagedDriver } from './managed.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { ToolOutcomeUnknownError, ToolNoEffectError, toolResultText } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { BackgroundTaskManager } from '../../agent/background-task.ts'
import { Tools, SessionTools } from '../../tools/registry.ts'
import { InvokeTool } from '../../tools/invoke-tool.ts'

for (const cancel of [false, true]) test(`reviewed import is admitted once in background; cancellation=${cancel} preserves effect uncertainty`, async () => {
  const home = await mkdtemp(join(process.cwd(), '.layerfs-import-bg-test-'))
  let service: ManagedLayerFS | undefined
  try {
    const source = join(home, 'source'); await mkdir(source); await writeFile(join(source, 'index.ts'), 'export const fixture = 1')
    await mkdir(join(home, 'config')); await mkdir(join(home, 'state', 'layerfs'), { recursive: true })
    await writeFile(join(home, 'config', 'layerfs-managed.json'), JSON.stringify({ version: 1, projectId: 'p', approvedRootWorker: true,
      installation: { apiRoot: home, bundle: '/fixture/build', distribution: 'FixtureWSL', node: '/fixture/node', image: 'sha256:' + 'a'.repeat(64) } }))
    await writeFile(join(home, 'state', 'layerfs', 'worker-state.json'), JSON.stringify({ phase: 'stopped' }))
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<unknown>()
    const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
    let creates = 0
    const driver: ManagedDriver = { async request(action, input: any, signal, progress) {
      if (action === 'open' || action === 'status') return ready
      if (action === 'import_status') return { stage: 'not_started' }
      assert.equal(action, 'create'); creates++
      assert.equal(input.source, source); assert.equal(input.timeoutMs, 600000)
      progress?.({ stage: 'scan', jobId: 'fixture-job', scanned: { entries: 1, files: 1, bytes: 24 } })
      const abort = () => finish.reject(new ToolOutcomeUnknownError('Native work may continue'))
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      started.resolve()
      try { return await finish.promise } finally { signal.removeEventListener('abort', abort) }
    }, async close() {} }
    service = new ManagedLayerFS('p', home, () => driver, 'win32')
    let options: Parameters<BackgroundTaskManager['runPromiseTask']>[0] | undefined, completion: Promise<string> | undefined
    const background: Pick<BackgroundTaskManager, 'runPromiseTask'> = { runPromiseTask(next, promise) {
      assert.equal(completion, undefined, 'Only one background task may be admitted')
      options = next; completion = promise; promise.catch(() => {})
      return '1234567890abcdef'
    } }
    const tool = new LayerFSTool('p', home, service, undefined, background)
    const ownerTools: any = { executionMode: 'session' }; ownerTools.dynamicOwner = ownerTools
    const context = { projectId: 'p', sessionId: 'web:import', channel: 'web', chatId: 'import', signal: new AbortController().signal,
      physicalSessionId: 'web_import-0', messageId: 'request', senderId: 'owner', tools: ownerTools,
      resolveToolTarget: async () => ({ cwd: source, fileChangeTarget: { nodeId: 'main', workdirId: 'source' } }) } as ExecutionContext
    await assert.rejects(tool.execute({ action: 'create', workspace: 'source' }, context), ToolNoEffectError)
    assert.equal(creates, 0); assert.equal(completion, undefined)
    const preview = JSON.parse(toolResultText(await tool.execute({ action: 'import_preview', workspace: 'source' }, context))).result
    const args = { action: 'create', workspace: 'source', sourceReview: preview.reviewToken, sourceReviewed: true, importTimeoutMs: 600000 }
    const admitted = JSON.parse(toolResultText(await tool.execute(args, context))).result
    assert.equal(admitted.status, 'running'); assert.equal(admitted.executionId, 'bg:1234567890abcdef')
    assert.equal(options?.callback?.sessionId, context.sessionId)
    await started.promise
    await assert.rejects(tool.execute(args, context), /already in flight/)
    const inspection = JSON.parse(toolResultText(await tool.execute({ action: 'import_status' }, context))).result
    assert.equal(inspection.stage, 'scan'); assert.equal(inspection.jobId, 'fixture-job')
    assert.match(await options!.observe!(), /scan/)
    if (cancel) {
      await assert.rejects(options!.onCancel!('cancel') as Promise<void>, ToolOutcomeUnknownError)
      await assert.rejects(completion!, ToolOutcomeUnknownError)
      assert.equal(JSON.parse(await readFile(join(home, 'state', 'layerfs', 'worker-state.json'), 'utf8')).phase, 'uncertain')
      assert.equal(JSON.parse(await readFile(join(home, 'state', 'layerfs', 'import-state.json'), 'utf8')).stage, 'unknown')
    } else {
      finish.resolve({ kind: 'Initialized', project: 'fixture' })
      assert.equal(JSON.parse(await completion!).result.kind, 'Initialized')
      assert.equal(JSON.parse(await readFile(join(home, 'state', 'layerfs', 'import-state.json'), 'utf8')).stage, 'done')
    }
    assert.equal(creates, 1)
  } finally { await service?.close(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test('registry/invoke_tool refuses task/call/nested/recovered import admission before consuming the review token', async () => {
  const home = await mkdtemp(join(process.cwd(), '.layerfs-import-mode-test-'))
  try {
    await writeFile(join(home, 'index.ts'), 'export const fixture = true')
    let admitted = 0, imports = 0, completed: Promise<string> | undefined
    const managed = { namespaceInfo: async () => ({ namespace: 'legacy', project: 'fixture' }), configured: async () => true, create: async () => { imports++; return { kind: 'Initialized' } } } as unknown as ManagedLayerFS
    const background: Pick<BackgroundTaskManager, 'runPromiseTask'> = { runPromiseTask(_options, promise) { admitted++; completed = promise; promise.catch(() => {}); return '1234567890abcdef' } }
    const base = new Tools(home); base.register(new InvokeTool())
    const tools = new SessionTools(base, home); tools.registerDynamic(new LayerFSTool('modes', home, managed, undefined, background))
    const context = { projectId: 'modes', sessionId: 'web:modes', physicalSessionId: 'web_modes-0', messageId: 'request', senderId: 'owner', channel: 'web', chatId: 'modes', tools,
      signal: new AbortController().signal, resolveToolTarget: async () => ({ cwd: home, fileChangeTarget: { nodeId: 'main', workdirId: 'source' } }) } as ExecutionContext
    tools.setExecutionScope('call', [])
    const preview = JSON.parse(toolResultText(await tools.execute('invoke_tool', { name: 'layerfs', args: { action: 'import_preview', workspace: 'source' } }, context))).result
    const args = { name: 'layerfs', args: { action: 'create', workspace: 'source', sourceReview: preview.reviewToken, sourceReviewed: true } }
    for (const mode of ['call', 'task'] as const) {
      tools.setExecutionScope(mode, [])
      assert.match(toolResultText(await tools.execute('invoke_tool', args, context)), /direct durable session/)
      assert.equal(admitted, 0); assert.equal(imports, 0)
    }
    tools.setExecutionScope('session', [])
    for (const patch of [{ scriptInvocation: true }, { recoveringToolCall: true }]) {
      assert.match(toolResultText(await tools.execute('invoke_tool', args, { ...context, ...patch })), /direct durable session/)
    }
    assert.equal(admitted, 0); assert.equal(imports, 0)
    const receipt = JSON.parse(toolResultText(await tools.execute('invoke_tool', args, context)))
    assert.equal(receipt.result.status, 'running')
    assert.equal(JSON.parse(await completed!).result.kind, 'Initialized')
    assert.equal(admitted, 1); assert.equal(imports, 1)
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
