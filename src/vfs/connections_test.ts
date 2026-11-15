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
    evidence: { discovery: 'unknown', sessionMetadata: 'present', received: 'unknown', persisted: 'unknown', bound: 'unknown', executed: 'unknown' },
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
  const receiver = (await vfs.resolve('v:connections/conn/receivers/group%3A1.json', context))!
  assert.match(receiver, /qq:existing/)
  assert.deepEqual(JSON.parse(receiver).evidence, projection().receivers[0]!.evidence)
  const sink = JSON.parse((await vfs.resolve('v:connections/conn/sink.json', context))!)
  assert.deepEqual(sink.receivers[0].evidence, JSON.parse(receiver).evidence)
  assert.throws(() => vfs.write('v:connections/conn/sink.json', { content: '{}' }, context), /read-only/)
  for (const patch of [{ projectId: 'other' }, { admin: false }, { remoteWorkdir: {} }, { scriptInvocation: true }, { tools: { executionMode: 'call' } }])
    assert.throws(() => handler.read('conn/sink.json', { ...context, ...patch } as ExecutionContext), /management/)
  assert(calls.every(id => id === 'conn'))
})

test('QQ owner and forged/cross-scope calls cannot read or enumerate management evidence', () => {
  let calls = 0
  const handler = createConnectionsHandler({ projectId: 'p', assertSession: () => { throw Error('Not a live owner Web session') },
    index: () => { calls++; return { ids: ['conn'] } }, overview: () => { calls++; throw Error('Must not inspect') },
    sink: () => { calls++; return projection() } })
  const qq = { ...context, channel: 'qq', sessionId: 'bot:p:conn:dm', chatId: 'dm', admin: true,
    channelAddress: { projectId: 'p', botInstanceId: 'conn', platform: 'qq', conversationId: 'dm' } } as ExecutionContext
  for (const candidate of [qq, { ...qq, projectId: 'other' }, { ...qq, channelAddress: { ...qq.channelAddress!, botInstanceId: 'other' } },
    { ...context, channelAddress: qq.channelAddress }, { ...context, projectId: 'other' }, context]) {
    for (const path of ['overview', 'index.json', 'conn/sink.json', 'other/sink.json', 'self.json']) {
      assert.throws(() => handler.read(path, candidate), /management|live owner/)
      assert.throws(() => handler.list(candidate, { subpath: path }), /management|live owner/)
    }
  }
  assert.equal(calls, 0, 'Denied contexts must not even perform inventory lookups')
})
