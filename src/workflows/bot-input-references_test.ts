import { createBotsHandler } from '../vfs/bots.ts'
import type { DirectoryBots } from '../bots/runtime.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botCanvas, parseBotProjection } from '../../app/src/bot-workflows.ts'
import { botInputReference, captureInputReferences } from '../../app/src/workflow-input-references.ts'
import { workflowReferenceResolver } from './references.ts'
import type { WorkflowRuntime } from './runtime.ts'
import type { BotWorkflowProjection } from '../bots/workflow-projection.ts'
import { observationLocator } from '../bots/observation.ts'
import { connectionSinkProjection } from '../channels/sink-projection.ts'
import { createConnectionsHandler } from '../vfs/connections.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

const snapshot = (): BotWorkflowProjection => ({
  sinks: [connectionSinkProjection({ projectId: 'p', connectionId: 'conn', platform: 'qq', observations: [], histories: [] })],
  connections: [{ id: 'conn', displayName: 'Transport', platform: 'qq', purpose: 'service', enabled: true, health: 'connected' }],
  deployments: [{ id: 'role', state: 'valid', mode: 'service', agent: 'BOT:role', revision: 'actual-published-revision' }],
  bindings: [{ id: 'entry-identity', deploymentId: 'role', connectionId: 'conn', platform: 'qq', topic: 'group:PRIVATE_TOPIC', kind: 'message', enabled: true, subscribed: true, listener: true, sessionIds: ['PRIVATE_SESSION'] }],
  warnings: [], routing: 'not-probed', processingSuccess: 'unknown',
})
const runtime = { inspect: () => ({ projectId: 'p', definitions: [], runs: [] }) as unknown as ReturnType<WorkflowRuntime['inspect']> }
const contextData = (text: string) => JSON.parse(text.split('\n').at(-2)!) as Array<Record<string, string>>

test('renderer BOT/entry identity freezes to genuinely readable/listable/searchable Project observation paths without management authority', async () => withTempWorkspace(async home => {
  const state = snapshot()
  const flow = botCanvas(parseBotProjection(state, 'p'))[0]!
  const item = botInputReference('p', flow, 'bot:entry-identity')!
  assert.deepEqual(item.reference, { kind: 'bot-deployment', projectId: 'p', botId: 'role', revision: 'actual-published-revision', bindingId: 'entry-identity' })
  assert.match(item.label, /BOT:role/)
  const entry = botInputReference('p', flow, 'entry:entry-identity')!
  assert.equal(entry.reference.kind, 'bot-deployment')
  assert.equal(entry.reference.selector, 'entry')
  const payload = captureInputReferences([item, entry])
  const resolve = workflowReferenceResolver('p', runtime, () => state.sinks[0]!, () => state)
  const frozen = resolve(payload), records = contextData(frozen)
  const handler = createConnectionsHandler({ projectId: 'p', observation: () => state,
    assertSession: () => { throw Error('Not owner') }, index: () => { throw Error('Management must not be touched') },
    overview: () => { throw Error('Management must not be touched') }, sink: () => { throw Error('Management must not be touched') } })
  const vfs = new VirtualFs(); vfs.mount('v:connections', 'Connections', handler.read, handler.list, undefined, handler.directory)
  const bots = createBotsHandler({ projectId: 'p', store: { projectId: 'p', ids: () => { throw Error('Must not enumerate management') } }, channels: { projectId: 'p', botStatus: () => { throw Error('Must not read management') } }, directory: { deployments: { projectId: 'p' } } as DirectoryBots, assertSession: () => { throw Error('Not owner') } })
  vfs.mount('v:bots', 'BOT management', bots.read, bots.list)
  const base = new Tools(home); base.register(new ReadTool(home, vfs)); base.register(new SearchTool(home, undefined, vfs, false))
  const tools = new SessionTools(base, home, ['read', 'search'])
  const context = { projectId: 'p', channel: 'qq', isGroup: true, sessionId: 'qq:unrelated', admin: false, tools, signal: new AbortController().signal } as ExecutionContext
  try {
    for (const path of [records[0]!.path!, records[0]!.bindingPath!]) {
      const raw = String(await tools.execute('read', { path }, context))
      const object = JSON.parse(raw)
      assert.equal(object.projectId, 'p')
      assert.equal(object.view, 'current-observation')
      assert.doesNotMatch(raw, /PRIVATE_|source|directory|sessionIds|conversationId|agent|topic/)
      assert.match(String(await tools.execute('read', { path: path.slice(0, path.lastIndexOf('/')), flag: 'l' }, context)), new RegExp(object.id))
      assert.match(String(await tools.execute('search', { path, handler: 'grep', query: object.id }, context)), new RegExp(object.id))
      assert.match(String(await tools.execute('search', { path: path.slice(0, path.lastIndexOf('/')), handler: 'glob', query: '*.json' }, context)), new RegExp(object.id))
      assert.throws(() => handler.read(path.slice('v:connections/'.length), { ...context, projectId: 'other' }), /Project mismatch/)
      assert.throws(() => vfs.write(path, { content: '{}' }, context), /read-only/)
    }
    const bot = JSON.parse(String(await tools.execute('read', { path: records[0]!.path }, context)))
    assert.equal(bot.revision, 'actual-published-revision')
    assert.match(String(await tools.execute('read', { path: records[0]!.managementPath }, context)), /management/)
    assert.equal(JSON.parse(String(await tools.execute('read', { path: 'v:connections/observation.json' }, context))).deployments[0].path, records[0]!.path)
    state.deployments[0]!.revision = 'new-published-revision'
    assert.throws(() => resolve(payload), /stale/)
    assert.equal(JSON.parse(String(await tools.execute('read', { path: records[0]!.path }, context))).revision, 'new-published-revision')
    assert.match(frozen, /actual-published-revision/)
    assert.doesNotMatch(frozen, /new-published-revision|PRIVATE_SESSION/)
    state.deployments = []
    assert.match(String(await tools.execute('read', { path: records[0]!.path }, context)), /unavailable/)
  } finally { await tools.resetDynamicAndWait() }
}))

test('BOT reference strict fields, stale/quarantined/mismatched bindings and scope fail closed; locators separate Project/kind/receiver parent', () => {
  const state = snapshot(), flow = botCanvas(parseBotProjection(state, 'p'))[0]!, item = botInputReference('p', flow, 'bot:entry-identity')!
  const resolve = workflowReferenceResolver('p', runtime, () => state.sinks[0]!, () => state)
  const ref = item.reference
  for (const patch of [{ projectId: 'other' }, { revision: 'old' }, { botId: 'missing' }, { bindingId: 'foreign' }, { path: 'v:bots/deployments/role/status' }, { tools: ['delete'] }, { selector: 'run' }, { connectionId: 'forged' }]) {
    assert.throws(() => resolve([{ ...ref, ...patch }]))
  }
  state.bindings[0]!.deploymentId = 'other'
  assert.throws(() => resolve([ref]), /binding/)
  state.deployments[0]!.state = 'quarantined'
  assert.throws(() => resolve([ref]), /stale|unavailable/)
  assert.equal(botInputReference('p', botCanvas(parseBotProjection(state, 'p'))[0]!, 'bot:entry-identity'), undefined, 'Never fall back to Connection or receiver')
  assert.equal(new Set([
    observationLocator('p', 'deployment', 'same').id, observationLocator('q', 'deployment', 'same').id,
    observationLocator('p', 'binding', 'same').id, observationLocator('p', 'receiver', 'same', 'c1').id,
    observationLocator('p', 'receiver', 'same', 'c2').id,
  ]).size, 5)
})

test('real web admission rejects stale/cross-Project/forged BOT references before delivery and freezes accepted entry context', async () => {
  const { Hono } = await import('hono')
  const { Bus } = await import('../bus/bus.ts')
  const { WebChannel } = await import('../channels/web.ts')
  const state = snapshot(), bus = new Bus(), history: string[] = []
  const resolve = workflowReferenceResolver('p', runtime, () => state.sinks[0]!, () => state)
  const channel = new WebChannel(bus, { authorize: () => true, resolveInputReferences: resolve })
  channel.setReceiver(async message => {
    history.push(message.content)
    bus.emit('message.outbound', { event: 'response', channel: 'web', chatId: message.chatId, replyTo: message.messageId, done: true, content: 'ok' })
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  const app = new Hono(); await channel.start(app)
  const ref = botInputReference('p', botCanvas(parseBotProjection(state, 'p'))[0]!, 'entry:entry-identity')!.reference
  const post = (references: unknown) => app.request('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'ordinary', content: 'Discuss only', references, delivery: 'queue' }) })
  try {
    for (const patch of [{ projectId: 'foreign' }, { revision: 'stale' }, { bindingId: 'unknown' }, { path: 'v:bots/deployments/role/status' }, { enabled: true }, { tools: ['delete'] }]) {
      assert.equal((await post([{ ...ref, ...patch }])).status, 400)
    }
    assert.deepEqual(history, [])
    assert.equal((await post([ref])).status, 200)
    assert.equal(history.length, 1)
    const frozen = history[0]!
    assert.match(frozen, /"selector":"entry"/)
    assert.match(frozen, /observations\/binding\//)
    state.deployments[0]!.revision = 'next-published'
    assert.equal((await post([ref])).status, 400)
    assert.equal(history[0], frozen)
    assert.equal(history.length, 1, 'No synthetic BOT execution, preparation, or delivery on rejection')
  } finally { await channel.stop() }
})

test('large observation discovery is bounded and explicitly truncated, while exact locators beyond the first page remain readable', async () => {
  const state = snapshot()
  state.deployments = Array.from({ length: 125 }, (_, index) => ({ id: `role${index}`, state: 'valid', mode: 'service', revision: `published-${index}` }))
  const handler = createConnectionsHandler({ projectId: 'p', observation: () => state,
    assertSession: () => { throw Error('Not owner') }, index: () => { throw Error('No management reads') },
    overview: () => { throw Error('No management reads') }, sink: () => { throw Error('No management reads') } })
  const context = { projectId: 'p', channel: 'qq', admin: false, signal: new AbortController().signal,
    tools: { has: (name: string) => ['read', 'search'].includes(name) } } as ExecutionContext
  const scope = 'observations/deployment'
  const entries = await handler.list(context, { subpath: scope })
  assert.equal(entries.length, 50)
  assert.match(entries.at(-1)!.warning!, /first 50 of 125/)
  const directory = await handler.directory(scope, context)
  assert.equal(directory?.items.length, 50)
  assert.match(directory!.header, /truncated/)
  const locator = observationLocator('p', 'deployment', 'role124')
  const object = JSON.parse(String(await handler.read(locator.path.slice('v:connections/'.length), context)))
  assert.equal(object.revision, 'published-124')
  assert.equal((await handler.list(context, { subpath: locator.path.slice('v:connections/'.length) })).length, 1)
  assert.throws(() => handler.read('observations/deployment/../../role124/status', context), /unavailable/)
})
