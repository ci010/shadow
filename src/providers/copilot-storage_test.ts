import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { CopilotAuthenticatorV2 } from './copilot-v2.ts'
import { createCopilotAuthStorage } from './copilot-auth-storage.ts'
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
  let master: Buffer | undefined
  const storage = createCopilotAuthStorage(root, { load: () => master && Buffer.from(master), save: value => { master = Buffer.from(value) } })
  const options = { storage, isolated: true, now: () => now, fetch: async () => { throw new Error('No external requests') } }
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
    assert.equal(statSync(join(root, 'hosts', 'octocat.ghe.com', 'api-key.json.protected')).mode & 0o777, 0o600)
  }
  const staleUndo = restored.persistGrant(grant('synthetic-enterprise-new', 'octocat.ghe.com'))
  restored.signOut()
  staleUndo()
  await assert.rejects(restored.getApiKey())
  assert.equal(storage.read(join(root, 'access-token')), 'synthetic-com')
  assert.equal(JSON.parse(storage.read(join(root, 'models.json'))!).models[0].id, 'com-model')
})

test('retired credentials are encrypted on access but remain rejected for inference', async t => {
  const root = join(process.cwd(), '.test-data', `copilot-retired-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'access-token'), 'synthetic-legacy-access\n')
  writeFileSync(join(root, 'api-key.json'), '{"token":"synthetic-short-key","expires_at":1900000000}\n')
  writeFileSync(join(root, 'models.json'), '{"models":[],"fetchedAt":1}\n')
  const snapshot = () => Object.fromEntries(readdirSync(root).map(name => [name, readFileSync(join(root, name)).toString('hex')]))
  let master: Buffer | undefined
  const storage = createCopilotAuthStorage(root, { load: () => master && Buffer.from(master), save: value => { master = Buffer.from(value) } })
  const auth = new CopilotAuthenticatorV2(root, { storage, isolated: true, now: () => now, fetch: async () => assert.fail('Must not contact GitHub') })
  assert.equal(auth.hasAccessToken(), false)
  assert.equal(auth.hasValidApiKey(), false)
  await assert.rejects(auth.getApiKey())
  await assert.rejects(auth.getApiKey(undefined, true))
  const config = ConfigSchema.parse({ agent: { model: 'gpt-4o@old' }, providers: { old: { type: 'copilot-v1' } } })
  await assert.rejects(createProvider('gpt-4o', config, 'old', auth).chat([], [], { model: 'gpt-4o' }), /Reconfigure/)
  await assert.rejects(createAggregatedProvider(config, auth).chat([], [], { model: 'gpt-4o' }), /Reconfigure/)
  assert.ok(snapshot()['api-key.json.protected'])
  assert.equal(snapshot()['api-key.json'], undefined)
  // Untouched legacy files migrate lazily, not by scanning user directories.
  assert.equal(storage.read(join(root, 'access-token')), 'synthetic-legacy-access\n')
})


test('credential filename overrides cannot target plaintext active-host metadata', t => {
  const root = join(process.cwd(), '.test-data', `copilot-collision-${randomUUID()}`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const variable of ['GITHUB_COPILOT_ACCESS_TOKEN_FILE', 'GITHUB_COPILOT_API_KEY_FILE', 'GITHUB_COPILOT_MODELS_CACHE_FILE']) {
    const previous = process.env[variable]
    try {
      for (const value of ['active-host', 'ACTIVE-HOST', '../outside', '/absolute', 'C:\\outside', '..\\outside', 'nested/token', 'token.protected', '.protected-key-created', '.protected-key-lock', 'master-key.dpapi', 'NUL', 'token:stream', 'token.']) {
        process.env[variable] = value
        assert.throws(() => new CopilotAuthenticatorV2(root), /Protected credentials/, `${variable}: ${value}`)
      }
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  }
})
