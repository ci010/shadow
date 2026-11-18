import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectionSinkProjection, sinkReceiverId } from './sink-projection.ts'
import { passiveChannelId, type ChannelSource } from './passive-contract.ts'
import { parseConnectionSinkProjection } from '../shared/connection-sink.ts'
const base = { projectId: 'p', connectionId: 'conn', platform: 'qq' as const, histories: [], observations: [] }
function history(source: ChannelSource) { return { sessionId: passiveChannelId(source), projectId: source.projectId, channelSource: source } }
const source = { version: 1 as const, projectId: 'p', connectionId: 'conn', platform: 'qq' as const, conversationId: 'group:one', kind: 'group' as const, name: 'Group one' }
test('new connection has one passive sink but no invented receivers/chat; paths are canonical', () => {
  const sink = connectionSinkProjection(base)
  assert.deepEqual(sink.receivers, [])
  assert.equal(sink.sink.navigation.kind, 'connection-content')
  assert.equal(sink.sinkPath, 'v:connections/conn/sink.json')
  assert.deepEqual(parseConnectionSinkProjection(sink, 'p'), sink)
})
test('QQ observed groups form distinct stable receivers referencing existing inboxes', () => {
  const histories = [history(source), history({ ...source, conversationId: 'group:two', name: 'Group two' })]
  const sink = connectionSinkProjection({ ...base, histories })
  assert.equal(sink.receivers.length, 2)
  const one = sink.receivers.find(receiver => receiver.address.conversationId === 'group:one')!
  assert.equal(one.id, sinkReceiverId(one.address))
  assert.equal(one.path, `v:connections/conn/receivers/${one.id}.json`)
  assert.deepEqual(one.navigation, { kind: 'conversation', address: one.address, inboxSessionId: passiveChannelId(source) })
  assert.deepEqual(parseConnectionSinkProjection(sink, 'p'), sink)
  const linked = connectionSinkProjection({ ...base, histories, bots: [{ botId: 'role', path: 'v:bots/deployments/role/status', workflowIds: ['flow'] }] })
  assert.deepEqual(linked.receivers, sink.receivers, 'BOT linking never rekeys a receiver or history')
})
test('Discord threads aggregate only their true parent, retain raw histories and never become assign receivers', () => {
  const child: ChannelSource = { version: 1, projectId: 'p', connectionId: 'conn', platform: 'discord', conversationId: '301', kind: 'thread', parentId: '201', guildId: '100', botUserId: '900' }
  const histories = [history(child), history({ ...child, conversationId: '302' })]
  const before = structuredClone(histories)
  const sink = connectionSinkProjection({ ...base, platform: 'discord', histories })
  assert.equal(sink.receivers.length, 1)
  assert.equal(sink.receivers[0]!.address.conversationId, '201')
  assert.deepEqual(sink.receivers[0]!.navigation, { kind: 'channel-content', address: sink.receivers[0]!.address,
    channelType: null, guildId: '100', view: 'threads' })
  assert.deepEqual(histories, before, 'Projection must not move/merge child history')
  assert.deepEqual(parseConnectionSinkProjection(sink, 'p'), sink)
})
test('unbound Discord discovery is visible without inventing inbox or channel type; invalid/cross-Project sources do not leak', () => {
  const sink = connectionSinkProjection({ ...base, platform: 'discord', histories: [history({ ...source, projectId: 'other' })],
    observations: [{ connection: 'conn', platform: 'discord', conversation: '301', parent: '201' },
      { connection: 'another', platform: 'discord', conversation: 'bad' }] })
  assert.equal(sink.receivers.length, 1)
  const nav = sink.receivers[0]!.navigation
  assert.equal(nav.kind, 'channel-content')
  assert.equal('inboxSessionId' in nav, false)
  assert.deepEqual(parseConnectionSinkProjection(sink, 'p'), sink)
  assert.equal(connectionSinkProjection({ ...base, histories: [{ ...history(source), sessionId: 'forged' }] }).receivers.length, 0)
})

test('only validated direct history projects a private receiver, never bare observed IDs', () => {
  const direct: ChannelSource = { ...source, conversationId: 'dm:one', kind: 'direct', name: 'Owner DM' }
  const qq = connectionSinkProjection({ ...base, histories: [history(direct)],
    observations: [{ connection: 'conn', platform: 'qq', conversation: 'unknown-dm' }] })
  assert.equal(qq.receivers.length, 1)
  assert.equal(qq.receivers[0]?.kind, 'direct')
  assert.equal(qq.receivers[0]?.name, 'Owner DM')
  assert.equal(qq.receivers[0]?.navigation.kind, 'conversation')
  assert.deepEqual(parseConnectionSinkProjection(qq, 'p'), qq)
  const discordDirect: ChannelSource = { version: 1, projectId: 'p', connectionId: 'conn', platform: 'discord',
    conversationId: '401', kind: 'direct', recipientId: '501', botUserId: '900' }
  const discord = connectionSinkProjection({ ...base, platform: 'discord', histories: [history(discordDirect)],
    observations: [{ connection: 'conn', platform: 'discord', conversation: '402' }] })
  assert.deepEqual(discord.receivers.map(r => [r.kind, r.address.conversationId]), [['direct', '401']])
  assert.equal(connectionSinkProjection({ ...base, histories: [{ ...history(direct), sessionId: 'forged' }] }).receivers.length, 0)
  assert.equal(connectionSinkProjection({ ...base, observations: [{ connection: 'conn', platform: 'qq', conversation: 'dm:one' }] }).receivers.length, 0)
})
test('parent messages and public-thread history share only the parent receiver, independent of receipt order', () => {
  const parent: ChannelSource = { version: 1, projectId: 'p', connectionId: 'conn', platform: 'discord',
    conversationId: '201', kind: 'channel', guildId: '100', botUserId: '900', name: 'Parent' }
  const child: ChannelSource = { ...parent, conversationId: '301', kind: 'thread', parentId: '201', name: 'Child' }
  const first = connectionSinkProjection({ ...base, platform: 'discord', histories: [history(child), history(parent)] })
  const second = connectionSinkProjection({ ...base, platform: 'discord', histories: [history(parent), history(child)] })
  assert.deepEqual(first, second)
  assert.equal(first.receivers.length, 1)
  assert.equal(first.receivers[0]?.name, 'Parent')
  assert.deepEqual(first.receivers[0]?.navigation, { kind: 'channel-content', address: first.receivers[0]!.address,
    channelType: null, guildId: '100', view: 'messages-and-threads' })
  assert.deepEqual(parseConnectionSinkProjection(first, 'p'), first)
})

test('inventory evidence never fabricates message persistence, binding, admission or execution', () => {
  const metadata = connectionSinkProjection({ ...base, histories: [history(source), history(source)] })
  assert.equal(metadata.receivers.length, 1, 'Duplicate history containers are not duplicate receipts')
  assert.deepEqual(metadata.receivers[0]!.evidence, { discovery: 'unknown', sessionMetadata: 'present',
    received: 'unknown', persisted: 'unknown', bound: 'unknown', executed: 'unknown' })
  const discovered = connectionSinkProjection({ ...base, platform: 'discord', observations: [
    { connection: 'conn', platform: 'discord', conversation: 'thread', parent: 'parent' }] })
  assert.deepEqual(discovered.receivers[0]!.evidence, { discovery: 'observed', sessionMetadata: 'unknown',
    received: 'unknown', persisted: 'unknown', bound: 'unknown', executed: 'unknown' })
  assert.deepEqual(parseConnectionSinkProjection(JSON.parse(JSON.stringify(metadata)), 'p'), metadata, 'Restart/serialization does not upgrade evidence')
  assert.deepEqual(connectionSinkProjection({ ...base, histories: [history(source)], bots: [] }), metadata, 'Unlink is not a historical rejection receipt')
  assert.throws(() => parseConnectionSinkProjection({ ...metadata, receivers: [{ ...metadata.receivers[0],
    evidence: { ...metadata.receivers[0]!.evidence, persisted: 'confirmed' } }] }), /unknown/)
  assert.throws(() => parseConnectionSinkProjection({ ...metadata, receivers: [{ ...metadata.receivers[0],
    evidence: { ...metadata.receivers[0]!.evidence, body: 'PRIVATE' } }] }), /Unrecognized/)
})
