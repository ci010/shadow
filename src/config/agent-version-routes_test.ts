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

test('app Agent settings validate, persist and resolve across Projects without changing model defaults', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    await writeFile(configPath, JSON.stringify({ agent: { model: 'synthetic' } }))
    let active = ConfigSchema.parse({ agent: { model: 'synthetic' } })
    const store = new AppProviderConfigStore({ configPath, getConfig: () => active, onChanged: changed => { active = changed } })
    const project = new ProjectConfigStore({ configPath: join(root, 'project.json'), home: root, getSharedConfig: () => active })
    await project.init()
    const app = new Hono()
    appAgentVersionDefaultsPlugin(store, () => active)(app)
    const path = '/api/app/agent-version-defaults'
    const patch = (body: unknown) => app.request(path, { method: 'PATCH', body: JSON.stringify(body) })
    const getSelected = async () => Object.fromEntries((await (await app.request(path)).json()).roles.map(
      (role: { role: string; selectedVersion: string }) => [role.role, role.selectedVersion],
    ))
    assert.deepEqual(await getSelected(), { general: 'v2', explore: 'v1', plan: 'v1', sub: 'v1', verify: 'v1' })
    for (const body of [[], { malicious: 'v1' }, { general: 'latest' }, { explore: 'v2' }, { general: 1 }, { agent: { model: 'changed' } }]) {
      assert.equal((await patch(body)).status, 400)
    }
    assert.equal((await patch({ general: 'v1' })).status, 200)
    assert.equal((await patch({ explore: 'v1' })).status, 200)
    assert.equal((await getSelected()).general, 'v1')
    const raw = JSON.parse(await readFile(configPath, 'utf8'))
    assert.deepEqual(raw.agentVersionDefaults, { general: 'v1', explore: 'v1' })
    assert.equal(raw.agent.model, 'synthetic')
    assert.deepEqual(project.current().agentVersionDefaults, raw.agentVersionDefaults)
    assert.equal(project.current().agent.model, 'synthetic')
    await assert.rejects(project.update(previous => ({ ...previous, agentVersionDefaults: { general: 'v2' } })), /App settings/)
    await project.updateModelDefaults({ model: 'project-model' })
    const projectRaw = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))
    assert.equal(projectRaw.agent.model, 'project-model')
    assert.equal(projectRaw.agentVersionDefaults, undefined)
  })
})
