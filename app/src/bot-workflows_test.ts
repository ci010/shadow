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
