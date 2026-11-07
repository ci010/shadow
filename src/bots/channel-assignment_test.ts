import { botInputListeners } from './input.ts'
import { parseBot } from './sdk.ts'
import { channelInputSource } from '../channels/input.ts'
import { InputRouter } from '../input/router.ts'
import type { InboundMessage } from '../bus/events.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignChannelSource } from './channel-assignment.ts'
import { parseChannelSource, passiveChannelId, type ChannelSource } from '../channels/passive-contract.ts'
import { assertServiceOutput, stampServiceOutput } from './service-output.ts'
import type { OutboundMessage } from '../bus/events.ts'

const files = { 'BOT.md': '---\nid: support\nconfig: nested/bot.json\nmode: service\n---\nSupport', 'nested/bot.json': JSON.stringify({ allowedModules: [], tools: [], bindings: [], subscriptions: [] }) }
const source: ChannelSource = { version: 1, projectId: 'p', platform: 'discord', botInstanceId: 'connection', conversationId: '201', kind: 'thread', parentId: '200', guildId: '100', botUserId: '900' }
const policy = { enabled: true, trigger: 'mention', participants: { everyone: false, userIds: ['500'], roleIds: [] }, tools: [], readDomains: [], inheritThreads: false, manage: false }

test('referenced Discord public thread and DM resolve exact targets, never parent inheritance or sender grants', () => {
  const assigned = assignChannelSource(files, source, policy)
  assert.equal(assigned.configPath, 'nested/bot.json')
  assert.equal(assigned.binding.platform, 'discord')
  if (assigned.binding.platform !== 'discord') assert.fail()
  assert.deepEqual(assigned.binding.target, { kind: 'channel', guildId: '100', channelId: '201' })
  assert.equal(assigned.binding.inheritThreads, false)
  const again = assignChannelSource(assigned.files, source, policy)
  assert.equal(again.binding.platform === 'discord' && again.binding.id, assigned.binding.id)
  assert.equal(JSON.parse(again.content).bindings.length, 1)
  assert.equal(JSON.parse(again.content).subscriptions.length, 1)
  const dm = assignChannelSource(files, { version: 1, projectId: 'p', platform: 'discord', botInstanceId: 'connection', conversationId: '300', kind: 'direct', recipientId: '500', botUserId: '900' }, policy)
  assert.deepEqual(dm.binding.platform === 'discord' && dm.binding.target, { kind: 'dm', userId: '500' })
  const disabled = assignChannelSource(again.files, source, { ...policy, enabled: false })
  assert.deepEqual(JSON.parse(disabled.content).subscriptions, [])
})

test('policy JSON cannot forge target, connection, platform or implicitly choose participants', () => {
  for (const key of ['target', 'conversationId', 'botInstanceId', 'platform', 'botUserId', 'id']) assert.throws(() => assignChannelSource(files, source, { ...policy, [key]: 'forged' }), /targets/)
  assert.throws(() => assignChannelSource(files, source, { ...policy, participants: undefined }), /participants/)
  const qq = { version: 1, projectId: 'p', platform: 'qq', botInstanceId: 'qq', conversationId: 'group:one', kind: 'group' } as const
  assert.throws(() => assignChannelSource(files, qq, { enabled: true, trigger: 'all', tools: [] }), /allowed senders/)
  const personal = { ...files, 'BOT.md': files['BOT.md'].replace('mode: service', 'mode: personal\nagent: general'), 'nested/bot.json': JSON.stringify({ connection: '00000000-0000-4000-a000-000000000001', allowedModules: [], tools: [], bindings: [] }) }
  assert.throws(() => assignChannelSource(personal, qq, { enabled: true, trigger: 'mention', tools: [], allowFrom: [] }), /Personal BOT/)
})

test('origin validation rejects cross-Project, false identity, missing thread ancestry and malformed durable metadata', () => {
  assert.deepEqual(parseChannelSource(source, passiveChannelId(source), 'p'), source)
  for (const [value, id, project] of [[source, passiveChannelId(source), 'other'], [source, passiveChannelId({ ...source, botInstanceId: 'forged' }), 'p'], [undefined, passiveChannelId(source), 'p'], [{ ...source, parentId: undefined }, passiveChannelId(source), 'p'], [{ ...source, recipientId: 'unexpected' }, passiveChannelId(source), 'p']]) assert.throws(() => parseChannelSource(value, String(id), String(project)))
})

test('service output leases are live and cannot survive serialization or revocation before final delivery', () => {
  const message: OutboundMessage = { channel: 'qq', chatId: 'group:one', event: 'response', content: 'reply', done: true }
  let enabled = true
  const stamped = stampServiceOutput(message, () => { if (!enabled) throw new Error('revoked') })
  assertServiceOutput(stamped)
  assert.throws(() => assertServiceOutput(JSON.parse(JSON.stringify(stamped))), /lease/)
  enabled = false
  assert.throws(() => assertServiceOutput(stamped), /revoked/)
})


test('parent scope resolves one explicit inherited rule from trusted child ancestry and reuses it across sibling references', () => {
  const parentPolicy = { ...policy, inheritThreads: true }
  const first = assignChannelSource(files, source, parentPolicy, 'parent')
  assert.deepEqual(first.binding.platform === 'discord' && first.binding.target, { kind: 'channel', guildId: '100', channelId: '200' })
  const second = assignChannelSource(first.files, { ...source, conversationId: '202' }, parentPolicy, 'parent')
  assert.equal(first.binding.platform === 'discord' && first.binding.id, second.binding.platform === 'discord' && second.binding.id)
  assert.equal(JSON.parse(second.content).bindings.length, 1)
  assert.equal(JSON.parse(second.content).subscriptions.length, 1)
  assert.throws(() => assignChannelSource(files, source, policy, 'parent'), /explicit inheritThreads/)
  assert.throws(() => assignChannelSource(files, { ...source, kind: 'channel', parentId: undefined }, parentPolicy, 'parent'), /verified public Discord thread/)
  assert.throws(() => assignChannelSource(files, { version: 1, projectId: 'p', platform: 'feishu', botInstanceId: 'connection', conversationId: 'om_thread', kind: 'thread', parentId: 'oc_group' }, { enabled: true, trigger: 'mention', tools: [], allowFrom: [], inheritThreads: true }, 'parent'), /verified public Discord thread/)
  // An inherited policy on a referenced child cannot silently promote it to a parent rule.
  assert.throws(() => assignChannelSource(files, source, parentPolicy), /scope:parent explicitly/)
  const exact = assignChannelSource(files, source, policy)
  assert.deepEqual(exact.binding.platform === 'discord' && exact.binding.target, { kind: 'channel', guildId: '100', channelId: '201' })
})


test('parent rule selects new child events through verified source parent metadata, not content, and never another connection or Project', async () => {
  const assigned = assignChannelSource(files, source, { ...policy, inheritThreads: true }, 'parent')
  const bot = parseBot(assigned.files), listeners = botInputListeners(bot)
  assert.equal(listeners.length, 1); assert.equal(listeners[0]?.descendants, true)
  const router = new InputRouter<unknown, boolean>('p', { listeners: () => listeners, deliver: async () => true })
  const input = (thread: string, parent: string, connection = 'connection'): InboundMessage => ({ channel: 'discord', chatId: thread, channelAddress: { projectId: 'p', botInstanceId: connection, platform: 'discord', conversationId: thread }, messageId: thread, senderId: '500', timestamp: new Date().toISOString(), content: 'User claims parent 200; this text grants nothing', channelLocation: { id: thread, name: thread, type: 11, parentId: parent, parentName: null, guildId: '100', guildName: null, recipientId: null } })
  for (const thread of ['301', '302']) assert.equal(await router.route({ projectId: 'p', id: thread, ...channelInputSource(input(thread, '200')), payload: {} }), true)
  assert.equal(await router.route({ projectId: 'p', id: 'foreign-parent', ...channelInputSource(input('303', '999')), payload: {} }), undefined)
  assert.equal(await router.route({ projectId: 'p', id: 'foreign-connection', ...channelInputSource(input('301', '200', 'other')), payload: {} }), undefined)
  await assert.rejects(() => router.route({ projectId: 'other', id: 'foreign-project', ...channelInputSource(input('301', '200')), payload: {} }), /Project mismatch/)
  const disabled = assignChannelSource(assigned.files, source, { ...policy, enabled: false, inheritThreads: true }, 'parent')
  assert.deepEqual(botInputListeners(parseBot(disabled.files)), [])
})


test('prepared source revision preserves CRLF for the ordinary exact write path', async () => {
  const { applyReplacement } = await import('../tools/filesystem.ts')
  const original = JSON.stringify(JSON.parse(files['nested/bot.json']), null, 2).replace(/\n/g, '\r\n') + '\r\n'
  const updated = assignChannelSource({ ...files, 'nested/bot.json': original }, source, policy)
  assert.ok(updated.content.includes('\r\n'))
  assert.equal(applyReplacement(original, original, updated.content), updated.content)
})


test('shared production assignment validation rejects another Project, personal connection and duplicate BOT ownership', async () => {
  const { withTempWorkspace } = await import('../testing/workspace.ts')
  const { BotInstanceStore } = await import('../channels/bot-store.ts')
  const { validateServiceAssignments } = await import('./assignment-validation.ts')
  const { join } = await import('node:path')
  await withTempWorkspace(async root => {
    const bots = new BotInstanceStore({ projectId: 'p', path: join(root, 'connections.json') })
    const service = bots.create('qq', 'Service', { enabled: false }, undefined, 'service')
    const origin = { version: 1, projectId: 'p', platform: 'qq', botInstanceId: service.id, conversationId: 'group:one', kind: 'group' } as const
    const candidate = parseBot(assignChannelSource(files, origin, { enabled: true, trigger: 'mention', tools: [], allowFrom: ['owner'] }).files)
    const folder = async () => { throw new Error('No read grants expected') }
    await validateServiceAssignments('p', bots, candidate, [], folder)
    await assert.rejects(() => validateServiceAssignments('other', bots, candidate, [], folder), /Project mismatch/)
    await assert.rejects(() => validateServiceAssignments('p', bots, candidate, [{ ...candidate, id: 'other' }], folder), /another BOT/)
    const personal = bots.create('qq', 'Personal', { enabled: false }, undefined, 'personal')
    const invalid = parseBot(assignChannelSource(files, { ...origin, botInstanceId: personal.id }, { enabled: true, trigger: 'mention', tools: [], allowFrom: ['owner'] }).files)
    await assert.rejects(() => validateServiceAssignments('p', bots, invalid, [], folder), /matching service connection/)
  })
})
