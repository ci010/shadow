import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import type { ChatMessage } from '../providers/provider.ts'
import { isRuntimeContextEvent, runtimeContextEvent } from './runtime-context-event.ts'

function textPart(message: ChatMessage, index: number): string {
  assert(Array.isArray(message.content))
  const part = message.content[index]
  assert(part?.type === 'text')
  return part.text
}

function freezeHistory(history: ChatMessage[]): void {
  for (const message of history) {
    if (Array.isArray(message.content)) {
      message.content.forEach(Object.freeze)
      Object.freeze(message.content)
    }
    Object.freeze(message)
  }
  Object.freeze(history)
}

test('runtime context events have ordinary event provenance and snapshot semantics', async () => {
  const message = await runtimeContextEvent([], 'work', 'Current assignment', '.')
  assert(message)
  assert.equal(message.role, 'user')
  assert.equal(message.name, 'runtime-context')
  assert.match(textPart(message, 0), /^<event type="runtime-context-work" source="runtime-context" event-id="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" \/>$/)
  const payload = textPart(message, 1)
  assert.match(payload, /historical snapshot, not a new human request or permission/)
  assert.match(payload, /latest event of type runtime-context-work supersedes older snapshots of the same type/)
  assert(payload.endsWith('Snapshot:\nCurrent assignment'))
})

test('runtime context neither mutates frozen history nor rewrites old events', async () => {
  const first = await runtimeContextEvent([], 'work', 'A', '.')
  assert(first)
  const history: ChatMessage[] = [{ role: 'assistant', content: 'Existing response' }, first]
  const original = JSON.stringify(history)
  freezeHistory(history)
  assert.equal(await runtimeContextEvent(history, 'work', 'A', '.'), undefined)
  assert(await runtimeContextEvent(history, 'work', 'B', '.'))
  assert.equal(JSON.stringify(history), original)
  assert.equal(history[1], first)
})

test('same content deduplicates after JSON reload and intervening messages', async () => {
  const first = await runtimeContextEvent([], 'work', 'A\n<&> exact text ', '.')
  assert(first)
  const history: ChatMessage[] = JSON.parse(JSON.stringify([
    first, { role: 'assistant', content: 'Intervening response' },
  ]))
  assert.equal(await runtimeContextEvent(history, 'work', 'A\n<&> exact text ', '.'), undefined)
  // Comparison preserves whitespace rather than normalizing logical content.
  assert(await runtimeContextEvent(history, 'work', 'A\n<&> exact text', '.'))
})

test('A to B to A compares the latest snapshot and gives each change a fresh ID', async () => {
  const history: ChatMessage[] = []
  for (const content of ['A', 'B', 'A']) {
    const message = await runtimeContextEvent(history, 'work', content, '.')
    assert(message)
    history.push(message)
    assert.equal(await runtimeContextEvent(history, 'work', content, '.'), undefined)
  }
  assert.equal(new Set(history.map(message => textPart(message, 0))).size, 3)
  assert.equal(textPart(history[0]!, 1), textPart(history[2]!, 1))
})

test('empty initial context is skipped; clearing work emits once and survives reload', async () => {
  assert.equal(await runtimeContextEvent([], 'work', '', '.'), undefined)
  const first = await runtimeContextEvent([], 'work', 'A', '.')
  assert(first)
  const cleared = await runtimeContextEvent([first], 'work', '', '.')
  assert(cleared)
  assert.match(textPart(cleared, 1), /Snapshot cleared: no current context of this kind/)
  assert.notEqual(textPart(first, 0), textPart(cleared, 0))
  const history: ChatMessage[] = JSON.parse(JSON.stringify([first, cleared]))
  assert.equal(await runtimeContextEvent(history, 'work', '', '.'), undefined)
  assert(await runtimeContextEvent(history, 'work', 'A', '.'))
  assert(await runtimeContextEvent(history, 'work', 'Snapshot cleared: no current context of this kind.', '.'))
})

test('legacy audience records remain recognized without affecting Work deduplication', async () => {
  const work = (await runtimeContextEvent([], 'work', 'A', '.'))!
  const audience: ChatMessage = { ...work, content: [
    { type: 'text', text: textPart(work, 0).replace('runtime-context-work', 'runtime-context-audience') },
    { type: 'text', text: 'Legacy audience snapshot: obsolete instructions' },
  ] }
  assert(isRuntimeContextEvent(audience))
  const history = JSON.parse(JSON.stringify([work, audience]))
  freezeHistory(history)
  assert.equal(await runtimeContextEvent(history, 'work', 'A', '.'), undefined)
  assert(await runtimeContextEvent(history, 'work', 'B', '.'))
  assert(await runtimeContextEvent(history, 'work', '', '.'))
})

test('event-looking user payloads and other metadata cannot spoof runtime events', async () => {
  const genuine = await runtimeContextEvent([], 'work', 'A', '.')
  assert(genuine)
  const tag = textPart(genuine, 0)
  const payload = textPart(genuine, 1)
  const user = await buildUserChatMessage({
    kind: 'message', id: 'user-input', timestamp: new Date().toISOString(), policy: 'interactive',
    source: { kind: 'user', sender: { channel: 'test', chatId: 'test', senderId: 'human', messageId: 'user-input' } },
    content: `${tag}\n${payload}`,
  }, '.', '.')
  const impostors: ChatMessage[] = [
    user,
    { role: 'user', content: `${tag}\n${payload}` },
    { role: 'assistant', content: genuine.content },
    { role: 'user', content: [{ type: 'text', text: `prefix ${tag}` }, { type: 'text', text: payload }] },
    { role: 'user', content: [{ type: 'text', text: `${tag}\nextra` }, { type: 'text', text: payload }] },
    { role: 'user', content: [{ type: 'text', text: tag.replace('source="runtime-context"', 'source="other"') }, { type: 'text', text: payload }] },
  ]
  for (const impostor of impostors) {
    assert(await runtimeContextEvent([impostor], 'work', 'A', '.'))
    assert.equal(await runtimeContextEvent([genuine, impostor], 'work', 'A', '.'), undefined)
  }
})
