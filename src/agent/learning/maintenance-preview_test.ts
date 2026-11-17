import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Hono } from 'hono'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { SkillsManager } from '../../skills/loader.ts'
import { SkillEditStore } from '../../skills/edit-store.ts'
import { registerKnowledgeRoutes } from '../../knowledge/routes.ts'
import { LearningLedger, fingerprint } from './ledger.ts'
import { checksum, type MaintenanceHistory } from './maintenance-contracts.ts'
import { ProjectMaintenanceSources } from './maintenance-sources.ts'
import { LearningMaintenancePreview } from './maintenance-preview.ts'
import type { MaintenanceSources } from './maintenance-foundation.ts'
import { LearningRuntime } from './pipelines.ts'
import { LearningTools } from './tools.ts'
import { fakeSessions } from './test-fixtures.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const projectId = 'synthetic-preview'
const history: MaintenanceHistory = { async inventory() { return { projectId, complete: true, revision: checksum('empty'), sessions: [] } }, async messages() { throw new Error('unknown history') } }
function fixture(home: string) {
  const skills = new SkillsManager(home)
  const ledger = new LearningLedger(home, projectId)
  const batch = ledger.create('reflector', [], [])
  const file = (path: string, text: string) => { const name = projectStoragePath(home, path); mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, text); return name }
  const page = (path = 'memory/topics/old.md', text = 'automatic knowledge\n') => {
    file(path, text)
    ledger.artifact(batch.id, { path, kind: 'memory', revision: fingerprint(text) })
  }
  const sources = new ProjectMaintenanceSources(home, projectId, skills, history)
  // Pure protocol tests below use independently trusted SYNTHETIC ownership.
  // The production adapter deliberately cannot produce such attestations yet.
  const trustedSources: MaintenanceSources = { history,
    async candidates() { return (await sources.protectedSources()).map(({ path, sourceRevision, snapshotRevision }) => ({
      projectId, path, sourceRevision, snapshotRevision, provenance: { kind: 'automatic-learning' as const,
        batchId: batch.id, artifactRevision: sourceRevision, manual: false as const, builtin: false as const } })) },
    async snapshot(candidate) { return { version: 1, directories: [], files: { 'page.md': readFileSync(projectStoragePath(home, candidate.path)).toString('base64') } } },
  }
  const service = new LearningMaintenancePreview(home, projectId, trustedSources)
  return { skills, ledger, batch, file, page, sources, service, trustedSources }
}

test('production adapter preserves matching automatic receipts without exclusive ownership proof', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  assert.deepEqual(await f.sources.candidates(), [])
  f.page()
  const [observed] = await f.sources.protectedSources()
  assert.equal(observed.sourceRevision, fingerprint('automatic knowledge\n'))
  assert.notEqual(observed.sourceRevision, observed.snapshotRevision)
  assert.equal(observed.reason, 'automatic-receipt-is-not-exclusive-ownership')
  assert.deepEqual(await f.sources.candidates(), [])
  const [syntheticCandidate] = await f.trustedSources.candidates()
  await assert.rejects(() => f.sources.snapshot(syntheticCandidate), /exclusive automatic ownership/)
  f.file(observed.path, 'manual replacement')
  assert.deepEqual(await f.sources.protectedSources(), [])
  assert.deepEqual(await f.sources.candidates(), [])
}))

test('identity/conventions/logs/manual/unknown/path traversal never become candidates', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  for (const path of ['memory/identities/user.md', 'memory/conventions/rules.md', 'memory/events/old.jsonl', 'SOUL.md']) f.page(path)
  f.file('memory/topics/manual.md', 'manual without receipt')
  f.file('memory/topics/unknown.md', '---\nprovenance: automatic-learning\n---\nnot evidence')
  f.ledger.artifact(f.batch.id, { path: '../outside.md', kind: 'memory', revision: checksum('fake') })
  assert.deepEqual(await f.sources.candidates(), [])
  const receipt = f.ledger.maintenanceArtifacts()
  receipt.length = 0
  assert.notEqual(f.ledger.maintenanceArtifacts().length, 0)
}))

test('single-member skill uses real package revision; resources and symlinks are protected', async () => withTempWorkspace(async home => {
  const f = fixture(home), store = new SkillEditStore(home, f.skills)
  const content = '---\nname: example\ndescription: Synthetic test lesson\n---\nHow to test\n'
  const saved = await store.save('example', { 'SKILL.md': content }, null)
  const path = 'skills/example/SKILL.md'
  f.ledger.artifact(f.batch.id, { path, kind: 'skill', revision: saved.revision })
  const [observed] = await f.sources.protectedSources()
  assert.equal(observed.sourceRevision, saved.revision)
  assert.deepEqual(await f.sources.candidates(), [])
  f.file('skills/example/extra.txt', 'unproven resource')
  assert.deepEqual(await f.sources.candidates(), [])
  const target = f.file('memory/topics/target.md', 'manual')
  const link = projectStoragePath(home, 'memory/topics/link.md')
  symlinkSync(target, link)
  f.ledger.artifact(f.batch.id, { path: 'memory/topics/link.md', kind: 'memory', revision: fingerprint('manual') })
  assert.deepEqual(await f.sources.candidates(), [])
}))

test('foreign ledger fails rather than becoming an empty candidate set', async () => withTempWorkspace(async home => {
  fixture(home)
  const sources = new ProjectMaintenanceSources(home, 'foreign-project', new SkillsManager(home), history)
  await assert.rejects(() => sources.candidates(), /different Project/)
}))

test('preview selects exact retirement and seed baselines, does not prepare or modify files', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  f.page(); f.page('memory/topics/seed.md', 'seed')
  const choices = (await f.service.candidates()).candidates
  const before = readFileSync(projectStoragePath(home, '.learning', 'state.v1.json'))
  const beforeEntries = readdirSync(projectStoragePath(home, '.learning'))
  const plan = await f.service.preview({ candidates: [choices[0]], seeds: [choices[1]] })
  assert.equal(plan.activation, 'disabled')
  assert.equal(plan.integration, 'partial')
  assert.equal(plan.manifest.candidates.length, 1)
  assert.equal(plan.seeds[0].sourceRevision, choices[1].sourceRevision)
  assert.deepEqual(readFileSync(projectStoragePath(home, '.learning', 'state.v1.json')), before)
  assert.deepEqual(readdirSync(projectStoragePath(home, '.learning')), beforeEntries)
  assert.throws(() => f.service.apply({ operationId: plan.manifest.operationId, manifestRevision: plan.manifestRevision }), /disabled/)
  assert.equal(f.service.status().activation, 'disabled')
  assert.equal(f.service.status().foundation.state, null)
}))

test('preview rejects stale revisions, duplicates, overlap and forged provenance/epochs', async () => withTempWorkspace(async home => {
  const f = fixture(home); f.page()
  const [selected] = (await f.service.candidates()).candidates
  for (const raw of [
    { candidates: [{ ...selected, sourceRevision: checksum('stale') }], seeds: [] },
    { candidates: [selected, selected], seeds: [] },
    { candidates: [selected], seeds: [selected] },
    { candidates: [{ ...selected, provenance: { kind: 'automatic-learning' } }], seeds: [] },
    { candidates: [selected], seeds: [], fromEpoch: 5 },
    { candidates: [{ ...selected, path: '../outside' }], seeds: [] },
  ]) await assert.rejects(() => f.service.preview(raw))
  f.file(selected.path, 'changed')
  await assert.rejects(() => f.service.preview({ candidates: [selected], seeds: [] }), /receipt/)
}))

test('knowledge authorization protects every maintenance endpoint; valid apply is disabled and forged evidence rejected', async () => withTempWorkspace(async home => {
  const f = fixture(home); f.page()
  const app = new Hono()
  registerKnowledgeRoutes(app, { workspace: home, skills: f.skills, authorize: async request => request.headers.get('x-synthetic-authorized') === 'yes', learningMaintenance: f.service })
  const prefix = '/api/knowledge/learning-maintenance/'
  for (const endpoint of ['status', 'candidates', 'preview', 'apply']) {
    const response = await app.request(prefix + endpoint, { method: ['preview', 'apply'].includes(endpoint) ? 'POST' : 'GET' })
    assert.equal(response.status, 401)
  }
  const headers = { 'x-synthetic-authorized': 'yes', 'Content-Type': 'application/json' }
  const status = await app.request(prefix + 'status', { headers })
  assert.equal(status.status, 200); assert.equal((await status.json()).activation, 'disabled')
  const choices = (await f.service.candidates()).candidates
  const response = await app.request(prefix + 'preview', { method: 'POST', headers, body: JSON.stringify({ candidates: choices, seeds: [] }) })
  assert.equal(response.status, 200)
  const plan = await response.json()
  for (const [body, expected] of [
    [{ operationId: plan.manifest.operationId, manifestRevision: plan.manifestRevision }, 503],
    [{ operationId: plan.manifest.operationId, manifestRevision: plan.manifestRevision, provenance: {} }, 400],
  ] as const) {
    const apply = await app.request(prefix + 'apply', { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(apply.status, expected)
  }
  const bad = await app.request(prefix + 'preview', { method: 'POST', headers, body: JSON.stringify({ candidates: [{ ...choices[0], sourceRevision: checksum('stale') }], seeds: [] }) })
  assert.equal(bad.status, 409)
  assert.equal(f.service.status().foundation.state, null)
}))

test('seed changes during history capture reject the plan; no implicit retry or preparation', async () => withTempWorkspace(async home => {
  const f = fixture(home); f.page()
  const [seed] = (await f.service.candidates()).candidates
  let changed = false
  const changingHistory: MaintenanceHistory = { ...history, async inventory() {
    if (!changed) { changed = true; f.file(seed.path, 'third-party seed change') }
    return history.inventory()
  } }
  const service = new LearningMaintenancePreview(home, projectId, { ...f.trustedSources, history: changingHistory })
  await assert.rejects(() => service.preview({ candidates: [], seeds: [seed] }), /Seed revision changed/)
  assert.equal(service.status().foundation.state, null)
  assert.equal(readFileSync(projectStoragePath(home, seed.path), 'utf8'), 'third-party seed change')
}))

test('manual Wiki updated through the formal automatic tool stays protected despite matching artifact receipt', async () => withTempWorkspace(async home => {
  const f = fakeSessions(home, [{ sessionId: 'web:source', segmentIndex: 0, total: 5 }])
  const skills = new SkillsManager(home)
  const runtime = new LearningRuntime(f.sessions, 'a', skills)
  const tools = new LearningTools(runtime)
  const batch = runtime.ledger.create('reflector', [{ sessionId: 'web:source', physicalId: 'source-physical', segmentIndex: 0, offset: 0, end: 5 }], [])
  runtime.ledger.bind(batch.id, 'cron:mixed-page')
  f.records.set('cron:mixed-page', { sessionId: 'cron:mixed-page', segmentIndex: 0, projectId: 'a' })
  const context: ExecutionContext = { sessionId: 'cron:mixed-page', projectId: 'a', physicalSessionId: 'mixed-page-0', cwd: home,
    signal: new AbortController().signal, channel: 'cron', chatId: 'mixed-page', senderId: 'fixture', messageId: 'fixture',
    tools: new SessionTools(new Tools(home), home) }
  const path = 'memory/topics/manual-mixed.md'
  const file = projectStoragePath(home, path)
  mkdirSync(dirname(file), { recursive: true })
  const manual = '# Hand-authored\nProtected manual understanding.'
  writeFileSync(file, manual)
  await tools.memory.execute({ action: 'save_wiki', path: 'topics/manual-mixed.md', revision: fingerprint(manual),
    content: `${manual}\nAutomatic addition.`, summary: 'Synthetic automatic update of a manual page.',
    wikiEvidence: [{ sessionId: 'web:source', physicalId: 'source-physical', offset: 0, end: 2 }] }, context)
  const receipt = runtime.ledger.batch(batch.id).artifacts.find(artifact => artifact.path === path)!
  assert.equal(receipt.revision, fingerprint(readFileSync(file, 'utf8')))
  const sources = new ProjectMaintenanceSources(home, 'a', skills, history)
  assert.equal((await sources.protectedSources())[0].reason, 'automatic-receipt-is-not-exclusive-ownership')
  assert.deepEqual(await sources.candidates(), [])
  assert.match(readFileSync(file, 'utf8'), /Protected manual understanding/)
}))

test('production composition reports protected receipts, rejects their selection and permits only empty planning', async () => withTempWorkspace(async home => {
  const f = fixture(home); f.page()
  const service = new LearningMaintenancePreview(home, projectId, f.sources)
  const assessment = await service.candidates()
  assert.deepEqual(assessment.candidates, [])
  assert.equal(assessment.protectedSources.length, 1)
  const { path, sourceRevision, snapshotRevision } = assessment.protectedSources[0]
  await assert.rejects(() => service.preview({ candidates: [{ path, sourceRevision, snapshotRevision }], seeds: [] }), /no current automatic receipt/)
  const plan = await service.preview({ candidates: [], seeds: [] })
  assert.deepEqual(plan.manifest.candidates, [])
  assert.equal(plan.activation, 'disabled')
  assert.equal(service.status().foundation.state, null)
}))
