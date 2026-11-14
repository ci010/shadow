import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectionSinkCanvas, sinkNavigationLocation } from './connection-sinks.ts'
import { workflowCanvas } from './workflow-canvas.ts'
import { connectionSinkInputReference, captureInputReferences } from './workflow-input-references.ts'
import { parseWorkflows } from './workflows.ts'
import type { ConnectionSinkProjection, ChannelSinkNavigation } from '../../src/channels/sink-contract.ts'
const address = { projectId: 'p', botInstanceId: 'conn', platform: 'discord' as const, conversationId: 'parent' }
const projection = (): ConnectionSinkProjection => ({ kind: 'connection-sink', id: 'connection:conn', projectId: 'p', connectionId: 'conn',
  connectionPath: 'v:connections/conn/overview.json', sinkPath: 'v:connections/conn/sink.json',
  sink: { kind: 'common-receipt', reacts: false, navigation: { kind: 'connection-content', projectId: 'p', connectionId: 'conn' } },
  receivers: [{ id: 'parent', address, path: 'v:connections/conn/receivers/parent.json',
    navigation: { kind: 'channel-content', address, guildId: 'guild', channelType: 15, view: 'threads' } },
  { id: 'second', address: { ...address, conversationId: 'second' }, path: 'v:connections/conn/receivers/second.json',
    navigation: { kind: 'channel-content', address: { ...address, conversationId: 'second' }, guildId: 'guild', channelType: 0, view: 'messages-and-threads' } }],
  bots: [], guidePath: 'v:bots/authoring' })
test('Connection branches to real parent receivers, with no BOT/session/linear receiver chain', () => {
  const flow = connectionSinkCanvas(projection(), 'p', 'Discord')
  assert.deepEqual(flow.graph!.map(node => node.nodeType), ['connection', 'sink', 'sink'])
  assert.equal(flow.conversation, undefined); assert.equal(flow.control, undefined)
  const canvas = workflowCanvas([flow])
  assert(canvas.edges.every(edge => edge.source === JSON.stringify(['connection:conn', 'connection'])))
  assert.equal(canvas.edges.length, 2)
  assert(canvas.nodes.every(node => !node.draggable && !node.connectable && !node.deletable))
  assert.throws(() => parseWorkflows({ projectId: 'other', definitions: [], runs: [], bots: { connections: [], deployments: [], bindings: [],
    sinks: [projection()], warnings: [], routing: 'not-probed', processingSuccess: 'unknown' } }, 'other'))
  const root = connectionSinkInputReference('p', 'conn', 'Discord'), receiver = connectionSinkInputReference('p', 'conn', 'Parent', 'parent')
  assert.deepEqual(captureInputReferences([root, receiver]), [{ kind: 'connection-sink', projectId: 'p', connectionId: 'conn' },
    { kind: 'connection-sink', projectId: 'p', connectionId: 'conn', receiverId: 'parent' }])
})
test('navigation uses existing inbox or parent channel; zero/multiple content never invents chat', () => {
  const conversation: ChannelSinkNavigation = { kind: 'conversation', address, inboxSessionId: 'existing' }
  assert.equal(sinkNavigationLocation(conversation)?.params.sessionId, 'existing')
  const forum = projection().receivers[0].navigation
  assert.match(sinkNavigationLocation(forum)!.params.sessionId, /parent/)
  assert.equal(sinkNavigationLocation({ ...forum, guildId: null } as ChannelSinkNavigation), undefined)
  assert.equal(sinkNavigationLocation(projection().sink.navigation), undefined)
  const empty = projection(); empty.receivers = []
  assert.equal(connectionSinkCanvas(empty, 'p', 'Empty').graph!.length, 2)
})
