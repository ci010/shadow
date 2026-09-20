import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMessageTime, messageTime, resendableUserMessage, messageHistoryMarkers } from './message-history.ts'
import { parseLiveSessionMessage } from './chat-events.ts'

test('resend targets only a trailing human message and preserves its attachments', () => {
  assert.equal(resendableUserMessage([]), undefined)
  const message = { role: 'user', content: '', media: ['media:photo.png'] }
  assert.equal(resendableUserMessage([{ role: 'assistant', content: 'Previous reply' }, message]), message)
  assert.equal(resendableUserMessage([message, { role: 'assistant', content: 'Done' }]), undefined)
})

test('I/O and background notifications never become resend prompts or fallback content', () => {
  const answered = [{ role: 'user', content: 'Record a sample' }, { role: 'assistant', content: 'Saved recording.wav' }]
  for (const message of [
    { role: 'user', content: 'I/O completed', isSystemEvent: true },
    { role: 'user', content: 'exec finished', isSystemEvent: true },
    { role: 'user', content: 'Compacted history', isSummary: true },
    { role: 'user', content: 'Tool result', event: 'tool_result' },
    { role: 'tool', content: 'Output' },
    { role: 'user', content: 'Delegated handoff', sessionSource: { id: 'web:orchestrator' } },
  ]) {
    assert.equal(resendableUserMessage([...answered, message]), undefined)
    assert.equal(resendableUserMessage([message]), undefined)
  }
  assert.equal(resendableUserMessage([
    ...answered,
    { role: 'user', content: 'I/O completed', isSystemEvent: true },
    { role: 'user', content: 'exec finished', isSystemEvent: true },
  ]), undefined)
})

test('session messages appear alongside human turns with distinct attribution', () => {
  assert.deepEqual(messageHistoryMarkers([
    { role: 'user', content: 'Human request' },
    { role: 'user', content: 'Delegated task', sessionSource: { id: 'web:orchestrator', intent: 'handoff' } },
    { role: 'user', content: 'Human follow-up', senderName: 'Alice' },
  ], [{ sessionId: 'web:orchestrator', label: 'Coordinator' }]).map(({ index, kind, source, sourceId, label }) => ({ index, kind, source, sourceId, label })), [
    { index: 0, kind: 'user', source: 'User', sourceId: undefined, label: 'User message' },
    { index: 1, kind: 'session', source: 'Coordinator', sourceId: 'web:orchestrator', label: 'Session handoff' },
    { index: 2, kind: 'user', source: 'Alice', sourceId: undefined, label: 'User message' },
  ])
})

test('history rail excludes tools, summaries and unrelated system events while preserving indexes and times', () => {
  assert.deepEqual(messageHistoryMarkers([
    { role: 'user', content: 'First\n question', timestamp: '2026-09-10T02:00:00Z' },
    { role: 'assistant', content: 'Response' },
    { role: 'user', content: 'Scheduled event', isSystemEvent: true },
    { role: 'user', content: 'Old summary', isSummary: true },
    { role: 'tool', content: 'Tool result' },
    { role: 'user', content: 'Tool metadata', event: 'tool_result' },
    { role: 'user', content: 'Second question' },
  ]).map(({ index, preview, timestamp }) => ({ index, preview, timestamp })), [
    { index: 0, preview: 'First question', timestamp: '2026-09-10T02:00:00Z' },
    { index: 6, preview: 'Second question', timestamp: undefined },
  ])
})

test('empty and media-only histories have honest previews without fabricated dates', () => {
  assert.deepEqual(messageHistoryMarkers([]), [])
  assert.equal(messageHistoryMarkers([{ role: 'user', content: '' }])[0].preview, 'Attachment')
  assert.equal(formatMessageTime(), 'Time unavailable')
  assert.equal(formatMessageTime('not a timestamp'), 'Time unavailable')
})

test('session events and live sender envelopes are navigable without becoming resendable', () => {
  const messages = [
    '<sender source="session" id="web:review" name="Reviewer" intent="progress"/>Checking changes',
    '<event type="subagent-complete" source="Worker" source-session-id="task:worker"/>Finished\n review',
    '<event type="message" source="Reviewer" sourceSessionId="web:review"/>A question',
    '<event type="subagent-failed" source="Legacy worker"/>',
    '<event type="heartbeat" source="scheduler"/>Wake up',
  ].map(content => {
    const parsed = parseLiveSessionMessage({ role: 'user', content, timestamp: '2026-09-20T01:00:00Z' })
    assert(parsed)
    return parsed
  })
  const markers = messageHistoryMarkers(messages)
  assert.deepEqual(markers.map(marker => marker.index), [0, 1, 2, 3])
  assert.deepEqual(markers.map(marker => marker.source), ['Reviewer', 'Worker', 'Reviewer', 'Legacy worker'])
  assert.deepEqual(markers.map(marker => marker.label), ['Session progress', 'Agent completed', 'message', 'Agent failed'])
  assert.equal(markers[1].preview, 'Finished review')
  assert.equal(markers[3].preview, 'Agent failed')
  assert.equal(markers[1].sourceId, 'task:worker')
  assert.equal(markers[2].sourceId, 'web:review')
  assert(markers.every(marker => marker.timestamp === '2026-09-20T01:00:00Z'))
  for (const message of messages) assert.equal(resendableUserMessage([message]), undefined)
})

test('unlisted sessions retain recorded names or IDs and missing identity is explicit', () => {
  const markers = messageHistoryMarkers([
    { role: 'user', content: 'Named', sessionSource: { id: 'web:missing', name: 'Archived topic' } },
    { role: 'user', content: 'Unnamed', sessionSource: { id: 'web:missing' } },
    { role: 'user', content: 'Legacy', sessionSource: {} },
    { role: 'user', content: 'Done', isSystemEvent: true, eventMeta: { type: 'subagent-complete', source: 'Worker', attrs: { executionId: 'task:old' } } },
  ])
  assert.deepEqual(markers.map(marker => marker.source), ['Archived topic', 'web:missing', 'Unknown session', 'Worker'])
  assert.equal(markers[3].sourceId, 'task:old')
})

test('hover times use local calendar days for Today, Yesterday and older dates', () => {
  const now = new Date(2026, 8, 11, 0, 30)
  assert.equal(formatMessageTime(new Date(2026, 8, 11, 0, 0).toISOString(), now, 'en-US'), 'Today, 00:00')
  assert.equal(formatMessageTime(new Date(2026, 8, 10, 23, 48).toISOString(), now, 'en-US'), 'Yesterday, 23:48')
  assert.equal(formatMessageTime(new Date(2026, 8, 9, 12, 5).toISOString(), now, 'en-US'), 'Sep 9, 12:05')
  assert.equal(formatMessageTime(new Date(2025, 8, 9, 12, 5).toISOString(), now, 'en-US'), 'Sep 9, 2025, 12:05')
})

test('Yesterday spans month and year boundaries without assuming a fixed 24-hour offset', () => {
  const now = new Date(2027, 0, 1, 0, 1)
  assert.equal(formatMessageTime(new Date(2026, 11, 31, 23, 59).toISOString(), now, 'en-US'), 'Yesterday, 23:59')
})

test('message footers use compact local time and expose the full date and timezone', () => {
  const timestamp = new Date(2026, 0, 3, 9, 7).toISOString()
  const time = messageTime(timestamp, 'en-US')
  assert.equal(time.dateTime, timestamp)
  assert.equal(time.label, '09:07')
  assert.match(time.title, /2026/)
  assert.match(time.title, /Jan 3/)
  assert.equal(messageTime(new Date(2026, 0, 3, 0, 0).toISOString(), 'en-US').label, '00:00')
})

test('missing or invalid historical timestamps never turn into current time', () => {
  for (const timestamp of [undefined, '', 'invalid']) {
    const time = messageTime(timestamp)
    assert.equal(time.dateTime, undefined)
    assert.equal(time.label, 'Time unavailable')
  }
})
