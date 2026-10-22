import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ConfigSchema } from './schema.ts'
import { loadConfig } from './loader.ts'
import { ConfigStore, redactConfig } from './store.ts'
import { AppProviderConfigStore, ProjectConfigStore } from '../projects/config-store.ts'
import { projectConfigPlugin } from '../projects/config-routes.ts'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { appWebSearchPlugin } from './web-search-routes.ts'
import { WEB_SEARCH_KEY_FIELDS, webSearchStatus, WebSearchPatchSchema } from './web-search.ts'

test('web search configuration validates selection and strictly validates patches', () => {
  for (const provider of ['auto', 'firecrawl', 'brave', 'exa', 'tavily']) {
    assert.equal(ConfigSchema.parse({ tools: { webSearchProvider: provider } }).tools.webSearchProvider, provider)
  }
  assert.equal(ConfigSchema.safeParse({ tools: { webSearchProvider: 'unknown' } }).success, false)
  for (const patch of [[], null, { provider: 'unknown' }, { apiKeys: { exa: '' } },
    { apiKeys: { tavily: 12 } }, { apiKeys: { unexpected: 'synthetic' } }, { projectId: 'one' }]) {
    assert.equal(WebSearchPatchSchema.safeParse(patch).success, false)
  }
  assert.deepEqual(WebSearchPatchSchema.parse({ apiKeys: { exa: ' synthetic ', brave: null } }),
    { apiKeys: { exa: 'synthetic', brave: null } })
  assert.equal(webSearchStatus({ webSearchProvider: 'exa' }).ready, false)
  assert.equal(webSearchStatus({}).ready, true)
})

test('App search routes authenticate, expose presence only, and preserve unrelated configuration', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    const initial = {
      agent: { workspace: root }, providers: { openai: { apiKey: 'synthetic-model-key' } },
      tools: { firecrawlApiKey: 'synthetic-firecrawl', exec: { defaultShell: 'pwsh' } },
    }
    await writeFile(configPath, JSON.stringify(initial))
    let active = ConfigSchema.parse(initial)
    const store = new AppProviderConfigStore({ configPath, getConfig: () => active, onChanged: value => { active = value } })
    const app = new Hono()
    const credential = 'synthetic-launch-credential'
    registerGatewayRoutes(app, [appWebSearchPlugin(store, () => active)], { launchCredential: credential })
    const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }
    const request = (body?: unknown) => app.request('/api/app/web-search', {
      headers, ...(body === undefined ? {} : { method: 'PATCH', body: JSON.stringify(body) }),
    })
    assert.equal((await app.request('/api/app/web-search')).status, 401)
    assert.equal((await app.request('/api/app/web-search', { method: 'PATCH', body: '{}' })).status, 401)
    assert.equal((await app.request('/api/app/web-search', { method: 'PATCH', headers, body: '{' })).status, 400)
    assert.equal((await request({ tools: {} })).status, 400)
    const before = await request()
    assert.equal(before.headers.get('cache-control'), 'no-store')
    assert.doesNotMatch(await before.text(), /synthetic-|ApiKey/)
    const saved = await request({ provider: 'exa', apiKeys: { exa: 'synthetic-exa', tavily: 'synthetic-tavily', brave: 'synthetic-brave' } })
    assert.equal(saved.status, 200)
    assert.equal(saved.headers.get('cache-control'), 'no-store')
    const status = await saved.json()
    assert.deepEqual(status, {
      provider: 'exa', effectiveProvider: 'exa', ready: true,
      keys: { firecrawl: true, brave: true, exa: true, tavily: true },
    })
    const file = JSON.parse(await readFile(configPath, 'utf8'))
    assert.deepEqual(file.agent, initial.agent)
    assert.deepEqual(file.providers, initial.providers)
    assert.deepEqual(file.tools.exec, initial.tools.exec)
    assert.equal(file.tools.exaApiKey, 'synthetic-exa')
    assert.equal(file.tools.firecrawlApiKey, 'synthetic-firecrawl')
    await request({ apiKeys: { exa: null } })
    assert.equal(active.tools.exaApiKey, '')
    assert.equal((await (await request()).json()).ready, false, 'Removing the selected key does not switch providers')
    await request({ provider: 'auto' })
    assert.equal((await (await request()).json()).effectiveProvider, 'firecrawl')
    const restored = ConfigSchema.parse(await new AppProviderConfigStore({ configPath }).read())
    assert.deepEqual(webSearchStatus(restored.tools), webSearchStatus(active.tools))
    assert.doesNotMatch(JSON.stringify(redactConfig(file)), /synthetic-/)
  })
})

test('App search changes roll back when activation fails without exposing credentials', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    await writeFile(configPath, '{}')
    const active = ConfigSchema.parse({})
    const store = new AppProviderConfigStore({
      configPath, getConfig: () => active,
      onChanged: () => { throw new Error('synthetic-private-error') },
    })
    const app = new Hono()
    appWebSearchPlugin(store, () => active)(app)
    const response = await app.request('/api/app/web-search', {
      method: 'PATCH', body: JSON.stringify({ provider: 'tavily', apiKeys: { tavily: 'synthetic-private-key' } }),
    })
    assert.equal(response.status, 500)
    assert.doesNotMatch(await response.text(), /synthetic-/)
    assert.equal(await readFile(configPath, 'utf8'), '{}')
    assert.equal((await (await app.request('/api/app/web-search')).json()).provider, 'auto')
  })
})

test('all Projects inherit live App search settings without persisting or overriding shared keys', async () => {
  await withTempWorkspace(async root => {
    let shared = ConfigSchema.parse({
      tools: { webSearchProvider: 'exa', exaApiKey: 'synthetic-app-exa', braveApiKey: 'synthetic-app-brave' },
    })
    const projects = ['a', 'b'].map(id => new ProjectConfigStore({
      configPath: join(root, `${id}.json`), home: join(root, id), getSharedConfig: () => shared,
    }))
    await projects[0].init(shared)
    await projects[1].init()
    for (const store of projects) {
      assert.equal(store.current().tools.exaApiKey, 'synthetic-app-exa')
      assert.equal(store.current().tools.webSearchProvider, 'exa')
      await store.update(raw => redactConfig(raw))
      const saved = await readFile(store.configPath, 'utf8')
      assert.doesNotMatch(saved, /synthetic-app|exaApiKey|braveApiKey|webSearchProvider/)
      const app = new Hono()
      projectConfigPlugin(store)(app)
      for (const patch of [{ exaApiKey: 'synthetic-injected' }, { webSearchProvider: 'tavily' }, { tavilyApiKey: 'synthetic-injected' }]) {
        const raw = await store.read()
        const response = await app.request('/api/config', {
          method: 'PATCH', body: JSON.stringify({ ...raw, tools: { ...(raw.tools as object), ...patch } }),
        })
        assert.equal(response.status, 400)
      }
      assert.equal((await app.request('/api/app/web-search', { method: 'PATCH', body: '{}' })).status, 404)
    }
    shared = ConfigSchema.parse({ tools: { webSearchProvider: 'tavily', tavilyApiKey: 'synthetic-app-tavily' } })
    for (const store of projects) {
      await store.refreshShared()
      assert.equal(store.current().tools.tavilyApiKey, 'synthetic-app-tavily')
      assert.equal(store.current().tools.exaApiKey, undefined, 'Removed shared keys do not survive in Project memory')
      await store.update(raw => ({ ...raw, tools: { ...(raw.tools as object), restrictToWorkspace: true } }))
      assert.equal(store.current().tools.restrictToWorkspace, true)
      assert.doesNotMatch(await readFile(store.configPath, 'utf8'), /synthetic-app|ApiKey|webSearchProvider/)
    }
    const restored = new ProjectConfigStore({
      configPath: projects[0].configPath, home: join(root, 'a'), getSharedConfig: () => shared,
    })
    await restored.init()
    assert.equal(restored.current().tools.tavilyApiKey, 'synthetic-app-tavily')
  })
})

test('legacy Project search fields are ignored, not promoted or replaced by App credentials', async t => {
  await withTempWorkspace(async root => {
    const warning = t.mock.method(console, 'warn', () => {})
    const configPath = join(root, 'legacy.json')
    await writeFile(configPath, JSON.stringify({ tools: { firecrawlApiKey: 'synthetic-old-key', webSearchProvider: 'firecrawl' } }))
    const store = new ProjectConfigStore({
      configPath, home: join(root, 'home'),
      getSharedConfig: () => ConfigSchema.parse({ tools: { webSearchProvider: 'exa', exaApiKey: 'synthetic-app-key' } }),
    })
    await store.init()
    assert.equal(store.current().tools.firecrawlApiKey, undefined)
    assert.equal(store.current().tools.exaApiKey, 'synthetic-app-key')
    assert.equal(warning.mock.callCount(), 1)
    assert.doesNotMatch(String(warning.mock.calls[0].arguments), /synthetic-/)
    await store.update(raw => redactConfig(raw))
    const text = await readFile(configPath, 'utf8')
    assert.match(text, /synthetic-old-key/)
    assert.doesNotMatch(text, /synthetic-app-key/)
  })
})

test('environment search keys load, survive unrelated App saves, and remain off disk until explicitly edited', async () => {
  await withTempWorkspace(async root => {
    const variables = ['FIRECRAWL_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY']
    const previous = variables.map(name => process.env[name])
    try {
      variables.forEach((name, index) => { process.env[name] = `synthetic-env-${index}` })
      const configPath = join(root, 'env.json')
      await writeFile(configPath, '{}')
      let active = await loadConfig(configPath)
      WEB_SEARCH_KEY_FIELDS.forEach((field, index) => assert.equal(active.tools[field], `synthetic-env-${index}`))
      const store = new AppProviderConfigStore({ configPath, getConfig: () => active, onChanged: value => { active = value } })
      await store.updateWebSearch({ provider: 'tavily' })
      await store.updateModelDefaults({ model: 'test@copilot' })
      WEB_SEARCH_KEY_FIELDS.forEach((field, index) => assert.equal(active.tools[field], `synthetic-env-${index}`))
      assert.doesNotMatch(await readFile(configPath, 'utf8'), /synthetic-env|ApiKey/)
      await store.updateWebSearch({ apiKeys: { tavily: null, exa: 'synthetic-saved-exa' } })
      assert.equal(active.tools.tavilyApiKey, '')
      assert.equal(active.tools.exaApiKey, 'synthetic-saved-exa')
      await store.updateModelDefaults({ model: null })
      assert.equal(active.tools.tavilyApiKey, '')
      const file = await new ConfigStore({ configPath }).read()
      assert.deepEqual(file.tools, { webSearchProvider: 'tavily', tavilyApiKey: '', exaApiKey: 'synthetic-saved-exa' })
    } finally {
      variables.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name]
        else process.env[name] = previous[index]
      })
    }
  })
})
