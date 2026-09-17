import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ConfigStore } from './store.ts'
import { ConfigSchema } from './schema.ts'

test('saving model defaults retains startup-only environment settings without writing secrets', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, '{}')
    let active = ConfigSchema.parse({
      providers: { openai: { apiKey: 'synthetic-env-key' } },
      tools: { braveApiKey: 'synthetic-brave', exec: { defaultShell: 'pwsh' } },
      mcp: { injected: { command: 'synthetic-command', env: { SECRET: 'synthetic-mcp' } } },
    })
    const store = new ConfigStore({ configPath, getConfig: () => active, onChanged: value => { active = value } })
    await store.update(raw => ({ ...raw, agent: { model: 'gpt-6-astra@copilot' } }))
    assert.equal(active.providers.openai.apiKey, 'synthetic-env-key')
    assert.equal(active.tools.braveApiKey, 'synthetic-brave')
    assert.equal(active.tools.exec?.defaultShell, 'pwsh')
    assert.equal(active.mcp.servers[0].name, 'injected')
    assert.doesNotMatch(await readFile(configPath, 'utf8'), /synthetic-|pwsh|injected/)
  })
})

test('configuration loads once, returns isolated snapshots and restores internal writes after restart', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({ agent: { model: 'first@copilot' } }))
    const store = new ConfigStore({ configPath })
    const snapshot = await store.read()
    snapshot.agent = { model: 'mutated-copy' }
    await writeFile(configPath, JSON.stringify({ agent: { model: 'external-edit' } }))
    assert.deepEqual((await store.read()).agent, { model: 'first@copilot' })
    await store.update(raw => ({ ...raw, agent: { ...(raw.agent as object), reasoningEffort: 'high' } }))
    const restored = new ConfigStore({ configPath })
    assert.deepEqual((await restored.read()).agent, { model: 'first@copilot', reasoningEffort: 'high' })
  })
})

test('queued updates wait for activation and merge against the last committed snapshot', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, '{}')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let changes = 0
    const store = new ConfigStore({ configPath, onChanged: async () => {
      if (++changes === 1) { entered.resolve(); await release.promise }
    } })
    const first = store.update(raw => ({ ...raw, agent: { model: 'gpt-6-astra@copilot' } }))
    await entered.promise
    const second = store.update(raw => ({ ...raw, agent: { ...(raw.agent as object), reasoningEffort: 'high' } }))
    assert.deepEqual(await store.read(), {})
    release.resolve()
    await Promise.all([first, second])
    assert.deepEqual((await store.read()).agent, { model: 'gpt-6-astra@copilot', reasoningEffort: 'high' })
  })
})

test('failed asynchronous activation rolls back disk and memory without poisoning later updates', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, '{}')
    let fail = true
    const store = new ConfigStore({ configPath, onChanged: async () => {
      await Promise.resolve()
      if (fail) throw new Error('synthetic activation failure')
    } })
    await assert.rejects(store.update(() => ({ agent: { model: 'failed' } })), /previous file was restored/)
    assert.equal(await readFile(configPath, 'utf8'), '{}')
    assert.deepEqual(await store.read(), {})
    fail = false
    await store.update(() => ({ agent: { model: 'saved' } }))
    assert.deepEqual((await new ConfigStore({ configPath }).read()).agent, { model: 'saved' })
  })
})
