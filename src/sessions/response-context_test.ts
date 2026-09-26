import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { withResponseAudience } from '../agent/context/response-audience.ts'
import type { ChatMessage } from '../providers/provider.ts'
import type { InputSource } from './input.ts'
import { createResponseContext, isBackgroundResponse, parseResponseContext } from './response-context.ts'

const user: InputSource = { kind: 'user', sender: { channel: 'web', chatId: 'owner', senderId: 'owner', messageId: 'input' } }
const event: InputSource = { kind: 'event', eventId: 'event', type: 'subagent-failed', source: 'worker',
  origin: { sessionId: 'web:owner', inputId: 'old-user-request', source: user }, attributes: { privateDetail: 'not for display' } }

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: response provenance survives reopening without new log records or rewriting legacy messages`, async () => {
    const directory = await createTempWorkspace()
    const context = createResponseContext('turn', event, 'session', 'web')!
    const writer: SessionStore = new Store(directory)
    let reader: SessionStore | undefined
    try {
      try {
        await writer.init()
        await writer.appendMessages('fixture-0', [
          { role: 'assistant', content: 'Legacy reply', timestamp: '2026-01-01T00:00:00Z' },
          { role: 'assistant', content: 'New reply', timestamp: '2026-01-01T00:00:01Z', responseContext: context },
        ])
      } finally { writer.close?.() }
      reader = new Store(directory)
      await reader.init()
      const records = await Array.fromAsync(reader.readSessionLog('fixture-0'))
      assert.equal(records.length, 2)
      assert.equal(await reader.countSessionLog('fixture-0'), 2)
      assert.equal(records[0].responseContext, undefined)
      assert.deepEqual(parseResponseContext(records[1].responseContext), context)
      assert.deepEqual(records.map(record => record.content), ['Legacy reply', 'New reply'])
    } finally {
      reader?.close?.()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('response context is a small runtime projection, not historical user involvement or authority', () => {
  const context = createResponseContext('turn', event, 'session', 'web')!
  assert.deepEqual(context, { version: 1, turnId: 'turn', responseId: 'turn:0', userInvolved: false,
    source: { kind: 'event', eventId: 'event', type: 'subagent-failed', source: 'worker', status: 'failed' } })
  assert(isBackgroundResponse(context))
  assert(!isBackgroundResponse({ ...context, userInvolved: true }))
  assert(!isBackgroundResponse(createResponseContext('turn', user, 'session', 'web')))
  assert(!isBackgroundResponse(undefined))
  assert.deepEqual(parseResponseContext(context), context)
})

test('legacy and malformed response metadata remain visible with a diagnostic for malformed data', t => {
  const warnings = t.mock.method(console, 'warn', () => {})
  assert.equal(parseResponseContext(undefined), undefined)
  assert.equal(warnings.mock.calls.length, 0)
  const context = createResponseContext('turn', event, 'session', 'web')!
  for (const invalid of [null, {}, { ...context, version: 2 }, { ...context, userInvolved: 'false' },
    { ...context, source: { kind: 'user' } }, { ...context, source: { kind: 'session', sessionId: '' } }]) {
    assert.equal(parseResponseContext(invalid), undefined)
  }
  assert.equal(warnings.mock.calls.length, 6)
})

test('task/call, legacy unknown modes and A2A retain their existing prompts and result contracts', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'Return the complete caller result' }]
  for (const mode of ['task', 'call', undefined] as const) {
    const context = createResponseContext('turn', event, mode, 'web')
    assert.equal(context, undefined)
    assert.equal(withResponseAudience(messages, context), messages)
  }
  assert.equal(createResponseContext('turn', user, 'session', 'a2a'), undefined)
  assert.equal(createResponseContext('turn', { kind: 'user', sender: { ...user.sender, channel: 'a2a' } }, 'session', 'system'), undefined)
})

test('per-inference audience guidance neither mutates reusable prompts nor accumulates across turns', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'Reusable role and work constraints' }]
  const background = createResponseContext('event-turn', event, 'session', 'web')!
  const first = withResponseAudience(messages, background)
  assert.match(String(first[0].content), /no user input admitted/)
  assert.match(String(first[0].content), /not as a new user request/)
  const mixed = withResponseAudience(messages, { ...background, userInvolved: true })
  assert.match(String(mixed[0].content), /Answer the user's request normally/)
  assert.doesNotMatch(String(mixed[0].content), /no user input admitted/)
  assert.equal(messages[0].content, 'Reusable role and work constraints')
  assert.equal(mixed.filter(message => message.role === 'system').length, 1)
})
