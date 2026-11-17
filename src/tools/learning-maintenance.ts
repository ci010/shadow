import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isDirectOwnerTurn, isOwnerSession } from '../sessions/owner-policy.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import type { SessionState } from '../sessions/session-store.ts'

import type { YieldManager } from '../sessions/yield.ts'
import { parseYieldAnswer, parseYieldRequest, type YieldRequest } from '../sessions/yield-contract.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { canonical, checksum, revisionSchema, archivePathSchema } from '../agent/learning/maintenance-contracts.ts'
import { snapshotRevision, type MaintenanceSnapshot } from '../agent/learning/maintenance-foundation.ts'
import { ReviewedMaintenancePreview, reviewedDocumentScope, type ReviewedDocumentSources } from '../agent/learning/maintenance-reviewed.ts'
import { confirmDocumentExecution, confirmDocumentRestoration, DocumentMaintenanceOperation, DocumentMaintenanceRestoration, type DocumentMaintenancePlan, type DocumentRestorationPlan } from '../agent/learning/maintenance-documents.ts'
import { MaintenanceGate } from '../agent/learning/maintenance-gate.ts'
import { DocumentMaintenanceProtection, protectionClassification } from '../agent/learning/maintenance-protection.ts'
import type { ProjectMaintenanceSources } from '../agent/learning/maintenance-sources.ts'

/** Production and tests share the persisted-owner/physical-source predicate. */
export function maintenanceOwnerAccess(context: ExecutionContext, projectId: string, state: SessionState | null | undefined,
  managed: boolean, localAvailable: boolean): boolean {
  return isOwnerSession(state, projectId) && !!state && state.sessionId === context.sessionId && !managed && localAvailable && physicalSessionId(state) === context.physicalSessionId
}

const selection = protectionClassification.extend({ replacementText: z.string().max(512 * 1024).optional() }).strict()
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inventory') }).strict(),
  z.object({ action: z.literal('inspect'), paths: z.array(archivePathSchema).min(1).max(1000) }).strict(),
  z.object({ action: z.literal('preview'), documents: z.array(selection).min(1).max(1000) }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('read'), revision: revisionSchema }).strict(),
  z.object({ action: z.literal('review'), revision: revisionSchema }).strict(),
  z.object({ action: z.literal('execute'), revision: revisionSchema }).strict(),
  z.object({ action: z.literal('recovery_preview'), direction: z.enum(['resume', 'rollback', 'restore', 'resume-restore']) }).strict(),
])
type Selection = z.infer<typeof selection>
type Direction = 'archive' | 'resume' | 'rollback' | 'restore' | 'resume-restore'
interface Entry {
  hostActionId: string; sessionId: string; physicalId: string
  direction: Direction; documents: Selection[]
  originals: Record<string, MaintenanceSnapshot>
  archive?: DocumentMaintenancePlan; restoration?: DocumentRestorationPlan
  contentDecision?: string
  baseline: string
  protectionRevision: string
  gateRevision: string
  inventory: ReturnType<ProjectMaintenanceSources['documentInventory']>
  preimageAvailability?: Record<string, 'durable-verified' | 'source-only-missing-snapshot-requires-prepare'>
}
const digest = (value: unknown) => checksum(canonical(value))
const decisionOptions = ['Approve this exact revision', 'Do not approve'] as [string, string]

/** Host-owned ephemeral plans; neither tool arguments nor persisted decision IDs
 * can mint authority. Construction/read/status do not create a durable journal.
 * Broker is the existing ownerOnly YieldManager (authenticated owner HTTP UI),
 * not the agent-facing Ask/Reply tools or historical decision lookup. */
export class LearningMaintenanceTool implements Tool {
  readonly name = 'learning_maintenance'
  readonly description = 'Document-only Project maintenance. Owning local durable private Web admin USER turn, sole direct call only; no scripts, child tasks, Bot, remote/LayerFS or retry. inventory returns the full bounded supported-document classification domain and explicitly protected unsupported paths (never sensitive identities/log bodies). inspect returns native/text/snapshot hashes. preview binds the full inventory full explicit retain/protected/archive/seed classifications and complete replacementText; supply exact inspected hashes, never a text hash as native Skill revision. read returns complete host-registered plan. review asks the HUMAN for content/classification approval only, then CAS-persists the exact Project protection policy/audit (not execution). Unlisted/new/changed/unsupported sources stay protected and previous known-manual protection cannot be downgraded. execute independently asks the HUMAN for this exact plan/action before mutation. recovery_preview binds the exact durable receipts for explicit resume/rollback/post-archive restore/resume-restore, each needs a NEW execute confirmation. Status/read never recover. No history/epoch changes. No approval/ref/token arguments. Unknown results must be inspected, never blindly retried. Plans disappear on restart; old status is still readable. HTTP apply remains unavailable.'
  readonly readonly = (args: Record<string, unknown>) => ['inventory', 'inspect', 'preview', 'status', 'read', 'recovery_preview'].includes(String(args.action))
  readonly parameters: ToolParameters = { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['inventory', 'inspect', 'preview', 'status', 'read', 'review', 'execute', 'recovery_preview'] },
    paths: { type: 'array', items: { type: 'string' } },
    documents: { type: 'array', description: 'preview: [{path, sourceRevision, snapshotRevision, sourceTextDigest, disposition: retain|protected|archive|seed, replacementText?}]. All hashes from current inspect; replacementText required only for seed. Changed historical checklist text needs fresh inspection and human content review.', items: { type: 'object' } },
    revision: { type: 'string', description: 'Exact host-registered revision, not a plan, receipt or approval.' },
    direction: { type: 'string', enum: ['resume', 'rollback', 'restore', 'resume-restore'] },
  } }
  private readonly plans = new Map<string, Entry>()
  private readonly attempted = new Set<string>()
  private busy = false
  constructor(private readonly projectId: string, private readonly sources: ReviewedDocumentSources & Pick<ProjectMaintenanceSources, 'documentInventory'>,
    private readonly operation: DocumentMaintenanceOperation, private readonly restoration: DocumentMaintenanceRestoration,
    private readonly gate: MaintenanceGate, private readonly protection: DocumentMaintenanceProtection, private readonly broker: Pick<YieldManager, 'askOwner'>,
    private readonly canUse: (context: ExecutionContext) => boolean) {}

  private authorize(context: ExecutionContext) {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId || !isDirectOwnerTurn(context) || context.remoteWorkdir || context.layerfsWorkdir ||
      context.scriptInvocation || context.recoveringToolCall || !context.soleDirectToolCall ||
      context.tools.dynamicOwner !== context.tools || !this.canUse(context)) throw new Error('Maintenance requires a current owning local durable private Web administrator user turn; unavailable in this execution context')
  }
  private baseline() { return digest({ archive: this.operation.status(), restoration: this.restoration.status(), gate: this.gate.status(), protection: this.protection.status() }) }
  private inspect(paths: string[]) { return new ReviewedMaintenancePreview(this.projectId, this.sources).inspect({ paths }) }
  private view(entry: Entry) {
    return { version: 1, projectId: this.projectId, ...entry,
      originalText: Object.fromEntries(Object.entries(entry.originals).map(([path, snapshot]) => [path,
        Buffer.from(snapshot.files[path.startsWith('memory/') ? 'page.md' : 'SKILL.md']!, 'base64').toString('utf8')])),
      provenance: 'unknown-not-automatic',
      effects: { history: 'none', epoch: 'unchanged', sourceLogs: 'unchanged', unselected: 'unchanged',
        contentReview: 'CAS-persists-exact-Project-classification-policy-and-immutable-audit-only-not-execution',
        coverage: 'inventory-supported-single-documents-only; all-unlisted-unsupported-new-or-changed-protected',
        classifications: 'human-selection-only-not-authorship-attestation; existing-protected-cannot-be-downgraded',
        unfinishedLearning: 'blocks-execution-no-acknowledgement', temporaryVisibility: 'selected-documents-unavailable-while-fenced',
        archive: 'original-bytes-retained-but-excluded-from-active-consumers', seed: 'exact-native-CAS-full-replacement',
        recovery: 'explicit-new-human-confirmation-required-no-automatic-retry', restore: 'independent-receipt-original-snapshots-retained',
        limitations: 'external-OS-writers-not-fenced; previously-delivered-context-not-retracted; resource-bearing-Skills-unsupported' },
    }
  }
  private register(entry: Entry) {
    // Bound ephemeral memory and never evict a pending confirmation's plan.
    if (this.plans.size >= 128) throw new Error('Host plan capacity reached; restart only after inspecting durable status')
    const stored = structuredClone(entry), bytes = canonical(this.view(stored))
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('Complete host plan exceeds 16 MiB; no truncated plan can be confirmed')
    const revision = checksum(bytes)
    this.plans.set(revision, stored)
    return this.result(revision, stored)
  }
  private result(revision: string, entry: Entry) {
    return { revision, plan: this.view(entry), fullPlanUrl: `/projects/${encodeURIComponent(this.projectId)}/api/knowledge/learning-maintenance/owner-plans/${revision}`,
      approval: entry.direction === 'archive' && !entry.archive ? 'content-review-required-then-independent-execution' : 'independent-execution-required' }
  }
  private get(revision: string, context: ExecutionContext) {
    const entry = this.plans.get(revision)
    if (!entry || entry.sessionId !== context.sessionId || entry.physicalId !== context.physicalSessionId || digest(this.view(entry)) !== revision) throw new Error('Unknown, foreign or expired host plan; inspect status and generate a new plan')
    return entry
  }
  /** Authenticated owner GET only. No mutation/confirmation route is exposed. */
  ownerPlan(revision: string) {
    revisionSchema.parse(revision)
    const entry = this.plans.get(revision)
    if (!entry) throw new Error('Host plan not available in this loaded instance; generate a new plan')
    return this.result(revision, entry)
  }
  private recheck(entry: Entry, context: ExecutionContext) {
    this.authorize(context)
    if (entry.gateRevision !== digest(this.gate.status())) throw new Error('Complete gate version changed; new plan and confirmation required')
    if (entry.protectionRevision !== this.protection.revision()) throw new Error('Protection policy version changed; new plan and confirmation required')
    if (entry.baseline !== this.baseline()) throw new Error('Durable receipt/gate/protection version changed; inspect status and generate a new plan')
    if (digest(entry.inventory) !== digest(this.sources.documentInventory())) throw new Error('Full classification inventory changed; missing/new/changed entries remain protected; generate a new plan and confirm again')
    for (const document of entry.documents.filter(item => ['archive', 'seed'].includes(item.disposition))) this.protection.assertUnprotected(document.path)
    for (const document of entry.documents) {
      const current = this.inspect([document.path])[0]!
      if (current.sourceRevision !== document.sourceRevision || current.snapshotRevision !== document.snapshotRevision || current.sourceTextDigest !== document.sourceTextDigest) throw new Error(`Document changed: ${document.path}; new inspection and content review required`)
    }
  }
  private async human(entry: Entry, revision: string, phase: 'content' | 'execution', context: ExecutionContext) {
    let opened: YieldRequest | undefined
    const counts = ['archive', 'seed', 'retain', 'protected'].map(disposition => `${entry.documents.filter(item => item.disposition === disposition).length} ${disposition}`).join(', ')
    const question = `${phase === 'content' ? 'Review CONTENT ONLY (not execution)' : 'Authorize EXECUTION'}: ${entry.direction}; Project ${this.projectId}; ${entry.documents.length} files (${counts}). Exact revision ${revision}. Read the COMPLETE plan including original text, retain/archive choices, full seed replacements, direct/indirect effects and restoration receipts before deciding: /projects/${encodeURIComponent(this.projectId)}/api/knowledge/learning-maintenance/owner-plans/${revision} . Selected paths become temporarily unavailable while fenced; unfinished learning batches block execution. History NONE; epoch UNCHANGED. Content approval CAS-persists only this Project's exact classification policy plus immutable audit, NOT archive execution. Inventory covers supported single documents only; all unlisted/unsupported/new/changed entries remain protected; existing known-manual protection cannot be downgraded. Classification does NOT attest authorship; provenance remains unknown. Restoration and recovery need separate fresh approval. Denial/default/timeout/cancel never authorize changes.`
    const outcome = await this.broker.askOwner(context.sessionId, {
      independent: true, question,
      options: decisionOptions, defaultOption: decisionOptions[1],
    }, context.signal, 10 * 60 * 1000, request => {
      if (request.question !== question || request.independent !== true || !request.ownerOnly || request.sessionId !== context.sessionId || request.recipient.kind !== 'user' || request.recipient.sessionId !== context.sessionId ||
        request.origin?.physicalId !== context.physicalSessionId || !request.id || !request.origin || !request.deadline ||
        canonical(request.options) !== canonical(decisionOptions) || request.defaultOption !== decisionOptions[1]) throw new Error('Owner human broker identity/origin unavailable')
      opened = parseYieldRequest(structuredClone(request), context.sessionId)
    })
    this.recheck(entry, context)
    if (!opened || !('answeredBy' in outcome)) throw new Error('No current explicit human approval for this exact host plan')
    const answer = parseYieldAnswer(outcome, opened)
    if (answer.answeredBy !== 'user' || answer.custom || answer.option !== decisionOptions[0] ||
      answer.requestId !== opened.id || !answer.reference || answer.reference.requestId !== opened.id ||
      answer.reference.sessionId !== context.sessionId || answer.reference.physicalId !== context.physicalSessionId ||
      !Number.isFinite(Date.parse(answer.answeredAt)) || Date.parse(answer.answeredAt) > Date.parse(opened.deadline!) ||
      Date.parse(answer.answeredAt) < Date.parse(opened.createdAt)) throw new Error('No current explicit human approval for this exact host plan')
    return canonical({ phase, projectId: this.projectId, revision, request: answer.reference, answeredAt: answer.answeredAt })
  }
  async execute(raw: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    this.authorize(context)
    const args = input.parse(raw)
    if (args.action === 'status') return JSON.stringify({ archive: this.operation.status(), restoration: this.restoration.status(), gate: this.gate.status(), protection: this.protection.status(), hostPlans: 'ephemeral-no-history-approval-reuse' })
    if (args.action === 'read') return JSON.stringify(this.result(args.revision, this.get(args.revision, context)))
    if (this.busy) throw new Error('Another maintenance host request is pending; inspect status, do not replay')
    if (args.action === 'inventory') return JSON.stringify({ ...this.sources.documentInventory(), protection: this.protection.status() })
    if (args.action === 'inspect') return JSON.stringify(this.inspect(args.paths))
    if (args.action === 'preview') {
      if (this.operation.status() || this.restoration.status()) throw new Error('A durable operation exists; inspect status and use explicit recovery_preview, never replay archive')
      if (new Set(args.documents.map(item => item.path)).size !== args.documents.length) throw new Error('Duplicate selection')
      if (!args.documents.some(item => ['archive', 'seed'].includes(item.disposition))) throw new Error('No documents selected for maintenance')
      const inventory = this.sources.documentInventory()
      if (canonical(args.documents.map(item => item.path).sort()) !== canonical(inventory.eligible.map(item => item.path).sort())) throw new Error('Provide the full supported-document classification list; missing/unlisted/unsupported entries are protected, never implicitly eligible')
      const originals: Entry['originals'] = {}
      for (const document of args.documents) {
        if ((document.disposition === 'seed') !== (document.replacementText !== undefined)) throw new Error('Only seeds require complete replacementText')
        const observed = this.sources.observeDocument(document.path)
        const member = document.path.startsWith('memory/') ? 'page.md' : 'SKILL.md'
        if (observed.sourceRevision !== document.sourceRevision || snapshotRevision(observed.snapshot) !== document.snapshotRevision ||
          checksum(Buffer.from(observed.snapshot.files[member]!, 'base64')) !== document.sourceTextDigest) throw new Error(`Document changed: ${document.path}; new inspection and content review required`)
        originals[document.path] = observed.snapshot
        if (Buffer.byteLength(canonical(originals)) > 8 * 1024 * 1024) throw new Error('Complete preimages exceed bounded plan size; no partial content review')
      }
      const entry: Entry = { hostActionId: randomUUID(), sessionId: context.sessionId, physicalId: context.physicalSessionId, direction: 'archive',
        documents: args.documents, originals, baseline: this.baseline(), protectionRevision: this.protection.revision(), gateRevision: digest(this.gate.status()), inventory }
      this.recheck(entry, context)
      return JSON.stringify(this.register(entry))
    }
    if (args.action === 'recovery_preview') {
      const archive = this.operation.status(), restoration = this.restoration.status()
      let restorePlan: DocumentRestorationPlan | undefined
      if (args.direction === 'restore') restorePlan = this.restoration.plan().plan
      else if (args.direction === 'resume-restore') {
        if (!restoration) throw new Error('No restoration receipt to resume')
        restorePlan = restoration.plan
      } else {
        if (!archive || restoration) throw new Error('No unambiguous archive receipt to recover; inspect status')
        if (args.direction === 'rollback' && archive.phase === 'committed') throw new Error('Committed archive requires independent restore, not rollback')
        if (args.direction === 'resume' && archive.phase === 'rolled-back') throw new Error('Rolled-back receipt cannot resume archive execution')
      }
      const fixedArchive = restorePlan ? undefined : archive!.plan
      const originals: Entry['originals'] = {}
      const documents = fixedArchive?.request.documents ?? restorePlan!.originalReceipt.plan.request.documents
      const preimageAvailability: NonNullable<Entry['preimageAvailability']> = {}
      for (const document of documents) {
        try {
          originals[document.path] = this.operation.snapshot(document.snapshotRevision).snapshot
          preimageAvailability[document.path] = 'durable-verified'
        } catch (error) {
          // Only a genuinely NOT-YET-captured preimage can be reconstructed for
          // display from unchanged formal source bytes. Never repair corrupt or
          // missing already-receipted snapshots, nor a post-mutation receipt.
          if ((error as { code?: string }).code !== 'maintenance_snapshot_missing' || !fixedArchive ||
            archive!.preimages[document.path] || !['preparing', 'blocked'].includes(archive!.phase) ||
            this.gate.status().operation?.phase !== 'reserved') throw error
          const current = this.sources.observeDocument(document.path), member = document.path.startsWith('memory/') ? 'page.md' : 'SKILL.md'
          if (current.sourceRevision !== document.sourceRevision || snapshotRevision(current.snapshot) !== document.snapshotRevision ||
            checksum(Buffer.from(current.snapshot.files[member]!, 'base64')) !== document.sourceTextDigest) throw new Error('Uncaptured preimage source changed; cannot authorize recapture')
          originals[document.path] = current.snapshot
          preimageAvailability[document.path] = 'source-only-missing-snapshot-requires-prepare'
        }
      }
      const observed = this.inspect(documents.map(item => item.path)).map(({ provenance: _, ...item }) => ({ ...item,
        disposition: documents.find(document => document.path === item.path)!.disposition }))
      const entry: Entry = { hostActionId: randomUUID(), sessionId: context.sessionId, physicalId: context.physicalSessionId, direction: args.direction,
        documents: observed, originals, preimageAvailability, baseline: this.baseline(), protectionRevision: this.protection.revision(), gateRevision: digest(this.gate.status()),
        inventory: this.sources.documentInventory(), ...(fixedArchive ? { archive: fixedArchive } : { restoration: restorePlan }) }
      this.recheck(entry, context)
      return JSON.stringify(this.register(entry))
    }
    const entry = this.get(args.revision, context)
    this.recheck(entry, context)
    if (this.attempted.has(args.revision)) throw new Error('This host action was already attempted or outcome is unknown; inspect status and explicitly create a recovery plan')
    this.attempted.add(args.revision) // Includes denied/cancelled prompts: no blind replay.
    this.busy = true
    try {
      if (args.action === 'review') {
        if (entry.direction !== 'archive' || entry.archive) throw new Error('Only a fresh content draft can be reviewed')
        const decision = await this.human(entry, args.revision, 'content', context)
        const documents = entry.documents.filter(item => ['archive', 'seed'].includes(item.disposition)).map(({ replacementText: _, disposition, ...item }) => ({ ...item, disposition: disposition as 'archive' | 'seed' }))
        const replacements: Record<string, MaintenanceSnapshot> = {}
        for (const document of entry.documents.filter(item => item.disposition === 'seed')) replacements[document.path] = {
          version: 1, directories: [], files: { [document.path.startsWith('memory/') ? 'page.md' : 'SKILL.md']: Buffer.from(document.replacementText!).toString('base64') } }
        const scopeHash = digest(reviewedDocumentScope(this.projectId, documents))
        const { plan } = this.operation.plan({ documents, historyEffect: 'none' }, replacements, { version: 1, projectId: this.projectId,
          authority: 'host-content-review', scopeHash, reviewTextDigest: args.revision })
        this.recheck(entry, context)
        this.gate.writeSync([], () => {
          this.authorize(context)
          if (digest(entry.inventory) !== digest(this.sources.documentInventory())) throw new Error('Classification inventory changed before policy CAS; new content review required')
          this.protection.publish(entry.documents, entry.originals, digest(entry.inventory), args.revision, decision, entry.protectionRevision)
        }, entry.gateRevision)
        return JSON.stringify(this.register({ ...entry, archive: plan, contentDecision: decision, baseline: this.baseline(),
          protectionRevision: this.protection.revision(), gateRevision: digest(this.gate.status()) }))
      }
      if (entry.direction === 'archive' && (!entry.archive || !entry.contentDecision)) throw new Error('Human content review required separately before execution')
      const contentPlanRevision = entry.archive?.contentReview.reviewTextDigest ?? entry.restoration!.originalReceipt.plan.contentReview.reviewTextDigest
      this.protection.assertApproved(contentPlanRevision)
      const decision = await this.human(entry, args.revision, 'execution', context)
      // All authority, source and durable CAS checks run again AFTER the human
      // returns and synchronously before entering the domain's first reservation.
      this.recheck(entry, context)
      if (entry.direction === 'archive') {
        let preparedGate: string | undefined
        await this.operation.prepare(entry.archive!, confirmDocumentExecution(entry.archive!, decision), entry.gateRevision, revision => { preparedGate = revision })
        this.authorize(context)
        if (!preparedGate) throw new Error('Exact preparation release revision unavailable; explicit recovery required')
        return JSON.stringify(await this.operation.resume(preparedGate))
      }
      if (entry.direction === 'rollback' || entry.direction === 'resume') {
        const receipt = this.operation.status()!
        const preparing = receipt.phase === 'preparing' || (receipt.phase === 'blocked' && this.gate.status().operation?.phase === 'reserved')
        let preparedGate: string | undefined
        if (preparing) await this.operation.prepare(entry.archive!, confirmDocumentExecution(entry.archive!, decision), entry.gateRevision, revision => { preparedGate = revision })
        this.authorize(context)
        if (preparing && !preparedGate) throw new Error('Exact preparation release revision unavailable; explicit recovery required')
        const expected = preparing ? preparedGate! : entry.gateRevision
        return JSON.stringify(entry.direction === 'rollback' ? await this.operation.rollback(expected) : await this.operation.resume(expected))
      }
      const preparing = entry.direction === 'restore' || this.restoration.status()?.phase === 'preparing' ||
        (this.restoration.status()?.phase === 'blocked' && this.gate.status().operation?.phase === 'reserved')
      let preparedGate: string | undefined
      if (preparing) await this.restoration.prepare(entry.restoration!, confirmDocumentRestoration(entry.restoration!, decision), entry.gateRevision, revision => { preparedGate = revision })
      this.authorize(context)
      if (preparing && !preparedGate) throw new Error('Exact restoration preparation release revision unavailable; explicit recovery required')
      return JSON.stringify(await this.restoration.resume(preparing ? preparedGate! : entry.gateRevision))
    } finally { this.busy = false }
  }
}
