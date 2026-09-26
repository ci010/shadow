import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '../config/schema.ts'
import { redactConfig } from '../config/store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { AppProviderConfigStore, ProjectConfigStore } from './config-store.ts'

test('existing Projects start with retired voice settings and keep unrelated configuration', async () => {
  await withTempWorkspace(async root => {
    const shared = ConfigSchema.parse({ providers: { openai: { apiKey: 'synthetic-shared-key' } } })
    const options = { configPath: join(root, 'project.json'), home: join(root, 'home'), getSharedConfig: () => shared }
    const original = JSON.stringify({
      voice: { enabled: true, sttUrl: 'http://127.0.0.1:1', timeoutMs: 30000 },
      agent: { model: 'project@openai' }, learning: { enabled: false }, channels: { web: { enabled: true } },
    })
    await writeFile(options.configPath, original)
    const store = new ProjectConfigStore(options)
    await store.init()
    assert.equal(Object.hasOwn(store.current(), 'voice'), false)
    assert.equal(store.current().agent.model, 'project@openai')
    assert.equal(store.current().providers.openai.apiKey, 'synthetic-shared-key')
    assert.deepEqual(store.current().learning, { ...shared.learning, enabled: false })
    assert.deepEqual(await store.persistedChannels(), { web: { enabled: true } })
    assert.equal(await readFile(options.configPath, 'utf8'), original)
    await store.updateModelDefaults({ reasoningEffort: 'high' })
    const persisted = JSON.parse(await readFile(options.configPath, 'utf8'))
    assert.equal(Object.hasOwn(persisted, 'voice'), false)
    assert.equal(Object.hasOwn(persisted, 'providers'), false)
    const restored = new ProjectConfigStore(options)
    await restored.init()
    assert.equal(restored.current().agent.model, 'project@openai')
    assert.equal(restored.current().agent.reasoningEffort, 'high')
    assert.deepEqual(restored.current().learning, { ...shared.learning, enabled: false })
    await assert.rejects(restored.update(raw => ({ ...raw, voice: { enabled: true } })), /voice/)
  })
})

test('unset project defaults inherit App values without persisting resolved choices', async () => {
  await withTempWorkspace(async root => {
    let shared = ConfigSchema.parse({})
    const options = { configPath: join(root, 'project.json'), home: join(root, 'home'), getSharedConfig: () => shared }
    const store = new ProjectConfigStore(options)
    await store.init()
    assert.equal(store.current().agent.model, 'gpt-6-astra@copilot')
    assert.deepEqual(store.modelDefaults().overrides, {})
    shared = ConfigSchema.parse({ agent: { model: 'other@copilot', reasoningEffort: 'high', thinking: { type: 'disabled' } } })
    await store.refreshShared()
    assert.equal(store.current().agent.model, 'other@copilot')
    assert.equal(store.current().agent.reasoningEffort, 'high')
    await store.update(raw => ({ ...raw, learning: { ...(raw.learning as object), enabled: false } }))
    const savedAgent = JSON.parse(await readFile(options.configPath, 'utf8')).agent
    assert.equal(savedAgent.workspace, options.home)
    for (const field of ['model', 'quickModel', 'temperature', 'thinking', 'reasoningEffort']) assert.equal(field in savedAgent, false)
    await store.updateModelDefaults({ model: 'other@copilot', reasoningEffort: 'medium' })
    shared = ConfigSchema.parse({ agent: { model: 'new-app@copilot', reasoningEffort: 'max' } })
    await store.refreshShared()
    assert.equal(store.current().agent.model, 'other@copilot', 'An explicit choice can pin the previously inherited value')
    assert.equal(store.current().agent.reasoningEffort, 'medium')
    assert.equal(store.current().agent.thinking, undefined, 'Clearing an App value clears inherited state too')
    await store.updateModelDefaults({ model: null })
    assert.equal(store.current().agent.model, 'new-app@copilot')
    assert.equal(store.current().agent.reasoningEffort, 'medium')
    const restored = new ProjectConfigStore(options)
    await restored.init()
    assert.deepEqual(restored.modelDefaults(), store.modelDefaults())
    await restored.updateModelDefaults({ reasoningEffort: null })
    assert.equal(restored.current().agent.reasoningEffort, 'max')
  })
})

test('App defaults can be cleared back to built-in defaults and preserve unrelated settings', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    await writeFile(configPath, JSON.stringify({ providers: { copilot: {} }, agent: { workspace: root } }))
    const store = new AppProviderConfigStore({ configPath })
    await store.updateModelDefaults({ model: 'custom@copilot', reasoningEffort: 'high' })
    assert.equal((await store.modelDefaults()).model, 'custom@copilot')
    await store.updateModelDefaults({ model: null, reasoningEffort: null })
    assert.equal((await store.modelDefaults()).model, 'gpt-6-astra@copilot')
    assert.equal((await store.modelDefaults()).reasoningEffort, 'medium')
    assert.deepEqual(await store.read(), { providers: { copilot: {} }, agent: { workspace: root } })
  })
})

test('org defaults persist independently while shared credentials never enter scoped config', async () => {
  await withTempWorkspace(async root => {
    let shared = ConfigSchema.parse({
      agent: { model: 'legacy@openai' }, channels: { qq: { appId: 'legacy', secret: 'fixture' } },
      providers: { openai: { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1' } },
      mcp: { legacy: { command: 'unused' } },
    })

    test('App provider setup persists connections without changing legacy model defaults or other host settings', async () => {
      await withTempWorkspace(async root => {
        const configPath = join(root, 'host-config.json')
        const original = { agent: { model: 'legacy@openai' }, providers: {}, learning: { reflectIntervalMs: 5000 } }
        await writeFile(configPath, JSON.stringify(original))
        let shared = ConfigSchema.parse(original)
        const store = new AppProviderConfigStore({ configPath, getConfig: () => shared, onChanged: value => { shared = value } })
        const provider = { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1' }
        await store.update(raw => ({
          ...raw, providers: { openai: provider }, agent: { model: 'probe@openai' }, learning: { reflectIntervalMs: 1 },
        }))
        assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { ...original, providers: { openai: provider } })
        assert.equal(shared.agent.model, original.agent.model)
        assert.equal(shared.learning.reflectIntervalMs, original.learning.reflectIntervalMs)
        assert.equal(shared.providers.openai.apiKey, provider.apiKey)
      })
    })
    const create = (id: string) => new ProjectConfigStore({
      configPath: join(root, id, 'config.json'), home: join(root, id, 'home'), getSharedConfig: () => shared,
    })
    const legacy = create('default')
    const fresh = create('new')
    await legacy.init(shared)
    await fresh.init()
    assert.equal(legacy.current().agent.model, 'legacy@openai')
    assert.deepEqual(fresh.current().channels, {})
    assert.deepEqual(fresh.current().mcp.servers, [])
    assert.equal(fresh.current().providers.openai.apiKey, 'fixture-key')
    assert.equal(await readFile(join(root, 'default', 'config.json'), 'utf8').then(text => text.includes('fixture-key')), false)
    await fresh.update(raw => ({ ...raw, agent: { ...(raw.agent as object), model: 'new@openai' } }))
    assert.equal(fresh.current().agent.model, 'new@openai')
    assert.equal(legacy.current().agent.model, 'legacy@openai')
    await fresh.update(raw => redactConfig(raw))
    await assert.rejects(fresh.update(raw => ({ ...raw, providers: { openai: { apiKey: 'injected' } } })), /Shared providers/)
    await assert.rejects(fresh.update(raw => ({ ...raw, agent: { ...(raw.agent as object), workspace: root } })), /Home/)
    shared = { ...shared, providers: { openai: { apiKey: 'rotated' } } }
    await fresh.refreshShared()
    assert.equal(fresh.current().providers.openai.apiKey, 'rotated')
    assert.equal(fresh.current().agent.model, 'new@openai')
    await fresh.update(raw => ({ ...raw, learning: { ...(raw.learning as object), enabled: false } }))
    await assert.rejects(fresh.update(raw => ({ ...raw, learning: { ...(raw.learning as object), enabled: 'false' } })), /boolean/)
    const restored = create('new')
    await restored.init()
    assert.equal(restored.current().agent.model, 'new@openai')
    assert.deepEqual(restored.current().learning, { ...fresh.current().learning, enabled: false })
  })
})
