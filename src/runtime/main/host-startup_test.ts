import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { join } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { ConfigSchema } from '../../config/schema.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { ProjectCatalog } from '../../projects/catalog.ts'
import { FolderRegistry } from '../../folders/registry.ts'
import { startProjectHost } from './host.ts'
import type { MainRuntimeHandle } from './contracts.ts'
import type { RealtimeHub } from '../../realtime/hub.ts'
import { JsonlSessionStore } from '../../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../../sessions/session-store-sqlite.ts'
import { projectPaths } from '../../projects/contracts.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { safeSessionId } from '../../utils/paths.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: bad session storage isolates its Project, preserves data, and supports repair/retry`, async t => {
    await withTempWorkspace(async root => {
      const home = join(root, 'home')
      const catalog = new ProjectCatalog(home)
      await catalog.init()
      const healthy = await catalog.create('Healthy project')
      const identity = { version: 1 as const, rootId: 'a'.repeat(64), ancestorIds: [] }
      const existing = await catalog.registerRemoteFolder(healthy.id, { version: 2, nodeId: 'child', workdirId: 'existing' }, identity)
      const directory = projectStoragePath(projectPaths(home, 'default').home, '.sessions')
      const state = {
        sessionId: 'web:orchestrator', segmentIndex: 2, ownershipVersion: 2, projectId: 'default',
        sessionKind: 'orchestrator', agentType: 'orchestrator',
        workdir: { version: 2 as const, nodeId: 'child', workdirId: 'original-grant' },
      }
      const statePath = join(directory, `${safeSessionId(state.sessionId)}.json`)
      const store = new Store(directory)
      const history = [{ role: 'user', content: 'Synthetic history must survive' }]
      try {
        await store.init()
        await store.saveState(state.sessionId, { sessionId: state.sessionId, segmentIndex: 2, projectId: 'default' })
        await store.createSessionLog('original-segment', history)
      } finally { store.close() }
      const put = async (raw: string) => {
        if (Store === JsonlSessionStore) return writeFile(statePath, raw)
        const db = new DatabaseSync(join(directory, 'sessions.db'))
        try { db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?').run(raw, state.sessionId) }
        finally { db.close() }
      }
      const get = async () => {
        if (Store === JsonlSessionStore) return readFile(statePath, 'utf8')
        const db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
        try { return String(db.prepare('SELECT prototype FROM session_states WHERE key = ?').get(state.sessionId)?.prototype) }
        finally { db.close() }
      }
      const encode = (metadata: object) => JSON.stringify(Store === JsonlSessionStore ? metadata : { version: 1, metadata })
      const malformed = '{ "private": "synthetic-sensitive-text", broken'
      await put(malformed)
      const reservation = createServer().listen(0, '127.0.0.1')
      await once(reservation, 'listening')
      const address = reservation.address()
      assert(address && typeof address !== 'string')
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
      const credential = 'synthetic-session-recovery-credential'
      const request = (path: string, method = 'GET') => fetch(`http://127.0.0.1:${address.port}${path}`, {
        method, headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(5000),
      })
      const messages: unknown[][] = []
      t.mock.method(console, 'error', (...args: unknown[]) => { messages.push(args) })
      const entered: string[] = []
      let liveCatalog: ProjectCatalog | undefined
      const config = ConfigSchema.parse({ agent: { workspace: home }, channels: {}, mcp: {} })
      const runtime = await startProjectHost(config, {
        localExecutor: false, gateway: { host: '127.0.0.1', port: address.port, launchCredential: credential },
      }, async (_config, dependencies) => {
        entered.push(dependencies.project.id)
        liveCatalog = dependencies.catalog
        if (dependencies.project.id === 'default') {
          const snapshot = dependencies.startupSessionStates?.[Store === JsonlSessionStore ? 'jsonl' : 'sqlite']
          assert.equal(snapshot?.[state.sessionId].sessionKind, undefined)
          assert.equal(snapshot?.[state.sessionId].agentType, 'general')
          assert.equal(snapshot?.[state.sessionId].segmentIndex, 2)
        }
        return { app: new Hono().get('/api/fixture', c => c.json({ ready: true })),
          folders: new FolderRegistry(dependencies.home), ready: Promise.resolve(),
          async shutdown() {}, updateConfig() {} }
      })
      try {
        await runtime.ready
        assert(liveCatalog)
        assert.deepEqual(entered, [healthy.id])
        assert.equal((await request('/local/v1/readiness')).status, 200)
        assert.equal((await request('/api/projects')).status, 200)
        assert.equal((await request(`/projects/${healthy.id}/api/fixture`)).status, 200)
        assert.equal((await request('/projects/default/api/fixture')).status, 503)
        const remote = { version: 2 as const, nodeId: 'child', workdirId: 'new-grant' }
        for (const raw of [malformed, '', encode({ ...state, sessionKind: 'unknown' }),
          encode({ ...state, ownershipVersion: 999 }), encode({ ...state, projectId: healthy.id })]) {
          await put(raw)
          const response = await request('/api/projects/default/retry', 'POST')
          assert.equal(response.status, 200)
          const status = await response.json()
          assert.equal(status.state, 'failed')
          assert.match(status.error, /Original data is preserved/)
          assert.equal(await get(), raw)
          await assert.rejects(liveCatalog.registerRemoteFolder(healthy.id, remote, identity), { code: 'session_ownership_unavailable' })
          await assert.rejects(liveCatalog.changeFolderProject(healthy.id, existing.id, 'default'), { code: 'session_ownership_unavailable' })
          assert.equal((await request(`/projects/${healthy.id}/api/fixture`)).status, 200)
        }
        assert.deepEqual(entered, [healthy.id], 'Invalid Projects must not instantiate services or overwrite metadata')
        assert.doesNotMatch(JSON.stringify(messages), /synthetic-sensitive-text/)
        await put(encode(state))
        const repaired = await request('/api/projects/default/retry', 'POST')
        assert.deepEqual(await repaired.json(), { state: 'ready' })
        assert.equal((await request('/projects/default/api/fixture')).status, 200)
        assert.deepEqual(liveCatalog.remoteClaims().find(claim => claim.workdir.workdirId === 'original-grant')?.workdir, state.workdir)
        await liveCatalog.resolveRemoteClaim(state.workdir, { ...identity, rootId: 'b'.repeat(64) })
        await liveCatalog.registerRemoteFolder(healthy.id, remote, { ...identity, rootId: 'c'.repeat(64) })
        assert.equal(await get(), encode(state), 'Reading and retrying must not rewrite the repaired source')
        const reopened = new Store(directory)
        try { assert.deepEqual(await Array.fromAsync(reopened.readSessionLog('original-segment')), history) }
        finally { reopened.close() }
      } finally { await runtime.shutdown() }
    })
  })
}

test('host starts Projects concurrently with bounded pressure and waits for their readiness', { timeout: 15_000 }, async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const catalog = new ProjectCatalog(home)
    await catalog.init()
    for (let index = 0; index < 4; index++) await catalog.create(`Project ${index}`)
    const releases: Array<() => void> = []
    const entered: string[] = []
    const stopped: string[] = []
    let active = 0
    let peak = 0
    let resolved = false
    const config = ConfigSchema.parse({
      agent: { workspace: home, model: 'fixture@openai' },
      providers: { openai: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1' } },
      channels: {}, mcp: {},
    })

    let runtime: MainRuntimeHandle | undefined
    const starting = startProjectHost(config, { gateway: { host: '127.0.0.1', port: 0 } }, async (_config, dependencies) => {
      entered.push(dependencies.project.id)
      active++
      peak = Math.max(peak, active)
      const ready = Promise.withResolvers<void>()
      releases.push(() => ready.resolve())
      return {
        app: new Hono(), folders: new FolderRegistry(dependencies.home),
        ready: ready.promise.finally(() => { active-- }),
        async shutdown() { stopped.push(dependencies.project.id) },
        updateConfig() {},
      }
    }).then(value => { resolved = true; return value })
    const wait = async (check: () => boolean) => {
      const deadline = Date.now() + 5000
      while (!check()) {
        assert.ok(Date.now() < deadline, 'Concurrent startup did not reach its next barrier')
        await delay(5)
      }
    }
    try {
      await wait(() => entered.length === 3)
      assert.equal(active, 3)
      assert.equal(resolved, false, 'Do not claim readiness while Project services are unavailable')
      releases[0]()
      await wait(() => entered.length === 4)
      releases[1]()
      await wait(() => entered.length === 5)
      assert.equal(peak, 3)
      for (const release of releases) release()
      runtime = await starting
      assert.equal(resolved, true)
      assert.equal(active, 0)
      assert.equal(new Set(entered).size, 5)
    } finally {
      // Allow any workers entering during cleanup to finish as well.
      const draining = setInterval(() => { for (const release of releases) release() }, 5)
      try { runtime ??= await starting; await runtime.shutdown() }
      finally { clearInterval(draining) }
    }
    assert.equal(new Set(stopped).size, 5)
  })
})

test('a failed Project remains explicitly unavailable without taking the shared Main feed down', async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const catalog = new ProjectCatalog(home)
    await catalog.init()
    const failed = await catalog.create('Unavailable fixture')
    const config = ConfigSchema.parse({
      agent: { workspace: home, model: 'fixture@openai' },
      providers: { openai: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1' } },
      channels: {}, mcp: {},
    })
    let hub: RealtimeHub | undefined
    const runtime = await startProjectHost(config, { gateway: { host: '127.0.0.1', port: 0 } }, async (_config, dependencies) => {
      const realtime = dependencies.realtimeHub
      assert(realtime)
      hub = realtime
      if (dependencies.project.id === failed.id) throw new Error('Synthetic Project startup failure')
      const publisher = realtime.registerProject(dependencies.project.id)
      return {
        app: new Hono(), folders: new FolderRegistry(dependencies.home), ready: Promise.resolve(),
        async shutdown() { publisher.close() }, updateConfig() {},
      }
    })
    try {
      assert(hub)
      const unavailable = { kind: 'sessions' as const, projectId: failed.id }
      const response = hub.connect([{ kind: 'sessions', projectId: 'default' }, unavailable], new AbortController().signal)
      assert.equal(response.status, 200)
      const reader = response.body!.getReader()
      const next = async () => {
        const result = await reader.read()
        assert(!result.done)
        return JSON.parse(new TextDecoder().decode(result.value).match(/^data: (.+)$/m)![1])
      }
      assert.equal((await next()).type, 'reset')
      assert.deepEqual(await next(), { type: 'unavailable', cursor: hub.cursor, topics: [unavailable] })
      assert.equal((await next()).type, 'ready')
      await reader.cancel()
    } finally { await runtime.shutdown() }
  })
})


test('host propagates coordinator mode to every Project and stops advertising Main shell without affecting readiness', async () => {
  for (const localExecutor of [undefined, true, false]) await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const catalog = new ProjectCatalog(home)
    await catalog.init()
    await catalog.create('Second Project')
    const config = ConfigSchema.parse({ agent: { workspace: home, model: 'fixture@openai' },
      providers: { openai: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1' } }, channels: {}, mcp: {} })
    const seen = new Set<string>()
    const runtime = await startProjectHost(config, { localExecutor, gateway: { host: '127.0.0.1', port: 0 } }, async (_config, dependencies) => {
      assert.equal(dependencies.localExecutor, localExecutor !== false)
      const main = dependencies.mainCluster.getNodeInventory().nodes.find(node => node.role === 'main')!
      assert(main)
      assert.equal(main.support.operations.includes('process.execute'), localExecutor !== false)
      seen.add(dependencies.project.id)
      return { app: new Hono(), folders: new FolderRegistry(dependencies.home), ready: Promise.resolve(),
        async shutdown() {}, updateConfig() {} }
    })
    try { await runtime.ready; assert.equal(seen.size, 2) }
    finally { await runtime.shutdown() }
  })
})


test('explicit app data root overrides workspace and owns canonical host and Project files', async () => {
  await withTempWorkspace(async root => {
    const dataDir = join(root, 'app')
    const oldWorkspace = join(root, 'old-workspace')
    const config = ConfigSchema.parse({ agent: { workspace: oldWorkspace }, channels: {}, mcp: {} })
    const runtime = await startProjectHost(config, { dataDir, gateway: { host: '127.0.0.1', port: 0 } }, async (projectConfig, dependencies) => {
      assert.equal(dependencies.home, join(dataDir, 'projects', 'default'))
      assert.equal(projectConfig.agent.workspace, dependencies.home)
      return { app: new Hono(), folders: new FolderRegistry(dependencies.home), ready: Promise.resolve(), async shutdown() {}, updateConfig() {} }
    })
    try {
      for (const path of ['projects.json', 'telemetry/host.db', 'projects/default/config/project.json']) {
        assert.equal((await stat(join(dataDir, path))).isFile(), true)
      }
      await assert.rejects(stat(join(dataDir, 'projects', 'default', 'workspace')), { code: 'ENOENT' })
      await assert.rejects(stat(`${oldWorkspace}.projects`), { code: 'ENOENT' })
    } finally { await runtime.shutdown() }
    assert.equal((await stat(join(dataDir, 'devices', 'registry.v1.json'))).isFile(), true)
  })
})
