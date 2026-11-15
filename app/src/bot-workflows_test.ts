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
  assert.equal(flows.length, 3)
  assert.equal(flows[0]?.control, undefined)
  assert.equal(flows[0]?.conversation, undefined)
  assert.deepEqual(flows[1]?.conversation, { kind: 'fixed', sessionId: 'qq:existing' })
  assert.equal(flows[1]?.enabled, false)
  assert.match(JSON.stringify(flows[0]?.graph), /disconnected/)
  assert.match(JSON.stringify(flows[2]?.graph), /quarantined/)
  const canvas = workflowCanvas(flows)
  assert.equal(canvas.nodes.filter(n => n.type === 'group').length, 3)
  assert(canvas.nodes.every(n => !n.draggable && !n.connectable && !n.deletable))
  assert(canvas.edges.every(edge => !edge.animated))
  assert.equal(new Set(canvas.nodes.map(n => n.id)).size, canvas.nodes.length)
  assert.throws(() => parseBotProjection({ ...bots, credentials: 'not allowed' }))
  assert.throws(() => parseBotProjection({ ...bots, connections: [{ ...bots.connections[0], config: {} }] }))
  assert.throws(() => parseBotProjection({ ...bots, deployments: [{ id: 'bad', state: 'running' }] }))
  assert.equal(parseWorkflows({ projectId: 'p', definitions: [], runs: [], botsUnavailable: true }, 'p').botsUnavailable, true)
})

test('only isolated connector groups expose exact connection configuration, not deployments or binding conversations', () => {
  const flows = botCanvas(parseBotProjection({ ...bots, connections: [...bots.connections,
    { ...bots.connections[0], id: 'one /?#', displayName: 'First' },
    { ...bots.connections[0], id: 'second', displayName: 'Second' }], deployments: [...bots.deployments, { id: 'second', state: 'valid' }] }))
  const groups = workflowCanvas(flows).nodes.filter(n => n.type === 'group')
  assert.deepEqual(groups.filter(n => n.data.configureConnectionId).map(n => n.data.configureConnectionId), ['one /?#', 'second'])
  assert.equal(groups.find(n => n.data.definition.id === 'bot-deployment:second')?.data.configureConnectionId, undefined)
  assert.deepEqual(groups.find(n => n.data.definition.id === 'bot-binding:two')?.data.conversation, { kind: 'fixed', sessionId: 'qq:existing' })
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
  assert.equal(flows.length, 2)
  assert.equal(flows[0]?.sinkProjection?.receivers.length, 1)
  const owner = flows.find(flow => flow.definition.id === 'bot-binding:owner')!
  assert.deepEqual(owner.graph?.map(node => node.nodeType), ['connection', 'binding', 'deployment', 'session'])
  assert.match(JSON.stringify(owner.graph), /general/)
  assert.match(JSON.stringify(owner.graph), /not permission to reply in every group/)
  assert.deepEqual(owner.conversation, { kind: 'fixed', sessionId: 'owner-dm-session' })
  assert(!JSON.stringify(owner.graph).includes('group:extra'))
  assert(flows.every(flow => flow.graph?.every(node => node.status === 'unknown')))
  const receiverConfig = flows[0]!.graph![1]!.config as { evidence: unknown }
  assert.deepEqual(receiverConfig.evidence, sink.receivers[0]!.evidence, 'Graph and read-only DTO share evidence')
  assert.equal((owner.graph![1]!.config as { listener: boolean }).listener, true)
  assert.equal((owner.graph![1]!.config as { admission: string }).admission, 'unknown')
})
