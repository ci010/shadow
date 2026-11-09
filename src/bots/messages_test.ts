import test from 'node:test'
import assert from 'node:assert/strict'
import { ChannelMessageStream } from '../channels/message-stream.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotMessages } from './messages.ts'
import type { BotHostScope } from './host-contract.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { MAX_JSON_BYTES } from '../script-runtime/json-boundary.ts'

const scope: BotHostScope = { projectId: 'p', botId: 'demo', bindingKey: 'one', revision: 'r1', sessionId: 'bound', address: { projectId: 'p', platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one' } }
const context = (signal = new AbortController().signal) => ({ projectId: 'p', sessionId: 'bound', signal }) as ExecutionContext

test('incremental Bot messages reuse fixed-range watermark batches; retries/restart/late edits do not skip or cross bindings', async () => {
  await withTempWorkspace(async workspace => {
    const stream = new ChannelMessageStream(workspace, 'p')
    const append = (message: string, conversation = 'group:one', kind = 'created' as 'created' | 'updated') => stream.append({ connection: 'connection', platform: 'qq', conversation, kind, message, content: message })
    append('one'); append('private-other', 'group:two'); append('two')
    let allowed = true, reader = new BotMessages(workspace, 'p', () => { if (!allowed) throw new Error('revoked') })
    const call = (input: Record<string, unknown>, ctx = context()) => reader.execute(scope, input, ctx) as Promise<any>
    const first = await call({ action: 'read', limit: 1, attempt: 'a1' })
    assert.deepEqual(first.events.map((event: any) => event.message), ['one'])
    assert.equal(first.batch.state, 'running')
    append('three')
    reader = new BotMessages(workspace, 'p', () => { if (!allowed) throw new Error('revoked') })
    const replay = await call({ action: 'read', limit: 100 })
    assert.equal(replay.batch.id, first.batch.id)
    assert.deepEqual(replay.events, first.events)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(call({ action: 'ack', batch: first.batch.id, attempt: 'a1' }, context(cancelled.signal)), /abort/i)
    await call({ action: 'retry', batch: first.batch.id, attempt: 'a1', error: 'cancelled processing' })
    await call({ action: 'read', attempt: 'a2' })
    await assert.rejects(call({ action: 'ack', batch: first.batch.id, attempt: 'a1' }), /attempt/i)
    await call({ action: 'ack', batch: first.batch.id, attempt: 'a2' })
    const next = await call({ action: 'read', attempt: 'a3' })
    assert.deepEqual(next.events.map((event: any) => event.message), ['two', 'three'])
    await call({ action: 'ack', batch: next.batch.id, attempt: 'a3' })
    append('one', 'group:one', 'updated')
    assert.deepEqual((await call({ action: 'read' })).events.map((event: any) => event.kind), ['updated'])
    for (const selector of ['consumer', 'connection', 'conversation', 'conversations', 'includeChildren', 'initialAfter']) await assert.rejects(call({ action: 'read', [selector]: 'other' }))
    await assert.rejects(reader.execute({ ...scope, bindingKey: 'two' }, { action: 'ack', batch: first.batch.id, attempt: 'a2' }, context()), /Unknown/)
    allowed = false
    await assert.rejects(call({ action: 'read' }), /revoked/)
  })
})

test('Bot message byte-bounded pages preserve unread data and explicitly fail retention gaps', async () => {
  await withTempWorkspace(async workspace => {
    const stream = new ChannelMessageStream(workspace, 'p')
    for (let i = 0; i < 10; i++) stream.append({ connection: 'connection', platform: 'qq', conversation: 'group:one', kind: 'created', message: String(i), content: '\u0000'.repeat(32000) })
    const reader = new BotMessages(workspace, 'p', () => {})
    const page = await reader.execute(scope, { action: 'read', limit: 100, attempt: 'one' }, context()) as any
    assert.equal(page.events.length, 1)
    assert.equal(page.hasMore, true)
    assert(Buffer.byteLength(JSON.stringify(page)) < MAX_JSON_BYTES)
    await reader.execute(scope, { action: 'ack', batch: page.batch.id, attempt: 'one' }, context())
    const next = await reader.execute(scope, { action: 'read' }, context()) as any
    assert.equal(next.events[0].message, '1')
    const tiny = new ChannelMessageStream(workspace, 'p', 1)
    tiny.append({ connection: 'connection', platform: 'qq', conversation: 'group:one', kind: 'created', message: 'new' })
    await assert.rejects(reader.execute(scope, { action: 'read' }, context()), /expired|retention gap/)
  })
})
