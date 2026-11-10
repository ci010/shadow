import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SignalProviderRuntime } from '../signals/providers/runtime.ts'
import { SignalProviderTool } from './signal-provider.ts'
import { registerInternalEventTools } from './internal-events.ts'
import { registerSignalTools } from './signal-tools.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ReadTool } from './read.ts'
import { Tools, SessionTools } from './registry.ts'
import type { ExecutionContext } from './context.ts'

test('signals discovery is separate from internal events and legacy invocation resolves without public aliases', async () => withTempWorkspace(async workspace => {
  const deliveries: string[] = []
  const events = new EventService(workspace, new Bus(), async (id, input) => {
    deliveries.push(id)
    return { status: 'accepted', sessionId: id, inputId: input.id }
  })
  await events.start()
  const providers = new SignalProviderRuntime(workspace, { execute: async () => { throw Error('No IO expected') } }, async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }), () => true, () => false)
  providers.start()
  const base = new Tools(workspace)
  const importer = new ImportTool(new Map(), workspace)
  const invoke = new InvokeTool(importer)
  base.register(new ReadTool(workspace))
  base.register(invoke)
  registerInternalEventTools(importer, events)
  registerSignalTools(importer, new SignalProviderTool(providers, 'project'))
  const tools = new SessionTools(base, workspace)
  const context = { projectId: 'project', sessionId: 'owner', inputSource: 'user', signal: new AbortController().signal, tools } as ExecutionContext
  try {
    assert.deepEqual(base.getDefinitions().map(def => def.function.name), ['read', 'invoke_tool'])
    const flat = await importer.virtualEntries(context)
    assert.deepEqual(flat.map(entry => entry.name).sort(), ['event_subscribe', 'signal_provider'])
    const root = await importer.readVirtual('', context)
    const entries = root.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    assert.deepEqual(entries.map(entry => entry.name).sort(), ['event_subscribe', 'signal_provider'])
    assert(entries.every(entry => Object.keys(entry).sort().join(',') === 'description,name'))
    assert.doesNotMatch(root, /"parameters"|"properties"/)
    assert.equal(JSON.parse(await importer.readVirtual('event_subscribe', context)).name, 'event_subscribe')
    const catalog = await importer.virtualEntries(context, { subpath: 'events' })
    assert.deepEqual(catalog.map(entry => entry.name).sort(), ['events', 'events/event_subscribe'])
    const signalCatalog = await importer.virtualEntries(context, { subpath: 'signals' })
    assert.deepEqual(signalCatalog.map(entry => entry.name).sort(), ['signals', 'signals/signal_provider'])
    assert.equal(tools.hasDynamic('signal_provider'), false)
    assert.equal(tools.hasDynamic('event_subscribe'), false)
    assert.match(String(await invoke.execute({ name: 'event_subscribe', args: { action: 'subscribe', event: 'cron-tick', source: 'cron' } }, context)), /Subscribed owner/)
    assert.equal(tools.hasDynamic('event_subscribe'), true)
    await events.emit({ type: 'cron-tick', source: 'cron', content: 'Internal tick', targetSessionId: 'owner' })
    assert.deepEqual(deliveries, ['owner'])
    assert.match(String(await invoke.execute({ name: 'event_provider', args: { action: 'run' } }, context)), /Saved\/completed/)
    assert.equal(tools.hasDynamic('signal_provider'), true)
    assert.equal(tools.hasDynamic('event_provider'), false)
    const blocked = new SessionTools(base, workspace, undefined, ['event_provider'])
    assert.equal(blocked.canUseDynamic('signal_provider'), false)
    assert.equal(blocked.canUseDynamic('event_provider'), false)
    for (const name of ['signal_provider', 'event_provider']) assert.match(String(await invoke.execute({ name, args: { action: 'run' } }, { ...context, tools: blocked })), /not active and could not be imported/)
    const call = new SessionTools(base, workspace)
    call.setExecutionScope('call', [])
    assert.match(String(await invoke.execute({ name: 'event_subscribe', args: { action: 'list' } }, { ...context, tools: call })), /not active and could not be imported/)
    assert.match(String(await invoke.execute({ name: 'event_provider', args: { action: 'run' } }, { ...context, tools: call })), /not active and could not be imported/)
  } finally { await events.stop(); await providers.stop() }
}))
