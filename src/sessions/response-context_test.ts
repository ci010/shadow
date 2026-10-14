import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { SESSION_RESPONSE_GUIDANCE } from '../agent/context/response-audience.ts'
import { runtimeContextEvent } from './runtime-context-event.ts'
import type { ChatMessage } from '../providers/provider.ts'
import type { InputSource } from './input.ts'
import { continuedUserInvolvement, createResponseContext, hasNoAdmittedUserInput, parseResponseContext, reconcileResponseContinuity } from './response-context.ts'

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
  assert(hasNoAdmittedUserInput(context))
  assert(!hasNoAdmittedUserInput({ ...context, userInvolved: true }))
  assert(!hasNoAdmittedUserInput(createResponseContext('turn', user, 'session', 'web')))
  assert(!hasNoAdmittedUserInput(undefined))
  assert.deepEqual(parseResponseContext(context), context)
})

test('unfinished user tool loops retain their audience across event turns, ending at the final answer', () => {
  const foreground = createResponseContext('user-turn', user, 'session', 'web')!
  const background = createResponseContext('event-turn', event, 'session', 'web')!
  const tool_calls: ChatMessage['tool_calls'] = [{
    id: 'read', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.ts"}' },
  }]
  const messages: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls, responseContext: foreground },
    { role: 'tool', content: 'Source', tool_call_id: 'read' },
    { role: 'user', content: '<event type="subagent-complete" />' },
    { role: 'assistant', content: 'Continue fixing', tool_calls, responseContext: background },
    { role: 'tool', content: 'Fixed', tool_call_id: 'read' },
    { role: 'assistant', content: 'User-facing result', responseContext: { ...background, responseId: 'event-turn:1' } },
    { role: 'assistant', content: 'Independent background acknowledgement',
      responseContext: createResponseContext('later', event, 'session', 'web') },
  ]
  const original = structuredClone(messages)
  const repaired = reconcileResponseContinuity(messages)
  assert.deepEqual(messages, original)
  assert.deepEqual(repaired.messages.filter(message => message.role === 'assistant')
    .map(message => hasNoAdmittedUserInput(message.responseContext)), [false, false, false, true])
  assert.equal(repaired.messages[3].responseContext?.source, background.source)
  assert.equal(repaired.messages[5].responseContext?.responseId, 'event-turn:1')
  assert.equal(repaired.unfinishedUserResponse, false)
  assert(reconcileResponseContinuity(messages.slice(0, 5)).unfinishedUserResponse)
  assert.deepEqual(reconcileResponseContinuity(repaired.messages), repaired)
  assert.deepEqual(reconcileResponseContinuity(messages.slice(2)).messages, messages.slice(2))
  assert.equal(reconcileResponseContinuity([
    { role: 'assistant', content: 'Already answered', responseContext: foreground },
    messages[3],
  ]).messages[1].responseContext?.userInvolved, false)
})

test('continuation finds the unfinished input audience without mistaking old user turns for current ones', () => {
  const direct = { role: 'user' as const, content: [
    { type: 'text' as const, text: '<sender id="owner" name="owner" chat="direct" />' },
    { type: 'text' as const, text: 'Original request' },
  ] }
  const background = { role: 'user' as const, content: [
    { type: 'text' as const, text: '<event type="fixture" source="system" event-id="event" />' },
    { type: 'text' as const, text: '<sender id="owner" name="owner" chat="direct" />' },
  ] }
  assert(continuedUserInvolvement([direct, { role: 'tool', content: 'Completed' }]))
  assert(continuedUserInvolvement([{ role: 'user', content: [
    { type: 'text', text: '<sender id="member" name="Alice" chat="group" platform-role="owner" platform-source="session" />' },
    { type: 'text', text: 'Original request' },
  ] }]))
  assert(!continuedUserInvolvement([{ role: 'user', content: [
    { type: 'text', text: '<sender id="peer" name="Agent" chat="group" source="session" />' },
    { type: 'text', text: 'Background report' },
  ] }]))
  assert(continuedUserInvolvement([direct, { role: 'assistant', content: 'Rechecking',
    responseContext: createResponseContext('turn', user, 'session', 'web') },
  { role: 'user', name: '__work_realignment__', content: 'Work changed' }]))
  assert(!continuedUserInvolvement([direct, { role: 'assistant', content: 'Finished' }, background]))
  assert(!continuedUserInvolvement([background, { role: 'assistant', content: 'Working',
    responseContext: createResponseContext('event-turn', event, 'session', 'web') }]))
  assert(continuedUserInvolvement([background, { role: 'assistant', content: 'Working',
    responseContext: { ...createResponseContext('event-turn', event, 'session', 'web')!, userInvolved: true } }]))
  assert(!continuedUserInvolvement([{ role: 'user', content: 'Legacy text without provenance' }]))
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
  for (const mode of ['task', 'call', undefined] as const) {
    const context = createResponseContext('turn', event, mode, 'web')
    assert.equal(context, undefined)
  }
  assert.equal(createResponseContext('turn', user, 'session', 'a2a'), undefined)
  assert.equal(createResponseContext('turn', { kind: 'user', sender: { ...user.sender, channel: 'a2a' } }, 'session', 'system'), undefined)
})

test('session delivery guidance is static and allows substantive asynchronous answers', () => {
  assert.match(SESSION_RESPONSE_GUIDANCE, /not as a new user request/)
  assert.match(SESSION_RESPONSE_GUIDANCE, /including\n?asynchronous work/)
  assert.match(SESSION_RESPONSE_GUIDANCE, /return no user-facing text/)
  assert.match(SESSION_RESPONSE_GUIDANCE, /pending request/)
})

test('persisted context events do not hide user continuity when interrupted before the first response', async () => {
  const input: ChatMessage = { role: 'user', content: [{ type: 'text', text: '<sender id="owner" name="owner" chat="direct" />' }, { type: 'text', text: 'Task' }] }
  const history = [input]
  history.push((await runtimeContextEvent(history, 'work', 'Work A', '.'))!)
  history.push({ role: 'user', name: 'runtime-context', content: [
    { type: 'text', text: '<event type="runtime-context-audience" source="runtime-context" event-id="12345678-1234-4123-8123-123456789abc" />' },
    { type: 'text', text: 'Legacy audience snapshot' },
  ] })
  assert(continuedUserInvolvement(history))
  assert(continuedUserInvolvement(JSON.parse(JSON.stringify(history))))
})
