import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLayerFSTools, LayerFSTool, layerFSToolContracts } from './layerfs.ts'
import { createLayerFSResourceTools, layerfsResourceContracts } from './layerfs-resource.ts'
import type { LayerFSResources } from '../execution/layerfs/resource-service.ts'
import type { ExecutionContext } from './context.ts'

const projectId = 'synthetic-project'
const context = { projectId, signal: new AbortController().signal } as ExecutionContext

test('discovery combines installation-only factory and flat explicit template intents without legacy repair aliases', () => {
  const installation = createLayerFSTools(projectId)
  assert.deepEqual(installation.map(t => t.name), ['layerfs_doctor', 'layerfs_setup', 'layerfs_bootstrap_plan', 'layerfs_bootstrap', 'layerfs_bootstrap_status'])
  const templates = createLayerFSResourceTools({ projectId } as LayerFSResources)
  const tools = [...templates, ...installation]
  assert.deepEqual(tools.map(({ name, description, parameters, supportsLayerFSWorkdir }) => ({ name, description, parameters, supportsLayerFSWorkdir })), layerFSToolContracts())
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length)
  for (const name of ['layerfs', 'layerfs_read', 'layerfs_write', 'layerfs_exec', 'layerfs_connect', 'layerfs_import', 'layerfs_mount', 'layerfs_namespace_status', 'layerfs_import_recover']) assert.ok(!tools.some(t => t.name === name))
  for (const tool of tools) {
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(!('action' in tool.parameters.properties))
    assert.ok((tool.parameters.required ?? []).every(key => key in tool.parameters.properties))
  }
  const find = (name: string) => tools.find(t => t.name === `layerfs_${name}`)!
  assert.deepEqual(find('runtime_start').parameters.required, ['runtimeId'])
  for (const contract of layerfsResourceContracts()) assert.ok(!('namespace' in contract.parameters.properties))
  assert.ok(!('allowDownloads' in find('setup').parameters.properties))
  assert.ok(!('installation' in find('bootstrap').parameters.properties))
})

test('installation wrappers reject action injection, missing fields and invalid types before dispatch', async () => {
  const tool = createLayerFSTools(projectId).find(t => t.name === 'layerfs_setup')!
  await assert.rejects(tool.execute({ installation: {}, approved: true, allowRootWorker: true, action: 'publish' }, context), /Unexpected action/)
  await assert.rejects(tool.execute({}, context), /Missing installation/)
  await assert.rejects(tool.execute({ installation: {}, approved: 'yes', allowRootWorker: true }, context), /Invalid approved/)
})

test('installation dispatch shares one service and preserves args/context and failure identity', async () => {
  const original = LayerFSTool.prototype.execute
  const calls: { self: LayerFSTool; args: Record<string, unknown>; context: ExecutionContext }[] = []
  const result = { isError: true, content: [] }
  LayerFSTool.prototype.execute = async function(args, context) { calls.push({ self: this, args, context }); return result }
  try {
    const tools = createLayerFSTools(projectId)
    assert.equal(await tools.find(t => t.name === 'layerfs_setup')!.execute({ installation: {}, approved: true, allowRootWorker: true }, context), result)
    await tools.find(t => t.name === 'layerfs_doctor')!.execute({}, context)
    assert.equal(calls[0].self, calls[1].self)
    assert.equal(calls[0].context, context)
    assert.deepEqual(calls[0].args, { installation: {}, approved: true, allowRootWorker: true, action: 'setup' })
  } finally { LayerFSTool.prototype.execute = original }
})

test('installation intents retain Project, remote and abort enforcement without starting LayerFS', async () => {
  const tool = createLayerFSTools(projectId).find(t => t.name === 'layerfs_doctor')!
  await assert.rejects(tool.execute({}, { projectId: 'foreign' } as ExecutionContext), /Current local Project/)
  await assert.rejects(tool.execute({}, { projectId, remoteWorkdir: {} } as ExecutionContext), /Current local Project/)
  await assert.rejects(tool.execute({}, { projectId, signal: AbortSignal.abort(new Error('synthetic abort')) } as ExecutionContext), /synthetic abort/)
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
