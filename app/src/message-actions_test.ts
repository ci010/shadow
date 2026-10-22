import assert from 'node:assert/strict'
import test from 'node:test'
import { inlineMessageActions } from './message-actions.ts'
import { groupToolActivity, type ToolActivityMessage } from './tool-activity.ts'
import type { SidebarSession } from './folders-sidebar.ts'

const call = (id: string, sessionId = 'web:peer'): ToolActivityMessage => ({
  event: 'tool_call', toolCallId: id, content: '',
  toolCall: { name: 'message', arguments: { sessionId, content: 'Please review the changes.' } },
})
const result = (id: string, content: string): ToolActivityMessage => ({ event: 'tool_result', toolCallId: id, content })
const peer: SidebarSession = {
  sessionId: 'web:peer', label: 'Reviewer', isDirectChat: true, isCurrent: false, parentSessionId: null, depth: 0,
}

test('message actions resolve recipient names and distinguish queue admission from silent recording', () => {
  const entries = inlineMessageActions([
    call('queue'), result('queue', 'Message sent to web:peer. Queued for a response after any active turn.'),
    { ...call('silent'), toolCall: { name: 'message', arguments: { sessionId: 'web:peer', content: 'For later', silent: true } } },
    result('silent', 'Message sent to web:peer (silent). Recorded only.'),
  ], [peer]).entries
  assert.equal(entries.get(0)?.recipient, 'Reviewer')
  assert.equal(entries.get(0)?.sessionId, peer.sessionId)
  assert.equal(entries.get(0)?.content, 'Please review the changes.')
  assert.equal(entries.get(0)?.status, 'queued')
  assert.equal(entries.get(2)?.status, 'recorded')
  assert.match(entries.get(2)!.arguments, /"silent": true/)
})

test('ID pairing crosses intervening text without swallowing other tool activity or orphan results', () => {
  const messages: ToolActivityMessage[] = [
    { event: 'tool_call', toolCallId: 'read', content: '', toolCall: { name: 'read', arguments: { path: 'a.ts' } } },
    call('send'),
    { content: 'Still working' },
    result('read', 'File contents'),
    result('send', 'Message sent to web:peer. Queued.'),
    result('orphan', 'Error: unmatched result'),
    { event: 'tool_call', content: '', toolCall: { name: 'exec', arguments: { command: 'pnpm test' } } },
  ]
  const actions = inlineMessageActions(messages, [])
  assert.deepEqual([...actions.entries.keys()], [1])
  assert.deepEqual([...actions.excluded], [1, 4])
  assert.equal(actions.entries.get(1)?.recipient, 'web:peer')
  const tools = [...groupToolActivity(messages, actions.excluded).values()].flatMap(batch => batch.entries)
  assert.deepEqual(tools.map(tool => tool.name), ['read', 'Tool', 'exec'])
  assert.equal(tools[0].result, 'File contents')
  assert.equal(tools[1].result, 'Error: unmatched result')
})

test('native, imported and legacy JSON message calls use the same special presentation', () => {
  const messages: ToolActivityMessage[] = [
    call('native'),
    { event: 'tool_call', toolCallId: 'wrapped', content: '', toolCall: {
      name: 'invoke_tool', arguments: { name: 'message', args: { sessionId: 'web:peer', content: 'Wrapped' } },
    } },
    { event: 'tool_call', content: 'message({"sessionId":"web:legacy","content":"Legacy"})' },
    { event: 'tool_result', content: 'Message sent to web:legacy. Queued.' },
  ]
  const actions = inlineMessageActions(messages, [])
  assert.equal(actions.entries.size, 3)
  assert.equal(actions.entries.get(1)?.content, 'Wrapped')
  assert.match(actions.entries.get(1)!.arguments, /"args"/)
  assert.equal(actions.entries.get(2)?.status, 'queued')
  assert.equal(actions.entries.get(2)?.sessionId, 'web:legacy')
})

test('pending, failed, empty and unexpected receipts do not claim successful delivery', () => {
  for (const [text, expected] of [
    [undefined, 'pending'], ['Error: target unavailable', 'failed'], ['Failed to send', 'failed'],
    ['', 'unknown'], ['Some other output', 'unknown'], ['Message sent to web:someone-else. Queued.', 'unknown'],
  ] as const) {
    const messages = [call('send')]
    if (text !== undefined) messages.push(result('send', text))
    const entry = inlineMessageActions(messages, []).entries.get(0)!
    assert.equal(entry.status, expected)
    assert.equal(entry.result, text)
  }
})

test('malformed and partial calls retain raw arguments and errors but never invent navigation targets', () => {
  for (const args of [{ content: 'Missing target' }, { sessionId: 42 }, { sessionId: 'invalid' }]) {
    const messages: ToolActivityMessage[] = [{
      event: 'tool_call', content: '', toolCall: { name: 'message', arguments: args },
    }, { event: 'tool_result', content: 'Error: invalid arguments' }]
    const entry = inlineMessageActions(messages, []).entries.get(0)!
    assert.equal(entry.sessionId, undefined)
    assert.equal(entry.status, 'failed')
    assert.equal(entry.arguments, JSON.stringify(args, null, 2))
  }
})

test('legacy calls without usable arguments remain inspectable and unrelated tools stay generic', () => {
  const messages: ToolActivityMessage[] = [
    { event: 'tool_call', content: 'message(not JSON)' },
    { event: 'tool_result', content: 'Legacy result' },
    { event: 'tool_call', content: '', toolCall: { name: 'send_email', arguments: { sessionId: 'web:peer' } } },
  ]
  const actions = inlineMessageActions(messages, [])
  assert.equal(actions.entries.size, 1)
  assert.equal(actions.entries.get(0)?.arguments, 'not JSON')
  assert.equal(actions.entries.get(0)?.status, 'unknown')
  assert.deepEqual([...actions.excluded], [0, 1])
})
