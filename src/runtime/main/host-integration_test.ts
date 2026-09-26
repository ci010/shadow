import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ConfigSchema } from '../../config/schema.ts'
import { startMainRuntime } from './start.ts'
import type { MainRuntimeHandle } from './contracts.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectPaths, type ProjectRecord } from '../../projects/contracts.ts'
import type { FolderRecord } from '../../folders/contracts.ts'
import type { BotInstanceStatus } from '../../channels/setup-contract.ts'
import type { AutomationSummary } from '../../cron/contracts.ts'
import type { WebSearchStatus } from '../../config/web-search.ts'

test('real Main concurrently isolates Project folders, Home prompts, defaults, bots and restart state', { timeout: 90_000 }, async () => {
  await withTempWorkspace(async root => {
    const previousCwd = process.cwd()
    const environmentKeys = ['GITHUB_COPILOT_TOKEN_DIR', 'GITHUB_COPILOT_ACCESS_TOKEN_FILE',
      'GITHUB_COPILOT_API_KEY_FILE', 'GITHUB_COPILOT_MODELS_CACHE_FILE', 'OTEL_DB_PATH', 'VITE_DEV_URL', 'UI_DIST_DIR',
      'SHADOW_A2A_MISSING_STARTUP_TEST_TOKEN']
    const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]))
    let runtime: MainRuntimeHandle | undefined
    try {
      for (const key of environmentKeys) delete process.env[key]
      process.env.GITHUB_COPILOT_TOKEN_DIR = join(root, 'empty-auth')
      process.chdir(root)
      const home = join(root, 'configured-home')
      const pathA = join(root, 'A-private-folder')
      const pathB = join(root, 'B-private-folder')
      for (const directory of [home, pathA, pathB]) await mkdir(directory)
      await writeFile(join(home, 'SOUL.md'), 'BASE_HOME_NOT_IMPORTED\n')
      const projectHome = projectPaths(`${home}.projects`, 'default').home
      await mkdir(projectHome, { recursive: true })
      await writeFile(join(projectHome, 'SOUL.md'), 'ORG_A_PRIVATE_IDENTITY_7f01\n')
      await writeFile(join(home, 'unknown-user-file.bin'), Buffer.from([0, 41, 255]))
      await writeFile(join(pathA, 'sentinel.txt'), 'A file only')
      await writeFile(join(pathB, 'sentinel.txt'), 'B file only')
      const reservation = createServer().listen(0, '127.0.0.1')
      await once(reservation, 'listening')
      const address = reservation.address()
      assert(address && typeof address !== 'string')
      const port = address.port
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
      const rawConfig = {
        agent: { workspace: home, model: 'fixture@openai', sessionStorage: 'sqlite' },
        providers: { openai: { apiKey: 'synthetic-unused-key', baseUrl: 'http://127.0.0.1:1/v1' } },
        channels: {}, mcp: {},
      }
      const config = ConfigSchema.parse(rawConfig)
      const configPath = join(root, 'fixture.config.json')
      await writeFile(configPath, JSON.stringify(rawConfig))
      const uiRoot = join(root, 'ui')
      await mkdir(join(uiRoot, 'assets'), { recursive: true })
      await writeFile(join(uiRoot, 'index.html'), '<html>Browser pairing fixture</html>')
      await writeFile(join(uiRoot, 'assets', 'fixture.js'), 'export const fixture = true')
      process.env.UI_DIST_DIR = uiRoot
      const credential = randomUUID()
      const options = { configPath, localNodeId: 'fixture-main', gateway: { host: '127.0.0.1', port, launchCredential: credential } }
      const base = `http://127.0.0.1:${port}`
      const projectConfigPath = projectPaths(`${home}.projects`, 'default').configPath
      await mkdir(dirname(projectConfigPath), { recursive: true })
      await writeFile(projectConfigPath, JSON.stringify({ voice: { enabled: false, timeoutMs: 30000 }, a2a: { server: {
        url: `${base}/projects/default/a2a`, agentType: 'a2a-text',
        callers: { fixture: 'SHADOW_A2A_MISSING_STARTUP_TEST_TOKEN' },
      } } }))
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
      assert.deepEqual(await json('/api/projects/default/status'), { state: 'ready' })
      for (const [path, method] of [
        ['/projects/default/a2a/.well-known/agent-card.json', 'GET'],
        ['/projects/default/a2a', 'POST'],
      ]) {
        const unavailable = await request(path, method)
        assert.equal(unavailable.status, 503)
        assert.equal(unavailable.headers.get('cache-control'), 'no-store')
        assert.equal((await unavailable.json()).error, 'a2a_unavailable')
        assert.equal((await fetch(base + path, { method })).status, 401, 'No anonymous fallback for missing A2A credentials')
      }
      assert.equal((await fetch(base + '/api/projects')).status, 401)
      assert.equal((await fetch(base + '/api/live?topics=[]')).status, 401)
      assert.equal((await fetch(base + '/nodes/v1/network')).status, 401)
      const deviceNetwork = await json<{ enabled: boolean; state: string; endpoint: string | null }>('/nodes/v1/network')
      assert.equal(deviceNetwork.enabled, false)
      assert.equal(deviceNetwork.state, 'disabled')
      assert.equal(deviceNetwork.endpoint, null)
      assert.equal((await fetch(base + '/')).status, 200)
      assert.equal((await fetch(base + '/projects/default/chat')).status, 200)
      assert.equal((await fetch(base + '/assets/fixture.js')).status, 200)
      assert.deepEqual(await (await fetch(base + '/api/web-auth/session')).json(), { version: 1, required: true, authenticated: false })
      const offer = await json<{ code: string; url: string }>('/local/v1/web-pairing', 'POST')
      assert.equal(offer.url, base + '/')
      const paired = await fetch(base + '/api/web-auth/pair', {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code }),
      })
      assert.equal(paired.status, 200)
      const browserHeaders = { origin: base, cookie: paired.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }
      assert.equal((await fetch(base + '/api/projects', { headers: browserHeaders })).status, 200)
      assert.equal((await fetch(base + '/local/v1/readiness', { headers: browserHeaders })).status, 401)
      assert.equal((await fetch(base + '/nodes/v1/network', { headers: browserHeaders })).status, 401)
      const initial = await json<{ projects: ProjectRecord[] }>('/api/projects')
      assert.deepEqual(initial.projects.map(org => org.id), ['default'])
      const created = await json<{ project: ProjectRecord; runtime: { state: string } }>(
        '/api/projects', 'POST', { name: 'Second project' }, 201)
      assert.equal(created.runtime.state, 'ready')
      const a = '/projects/default'
      const b = `/projects/${created.project.id}`
      assert.equal((await fetch(base + '/api/app/web-search')).status, 401)
      assert.equal((await fetch(base + '/api/app/web-search', { method: 'PATCH', body: '{}' })).status, 401)
      const searchStatus = await json<WebSearchStatus>('/api/app/web-search', 'PATCH', {
        provider: 'exa', apiKeys: {
          firecrawl: 'synthetic-search-firecrawl', brave: 'synthetic-search-brave',
          exa: 'synthetic-search-exa', tavily: 'synthetic-search-tavily',
        },
      })
      assert.equal(searchStatus.effectiveProvider, 'exa')
      assert.equal(searchStatus.ready, true)
      assert.doesNotMatch(JSON.stringify(searchStatus), /synthetic-search-/)
      for (const [prefix, id] of [[a, 'default'], [b, created.project.id]]) {
        const config = await json<{ tools: Record<string, unknown> }>(prefix + '/api/config')
        assert.equal(config.tools.webSearchProvider, 'exa')
        assert.equal(config.tools.exaApiKey, '__SHADOW_REDACTED__')
        assert.equal((await request(prefix + '/api/config', 'PATCH', {
          ...config, tools: { ...config.tools, webSearchProvider: 'brave' },
        })).status, 400)
        assert.doesNotMatch(await readFile(projectPaths(`${home}.projects`, id).configPath, 'utf8'), /synthetic-search-|ApiKey|webSearchProvider/)
      }
      assert.equal(JSON.parse(await readFile(configPath, 'utf8')).tools.exaApiKey, 'synthetic-search-exa')
      for (const project of [a, b]) {
        const pending = project + '/api/agent-resources/credential-requests'
        assert.equal((await fetch(base + pending)).status, 401)
        const metadata = await request(pending)
        assert.equal(metadata.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await metadata.json(), { request: null })
        assert.equal((await request(`${pending}/${randomUUID()}`, 'POST', { value: 'synthetic-stale-value' })).status, 409)
        assert.deepEqual(await json(project + '/api/agent-resources/credentials'), { names: [] })
        const publication = project + '/api/agent-resources/publication-requests'
        assert.equal((await fetch(base + publication)).status, 401)
        const review = await request(publication)
        assert.equal(review.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await review.json(), { request: null, requests: [] })
        const decision = { revision: `sha256:${'a'.repeat(64)}`, baseRevision: `sha256:${'b'.repeat(64)}` }
        for (const method of ['POST', 'DELETE']) {
          assert.equal((await request(`${publication}/${randomUUID()}`, method, decision)).status, 409)
          assert.equal((await fetch(base + `${publication}/${randomUUID()}`, { method })).status, 401)
        }
        const probes = project + '/api/agent-resources/probe-requests'
        assert.equal((await fetch(base + probes)).status, 401)
        const probeReviews = await request(probes)
        assert.equal(probeReviews.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await probeReviews.json(), { requests: [] })
        for (const method of ['POST', 'DELETE']) {
          assert.equal((await request(`${probes}/${randomUUID()}`, method, { revision: decision.revision })).status, 409)
          assert.equal((await fetch(base + `${probes}/${randomUUID()}`, { method })).status, 401)
        }
      }
      assert.equal((await fetch(base + '/api/app/model-defaults')).status, 401)
      await json('/api/app/model-defaults', 'PATCH', { model: 'app-choice@openai', reasoningEffort: 'medium' })
      const before = await json<{ model: string }>(b + '/api/config/model-defaults')
      assert.equal(before.model, 'app-choice@openai')
      await json(a + '/api/config/model-defaults', 'PATCH', { model: 'org-a@openai', temperature: 0.2 })
      assert.deepEqual(await json(b + '/api/config/model-defaults'), before)
      const folderA = (await json<{ folder: FolderRecord }>(a + '/api/folders/register', 'POST', { path: pathA })).folder
      const folderB = (await json<{ folder: FolderRecord }>(b + '/api/folders/register', 'POST', { path: pathB })).folder
      assert.equal((await request(b + '/api/folders/register', 'POST', { path: pathA })).status, 409)
      assert.equal((await request(b + `/api/folders/${folderA.id}/files`)).status, 404)
      assert.deepEqual((await json<{ folders: FolderRecord[] }>(a + '/api/folders')).folders.map(folder => folder.id), [folderA.id])
      assert.deepEqual((await json<{ folders: FolderRecord[] }>(b + '/api/folders')).folders.map(folder => folder.id), [folderB.id])
      const sessionA = await json<{ sessionId: string }>(a + `/api/folders/${folderA.id}/sessions`, 'POST', {})
      const sessionB = await json<{ sessionId: string }>(b + `/api/folders/${folderB.id}/sessions`, 'POST', {})
      const aSession = a + `/api/sessions/${encodeURIComponent(sessionA.sessionId)}`
      const bSession = b + `/api/sessions/${encodeURIComponent(sessionB.sessionId)}`
      assert.equal((await fetch(base + aSession + '/context', { headers: browserHeaders })).status, 200)
      assert.equal((await fetch(base + b + '/api/config/model-defaults', {
        method: 'PATCH', headers: browserHeaders, body: JSON.stringify({ model: null }),
      })).status, 200)
      assert.equal((await fetch(base + aSession + '/background-tasks')).status, 401)
      assert.deepEqual(await json(aSession + '/background-tasks'), { sessionId: sessionA.sessionId, total: 0, tasks: [] })
      assert.deepEqual(await json(bSession + '/background-tasks'), { sessionId: sessionB.sessionId, total: 0, tasks: [] })
      assert.equal((await request(a + '/api/sessions/web%3Aunadmitted/background-tasks')).status, 404)
      assert.equal((await request(a + '/api/sessions/web%3Aunadmitted/details')).status, 404)
      const [contextA, contextB] = await Promise.all([
        json<{ systemPrompt: string }>(aSession + '/context'),
        json<{ systemPrompt: string }>(bSession + '/context'),
      ])
      assert(contextA.systemPrompt.includes('ORG_A_PRIVATE_IDENTITY_7f01'))
      assert(!contextA.systemPrompt.includes('BASE_HOME_NOT_IMPORTED'))
      assert(!contextB.systemPrompt.includes('ORG_A_PRIVATE_IDENTITY_7f01'))
      assert(!contextA.systemPrompt.includes('B-private-folder'))
      assert(!contextB.systemPrompt.includes('A-private-folder'))
      for (const suffix of ['/context', '/files', '/preview?path=sentinel.txt', '/ask', '/background-tasks']) {
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
      const automationsA = await json<{ automations: AutomationSummary[] }>(a + '/api/automations')
      const automationsB = await json<{ automations: AutomationSummary[] }>(b + '/api/automations')
      assert.equal(automationsA.automations.length, 3)
      assert.equal(automationsB.automations.length, 3)
      assert(automationsA.automations.every(job => job.session === 'fresh' && !job.enabled))
      assert(automationsB.automations.every(job => job.session === 'fresh' && job.enabled))
      assert.equal((await fetch(base + a + '/api/automations')).status, 401)
      assert.deepEqual(await json(a + '/api/automations/learning%3Areflector/runs'), { runs: [], total: 0, offset: 0 })
      assert.equal((await request(b + '/api/automations/unknown-job/runs')).status, 404)
      assert.equal((await request(a + '/api/automations', 'POST', {})).status, 404)
      const addBot = async (scope: string, name: string) =>
        (await json<{ channel: BotInstanceStatus }>(scope + '/api/channels', 'POST',
          { platform: 'qq', displayName: name, config: { enabled: false } }, 201)).channel
      const botsA = await Promise.all([addBot(a, 'Bot one'), addBot(a, 'Bot two')])
      const botB = await addBot(b, 'Bot one')
      assert.notEqual(botsA[0].id, botsA[1].id)
      assert.equal(botsA[0].projectId, 'default')
      assert.equal(botB.projectId, created.project.id)
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
      const liveTopics = [
        { kind: 'chat', projectId: created.project.id, sessionId: 'web:model-and-identity' },
        { kind: 'sessions', projectId: created.project.id },
      ]
      const live = await request(`/api/live?topics=${encodeURIComponent(JSON.stringify(liveTopics))}`)
      assert.equal(live.status, 200)
      const liveReader = live.body!.getReader()
      try {
        const admission = await json<{ requestId: string }>(b + '/api/chat/send', 'POST', {
          chatId: 'model-and-identity', content: '/help', config: { model: 'selected@openai' }, stream: false,
        })
        let pending = ''
        let delivered = false
        const decoder = new TextDecoder()
        while (!delivered) {
          const chunk = await liveReader.read()
          assert.equal(chunk.done, false, 'Shared feed must deliver admission-only command output')
          pending += decoder.decode(chunk.value, { stream: true })
          let boundary: number
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, boundary)
            pending = pending.slice(boundary + 2)
            const data = frame.match(/^data: (.+)$/m)
            if (!data) continue
            const envelope = JSON.parse(data[1])
            if (envelope.type !== 'event') continue
            assert.equal(envelope.topic.projectId, created.project.id)
            if (envelope.topic.kind === 'chat' && envelope.payload.done) {
              assert.equal(envelope.requestId, admission.requestId)
              delivered = true
            }
          }
        }
      } finally { await liveReader.cancel() }
      const selected = await json<{ sessions: Array<{ sessionId: string; config?: { model?: string } }> }>(b + '/api/sessions/graph')
      assert.equal(selected.sessions.find(session => session.sessionId === 'web:model-and-identity')?.config?.model, 'selected@openai')
      assert.deepEqual(await json(b + '/api/config/model-defaults'), before)
      const bConfig = await json<{ agent: { workspace: string } }>(b + '/api/config')
      const observedIdentity = JSON.parse(await readFile(join(bConfig.agent.workspace, 'memory', 'identities', 'index.json'), 'utf8'))
      assert.equal(observedIdentity.accountChats['web:web-user'], 'model-and-identity')
      assert.deepEqual(await readFile(join(home, 'unknown-user-file.bin')), Buffer.from([0, 41, 255]))
      const ioRun = await json<{ id: string; status: string }>(a + '/api/io/runs', 'POST', {
        sessionId: sessionA.sessionId,
        definition: {
          version: 1, title: 'Fixture I/O', purpose: 'Verify project ownership without accessing devices',
          endpoint: 'ws://127.0.0.1:1',
          sources: [{ id: 'form', kind: 'form' }],
          limits: { durationMs: 1000, maxBytes: 1024 }, ui: [],
        },
      }, 201)
      assert.equal(ioRun.status, 'awaiting_consent')
      assert.equal((await fetch(base + a + '/api/io/runs')).status, 401)
      assert.equal((await request(b + `/api/io/runs/${ioRun.id}`)).status, 404)
      assert.equal((await json<{ total: number }>(aSession + '/background-tasks')).total, 1)
      await runtime.shutdown()
      await runtime.finished
      runtime = await startMainRuntime(ConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8'))), options)
      await runtime.ready
      assert.equal((await fetch(base + '/api/projects', { headers: browserHeaders })).status, 401)
      assert.deepEqual(await (await fetch(base + '/api/web-auth/session')).json(), { version: 1, required: true, authenticated: false })
      assert.equal((await json<{ projects: ProjectRecord[] }>('/api/projects')).projects.length, 2)
      assert.equal((await json<{ model: string }>(a + '/api/config/model-defaults')).model, 'org-a@openai')
      assert.equal((await json<{ model: string }>(b + '/api/config/model-defaults')).model, 'app-choice@openai')
      assert.deepEqual(await json('/api/app/web-search'), searchStatus)
      await json('/api/app/model-defaults', 'PATCH', { model: null, reasoningEffort: null })
      assert.equal((await json<{ model: string }>(b + '/api/config/model-defaults')).model, 'gpt-6-astra@copilot')
      assert.equal((await json<{ model: string }>(a + '/api/config/model-defaults')).model, 'org-a@openai')
      assert.equal((await json<{ enabled: boolean }>(a + '/api/learning')).enabled, false)
      assert.equal((await json<{ channels: BotInstanceStatus[] }>(a + '/api/channels')).channels.length, 2)
      assert.equal((await json<{ channels: BotInstanceStatus[] }>(b + '/api/channels')).channels.length, 1)
      assert.equal((await request(aSession + '/details')).status, 200)
      assert.equal((await request(bSession + '/details')).status, 200)
      const restoredIo = await json<{ status: string; backendStatus?: string }>(a + `/api/io/runs/${ioRun.id}`)
      assert.equal(restoredIo.status, 'awaiting_consent')
      assert.notEqual(restoredIo.backendStatus, 'ready', 'Restart must not reconnect or grant pending I/O requests')
      assert.deepEqual((await json<{ clients: unknown[] }>(a + '/api/io/capabilities')).clients, [])
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
