import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ConfigStore } from './store.ts'
import { ConfigSchema } from './schema.ts'

test('stored voice settings are retired on read and removed only by a successful normal save', async t => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    const original = JSON.stringify({
      voice: { enabled: false, timeoutMs: 30000 },
      providers: { openai: { apiKey: 'synthetic-persisted-key' } },
      agent: { model: 'fixture@openai' }, customMetadata: { retained: true },
    })
    await writeFile(configPath, original)
    const warnings: string[] = []
    t.mock.method(console, 'warn', (message: string) => warnings.push(message))
    let fail = true
    const store = new ConfigStore({ configPath, onChanged: () => {
      if (fail) throw new Error('synthetic activation failure')
    } })
    const raw = await store.read()
    assert.equal(Object.hasOwn(raw, 'voice'), false)
    assert.equal(await readFile(configPath, 'utf8'), original)
    await store.read()
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /voice/)
    await assert.rejects(store.update(value => ({ ...value, voice: { enabled: true } })), /voice/)
    await assert.rejects(store.update(value => ({ ...value, agent: { reasoningEffort: 'invalid' } })), /reasoningEffort/)
    await assert.rejects(store.update(value => value), /previous file was restored/)
    assert.equal(await readFile(configPath, 'utf8'), original)
    fail = false
    await store.update(value => ({ ...value, agent: { model: 'updated@openai' } }))
    const expected = { ...raw, agent: { model: 'updated@openai' } }
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), expected)
    assert.deepEqual(await new ConfigStore({ configPath }).read(), expected)
    assert.equal(warnings.length, 1)
  })
})

test('retiring voice settings still preserves an external edit instead of overwriting it', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({ voice: { enabled: false } }))
    const store = new ConfigStore({ configPath })
    await store.read()
    const external = '{"voice":{"enabled":false},"agent":{"model":"external"}}'
    await writeFile(configPath, external)
    await assert.rejects(store.update(raw => raw), /changed on disk/)
    assert.equal(await readFile(configPath, 'utf8'), external)
  })
})

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

test('configuration snapshots are isolated and external edits block writes until restart', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({ agent: { model: 'first@copilot' } }))
    const store = new ConfigStore({ configPath })
    const snapshot = await store.read()
    snapshot.agent = { model: 'mutated-copy' }
    await writeFile(configPath, JSON.stringify({ agent: { model: 'external-edit' } }))
    assert.deepEqual((await store.read()).agent, { model: 'first@copilot' })
    await assert.rejects(store.update(raw => ({ ...raw, agent: { ...(raw.agent as object), reasoningEffort: 'high' } })), /changed on disk/)
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).agent, { model: 'external-edit' })
    const restored = new ConfigStore({ configPath })
    await restored.update(raw => ({ ...raw, agent: { ...(raw.agent as object), reasoningEffort: 'high' } }))
    assert.deepEqual((await new ConfigStore({ configPath }).read()).agent, { model: 'external-edit', reasoningEffort: 'high' })
  })
})

test('failed activation does not overwrite an external edit made while activating', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, '{}')
    const external = '{"agent":{"model":"external"}}'
    const store = new ConfigStore({ configPath, onChanged: async () => {
      await writeFile(configPath, external)
      throw new Error('synthetic activation failure')
    } })
    await assert.rejects(store.update(() => ({ agent: { model: 'attempted' } })), /external edit was preserved/)
    assert.equal(await readFile(configPath, 'utf8'), external)
    assert.deepEqual(await store.read(), {})
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

test('failed preparation leaves disk, memory and activation untouched', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, '{}')
    let activations = 0
    const store = new ConfigStore({
      configPath,
      beforeCommit: async () => {
        assert.equal(await readFile(configPath, 'utf8'), '{}')
        throw new Error('Indexing failed')
      },
      onChanged: () => { activations++ },
    })
    await assert.rejects(store.update(raw => ({ ...raw, mcp: { fixture: { command: 'synthetic' } } })), /Indexing failed/)
    assert.equal(await readFile(configPath, 'utf8'), '{}')
    assert.deepEqual(await store.read(), {})
    assert.equal(activations, 0)
  })
})

test('preparation preserves concurrent external edits and observes cancellation before writing', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'config.json')
    await writeFile(configPath, '{}')
    const external = '{"agent":{"model":"external"}}'
    const store = new ConfigStore({
      configPath, beforeCommit: async () => { await writeFile(configPath, external) },
    })
    await assert.rejects(store.update(raw => ({ ...raw, mcp: {} })), /changed on disk during preparation/)
    assert.equal(await readFile(configPath, 'utf8'), external)
    const controller = new AbortController()
    const aborting = new ConfigStore({
      configPath, beforeCommit: (_config, _raw, signal) => {
        assert.equal(signal, controller.signal)
        controller.abort()
      },
    })
    await assert.rejects(aborting.update(raw => ({ ...raw, mcp: {} }), controller.signal), { name: 'AbortError' })
    assert.equal(await readFile(configPath, 'utf8'), external)
  })
})
