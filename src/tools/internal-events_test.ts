import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { EventProviderRuntime } from '../events/providers/runtime.ts'
import { EventProviderTool } from './event-provider.ts'
import { registerInternalEventTools } from './internal-events.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ReadTool } from './read.ts'
import { Tools, SessionTools } from './registry.ts'
import type { ExecutionContext } from './context.ts'

test('events discovery retains lazy internal subscriptions and provider tool only', async () => withTempWorkspace(async workspace => {
  const deliveries: string[] = []
  const events = new EventService(workspace, new Bus(), async (id, input) => {
    deliveries.push(id)
    return { status: 'accepted', sessionId: id, inputId: input.id }
  })
  await events.start()
  const providers = new EventProviderRuntime(workspace, { execute: async () => { throw Error('No IO expected') } }, async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }), () => true, () => false)
  const base = new Tools(workspace)
  const importer = new ImportTool(new Map(), workspace)
  const invoke = new InvokeTool(importer)
  base.register(new ReadTool(workspace))
  base.register(invoke)
  registerInternalEventTools(importer, events, [new EventProviderTool(providers, 'project')])
  const tools = new SessionTools(base, workspace)
  const context = { projectId: 'project', sessionId: 'owner', inputSource: 'user', signal: new AbortController().signal, tools } as ExecutionContext
  try {
    assert.deepEqual(base.getDefinitions().map(def => def.function.name), ['read', 'invoke_tool'])
    const catalog = await importer.virtualEntries(context, { subpath: 'events' })
    assert.deepEqual(catalog.map(entry => entry.name).sort(), ['events', 'events/event_provider', 'events/event_subscribe'])
    assert.equal(tools.hasDynamic('event_provider'), false)
    assert.equal(tools.hasDynamic('event_subscribe'), false)
    assert.match(String(await invoke.execute({ name: 'event_subscribe', args: { action: 'subscribe', event: 'cron-tick', source: 'cron' } }, context)), /Subscribed owner/)
    assert.equal(tools.hasDynamic('event_subscribe'), true)
    await events.emit({ type: 'cron-tick', source: 'cron', content: 'Internal tick', targetSessionId: 'owner' })
    assert.deepEqual(deliveries, ['owner'])
    const call = new SessionTools(base, workspace)
    call.setExecutionScope('call', [])
    assert.match(String(await invoke.execute({ name: 'event_subscribe', args: { action: 'list' } }, { ...context, tools: call })), /not active and could not be imported/)
  } finally { await events.stop(); await providers.stop() }
}))
