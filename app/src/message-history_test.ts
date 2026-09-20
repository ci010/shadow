import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMessageTime, messageTime, resendableUserMessage, userMessageMarkers } from './message-history.ts'

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

test('session messages never appear in the human history navigator', () => {
  assert.deepEqual(userMessageMarkers([
    { role: 'user', content: 'Human request' },
    { role: 'user', content: 'Delegated task', sessionSource: { id: 'web:orchestrator', intent: 'handoff' } },
    { role: 'user', content: 'Human follow-up' },
  ]).map(marker => marker.index), [0, 2])
})

test('history rail includes only real user turns, preserving rendered message indexes and timestamps', () => {
  assert.deepEqual(userMessageMarkers([
    { role: 'user', content: 'First\n question', timestamp: '2026-09-10T02:00:00Z' },
    { role: 'assistant', content: 'Response' },
    { role: 'user', content: 'Scheduled event', isSystemEvent: true },
    { role: 'user', content: 'Old summary', isSummary: true },
    { role: 'tool', content: 'Tool result' },
    { role: 'user', content: 'Tool metadata', event: 'tool_result' },
    { role: 'user', content: 'Second question' },
  ]), [
    { index: 0, preview: 'First question', timestamp: '2026-09-10T02:00:00Z' },
    { index: 6, preview: 'Second question', timestamp: undefined },
  ])
})

test('empty and media-only histories have honest previews without fabricated dates', () => {
  assert.deepEqual(userMessageMarkers([]), [])
  assert.equal(userMessageMarkers([{ role: 'user', content: '' }])[0].preview, 'Attachment')
  assert.equal(formatMessageTime(), 'Time unavailable')
  assert.equal(formatMessageTime('not a timestamp'), 'Time unavailable')
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
