import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { BUILTIN_AGENT_VERSIONS } from '../agent/types/versions.ts'
import { AppProviderConfigStore, ProjectConfigStore } from '../projects/config-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { appAgentVersionDefaultsPlugin } from './agent-version-routes.ts'
import { ConfigSchema } from './schema.ts'

test('every built-in Agent version references a shipped definition and each default exists', async () => {
  const definitions = new Map((await getBuiltinAgentTypes()).map(agent => [agent.name, agent]))
  const ids = new Set<string>()
  for (const role of BUILTIN_AGENT_VERSIONS) {
    assert(role.versions.some(option => option.version === role.defaultVersion))
    for (const { agentType } of role.versions) {
      assert(!ids.has(agentType), `${agentType} must be a stable, unique definition ID`)
      ids.add(agentType)
      assert(definitions.has(agentType), `${agentType} must be shipped`)
      assert.equal(definitions.get(agentType)?.model, undefined)
    }
  }
})

test('app prompt default persists independently and respects the deployment override', async t => {
  const key = 'SHADOW_BUILTIN_PROMPT_VERSION'
  const previous = process.env[key]
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  delete process.env[key]
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    const initial = { agent: { model: 'synthetic' }, agentVersionDefaults: { general: 'v1' } }
    await writeFile(configPath, JSON.stringify(initial))
    let active = ConfigSchema.parse(initial)
    const store = new AppProviderConfigStore({ configPath, getConfig: () => active, onChanged: changed => { active = changed } })
    const project = new ProjectConfigStore({ configPath: join(root, 'project.json'), home: root, getSharedConfig: () => active })
    await project.init()
    const app = new Hono()
    appAgentVersionDefaultsPlugin(store, () => active)(app)
    const path = '/api/app/agent-version-defaults'
    const patch = (body: unknown) => app.request(path, { method: 'PATCH', body: JSON.stringify(body) })
    const get = async () => (await app.request(path)).json()
    assert.deepEqual(await get(), { version: 'v2', source: 'builtin' })
    for (const body of [[], {}, { general: 'v1' }, { version: 'latest' }, { version: 1 }, { version: 'v1', extra: true }]) {
      assert.equal((await patch(body)).status, 400)
    }
    assert.deepEqual(await (await patch({ version: 'v1' })).json(), { version: 'v1', source: 'app' })
    assert.deepEqual(await get(), { version: 'v1', source: 'app' })
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { ...initial, builtinPromptVersion: 'v1' })
    assert.equal(project.current().builtinPromptVersion, 'v1')
    await assert.rejects(project.update(previous => ({ ...previous, builtinPromptVersion: 'v2' })), /App settings/)
    await project.updateModelDefaults({ model: 'project-model' })
    assert.equal(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')).builtinPromptVersion, undefined)
    process.env[key] = 'v2'
    assert.deepEqual(await get(), { version: 'v2', source: 'environment' })
    assert.equal((await patch({ version: 'v2' })).status, 409)
    process.env[key] = 'invalid'
    assert.deepEqual(await get(), { version: null, source: 'environment' })
    assert.equal((await patch({ version: 'v2' })).status, 409)
    delete process.env[key]
    assert.deepEqual(await get(), { version: 'v1', source: 'app' })
  })
})
