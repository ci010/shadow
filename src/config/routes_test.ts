import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { configPlugin } from './routes.ts'
import { ConfigStore, REDACTED_SECRET } from './store.ts'
import { ConfigSchema } from './schema.ts'

test('config GET/PATCH redact credentials and preserve them during ordinary model changes', async (t) => {
  const root = join(process.cwd(), '.test-data', `config-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'config.json')
  const raw = {
    agent: { model: 'gpt-4o' },
    providers: { openai: { apiKey: 'synthetic-provider-key' } },
    channels: { discord: { token: 'synthetic-discord-token' } },
    mcp: { fixture: { command: 'node', env: { PRIVATE_VALUE: 'synthetic-env-secret' } } },
    fixture: { keep: 'unrelated' },
  }
  writeFileSync(path, JSON.stringify(raw))
  let active = ConfigSchema.parse(raw)
  const store = new ConfigStore({ configPath: path, getConfig: () => active, onChanged: (config) => { active = config } })
  const app = new Hono()
  configPlugin({ store })(app)
  const response = await app.request('/api/config')
  const body = await response.json()
  assert.equal(body.providers.openai.apiKey, REDACTED_SECRET)
  assert.equal(body.mcp.fixture.env.PRIVATE_VALUE, REDACTED_SECRET)
  assert.doesNotMatch(JSON.stringify(body), /synthetic-/)
  body.agent.model = 'gpt-4.1@openai'
  delete body.channels.discord.token
  const saved = await app.request('/api/config', { method: 'PATCH', body: JSON.stringify(body) })
  assert.equal(saved.status, 200)
  assert.doesNotMatch(await saved.text(), /synthetic-/)
  assert.equal(active.agent.model, 'gpt-4.1@openai')
  assert.equal(active.providers.openai.apiKey, 'synthetic-provider-key')
  const persisted = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(persisted.channels.discord.token, 'synthetic-discord-token')
  assert.equal(persisted.mcp.fixture.env.PRIVATE_VALUE, 'synthetic-env-secret')
  assert.equal(persisted.fixture.keep, 'unrelated')
})

test('config activation failures roll back disk and report safe failure', async (t) => {
  const root = join(process.cwd(), '.test-data', `rollback-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'config.json')
  const original = JSON.stringify({ agent: { model: 'old' } })
  writeFileSync(path, original)
  const app = new Hono()
  configPlugin({ configPath: path, onChanged: () => { throw new Error('synthetic-secret-error') } })(app)
  const saved = await app.request('/api/config', { method: 'PATCH', body: JSON.stringify({ agent: { model: 'new' } }) })
  assert.equal(saved.status, 500)
  assert.doesNotMatch(await saved.text(), /synthetic-secret-error/)
  assert.equal(readFileSync(path, 'utf8'), original)
  const invalid = await app.request('/api/config', { method: 'PATCH', body: '{' })
  assert.equal(invalid.status, 400)
  assert.equal(readFileSync(path, 'utf8'), original)
})
