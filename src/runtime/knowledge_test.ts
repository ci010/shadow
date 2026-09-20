import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { ConfigSchema } from '../config/schema.ts'
import { startMainRuntime } from './main/start.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectPaths } from '../projects/contracts.ts'
import type { KnowledgeCatalog, KnowledgeDetail } from '../knowledge/contracts.ts'
import type { KnowledgeMaintenanceReport, KnowledgeMaintenanceStatus, KnowledgeRepairPreview } from '../knowledge/maintenance-contracts.ts'

test('knowledge and maintenance stay Project-scoped through confirmed deletion and repair', { timeout: 60000 }, async t => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    await mkdir(home)
    const reservation = createServer().listen({ host: '127.0.0.1', port: 0 })
    await once(reservation, 'listening')
    const address = reservation.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const config = ConfigSchema.parse({
      agent: { workspace: home, model: 'fixture@openai' },
      providers: { openai: { apiKey: 'synthetic-unused', baseUrl: 'http://127.0.0.1:1' } }, channels: {}, mcp: {},
    })
    const runtime = await startMainRuntime(config, { gateway: { host: '127.0.0.1', port: address.port, launchCredential: 'knowledge-fixture' } })
    const origin = `http://127.0.0.1:${address.port}`
    const request = (path: string, method = 'GET', body?: unknown) => fetch(origin + path, {
      method, headers: { authorization: 'Bearer knowledge-fixture', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    try {
      assert.equal((await fetch(origin + '/projects/default/api/knowledge')).status, 401)
      const created = await request('/api/projects', 'POST', { name: 'Knowledge owner' })
      assert.equal(created.status, 201)
      const { project } = await created.json()
      const owner = `/projects/${project.id}`
      await t.waitFor(async () => {
        const status = await (await request(owner + '/api/knowledge/maintenance')).json() as KnowledgeMaintenanceStatus
        assert.equal(status.scanning, false)
        assert(status.report, 'Startup runs an initial deterministic scan')
        assert.equal(status.intervalMs, 86_400_000)
        return true
      })
      const paths = projectPaths(`${home}.projects`, project.id)
      const directory = join(paths.home, 'memory', 'topics')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'owned.md'), '# Owned knowledge\n')
      await writeFile(join(directory, 'referrer.md'), '# Reference\n[Owned](owned.md)')
      const response = await request(owner + '/api/knowledge')
      assert.equal(response.status, 200)
      const catalog = await response.json() as KnowledgeCatalog
      const entry = catalog.entries.find(item => item.id === 'memory/topics/owned.md')
      assert(entry)
      const defaults = await (await request('/projects/default/api/knowledge')).json() as KnowledgeCatalog
      assert(!defaults.entries.some(item => item.id === entry.id))
      assert.equal((await request(`/projects/default/api/knowledge/entry?id=${encodeURIComponent(entry.id)}`)).status, 404)
      const detailResponse = await request(`${owner}/api/knowledge/entry?id=${encodeURIComponent(entry.id)}`)
      assert.equal(detailResponse.status, 200)
      const detail = await detailResponse.json() as KnowledgeDetail
      assert.equal(detail.content, '# Owned knowledge\n')
      assert.equal((await request(owner + '/api/knowledge/entry', 'DELETE', { id: entry.id, revision: entry.revision })).status, 200)
      await assert.rejects(readFile(join(directory, 'owned.md')), { code: 'ENOENT' })
      const after = await (await request(owner + '/api/knowledge')).json() as KnowledgeCatalog
      assert(!after.entries.some(item => item.id === entry.id))
      assert(after.links.some(link => link.source === 'memory/topics/referrer.md' && link.target === entry.id))
      assert.match(await readFile(join(directory, 'referrer.md'), 'utf8'), /\[Owned\]\(owned.md\)/)
      const scanResponse = await request(owner + '/api/knowledge/maintenance/scan', 'POST', {})
      assert.equal(scanResponse.status, 200, await scanResponse.clone().text())
      const report = await scanResponse.json() as KnowledgeMaintenanceReport
      assert(report.findings.some(finding => finding.sourceId === 'memory/topics/referrer.md'
        && finding.target === entry.id && finding.reason === 'missing' && finding.repairable))
      const previewResponse = await request(owner + '/api/knowledge/maintenance/preview', 'POST', {
        reportId: report.id, sourceId: 'memory/topics/referrer.md',
      })
      assert.equal(previewResponse.status, 200, await previewResponse.clone().text())
      const preview = await previewResponse.json() as KnowledgeRepairPreview
      assert.equal(preview.before, '# Reference\n[Owned](owned.md)')
      assert.equal(preview.after, '# Reference\nOwned')
      assert.equal(await readFile(join(directory, 'referrer.md'), 'utf8'), preview.before, 'Preview does not mutate Wiki')
      const wrongProject = await request('/projects/default/api/knowledge/maintenance/apply', 'POST', {
        reportId: report.id, sourceId: preview.sourceId, revision: preview.revision,
      })
      assert.equal(wrongProject.status, 409)
      const applied = await request(owner + '/api/knowledge/maintenance/apply', 'POST', {
        reportId: report.id, sourceId: preview.sourceId, revision: preview.revision,
      })
      assert.equal(applied.status, 200, await applied.clone().text())
      assert.equal(await readFile(join(directory, 'referrer.md'), 'utf8'), '# Reference\nOwned')
      const sessions = await (await request(owner + '/api/sessions/graph')).json()
      assert.deepEqual(sessions.sessions, [], 'Maintenance does not create agent sessions')
    } finally { await runtime.shutdown(); await runtime.finished }
  })
})
