import test from 'node:test'
import assert from 'node:assert/strict'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotSend } from './send.ts'
import type { BotHostScope } from './host-contract.ts'
import type { ExecutionContext } from '../tools/context.ts'

const scope: BotHostScope = { projectId: 'p', botId: 'demo', bindingKey: 'binding', revision: 'r1', sessionId: 'bound', address: { projectId: 'p', botInstanceId: 'connection', platform: 'discord', conversationId: '123' } }
const context = (signal = new AbortController().signal) => ({ projectId: 'p', sessionId: 'bound', signal }) as ExecutionContext

test('explicit BOT send pins original group and reuses durable receipt; authorization precedes retries', async () => {
  await withTempWorkspace(async workspace => {
    let sent = 0, permitted = true
    const deps = { assertCurrent: () => { if (!permitted) throw new Error('revoked') }, assertConnection: (connection: string, conversation?: string) => { assert.equal(connection, 'connection'); assert.equal(conversation, '123') },
      send: async (connection: string, conversation: string, content: string, nonce: string) => { assert.equal(connection, 'connection'); assert.equal(conversation, '123'); assert.equal(content, 'hello'); assert.match(nonce, /^\d+$/); sent++; return { id: '456' } } }
    let sender = new BotSend(workspace, 'p', deps)
    const input = { content: 'hello', idempotencyKey: 'one' }
    assert.deepEqual(await sender.execute(scope, input, context()), { id: '456' })
    sender = new BotSend(workspace, 'p', deps)
    assert.deepEqual(await sender.execute(scope, input, context()), { id: '456' })
    assert.equal(sent, 1)
    await assert.rejects(sender.execute(scope, { ...input, content: 'changed' }, context()), /different content/)
    for (const selector of ['destination', 'connection', 'conversation', 'sessionId', 'replyTo']) await assert.rejects(sender.execute(scope, { ...input, [selector]: 'other' }, context()))
    for (const platform of ['qq', 'feishu'] as const) await assert.rejects(sender.execute({ ...scope, address: { ...scope.address, platform } }, input, context()), /not supported/)
    await assert.rejects(sender.execute({ ...scope, projectId: 'other' }, input, context()), /scope/)
    await assert.rejects(sender.execute({ ...scope, sessionId: 'other' }, input, context()), /scope/)
    permitted = false
    await assert.rejects(sender.execute(scope, input, context()), /revoked/)
    assert.equal(sent, 1)
  })
})

test('failed and cancelled explicit sends never silently retry uncertain writes', async () => {
  await withTempWorkspace(async workspace => {
    let sent = 0
    const controller = new AbortController()
    const sender = new BotSend(workspace, 'p', { assertCurrent: () => {}, assertConnection: () => {}, send: async () => { sent++; controller.abort(); throw new Error('platform reply lost') } })
    const input = { content: 'hello', idempotencyKey: 'one' }
    await assert.rejects(sender.execute(scope, input, context(controller.signal)), /platform reply lost/)
    assert.equal(sent, 1)
    await assert.rejects(sender.execute(scope, input, context()), /uncertain/)
    assert.equal(sent, 1)
    await assert.rejects(sender.execute(scope, { ...input, idempotencyKey: 'two' }, context(controller.signal)), /abort/i)
    assert.equal(sent, 1)
  })
})

test('platform permission denial is explicit, produces no send and leaves no success receipt', async () => {
  await withTempWorkspace(async workspace => {
    let sent = 0
    const sender = new BotSend(workspace, 'p', { assertCurrent: () => {}, assertConnection: () => { throw new Error('platform permission denied') }, send: async () => { sent++; return null } })
    await assert.rejects(sender.execute(scope, { content: 'hello', idempotencyKey: 'one' }, context()), /permission denied/)
    assert.equal(sent, 0)
  })
})

for (const platform of ['qq', 'feishu'] as const) test(`${platform} explicit SDK send uses bound receipt adapter and existing durable send ledger`, async () => {
  await withTempWorkspace(async workspace => {
    const bound = { ...scope, address: { ...scope.address, platform, conversationId: platform === 'qq' ? 'group:one' : 'oc_one' } }
    let sent = 0
    const sender = new BotSend(workspace, 'p', {
      assertCurrent: () => {}, assertConnection: (connection, conversation) => { assert.equal(connection, bound.address.botInstanceId); assert.equal(conversation, bound.address.conversationId) },
      send: async () => { throw new Error('Must not call Discord transport') },
      sendBotText: async (address, content, signal) => { assert.deepEqual(address, bound.address); assert.equal(content, 'hello'); signal.throwIfAborted(); sent++; return { id: 'real-platform-receipt' } },
    })
    const input = { content: 'hello', idempotencyKey: 'one' }
    assert.deepEqual(await sender.execute(bound, input, context()), { id: 'real-platform-receipt' })
    assert.deepEqual(await sender.execute(bound, input, context()), { id: 'real-platform-receipt' })
    assert.equal(sent, 1)
    await assert.rejects(sender.execute(bound, { ...input, destination: 'other' }, context()))
    assert.equal(sent, 1)
  })
})
