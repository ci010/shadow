import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { ConfigSchema } from '../../config/schema.ts'
import { ProjectCatalog } from '../../projects/catalog.ts'
import { projectPaths } from '../../projects/contracts.ts'
import { FolderRegistry } from '../../folders/registry.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { startProjectHost } from './host.ts'

test('Main revokes admission, drains project services before deleting Home and resumes interrupted cleanup on restart', { timeout: 15_000 }, async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home'), catalog = new ProjectCatalog(`${home}.projects`)
    await catalog.init()
    const project = await catalog.create('Delete fixture')
    const interrupted = await catalog.create('Interrupted fixture')
    const paths = projectPaths(catalog.hostHome, project.id)
    const folder = join(root, 'working-folder')
    await mkdir(folder)
    await writeFile(join(folder, 'keep.txt'), 'Keep working files')
    await catalog.registerFolder(project.id, folder)
    for (const id of [project.id, interrupted.id]) {
      const { home } = projectPaths(catalog.hostHome, id)
      await mkdir(home, { recursive: true })
      await writeFile(join(home, 'history.jsonl'), 'Synthetic JSONL history')
      await writeFile(join(home, 'sessions.sqlite'), 'Synthetic SQLite history')
    }
    await assert.rejects(catalog.remove(interrupted.id, async () => { throw new Error('Interrupted shutdown') }), /Interrupted/)
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const credential = randomUUID(), base = `http://127.0.0.1:${address.port}`
    const headers = { authorization: `Bearer ${credential}` }
    const config = ConfigSchema.parse({
      agent: { workspace: home, model: 'fixture@openai' },
      providers: { openai: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1' } }, channels: {}, mcp: {},
    })
    const draining = Promise.withResolvers<void>()
    let deleting = false, failFirstShutdown = true
    const started: string[] = []
    const runtime = await startProjectHost(config, { gateway: { host: '127.0.0.1', port: address.port, launchCredential: credential } },
      async (_config, dependencies) => {
        started.push(dependencies.project.id)
        const app = new Hono(), publisher = dependencies.realtimeHub!.registerProject(dependencies.project.id)
        app.get('/api/fixture', c => c.json({ projectId: dependencies.project.id }))
        return {
          app, folders: new FolderRegistry(dependencies.home), ready: Promise.resolve(), updateConfig() {},
          async shutdown() {
            if (dependencies.project.id === project.id) {
              deleting = true
              await draining.promise
              if (failFirstShutdown) { failFirstShutdown = false; throw new Error('Synthetic shutdown failure') }
            }
            publisher.close()
          },
        }
      }, process.cwd())
    try {
      assert.deepEqual(new Set(started), new Set(['default', project.id]))
      await assert.rejects(stat(projectPaths(catalog.hostHome, interrupted.id).root), { code: 'ENOENT' })
      const deletion = fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) })
      const deadline = Date.now() + 3000
      while (!deleting) { assert(Date.now() < deadline); await delay(5) }
      assert.equal(await readFile(join(paths.home, 'history.jsonl'), 'utf8'), 'Synthetic JSONL history')
      assert.equal((await fetch(`${base}/projects/${project.id}/api/fixture`, { headers })).status, 503)
      assert.equal((await fetch(`${base}/api/projects/${project.id}/retry`, { method: 'POST', headers })).status, 409)
      assert.equal((await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE', headers })).status, 409)
      assert.equal((await fetch(`${base}/projects/default/api/fixture`, { headers })).status, 200)
      draining.resolve()
      const failed = await deletion
      assert.equal(failed.status, 500)
      assert.match((await failed.json()).message, /Deletion did not finish/)
      assert.equal(await readFile(join(paths.home, 'sessions.sqlite'), 'utf8'), 'Synthetic SQLite history')
      assert.equal((await fetch(`${base}/projects/${project.id}/api/fixture`, { headers })).status, 503)
      const result = await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE', headers })
      assert.equal(result.status, 200)
      assert.deepEqual(await result.json(), { deletedProjectId: project.id })
      await assert.rejects(stat(paths.root), { code: 'ENOENT' })
      assert.equal(await readFile(join(folder, 'keep.txt'), 'utf8'), 'Keep working files')
      assert.equal((await fetch(`${base}/projects/${project.id}/api/fixture`, { headers })).status, 404)
      const reloaded = new ProjectCatalog(catalog.hostHome)
      await reloaded.init()
      assert.deepEqual(reloaded.list().map(project => project.id), ['default'])
      assert.equal((await reloaded.registerFolder('default', folder)).projectId, 'default')
    } finally { draining.resolve(); await runtime.shutdown() }
  })
})
