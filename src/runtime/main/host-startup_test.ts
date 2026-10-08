import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { join } from 'node:path'
import { ConfigSchema } from '../../config/schema.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { ProjectCatalog } from '../../projects/catalog.ts'
import { FolderRegistry } from '../../folders/registry.ts'
import { startProjectHost } from './host.ts'
import type { MainRuntimeHandle } from './contracts.ts'
import type { RealtimeHub } from '../../realtime/hub.ts'

test('host starts Projects concurrently with bounded pressure and waits for their readiness', { timeout: 15_000 }, async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const catalog = new ProjectCatalog(`${home}.projects`)
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
    const catalog = new ProjectCatalog(`${home}.projects`)
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
