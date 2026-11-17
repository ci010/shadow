import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { candidateSchema, captureCutoffs, checksum, manifestRevision, verifyCutoffs, type ArchiveCandidate, type HistoryInventory } from './maintenance-contracts.ts'
import { LearningMaintenanceFoundation, snapshotRevision, snapshotSchema, type MaintenanceSnapshot, type MaintenanceSources } from './maintenance-foundation.ts'

const createdAt = '2026-11-17T10:00:00.000Z'
const options = () => ({ operationId: randomUUID(), createdAt, fromEpoch: 0 })
const page = (text = 'old automatic knowledge'): MaintenanceSnapshot => ({ version: 1, directories: [], files: { 'page.md': Buffer.from(text).toString('base64') } })
function fixture() {
  // Synthetic Project only; no runtime/home resolver or live service is used.
  const home = mkdtempSync(join(tmpdir(), 'shadow-learning-foundation-'))
  after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }))
  const snapshot = page()
  let candidates: ArchiveCandidate[] = [{ projectId: 'test-project', path: 'memory/topics/example.md',
    sourceRevision: checksum(Buffer.from(snapshot.files['page.md'], 'base64')), snapshotRevision: snapshotRevision(snapshot),
    provenance: { kind: 'automatic-learning', batchId: randomUUID(), artifactRevision: checksum(Buffer.from(snapshot.files['page.md'], 'base64')), manual: false, builtin: false } }]
  let inventory: HistoryInventory = { projectId: 'test-project', revision: checksum('inventory'), complete: true, sessions: [
    { sessionId: 'unloaded-history', updatedAt: createdAt, segments: [
      { physicalId: 'physical-old', segmentIndex: 0 }, { physicalId: 'physical-current', segmentIndex: 1 },
    ] },
    { sessionId: 'empty-history', updatedAt: createdAt, segments: [{ physicalId: 'physical-empty', segmentIndex: 0 }] },
  ] }
  const messages = new Map<string, unknown[]>([['physical-old', [{ role: 'user', content: 'old message' }]],
    ['physical-current', [{ role: 'user', content: 'newer message' }]], ['physical-empty', []]])
  let reads = 0
  const sources: MaintenanceSources = {
    history: { async inventory() { return structuredClone(inventory) }, async messages(_sessionId, physicalId) {
      if (!messages.has(physicalId)) throw new Error('Missing segment')
      return structuredClone(messages.get(physicalId)!)
    } },
    async candidates() { return structuredClone(candidates) },
    async snapshot() { reads++; return structuredClone(snapshot) },
  }
  const service = () => new LearningMaintenanceFoundation(home, 'test-project', sources)
  return { home, snapshot, sources, service, messages, get reads() { return reads }, get candidates() { return candidates },
    set candidates(value) { candidates = value }, get inventory() { return inventory }, set inventory(value) { inventory = value } }
}

test('preview is read-only and captures every enumerated physical segment including empty histories', async () => {
  const f = fixture(), service = f.service()
  const plan = await service.preview(options())
  assert.deepEqual(readdirSync(f.home), [])
  assert.deepEqual(plan.manifest.cutoffs.map(c => [c.physicalId, c.messageCount]), [['physical-old', 1], ['physical-current', 1], ['physical-empty', 0]])
  assert.equal(plan.revision, manifestRevision(plan.manifest))
  assert.deepEqual(service.status(), { activation: 'unsupported', state: null })
  assert.throws(() => service.apply(), /unsupported/)
})

test('candidate validation preserves identity, conventions, manual, builtin and unknown sources', () => {
  const candidate = fixture().candidates[0]
  for (const path of ['memory/identities/user.md', 'memory/conventions/rules.md', 'memory/events/2026-11-17.jsonl',
    '../memory/topics/a.md', 'memory/topics/../a.md', '/memory/topics/a.md', 'memory\\topics\\a.md',
    'builtin:skills/a/SKILL.md', 'config/SOUL.md', 'skills/a/other.md', 'memory/topics/.hidden.md']) {
    assert.equal(candidateSchema.safeParse({ ...candidate, path }).success, false, path)
  }
  for (const provenance of [{ ...candidate.provenance, manual: true }, { ...candidate.provenance, builtin: true },
    { ...candidate.provenance, kind: 'manual' }, { ...candidate.provenance, kind: 'unknown' }, {},
    { ...candidate.provenance, artifactRevision: checksum('different') }]) {
    assert.equal(candidateSchema.safeParse({ ...candidate, provenance }).success, false)
  }
})

test('foreign candidates, foreign inventory, invalid times and missing segments fail rather than become empty', async () => {
  for (const mutation of ['candidate', 'inventory', 'time', 'gap', 'missing', 'incomplete', 'duplicate'] as const) {
    const f = fixture()
    if (mutation === 'candidate') f.candidates = [{ ...f.candidates[0], projectId: 'foreign' }]
    if (mutation === 'inventory') f.inventory.projectId = 'foreign'
    if (mutation === 'time') f.inventory.sessions[0].updatedAt = 'not-a-time'
    if (mutation === 'gap') f.inventory.sessions[0].segments.splice(0, 1)
    if (mutation === 'missing') f.messages.delete('physical-old')
    if (mutation === 'incomplete') Object.assign(f.inventory, { complete: false })
    if (mutation === 'duplicate') f.inventory.sessions[1].segments[0].physicalId = 'physical-old'
    await assert.rejects(() => f.service().preview(options()), { name: /Error/ }, mutation)
  }
  await assert.rejects(() => fixture().service().preview({ ...options(), createdAt: '2026-99-99T00:00:00Z' }))
})

test('inventory changes while capturing fail closed', async () => {
  const f = fixture()
  let count = 0
  f.sources.history.inventory = async () => ({ ...f.inventory, revision: checksum(String(count++)) })
  await assert.rejects(() => captureCutoffs('test-project', f.sources.history), /changed/)
})

test('prefix checks permit late append but reject rewrites/truncation independent of when fields', async () => {
  const f = fixture(), { cutoffs } = await captureCutoffs('test-project', f.sources.history)
  f.messages.get('physical-old')!.push({ when: '1900-01-01', content: 'late append' })
  await verifyCutoffs(cutoffs, f.sources.history)
  f.messages.get('physical-old')![0] = { when: '2099-01-01', content: 'rewrite' }
  await assert.rejects(() => verifyCutoffs(cutoffs, f.sources.history), /prefix conflict/)
  f.messages.set('physical-old', [])
  await assert.rejects(() => verifyCutoffs(cutoffs, f.sources.history), /prefix conflict/)
})

test('prepare persists immutable snapshots without changing source files; restart and prepare are idempotent', async () => {
  const f = fixture(), service = f.service()
  mkdirSync(join(f.home, 'memory', 'topics'), { recursive: true })
  writeFileSync(join(f.home, 'memory', 'topics', 'example.md'), 'original remains')
  const plan = await service.preview(options())
  assert.notEqual(plan.manifest.candidates[0].sourceRevision, plan.manifest.candidates[0].snapshotRevision)
  const state = await service.prepare(plan.manifest, plan.revision)
  assert.equal(state.phase, 'prepared')
  assert.equal(state.snapshots[f.candidates[0].path], f.candidates[0].snapshotRevision)
  assert.equal(f.reads, 1)
  assert.equal(readFileSync(join(f.home, 'memory', 'topics', 'example.md'), 'utf8'), 'original remains')
  const restarted = f.service()
  assert.deepEqual(restarted.status().state, state)
  assert.deepEqual(await restarted.prepare(plan.manifest, plan.revision), state)
  assert.equal(f.reads, 1)
  assert.deepEqual(restarted.archive(f.candidates[0].path), { archived: true, instructionAuthority: false, snapshot: f.snapshot })
  assert.throws(() => restarted.apply(), /unsupported/)
  assert.throws(() => new LearningMaintenanceFoundation(f.home, 'foreign-project', f.sources), /Foreign/)
})

test('full skill package snapshot retains binary resources and empty directories', async () => {
  const f = fixture()
  const snapshot: MaintenanceSnapshot = { version: 1, directories: ['assets', 'empty'], files: {
    'SKILL.md': Buffer.from('# Automated lesson').toString('base64'), 'assets/example.bin': Buffer.from([0, 255, 7]).toString('base64'),
  } }
  const sourceRevision = checksum(Buffer.from(snapshot.files['SKILL.md'], 'base64'))
  f.candidates = [{ ...f.candidates[0], path: 'skills/example/SKILL.md',
    sourceRevision, snapshotRevision: snapshotRevision(snapshot),
    provenance: { ...f.candidates[0].provenance, artifactRevision: sourceRevision } }]
  f.sources.snapshot = async () => snapshot
  const service = f.service(), plan = await service.preview(options())
  assert.notEqual(f.candidates[0].sourceRevision, f.candidates[0].snapshotRevision)
  const prepared = await service.prepare(plan.manifest, plan.revision)
  assert.equal(prepared.snapshots[f.candidates[0].path], snapshotRevision(snapshot))
  assert.equal(prepared.manifest.candidates[0].provenance.artifactRevision, sourceRevision)
  assert.deepEqual(service.archive(f.candidates[0].path).snapshot, snapshot)
  assert.equal(snapshotSchema.safeParse({ ...snapshot, files: { '../escape': '' } }).success, false)
  assert.equal(snapshotSchema.safeParse({ ...snapshot, files: { 'SKILL.md': '', 'skill.md': '' } }).success, false)
})

test('stale preview revision makes no writes; current-source conflicts durably block', async () => {
  const f = fixture(), service = f.service(), plan = await service.preview(options())
  await assert.rejects(() => service.prepare(plan.manifest, checksum('stale')), /revision/)
  assert.deepEqual(readdirSync(f.home), [])
  f.sources.snapshot = async () => page('unexpected changed content')
  await assert.rejects(() => service.prepare(plan.manifest, plan.revision), /revision conflict/)
  assert.equal(f.service().status().state?.phase, 'blocked')
  await assert.rejects(() => f.service().prepare(plan.manifest, plan.revision), /blocked/)
})

test('changed provenance, incomplete cutoff plan and stale history cannot be prepared', async () => {
  for (const mutation of ['provenance', 'omit-cutoffs', 'append'] as const) {
    const f = fixture(), service = f.service(), plan = await service.preview(options())
    if (mutation === 'provenance') f.candidates = []
    if (mutation === 'omit-cutoffs') { plan.manifest.cutoffs = []; plan.revision = manifestRevision(plan.manifest) }
    if (mutation === 'append') f.messages.get('physical-old')!.push({ content: 'late append before prepare; preview again' })
    await assert.rejects(() => service.prepare(plan.manifest, plan.revision), /conflict/)
    assert.equal(f.service().status().state?.phase, 'blocked')
  }
})

test('different operation or stale instance cannot overwrite a prepared receipt', async () => {
  const f = fixture(), first = f.service(), stale = f.service(), plan = await first.preview(options())
  const state = await first.prepare(plan.manifest, plan.revision)
  // A stale journal cannot save another state even if it reads fresh status.
  const other = await stale.preview(options())
  await assert.rejects(() => stale.prepare(other.manifest, other.revision), /operation conflict/)
  assert.deepEqual(f.service().status().state, state)
})

test('snapshot corruption is never overwritten or exposed as verified evidence', async () => {
  const f = fixture(), service = f.service(), plan = await service.preview(options())
  await service.prepare(plan.manifest, plan.revision)
  const file = join(f.home, 'state', 'learning', 'maintenance-foundation-v1', 'snapshots', `${f.candidates[0].snapshotRevision}.json`)
  // Fault injection by the synthetic test operator; the service never overwrites snapshots.
  const { chmodSync } = await import('node:fs')
  chmodSync(file, 0o600); writeFileSync(file, JSON.stringify(page('corrupt')))
  assert.throws(() => f.service().archive(f.candidates[0].path), /hash conflict/)
  await assert.rejects(() => f.service().prepare(plan.manifest, plan.revision), /hash conflict/)
  assert.equal(f.service().status().state?.phase, 'blocked')
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(page('corrupt')))
})

test('interrupted preparation remains visible and can resume after restart, not auto-activate', async () => {
  const f = fixture(), service = f.service(), plan = await service.preview(options())
  let release!: () => void, entered!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  f.sources.snapshot = async () => { entered(); await wait; return f.snapshot }
  const pending = service.prepare(plan.manifest, plan.revision)
  // The adapter is invoked only after the durable reservation.
  await started
  assert.equal(f.service().status().state?.phase, 'preparing')
  await assert.rejects(() => service.prepare(plan.manifest, plan.revision), /already running/)
  const restarted = f.service()
  f.sources.snapshot = async () => f.snapshot
  const resumed = await restarted.prepare(plan.manifest, plan.revision)
  assert.equal(resumed.phase, 'prepared')
  release()
  await assert.rejects(() => pending, /journal conflict/)
  assert.deepEqual(f.service().status().state, resumed)
  assert.throws(() => restarted.apply(), /unsupported/)
})


test('manifest corruption and unsafe storage symlinks are rejected on restart', async () => {
  const f = fixture(), service = f.service(), plan = await service.preview(options())
  await service.prepare(plan.manifest, plan.revision)
  const file = join(f.home, 'state', 'learning', 'maintenance-foundation-v1', 'state.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.manifest.cutoffs[0].messageCount++
  writeFileSync(file, JSON.stringify(state))
  assert.throws(() => f.service(), /checksum conflict/)
  const other = fixture()
  const { symlinkSync } = await import('node:fs')
  symlinkSync(f.home, join(other.home, 'state'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => other.service(), /Unsafe maintenance directory/)
})

test('snapshot adapter failure durably blocks after reservation, without deleting evidence', async () => {
  const f = fixture(), service = f.service(), plan = await service.preview(options())
  f.sources.snapshot = async () => { throw new Error('injected read failure') }
  await assert.rejects(() => service.prepare(plan.manifest, plan.revision), /injected read failure/)
  const restarted = f.service()
  assert.equal(restarted.status().state?.phase, 'blocked')
  assert.deepEqual(restarted.status().state?.manifest, plan.manifest)
  assert.deepEqual(restarted.status().state?.snapshots, {})
  await assert.rejects(() => restarted.prepare(plan.manifest, plan.revision), /blocked/)
  assert.throws(() => restarted.archive(plan.manifest.candidates[0].path), /No verified snapshot/)
})


test('native source provenance and independent snapshot mismatches reject separately', async () => {
  const source = fixture(), service = source.service(), plan = await service.preview(options())
  source.candidates = [{ ...source.candidates[0], sourceRevision: checksum('changed native source') }]
  await assert.rejects(() => service.prepare(plan.manifest, plan.revision), /Current revision lacks exact automatic provenance/)
  assert.equal(source.service().status().state?.phase, 'blocked')
  assert.deepEqual(source.service().status().state?.snapshots, {})

  const envelope = fixture(), second = envelope.service(), other = await second.preview(options())
  envelope.sources.snapshot = async () => page('different complete envelope')
  await assert.rejects(() => second.prepare(other.manifest, other.revision), /Candidate snapshot revision conflict/)
  assert.equal(envelope.service().status().state?.phase, 'blocked')
  assert.deepEqual(envelope.service().status().state?.snapshots, {})
  assert.equal(envelope.service().status().state?.manifest.candidates[0].sourceRevision, envelope.candidates[0].provenance.artifactRevision)
})
