import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { YieldManager } from '../sessions/yield.ts'
import { parseYieldQuestion, type YieldRequest } from '../sessions/yield-contract.ts'
import { decisionBrief } from '../testing/decision.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { QQChannel } from './qq.ts'
import { QQDeliveryError } from './qq-replies.ts'
import { inputContext, type SessionMessageInput } from '../sessions/input.ts'

const NOW = Date.parse('2026-09-18T04:00:00.000Z')
const options = { appId: 'synthetic-app', secret: 'synthetic-secret' }
type RequestRecord = { path: string; body: Record<string, unknown> }

function transport(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const requests: RequestRecord[] = []
  let reply: (() => Response | Promise<Response>) | undefined
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === 'bots.qq.com') return Response.json({ access_token: 'synthetic-token', expires_in: 7200 })
    if (init?.method === 'PUT') return new Response(null, { status: 200 })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/upload_prepare')) return Response.json({
      upload_id: 'upload', block_size: 1024, parts: [{ index: 0, presigned_url: 'https://upload.example.test/part' }],
    })
    if (url.pathname.endsWith('/files')) return Response.json({ file_info: 'file' })
    if (url.pathname.endsWith('/messages') && reply) return reply()
    return Response.json({ id: `sent-${requests.length}` })
  })
  return {
    requests,
    messages: () => requests.filter(request => request.path.endsWith('/messages')),
    fail: (fn: () => Response | Promise<Response>) => { reply = fn },
  }
}

function channel(bus = new Bus(), overrides = {}) {
  const result = new QQChannel(bus, { ...options, ...overrides })
  result.setReceiver(async message => ({ status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }))
  return result
}

async function incoming(qq: QQChannel, chatId = 'group:one', id = 'source', timestamp: unknown = new Date().toISOString()) {
  const group = chatId.startsWith('group:')
  await (qq as unknown as {
    handleDispatch(event: string, data: Record<string, unknown>): Promise<void>
  }).handleDispatch(group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', {
    id, timestamp, content: 'Hello', group_openid: chatId.slice(6),
    author: group ? { member_openid: 'alice' } : { user_openid: chatId.slice(4) },
  })
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { channel: 'qq', chatId: 'group:one', replyTo: 'source', content: 'Summary', event: 'response', done: true, ...overrides }
}

test('QQ filters raw tools/progress only at delivery, preserving final errors and separate decisions', async t => {
  const wire = transport(t)
  const bus = new Bus()
  const qq = channel(bus)
  await incoming(qq)
  const observed: OutboundMessage[] = []
  bus.on('message.outbound', msg => { observed.push(msg) })
  const messages = [
    message({ event: 'tool_call', content: 'read', done: false }),
    message({ event: 'tool_result', content: 'xmcl_issues', done: false }),
    message({ content: 'Looking into it', done: false }),
    message(),
    message({ content: '⚠️ Request failed: provider unavailable' }),
  ]
  qq.acceptToolResults = true
  for (const msg of messages) { bus.emit('message.outbound', msg); await qq.onMessage(msg) }
  await qq.presentDecisionText('group:one', 'Choose 1 or 2', 'source')
  assert.deepEqual(observed, messages)
  assert.deepEqual(wire.messages().map(request => request.body.markdown), [
    { content: 'Summary' }, { content: '⚠️ Request failed: provider unavailable' }, { content: 'Choose 1 or 2' },
  ])
  await qq.onMessage(message({ content: '', done: true }))
  assert.equal(wire.messages().length, 3)
})

for (const [chatId, allowance] of [['group:one', 5], ['c2c:alice', 4]] as const) {
  test(`QQ ${chatId} serializes concurrent sends within ${allowance} shared slots`, async t => {
    const wire = transport(t)
    const qq = channel()
    await incoming(qq, chatId)
    const outcomes = await Promise.allSettled(Array.from({ length: allowance + 2 }, () => qq.send(message({ chatId }))))
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, allowance)
    assert.equal(wire.messages().length, allowance)
    assert.deepEqual(wire.messages().map(request => request.body.msg_seq), Array.from({ length: allowance }, (_, i) => i + 1))
    assert.ok(wire.messages().every(request => request.body.msg_id === 'source'))
    for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.kind, 'quota')
  })
}

test('QQ never borrows a recent unrelated source, and expires at five minutes', async t => {
  const wire = transport(t)
  const qq = channel()
  await incoming(qq)
  t.mock.timers.tick(60_000)
  await incoming(qq, 'group:one', 'unrelated')
  await qq.send(message())
  assert.equal(wire.messages()[0].body.msg_id, 'source')
  await assert.rejects(qq.send(message({ replyTo: '' })), { kind: 'invalid_source' })
  await assert.rejects(qq.send(message({ replyTo: 'unobserved' })), { kind: 'invalid_source' })
  t.mock.timers.tick(240_000)
  await assert.rejects(qq.send(message()), { kind: 'expired' })
  await qq.send(message({ replyTo: 'unrelated' }))
  assert.equal(wire.messages().length, 2)
})

test('QQ source and sequence tracking is isolated by chat and channel instance; redelivery does not reset it', async t => {
  const wire = transport(t)
  const first = channel()
  const second = channel()
  for (const qq of [first, second]) {
    await incoming(qq)
    await incoming(qq, 'group:two')
    await qq.send(message())
    await qq.send(message({ chatId: 'group:two' }))
  }
  await incoming(first)
  await first.send(message())
  assert.deepEqual(wire.messages().map(request => request.body.msg_seq), [1, 1, 1, 1, 2])
})

for (const markdown of [true, false]) {
  test(`QQ proactive group replies omit passive credentials (${markdown ? 'Markdown' : 'text'})`, async t => {
    const wire = transport(t)
    const qq = channel(new Bus(), { markdown })
    await incoming(qq, 'group:one', 'unrelated')
    const outbound = message({ replyTo: undefined })
    await qq.onMessage({ ...outbound, done: false })
    await qq.onMessage({ ...outbound, event: 'tool_result' })
    assert.equal(wire.messages().length, 0)
    await qq.onMessage(outbound)
    assert.deepEqual(wire.messages(), [{
      path: '/v2/groups/one/messages',
      body: markdown ? { msg_type: 2, markdown: { content: 'Summary' } } : { msg_type: 0, content: 'Summary' },
    }])
    await qq.send(message({ replyTo: 'unrelated' }))
    assert.equal(wire.messages()[1].body.msg_seq, 1)
    await assert.rejects(qq.send(message({ chatId: 'c2c:alice', replyTo: undefined })), { kind: 'invalid_source' })
  })
}

test('QQ proactive group media uploads once and sends without passive credentials', async t => {
  const wire = transport(t)
  await withTempWorkspace(async workspace => {
    const dir = sessionWorkspacePath(workspace, 'qq:group:one')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'report.txt'), 'synthetic report')
    const qq = channel(new Bus(), { workspace })
    await qq.onMessage(message({ replyTo: undefined, media: ['report.txt'] }))
    assert.deepEqual(wire.messages().map(request => request.body), [
      { msg_type: 2, markdown: { content: 'Summary' } },
      { msg_type: 7, media: { file_info: 'file' } },
    ])
    assert.equal(wire.requests.filter(request => request.path.endsWith('/upload_prepare')).length, 1)
  })
})

for (const [name, failure, kind] of [
  ['permission', () => Response.json({ code: 40034105, message: 'secret' }, { status: 403 }), 'permission'],
  ['rate', () => Response.json({ code: 40034100, message: 'secret' }, { status: 429 }), 'rate'],
  ['network', () => { throw new Error('secret') }, 'unknown'],
] as const) {
  test(`QQ proactive ${name} failure is surfaced without format fallback or retry`, async t => {
    const wire = transport(t)
    wire.fail(failure)
    const qq = channel()
    await assert.rejects(qq.onMessage(message({ replyTo: undefined })), (error: unknown) => {
      assert.ok(error instanceof QQDeliveryError)
      assert.equal(error.kind, kind)
      assert.doesNotMatch(error.message, /secret/)
      return true
    })
    assert.equal(wire.messages().length, 1)
    assert.equal(wire.messages()[0].body.msg_id, undefined)
  })
}

test('QQ rejected admission, missing/old timestamps, stop, and pre-restart replay cannot mint allowances', async t => {
  const wire = transport(t)
  const qq = channel()
  qq.setReceiver(async () => { throw new Error('denied') })
  await assert.rejects(incoming(qq), /denied/)
  await assert.rejects(qq.send(message()), { kind: 'invalid_source' })
  const other = channel()
  await incoming(other, 'group:one', 'missing', null)
  await incoming(other, 'group:one', 'old', new Date(NOW - 1).toISOString())
  for (const replyTo of ['missing', 'old']) await assert.rejects(other.send(message({ replyTo })), { kind: 'invalid_source' })
  await incoming(other)
  await other.stop()
  await assert.rejects(other.send(message()), { kind: 'invalid_source' })
  t.mock.timers.tick(1)
  const restarted = channel()
  await incoming(restarted, 'group:one', 'source', new Date(NOW).toISOString())
  await assert.rejects(restarted.send(message()), { kind: 'invalid_source' })
  assert.equal(wire.messages().length, 0)
})

test('QQ delivery waits for accepted admission, not just a gateway observation', async t => {
  const wire = transport(t)
  const qq = channel()
  let accept!: () => void
  const gate = new Promise<void>(resolve => { accept = resolve })
  qq.setReceiver(async message => {
    await gate
    return { status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }
  })
  const admission = incoming(qq)
  await new Promise(resolve => setImmediate(resolve))
  const sending = qq.send(message())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(wire.messages().length, 0)
  accept()
  await Promise.all([admission, sending])
  assert.equal(wire.messages().length, 1)
})

test('QQ tracking stays bounded without evicting live allowances or renewing replayed sources', async t => {
  const wire = transport(t)
  const qq = channel()
  await incoming(qq)
  await qq.send(message())
  for (let i = 1; i < 500; i++) await incoming(qq, 'group:one', `source-${i}`)
  await incoming(qq, 'group:one', 'overflow')
  await assert.rejects(qq.send(message({ replyTo: 'overflow' })), { kind: 'invalid_source' })
  // The gateway's small dedup ring has rolled over, but the reply ledger has not.
  await incoming(qq)
  await qq.send(message())
  assert.deepEqual(wire.messages().map(request => request.body.msg_seq), [1, 2])
  t.mock.timers.tick(300_000)
  await incoming(qq, 'group:one', 'fresh')
  await qq.send(message({ replyTo: 'fresh' }))
  await incoming(qq, 'group:one', 'source-1', new Date(NOW).toISOString())
  await assert.rejects(qq.send(message({ replyTo: 'source-1' })), { kind: 'invalid_source' })
})

test('QQ transient reconnect retains budget and invalidates old connection delivery', async t => {
  const wire = transport(t)
  class ReconnectingQQ extends QQChannel {
    reconnect() { this.setAccepting(false); this.setAccepting(true) }
  }
  const qq = new ReconnectingQQ(new Bus(), options)
  qq.setReceiver(async msg => ({ status: 'accepted', sessionId: `qq:${msg.chatId}`, inputId: msg.messageId }))
  await incoming(qq)
  await qq.send(message())
  const guard = qq.connectionGuard()
  qq.reconnect()
  assert.throws(guard, /connection has changed/)
  await incoming(qq)
  await qq.send(message())
  assert.deepEqual(wire.messages().map(request => request.body.msg_seq), [1, 2])
})

test('QQ queued requests recheck expiry after the previous request finishes', async t => {
  const wire = transport(t)
  const qq = channel()
  await incoming(qq)
  let finish!: (response: Response) => void
  wire.fail(() => new Promise<Response>(resolve => { finish = resolve }))
  const first = qq.send(message())
  await new Promise(resolve => setImmediate(resolve))
  const second = qq.send(message())
  const rejected = assert.rejects(second, { kind: 'expired' })
  t.mock.timers.tick(300_000)
  finish(Response.json({ id: 'first' }))
  await Promise.all([first, rejected])
  assert.equal(wire.messages().length, 1)
})

for (const [code, kind] of [
  [304103, 'expired'], [40034005, 'expired'], [40034128, 'quota'],
  [40054005, 'duplicate'], [40034024, 'invalid_source'], [40034100, 'rate'], [40034105, 'permission'],
] as const) {
  test(`QQ classifies ${code} and never retries Markdown as plain or drops msg_id`, async t => {
    const wire = transport(t)
    const qq = channel()
    await incoming(qq)
    wire.fail(() => Response.json({ code, message: 'secret-response', token: 'secret-token' }, { status: 400 }))
    await assert.rejects(qq.send(message()), (error: unknown) => {
      assert.ok(error instanceof QQDeliveryError)
      assert.equal(error.kind, kind)
      assert.equal(error.outcome, 'rejected')
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /secret/)
      return true
    })
    await assert.rejects(qq.send(message()), { kind: 'unknown' })
    assert.equal(wire.messages().length, 1)
    assert.equal(wire.messages()[0].body.msg_id, 'source')
    assert.equal(wire.messages()[0].body.msg_type, 2)
  })
}

for (const [name, failure] of [
  ['network', () => { throw new Error('secret URL or credential') }],
  ['server', () => Response.json({ code: 999999, message: 'secret body' }, { status: 503 })],
  ['malformed acknowledgement', () => Response.json({ message: 'secret body' })],
] as const) {
  test(`QQ ${name} outcome is unknown, reserves the sequence and prevents duplicate retries`, async t => {
    const wire = transport(t)
    const qq = channel()
    await incoming(qq)
    wire.fail(failure)
    await assert.rejects(qq.send(message()), { kind: 'unknown', outcome: 'unknown' })
    await assert.rejects(qq.send(message()), { kind: 'unknown', outcome: 'unknown' })
    assert.equal(wire.messages().length, 1)
  })
}

test('QQ text and media share budget; reject an oversized bundle before any partial delivery', async t => {
  const wire = transport(t)
  await withTempWorkspace(async workspace => {
    const dir = sessionWorkspacePath(workspace, 'qq:group:one')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'report.txt'), 'synthetic report')
    const qq = channel(new Bus(), { workspace, markdown: false })
    await incoming(qq)
    assert.equal(await qq.send(message({ content: '', media: ['report.txt'] })), 'sent-4')
    await qq.send(message({ media: ['report.txt'] }))
    assert.deepEqual(wire.messages().map(request => [request.body.msg_type, request.body.msg_seq]), [[7, 1], [0, 2], [7, 3]])
    const before = wire.requests.length
    await assert.rejects(qq.send(message({ media: ['report.txt', 'report.txt'] })), { kind: 'quota' })
    assert.equal(wire.requests.length, before)
    await qq.send(message())
    await qq.send(message())
    await assert.rejects(qq.send(message()), { kind: 'quota' })
  })
})

test('QQ guild progress and legacy Markdown rejection fallback remain independent of passive policy', async t => {
  const wire = transport(t)
  const qq = channel()
  wire.fail(() => wire.messages().length === 1
    ? Response.json({ code: 99999 }, { status: 400 }) : Response.json({ id: 'plain' }))
  await qq.onMessage(message({ chatId: 'channel:guild', event: 'tool_call', done: false, content: 'read' }))
  assert.equal(wire.messages().length, 2)
  assert.equal(wire.messages()[1].body.content, 'read')
})

test('QQ media upload time cannot extend the message deadline', async t => {
  const wire = transport(t)
  await withTempWorkspace(async workspace => {
    const dir = sessionWorkspacePath(workspace, 'qq:group:one')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'report.txt'), 'synthetic report')
    const qq = channel(new Bus(), { workspace })
    await incoming(qq)
    const fetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init)
      if (String(input).endsWith('/files')) t.mock.timers.tick(300_000)
      return response
    })
    await assert.rejects(qq.send(message({ content: '', media: ['report.txt'] })), { kind: 'expired' })
    assert.equal(wire.messages().length, 0)
  })
})

test('QQ manager routes decisions with their source and emits delivery failure for explicit rejection', async t => {
  const wire = transport(t)
  await withTempWorkspace(async workspace => {
    const bus = new Bus()
    const store = new BotInstanceStore({ projectId: 'project', path: join(workspace, 'bots.json') })
    const bot = store.create('qq', 'QQ', { ...options, enabled: true })
    class ReadyQQ extends QQChannel {
      override async start() { this.reportState('connected') }
    }
    const qq = new ReadyQQ(bus, options)
    const request = {
      id: 'decision', sessionId: '', recipient: { kind: 'user' as const, sessionId: '' },
      question: 'Proceed?', options: ['Yes', 'No'] as [string, string], defaultOption: 'No',
      createdAt: new Date().toISOString(), deadline: null,
    }
    const { channelSessionId } = await import('../bus/events.ts')
    const address = { projectId: 'project', botInstanceId: bot.id, platform: 'qq', conversationId: 'group:one' }
    request.sessionId = request.recipient.sessionId = channelSessionId(address)
    const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, {
      yields: { get: () => request }, getActiveSession: () => undefined,
    } as unknown as SessionManager, async msg => ({
      status: 'accepted', sessionId: request.sessionId, inputId: msg.messageId,
    }), { projectId: 'project', instanceStore: store, factory: () => qq })
    await manager.init()
    await manager.startAll(new Hono())
    try {
      await incoming(qq)
      await incoming(qq, 'group:one', 'unrelated')
      await manager.deliver(message({ channelAddress: address, done: false, yieldRequest: request, content: 'Proceed? 1/2' }))
      assert.equal(wire.messages()[0].body.msg_id, 'source')
      const handoff: SessionMessageInput = {
        id: 'handoff', kind: 'message', policy: 'queue',
        timestamp: new Date().toISOString(),
        source: { kind: 'session', sessionId: 'web:worker', coordination: { intent: 'handoff' } },
        content: 'Task finished. Notify the group.',
      }
      const context = inputContext(request.sessionId, handoff)
      assert.deepEqual(context.channelAddress, address)
      assert.equal(context.platformMessageId, undefined)
      await manager.deliver(message({
        channel: context.channel, chatId: context.chatId,
        channelAddress: context.channelAddress, replyTo: context.platformMessageId,
      }))
      assert.deepEqual(wire.messages()[1], {
        path: '/v2/groups/one/messages', body: { msg_type: 2, markdown: { content: 'Summary' } },
      })
      wire.fail(() => Response.json({ code: 40034128 }, { status: 400 }))
      const failed = new Promise<unknown>(resolve => bus.on('channel.delivery.failed', event => resolve(event)))
      bus.emit('message.outbound', message({ channelAddress: address }))
      assert.deepEqual(await failed, {
        projectId: 'project', channelAddress: address, channel: 'qq', chatId: 'group:one',
        error: 'QQ delivery failed: quota (rejected) status=400 code=40034128',
      })
      assert.equal(wire.messages().length, 3)
    } finally {
      await manager.stopAll()
    }
  })

})

test('QQ legacy yield notification retains the initiating turn source, not the answer or latest message', async t => {
  const wire = transport(t)
  const qq = channel()
  await incoming(qq)
  await incoming(qq, 'group:one', 'unrelated')
  const notify = (SessionManager.prototype as unknown as {
    notifyYieldUser(request: YieldRequest, replyTo?: string): Promise<void>
  }).notifyYieldUser
  const outbound: OutboundMessage[] = []
  const receiver = { deps: {
    deliverYield: async (msg: OutboundMessage) => { outbound.push(msg); await qq.onMessage(msg) },
  } }
  const yields = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: null }),
    notifyUser: (request, replyTo) => notify.call(receiver, request, replyTo),
    notifyParent: async () => {},
  })
  const ctx = {
    sessionId: 'qq:group:one', channel: 'qq', chatId: 'group:one', senderId: 'alice',
    inputSource: 'user', platformMessageId: 'source', signal: new AbortController().signal,
  } as ExecutionContext
  const pending = yields.ask(ctx.sessionId, parseYieldQuestion({ brief: decisionBrief, question: 'Proceed?',
    options: ['Yes', 'No'], defaultOption: 'No' }), ctx.signal, { channel: ctx.channel, senderId: ctx.senderId }, ctx.platformMessageId)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(outbound[0].replyTo, 'source')
  assert.equal(wire.messages()[0].body.msg_id, 'source')
  t.mock.timers.tick(300_000)
  await incoming(qq, 'group:one', 'answer')
  yields.answerChannel(ctx.sessionId, yields.get(ctx.sessionId)!.id, 'Yes', 'qq', 'alice')
  assert.equal((await pending).option, 'Yes')
  await assert.rejects(qq.send(message({ replyTo: ctx.platformMessageId })), { kind: 'invalid_source' })
  assert.equal(wire.messages().length, 1)
})
