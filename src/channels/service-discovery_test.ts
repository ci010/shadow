import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceDiscoveryStore } from './service-discovery.ts'
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
