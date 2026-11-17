import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { SkillsManager } from '../../skills/loader.ts'
import { SkillEditStore } from '../../skills/edit-store.ts'
import { KnowledgeService } from '../../knowledge/service.ts'
import { WikiDocumentStore } from '../../knowledge/document-store.ts'
import { MemoryStore } from '../memory.ts'
import { createMemoryHandler } from '../../vfs/mounts.ts'
import { Tools, SessionTools } from '../../tools/registry.ts'
import { WriteTool } from '../../tools/filesystem.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { checksum, type MaintenanceHistory } from './maintenance-contracts.ts'
import { ProjectMaintenanceSources } from './maintenance-sources.ts'
import { ReviewedMaintenancePreview, type HostContentReview } from './maintenance-reviewed.ts'
import { DocumentMaintenanceOperation, confirmDocumentExecution } from './maintenance-documents.ts'
import { MaintenanceGate } from './maintenance-gate.ts'
import { encapsulationInputs } from './inputs.ts'
import { LearningLedger } from './ledger.ts'

const projectId = 'synthetic-documents'
const history: MaintenanceHistory = { async inventory() { throw new Error('No history effect approved') }, async messages() { throw new Error('No history effect approved') } }
const content = (name: string, body: string) => `---\nname: ${name}\ndescription: Synthetic maintenance fixture only\n---\n${body}\n`
function context(home: string): ExecutionContext {
  return { sessionId: 'web:synthetic', physicalSessionId: 'synthetic-physical', projectId, cwd: home, signal: new AbortController().signal,
    channel: 'web', chatId: 'synthetic', senderId: 'synthetic', messageId: 'synthetic', tools: new SessionTools(new Tools(home), home) }
}
async function fixture(home: string, fault: (stage: string) => void = () => {}) {
  const skills = new SkillsManager(home), store = new SkillEditStore(home, skills)
  const file = (path: string, text: string) => { const name = projectStoragePath(home, path); mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, text); return name }
  file('memory/topics/archive.md', '# Archive\n\nOriginal mixed source\n')
  file('memory/topics/seed.md', '# Seed\n\nOriginal full seed\n')
  file('memory/topics/retain.md', '# Retain\n\nUnselected source\n')
  await store.save('archive-fixture', { 'SKILL.md': content('archive-fixture', 'Original archive skill') }, null)
  await store.save('seed-fixture', { 'SKILL.md': content('seed-fixture', 'Original full seed skill') }, null)
  const sources = new ProjectMaintenanceSources(home, projectId, skills, history)
  const reviewed = new ReviewedMaintenancePreview(projectId, sources)
  const paths = ['memory/topics/archive.md', 'memory/topics/seed.md', 'skills/archive-fixture/SKILL.md', 'skills/seed-fixture/SKILL.md']
  const request = { documents: reviewed.inspect({ paths }).map(({ provenance: _, ...item }) => ({ ...item, disposition: item.path.includes('seed') ? 'seed' as const : 'archive' as const })), historyEffect: 'none' }
  const review: HostContentReview = { version: 1, projectId, authority: 'host-content-review',
    scopeHash: reviewed.preview(request).scopeHash, reviewTextDigest: checksum('Synthetic explicit content selection') }
  const replacements = {
    'memory/topics/seed.md': { version: 1 as const, directories: [], files: { 'page.md': Buffer.from('# Seed\n\nCondensed seed\n').toString('base64') } },
    'skills/seed-fixture/SKILL.md': { version: 1 as const, directories: [], files: { 'SKILL.md': Buffer.from(content('seed-fixture', 'Condensed seed skill')).toString('base64') } },
  }
  const service = new DocumentMaintenanceOperation(home, projectId, sources, skills, fault)
  const { plan, revision } = service.plan(request, replacements, review)
  const confirmation = confirmDocumentExecution(plan, 'synthetic-host-independent-execution-decision')
  return { skills, store, file, sources, reviewed, request, review, plan, revision, confirmation, service,
    restart: (nextFault: (stage: string) => void = () => {}) => new DocumentMaintenanceOperation(home, projectId, sources, skills, nextFault) }
}

test('document safety chain snapshots all preimages, CAS seeds, durable retirement and every discovery surface agree', async () => withTempWorkspace(async home => {
  const f = await fixture(home), ctx = context(home), vfs = createMemoryHandler(home, projectId)
  const { createKnowledgeHandler } = await import('../../vfs/knowledge.ts')
  const logBytes = JSON.stringify({ what: 'Synthetic original log evidence', who: 'synthetic', origin: 'web:original' }) + '\n'
  f.file('memory/events/2026-11-17.jsonl', logBytes)
  const navigation = createKnowledgeHandler(new KnowledgeService(home, f.skills), projectId, () => {})
  const logPage = JSON.parse(await navigation.read('logs/date/2026-11-17', ctx))
  const locator = logPage.items[0].reference.replace('v:knowledge/', '')
  const projected = await navigation.read(locator, ctx)
  const peer = new SkillsManager(home); await peer.load()
  const peerGeneration = peer.mutationGeneration
  const originals = new Map(f.plan.request.documents.map(item => [item.path, readFileSync(projectStoragePath(home, item.path))]))
  assert.equal(f.service.status(), null)
  await f.service.prepare(f.plan, f.confirmation)
  assert.equal(f.service.status()?.phase, 'prepared')
  assert.equal(new MaintenanceGate(home).status().operation?.phase, 'reserved')
  await peer.load() // Real watcher reload while selected entries are hidden.
  assert.doesNotMatch(await new MemoryStore(home).readKeywords(), /archive —|seed —/)
  assert.equal(f.skills.getSkillBody('archive-fixture'), undefined)
  await assert.rejects(async () => vfs.read('topics/archive.md', ctx), /Retired document/)
  await assert.rejects(async () => vfs.write('topics/retain.md', { content: 'racing write' }, ctx), /fence active/)
  const committed = await f.restart().resume()
  assert.equal(committed.phase, 'committed')
  for (const item of f.plan.request.documents) {
    const snapshot = f.service.snapshot(item.snapshotRevision)
    const member = item.path.startsWith('memory/') ? 'page.md' : 'SKILL.md'
    assert.deepEqual(Buffer.from(snapshot.snapshot.files[member]!, 'base64'), originals.get(item.path))
    assert.equal(snapshot.instructionAuthority, false)
    if (item.disposition === 'archive') assert.deepEqual(readFileSync(projectStoragePath(home, item.path)), originals.get(item.path))
  }
  assert.match(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), /Condensed seed/)
  assert.match(f.skills.getSkillBody('seed-fixture')!, /Condensed seed skill/)
  assert.match(peer.getSkillBody('seed-fixture')!, /Condensed seed skill/)
  assert.ok(peer.mutationGeneration > peerGeneration)
  assert.equal(peer.getSkillBody('archive-fixture'), undefined)
  assert.equal(f.skills.getSkillBody('archive-fixture'), undefined)
  const catalog = new KnowledgeService(home, f.skills).catalog()
  assert.ok(!catalog.entries.some(item => item.id === 'memory/topics/archive.md' || item.id === 'skills/archive-fixture/SKILL.md'))
  assert.ok(catalog.entries.some(item => item.id === 'memory/topics/retain.md'))
  assert.doesNotMatch(await new MemoryStore(home).readKeywords(), /archive —/)
  const inputs = await encapsulationInputs(home, ctx.signal)
  assert.ok(!inputs.some(item => item.path === 'memory/topics/archive.md'))
  assert.ok(inputs.some(item => item.path === 'memory/topics/seed.md'))
  const listed = await vfs.list(ctx)
  assert.ok(!listed.some(item => item.name === 'topics/archive.md'))
  await assert.rejects(async () => vfs.write('topics/archive.md', { content: 'resurrection' }, ctx), /Retired/)
  await assert.rejects(() => new WriteTool(home).execute({ path: projectStoragePath(home, 'memory/topics/archive.md'), content: 'raw formal resurrection' }, ctx), /Retired/)
  assert.throws(() => new WikiDocumentStore(home).replace('memory/topics/archive.md', checksum(originals.get('memory/topics/archive.md')!), Buffer.from('new')), /Retired/)
  assert.throws(() => f.store.read('archive-fixture'), /Retired/)
  const oldRevision = f.plan.request.documents.find(item => item.path === 'skills/archive-fixture/SKILL.md')!.sourceRevision
  await assert.rejects(() => f.store.save('archive-fixture', { 'SKILL.md': content('archive-fixture', 'Resurrection') }, oldRevision), /Retired/)
  await assert.rejects(() => new WriteTool(home).execute({ path: projectStoragePath(home, 'skills/archive-fixture/resources/revive.ts'), content: 'no package resurrection' }, ctx), /Retired/)
  // Reopening/watch reload has no in-memory-only tombstone loophole.
  const reloaded = new SkillsManager(home); await reloaded.load()
  assert.equal(reloaded.getSkillBody('archive-fixture'), undefined)
  assert.match(reloaded.getSkillBody('seed-fixture')!, /Condensed seed skill/)
  assert.equal(f.restart().status()?.phase, 'committed')
  assert.equal((await f.restart().resume()).phase, 'committed')
  assert.match(readFileSync(projectStoragePath(home, 'memory/topics/retain.md'), 'utf8'), /Unselected source/)
  assert.equal(await navigation.read(locator, ctx), projected)
  assert.equal(await vfs.read('events/2026-11-17.jsonl', ctx), logBytes)
  const { Hono } = await import('hono')
  const { registerKnowledgeRoutes } = await import('../../knowledge/routes.ts')
  const { LearningMaintenancePreview } = await import('./maintenance-preview.ts')
  const app = new Hono()
  registerKnowledgeRoutes(app, { workspace: home, skills: f.skills,
    learningMaintenance: new LearningMaintenancePreview(home, projectId, f.sources),
    authorize: request => request.headers.get('x-synthetic') === 'authorized' })
  const snapshotPath = `/api/knowledge/learning-maintenance/snapshots/${f.plan.request.documents[0]!.snapshotRevision}`
  assert.equal((await app.request(snapshotPath)).status, 401)
  const response = await app.request(snapshotPath, { headers: { 'x-synthetic': 'authorized' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal((await response.json()).instructionAuthority, false)
  assert.equal((await app.request('/api/knowledge/learning-maintenance/snapshots/' + checksum('missing'), { headers: { 'x-synthetic': 'authorized' } })).status, 404)

}))

test('execution tokens cannot be forged, transplanted, or reused for modified seed plans', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  await assert.rejects(() => f.service.prepare(f.plan, { kind: 'host-document-execution-confirmation' }), /Host-held/)
  const changed = structuredClone(f.plan)
  changed.replacements['memory/topics/seed.md']!.files['page.md'] = Buffer.from('forged seed').toString('base64')
  await assert.rejects(() => f.service.prepare(changed, f.confirmation), /Host-held/)
  assert.equal(f.service.status(), null)
  assert.equal(new MaintenanceGate(home).status().operation, null)
  const foreign = new DocumentMaintenanceOperation(home, 'foreign-project', f.sources, f.skills)
  await assert.rejects(() => foreign.prepare(f.plan, f.confirmation), /Host-held/)
}))

test('persisted unfinished batches block preparation without acknowledging attempts, effects or outcomes', async () => withTempWorkspace(async home => {
  const f = await fixture(home), ledger = new LearningLedger(home, projectId)
  const batch = ledger.create('encapsulator', [], [])
  const before = ledger.batch(batch.id)
  await assert.rejects(() => f.service.prepare(f.plan, f.confirmation), /Unfinished learning batches/)
  assert.deepEqual(new LearningLedger(home, projectId).batch(batch.id), before)
  assert.equal(new MaintenanceGate(home).status().operation, null)
}))

for (const stage of ['reserved', 'snapshot-written', 'before-seed-write', 'seed-written', 'before-visibility', 'visibility-published', 'receipt-published', 'before-fence-release']) {
  test(`fault ${stage}: fence/evidence survive restart; exact operation resumes without replaying third-party versions`, async () => withTempWorkspace(async home => {
    let failed = false
    const f = await fixture(home, point => { if (!failed && point === stage) { failed = true; throw new Error(`synthetic crash ${stage}`) } })
    if (stage === 'reserved' || stage === 'snapshot-written') {
      await assert.rejects(() => f.service.prepare(f.plan, f.confirmation), /synthetic crash/)
      assert.equal(f.restart().status()?.phase, 'blocked')
      await f.restart().prepare(f.plan, f.confirmation)
    } else {
      await f.service.prepare(f.plan, f.confirmation)
      await assert.rejects(() => f.service.resume(), /synthetic crash/)
      assert.equal(f.restart().status()?.phase, 'blocked')
      assert.throws(() => new MaintenanceGate(home).assertIdle(), /fence active/)
    }
    const result = await f.restart().resume()
    assert.equal(result.phase, 'committed')
    assert.equal(new MaintenanceGate(home).status().operation?.id, f.plan.operationId)
    assert.equal(Object.keys(result.preimages).length, 4)
    assert.match(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), /Condensed/)
  }))
}

test('rollback after seed-write crash restores exact full original preimages through native CAS', async () => withTempWorkspace(async home => {
  let writes = 0
  const f = await fixture(home, stage => { if (stage === 'seed-written' && ++writes === 2) throw new Error('synthetic after both seeds') })
  const originals = f.plan.request.documents.map(item => [item.path, readFileSync(projectStoragePath(home, item.path))] as const)
  await f.service.prepare(f.plan, f.confirmation)
  await assert.rejects(() => f.service.resume(), /synthetic after both seeds/)
  const result = await f.restart().rollback()
  assert.equal(result.phase, 'rolled-back')
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(projectStoragePath(home, path)), bytes)
  assert.deepEqual(new MaintenanceGate(home).status().retired, [])
  assert.match(f.skills.getSkillBody('seed-fixture')!, /Original full seed skill/)
  assert.equal((await f.restart().rollback()).phase, 'rolled-back')
  await assert.rejects(() => f.restart().resume(), /Terminal/)
}))

test('seed CAS conflict never overwrites a third-party version and retains operation/preimage evidence', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  await f.service.prepare(f.plan, f.confirmation)
  f.file('memory/topics/seed.md', 'third-party version after preparation')
  await assert.rejects(() => f.service.resume(), /exact-CAS conflict/)
  assert.equal(f.restart().status()?.phase, 'blocked')
  await assert.rejects(() => f.restart().rollback(), /exact-CAS conflict/)
  assert.equal(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), 'third-party version after preparation')
  assert.equal(new MaintenanceGate(home).status().operation?.phase, 'mutating')
  assert.equal(Object.keys(f.restart().status()!.preimages).length, 4)
}))

test('corrupt immutable preimages block explicit recovery, not repaired/deleted by restart', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  await f.service.prepare(f.plan, f.confirmation)
  const revision = f.plan.request.documents[0]!.snapshotRevision
  const path = projectStoragePath(home, `state/learning/document-maintenance-v1/snapshots/${revision}.json`)
  writeFileSync(path, 'corrupt synthetic evidence')
  assert.equal(f.restart().status()?.phase, 'prepared')
  await assert.rejects(() => f.restart().resume())
  assert.equal(readFileSync(path, 'utf8'), 'corrupt synthetic evidence')
  assert.equal(new MaintenanceGate(home).status().operation?.phase, 'reserved')
}))


test('resume and rollback cannot concurrently mutate or publish different terminal visibility', async () => withTempWorkspace(async home => {
  let competing!: Promise<unknown>, once = false
  const f = await fixture(home, stage => {
    if (stage === 'before-visibility' && !once) {
      once = true
      competing = f.restart().rollback().catch(error => error)
    }
  })
  await f.service.prepare(f.plan, f.confirmation)
  const result = await f.service.resume()
  const rejected = await competing
  assert.ok(rejected instanceof Error)
  assert.match(rejected.message, /execution already owned/)
  assert.equal(result.phase, 'committed')
  assert.equal(f.restart().status()?.phase, 'committed')
  assert.equal(new MaintenanceGate(home).status().operation?.terminalDirection, 'commit')
  assert.ok(new MaintenanceGate(home).isRetired('memory/topics/archive.md'))
  assert.match(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), /Condensed/)
  await assert.rejects(() => f.restart().rollback(), /Terminal/)
}))

test('case aliases on case-insensitive volumes cannot resurrect retired documents through formal APIs', async t => withTempWorkspace(async home => {
  const f = await fixture(home), ctx = context(home), vfs = createMemoryHandler(home, projectId)
  await f.service.prepare(f.plan, f.confirmation); await f.service.resume()
  const canonicalFile = projectStoragePath(home, 'memory/topics/archive.md')
  const alias = projectStoragePath(home, 'memory/topics/ARCHIVE.md')
  const { existsSync } = await import('node:fs')
  if (!existsSync(alias)) {
    // Distinct files must not be retired merely by case folding on a sensitive FS.
    f.file('memory/topics/ARCHIVE.md', 'distinct manual uppercase file')
    assert.equal(new MaintenanceGate(home).isHidden('memory/topics/ARCHIVE.md'), false)
    return
  }
  const before = readFileSync(canonicalFile)
  await assert.rejects(async () => vfs.read('topics/ARCHIVE.md', ctx), /Retired/)
  await assert.rejects(async () => vfs.write('topics/ARCHIVE.md', { content: 'alias resurrection' }, ctx), /Retired/)
  await assert.rejects(() => new WriteTool(home).execute({ path: `${home}/MEMORY/topics/ARCHIVE.md`, content: 'root alias resurrection' }, ctx), /Retired/)
  assert.deepEqual(readFileSync(canonicalFile), before)
}))

test('async VFS consumption fails closed if a maintenance view changes while files are being listed', async () => withTempWorkspace(async home => {
  const f = await fixture(home), ctx = context(home), vfs = createMemoryHandler(home, projectId)
  const listing = Promise.resolve(vfs.list(ctx))
  await f.service.prepare(f.plan, f.confirmation)
  await assert.rejects(listing, /visibility changed/)
}))


test('pre-existing symlink aliases cannot bypass retired document protection through VFS or generic writes', async () => withTempWorkspace(async home => {
  const { symlinkSync, linkSync } = await import('node:fs')
  const f = await fixture(home), ctx = context(home), vfs = createMemoryHandler(home, projectId)
  const original = projectStoragePath(home, 'memory/topics/archive.md')
  const inside = projectStoragePath(home, 'memory/topics/alias.md'), outside = `${home}/outside-alias.md`
  symlinkSync(original, inside); symlinkSync(original, outside)
  await f.service.prepare(f.plan, f.confirmation); await f.service.resume()
  const before = readFileSync(original)
  await assert.rejects(async () => vfs.read('topics/alias.md', ctx), /Linked knowledge paths/)
  for (const path of [inside, outside]) await assert.rejects(() => new WriteTool(home).execute({ path, content: 'must not overwrite' }, ctx), /Linked knowledge paths|Retired/)
  const hardlink = projectStoragePath(home, 'memory/topics/hardlink.md')
  linkSync(original, hardlink)
  await assert.rejects(async () => vfs.read('topics/hardlink.md', ctx), /unlinked regular/)
  await assert.rejects(() => new WriteTool(home).execute({ path: hardlink, content: 'must not overwrite' }, ctx), /hard links/)
  assert.deepEqual(readFileSync(original), before)
}))


test('retired document references leave learning admission without deleting original logs or done effects', async () => withTempWorkspace(async home => {
  const f = await fixture(home), ledger = new LearningLedger(home, projectId)
  const batch = ledger.create('reflector', [], [])
  ledger.bind(batch.id, 'cron:synthetic-original')
  const original = { id: 'synthetic-retired-ref', path: 'memory/events/2026-11-17.jsonl', origin: 'web:original',
    when: '2026-11-17T00:00:00.000Z', who: 'synthetic', what: 'Original explicit document reference', refs: ['v:memory/topics/archive.md'] }
  ledger.log(batch.id, original)
  ledger.propose(batch.id, 'applied', 'Synthetic original retained event')
  ledger.complete(batch.id)
  const before = ledger.batch(batch.id)
  assert.ok(ledger.logsFor('encapsulator').some(item => item.id === original.id))
  await f.service.prepare(f.plan, f.confirmation); await f.service.resume()
  const current = new LearningLedger(home, projectId)
  assert.ok(!current.logsFor('encapsulator').some(item => item.id === original.id))
  assert.deepEqual(current.batch(batch.id), before)
  assert.throws(() => current.create('encapsulator', [], [original]), /Retired document references/)
  assert.deepEqual(new LearningLedger(home, projectId).batch(batch.id), before)
}))
