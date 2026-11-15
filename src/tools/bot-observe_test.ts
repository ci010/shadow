import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BotObserveTool } from './bot-observe.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from './context.ts'
import type { BotWorkflowProjection } from '../bots/workflow-projection.ts'
import { connectionSinkProjection } from '../channels/sink-projection.ts'
import { passiveChannelId } from '../channels/passive-contract.ts'

const source = { version: 1 as const, projectId: 'p', botInstanceId: 'PRIVATE_CONNECTION', platform: 'qq' as const,
  conversationId: 'group:PRIVATE_USER', kind: 'group' as const, name: 'PRIVATE_NAME' }
const sink = connectionSinkProjection({ projectId: 'p', connectionId: source.botInstanceId, platform: 'qq',
  histories: [{ sessionId: passiveChannelId(source), projectId: 'p', channelSource: source }], observations: [] })
const snapshot: BotWorkflowProjection = { sinks: [sink], connections: [{ id: source.botInstanceId, displayName: 'PRIVATE_NAME', platform: 'qq',
  purpose: 'personal', enabled: true, health: 'connected' }], deployments: [{ id: 'PRIVATE_BOT', state: 'valid', mode: 'personal', agent: 'general' }],
  bindings: [{ id: 'PRIVATE_BINDING', connectionId: source.botInstanceId, deploymentId: 'PRIVATE_BOT', platform: 'qq', topic: 'PRIVATE_TOPIC',
    enabled: true, subscribed: true, listener: true, kind: 'host-owner-ingress', sessionIds: ['PRIVATE_SESSION'] }],
  warnings: [], routing: 'not-probed', processingSuccess: 'unknown' }

test('host-granted tool catalog and invocation succeed for full QQ context, without owner-Web scope', async () => withTempWorkspace(async home => {
  let reads = 0
  const importer = new ImportTool(new Map(), home, 'p')
  importer.registerBuiltin('bot_observe', new BotObserveTool('p', () => { reads++; return snapshot }))
  const base = new Tools(home); base.register(new InvokeTool(importer)); base.register(importer)
  base.register({ name: 'read', description: 'Synthetic read grant', parameters: { type: 'object', properties: {} }, execute: async () => '' })
  const tools = new SessionTools(base, home)
  const context = { projectId: 'p', channel: 'qq', isGroup: true, admin: false, sessionId: 'qq:unrelated',
    tools, signal: new AbortController().signal } as ExecutionContext
  assert((await importer.virtualEntries(context)).some(entry => entry.name === 'bot_observe'))
  const raw = String(await tools.execute('invoke_tool', { name: 'bot_observe', args: {} }, context))
  const result = JSON.parse(raw)
  assert.equal(reads, 1)
  assert.equal(result.projectId, 'p')
  assert.deepEqual(result.connections[0].receivers[0].evidence, sink.receivers[0]!.evidence, 'UI navigation and tool share the same evidence DTO')
  assert.equal(result.bindings[0].listener, true)
  assert.equal(result.bindings[0].sessionCount, 1)
  assert.equal(result.bindings[0].admission, 'unknown')
  assert.doesNotMatch(raw, /PRIVATE_|sender|content|secret|chatId|conversationId|inboxSessionId/)
  assert.match(String(await tools.execute('invoke_tool', { name: 'bot_observe', args: {} }, { ...context, projectId: 'other' })), /Project mismatch/)
  assert.equal(reads, 1, 'Cross-Project rejection precedes source access')
  assert.match(String(await tools.execute('invoke_tool', { name: 'bot_observe', args: { projectId: 'other', full: true } }, context)), /contract|schema|additional|invalid/i)
  assert.equal(reads, 1, 'Model-supplied scope/full is not authority')
  await tools.resetDynamicAndWait()
}))

test('existing host tool filters hide discovery and block import/invoke bypasses when not granted', async () => withTempWorkspace(async home => {
  let reads = 0
  const tool = new BotObserveTool('p', () => { reads++; return snapshot })
  const importer = new ImportTool(new Map(), home, 'p'); importer.registerBuiltin('bot_observe', tool)
  const base = new Tools(home); base.register(new InvokeTool(importer)); base.register(importer)
  base.register({ name: 'read', description: 'Synthetic read grant', parameters: { type: 'object', properties: {} }, execute: async () => '' })
  for (const [allowed, blocked] of [[['read'], undefined], [undefined, ['bot_observe']]] as [string[] | undefined, string[] | undefined][]) {
    const tools = new SessionTools(base, home, allowed, blocked)
    const context = { projectId: 'p', tools, signal: new AbortController().signal } as ExecutionContext
    if (!tools.has('invoke_tool')) await assert.rejects(() => importer.virtualEntries(context), /not available/)
    else assert(!(await importer.virtualEntries(context)).some(entry => /bot_observe/.test(entry.name + entry.content)))
    assert.match(String(await importer.execute({ source: 'v:tools/bot_observe' }, context)), /Error/)
    assert.match(String(await tools.execute('invoke_tool', { name: 'bot_observe', args: {} }, context)), /Error/)
    await assert.rejects(() => tool.execute({}, context), /unavailable/)
    await tools.resetDynamicAndWait()
  }
  assert.equal(reads, 0)
}))
