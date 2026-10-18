import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotSettingsClient, parseBotStatus } from './bot-settings.ts'

const status = { id: 'b', projectId: 'p', platform: 'qq', displayName: 'Bot', label: 'QQ', enabled: false, configured: false, state: 'disabled', config: {}, secrets: {}, purpose: 'personal', ownerVerified: false }

test('Bot client creates explicit modes and keeps owner challenges scoped to exact Bot URL', async () => {
  const calls: Array<{ url: string; body?: unknown; method?: string }> = []
  const client = createBotSettingsClient('http://localhost/projects/p', 'p', async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const body = String(url).endsWith('/owner-challenge') ? { challenge: 'synthetic', expiresAt: 'later' }
      : String(url).endsWith('/owner-candidate') ? { candidate: 'platform-owner' }
      : String(url).endsWith('/owner-confirm') ? { confirmed: true }
      : String(url).endsWith('/owner') ? { revoked: true } : { channel: status }
    return Response.json(body)
  })
  assert.equal((await client.create('qq', 'Personal', undefined, 'personal')).purpose, 'personal')
  assert.equal((calls[0].body as any).purpose, 'personal')
  await client.create('qq', 'Service', undefined, 'service')
  assert.equal((calls[1].body as any).purpose, 'service')
  assert.equal((await client.challenge('b')).challenge, 'synthetic')
  assert.equal((await client.candidate('b')).candidate, 'platform-owner')
  await client.confirm('b', 'synthetic')
  await client.revoke('b')
  assert.ok(calls.slice(2).every(call => call.url.startsWith('http://localhost/projects/p/api/channels/b/')))
  assert.deepEqual(calls[4].body, { challenge: 'synthetic' })
  assert.equal(calls[5].method, 'DELETE')
})

test('old Bot status is explicit legacy, never inferred personal or owner verified', () => {
  const { purpose: _, ownerVerified: __, ...old } = status
  const parsed = parseBotStatus(old, 'p')
  assert.equal(parsed.purpose, 'legacy')
  assert.equal(parsed.ownerVerified, false)
  assert.throws(() => parseBotStatus(status, 'other'))
})

