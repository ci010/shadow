import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '../config/schema.ts'
import { redactConfig } from '../config/store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { AppProviderConfigStore, OrganizationConfigStore } from './config-store.ts'

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
    const create = (id: string) => new OrganizationConfigStore({
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
    fresh.refreshShared()
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
