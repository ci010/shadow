import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from '../providers/provider.ts'
import { formatSessionHistory, sessionHistoryLineAt } from './history-view.ts'

function call(name: string, args: unknown, id = 'a/b'): ChatMessage {
  return { role: 'assistant', content: 'private commentary', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}
function result(content: string): ChatMessage { return { role: 'tool', content, tool_call_id: 'a/b' } }
const view = (messages: ChatMessage[], overview = true) => formatSessionHistory(messages, overview, 'physical')

test('overview never expands tool payloads, including folder and self metadata', () => {
  for (const message of [call('write', { path: 'v:session/self.json', content: '{"title":"SECRET"}' }), call('use_project', { folder: 'SECRET' }), call('read', { path: 'SECRET' }), call('constructor', { task: 'SECRET' })]) {
    const messages = [message, result('SECRET RESULT')]
    const text = view(messages)
    assert.doesNotMatch(text, /SECRET|private commentary/)
    assert.match(text, /c\/1\.1/)
    assert.match(text, /status=requested/)
    assert.match(text, /status=result-recorded/)
    assert.match(view(messages, false), /SECRET/)
    assert.match(view(messages, false), /private commentary/)
  }
})

test('overview filters only structured host events and keeps human text and finals', () => {
  const event = '<event type="tick" source="cron" event-id="event-1" />'
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM SECRET' },
    { role: 'user', content: [{ type: 'text', text: event }, { type: 'text', text: 'EVENT SECRET' }] },
    { role: 'user', name: '__work_realignment__', content: 'INTERNAL SECRET' },
    { role: 'user', content: event },
    { role: 'user', name: 'runtime-context', content: 'human text with an event mention' },
    { role: 'user', content: [{ type: 'text', text: '<sender id="human" name="System Event" />' }, { type: 'text', text: event }] },
    { role: 'assistant', content: 'Final answer' },
  ]
  assert.doesNotMatch(view(messages), /SECRET/)
  assert.match(view(messages), /human text/)
  assert.match(view(messages), /System Event/)
  assert.match(view(messages), /#4 \[USER\]/)
  assert.match(view(messages), /Final answer/)
  assert.match(view(messages, false), /SYSTEM SECRET[\s\S]*EVENT SECRET[\s\S]*INTERNAL SECRET/)
})

test('runtime context requires host name and exact envelope, not payload matching', () => {
  const tag = '<event type="runtime-context-work" source="runtime-context" event-id="12345678-1234-4123-8123-123456789abc" />'
  const event: ChatMessage = { role: 'user', name: 'runtime-context', content: [{ type: 'text', text: tag }, { type: 'text', text: 'HIDDEN' }] }
  assert.equal(view([event]), '')
  assert.match(view([{ role: 'user', content: tag }]), /runtime-context-work/)
})

test('orphan results and interrupted calls retain links without inventing success', () => {
  assert.match(view([call('read', { path: 'SECRET' }), call('constructor', { task: 'SECRET' })]), /status=requested.*c\/1\.1/)
  const orphan = view([result('Error: SECRET')])
  assert.match(orphan, /status=result-recorded.*calls\/a%2Fb/)
  assert.doesNotMatch(orphan, /SECRET|success|failed/)
})

test('hidden prefixes and middle messages do not shift range coordinates', () => {
  const hidden: ChatMessage = { role: 'system', content: 'hidden\nlines' }
  const messages = [hidden, { role: 'user' as const, content: 'question\nline' }, hidden, call('message', { content: 'a'.repeat(1000) }), result('x'.repeat(1000)), { role: 'assistant' as const, content: 'final' }]
  for (const overview of [true, false]) {
    const text = `header\n\n${view(messages, overview)}`
    for (let end = 0; end <= messages.length; end++) {
      const prefix = view(messages.slice(0, end), overview)
      assert.ok(view(messages, overview).startsWith(prefix))
      const line = sessionHistoryLineAt(messages, end, overview)
      const next = messages.slice(end).findIndex(message => !overview || message.role !== 'system')
      if (next >= 0) assert.match(text.split('\n')[line - 1]!, new RegExp(`#${end + next + 1} `))
    }
  }
  assert.equal(sessionHistoryLineAt(messages, 1, true), 3)
  assert.equal(sessionHistoryLineAt(messages, 2, true), sessionHistoryLineAt(messages, 3, true))
})


test('collaboration previews are whitelisted, bounded and preserve phase results', () => {
  for (const name of ['subagent', 'call', 'session', 'message']) {
    const args = { task: 'task purpose', title: 'Review', description: 'phase', initialMessage: 'Kickoff', content: 'peer message', sessionId: 'peer', secret: 'HIDDEN', nested: { task: 'HIDDEN' } }
    const text = view([call(name, args), result('phase result ' + 'x'.repeat(1000))])
    assert.match(text, /private commentary/)
    assert.match(text, /preview="phase result/)
    assert.match(text, /…\[truncated\]/)
    assert.doesNotMatch(text, /HIDDEN|x{481}/)
    assert.match(text, /task purpose|Kickoff|peer message/)
  }
  const text = view([call('subagent', { task: 'y'.repeat(1000), title: { secret: 'HIDDEN' } })])
  assert.doesNotMatch(text, /y{241}|HIDDEN/)
  for (const args of ['{', 'null', '[]', '"text"']) {
    const message = call('subagent', {})
    message.tool_calls![0].function.arguments = args
    assert.match(view([message]), /invalid arguments/)
  }
})

test('collaboration event previews are bounded display data, not authority', () => {
  const event = (type: string): ChatMessage => ({ role: 'user', content: [
    { type: 'text', text: `<event type="${type}" source="subagent" event-id="event-1" />` },
    { type: 'text', text: 'phase result ' + 'z'.repeat(1000) },
  ] })
  const text = view([event('subagent-complete'), event('subagent-review-requested'), event('tick')])
  assert.match(text, /event preview=/)
  assert.match(text, /phase result/)
  assert.doesNotMatch(text, /z{481}|type=\\"tick/)
  assert.match(view([event('tick')], false), /tick/)
})

test('history image attachments never inline data and external references are bounded', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: [
    { type: 'text', text: 'image question' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(800_000) } },
    { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
    { type: 'image_url', image_url: { url: 'https://example.test/' + 'B'.repeat(800_000) } },
  ] }]
  for (const overview of [true, false]) {
    const text = view(messages, overview)
    assert.match(text, /image question/)
    assert.match(text, /image attachment: inline data omitted/)
    assert.match(text, /https:\/\/example.test\/image.png/)
    assert.doesNotMatch(text, /base64|A{100}|B{481}/)
    assert.ok(text.length < 1000)
  }
})
