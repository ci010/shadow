import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { SkillsManager } from '../../skills/loader.ts'
import { SkillEditStore } from '../../skills/edit-store.ts'
import { registerKnowledgeRoutes } from '../../knowledge/routes.ts'
import { JsonlSessionStore } from '../../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../../sessions/session-store-sqlite.ts'
import { physicalSessionId } from '../../sessions/session-identity.ts'
import { checksum, type MaintenanceHistory } from './maintenance-contracts.ts'
import { ProjectMaintenanceSources } from './maintenance-sources.ts'
import { SessionStoreMaintenanceHistory } from './maintenance-history.ts'
import { ReviewedMaintenancePreview, type HostContentReview } from './maintenance-reviewed.ts'
import { LearningMaintenancePreview } from './maintenance-preview.ts'

const projectId = 'synthetic-reviewed'
const neverHistory: MaintenanceHistory = {
  async inventory() { throw new Error('Document-only selection must not capture global history') },
  async messages() { throw new Error('Document-only selection must not read history') },
}
function fixture(home: string, history = neverHistory) {
  const skills = new SkillsManager(home)
  const protectedPaths = new Set(['memory/topics/protected.md'])
  const sources = new ProjectMaintenanceSources(home, projectId, skills, history, protectedPaths)
  const service = new LearningMaintenancePreview(home, projectId, sources)
  const reviewed = new ReviewedMaintenancePreview(projectId, sources)
  const file = (path: string, bytes: string) => {
    const name = projectStoragePath(home, path)
    mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, bytes)
    return name
  }
  const page = 'memory/topics/mixed.md'
  file(page, '# Mixed source\n\nManually started; later learned text.\n')
  const select = (path = page, disposition: 'archive' | 'seed' = 'archive') => {
    const { provenance: _, ...selection } = reviewed.inspect({ paths: [path] })[0]!
    return { ...selection, disposition }
  }
  return { skills, sources, service, reviewed, file, page, select, protectedPaths }
}
function bytesTree(directory: string): unknown {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isDirectory() ? bytesTree(join(directory, entry.name)) : readFileSync(join(directory, entry.name)).toString('base64')])
}

test('nonempty production document preview preserves unknown provenance; no state, history, epoch or source changes', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  const before = bytesTree(home)
  const document = f.select()
  const request = { documents: [document], historyEffect: 'none' }
  const plan = await f.service.previewDocuments(request)
  assert.ok('scopeHash' in plan)
  assert.deepEqual(plan.documents, [document])
  assert.equal(plan.provenance, 'unknown')
  assert.equal(plan.contentReview, null)
  assert.equal(plan.executionApproval, 'required-separately')
  assert.equal(plan.activation, 'disabled')
  assert.deepEqual(plan.effects, { history: 'none', epoch: 'unchanged', unselectedDocuments: 'unchanged', sourceLogs: 'unchanged' })
  assert.equal(f.service.status().foundation.state, null)
  assert.deepEqual(bytesTree(home), before)
  assert.deepEqual(await f.sources.candidates(), [])
  assert.throws(() => f.service.apply({ operationId: plan.operationId, manifestRevision: plan.planRevision }), /apply disabled/)
}))

test('native Skill package revision is independent of text digest and complete snapshot digest', async () => withTempWorkspace(async home => {
  const f = fixture(home), store = new SkillEditStore(home, f.skills)
  const text = '---\nname: synthetic\ndescription: Synthetic lesson only\n---\nExample\n'
  const saved = await store.save('synthetic', { 'SKILL.md': text }, null)
  const selection = f.select('skills/synthetic/SKILL.md', 'seed')
  assert.equal(selection.sourceRevision, saved.revision)
  assert.equal(selection.sourceTextDigest, checksum(text))
  assert.notEqual(selection.sourceRevision, selection.sourceTextDigest)
  assert.notEqual(selection.snapshotRevision, selection.sourceRevision)
  const plan = f.reviewed.preview({ documents: [selection], historyEffect: 'none' })
  assert.equal(plan.documents[0]!.disposition, 'seed')
  // In particular, the text-only hash from a human checklist is not native CAS.
  assert.throws(() => f.reviewed.preview({ documents: [{ ...selection, sourceRevision: checksum(text) }], historyEffect: 'none' }), /revision changed/)
  f.file('skills/synthetic/resource.txt', 'new package member')
  assert.throws(() => f.reviewed.inspect({ paths: [selection.path] }), /package members/)
}))

test('separate host review binds exact project/scope/text receipt, never execution authority', async () => withTempWorkspace(async home => {
  const f = fixture(home), request = { documents: [f.select()], historyEffect: 'none' }
  const first = f.reviewed.preview(request)
  const review: HostContentReview = { version: 1, projectId, scopeHash: first.scopeHash,
    reviewTextDigest: checksum('Synthetic human review statement'), authority: 'host-content-review' }
  const approved = f.reviewed.preview(request, review)
  assert.deepEqual(approved.contentReview, review)
  assert.equal(approved.scopeHash, first.scopeHash)
  assert.notEqual(approved.operationId, first.operationId)
  assert.equal(approved.executionApproval, 'required-separately')
  assert.equal(approved.activation, 'disabled')
  assert.throws(() => f.reviewed.preview(request, { ...review, projectId: 'foreign' }), /Foreign or stale/)
  assert.throws(() => f.reviewed.preview({ ...request, documents: [f.select(f.page, 'seed')] }, review), /Foreign or stale/)
  for (const extra of [{ approved: true }, { contentReview: review }, { provenance: 'automatic-learning' }, { epoch: 1 }]) {
    assert.throws(() => f.reviewed.preview({ ...request, ...extra }))
  }
}))

test('protected/identity/foreign syntax/traversal, stale separate revisions and duplicate selection fail closed', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  const selected = f.select()
  for (const field of ['sourceRevision', 'snapshotRevision', 'sourceTextDigest'] as const) {
    assert.throws(() => f.reviewed.preview({ documents: [{ ...selected, [field]: checksum('stale') }], historyEffect: 'none' }), /revision changed/)
  }
  for (const path of ['memory/decisions/preserve.md', 'memory/topics/protected.md', 'memory/identities/user.md',
    'memory/events/old.jsonl', '../escape.md', 'builtin:skills/synthetic', 'other-project/memory/topics/test.md', 'memory/topics/../mixed.md']) {
    assert.throws(() => f.reviewed.inspect({ paths: [path] }))
  }
  assert.throws(() => f.reviewed.preview({ documents: [selected, selected], historyEffect: 'none' }), /Duplicate/)
  assert.throws(() => f.reviewed.preview({ documents: [selected], historyEffect: 'all-old' }))
  const link = projectStoragePath(home, 'memory/topics/link.md')
  symlinkSync(projectStoragePath(home, f.page), link)
  assert.throws(() => f.reviewed.inspect({ paths: ['memory/topics/link.md'] }), /Linked/)
  f.file(f.page, 'third-party changed text')
  assert.throws(() => f.reviewed.preview({ documents: [selected], historyEffect: 'none' }), /revision changed/)
}))

test('source and host policy changes during the final recheck invalidate a preview', async () => withTempWorkspace(async home => {
  const f = fixture(home), document = f.select()
  for (const mutation of [() => f.file(f.page, 'race'), () => f.protectedPaths.add(f.page)]) {
    f.file(f.page, '# Mixed source\n\nManually started; later learned text.\n')
    let reads = 0
    const service = new ReviewedMaintenancePreview(projectId, { observeDocument(path) {
      if (++reads === 2) mutation()
      return f.sources.observeDocument(path)
    } })
    assert.throws(() => service.preview({ documents: [document], historyEffect: 'none' }), /changed during preview|Host-protected/)
  }
}))

for (const format of ['jsonl', 'sqlite'] as const) {
  test(`${format}: real persisted history remains readable and excluded from document-only effects`, async () => withTempWorkspace(async home => {
    const directory = join(home, 'sessions')
    const store = format === 'jsonl' ? new JsonlSessionStore(directory) : new SqliteSessionStore(directory)
    try {
      await store.init()
      const state = { sessionId: 'web:synthetic', segmentIndex: 1, projectId, ownershipVersion: 2 as const,
        physicalIdVersion: 2 as const, lastActivityAt: '2026-11-17T00:00:00.000Z' }
      await store.saveState(state.sessionId, state)
      for (let index = 0; index < 2; index++) await store.createSessionLog(physicalSessionId(state, index), [
        { type: 'start', timestamp: '2026-11-17T00:00:00.000Z' }, { role: 'user', content: `synthetic original ${index}` },
      ])
      const history = new SessionStoreMaintenanceHistory(store, { projectId, sessionsDirectory: directory, format })
      const inventory = await history.inventory()
      const old = await history.messages(state.sessionId, physicalSessionId(state, 0))
      const f = fixture(home, history)
      const plan = await f.service.previewDocuments({ documents: [f.select()], historyEffect: 'none' })
      assert.ok('effects' in plan)
      assert.equal(plan.effects.history, 'none')
      assert.deepEqual(await history.inventory(), inventory)
      assert.deepEqual(await history.messages(state.sessionId, physicalSessionId(state, 0)), old)
    } finally { store.close?.() }
  }))
}

test('authorized production routes expose nonempty observations, not caller approval; apply still 503', async () => withTempWorkspace(async home => {
  const f = fixture(home), app = new Hono()
  registerKnowledgeRoutes(app, { workspace: home, skills: f.skills, learningMaintenance: f.service,
    authorize: request => request.headers.get('x-synthetic') === 'authorized' })
  const prefix = '/api/knowledge/learning-maintenance/'
  const headers = { 'x-synthetic': 'authorized', 'Content-Type': 'application/json' }
  const post = (endpoint: string, body: unknown, authorized = true) => app.request(prefix + endpoint,
    { method: 'POST', headers: authorized ? headers : {}, body: JSON.stringify(body) })
  assert.equal((await post('documents', { paths: [f.page] }, false)).status, 401)
  const inspection = await post('documents', { paths: [f.page] })
  assert.equal(inspection.status, 200)
  assert.equal(inspection.headers.get('Cache-Control'), 'no-store')
  const [observed] = await inspection.json()
  const { provenance: _, ...selection } = observed
  const body = { documents: [{ ...selection, disposition: 'archive' }], historyEffect: 'none' }
  const response = await post('preview', body)
  assert.equal(response.status, 200)
  const plan = await response.json()
  assert.equal(plan.documents.length, 1)
  assert.equal(plan.contentReview, null)
  assert.equal((await post('preview', { ...body, approved: true })).status, 400)
  assert.equal((await post('documents', { paths: [f.page], protectedPaths: [] })).status, 400)
  assert.equal((await post('apply', { operationId: plan.operationId, manifestRevision: plan.planRevision })).status, 503)
  assert.equal(f.service.status().foundation.state, null)
}))
