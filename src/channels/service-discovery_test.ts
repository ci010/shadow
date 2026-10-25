import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceDiscoveryStore } from './service-discovery.ts'
import { FeishuChannel } from './feishu.ts'
import { QQChannel } from './qq.ts'
import { Bus } from '../bus/bus.ts'

test('discovery is bounded, deduplicated, expiring, private, project-owned and sampled on disk', t => {
  const root = join(process.cwd(), '.test-data', `discovery-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'discovery.json')
  let now = 100_000
  const store = new ServiceDiscoveryStore('A', path, () => now)
  const entry = { botInstanceId: 'bot', platform: 'qq' as const, conversationId: 'group:1', name: 'Group' }
  store.observe(entry)
  const first = readFileSync(path, 'utf8')
  now++
  store.observe(entry)
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0]?.lastSeen, now)
  assert.equal(readFileSync(path, 'utf8'), first)
  for (let i = 0; i < 220; i++) store.observe({ ...entry, conversationId: `group:${i}` })
  assert.equal(store.list().length, 200)
  store.flush()
  assert.equal(new ServiceDiscoveryStore('A', path, () => now).list().length, 200)
  assert.throws(() => new ServiceDiscoveryStore('B', path), /project mismatch/)
  const snapshot = store.list(); snapshot[0]!.name = 'changed'
  assert.notEqual(store.list()[0]?.name, 'changed')
  store.observe({ ...entry, conversationId: 'bad\nidentifier' })
  assert.equal(store.list().length, 200)
  now += 31 * 24 * 60 * 60 * 1000
  assert.deepEqual(store.list(), [])
})

test('real QQ group discovery stops before attachment downloads, receiver and passive-reply admission', async t => {
  const channel = new QQChannel(new Bus(), { appId: 'synthetic-id', secret: 'synthetic-secret', allowFrom: [], triggerMode: 'all' })
  const observations: string[] = []
  channel.setGroupPreflight((chatId, name) => { observations.push(`${chatId}:${name}`); return false })
  channel.setReceiver(async () => { assert.fail('Unbound service group must not reach Agent receiver') })
  t.mock.method(channel as never, 'downloadAttachments' as never, (() => { assert.fail('No attachment storage for discovery') }) as never)
  const adapter = channel as unknown as { onGroupMessage(data: Record<string, unknown>, mentioned: boolean): Promise<void> }
  await adapter.onGroupMessage({ id: 'm1', group_openid: 'group1', group_name: 'Available name', author: { member_openid: 'user1' }, content: 'not persisted', attachments: [{}] }, true)
  assert.deepEqual(observations, ['group:group1:Available name'])
})

test('observed messages are deduplicated, independently copied, bounded, expiring and migrated from metadata-only records', t => {
  const root = join(process.cwd(), '.test-data', `discovery-messages-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'discovery.json')
  let now = 100_000
  const store = new ServiceDiscoveryStore('A', path, () => now)
  const group = { botInstanceId: 'bot', platform: 'qq' as const, conversationId: 'group:1' }
  for (let i = 0; i < 25; i++) store.observe(group, { id: String(i), sender: 'sender', text: 'x'.repeat(3000), state: 'not_enabled' })
  store.observe(group, { id: '24', sender: 'sender', text: 'duplicate' })
  assert.equal(store.list()[0].messages.length, 20)
  assert.equal(store.list()[0].messages[0].id, '5')
  assert.equal(store.list()[0].messages[0].text.length, 2000)
  assert.equal(store.list()[0].messages[0].state, 'not_enabled')
  store.list()[0].messages[0].text = 'caller mutation'
  assert.equal(store.list()[0].messages[0].text.length, 2000)
  store.flush()
  assert.equal(new ServiceDiscoveryStore('A', path, () => now).list()[0].messages.length, 20)
  now += 8 * 24 * 60 * 60 * 1000
  assert.deepEqual(store.list()[0].messages, [])
})

test('QQ Bot membership event discovers a group without invoking the receiver', async () => {
  const channel = new QQChannel(new Bus(), { appId: 'synthetic-id', secret: 'synthetic-secret', allowFrom: [] })
  const observations: string[] = []
  channel.setGroupPreflight(chatId => { observations.push(chatId); return false })
  channel.setReceiver(async () => { assert.fail('Membership cannot invoke an Agent') })
  const adapter = channel as unknown as { handleDispatch(event: string, data: Record<string, unknown>): Promise<void> }
  await adapter.handleDispatch('GROUP_ADD_ROBOT', { group_openid: 'new-group' })
  assert.deepEqual(observations, ['group:new-group'])
})


test('Feishu Bot membership observation does not react, parse messages or invoke a receiver', async () => {
  const channel = new FeishuChannel(new Bus(), { appId: 'synthetic-id', appSecret: 'synthetic-secret' })
  const observed: string[] = []
  channel.setGroupPreflight(chatId => { observed.push(chatId); return false })
  channel.setReceiver(async () => { assert.fail('Membership cannot invoke an Agent') })
  const adapter = channel as unknown as { _onMessage(data: Record<string, unknown>): Promise<void> }
  await adapter._onMessage({ _shadowMembership: true, chat_id: 'oc_new_group' })
  assert.deepEqual(observed, ['oc_new_group'])
})
