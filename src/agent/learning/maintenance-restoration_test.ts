import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { SkillsManager } from '../../skills/loader.ts'
import { SkillEditStore } from '../../skills/edit-store.ts'
import { KnowledgeService } from '../../knowledge/service.ts'
import { MemoryStore } from '../memory.ts'
import { createMemoryHandler } from '../../vfs/mounts.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { checksum, type MaintenanceHistory } from './maintenance-contracts.ts'
import { ProjectMaintenanceSources } from './maintenance-sources.ts'
import { ReviewedMaintenancePreview, type HostContentReview } from './maintenance-reviewed.ts'
import { confirmDocumentExecution, confirmDocumentRestoration, DocumentMaintenanceOperation, DocumentMaintenanceRestoration, type DocumentRestorationConfirmation } from './maintenance-documents.ts'
import { MaintenanceGate } from './maintenance-gate.ts'
import { encapsulationInputs } from './inputs.ts'

const projectId = 'synthetic-restore'
const history: MaintenanceHistory = { async inventory() { throw new Error('No history effect approved') }, async messages() { throw new Error('No history effect approved') } }
const skillText = (name: string, text: string) => `---\nname: ${name}\ndescription: Synthetic restoration fixture\n---\n${text}\n`
async function fixture(home: string) {
  const skills = new SkillsManager(home), store = new SkillEditStore(home, skills)
  const file = (path: string, text: string) => { const name = projectStoragePath(home, path); mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, text) }
  file('memory/topics/archive.md', '# Archive\nOriginal full page\n')
  file('memory/topics/seed.md', '# Seed\nOriginal full seed\n')
  file('memory/topics/retain.md', '# Retain\nUnselected\n')
  await store.save('archive-fixture', { 'SKILL.md': skillText('archive-fixture', 'Original full archive skill') }, null)
  await store.save('seed-fixture', { 'SKILL.md': skillText('seed-fixture', 'Original full seed skill') }, null)
  const sources = new ProjectMaintenanceSources(home, projectId, skills, history), reviewed = new ReviewedMaintenancePreview(projectId, sources)
  const paths = ['memory/topics/archive.md', 'memory/topics/seed.md', 'skills/archive-fixture/SKILL.md', 'skills/seed-fixture/SKILL.md']
  const originals = new Map(paths.map(path => [path, readFileSync(projectStoragePath(home, path))]))
  const request = { documents: reviewed.inspect({ paths }).map(({ provenance: _, ...item }) => ({ ...item, disposition: item.path.includes('seed') ? 'seed' as const : 'archive' as const })), historyEffect: 'none' }
  const review: HostContentReview = { version: 1, projectId, authority: 'host-content-review', scopeHash: reviewed.preview(request).scopeHash, reviewTextDigest: checksum('Synthetic original content review') }
  const archive = new DocumentMaintenanceOperation(home, projectId, sources, skills)
  const { plan } = archive.plan(request, {
    'memory/topics/seed.md': { version: 1, directories: [], files: { 'page.md': Buffer.from('# Seed\nCondensed\n').toString('base64') } },
    'skills/seed-fixture/SKILL.md': { version: 1, directories: [], files: { 'SKILL.md': Buffer.from(skillText('seed-fixture', 'Condensed seed skill')).toString('base64') } },
  }, review)
  const archiveConfirmation = confirmDocumentExecution(plan, 'synthetic-independent-archive-decision')
  await archive.prepare(plan, archiveConfirmation); await archive.resume()
  const originalReceipt = readFileSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json'))
  const restore = (fault: (stage: string) => void = () => {}) => new DocumentMaintenanceRestoration(home, projectId, sources, skills, fault)
  const context: ExecutionContext = { sessionId: 'web:synthetic', physicalSessionId: 'synthetic-0', projectId, cwd: home,
    signal: new AbortController().signal, channel: 'web', chatId: 'synthetic', senderId: 'synthetic', messageId: 'synthetic', tools: new SessionTools(new Tools(home), home) }
  const assertRestored = () => {
    for (const [path, bytes] of originals) assert.deepEqual(readFileSync(projectStoragePath(home, path)), bytes)
    assert.deepEqual(readFileSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json')), originalReceipt)
    assert.deepEqual(new MaintenanceGate(home).status().retired, [])
    assert.equal(new MaintenanceGate(home).status().operation?.settled, true)
  }
  return { skills, sources, file, archive, archiveConfirmation, restore, originals, originalReceipt, context, assertRestored }
}

test('committed archive restarts into separately confirmed restoration with all consumers/evidence preserved', async () => withTempWorkspace(async home => {
  const f = await fixture(home), service = f.restore(), peer = new SkillsManager(home)
  await peer.load()
  assert.equal(peer.getSkillBody('archive-fixture'), undefined)
  assert.equal(service.status(), null)
  const { plan, revision } = service.plan()
  await assert.rejects(() => service.prepare(plan, f.archiveConfirmation as unknown as DocumentRestorationConfirmation), /Independent host-held/)
  const confirmation = confirmDocumentRestoration(plan, 'synthetic-independent-restoration-decision')
  const snapshotsBefore = readdirSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/snapshots'))
  await service.prepare(plan, confirmation)
  await peer.load() // Watcher drops hidden paths before restoration publication.
  const committed = await f.restore().resume()
  assert.equal(committed.phase, 'committed'); assert.equal(committed.revision, revision)
  f.assertRestored()
  const gate = new MaintenanceGate(home).status()
  assert.equal(gate.operationHistory[0]!.id, plan.originalReceipt.plan.operationId)
  assert.equal(gate.operation?.restores?.revision, plan.originalReceipt.revision)
  assert.ok(readdirSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/restoration-receipts')).length >= 3)
  for (const snapshot of snapshotsBefore) assert.ok(readdirSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/snapshots')).includes(snapshot))
  assert.match(peer.getSkillBody('archive-fixture')!, /Original full archive skill/)
  assert.match(peer.getSkillBody('seed-fixture')!, /Original full seed skill/)
  assert.match(await new MemoryStore(home).readKeywords(), /archive — Archive/)
  assert.ok(new KnowledgeService(home, f.skills).catalog().entries.some(entry => entry.id === 'memory/topics/archive.md'))
  const vfs = createMemoryHandler(home, projectId)
  assert.equal(await vfs.read('topics/archive.md', f.context), f.originals.get('memory/topics/archive.md')!.toString('utf8'))
  assert.ok((await vfs.list(f.context)).some(item => item.name === 'topics/archive.md'))
  assert.ok((await encapsulationInputs(home, f.context.signal)).some(item => item.path === 'memory/topics/archive.md'))
  assert.equal((await f.restore().resume()).phase, 'committed')
  assert.equal((await f.restore().prepare(plan, confirmation)).phase, 'committed')
  await assert.rejects(() => f.archive.resume(), /identity\/revision conflict/)
  assert.throws(() => f.restore().plan(), /receipt already exists/)
  // Duplicate restore is an idempotent receipt read, not a replay over later edits.
  f.file('memory/topics/seed.md', 'legitimate later third-party version')
  await f.restore().resume()
  assert.equal(readFileSync(projectStoragePath(home, 'memory/topics/seed.md'), 'utf8'), 'legitimate later third-party version')
  assert.equal(readFileSync(projectStoragePath(home, 'memory/topics/retain.md'), 'utf8'), '# Retain\nUnselected\n')
}))

for (const path of ['memory/topics/archive.md', 'memory/topics/seed.md', 'skills/archive-fixture/SKILL.md', 'skills/seed-fixture/SKILL.md']) {
  test(`${path}: third-party bytes before plan or during restoration are never overwritten`, async () => withTempWorkspace(async home => {
    const f = await fixture(home), { plan } = f.restore().plan(), confirmation = confirmDocumentRestoration(plan, 'synthetic-restore-decision')
    await f.restore().prepare(plan, confirmation)
    f.file(path, 'THIRD_PARTY_NEW_BYTES')
    await assert.rejects(() => f.restore().resume(), /conflict|changed|SKILL\.md|frontmatter/i)
    assert.equal(readFileSync(projectStoragePath(home, path), 'utf8'), 'THIRD_PARTY_NEW_BYTES')
    assert.equal(f.restore().status()?.phase, 'blocked')
    assert.deepEqual(readFileSync(projectStoragePath(home, 'state/learning/document-maintenance-v1/operation.json')), f.originalReceipt)
  }))
}
for (const path of ['memory/topics/archive.md', 'memory/topics/seed.md']) {
  test(`${path}: pre-plan drift rejects restoration without reserving or writing receipts`, async () => withTempWorkspace(async home => {
    const f = await fixture(home), before = new MaintenanceGate(home).status()
    f.file(path, 'third-party drift before plan')
    assert.throws(() => f.restore().plan(), /exact-CAS conflict/)
    assert.equal(f.restore().status(), null)
    assert.deepEqual(new MaintenanceGate(home).status(), before)
  }))
}

test('complete current gate revision and original receipt are part of the confirmed restoration scope', async () => withTempWorkspace(async home => {
  const f = await fixture(home), { plan } = f.restore().plan(), confirmation = confirmDocumentRestoration(plan, 'synthetic-restore-decision')
  new MaintenanceGate(home).writeSync(['memory/topics/retain.md'], () => undefined)
  await assert.rejects(() => f.restore().prepare(plan, confirmation), /complete gate revision changed/)
  assert.equal(f.restore().status(), null)
  const fresh = f.restore().plan().plan
  const changed = structuredClone(fresh); changed.currentDocuments[0]!.sourceTextDigest = checksum('forged')
  await assert.rejects(() => f.restore().prepare(changed, confirmDocumentRestoration(fresh, 'synthetic-new-decision')), /Independent host-held/)
  await f.restore().prepare(fresh, confirmDocumentRestoration(fresh, 'synthetic-new-decision'))
  await f.restore().resume(); f.assertRestored()
}))

for (const stage of ['restore-reserved', 'restore-prepared', 'restore-before-seed', 'restore-seed-written', 'restore-before-visibility', 'restore-visibility-published', 'restore-receipt-published', 'restore-before-fence-release']) {
  test(`${stage}: failure keeps fence/evidence and explicit restart resumes the same restore`, async () => withTempWorkspace(async home => {
    const f = await fixture(home), { plan } = f.restore().plan(), confirmation = confirmDocumentRestoration(plan, 'synthetic-restore-decision')
    let failed = false
    const faulted = f.restore(point => { if (!failed && point === stage) { failed = true; throw new Error(`synthetic crash ${stage}`) } })
    if (stage === 'restore-reserved' || stage === 'restore-prepared') {
      await assert.rejects(() => faulted.prepare(plan, confirmation), /synthetic crash/)
      assert.throws(() => new MaintenanceGate(home).assertIdle(), /fence active/)
      await f.restore().prepare(plan, confirmation)
    } else {
      await faulted.prepare(plan, confirmation)
      await assert.rejects(() => faulted.resume(), /synthetic crash/)
      assert.throws(() => new MaintenanceGate(home).assertIdle(), /fence active/)
    }
    assert.equal((await f.restore().resume()).phase, 'committed')
    f.assertRestored()
  }))
}

test('archive commit, concurrent restoration and repeated restoration cannot republish conflicting visibility', async () => withTempWorkspace(async home => {
  const f = await fixture(home), { plan } = f.restore().plan()
  let opposite!: Promise<unknown>, duplicate!: Promise<unknown>, once = false
  const service = f.restore(stage => {
    if (stage === 'restore-before-visibility' && !once) {
      once = true
      opposite = f.archive.resume().catch(error => error)
      duplicate = f.restore().resume().catch(error => error)
    }
  })
  await service.prepare(plan, confirmDocumentRestoration(plan, 'synthetic-restore-decision'))
  await service.resume()
  assert.match(String(await opposite), /identity\/revision conflict/)
  assert.match(String(await duplicate), /execution already owned/)
  await f.restore().resume(); f.assertRestored()
}))

test('actual process exit after a restored seed resumes with dead-runner evidence and no seed replay', async () => withTempWorkspace(async home => {
  const f = await fixture(home), { plan } = f.restore().plan()
  await f.restore().prepare(plan, confirmDocumentRestoration(plan, 'synthetic-restore-decision'))
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { SkillsManager } from './src/skills/loader.ts'
    import { ProjectMaintenanceSources } from './src/agent/learning/maintenance-sources.ts'
    import { DocumentMaintenanceRestoration } from './src/agent/learning/maintenance-documents.ts'
    const home = ${JSON.stringify(home)}, skills = new SkillsManager(home)
    const history = { async inventory(){throw new Error('no history effect')}, async messages(){throw new Error('no history effect')} }
    const sources = new ProjectMaintenanceSources(home, ${JSON.stringify(projectId)}, skills, history)
    await new DocumentMaintenanceRestoration(home, ${JSON.stringify(projectId)}, sources, skills,
      stage => {if(stage === 'restore-seed-written') process.exit(0)}).resume()
    throw new Error('expected synthetic process exit')
  `], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(new MaintenanceGate(home).status().runner?.direction, 'restore')
  await f.restore().resume(); f.assertRestored()
  assert.equal(new MaintenanceGate(home).status().abandonedExecutions.at(-1)?.direction, 'restore')
}))
