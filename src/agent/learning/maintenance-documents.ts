import { randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { Journal } from '../../watermarks/journal.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { WikiDocumentStore } from '../../knowledge/document-store.ts'
import { KnowledgeError, readSafe, safePath } from '../../knowledge/service.ts'
import { SkillEditStore, validateSkillDocument } from '../../skills/edit-store.ts'
import type { SkillsManager } from '../../skills/loader.ts'
import { loadSingleSkill } from '../../skills/parse.ts'
import { archivePathSchema, canonical, checksum, revisionSchema } from './maintenance-contracts.ts'
import { snapshotRevision, snapshotSchema, type MaintenanceSnapshot } from './maintenance-foundation.ts'
import { MaintenanceGate, type MaintenanceOperation } from './maintenance-gate.ts'
import { LearningLedger } from './ledger.ts'
import { ReviewedMaintenancePreview, reviewedDocumentSchema, reviewedDocumentScope, reviewedPreviewRequest, reviewSchema, type HostContentReview, type ReviewedDocumentSources } from './maintenance-reviewed.ts'

const planSchema = z.object({ version: z.literal(1), projectId: z.string().min(1), operationId: z.string().uuid(),
  request: reviewedPreviewRequest, contentReview: reviewSchema,
  replacements: z.record(archivePathSchema, snapshotSchema),
  effects: z.object({ history: z.literal('none'), epoch: z.literal('unchanged'),
    unfinishedLearning: z.literal('must-be-empty-no-acknowledgement'),
    learningInputs: z.literal('exclude-explicit-retired-document-references-only'),
    activePathsUnavailableWhileFenced: z.literal(true), sourceBytes: z.literal('archive-retains-original-seed-exact-cas') }).strict(),
}).strict().superRefine((plan, context) => {
  const scopeHash = checksum(canonical(reviewedDocumentScope(plan.projectId, plan.request.documents)))
  if (plan.contentReview.projectId !== plan.projectId || plan.contentReview.scopeHash !== scopeHash) context.addIssue({ code: 'custom', message: 'Content review scope conflict' })
  const seeds = plan.request.documents.filter(item => item.disposition === 'seed').map(item => item.path).sort()
  if (canonical(seeds) !== canonical(Object.keys(plan.replacements).sort())) context.addIssue({ code: 'custom', message: 'Each seed requires one exact replacement; archives cannot have replacements' })
  if (new Set(plan.request.documents.map(item => item.path)).size !== plan.request.documents.length) context.addIssue({ code: 'custom', message: 'Duplicate document' })
})
export type DocumentMaintenancePlan = z.infer<typeof planSchema>
export const documentPlanRevision = (plan: DocumentMaintenancePlan) => checksum(canonical(planSchema.parse(plan)))

// Only the trusted host confirmation entrypoint can mint a usable token. There
// is no HTTP/tool route to it. A reference records the independently obtained
// execution decision, not a client-supplied approved:true flag.
const confirmations = new WeakMap<object, { operation: MaintenanceOperation; plan: DocumentMaintenancePlan; decisionReference: string }>()
export interface DocumentExecutionConfirmation { readonly kind: 'host-document-execution-confirmation' }
export function confirmDocumentExecution(plan: DocumentMaintenancePlan, decisionReference: string): DocumentExecutionConfirmation {
  if (!decisionReference.trim() || decisionReference.length > 2000) throw new Error('Independent host execution decision reference required')
  const confirmation: DocumentExecutionConfirmation = Object.freeze({ kind: 'host-document-execution-confirmation' })
  confirmations.set(confirmation, { operation: { id: plan.operationId, revision: documentPlanRevision(plan) },
    plan: structuredClone(planSchema.parse(plan)), decisionReference })
  return confirmation
}
const stateSchema = z.object({ version: z.literal(1), plan: planSchema, revision: revisionSchema,
  decisionReference: z.string().min(1).max(2000), phase: z.enum(['preparing', 'prepared', 'mutating', 'committed', 'rolling-back', 'rolled-back', 'blocked']),
  preimages: z.record(archivePathSchema, revisionSchema), seedEffects: z.record(archivePathSchema, revisionSchema),
  direction: z.enum(['commit', 'rollback']).optional(), error: z.string().max(2000).optional(),
}).strict().superRefine((state, context) => {
  if (state.revision !== documentPlanRevision(state.plan)) context.addIssue({ code: 'custom', message: 'Stored plan revision conflict' })
  for (const [path, revision] of Object.entries(state.preimages)) if (!state.plan.request.documents.some(item => item.path === path && item.snapshotRevision === revision)) context.addIssue({ code: 'custom', message: 'Foreign preimage' })
  for (const [path, revision] of Object.entries(state.seedEffects)) {
    const replacement = state.plan.replacements[path]
    if (!replacement || nativeRevision(path, replacement) !== revision) context.addIssue({ code: 'custom', message: 'Foreign seed effect' })
  }
})
type State = z.infer<typeof stateSchema>
function textBytes(path: string, snapshot: MaintenanceSnapshot): Buffer {
  snapshotSchema.parse(snapshot)
  const member = path.startsWith('memory/') ? 'page.md' : 'SKILL.md'
  if (snapshot.directories.length || canonical(Object.keys(snapshot.files)) !== canonical([member])) throw new Error('Document maintenance requires a complete single-member snapshot')
  const bytes = Buffer.from(snapshot.files[member]!, 'base64')
  if (!isUtf8(bytes) || bytes.includes(0)) throw new Error('Document maintenance requires lossless UTF-8 bytes')
  return bytes
}
function nativeRevision(path: string, snapshot: MaintenanceSnapshot): string {
  const bytes = textBytes(path, snapshot)
  return path.startsWith('memory/') ? checksum(bytes) : validateSkillDocument(path.split('/')[1]!, bytes)
}

function immutableJson(file: string, value: unknown): string {
  const bytes = canonical(value), revision = checksum(bytes)
  mkdirSync(dirname(file), { recursive: true }); safePath(dirname(file))
  if (existsSync(file)) {
    if (readSafe(file, 64 * 1024 * 1024).content !== bytes) throw new Error('Immutable evidence bytes conflict')
    return revision
  }
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  return revision
}
function captureDocumentSnapshot(home: string, snapshot: MaintenanceSnapshot) {
  const revision = snapshotRevision(snapshot)
  immutableJson(projectStoragePath(home, `state/learning/document-maintenance-v1/snapshots/${revision}.json`), snapshot)
  return revision
}

/** Explicit archive-only read; never registered in default discovery/search. */
export function readDocumentMaintenanceSnapshot(home: string, revision: string) {
  revisionSchema.parse(revision)
  const file = projectStoragePath(home, `state/learning/document-maintenance-v1/snapshots/${revision}.json`)
  let content: string
  try { content = readSafe(file, 64 * 1024 * 1024).content }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KnowledgeError('maintenance_snapshot_missing', 'No snapshot with this revision in this Project', 404)
    throw error
  }
  const value = snapshotSchema.parse(JSON.parse(content))
  if (snapshotRevision(value) !== revision) throw new Error('Immutable preimage checksum conflict')
  return { snapshot: value, revision, historical: true as const, instructionAuthority: false as const }
}

/** Internal explicit host protocol. NOT composed into production apply. All
 * mutations require a separate host-held full plan execution confirmation.
 * No status/constructor/read calls prepare or recover. The archive receipt is
 * retained even when a separately confirmed restoration follows it; neither
 * journal nor fencing evidence is removed to unblock a failure. */
export class DocumentMaintenanceOperation {
  private readonly root: string
  private readonly gate: MaintenanceGate
  constructor(private readonly home: string, private readonly projectId: string,
    private readonly sources: ReviewedDocumentSources, private readonly skills: SkillsManager,
    private readonly fault: (stage: string) => void = () => {}) {
    this.root = projectStoragePath(home, 'state/learning/document-maintenance-v1')
    this.gate = new MaintenanceGate(home)
  }
  private journal() {
    let ancestor = this.root
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    safePath(ancestor)
    const file = join(this.root, 'operation.json')
    if (existsSync(file)) safePath(file)
    return new Journal<State | null>(file, value => stateSchema.parse(value))
  }
  status(): State | null { return structuredClone(this.journal().read(null as State | null)) }
  plan(raw: unknown, replacements: Record<string, MaintenanceSnapshot>, contentReview: HostContentReview) {
    const preview = new ReviewedMaintenancePreview(this.projectId, this.sources).preview(raw, contentReview)
    const plan = planSchema.parse({ version: 1, projectId: this.projectId, operationId: preview.operationId,
      request: reviewedPreviewRequest.parse(raw), replacements, contentReview,
      effects: { history: 'none', epoch: 'unchanged', unfinishedLearning: 'must-be-empty-no-acknowledgement',
        learningInputs: 'exclude-explicit-retired-document-references-only',
        activePathsUnavailableWhileFenced: true, sourceBytes: 'archive-retains-original-seed-exact-cas' } })
    for (const document of plan.request.documents) {
      const current = this.sources.observeDocument(document.path)
      // Validate lossless preimages (including Skill frontmatter) before fencing.
      if (nativeRevision(document.path, current.snapshot) !== document.sourceRevision) throw new Error('Native source conflict')
    }
    for (const [path, snapshot] of Object.entries(plan.replacements)) nativeRevision(path, snapshot)
    return { plan, revision: documentPlanRevision(plan), activation: 'disabled' as const }
  }
  private unfinished() {
    if (new LearningLedger(this.home, this.projectId).unfinished().length) throw new Error('Unfinished learning batches block document maintenance; no batch was acknowledged or excluded')
  }
  private capture(snapshot: MaintenanceSnapshot) { return captureDocumentSnapshot(this.home, snapshot) }
  snapshot(revision: string) {
    return readDocumentMaintenanceSnapshot(this.home, revision)
  }
  private identity(state: State): MaintenanceOperation { return { id: state.plan.operationId, revision: state.revision } }
  async prepare(raw: DocumentMaintenancePlan, confirmation: DocumentExecutionConfirmation, expectedGateRevision?: string, released?: (revision: string) => void) {
    const submitted = planSchema.parse(raw), revision = documentPlanRevision(submitted), audit = confirmations.get(confirmation)
    const plan = audit?.plan ?? submitted
    if (!audit || audit.operation.id !== plan.operationId || audit.operation.revision !== revision || plan.projectId !== this.projectId) throw new Error('Host-held exact full-plan execution confirmation required')
    this.unfinished()
    const prior = this.status()
    if (prior && (prior.revision !== revision || prior.plan.operationId !== plan.operationId)) throw new Error('Another durable document operation exists')
    const reserved = this.gate.reserve({ id: plan.operationId, revision }, plan.request.documents.map(item => item.path), expectedGateRevision)
    return this.gate.operation({ id: plan.operationId, revision }, async () => {
      const current = this.status()
      const journal = this.journal()
      let state: State = current ?? { version: 1, plan, revision, decisionReference: audit.decisionReference, phase: 'preparing', preimages: {}, seedEffects: {} }
      if (current && current.phase !== 'preparing' && !(current.phase === 'blocked' && this.gate.status().operation?.phase === 'reserved')) { this.verifyPreimages(current); return structuredClone(current) }
      state.phase = 'preparing'
      journal.save(state)
      try {
        this.unfinished()
        this.fault('reserved')
        for (const document of plan.request.documents) {
          const source = this.sources.observeDocument(document.path)
          if (source.sourceRevision !== document.sourceRevision || snapshotRevision(source.snapshot) !== document.snapshotRevision
            || checksum(textBytes(document.path, source.snapshot)) !== document.sourceTextDigest) throw new Error('Source changed before immutable preimage capture')
          state.preimages[document.path] = this.capture(source.snapshot)
          this.fault('snapshot-written')
          journal.save(state)
        }
        state.phase = 'prepared'; journal.save(state)
        return structuredClone(state)
      } catch (error) { state.phase = 'blocked'; state.error = String(error).slice(0, 2000); journal.save(state); throw error }
    }, 'prepare', true, checksum(canonical(reserved)), released)
  }
  private verifyPreimages(state: State) {
    for (const document of state.plan.request.documents) {
      if (state.preimages[document.path] !== document.snapshotRevision) throw new Error('Complete immutable preimages required before mutation')
      const original = this.snapshot(document.snapshotRevision).snapshot
      if (nativeRevision(document.path, original) !== document.sourceRevision || checksum(textBytes(document.path, original)) !== document.sourceTextDigest) throw new Error('Preimage native/text revision conflict')
    }
  }
  private async replace(path: string, expectedRevision: string, snapshot: MaintenanceSnapshot) {
    const bytes = textBytes(path, snapshot)
    if (path.startsWith('memory/')) return new WikiDocumentStore(this.home).replace(path, expectedRevision, bytes)
    return (await new SkillEditStore(this.home, this.skills).save(path.split('/')[1]!, { 'SKILL.md': bytes.toString('utf8') }, expectedRevision)).revision
  }
  /** Explicit crash retry. Never called by construction/status. Reconciles only
   * exact preimage/postimage CAS domains; third-party revisions remain untouched. */
  async resume(expectedGateRevision?: string) { return this.finish(false, expectedGateRevision) }
  async rollback(expectedGateRevision?: string) { return this.finish(true, expectedGateRevision) }
  private async finish(rollback: boolean, expectedGateRevision?: string) {
    const state = this.status()
    if (!state || state.plan.projectId !== this.projectId) throw new Error('No matching durable document operation')
    return this.gate.operation(this.identity(state), () => this.finishOwned(rollback), rollback ? 'rollback' : 'commit', true, expectedGateRevision)
  }
  private async finishOwned(rollback: boolean) {
    const journal = this.journal(), state = journal.read(null as State | null)
    if (!state || state.plan.projectId !== this.projectId) throw new Error('No matching durable document operation')
    const operation = this.identity(state)
    if (state.phase === 'committed' || state.phase === 'rolled-back') {
      if ((state.phase === 'rolled-back') !== rollback) throw new Error('Terminal document operation cannot change direction')
      this.verifyPreimages(state); await this.refreshSkills(state, rollback); this.gate.settle(operation); return structuredClone(state)
    }
    this.verifyPreimages(state); this.unfinished()
    const published = this.gate.status()
    if (published.operation?.id === operation.id && published.operation.revision === operation.revision && published.operation.phase === 'committed') {
      if (published.operation.terminalDirection !== (rollback ? 'rollback' : 'commit') || state.direction !== (rollback ? 'rollback' : 'commit')) throw new Error('Published operation cannot change direction')
      const expectedRetired = rollback ? [] : state.plan.request.documents.filter(item => item.disposition === 'archive').map(item => item.path).sort()
      if (canonical(published.retired) !== canonical(expectedRetired)) throw new Error('Published retirement scope conflict')
      for (const document of state.plan.request.documents) {
        const expected = rollback || document.disposition === 'archive' ? this.snapshot(document.snapshotRevision).snapshot : state.plan.replacements[document.path]!
        const actual = this.sources.observeDocument(document.path)
        if (nativeRevision(document.path, expected) !== actual.sourceRevision || snapshotRevision(expected) !== snapshotRevision(actual.snapshot)) throw new Error('Post-publication source conflict; no overwrite')
      }
      state.phase = rollback ? 'rolled-back' : 'committed'; delete state.error; journal.save(state)
      await this.refreshSkills(state, rollback)
      this.gate.settle(operation)
      return structuredClone(state)
    }
    // Exclusive runner already acquired before reading the operation journal.
    state.direction = rollback ? 'rollback' : 'commit'
    state.phase = rollback ? 'rolling-back' : 'mutating'; journal.save(state)
    this.gate.transition(operation, 'mutating')
    try {
      for (const document of state.plan.request.documents) {
        const original = this.snapshot(document.snapshotRevision).snapshot
        const current = this.sources.observeDocument(document.path)
        const replacement = state.plan.replacements[document.path]
        if (!replacement) {
          if (current.sourceRevision !== document.sourceRevision || snapshotRevision(current.snapshot) !== document.snapshotRevision) throw new Error('Archive source changed; original retained and operation blocked')
          continue
        }
        const postRevision = nativeRevision(document.path, replacement), postSnapshot = snapshotRevision(replacement)
        const atOriginal = current.sourceRevision === document.sourceRevision && snapshotRevision(current.snapshot) === document.snapshotRevision
        const atReplacement = current.sourceRevision === postRevision && snapshotRevision(current.snapshot) === postSnapshot
        if (!atOriginal && !atReplacement) throw new Error('Seed exact-CAS conflict: third-party revision preserved')
        if (rollback ? !atOriginal : !atReplacement) {
          this.fault(rollback ? 'before-seed-restore' : 'before-seed-write')
          await this.replace(document.path, current.sourceRevision, rollback ? original : replacement)
          this.fault(rollback ? 'seed-restored' : 'seed-written')
        }
        if (rollback) delete state.seedEffects[document.path]
        else state.seedEffects[document.path] = postRevision
        journal.save(state)
      }
      for (const document of state.plan.request.documents) {
        const expected = rollback || document.disposition === 'archive' ? this.snapshot(document.snapshotRevision).snapshot : state.plan.replacements[document.path]!
        const actual = this.sources.observeDocument(document.path)
        if (actual.sourceRevision !== nativeRevision(document.path, expected) || snapshotRevision(actual.snapshot) !== snapshotRevision(expected)) throw new Error('Final source revalidation conflict')
      }
      this.fault('before-visibility')
      // Invalidate all affected in-process cached Skills before publishing
      // visibility. Watcher reloads cannot resurrect hidden paths mid-operation.
      for (const item of state.plan.request.documents.filter(item => item.path.startsWith('skills/'))) this.skills.forgetSkillDirectory(dirname(projectStoragePath(this.home, item.path)))
      this.gate.transition(operation, 'committed', rollback ? [] : state.plan.request.documents.filter(item => item.disposition === 'archive').map(item => item.path))
      this.fault('visibility-published')
      state.phase = rollback ? 'rolled-back' : 'committed'; delete state.error; journal.save(state)
      this.fault('receipt-published')
      await this.refreshSkills(state, rollback)
      this.fault('before-fence-release')
      this.gate.settle(operation)
      return structuredClone(state)
    } catch (error) { state.phase = 'blocked'; state.error = String(error).slice(0, 2000); journal.save(state); throw error }
  }
  private async refreshSkills(state: State, rollback: boolean) {
    for (const item of state.plan.request.documents.filter(item => item.path.startsWith('skills/'))) {
      const directory = dirname(projectStoragePath(this.home, item.path)), name = item.path.split('/')[1]!
      this.skills.forgetSkillDirectory(directory)
      if (rollback || item.disposition === 'seed') {
        const loaded = await loadSingleSkill(directory, name)
        if (loaded) this.skills.setSkill(name, loaded)
      }
    }
  }

}


const restorationPlanSchema = z.object({ version: z.literal(1), kind: z.literal('restore-archived-documents'),
  projectId: z.string().min(1), operationId: z.string().uuid(), originalReceipt: stateSchema,
  originalReceiptRevision: revisionSchema, gateRevision: revisionSchema,
  currentDocuments: z.array(reviewedDocumentSchema).max(1000),
  effects: z.object({ history: z.literal('none'), epoch: z.literal('unchanged'),
    visibility: z.literal('restore-only-original-archive-paths'), seeds: z.literal('exact-cas-original-preimages'),
    receipts: z.literal('retain-all-original-and-restoration-evidence'),
    learningInputs: z.literal('restore-document-reference-admission-without-replaying-history') }).strict(),
}).strict().superRefine((plan, context) => {
  const original = plan.originalReceipt
  if (original.phase !== 'committed' || original.plan.projectId !== plan.projectId ||
    checksum(canonical(original)) !== plan.originalReceiptRevision) context.addIssue({ code: 'custom', message: 'Original committed receipt identity/revision conflict' })
  const expected = original.plan.request.documents.map(item => ({ path: item.path, disposition: item.disposition })).sort((a, b) => a.path.localeCompare(b.path))
  const actual = plan.currentDocuments.map(item => ({ path: item.path, disposition: item.disposition })).sort((a, b) => a.path.localeCompare(b.path))
  if (canonical(expected) !== canonical(actual)) context.addIssue({ code: 'custom', message: 'Restoration must bind exactly the complete original scope' })
})
export type DocumentRestorationPlan = z.infer<typeof restorationPlanSchema>
export const documentRestorationRevision = (plan: DocumentRestorationPlan) => checksum(canonical(restorationPlanSchema.parse(plan)))
export interface DocumentRestorationConfirmation { readonly kind: 'host-document-restoration-confirmation' }
const restorationConfirmations = new WeakMap<object, { plan: DocumentRestorationPlan; revision: string; decisionReference: string }>()
/** Independently obtained host decision for restoration, NOT the archive token. */
export function confirmDocumentRestoration(raw: DocumentRestorationPlan, decisionReference: string): DocumentRestorationConfirmation {
  if (!decisionReference.trim() || decisionReference.length > 2000) throw new Error('Independent restoration execution decision reference required')
  const plan = restorationPlanSchema.parse(raw), token: DocumentRestorationConfirmation = Object.freeze({ kind: 'host-document-restoration-confirmation' })
  restorationConfirmations.set(token, { plan: structuredClone(plan), revision: documentRestorationRevision(plan), decisionReference })
  return token
}
const restorationStateSchema = z.object({ version: z.literal(1), plan: restorationPlanSchema, revision: revisionSchema,
  decisionReference: z.string().min(1).max(2000), phase: z.enum(['preparing', 'prepared', 'restoring', 'committed', 'blocked']),
  preimages: z.record(archivePathSchema, revisionSchema), seedEffects: z.record(archivePathSchema, revisionSchema),
  error: z.string().max(2000).optional(),
}).strict().superRefine((state, context) => {
  if (documentRestorationRevision(state.plan) !== state.revision) context.addIssue({ code: 'custom', message: 'Restoration plan checksum conflict' })
  for (const [path, revision] of Object.entries(state.preimages)) if (!state.plan.currentDocuments.some(item => item.path === path && item.snapshotRevision === revision)) context.addIssue({ code: 'custom', message: 'Foreign restoration preimage' })
  for (const [path, revision] of Object.entries(state.seedEffects)) {
    const source = state.plan.originalReceipt.plan.request.documents.find(item => item.path === path && item.disposition === 'seed')
    if (!source || source.sourceRevision !== revision) context.addIssue({ code: 'custom', message: 'Foreign restored seed effect' })
  }
})
type RestorationState = z.infer<typeof restorationStateSchema>

/** A separately planned, confirmed and receipted post-archive restoration. It
 * never rewrites the original operation.json, deletes a gate or resets cursors.
 * No production mutation route calls this class. */
export class DocumentMaintenanceRestoration {
  private readonly root: string
  private readonly gate: MaintenanceGate
  constructor(private readonly home: string, private readonly projectId: string,
    private readonly sources: ReviewedDocumentSources, private readonly skills: SkillsManager,
    private readonly fault: (stage: string) => void = () => {}) {
    this.root = projectStoragePath(home, 'state/learning/document-maintenance-v1')
    this.gate = new MaintenanceGate(home)
  }
  private journal() {
    let ancestor = this.root
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    safePath(ancestor)
    const file = join(this.root, 'restoration.json')
    if (existsSync(file)) safePath(file)
    return new Journal<RestorationState | null>(file, value => restorationStateSchema.parse(value))
  }
  status() { return structuredClone(this.journal().read(null)) }
  private original() { return new DocumentMaintenanceOperation(this.home, this.projectId, this.sources, this.skills).status() }
  private unfinished() {
    if (new LearningLedger(this.home, this.projectId).unfinished().length) throw new Error('Unfinished learning batches block restoration; no old work was acknowledged')
  }
  private originalSnapshot(plan: DocumentRestorationPlan, path: string) {
    const document = plan.originalReceipt.plan.request.documents.find(item => item.path === path)
    if (!document || plan.originalReceipt.preimages[path] !== document.snapshotRevision) throw new Error('Original immutable preimage receipt missing')
    const snapshot = readDocumentMaintenanceSnapshot(this.home, document.snapshotRevision).snapshot
    if (nativeRevision(path, snapshot) !== document.sourceRevision || checksum(textBytes(path, snapshot)) !== document.sourceTextDigest) throw new Error('Original preimage native/text revision conflict')
    return snapshot
  }
  private archivedSnapshot(plan: DocumentRestorationPlan, path: string) {
    return plan.originalReceipt.plan.replacements[path] ?? this.originalSnapshot(plan, path)
  }
  private verifyCurrent(plan: DocumentRestorationPlan, restored = false) {
    for (const document of plan.currentDocuments) {
      const expected = restored ? this.originalSnapshot(plan, document.path) : this.archivedSnapshot(plan, document.path)
      const actual = this.sources.observeDocument(document.path)
      if (actual.sourceRevision !== nativeRevision(document.path, expected) || snapshotRevision(actual.snapshot) !== snapshotRevision(expected)) throw new Error('Restoration exact-CAS conflict: third-party archive/seed bytes preserved')
      if (!restored && (actual.sourceRevision !== document.sourceRevision || snapshotRevision(actual.snapshot) !== document.snapshotRevision ||
        checksum(textBytes(document.path, actual.snapshot)) !== document.sourceTextDigest)) throw new Error('Restoration current complete document revision changed')
    }
  }
  plan() {
    if (this.status()) throw new Error('A restoration receipt already exists; explicitly resume its fixed plan')
    const originalReceipt = this.original()
    if (!originalReceipt || originalReceipt.phase !== 'committed' || originalReceipt.plan.projectId !== this.projectId) throw new Error('A committed original archive receipt is required')
    this.gate.assertIdle(); this.unfinished()
    const observed = new ReviewedMaintenancePreview(this.projectId, this.sources).inspect({ paths: originalReceipt.plan.request.documents.map(item => item.path) })
    const currentDocuments = observed.map(({ provenance: _, ...item }) => ({ ...item,
      disposition: originalReceipt.plan.request.documents.find(document => document.path === item.path)!.disposition }))
    const plan = restorationPlanSchema.parse({ version: 1, kind: 'restore-archived-documents', projectId: this.projectId,
      operationId: randomUUID(), originalReceipt, originalReceiptRevision: checksum(canonical(originalReceipt)),
      gateRevision: checksum(canonical(this.gate.status())), currentDocuments,
      effects: { history: 'none', epoch: 'unchanged', visibility: 'restore-only-original-archive-paths', seeds: 'exact-cas-original-preimages',
        receipts: 'retain-all-original-and-restoration-evidence', learningInputs: 'restore-document-reference-admission-without-replaying-history' } })
    this.verifyCurrent(plan)
    return { plan, revision: documentRestorationRevision(plan), activation: 'disabled' as const }
  }
  private save(journal: Journal<RestorationState | null>, state: RestorationState) {
    restorationStateSchema.parse(state)
    const revision = checksum(canonical(state))
    // Immutable receipt versions retain failures/effects as well as terminal
    // success. An interrupted CAS can leave an orphan receipt, never lost evidence.
    immutableJson(join(this.root, 'restoration-receipts', `${revision}.json`), state)
    journal.save(state)
  }
  async prepare(raw: DocumentRestorationPlan, confirmation: DocumentRestorationConfirmation, expectedGateRevision?: string, released?: (revision: string) => void) {
    const submitted = restorationPlanSchema.parse(raw), audit = restorationConfirmations.get(confirmation)
    if (!audit || audit.revision !== documentRestorationRevision(submitted) || audit.plan.projectId !== this.projectId) throw new Error('Independent host-held exact restoration confirmation required')
    const plan = audit.plan, revision = audit.revision, original = this.original()
    if (!original || checksum(canonical(original)) !== plan.originalReceiptRevision) throw new Error('Original complete receipt changed before restoration')
    const prior = this.status()
    if (prior && prior.revision !== revision) throw new Error('Another restoration plan already owns the durable receipt')
    this.unfinished()
    if (!prior) this.verifyCurrent(plan)
    const operation = { id: plan.operationId, revision }
    const reserved = this.gate.reserveRestoration({ id: original.plan.operationId, revision: original.revision }, plan.gateRevision, operation, plan.currentDocuments.map(item => item.path),
      original.plan.request.documents.filter(item => item.disposition === 'archive').map(item => item.path), expectedGateRevision)
    return this.gate.operation(operation, async () => {
      const journal = this.journal(), current = journal.read(null)
      if (current && current.phase !== 'preparing' && !(current.phase === 'blocked' && this.gate.status().operation?.phase === 'reserved')) return structuredClone(current)
      const state: RestorationState = current ?? { version: 1, plan, revision, decisionReference: audit.decisionReference, phase: 'preparing', preimages: {}, seedEffects: {} }
      state.phase = 'preparing'; this.save(journal, state)
      try {
        this.unfinished(); this.verifyCurrent(plan); this.fault('restore-reserved')
        for (const document of plan.currentDocuments) {
          const source = this.sources.observeDocument(document.path)
          if (source.sourceRevision !== document.sourceRevision || snapshotRevision(source.snapshot) !== document.snapshotRevision) throw new Error('Source changed before restoration snapshot')
          state.preimages[document.path] = captureDocumentSnapshot(this.home, source.snapshot)
          this.save(journal, state)
        }
        state.phase = 'prepared'; this.save(journal, state); this.fault('restore-prepared')
        return structuredClone(state)
      } catch (error) { state.phase = 'blocked'; state.error = String(error).slice(0, 2000); this.save(journal, state); throw error }
    }, 'restore', true, checksum(canonical(reserved)), released)
  }
  private verifyPreimages(state: RestorationState) {
    for (const document of state.plan.currentDocuments) {
      this.originalSnapshot(state.plan, document.path)
      if (state.preimages[document.path] !== document.snapshotRevision ||
        snapshotRevision(readDocumentMaintenanceSnapshot(this.home, document.snapshotRevision).snapshot) !== document.snapshotRevision) throw new Error('Complete immutable restoration preimages required')
    }
  }
  async resume(expectedGateRevision?: string) {
    const initial = this.status()
    if (!initial || initial.plan.projectId !== this.projectId) throw new Error('No matching restoration receipt')
    const operation = { id: initial.plan.operationId, revision: initial.revision }
    const currentGate = this.gate.status()
    if (expectedGateRevision !== undefined && checksum(canonical(currentGate)) !== expectedGateRevision) throw new Error('Current complete gate revision changed; new host recovery plan/confirmation required')
    if (initial.phase === 'committed' && currentGate.operation?.id === operation.id &&
      currentGate.operation.revision === operation.revision && currentGate.operation.settled && !currentGate.runner) {
      this.verifyPreimages(initial)
      if (checksum(canonical(this.original())) !== initial.plan.originalReceiptRevision) throw new Error('Original archive receipt changed')
      return structuredClone(initial)
    }
    return this.gate.operation(operation, async () => {
      const journal = this.journal(), state = journal.read(null)
      if (!state || state.revision !== operation.revision) throw new Error('Restoration receipt changed')
      this.verifyPreimages(state)
      if (checksum(canonical(this.original())) !== state.plan.originalReceiptRevision) throw new Error('Original archive receipt changed; restoration blocked')
      if (state.phase === 'committed') { await this.refresh(state.plan); this.gate.settle(operation); return structuredClone(state) }
      this.unfinished()
      const published = this.gate.status().operation
      if (published?.phase === 'committed') {
        if (published.terminalDirection !== 'restore') throw new Error('Restoration terminal direction conflict')
        this.verifyCurrent(state.plan, true)
      } else {
        state.phase = 'restoring'; this.save(journal, state); this.gate.transition(operation, 'mutating')
        try {
          for (const document of state.plan.currentDocuments) {
            const original = this.originalSnapshot(state.plan, document.path), archived = this.archivedSnapshot(state.plan, document.path)
            const current = this.sources.observeDocument(document.path)
            const atOriginal = current.sourceRevision === nativeRevision(document.path, original) && snapshotRevision(current.snapshot) === snapshotRevision(original)
            const atArchived = current.sourceRevision === nativeRevision(document.path, archived) && snapshotRevision(current.snapshot) === snapshotRevision(archived)
            if (!atOriginal && !atArchived) throw new Error('Restoration exact-CAS conflict: third-party revision preserved')
            if (document.disposition === 'seed' && !atOriginal) {
              this.fault('restore-before-seed')
              const bytes = textBytes(document.path, original)
              if (document.path.startsWith('memory/')) new WikiDocumentStore(this.home).replace(document.path, current.sourceRevision, bytes)
              else await new SkillEditStore(this.home, this.skills).save(document.path.split('/')[1]!, { 'SKILL.md': bytes.toString('utf8') }, current.sourceRevision)
              this.fault('restore-seed-written')
            }
            if (document.disposition === 'seed') state.seedEffects[document.path] = nativeRevision(document.path, original)
            this.save(journal, state)
          }
          this.verifyCurrent(state.plan, true); this.fault('restore-before-visibility')
          for (const item of state.plan.currentDocuments.filter(item => item.path.startsWith('skills/'))) this.skills.forgetSkillDirectory(dirname(projectStoragePath(this.home, item.path)))
          this.gate.publishRestoration(operation, state.plan.originalReceipt.plan.request.documents.filter(item => item.disposition === 'archive').map(item => item.path))
          this.fault('restore-visibility-published')
        } catch (error) { state.phase = 'blocked'; state.error = String(error).slice(0, 2000); this.save(journal, state); throw error }
      }
      try {
        state.phase = 'committed'; delete state.error; this.save(journal, state); this.fault('restore-receipt-published')
        await this.refresh(state.plan); this.fault('restore-before-fence-release'); this.gate.settle(operation)
        return structuredClone(state)
      } catch (error) { state.phase = 'blocked'; state.error = String(error).slice(0, 2000); this.save(journal, state); throw error }
    }, 'restore', true, expectedGateRevision)
  }
  private async refresh(plan: DocumentRestorationPlan) {
    for (const document of plan.currentDocuments.filter(item => item.path.startsWith('skills/'))) {
      const directory = dirname(projectStoragePath(this.home, document.path)), name = document.path.split('/')[1]!
      this.skills.forgetSkillDirectory(directory)
      const loaded = await loadSingleSkill(directory, name)
      if (loaded) this.skills.setSkill(name, loaded)
    }
  }
}
