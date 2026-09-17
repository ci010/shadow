import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ConfigSchema } from './schema.ts'
import { AppProviderConfigStore, ProjectConfigStore } from '../projects/config-store.ts'
import { appModelDefaultsPlugin } from './model-routes.ts'
import { projectConfigPlugin } from '../projects/config-routes.ts'
import { McpManager } from '../mcp/manager.ts'

test('App defaults accept unset fields and reject unrelated settings without changing provider credentials', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    await writeFile(configPath, JSON.stringify({ providers: { copilot: { apiKey: 'synthetic-private' } } }))
    const store = new AppProviderConfigStore({ configPath })
    const app = new Hono()
    appModelDefaultsPlugin(store)(app)
    const patch = (body: unknown) => app.request('/api/app/model-defaults', { method: 'PATCH', body: JSON.stringify(body) })
    for (const body of [{ workspace: root }, { providers: {} }, { model: '' }, { reasoningEffort: 'unknown' }, []]) {
      assert.equal((await patch(body)).status, 400)
    }
    const response = await patch({ model: 'gpt-6-astra@copilot', reasoningEffort: 'medium' })
    assert.equal(response.status, 200)
    assert.doesNotMatch(await response.text(), /synthetic-private|apiKey/)
    assert.equal((await patch({ model: null, reasoningEffort: null })).status, 200)
    assert.deepEqual((await (await app.request('/api/app/model-defaults')).json()).overrides, {})
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).providers.copilot.apiKey, 'synthetic-private')
  })
})

test('project config saves directly await MCP activation instead of observing filesystem changes', async () => {
  await withTempWorkspace(async root => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const catalog: string[][] = []
    const manager = new McpManager(async servers => {
      if (servers.length) { entered.resolve(); await release.promise }
      catalog.push(servers.map(server => server.name))
    })
    const store = new ProjectConfigStore({
      configPath: join(root, 'project.json'), home: join(root, 'home'),
      getSharedConfig: () => ConfigSchema.parse({}),
      onChanged: config => manager.load(config.mcp.servers),
    })
    await store.init()
    await manager.ensureLoaded()
    const app = new Hono()
    projectConfigPlugin(store)(app)
    const previous = await store.read()
    const saving = app.request('/api/config', {
      method: 'PATCH', body: JSON.stringify({ ...previous, mcp: { fixture: { command: 'synthetic-command' } } }),
    })
    await entered.promise
    assert.deepEqual(store.current().mcp.servers, [])
    release.resolve()
    assert.equal((await saving).status, 200)
    assert.deepEqual(catalog, [[], ['fixture']])
    await writeFile(store.configPath, JSON.stringify({ mcp: {} }))
    assert.deepEqual(store.current().mcp.servers.map(server => server.name), ['fixture'])
    assert.deepEqual(catalog, [[], ['fixture']])
    await manager.stop()
  })
})
