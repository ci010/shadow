import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botCanvas, parseBotProjection } from './bot-workflows.ts'
import { workflowCanvas } from './workflow-canvas.ts'
import { parseWorkflows } from './workflows.ts'

export const bots = {
  connections: [{ id: 'qq-shared', displayName: 'Shared QQ', platform: 'qq', purpose: 'service', enabled: true, health: 'disconnected' }],
  deployments: [{ id: 'sales', state: 'valid', mode: 'service', agent: 'BOT:sales' }, { id: 'support', state: 'valid', mode: 'service', agent: 'BOT:support' }, { id: 'invalid', state: 'quarantined' }],
  bindings: [
    { id: 'one', deploymentId: 'sales', connectionId: 'qq-shared', platform: 'qq', topic: 'group:one', enabled: true, subscribed: true, listener: true, kind: 'message', sessionIds: [] },
    { id: 'two', deploymentId: 'support', connectionId: 'qq-shared', platform: 'qq', topic: 'group:two', enabled: false, subscribed: true, listener: false, kind: 'message', sessionIds: ['qq:existing'] },
  ], warnings: [], routing: 'not-probed', processingSuccess: 'unknown',
}
test('BOT projection is distinct from Workflow runtime definitions and shares the real read-only canvas', () => {
  const snapshot = parseWorkflows({ projectId: 'p', definitions: [], runs: [], bots }, 'p')
  assert.equal(snapshot.definitions.length, 0)
  const flows = botCanvas(snapshot.bots)
  assert.equal(flows.length, 2)
  assert.equal(flows[0]?.connectionSettingsId, 'qq-shared')
  assert.equal(flows[0]?.control, undefined)
  assert.equal(flows[0]?.conversation, undefined)
  assert.equal(flows[0]?.selectionAliases?.['bot-binding:two'], 'bot:two')
  assert.equal(flows[0]?.graph?.some(node => node.nodeType === 'session'), false)
  assert.deepEqual((flows[0]?.graph?.find(node => node.id === 'bot:two')?.config as { sessionIds: string[] }).sessionIds, ['qq:existing'])
  assert.equal(flows[1]?.enabled, false)
  assert.match(JSON.stringify(flows[0]?.graph), /disconnected/)
  assert.match(JSON.stringify(flows[1]?.graph), /quarantined/)
  const canvas = workflowCanvas(flows)
  assert.equal(canvas.nodes.filter(n => n.type === 'group').length, 2)
  assert(canvas.nodes.every(n => !n.draggable && !n.connectable && !n.deletable))
  assert(canvas.edges.every(edge => !edge.animated))
  assert.equal(new Set(canvas.nodes.map(n => n.id)).size, canvas.nodes.length)
  assert.throws(() => parseBotProjection({ ...bots, credentials: 'not allowed' }))
  assert.throws(() => parseBotProjection({ ...bots, connections: [{ ...bots.connections[0], config: {} }] }))
  assert.throws(() => parseBotProjection({ ...bots, deployments: [{ id: 'bad', state: 'running' }] }))
  assert.equal(parseWorkflows({ projectId: 'p', definitions: [], runs: [], botsUnavailable: true }, 'p').botsUnavailable, true)
})

test('isolated group shortcuts remain distinct from binding inspector configuration', () => {
  const flows = botCanvas(parseBotProjection({ ...bots, connections: [...bots.connections,
    { ...bots.connections[0], id: 'one /?#', displayName: 'First' },
    { ...bots.connections[0], id: 'second', displayName: 'Second' }], deployments: [...bots.deployments, { id: 'second', state: 'valid' }] }))
  const groups = workflowCanvas(flows).nodes.filter(n => n.type === 'group')
  assert.deepEqual(groups.filter(n => n.data.configureConnectionId).map(n => n.data.configureConnectionId), ['qq-shared', 'one /?#', 'second'])
  assert.equal(groups.find(n => n.data.definition.id === 'bot-deployment:second')?.data.configureConnectionId, undefined)
  assert.equal(groups.filter(n => n.data.definition.id === 'connection:qq-shared').length, 1)
})

// Regression: the common receipt sink must not replace the real personal Agent.
test('personal paired DM ingress survives a sink with an extra group, without granting group replies', async () => {
  const { connectionSinkProjection } = await import('../../src/channels/sink-projection.ts')
  const { passiveChannelId } = await import('../../src/channels/passive-contract.ts')
  const source = { version: 1 as const, projectId: 'p', botInstanceId: 'qq-shared', platform: 'qq' as const,
    conversationId: 'group:extra', kind: 'group' as const }
  const sink = connectionSinkProjection({ projectId: 'p', connectionId: 'qq-shared', platform: 'qq',
    histories: [{ sessionId: passiveChannelId(source), projectId: 'p', channelSource: source }], observations: [] })
  const snapshot = parseBotProjection({ ...bots, sinks: [sink], deployments: [{ id: 'personal', mode: 'personal', state: 'valid', agent: 'general' }],
    bindings: [{ id: 'owner', deploymentId: 'personal', connectionId: 'qq-shared', platform: 'qq', kind: 'host-owner-ingress',
      enabled: true, subscribed: true, listener: true, sessionIds: ['owner-dm-session'] }] }, 'p')
  const flows = botCanvas(snapshot)
  assert.equal(flows.length, 1)
  assert.equal(flows[0]?.connectionSettingsId, 'qq-shared')
  assert.equal(flows[0]?.sinkProjection?.receivers.length, 1)
  const owner = flows[0]!
  assert.deepEqual(owner.graph?.map(node => node.nodeType), ['connection', 'sink', 'deployment'])
  assert.match(JSON.stringify(owner.graph), /general/)
  assert.match(JSON.stringify(owner.graph), /not permission to reply in every group/)
  assert.equal(owner.graph?.find(node => node.id === 'bot:owner')?.parentId, 'connection')
  assert.deepEqual((owner.graph?.find(node => node.id === 'bot:owner')?.config as { sessionIds: string[] }).sessionIds, ['owner-dm-session'])
  assert(flows.every(flow => flow.graph?.every(node => node.status === 'unknown')))
  const receiverConfig = flows[0]!.graph![1]!.config as { evidence: unknown }
  assert.deepEqual(receiverConfig.evidence, sink.receivers[0]!.evidence, 'Graph and read-only DTO share evidence')
  assert.equal((owner.graph!.find(node => node.id === 'bot:owner')!.config as { listener: boolean }).listener, true)
  assert.equal((owner.graph!.find(node => node.id === 'bot:owner')!.config as { admission: string }).admission, 'unknown')
})

 test('missing binding connection is never replaced by another inventory entry', () => {
  const flows = botCanvas(parseBotProjection({ ...bots, bindings: [{ ...bots.bindings[0], connectionId: 'missing' }] }))
  const binding = flows.find(flow => flow.definition.id === 'bot-binding:one')!
  assert.equal(binding.connectionSettingsId, undefined)
  assert.deepEqual(binding.graph![0]!.config, { id: 'missing' })
 })

test('one transport branches through exact receiver identities, with configured-only and owner entries kept separate', async () => {
  const { connectionSinkProjection } = await import('../../src/channels/sink-projection.ts')
  const { passiveChannelId } = await import('../../src/channels/passive-contract.ts')
  const histories = ['group:one', 'group:unbound'].map(conversationId => {
    const channelSource = { version: 1 as const, projectId: 'p', botInstanceId: 'qq-shared', platform: 'qq' as const, conversationId, kind: 'group' as const }
    return { sessionId: passiveChannelId(channelSource), projectId: 'p', channelSource }
  })
  const sink = connectionSinkProjection({ projectId: 'p', connectionId: 'qq-shared', platform: 'qq', histories, observations: [] })
  const projection = parseBotProjection({ ...bots, deployments: bots.deployments.map(deployment => ({ ...deployment, revision: 'rev-one' })), sinks: [sink], bindings: [...bots.bindings,
    { ...bots.bindings[0], id: 'same-package', topic: 'group:unbound' },
    { ...bots.bindings[0], id: 'owner', kind: 'host-owner-ingress', topic: undefined }] })
  const flows = botCanvas(projection)
  const flow = flows.find(flow => flow.definition.id === sink.id)!
  assert.equal(flows.filter(flow => flow.connectionSettingsId === 'qq-shared').length, 1)
  const receiver = sink.receivers.find(receiver => receiver.address.conversationId === 'group:one')!
  assert.equal(flow.graph!.find(node => node.id === 'bot:one')!.parentId, `receiver:${receiver.id}`)
  assert.equal(flow.graph!.find(node => node.id === 'bot:one')!.receiverId, receiver.id)
  assert.equal(flow.graph!.find(node => node.id === 'bot:two')!.parentId, 'entry:two')
  assert.equal(flow.graph!.find(node => node.id === 'bot:owner')!.parentId, 'connection')
  assert.equal(flow.graph!.some(node => node.nodeType === 'binding'), false, 'Binding lives inside the published BOT')
  const first = flow.graph!.find(node => node.id === 'bot:one')!.config as { deployment: unknown; executed: string }
  const second = flow.graph!.find(node => node.id === 'bot:same-package')!.config as { deployment: unknown }
  assert.deepEqual(first.deployment, second.deployment, 'One publication identity and revision across receiver branches')
  assert.equal((first.deployment as { revision: string }).revision, 'rev-one')
  assert.equal(first.executed, 'unknown')
  assert.equal(flow.selectionAliases!['bot-binding:one'], 'bot:one')
  const canvas = workflowCanvas([flow])
  const edgePairs = canvas.edges.map(edge => [JSON.parse(edge.source)[1], JSON.parse(edge.target)[1]])
  assert(edgePairs.some(([from, to]) => from === `receiver:${receiver.id}` && to === 'bot:one'))
  assert(!edgePairs.some(([from, to]) => from === 'connection' && to === 'bot:one'))
  assert(!edgePairs.some(([from, to]) => from === `receiver:${receiver.id}` && to === 'bot:owner'))
  const withoutBinding = botCanvas({ ...projection, bindings: [] }).find(flow => flow.definition.id === sink.id)!
  assert.equal(withoutBinding.sinkProjection!.receivers.length, 2, 'Unbinding does not erase receiver inventory')
  assert.equal(withoutBinding.graph!.filter(node => node.id.startsWith('receiver:')).length, 2)
  assert.equal(withoutBinding.graph!.some(node => node.nodeType === 'deployment'), false)
})

test('receiver titles share names or typed raw identities; owner associations cannot consume groups', async () => {
  const { connectionSinkProjection } = await import('../../src/channels/sink-projection.ts')
  const { passiveChannelId } = await import('../../src/channels/passive-contract.ts')
  const { receiverLabel } = await import('./receiver-label.ts')
  const sources = [
    { kind: 'direct' as const, conversationId: 'dm:owner', name: 'Owner chat' },
    { kind: 'direct' as const, conversationId: 'dm:other' },
    { kind: 'group' as const, conversationId: 'group:one' },
  ].map(item => ({ version: 1 as const, projectId: 'p', botInstanceId: 'qq-shared', platform: 'qq' as const, ...item }))
  const sink = connectionSinkProjection({ projectId: 'p', connectionId: 'qq-shared', platform: 'qq', observations: [], histories: sources.map(channelSource => ({ projectId: 'p', sessionId: passiveChannelId(channelSource), channelSource })) })
  const owner = sink.receivers.find(r => r.address.conversationId === 'dm:owner')!
  const group = sink.receivers.find(r => r.kind === 'group')!
  const projection = parseBotProjection({ ...bots, sinks: [sink], bindings: [{ ...bots.bindings[0], id: 'owner', kind: 'host-owner-ingress', topic: undefined, receiverIds: [owner.id] }] })
  const flow = botCanvas(projection)[0]!
  assert.equal(flow.graph!.find(n => n.id === 'bot:owner')?.parentId, `receiver:${owner.id}`)
  for (const receiver of sink.receivers) assert.equal(flow.graph!.find(n => n.id === `receiver:${receiver.id}`)?.label, receiverLabel(receiver))
  assert.equal(receiverLabel(owner), 'Owner chat')
  assert.equal(receiverLabel(group), 'qq · Group · group:one')
  assert.equal(botCanvas({ ...projection, bindings: [{ ...projection.bindings[0]!, receiverIds: [group.id] }] })[0]!.graph!.find(n => n.id === 'bot:owner')?.parentId, 'connection')
})

test('Discord top-level and thread-parent receiver matching uses guild/channel IDs, never name', async () => {
  const { connectionSinkProjection } = await import('../../src/channels/sink-projection.ts')
  const { passiveChannelId } = await import('../../src/channels/passive-contract.ts')
  const source = { version: 1 as const, projectId: 'p', botInstanceId: 'discord', platform: 'discord' as const, kind: 'channel' as const, conversationId: '201', guildId: '100', botUserId: '900', name: 'Same display name' }
  for (const channelSource of [source, { ...source, kind: 'thread' as const, conversationId: '301', parentId: '201' }]) {
    const sink = connectionSinkProjection({ projectId: 'p', connectionId: 'discord', platform: 'discord', observations: [], histories: [{ projectId: 'p', sessionId: passiveChannelId(channelSource), channelSource }] })
    const binding = { ...bots.bindings[0], connectionId: 'discord', platform: 'discord', topic: 'guild:100:channel:201' }
    const projection = parseBotProjection({ ...bots, connections: [{ ...bots.connections[0], id: 'discord', platform: 'discord' }], sinks: [sink], bindings: [binding] })
    assert.equal(botCanvas(projection)[0]!.graph!.find(n => n.id === 'bot:one')?.parentId, `receiver:${sink.receivers[0]!.id}`)
    for (const topic of ['guild:999:channel:201', 'guild:100:channel:Same display name', 'dm:201']) {
      const flow = botCanvas({ ...projection, bindings: [{ ...projection.bindings[0]!, topic }] })[0]!
      assert.equal(flow.graph!.find(n => n.id === 'bot:one')?.parentId, 'entry:one')
      assert.match(flow.graph!.find(n => n.id === 'entry:one')!.label, /999|Same display name|dm:201/)
    }
  }
})
