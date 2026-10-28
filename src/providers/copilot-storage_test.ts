import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { CopilotAuthenticatorV2 } from './copilot-v2.ts'
import { ConfigSchema } from '../config/schema.ts'
import { createAggregatedProvider, createProvider } from './factory.ts'

const now = 1_800_000_000_000
const grant = (token: string, host = 'github.com') => ({ host, accessToken: token, apiKey: {
  token, expires_at: now / 1000 + 3600,
  directOAuth: { clientId: 'Ov23ctr1Udn5GokVCVJf', scope: 'copilot', expiryKnown: true },
} })

test('current disk grants survive reconstruction; rollback and signout remain host scoped', async t => {
  const root = join(process.cwd(), '.test-data', `copilot-storage-${randomUUID()}`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = { isolated: true, now: () => now, fetch: async () => { throw new Error('No external requests') } }
  const auth = new CopilotAuthenticatorV2(root, options)
  auth.persistGrant(grant('synthetic-com'))
  auth.writeModelsCache([{ id: 'com-model' }])
  const undo = auth.persistGrant(grant('synthetic-enterprise', 'octocat.ghe.com'))
  undo()
  assert.equal(auth.getHost(), 'github.com')
  assert.deepEqual(auth.readModelsCache()?.models, [{ id: 'com-model' }])
  auth.persistGrant(grant('synthetic-enterprise', 'octocat.ghe.com'))
  const restored = new CopilotAuthenticatorV2(root, options)
  assert.equal(restored.getHost(), 'octocat.ghe.com')
  assert.equal(await restored.getApiKey(), 'synthetic-enterprise')
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(root, 'hosts', 'octocat.ghe.com', 'api-key.json')).mode & 0o777, 0o600)
  }
  restored.signOut()
  await assert.rejects(restored.getApiKey())
  assert.equal(readFileSync(join(root, 'access-token'), 'utf8'), 'synthetic-com')
  assert.equal(JSON.parse(readFileSync(join(root, 'models.json'), 'utf8')).models[0].id, 'com-model')
})

test('loading retired config or legacy credentials does not modify any disk credential bytes', async t => {
  const root = join(process.cwd(), '.test-data', `copilot-retired-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'access-token'), 'synthetic-legacy-access\n')
  writeFileSync(join(root, 'api-key.json'), '{"token":"synthetic-short-key","expires_at":1900000000}\n')
  writeFileSync(join(root, 'models.json'), '{"models":[],"fetchedAt":1}\n')
  const snapshot = () => Object.fromEntries(readdirSync(root).map(name => [name, readFileSync(join(root, name)).toString('hex')]))
  const before = snapshot()
  const auth = new CopilotAuthenticatorV2(root, { isolated: true, now: () => now, fetch: async () => assert.fail('Must not contact GitHub') })
  assert.equal(auth.hasAccessToken(), false)
  assert.equal(auth.hasValidApiKey(), false)
  await assert.rejects(auth.getApiKey())
  await assert.rejects(auth.getApiKey(undefined, true))
  const config = ConfigSchema.parse({ agent: { model: 'gpt-4o@old' }, providers: { old: { type: 'copilot-v1' } } })
  await assert.rejects(createProvider('gpt-4o', config, 'old', auth).chat([], [], { model: 'gpt-4o' }), /Reconfigure/)
  await assert.rejects(createAggregatedProvider(config, auth).chat([], [], { model: 'gpt-4o' }), /Reconfigure/)
  assert.deepEqual(snapshot(), before)
})
