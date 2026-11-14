import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConnectionsHandler } from './connections.ts'
import { VirtualFs } from './virtual-fs.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { ConnectionSinkProjection } from '../channels/sink-contract.ts'

const projection = (): ConnectionSinkProjection => ({ kind: 'connection-sink', id: 'connection:conn', projectId: 'p', connectionId: 'conn',
  connectionPath: 'v:connections/conn/overview.json', sinkPath: 'v:connections/conn/sink.json',
  sink: { kind: 'common-receipt', reacts: false, navigation: { kind: 'connection-content', projectId: 'p', connectionId: 'conn' } },
  receivers: [{ id: 'group:1', address: { projectId: 'p', botInstanceId: 'conn', platform: 'qq', conversationId: 'group:1' },
    path: 'v:connections/conn/receivers/group%3A1.json', navigation: { kind: 'conversation', inboxSessionId: 'qq:existing',
      address: { projectId: 'p', botInstanceId: 'conn', platform: 'qq', conversationId: 'group:1' } } }], bots: [], guidePath: 'v:bots/authoring' })
const context = { projectId: 'p', channel: 'web', sessionId: 'web:owner', admin: true,
  signal: new AbortController().signal, tools: { executionMode: 'session' } } as ExecutionContext

test('canonical Connection mount is bounded read-only inspection with receiver paths', async () => {
  const calls: string[] = []
  const handler = createConnectionsHandler({ projectId: 'p', assertSession: id => { assert.equal(id, 'web:owner') },
    index: () => ({ ids: ['conn'] }), overview: id => ({ id, displayName: 'Connection', platform: 'qq', purpose: 'service',
      enabled: true, health: 'connected', ownerVerified: true, config: 'PRIVATE' }),
    sink: id => { calls.push(id); assert.equal(id, 'conn'); return projection() } })
  const vfs = new VirtualFs(); vfs.mount('v:connections', 'Connections', handler.read, handler.list)
  const overview = await vfs.resolve('v:connections/conn/overview.json', context)
  assert.match(overview!, /v:connections\/conn\/sink.json/); assert.doesNotMatch(overview!, /PRIVATE|config/)
  const entries = await vfs.list('v:connections/conn', context)
  assert(entries?.some(item => item.path === 'v:connections/conn/receivers/group%3A1.json'))
  assert.match((await vfs.resolve('v:connections/conn/receivers/group%3A1.json', context))!, /qq:existing/)
  assert.throws(() => vfs.write('v:connections/conn/sink.json', { content: '{}' }, context), /read-only/)
  for (const patch of [{ projectId: 'other' }, { admin: false }, { remoteWorkdir: {} }, { scriptInvocation: true }, { tools: { executionMode: 'call' } }])
    assert.throws(() => handler.read('conn/sink.json', { ...context, ...patch } as ExecutionContext), /management/)
  assert(calls.every(id => id === 'conn'))
})
