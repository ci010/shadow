import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeCommandResults } from './command-results.ts'
import { isCommandReceipt, type CommandReceipt } from '../../src/slash-commands/receipt.ts'
import { isUserMessage, resendableUserMessage } from './message-history.ts'

const receipt: CommandReceipt = {
  id: 'command-1', command: '/help', output: 'Command output only',
  timestamp: '2026-09-16T10:00:01Z', failed: false,
}

test('command receipts remain distinct, ordered and deduplicated across live and HTTP recovery', () => {
  const messages = [
    { role: 'user', content: 'Before', timestamp: '2026-09-16T10:00:00Z' },
    { role: 'assistant', content: 'After', timestamp: '2026-09-16T10:00:02Z' },
  ]
  const history = mergeCommandResults(messages, [receipt])
  assert.deepEqual(history.map(message => message.role), ['user', 'command', 'assistant'])
  assert.deepEqual(mergeCommandResults(history, [receipt, receipt]), history)
  assert.equal(history.filter(isUserMessage).length, 1)
  assert.equal(resendableUserMessage(history), undefined)
  assert.equal(resendableUserMessage(mergeCommandResults(messages.slice(0, 1), [receipt]))?.content, 'Before')
  assert.equal(resendableUserMessage(mergeCommandResults([], [receipt])), undefined)
})

test('command-only histories and legacy histories work without fabricating a model message', () => {
  assert.deepEqual(mergeCommandResults([], undefined), [])
  const [command] = mergeCommandResults([], [receipt])
  assert.equal(command.role, 'command')
  assert.equal(command.content, receipt.output)
  assert.equal(command.commandReceipt?.id, receipt.id)
})

test('commands do not reorder paired tool activity or untimestamped legacy messages', () => {
  const messages = [
    { role: 'user', content: 'Legacy message' },
    { role: 'assistant', content: 'call', event: 'tool_call' },
    { role: 'assistant', content: 'result', event: 'tool_result' },
    { role: 'assistant', content: 'After', timestamp: '2026-09-16T10:00:02Z' },
  ]
  const history = mergeCommandResults(messages, [receipt])
  assert.deepEqual(history.map(message => message.content), ['Legacy message', 'call', 'result', receipt.output, 'After'])
})

test('invalid command wire data fails visibly rather than becoming chat output', () => {
  for (const value of [null, {}, [{ ...receipt, timestamp: 'not-a-date' }], [{ ...receipt, command: 'hello' }], [{ ...receipt, failed: 'false' }]]) {
    assert.throws(() => mergeCommandResults([], value), /Invalid command history/)
  }
  assert.equal(isCommandReceipt({ ...receipt, id: '' }), false)
  assert.equal(isCommandReceipt({ ...receipt, output: {} }), false)
})
