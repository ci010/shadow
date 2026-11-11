import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLayerFSTools, LayerFSTool } from './layerfs.ts'
import type { ExecutionContext } from './context.ts'

test('factory exposes 29 narrow intents, not dispatcher or file-operation duplicates', () => {
  const tools = createLayerFSTools('synthetic-project')
  assert.equal(tools.length, 29)
  assert.equal(new Set(tools.map(t => t.name)).size, 29)
  for (const name of ['layerfs', 'layerfs_read', 'layerfs_write', 'layerfs_exec']) assert.ok(!tools.some(t => t.name === name))
  for (const tool of tools) {
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(!('action' in tool.parameters.properties))
    assert.ok((tool.parameters.required ?? []).every(key => key in tool.parameters.properties))
  }
  const find = (name: string) => tools.find(t => t.name === `layerfs_${name}`)!
  assert.deepEqual(find('fork').parameters.required, ['branch'])
  assert.deepEqual(find('mount').parameters.required, ['branch'])
  assert.deepEqual(find('import').parameters.required, ['workspace', 'sourceReview', 'sourceReviewed'])
  assert.deepEqual(Object.keys(find('doctor').parameters.properties), ['namespace'])
  assert.ok(!('allowDownloads' in find('setup').parameters.properties))
  assert.ok(!('installation' in find('bootstrap').parameters.properties))
})

test('wrappers reject action injection, missing fields and invalid types before dispatch', async () => {
  const tool = createLayerFSTools('synthetic-project').find(t => t.name === 'layerfs_mount')!
  const context = {} as ExecutionContext
  await assert.rejects(tool.execute({ branch: 'test', action: 'publish' }, context), /Unexpected action/)
  await assert.rejects(tool.execute({}, context), /Missing branch/)
  await assert.rejects(tool.execute({ branch: 123 }, context), /Invalid branch/)
})

test('dispatch shares one service and preserves args/context and failure identity', async () => {
  const original = LayerFSTool.prototype.execute
  const calls: { self: LayerFSTool; args: Record<string, unknown>; context: ExecutionContext }[] = []
  const result = { isError: true, content: [] }
  LayerFSTool.prototype.execute = async function(args, context) { calls.push({ self: this, args, context }); return result }
  try {
    const tools = createLayerFSTools('synthetic-project')
    const context = {} as ExecutionContext
    assert.equal(await tools.find(t => t.name === 'layerfs_fork')!.execute({ branch: 'test', ref: 'base' }, context), result)
    await tools.find(t => t.name === 'layerfs_mount')!.execute({ branch: 'test' }, context)
    assert.equal(calls[0].self, calls[1].self)
    assert.equal(calls[0].context, context)
    assert.deepEqual(calls[0].args, { branch: 'test', ref: 'base', action: 'fork' })
  } finally { LayerFSTool.prototype.execute = original }
})

test('intents retain Project, remote and abort enforcement without starting LayerFS', async () => {
  const tool = createLayerFSTools('synthetic-project').find(t => t.name === 'layerfs_doctor')!
  await assert.rejects(tool.execute({}, { projectId: 'foreign' } as ExecutionContext), /Project mismatch/)
  await assert.rejects(tool.execute({}, { projectId: 'synthetic-project', remoteWorkdir: {} } as ExecutionContext), /remote execution is unsupported/)
  await assert.rejects(tool.execute({}, { projectId: 'synthetic-project', signal: AbortSignal.abort(new Error('synthetic abort')) } as ExecutionContext), /synthetic abort/)
})


test('LayerFS invocation allows maintenance discovery but refuses unmarked host sources before initialization', async () => {
  const { InvokeTool } = await import('./invoke-tool.ts')
  let initialized = 0
  const tool = new InvokeTool({ initializeSource: async () => { initialized++; return 'contracts' }, importForInvocation: async () => undefined })
  const context = { layerfsWorkdir: { workspace: 'layerfs:fixture' }, tools: { activeDynamicTools: () => [] } } as unknown as ExecutionContext
  assert.equal(tool.supportsLayerFSWorkdir, true)
  assert.match(String(await tool.execute({ source: 'browser', args: {} }, context)), /only the LayerFS/)
  assert.match(String(await tool.execute({ name: 'host_command', args: {} }, context)), /does not support LayerFS/)
  assert.equal(initialized, 0)
  assert.equal(await tool.execute({ source: 'layerfs', args: {} }, context), 'contracts')
  assert.equal(initialized, 1)
})
