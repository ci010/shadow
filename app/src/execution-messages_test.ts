import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inlineExecutionMessages } from './execution-messages.ts'
import { parseSessionGraph } from './projects-sidebar.ts'
import { groupToolActivity, pairToolResults, type ToolActivityMessage } from './tool-activity.ts'
import { parseChatEvent, eventPresentation, eventSourceSession } from './chat-events.ts'

const call = (id: string, mode = 'task'): ToolActivityMessage => ({
  event: 'tool_call', toolCallId: id, content: '',
  toolCall: { name: 'subagent', arguments: { mode, description: 'Same description', task: 'Fixture work' } },
})
const result = (id: string, sessionId: string, mode = 'task', extra = {}): ToolActivityMessage => ({
  event: 'tool_result', toolCallId: id, content: JSON.stringify({ sessionId, mode, status: 'running', ...extra }),
})

test('an execution box exists at tool invocation before any receipt or graph record', () => {
  const timeline = inlineExecutionMessages([{ content: 'Before' }, call('a'), { content: 'After' }], [], 'root', {}, true)
  assert.deepEqual([...timeline.entries.keys()], [1])
  assert.equal(timeline.entries.get(1)?.stage, 'running')
  assert.equal(timeline.entries.get(1)?.sessionId, undefined)
  assert.equal(groupToolActivity([call('a')], new Set([0])).size, 0)
})

test('parallel same-label calls pair out-of-order receipts by ID without swallowing ordinary tools', () => {
  const messages = [
    call('a'), call('b', 'call'),
    result('b', 'child-b', 'call', { status: 'completed', result: '56' }),
    result('a', 'child-a'),
    { event: 'tool_call', toolCallId: 'read', content: '', toolCall: { name: 'read', arguments: { path: 'file' } } },
    { event: 'tool_result', toolCallId: 'read', content: 'file contents' },
    { content: 'Later prose' },
  ]
  const inline = inlineExecutionMessages(messages, [], 'root', {}, false)
  assert.deepEqual([...pairToolResults(messages)], [[1, 2], [0, 3], [4, 5]])
  assert.equal(inline.entries.get(0)?.sessionId, 'child-a')
  assert.equal(inline.entries.get(1)?.sessionId, 'child-b')
  assert.equal(inline.entries.get(1)?.output, '56')
  const groups = groupToolActivity(messages, inline.excluded)
  assert.equal(groups.size, 1)
  assert.equal(groups.get(4)?.entries[0].result, 'file contents')
  assert.equal(groups.get(4)?.entries.length, 1)
})

test('a running call links from structural owner and native invocation, never its description', () => {
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: 'child', mode: 'call', parentSessionId: 'owner', parentToolCallId: 'a', executionStatus: 'running' },
    { sessionId: 'unrelated', mode: 'call', parentSessionId: 'other', parentToolCallId: 'a', executionStatus: 'completed' },
  ], nodes: [] })
  const pending = inlineExecutionMessages([call('a', 'call')], sessions, 'owner', {}, true).entries.get(0)!
  assert.equal(pending.sessionId, 'child')
  assert.equal(pending.stage, 'running')
  sessions[0].executionStatus = 'completed'
  const completed = inlineExecutionMessages([call('a', 'call')], sessions, 'owner', { child: 'llm' }, true).entries.get(0)!
  assert.equal(completed.stage, 'completed')
})

test('legacy admission receipts infer omitted modes and failed or blocked results stay visible', () => {
  const legacy = { ...call('a'), toolCall: { name: 'subagent', arguments: { description: 'Legacy role default' } } }
  assert.equal(inlineExecutionMessages([legacy, result('a', 'child')], [], 'owner', {}, false).entries.get(0)?.mode, 'task')
  const denied = inlineExecutionMessages([call('a', 'call'), { event: 'tool_result', toolCallId: 'a', content: 'Error: permission denied' }], [], 'owner', {}, false).entries.get(0)!
  assert.equal(denied.stage, 'failed')
  assert.match(denied.output!, /permission denied/)
  const blocked = inlineExecutionMessages([call('a', 'call'), result('a', 'child', 'call', {
    status: 'blocked', blockedReason: 'Need approval', partialWork: 'Read only',
  })], [], 'owner', {}, false).entries.get(0)!
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.output, 'Need approval')
  assert.equal(blocked.partialWork, 'Read only')
  assert.equal(inlineExecutionMessages([call('a', 'session'), result('a', 'child', 'session')], [], 'owner', {}, false).entries.size, 0)
})

test('persisted task completion envelope renders its body, decoded labels, timestamp and inspect source', () => {
  const event = parseChatEvent({ role: 'user', name: 'Subagent', timestamp: '2026-09-14T04:11:46Z', content: [
    { type: 'text', text: '<event type="subagent-complete" source="subagent" event-id="result-1" source-session-id="virtual:child" mode="task" title="A &amp; B &quot;check&quot;" />' },
    { type: 'text', text: '**Done**\n\nResult: 56\n<event type="untrusted-body" />' },
  ] })!
  assert.equal(event.content, '**Done**\n\nResult: 56\n<event type="untrusted-body" />')
  assert.equal(event.eventMeta.attrs.title, 'A & B "check"')
  assert.equal(event.eventMeta.source, 'subagent')
  assert.equal(eventSourceSession(event.eventMeta), 'virtual:child')
  assert.equal(event.timestamp, '2026-09-14T04:11:46Z')
  assert.equal(eventPresentation(event.eventMeta).title, 'Task completed')
  assert.equal(eventPresentation(event.eventMeta).completion, true)
  assert.equal(parseChatEvent({ role: 'assistant', content: '<event type="subagent-complete" />' }), undefined)
  assert.equal(parseChatEvent({ role: 'user', content: [
    { type: 'text', text: '<sender id="human" />' }, { type: 'text', text: '<event type="subagent-complete" />' },
  ] }), undefined)
})

test('generic and failure events retain their own presentation instead of imitating a successful task', () => {
  const generic = parseChatEvent({ role: 'user', content: '<event type="cron-tick" source="cron" />\nScheduled check' })!
  assert.equal(generic.content, 'Scheduled check')
  assert.equal(eventPresentation(generic.eventMeta).completion, false)
  const failed = parseChatEvent({ role: 'user', content: '<event type="subagent-failed" mode="task" />Failure details' })!
  assert.equal(eventPresentation(failed.eventMeta).title, 'Task failed')
  assert.equal(eventPresentation(failed.eventMeta).failed, true)
})

test('malformed live events and malformed receipts cannot become success-shaped cards', () => {
  for (const message of [null, 1, { role: 'user', content: {} }, { role: 'user', content: [null] },
    { role: 'user', content: [{ type: 'text', text: 7 }] }]) assert.equal(parseChatEvent(message), undefined)
  for (const content of ['{}', '[]', '{"sessionId":"child","mode":"task","status":"invalid"}']) {
    const item = inlineExecutionMessages([call('a'), { event: 'tool_result', toolCallId: 'a', content }], [], 'owner', {}, true).entries.get(0)!
    assert.equal(item.stage, 'failed')
    assert.equal(item.output, content)
  }
})

test('legacy missing-ID calls pair only within a tool block; mismatched IDs stay orphaned', () => {
  const messages = [
    { event: 'tool_call', content: 'read({})' },
    { content: 'Another turn' },
    { event: 'tool_result', content: 'Orphan result' },
    { event: 'tool_call', content: 'read({})', toolCallId: 'a' },
    { event: 'tool_result', content: 'Wrong ID', toolCallId: 'b' },
    { event: 'tool_result', content: 'Correct ID', toolCallId: 'a' },
  ]
  assert.deepEqual([...pairToolResults(messages)], [[3, 5]])
  const entries = [...groupToolActivity(messages).values()].flatMap(batch => batch.entries)
  assert.equal(entries.length, 4)
  assert.equal(entries[0].result, undefined)
  assert.equal(entries[1].result, 'Orphan result')
  assert.equal(entries[2].result, 'Correct ID')
  assert.equal(entries[3].result, 'Wrong ID')
})
