import { workflowReferenceResolver } from '../workflows/references.ts'
import type { WorkflowRuntime } from '../workflows/runtime.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConnectionsHandler } from './connections.ts'
import { VirtualFs } from './virtual-fs.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { BotWorkflowProjection } from '../bots/workflow-projection.ts'
import { connectionSinkProjection } from '../channels/sink-projection.ts'
import { passiveChannelId } from '../channels/passive-contract.ts'

const source = { version: 1 as const, projectId: 'p', connectionId: 'PRIVATE_CONNECTION', platform: 'qq' as const,
  conversationId: 'group:PRIVATE_USER', kind: 'group' as const, name: 'PRIVATE_NAME' }
const sink = connectionSinkProjection({ projectId: 'p', connectionId: source.connectionId, platform: 'qq',
  histories: [{ sessionId: passiveChannelId(source), projectId: 'p', channelSource: source }], observations: [] })
const snapshot: BotWorkflowProjection = { sinks: [sink], connections: [{ id: source.connectionId, displayName: 'PRIVATE_NAME', platform: 'qq',
  purpose: 'personal', enabled: true, health: 'connected' }], deployments: [{ id: 'PRIVATE_BOT', state: 'valid', mode: 'personal', agent: 'general' }],
  bindings: [{ id: 'PRIVATE_BINDING', connectionId: source.connectionId, deploymentId: 'PRIVATE_BOT', platform: 'qq', topic: 'PRIVATE_TOPIC',
    enabled: true, subscribed: true, listener: true, kind: 'host-owner-ingress', sessionIds: ['PRIVATE_SESSION'] }],
  warnings: [], routing: 'not-probed', processingSuccess: 'unknown' }

test('read/list/glob/grep expose only redacted shared evidence to full and filtered QQ contexts', async () => withTempWorkspace(async home => {
  let reads = 0, managementReads = 0
  const handler = createConnectionsHandler({ projectId: 'p', observation: () => { reads++; return snapshot },
    assertSession: () => { throw Error('Not owner') }, index: () => { managementReads++; return { ids: ['PRIVATE_CONNECTION'] } },
    overview: () => { managementReads++; throw Error('Must not inspect') }, sink: () => { managementReads++; return sink } })
  const vfs = new VirtualFs(); vfs.mount('v:connections', 'Connections', handler.read, handler.list, undefined, handler.directory)
  const base = new Tools(home); base.register(new ReadTool(home, vfs)); base.register(new SearchTool(home, undefined, vfs, false))
  for (const [allowed, blocked] of [[undefined, undefined], [['read', 'search'], undefined], [['read'], undefined], [['search'], undefined], [undefined, ['read', 'search']], [[], undefined]] as [string[] | undefined, string[] | undefined][]) {
    const tools = new SessionTools(base, home, allowed, blocked)
    const context = { projectId: 'p', channel: 'qq', isGroup: true, admin: false, sessionId: 'qq:unrelated',
      tools, signal: new AbortController().signal } as ExecutionContext
    const before = reads
    if (tools.has('read') || tools.has('search')) {
      const directory = await vfs.directory('v:connections', context)
      assert.deepEqual(directory?.items, ['v:connections/overview', 'v:connections/observation.json'])
      assert.equal(reads, before, 'Name-only listing must not fetch observation or management sources')
    }
    if (tools.has('read')) {
      const raw = String(await tools.execute('read', { path: 'v:connections/observation.json', offset: 1, limit: 500 }, context))
      const result = JSON.parse(raw)
      assert.deepEqual(result.connections[0].receivers[0].evidence, sink.receivers[0]!.evidence)
      const freeze = workflowReferenceResolver('p', { inspect: () => ({ projectId: 'p', definitions: [], runs: [] }) as unknown as ReturnType<WorkflowRuntime['inspect']> }, () => sink, () => snapshot)
      for (const receiverId of [undefined, sink.receivers[0]!.id]) {
        const frozen = freeze([{ kind: 'connection-sink', projectId: 'p', connectionId: source.connectionId, ...(receiverId ? { receiverId } : {}) }])
        const record = JSON.parse(frozen.split('\n').at(-2)!)[0]
        const object = JSON.parse(String(await tools.execute('read', { path: record.path }, context)))
        assert.equal(object.objectKind, receiverId ? 'receiver' : 'connection')
        assert.equal(object.id, receiverId ? result.connections[0].receivers[0].id : result.connections[0].id)
      }

      assert.equal(result.bindings[0].listener, true); assert.equal(result.bindings[0].sessionCount, 1)
      assert.equal(result.bindings[0].admission, 'unknown'); assert.equal(result.processingSuccess, 'unknown')
      for (const record of [...result.connections, ...result.connections.flatMap((connection: { receivers: unknown[] }) => connection.receivers), ...result.deployments, ...result.bindings]) {
        const exact = String(await tools.execute('read', { path: record.path }, context))
        const object = JSON.parse(exact)
        assert.equal(object.id, record.id)
        assert.equal(object.objectKind, record.objectKind)
        assert.doesNotMatch(exact, /PRIVATE_|sender|secret|chatId|conversationId|inboxSessionId|sessionIds|topic/)
        assert.throws(() => handler.read(record.path.slice('v:connections/'.length), { ...context, projectId: 'other' }), /Project mismatch/)
      }

      assert.doesNotMatch(raw, /PRIVATE_|sender|content|secret|chatId|conversationId|inboxSessionId/)
      const guide = String(await tools.execute('read', { path: 'v:connections/overview' }, context))
      assert.match(guide, /v:connections\/observation.json/)
      const listing = String(await tools.execute('read', { path: 'v:connections', flag: 'l' }, context))
      assert.match(listing, /observation.json/); assert.doesNotMatch(listing, /PRIVATE_|index.json|sink.json/)
      assert.match(String(await tools.execute('read', { path: 'v:connections/PRIVATE_CONNECTION/sink.json' }, context)), /management/)
    } else assert.match(String(await tools.execute('read', { path: 'v:connections/observation.json' }, context)), /not available/)
    if (tools.has('search')) {
      for (const [handler, query] of [['glob', '**'], ['grep', 'unknown']]) {
        const result = String(await tools.execute('search', { handler, query, path: 'v:connections' }, context))
        assert.match(result, /observation.json/); assert.doesNotMatch(result, /PRIVATE_|index.json|sink.json/)
      }
      assert.match(String(await tools.execute('search', { handler: 'glob', query: '**', path: 'v:connections/PRIVATE_CONNECTION' }, context)), /management/)
    } else assert.match(String(await tools.execute('search', { handler: 'glob', query: '**', path: 'v:connections' }, context)), /not available/)
    const count = reads
    assert.throws(() => handler.read('observation.json', { ...context, projectId: 'other' }), /Project mismatch/)
    assert.throws(() => handler.list({ ...context, projectId: 'other' }), /Project mismatch/)
    assert.throws(() => handler.read('observation.json', { ...context, memoryAccess: {} } as ExecutionContext), /unavailable/)
    assert.equal(reads, count, 'Cross-Project/lease rejection precedes source access')
    if (!tools.has('read') && !tools.has('search')) {
      assert.throws(() => handler.read('observation.json', context), /unavailable/)
      assert.throws(() => handler.list(context), /unavailable/)
      assert.equal(reads, before)
    }
    await tools.resetDynamicAndWait()
  }
  assert.equal(managementReads, 0, 'Redacted discovery must not touch old navigation sources')
  assert.throws(() => vfs.write('v:connections/observation.json', { content: '{}' }, {} as ExecutionContext), /read-only/)
}))
