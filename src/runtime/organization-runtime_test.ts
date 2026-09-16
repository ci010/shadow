import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '../config/schema.ts'
import { startMainRuntime } from './main/start.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { organizationPaths } from '../organizations/contracts.ts'

test('one host concurrently serves independent org Homes, defaults, sessions and project ownership', { timeout: 60000 }, async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const aFolder = join(root, 'project-a')
    const bFolder = join(root, 'project-b')
    await Promise.all([mkdir(home), mkdir(aFolder), mkdir(bFolder)])
    await writeFile(join(home, 'SOUL.md'), '# Legacy-only identity\nlegacy-org-sentinel')
    const legacy = new JsonlSessionStore(join(home, '.sessions'))
    await legacy.init()
    await legacy.saveState('web:legacy-chat', { sessionId: 'web:legacy-chat', segmentIndex: 0 })
    const reservation = createServer().listen({ host: '127.0.0.1', port: 0 })
    await once(reservation, 'listening')
    const address = reservation.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const config = ConfigSchema.parse({ agent: { workspace: home, model: 'legacy@openai' },
      providers: { openai: { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1' } }, channels: {}, mcp: {} })
    const runtime = await startMainRuntime(config, { gateway: { host: '127.0.0.1', port: address.port, launchCredential: 'fixture-token' } })
    const request = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    try {
      const defaultPrefix = '/organizations/default'
      const created = await request('/api/organizations', 'POST', { name: 'Independent' })
      assert.equal(created.status, 201)
      const { organization, runtime: status } = await created.json()
      assert.equal(status.state, 'ready')
      const prefix = `/organizations/${organization.id}`
      assert.equal((await (await request('/api/organizations')).json()).organizations.length, 2)
      const [defaultGraph, freshGraph] = await Promise.all([
        request(`${defaultPrefix}/api/sessions/graph`).then(r => r.json()),
        request(`${prefix}/api/sessions/graph`).then(r => r.json()),
      ])
      assert.equal(defaultGraph.sessions[0].sessionId, 'web:legacy-chat')
      assert.equal(defaultGraph.sessions[0].organizationId, 'default')
      assert.deepEqual(freshGraph.sessions, [])
      assert.equal((await request(`${prefix}/api/sessions/web%3Alegacy-chat/files`)).status, 404)
      const oldDefaults = await (await request(`${defaultPrefix}/api/config`)).json()
      const newDefaults = await (await request(`${prefix}/api/config`)).json()
      assert.equal(oldDefaults.agent.model, 'legacy@openai')
      assert.notEqual(oldDefaults.agent.workspace, newDefaults.agent.workspace)
      assert.notEqual(newDefaults.agent.model, 'legacy@openai')
      assert.deepEqual(newDefaults.mcp, {})
      const changed = await request(`${prefix}/api/config`, 'PATCH', { ...newDefaults, agent: { ...newDefaults.agent, model: 'independent@openai' } })
      assert.equal(changed.status, 200, await changed.clone().text())
      assert.equal((await (await request('/api/config')).json()).agent.model, 'legacy@openai')
      const updated = await changed.json()
      const disabled = await request(`${prefix}/api/config`, 'PATCH', { ...updated, learning: { ...updated.learning, enabled: false } })
      assert.equal(disabled.status, 200)
      assert.equal((await (await request(`${prefix}/api/learning`)).json()).enabled, false)
      assert.equal((await (await request(`${defaultPrefix}/api/learning`)).json()).enabled, true)
      const modelPatch = await request(`${prefix}/api/config/model-defaults`, 'PATCH', { temperature: 0.2 })
      assert.equal(modelPatch.status, 200)
      assert.equal((await modelPatch.json()).temperature, 0.2)
      const providerMutation = await request(`${prefix}/api/config`, 'PATCH', { ...updated, providers: { openai: { apiKey: 'not-allowed' } } })
      assert.equal(providerMutation.status, 400)
      const a = await (await request(`${defaultPrefix}/api/projects/register`, 'POST', { path: aFolder })).json()
      const b = await (await request(`${prefix}/api/projects/register`, 'POST', { path: bFolder })).json()
      assert.equal((await request(`${prefix}/api/projects/register`, 'POST', { path: aFolder })).status, 409)
      const childFolder = join(aFolder, 'nested')
      await mkdir(childFolder)
      assert.equal((await request(`${prefix}/api/projects/register`, 'POST', { path: childFolder })).status, 409)
      assert.equal((await request(`${prefix}/api/projects/${a.project.id}/sessions`, 'POST', {})).status, 404)
      const sessionResponse = await request(`${prefix}/api/projects/${b.project.id}/sessions`, 'POST', {})
      assert.equal(sessionResponse.status, 200)
      const { sessionId } = await sessionResponse.json()
      const graph = await (await request(`${prefix}/api/sessions/graph`)).json()
      assert.equal(graph.sessions[0].sessionId, sessionId)
      assert.equal(graph.sessions[0].organizationId, organization.id)
      const contextResponse = await request(`${prefix}/api/sessions/${encodeURIComponent(sessionId)}/context`)
      assert.equal(contextResponse.status, 200, await contextResponse.clone().text())
      const context = await contextResponse.json()
      assert(!context.systemPrompt.includes('legacy-org-sentinel'))
      assert.equal((await request(`${defaultPrefix}/api/sessions/${encodeURIComponent(sessionId)}/details`)).status, 404)
      const unavailableRemote = await request(`${prefix}/api/sessions/remote`, 'POST', { nodeId: 'child', capabilityId: 'folder' })
      assert.equal(unavailableRemote.status, 503)
      assert.equal((await unavailableRemote.json()).error, 'remote_workdir_unavailable')
      const orgPaths = organizationPaths(`${home}.organizations`, organization.id)
      assert(!(await readFile(orgPaths.configPath, 'utf8')).includes('fixture-key'))
      assert((await readFile(join(home, 'SOUL.md'), 'utf8')).includes('legacy-org-sentinel'))
      const oldChat = await (await request(`${defaultPrefix}/api/projects/${a.project.id}/sessions`, 'POST', {})).json()
      const movedResponse = await request(`${defaultPrefix}/api/projects/${a.project.id}/move`, 'POST', { targetOrganizationId: organization.id })
      assert.equal(movedResponse.status, 200, await movedResponse.clone().text())
      const moved = (await movedResponse.json()).project
      assert.notEqual(moved.id, a.project.id)
      const oldKey = encodeURIComponent(oldChat.sessionId)
      assert.equal((await request(`${defaultPrefix}/api/sessions/${oldKey}`)).status, 200)
      assert.equal((await request(`${defaultPrefix}/api/sessions/${oldKey}/details`)).status, 200)
      assert.equal((await request(`${defaultPrefix}/api/sessions/${oldKey}/files`)).status, 409)
      assert.equal((await request(`${defaultPrefix}/api/chat/send`, 'POST', {
        chatId: oldChat.chatId, content: '/compact', stream: false,
      })).status, 409)
      assert.equal((await request(`${prefix}/api/sessions/${oldKey}/details`)).status, 404)
      const fresh = await (await request(`${prefix}/api/projects/${moved.id}/sessions`, 'POST', {})).json()
      const freshContext = await (await request(`${prefix}/api/sessions/${encodeURIComponent(fresh.sessionId)}/context`)).json()
      assert(!freshContext.systemPrompt.includes('legacy-org-sentinel'))
      const removed = await request(`${prefix}/api/projects/${moved.id}`, 'DELETE')
      assert.equal(removed.status, 200, await removed.clone().text())
      assert.deepEqual(await removed.json(), { removed: true, projectId: moved.id })
      assert.equal((await request(`${prefix}/api/sessions/${encodeURIComponent(fresh.sessionId)}/files`)).status, 409)
      assert.equal((await request(`${prefix}/api/sessions/${encodeURIComponent(sessionId)}/files`)).status, 200)
    } finally { await runtime.shutdown(); await runtime.finished }
  })
})
