import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { AppProviderConfigStore, ProjectConfigStore } from '../projects/config-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { appCompactionPlugin } from './compaction-routes.ts'
import { ConfigSchema } from './schema.ts'

test('App Compact v2 defaults on, persists opt-out and is inherited live by Projects', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    const projectPath = join(root, 'project.json')
    const initial = { agent: { model: 'synthetic', autoHandoff: false, handoffMaxThreshold: 0.9 } }
    await writeFile(configPath, JSON.stringify(initial))
    await writeFile(projectPath, JSON.stringify({ agent: { compactV2: false, autoHandoff: false } }))
    let active = ConfigSchema.parse(initial)
    const store = new AppProviderConfigStore({ configPath, getConfig: () => active, onChanged: changed => { active = changed } })
    const project = new ProjectConfigStore({ configPath: projectPath, home: root, getSharedConfig: () => active })
    await project.init()
    const app = new Hono()
    appCompactionPlugin(store, () => active)(app)
    const path = '/api/app/compaction'
    const get = () => app.request(path)
    const patch = (body: unknown) => app.request(path, { method: 'PATCH', body: JSON.stringify(body) })
    assert.deepEqual(await (await get()).json(), { compactV2: true })
    assert.equal(project.current().agent.compactV2, true, 'stale Project value cannot override the App policy')
    for (const body of [null, {}, { compactV2: 'false' }, { compactV2: false, autoHandoff: true }]) {
      assert.equal((await patch(body)).status, 400)
    }
    assert.deepEqual(await (await patch({ compactV2: false })).json(), { compactV2: false })
    assert.deepEqual(await (await get()).json(), { compactV2: false })
    assert.equal(project.current().agent.compactV2, false)
    assert.equal(project.current().agent.autoHandoff, false)
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { agent: { ...initial.agent, compactV2: false } })
    await assert.rejects(project.update(previous => ({ ...previous, agent: { compactV2: true } })), /App settings/)
    await project.updateModelDefaults({ model: 'project-model' })
    assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).agent.compactV2, undefined)
    assert.deepEqual(await (await patch({ compactV2: true })).json(), { compactV2: true })
    assert.equal(project.current().agent.compactV2, true)
  })
})
