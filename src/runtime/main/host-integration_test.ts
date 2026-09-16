import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '../../config/schema.ts'
import { startMainRuntime } from './start.ts'
import type { MainRuntimeHandle } from './contracts.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import type { OrganizationRecord } from '../../organizations/contracts.ts'
import type { ProjectRecord } from '../../projects/contracts.ts'
import type { BotInstanceStatus } from '../../channels/setup-contract.ts'

test('real Main concurrently isolates org projects, Home prompts, defaults, bots and restart state', { timeout: 90_000 }, async () => {
  await withTempWorkspace(async root => {
    const previousCwd = process.cwd()
    const environmentKeys = ['GITHUB_COPILOT_TOKEN_DIR', 'GITHUB_COPILOT_ACCESS_TOKEN_FILE',
      'GITHUB_COPILOT_API_KEY_FILE', 'GITHUB_COPILOT_MODELS_CACHE_FILE', 'OTEL_DB_PATH', 'VITE_DEV_URL', 'UI_DIST_DIR']
    const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]))
    let runtime: MainRuntimeHandle | undefined
    try {
      for (const key of environmentKeys) delete process.env[key]
      process.env.GITHUB_COPILOT_TOKEN_DIR = join(root, 'empty-auth')
      process.chdir(root)
      const home = join(root, 'legacy-home')
      const folderA = join(root, 'A-private-project')
      const folderB = join(root, 'B-private-project')
      for (const directory of [home, folderA, folderB]) await mkdir(directory)
      await writeFile(join(home, 'SOUL.md'), 'ORG_A_PRIVATE_IDENTITY_7f01\n')
      await writeFile(join(home, 'unknown-user-file.bin'), Buffer.from([0, 41, 255]))
      await writeFile(join(folderA, 'sentinel.txt'), 'A file only')
      await writeFile(join(folderB, 'sentinel.txt'), 'B file only')
      const reservation = createServer().listen(0, '127.0.0.1')
      await once(reservation, 'listening')
      const address = reservation.address()
      assert(address && typeof address !== 'string')
      const port = address.port
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
      const config = ConfigSchema.parse({
        agent: { workspace: home, model: 'fixture@openai', sessionStorage: 'sqlite' },
        providers: { openai: { apiKey: 'synthetic-unused-key', baseUrl: 'http://127.0.0.1:1/v1' } },
        channels: {}, mcp: {},
      })
      const configPath = join(root, 'fixture.config.json')
      await writeFile(configPath, JSON.stringify(config))
      const credential = randomUUID()
      const options = { configPath, localNodeId: 'fixture-main', gateway: { host: '127.0.0.1', port, launchCredential: credential } }
      const base = `http://127.0.0.1:${port}`
      async function request(path: string, method = 'GET', body?: unknown) {
        return fetch(base + path, {
          method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        })
      }
      async function json<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
        const response = await request(path, method, body)
        assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`)
        return response.json() as Promise<T>
      }
      runtime = await startMainRuntime(config, options)
      await runtime.ready
      assert.equal((await fetch(base + '/api/organizations')).status, 401)
      const initial = await json<{ organizations: OrganizationRecord[] }>('/api/organizations')
      assert.deepEqual(initial.organizations.map(org => org.id), ['default'])
      const created = await json<{ organization: OrganizationRecord; runtime: { state: string } }>(
        '/api/organizations', 'POST', { name: 'Second organization' }, 201)
      assert.equal(created.runtime.state, 'ready')
      const a = '/organizations/default'
      const b = `/organizations/${created.organization.id}`
      const before = await json<{ model: string }>(b + '/api/config/model-defaults')
      await json(a + '/api/config/model-defaults', 'PATCH', { model: 'org-a@openai', temperature: 0.2 })
      assert.deepEqual(await json(b + '/api/config/model-defaults'), before)
      const projectA = (await json<{ project: ProjectRecord }>(a + '/api/projects/register', 'POST', { path: folderA })).project
      const projectB = (await json<{ project: ProjectRecord }>(b + '/api/projects/register', 'POST', { path: folderB })).project
      assert.equal((await request(b + '/api/projects/register', 'POST', { path: folderA })).status, 409)
      assert.equal((await request(b + `/api/projects/${projectA.id}/files`)).status, 404)
      assert.deepEqual((await json<{ projects: ProjectRecord[] }>(a + '/api/projects')).projects.map(project => project.id), [projectA.id])
      assert.deepEqual((await json<{ projects: ProjectRecord[] }>(b + '/api/projects')).projects.map(project => project.id), [projectB.id])
      const sessionA = await json<{ sessionId: string }>(a + `/api/projects/${projectA.id}/sessions`, 'POST', {})
      const sessionB = await json<{ sessionId: string }>(b + `/api/projects/${projectB.id}/sessions`, 'POST', {})
      const aSession = a + `/api/sessions/${encodeURIComponent(sessionA.sessionId)}`
      const bSession = b + `/api/sessions/${encodeURIComponent(sessionB.sessionId)}`
      const [contextA, contextB] = await Promise.all([
        json<{ systemPrompt: string }>(aSession + '/context'),
        json<{ systemPrompt: string }>(bSession + '/context'),
      ])
      assert(contextA.systemPrompt.includes('ORG_A_PRIVATE_IDENTITY_7f01'))
      assert(!contextB.systemPrompt.includes('ORG_A_PRIVATE_IDENTITY_7f01'))
      assert(!contextA.systemPrompt.includes('B-private-project'))
      assert(!contextB.systemPrompt.includes('A-private-project'))
      for (const suffix of ['/context', '/files', '/preview?path=sentinel.txt', '/yield']) {
        assert.equal((await request(b + `/api/sessions/${encodeURIComponent(sessionA.sessionId)}${suffix}`)).status, 404)
      }
      assert((await (await request(aSession + '/preview?path=sentinel.txt')).text()).includes('A file only'))
      assert((await (await request(bSession + '/preview?path=sentinel.txt')).text()).includes('B file only'))
      const orgConfigA = await json<Record<string, unknown>>(a + '/api/config')
      const learning = orgConfigA.learning
      assert(learning && typeof learning === 'object')
      await json(a + '/api/config', 'PATCH', { ...orgConfigA, learning: { ...learning, enabled: false } })
      assert.equal((await json<{ enabled: boolean }>(a + '/api/learning')).enabled, false)
      assert.equal((await json<{ enabled: boolean }>(b + '/api/learning')).enabled, true)
      const addBot = async (scope: string, name: string) =>
        (await json<{ channel: BotInstanceStatus }>(scope + '/api/channels', 'POST',
          { platform: 'qq', displayName: name, config: { enabled: false } }, 201)).channel
      const botsA = await Promise.all([addBot(a, 'Bot one'), addBot(a, 'Bot two')])
      const botB = await addBot(b, 'Bot one')
      assert.notEqual(botsA[0].id, botsA[1].id)
      assert.equal(botsA[0].organizationId, 'default')
      assert.equal(botB.organizationId, created.organization.id)
      assert.equal((await request(b + `/api/channels/${botsA[0].id}`, 'PATCH', { displayName: 'wrong owner' })).status, 404)
      assert.equal((await json<{ channels: BotInstanceStatus[] }>(a + '/api/channels')).channels.length, 2)
      assert.equal((await json<{ channels: BotInstanceStatus[] }>(b + '/api/channels')).channels.length, 1)
      for (const model of ['', 12, {}, false]) {
        const response = await request(b + '/api/chat/send', 'POST', {
          chatId: 'invalid-model', content: '/help', config: { model }, stream: false,
        })
        assert.equal(response.status, 400)
        assert.equal((await response.json()).error, 'invalid_model')
      }
      assert.equal((await request(b + '/api/sessions/web%3Ainvalid-model/details')).status, 404)
      await json(b + '/api/chat/send', 'POST', {
        chatId: 'model-and-identity', content: '/help', config: { model: 'selected@openai' }, stream: false,
      })
      const selected = await json<{ sessions: Array<{ sessionId: string; config?: { model?: string } }> }>(b + '/api/sessions/graph')
      assert.equal(selected.sessions.find(session => session.sessionId === 'web:model-and-identity')?.config?.model, 'selected@openai')
      assert.deepEqual(await json(b + '/api/config/model-defaults'), before)
      const bConfig = await json<{ agent: { workspace: string } }>(b + '/api/config')
      const observedIdentity = JSON.parse(await readFile(join(bConfig.agent.workspace, 'memory', 'identities', 'index.json'), 'utf8'))
      assert.equal(observedIdentity.accountChats['web:web-user'], 'model-and-identity')
      assert.deepEqual(await readFile(join(home, 'unknown-user-file.bin')), Buffer.from([0, 41, 255]))
      await runtime.shutdown()
      await runtime.finished
      runtime = await startMainRuntime(config, options)
      await runtime.ready
      assert.equal((await json<{ organizations: OrganizationRecord[] }>('/api/organizations')).organizations.length, 2)
      assert.equal((await json<{ model: string }>(a + '/api/config/model-defaults')).model, 'org-a@openai')
      assert.equal((await json<{ enabled: boolean }>(a + '/api/learning')).enabled, false)
      assert.equal((await json<{ channels: BotInstanceStatus[] }>(a + '/api/channels')).channels.length, 2)
      assert.equal((await json<{ channels: BotInstanceStatus[] }>(b + '/api/channels')).channels.length, 1)
      assert.equal((await request(aSession + '/details')).status, 200)
      assert.equal((await request(bSession + '/details')).status, 200)
    } finally {
      if (runtime) { await runtime.shutdown(); await runtime.finished }
      process.chdir(previousCwd)
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
