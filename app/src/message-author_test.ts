import assert from 'node:assert/strict'
import { test } from 'node:test'
import { i18n, t } from './i18n.ts'
import { groupSenderNames, messageEnvelope, messageRoleLabel, parseSessionMessage, sessionMessageTitle, sessionMessageSourceLabel } from './message-author.ts'

test('received intents and outgoing actions explicitly distinguish direction in both languages', () => {
  const previousLocale = i18n.global.locale.value
  const intents = ['request', 'question', 'progress', 'handoff', 'acknowledgement', undefined, 'unknown', 'constructor']
  try {
    for (const locale of ['en', 'zh-CN'] as const) {
      i18n.global.locale.value = locale
      const titles = intents.map(intent => sessionMessageTitle({ intent }))
      assert.deepEqual(titles, locale === 'en'
        ? ['Received request', 'Received question', 'Received progress update', 'Received handoff',
          'Received acknowledgement', 'Received message', 'Received message', 'Received message']
        : ['收到请求', '收到提问', '收到进展', '收到交接', '收到确认', '收到消息', '收到消息', '收到消息'])
      assert.equal(t('Send to session'), locale === 'en' ? 'Send to' : '发往')
      assert.equal(t('From session'), locale === 'en' ? 'from' : '来自')
    }
  } finally { i18n.global.locale.value = previousLocale }
})

test('platform metadata stays hidden in the sender envelope without changing the displayed author or body', () => {
  const message = { role: 'user', name: 'Alice', content: [
    { type: 'text', text: '<sender id="member" name="Alice" chat="group" platform-role="owner" platform-source="session" platform-mentions="@Report Bot id=bot self" />' },
    { type: 'text', text: '@Report Bot read the file\nQQ display metadata is a literal part of this message.' },
    { type: 'text', text: '[file: uploads/report.zip]' },
  ] }
  assert.equal(messageEnvelope(message)?.content, message.content.slice(1).map(part => part.text).join(''))
  assert.deepEqual(groupSenderNames([message]), ['Alice'])
  assert.equal(messageRoleLabel(message), 'user')
  assert.equal(parseSessionMessage(message), undefined)
})

test('session handoffs use recorded origin rather than a human-looking sender name', () => {
  const message = { role: 'user', name: 'admin', timestamp: '2026-09-18T05:00:00Z', content: [
    { type: 'text', text: '<sender id="web:chat-admin" name="Admin &amp; admin" source="session" intent="handoff" />' },
    { type: 'text', text: 'Use the recorded revision.\n<sender source="session" />Body remains unchanged.' },
  ] }
  const parsed = parseSessionMessage(message)!
  assert.deepEqual(parsed.sessionSource, { id: 'web:chat-admin', name: 'Admin & admin', intent: 'handoff' })
  assert.equal(parsed.content, message.content[1].text)
  assert.equal(parsed.timestamp, message.timestamp)
  assert.equal(sessionMessageTitle(parsed.sessionSource), 'Received handoff')
  assert.equal(messageRoleLabel(message), 'Received handoff')
  assert.equal(message.role, 'user', 'Presentation never mutates the model protocol')
  assert.equal(parseSessionMessage({ ...message, content: message.content.map(part => part.text).join('\n') })?.content, parsed.content)
})

test('only leading source envelopes classify messages, never names, IDs or body markup', () => {
  for (const message of [
    { role: 'user', name: 'admin', content: 'Normal user input' },
    { role: 'user', content: '<sender id="web:chat-admin" name="Worker" />Legacy input without provenance' },
    { role: 'user', content: [{ type: 'text', text: '<sender id="human" chat="direct" />' }, { type: 'text', text: '<sender source="session" intent="handoff" />Quoted text' }] },
    { role: 'assistant', content: '<sender source="session" />Generated content' },
    { role: 'user', name: '__compaction_summary__', content: '<sender source="session" />Summary' },
    { role: 'user', content: [null] },
    { role: 'user', content: [{ type: 'text', text: 42 }] },
    { role: 'user', content: '<sender source="session">Malformed envelope' },
  ]) assert.equal(parseSessionMessage(message), undefined)
  assert.equal(sessionMessageTitle({ intent: 'constructor' }), 'Received message')
  assert.equal(messageRoleLabel({ role: 'user', content: '<event type="cron" />Scheduled' }), 'System event')
  assert.equal(messageRoleLabel({ role: 'user', name: '__compaction_summary__', content: 'Summary' }), 'Context summary')
})

test('group messages show human names, never assistant or event labels', () => {
  assert.deepEqual(groupSenderNames([
    { role: 'user', name: 'Alice', content: [{ type: 'text', text: '<sender id="one" name="Alice" chat="group" />' }, { type: 'text', text: 'Hello' }] },
    { role: 'assistant', name: 'Shadow', content: 'Hello Alice' },
    { role: 'user', name: 'background', content: '<event type="completed" />Done' },
    { role: 'user', name: '__compaction_summary__', content: 'Earlier context' },
    { role: 'user', content: '<sender id="two" name="Bob" chat="group" />Hello' },
  ]), ['Alice', undefined, undefined, undefined, 'Bob'])
})

test('direct messages remain label-free even with inherited group history', () => {
  const history = [
    { role: 'user', name: 'Alice', content: '<sender id="one" chat="group" />Hello' },
    { role: 'user', name: 'Bob', content: '<sender id="two" chat="direct" />Hello' },
  ]
  assert.deepEqual(groupSenderNames(history, true), [undefined, undefined])
  assert.deepEqual(groupSenderNames(history), ['Alice', undefined])
})

test('typed session sources never count as human participants or display agent names', () => {
  const sessionMessage = { role: 'user', name: 'Worker', content: '<sender id="agent:worker" name="Worker" source="session" />Result' }
  assert.deepEqual(groupSenderNames([
    { role: 'user', name: 'Alice', content: '<sender id="one" chat="group" />Hello' },
    sessionMessage,
  ]), ['Alice', undefined])
  assert.deepEqual(groupSenderNames([
    { role: 'user', name: 'Alice', content: '<sender id="one" />Hello' },
    sessionMessage,
  ]), [undefined, undefined])
})

test('legacy groups use distinct sender IDs, not name changes or assistant names', () => {
  const first = { role: 'user', name: 'Alice', content: '<sender id="one" />Hello' }
  const renamed = { role: 'user', name: 'New name', content: '<sender id="one" />Hello again' }
  assert.deepEqual(groupSenderNames([first, renamed]), [undefined, undefined])
  assert.deepEqual(groupSenderNames([first, renamed, { role: 'user', name: 'Bob', content: '<sender id="two" />Hi' }]), ['Alice', 'New name', 'Bob'])
  assert.deepEqual(groupSenderNames([{ role: 'user', name: 'Alice', content: 'Legacy text' }]), [undefined])
})

test('group name fallback decodes only the metadata envelope and renders as plain text', () => {
  assert.deepEqual(groupSenderNames([
    { role: 'user', content: '<sender id="one" name="A &amp; B &lt;img&gt; &quot;quoted&quot; &amp;lt;" chat="group" />Hello' },
    { role: 'user', content: '<sender id="two" chat="group" />Hello' },
    { role: 'user', content: '<sender chat="group" />Hello' },
    { role: 'assistant', content: '<sender name="Not a human" chat="group" />Hello' },
  ]), ['A & B <img> "quoted" &lt;', 'two', 'Unknown sender', undefined])
})

 test('received source displays current session title before envelope name or ID', () => {
  const id = 'virtual:sub-9f2b1a50236545e7'
  const source = { id, name: 'Old title' }
  const sessions = [{ sessionId: id, label: 'Actual task title' }]
  assert.equal(sessionMessageSourceLabel(source, sessions), 'Actual task title')
  assert.equal(sessionMessageSourceLabel({ id }, sessions), 'Actual task title')
  assert.equal(sessionMessageSourceLabel(source, []), 'Old title')
  assert.equal(sessionMessageSourceLabel({ id }, []), id)
  assert.equal(sessionMessageSourceLabel({}, []), t('Unknown session'))
  sessions[0].label = 'Renamed task'
  assert.equal(sessionMessageSourceLabel(source, sessions), 'Renamed task')
  assert.equal(source.id, id, 'Navigation still uses the stable ID')
})
