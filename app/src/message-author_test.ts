import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupSenderNames } from './message-author.ts'

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
