import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { YieldManager } from '../sessions/yield.ts'
import type { YieldRequest } from '../sessions/yield-contract.ts'
import { AbstractChannel, type ChannelDecision } from './base.ts'
import { unavailableCapabilities, type ChannelCapabilities } from './capabilities.ts'
import { ChannelManager } from './manager.ts'
import { QQChannel } from './qq.ts'
import { WebChannel } from './web.ts'
import { WeChatChannel } from './wechat.ts'

class DecisionChannel extends AbstractChannel {
  readonly name = 'discord'
  update: AbstractChannel['update'] = undefined
  native: YieldRequest[] = []
  sent: OutboundMessage[] = []
  threads: string[] = []
  failNative = false
  failText = false
  failCapabilities = false
  capabilities: ChannelCapabilities = {
    ...unavailableCapabilities(), conversation: 'group', threads: 'public', decisions: 'buttons',
  }
  async start() { this.setAccepting(true); this.reportState('connected') }
  async stop() { this.setAccepting(false); this.reportState('disconnected') }
  ready() { this.reportState('connected') }
  disconnected() { this.reportState('disconnected') }
  override getCapabilities() {
    if (this.failCapabilities) throw new Error('synthetic lookup failure')
    return this.capabilities
  }
  async createThread(chatId: string) { this.threads.push(chatId); return 'thread-id' }
  async send(msg: OutboundMessage) {
    if (this.failText) throw new Error('synthetic delivery failure')
    this.sent.push(msg)
    return 'sent-id'
  }
  override async presentDecision(_chatId: string, request: YieldRequest) {
    if (this.failNative) throw new Error('synthetic native failure')
    this.native.push(request)
  }
  click(decision: ChannelDecision) { return this.answerDecision(decision) }
}

async function fixture(t: TestContext) {
  const bus = new Bus()
  const created: DecisionChannel[] = []
  const yields = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: null }),
    notifyUser: async () => {}, notifyParent: async () => {},
  })
  const config = ConfigSchema.parse({ channels: { discord: { enabled: true, token: 'synthetic' } } })
  const sessions: Pick<SessionManager, 'yields' | 'getActiveSession'> = {
    yields, getActiveSession: () => undefined,
  }
  const manager = new ChannelManager(config, bus, sessions as SessionManager, async () => ({ status: 'accepted', sessionId: 'discord:room', inputId: 'input' }), () => {
    const channel = new DecisionChannel(bus, ['alice', 'bob'])
    created.push(channel)
    return channel
  })
  await manager.init()
  await manager.startAll(new Hono())
  t.after(async () => { yields.stop(); await manager.stopAll() })
  const ask = () => {
    const waiting = yields.ask('discord:room', {
      question: 'Proceed?', options: ['Yes', 'Change', 'Stop'], defaultOption: 'Yes',
    }, new AbortController().signal, { channel: 'discord', senderId: 'alice' })
    const request = yields.get('discord:room')!
    const message: OutboundMessage = {
      channel: 'discord', chatId: 'room', event: 'response', content: 'Text choices', done: true, yieldRequest: request,
    }
    return { waiting, request, message }
  }
  return { manager, yields, created, channel: created[0]!, ask, config }
}

test('capabilities reflect implemented QQ scenes, Web controls, and iLink limitations', () => {
  const qq = new QQChannel(new Bus(), { appId: 'fixture', secret: 'synthetic' })
  assert.equal(qq.getCapabilities('c2c:user').conversation, 'direct')
  assert.equal(qq.getCapabilities('group:room').conversation, 'group')
  assert.equal(qq.getCapabilities('channel:room').conversation, 'group')
  assert.deepEqual(qq.getCapabilities('dms:guild').outboundMedia, ['image'])
  for (const scene of ['c2c:user', 'group:room', 'channel:room', 'dms:guild']) {
    const cap = qq.getCapabilities(scene)
    assert.equal(cap.threads, 'none')
    assert.equal(cap.updates, 'none')
    assert.equal(cap.decisions, 'text')
    assert.equal(cap.codeBlocks, false)
  }
  assert.deepEqual(qq.getCapabilities('unsupported'), unavailableCapabilities())
  assert.equal(new WebChannel(new Bus(), {}).getCapabilities().decisions, 'native')
  const wechat = WeChatChannel.prototype.getCapabilities()
  assert.deepEqual(wechat.outboundMedia, ['image'])
  assert.equal(wechat.updates, 'none')
  assert.equal(wechat.threads, 'none')
})

test('manager gates capabilities and thread creation on active connection and chat support', async t => {
  const f = await fixture(t)
  assert.equal((await f.manager.getCapabilities('discord', 'room')).threads, 'public')
  assert.equal(await f.manager.createThread('discord', 'room', 'Child'), 'thread-id')
  f.channel.capabilities = { ...f.channel.capabilities, conversation: 'direct', threads: 'none' }
  assert.equal(await f.manager.createThread('discord', 'dm', 'Child'), null)
  assert.deepEqual(f.channel.threads, ['room'])
  f.channel.disconnected()
  assert.deepEqual(await f.manager.getCapabilities('discord', 'room'), unavailableCapabilities())
  f.channel.ready()
  f.channel.failCapabilities = true
  assert.deepEqual(await f.manager.getCapabilities('discord', 'room'), unavailableCapabilities())
  f.channel.failCapabilities = false
  f.manager.updateConfig({ ...f.config, channels: { ...f.config.channels, discord: { ...f.config.channels.discord!, token: 'changed' } } })
  assert.deepEqual(await f.manager.getCapabilities('discord', 'room'), unavailableCapabilities())
  assert.equal(await f.manager.createThread('discord', 'room', 'Child'), null)
})

test('native decisions route only the initiating user and reject replay, cross-chat and stale adapters', async t => {
  const f = await fixture(t)
  const { waiting, request, message } = f.ask()
  await f.manager.deliverDecision(message)
  assert.equal(f.channel.native[0]?.id, request.id)
  assert.equal(f.channel.sent.length, 0)
  const click: ChannelDecision = { chatId: 'room', senderId: 'alice', requestId: request.id, option: 2 }
  await assert.rejects(f.channel.click({ ...click, senderId: 'bob' }), /Only the user/)
  await assert.rejects(f.channel.click({ ...click, senderId: 'mallory' }), /not authorized/)
  await assert.rejects(f.channel.click({ ...click, chatId: 'elsewhere' }), /no longer pending/)
  assert.equal(await f.channel.click(click), 'Selected: Change')
  assert.equal((await waiting).option, 'Change')
  await assert.rejects(f.channel.click(click), /no longer pending/)
  await f.manager.updateChannel('discord', async config => config)
  await assert.rejects(f.channel.click(click), /disconnected|changed/)
})

test('native delivery failure uses isolated text fallback; settled requests are not sent', async t => {
  const f = await fixture(t)
  f.channel.failNative = true
  const { waiting, request, message } = f.ask()
  await f.manager.deliverDecision(message)
  assert.equal(f.channel.sent.length, 1)
  assert.equal(f.channel.sent[0]?.done, true)
  f.yields.answerChannel(request.sessionId, request.id, 'Yes', 'discord', 'alice')
  await waiting
  await f.manager.deliverDecision(message)
  assert.equal(f.channel.sent.length, 1)
})

test('native and fallback delivery errors propagate rather than looking successful', async t => {
  const f = await fixture(t)
  f.channel.failNative = true
  f.channel.failText = true
  const { waiting, request, message } = f.ask()
  await assert.rejects(f.manager.deliverDecision(message), /delivery failure/)
  const cancelled = assert.rejects(waiting, { name: 'AbortError' })
  f.yields.cancelChannel(request.sessionId, request.id, 'discord', 'alice')
  await cancelled
})

test('method presence does not enable edits when the adapter declares them unavailable', async () => {
  class NoEdits extends DecisionChannel {
    edits = 0
    override update = async () => { this.edits++ }
  }
  const channel = new NoEdits(new Bus())
  for (const content of ['one', 'two']) {
    await channel.onMessage({ channel: 'discord', chatId: 'room', event: 'response', content, done: false })
  }
  assert.deepEqual(channel.sent.map(message => message.content), ['one', 'two'])
  assert.equal(channel.edits, 0)
})

test('decision text is separate from the active progressive response', async () => {
  class Editable extends DecisionChannel {
    edited: string[] = []
    override capabilities: ChannelCapabilities = { ...unavailableCapabilities(), updates: 'replace' }
    override update = async (messageId: string) => { this.edited.push(messageId) }
    override async send(msg: OutboundMessage) {
      this.sent.push(msg)
      return `message-${this.sent.length}`
    }
  }
  const channel = new Editable(new Bus())
  await channel.onMessage({ channel: 'discord', chatId: 'room', event: 'response', content: 'Working', done: false })
  await channel.presentDecisionText('room', 'Choose an option')
  await channel.onMessage({ channel: 'discord', chatId: 'room', event: 'response', content: 'Done', done: true })
  assert.deepEqual(channel.edited, ['message-1'])
  assert.equal(channel.sent[1]?.content, 'Choose an option')
})
