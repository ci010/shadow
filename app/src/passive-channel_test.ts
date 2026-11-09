import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSessionGraph } from './folders-sidebar.ts'
import { filterReferenceSessions, insertSessionReference } from './session-references.ts'
import { passiveChannelId, type ChannelSource } from '../../src/channels/passive-contract.ts'
import { mountBotUi } from './bot-ui-test-helpers.ts'

const source: ChannelSource = { version: 1, projectId: 'p', platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one', kind: 'group', name: 'Support group' }
const id = passiveChannelId(source)

test('passive inbox projects as a read-only channel conversation and normal owner composer reference, not a synthetic observed group', () => {
  const sessions = parseSessionGraph({ nodes: [], sessions: [{ sessionId: id, projectId: 'p', name: source.name, channelSource: source, mode: 'session' }] }, 'p')
  assert.equal(sessions[0]?.isDirectChat, false)
  assert.deepEqual(sessions[0]?.channelSource, source)
  assert.equal(sessions[0]?.channelAddress?.botInstanceId, source.botInstanceId)
  const matching = filterReferenceSessions(sessions, 'web:owner', 'Support')
  assert.equal(matching.length, 1)
  const reference = insertSessionReference('Assign ', { start: 7, end: 7 }, matching[0]!, 'p')
  assert.match(reference.text, /v:sessions\/channel-inbox:/)
  assert.match(reference.text, /Session reference only/)
  assert.doesNotMatch(reference.text, /approve|deploy|grant/)
  assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ sessionId: id, projectId: 'other', channelSource: source }] }, 'other'))
  assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ sessionId: id, projectId: 'p' }] }, 'p'))
})

test('inbox notice describes receipt, reference, exact approval and history boundaries without editable bindings', t => {
  const view = mountBotUi(t, 'ChannelInboxNotice.vue', { source })
  assert.match(view.text(), /without invoking an Agent/)
  assert.match(view.text(), /type @ and select this inbox/)
  assert.match(view.text(), /not permission/)
  assert.match(view.text(), /never replayed automatically/)
  assert.equal(view.nodes().filter(node => ['input', 'form', 'select'].includes(node.tag)).length, 0)
  assert.deepEqual(view.nodes().find(node => node.tag === 'a')?.props.to, { name: 'chat', params: { projectId: 'p' } })
})
