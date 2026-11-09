import { createHash, randomUUID } from 'node:crypto'
import { AUTOMATIC_WORK_GUIDANCE } from '../cron/work-dispatch-contract.ts'

import { z } from 'zod'
import type { InitiativeStore } from '../initiatives/store.ts'
import { WorkConflict, workDefinitionSchema, workProgressSchema, workKey, type WorkActor, type WorkRecord, type WorkStamp } from '../initiatives/work-contract.ts'
import type { YieldRequest } from './yield-contract.ts'
import type { DecisionEvidence } from './decision-brief.ts'
import { decisionEvidenceSchema } from './decision-brief.ts'
import type { SessionState } from './session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool as TypedTool, ToolResult } from '../tools/tool.ts'
import { delegationOwner } from './execution-scope.ts'
import { type WorkPolicy, type WorkBinding } from './work-policy.ts'
import { workNotesSchema, workNotePatchSchema, workDecisionContextSchema, type WorkDecisionContext } from '../initiatives/work-notes.ts'

function canonicalRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRequest).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalRequest(v)}`).join(',')}}`
  return JSON.stringify(value)
}
function requestHash(value: unknown): string { return createHash('sha256').update(canonicalRequest(value)).digest('hex') }

type Tool = TypedTool<ToolResult>

const effectResultSourceSchema = z.object({
  invocationId: z.string(),
  resultSource: decisionEvidenceSchema.omit({ quote: true }).extend({ kind: z.literal('tool') }),
})

export interface WorkToolGuard {
  required?(sessionId: string): boolean
  snapshot(sessionId: string): WorkStamp[]
  prompt(sessionId: string, context?: ExecutionContext): string
  current(stamps: WorkStamp[]): boolean
  before(tool: Tool, args: Record<string, unknown>, context: ExecutionContext): { finish(failed: boolean, effect?: 'none' | 'returned'): string } | undefined
}

export interface WorkAlignmentDeps {
  state(id: string): SessionState | null | undefined
  evidence(source: DecisionEvidence): Promise<void>
  changed(record: WorkRecord, previous?: WorkRecord): Promise<void>
}

export const WORK_HELP = {
  notice: 'Notes orient work, never gate tools or grant permission. Completion is a reported result, not human acceptance.',
  create: { title: 'Short name', definition: { objective: 'Desired outcome; acceptance and boundaries are optional lists' },
    idempotencyKey: 'Optional creator/Project-scoped retry key (max 200); normalized identical requests return existing Work, changed parameters conflict. Retries do not republish saved creation.',
    parentKey: 'Optional existing parent', assignee: 'Optional durable session ID or null',
    notes: { kind: 'goal|approach|task|finding', relation: { kind: 'supports|requires|assumption', reason: 'Why this branch follows from the parent; omit for roots' } },
    requestQuote: 'Optional exact quote from the current user input; the host supplies its source' },
  update: { notes: { summary: 'Current conclusion', plan: ['Editable steps, not mandatory gates'], next: 'Next useful action or wait',
    artifacts: [{ label: 'Result', href: 'HTTP(S) or Project-relative resource URL' }], html: 'Optional read-only HTML exhibit; scripts and forms are not supported',
    attention: { kind: 'assumption|scope|dependency|decision|blocker', summary: 'Only material changes needing the coordinator to act' } },
    status: 'Optional pending|in_progress|blocked|done|cancelled', blockedReason: 'Required when blocked',
    definition: 'Coordinator/human only; same shape as create. Do not turn implementation preferences into user requirements.' },
  assign: { assignee: 'Existing durable session ID or null; responsibility only, not cancellation or permission' },
  review: { conclusion: 'Coordinator interpretation of a reported impact; does not approve operations' },
  discovery: { index: 'v:works/index; 20 receipts per page; follow next', context: 'v:works/context; associated keys', key: 'v:works/keys/<encodeURIComponent(key)>; optional /definition, /notes, /path', search: 'search at v:works; heed bounded-discovery warnings', writes: 'Discover v:tools/work_create, work_update, work_assign, work_review, work_link; invoke_tool with typed fields, no action/data' },
  version: 'Read the current note version before update, assign or review; send only changed fields. Goal revisions change only for semantic changes.',
  link: 'Associate this session with an existing key; does not select focus, assign responsibility, or complete Work.',
}

export class WorkAlignment implements WorkToolGuard {
  constructor(readonly store: InitiativeStore, private readonly deps: WorkAlignmentDeps) {}

  private async publishNote(record: WorkRecord, previous?: WorkRecord) {
    try { await this.deps.changed(record, previous) }
    catch (error) {
      throw new WorkConflict(`Note ${record.key} version ${record.sequence} is saved, but update delivery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private executor(sessionId: string): string {
    const seen = new Set<string>()
    while (!seen.has(sessionId)) {
      seen.add(sessionId)
      const state = this.deps.state(sessionId)
      const owner = delegationOwner(state)
      if (!owner) return sessionId
      sessionId = owner
    }
    throw new WorkConflict('Cyclic work execution lineage.')
  }

  records(sessionId: string, executionOnly = false): WorkRecord[] {
    const executor = this.executor(sessionId)
    const binding = delegationOwner(this.deps.state(sessionId)) ? this.store.executionBinding(sessionId) : undefined
    return this.store.workRecords().filter(record => {
      if (binding) return record.key === binding
      const authority = this.store.workAuthority(record.subject)
      return authority.executor === executor
        || (!executionOnly && authority.manager === sessionId)
    })
  }

  get(key: string): WorkRecord {
    const record = this.store.workRecords().find(item => item.key === key)
    if (!record) throw new WorkConflict('Work contract not found.')
    return record
  }

  policy(sessionId: string): WorkPolicy {
    if (!this.deps.state(sessionId)) throw new WorkConflict('Session not found in this Project.')
    return { mode: 'optional' }
  }

  required(sessionId: string): boolean { return this.policy(sessionId).mode === 'required' }

  private ancestry(record: WorkRecord): WorkRecord[] {
    const result: WorkRecord[] = []
    const seen = new Set([record.key])
    while (record.workflow?.parentKey) {
      record = this.get(record.workflow.parentKey)
      if (seen.has(record.key)) throw new WorkConflict('Cyclic Work ancestry.')
      seen.add(record.key)
      result.push(record)
    }
    return result
  }

  prepareDelegation(sessionId: string, binding: WorkBinding | undefined, mode: 'session' | 'task' | 'call'): WorkPolicy {
    this.policy(sessionId)
    if (!binding) return { mode: 'optional' }
    const record = this.get(binding.key)
    const authority = this.store.workAuthority(record.subject)
    if (!authority.active) throw new WorkConflict('Choose active work or reopen this note before assigning it.')
    if (mode === 'session') {
      this.assertController(record, { kind: 'session', sessionId })
      if (record.workflow?.assignee) throw new WorkConflict('A new peer requires unassigned Work; release an existing assignment first.')
    } else if (authority.executor !== this.executor(sessionId)) {
      throw new WorkConflict('Temporary execution can link only work assigned to its durable owner.')
    }
    return { mode: 'optional' }
  }

  assertDelegatedInput(sourceId: string, targetId: string): void {
    const source = this.policy(sourceId)
    if (source.mode === 'optional' || sourceId === targetId || source.controllerSessionId === targetId
      || delegationOwner(this.deps.state(sourceId)) === targetId) return
    const target = this.policy(targetId)
    const targetKeys = target.mode === 'required'
      ? new Set(target.keys.flatMap(key => [key, ...this.ancestry(this.get(key)).map(record => record.key)])) : new Set<string>()
    if (source.keys.some(key => !targetKeys.has(key))) {
      throw new WorkConflict('Managed requests require a recipient bound to the same Work or descendant scope. Report to the controller instead of delegating to an unconstrained peer.')
    }
  }

  async bindDelegation(sessionId: string, controller: string, binding: WorkBinding, signal?: AbortSignal): Promise<void> {
    this.prepareDelegation(controller, binding, 'session')
    this.requireSession(sessionId)
    const record = this.get(binding.key)
    await this.assignNote({ kind: 'session', sessionId: controller }, record.key, record.sequence, sessionId, signal)
  }

  async deliverAssignment(manager: string, assignee: string, reference: { key: string; assignmentRevision: number }, input: import('./input.ts').SessionMessageInput, deliver: import('./input.ts').DeliverInput): Promise<import('./input.ts').DeliveryReceipt> {
    this.requireSession(manager)
    this.requireSession(assignee)
    if (input.source.kind !== 'session' || input.source.sessionId !== manager) throw new WorkConflict('Assignment input must originate from its manager.')
    const fingerprint = requestHash({ content: input.content, media: input.media, policy: input.policy, manager, assignee,
      coordination: input.source.coordination, workStamps: input.source.workStamps })
    const reservation = this.store.reserveAssignmentDelivery(reference.key, reference.assignmentRevision, manager, assignee, input.id, fingerprint)
    if (!reservation.fresh) {
      if (reservation.status === 'accepted') return { status: 'accepted', sessionId: assignee, inputId: reservation.inputId, delivery: input.policy }
      throw new WorkConflict(`Assignment delivery inputId=${reservation.inputId} is unconfirmed; inspect the recipient before sending again. It has not been retried.`)
    }
    input.source.workAssignment = reference
    const receipt = await deliver(assignee, input)
    if (receipt.status !== 'accepted' || receipt.disposition === 'filtered' || receipt.sessionId !== assignee || receipt.inputId !== input.id) throw new WorkConflict('Assignment delivery was not confirmed by the recipient.')
    this.store.confirmAssignmentDelivery(reference.key, reference.assignmentRevision, manager, assignee, input.id)
    return receipt
  }

  linkExecution(sessionId: string, parentId: string, binding?: WorkBinding): void {
    const state = this.deps.state(sessionId)
    if (!state || delegationOwner(state) !== parentId) throw new WorkConflict('Only the actual parent may link a temporary execution.')
    this.prepareDelegation(parentId, binding, state.mode === 'call' ? 'call' : 'task')
    const key = binding?.key ?? this.decisionContext(parentId)?.originKey
    if (key) this.store.bindExecution(sessionId, key)
  }

  private focus(sessionId: string): string | undefined {
    const temporary = !!delegationOwner(this.deps.state(sessionId))
    const key = temporary ? this.store.executionBinding(sessionId) : this.store.workFocus(sessionId)
    return key && this.records(sessionId).some(record => record.key === key) ? key : undefined
  }

  private basis(parentKey?: string) {
    if (!parentKey) return []
    const parent = this.get(parentKey)
    return [...this.ancestry(parent).reverse(), parent].map(({ key, revision }) => ({ key, revision }))
  }

  contextChanged(record: WorkRecord): boolean {
    return !!record.notes && JSON.stringify(record.notes.basis) !== JSON.stringify(this.basis(record.workflow?.parentKey))
  }

  snapshot(sessionId: string): WorkStamp[] {
    this.policy(sessionId)
    return []
  }

  operationBasis(sessionId: string): WorkStamp[] {
    return this.decisionContext(sessionId)?.path.map(node => ({
      key: node.key, revision: node.revision, assignmentRevision: node.assignmentRevision,
    })) ?? []
  }

  current(stamps: WorkStamp[]): boolean {
    const records = this.store.workRecords()
    return stamps.every(stamp => records.some(record => record.key === stamp.key && record.revision === stamp.revision
      && record.workflow?.assignmentRevision === stamp.assignmentRevision))
  }

  currentContext(context: WorkDecisionContext): boolean {
    const records = new Map(this.store.workRecords().map(record => [record.key, record]))
    return context.path.every(node => {
      const record = records.get(node.key)
      return record?.revision === node.revision && (node.assignmentRevision === undefined
        || record.workflow?.assignmentRevision === node.assignmentRevision)
    })
  }

  currentDecision(request: YieldRequest): boolean {
    if (request.workContext && !this.currentContext(request.workContext)) return false
    return this.current(request.workStamps ?? [])
  }

  prompt(sessionId: string, _context?: ExecutionContext): string {
    const all = this.records(sessionId).filter(record => !['done', 'cancelled'].includes(record.workflow?.status ?? ''))
    const focus = this.focus(sessionId)
    const records = focus ? all.filter(record => record.key === focus) : all.slice(0, 3)
    if (!records.length) return ''
    const payload = records.map(record => {
      const path = this.decisionContext(sessionId, record.key)!.path
      const visible = path.length > 5 ? [path[0], ...path.slice(-4)] : path
      return {
        key: record.key, version: record.sequence,
        path: visible.map(node => ({ key: node.key, title: node.title, origin: node.origin,
          objective: node.objective.slice(0, 300),
          contextNeedsReview: node.contextNeedsReview, assessment: node.assessment?.slice(0, 400),
          relation: node.relation ? { kind: node.relation.kind, reason: node.relation.reason.slice(0, 240) } : undefined,
        })),
        omittedAncestors: path.length - visible.length,
        summary: record.notes?.summary.slice(0, 600), next: record.notes?.next.slice(0, 320),
        contextNeedsReview: this.contextChanged(record),
        attention: record.notes?.attention && !record.notes.attention.reviewed ? record.notes.attention.summary.slice(0, 400) : undefined,
      }
    })
    const content = JSON.stringify(payload)
    return (this.deps.state(sessionId)?.automaticWork ? '# Automatic Work execution\n' + AUTOMATIC_WORK_GUIDANCE + '\n' : '') + '# Shared work notes\nNotes orient work, never gate tools or grant permission. Update meaningful changes once, without adoption or echoing. This bounded index omits detail; read v:works/keys/<encoded-key> for the full goal path and constraints. Reassess stale branches rather than repeating an obsolete premise.\n' +
      `Active notes: ${all.length}; shown: ${records.length}; omitted: ${all.length - records.length}. Read v:works/context to discover your other notes; set ask workKey when assignments are ambiguous.\n` +
      (content.length <= 6000 ? content : JSON.stringify(records.map(record => ({
        key: record.key, version: record.sequence, title: record.workflow?.title,
        contextNeedsReview: this.contextChanged(record), detailOmitted: true,
      }))))
  }

  assertCurrent(stamps: WorkStamp[], sessionId: string): void {
    this.policy(sessionId)
    if (!this.current(stamps)) throw new WorkConflict('The referenced goal or assignment changed. Re-evaluate this explicit operation basis.')
  }

  before(_tool: Tool, _args: Record<string, unknown>, _context: ExecutionContext): ReturnType<WorkToolGuard['before']> {
    return undefined
  }

  context(sessionId: string, key?: string, history = false) {
    if (!this.deps.state(sessionId)) throw new WorkConflict('Session not found in this Project.')
    const focus = this.focus(sessionId)
    const records = key === undefined ? this.records(sessionId).filter(record =>
      !delegationOwner(this.deps.state(sessionId)) || !focus || record.key === focus) : [this.get(key)]
    return { ...this.view(records, this.focus(sessionId), history), policy: this.policy(sessionId) }
  }

  inspect(key: string, history = false) { return this.view([this.get(key)], key, history) }

  decisionContext(sessionId: string, originKey?: string, decisionKey?: string): WorkDecisionContext | undefined {
    if (!this.deps.state(sessionId)) throw new WorkConflict('Session not found in this Project.')
    if (!originKey) {
      originKey = this.focus(sessionId)

    }
    if (!originKey) {
      if (decisionKey) throw new WorkConflict('A decision node needs its originating work key.')
      return undefined
    }
    const record = this.get(originKey)
    const path = [...this.ancestry(record).reverse(), record]
    return workDecisionContextSchema.parse({
      originKey, decisionKey: decisionKey ?? originKey,
      path: path.map(item => ({
        key: item.key, revision: item.revision,
        ...(item.workflow ? { assignmentRevision: item.workflow.assignmentRevision } : {}),
        title: item.workflow?.title ?? item.definition.objective.slice(0, 160),
        objective: item.definition.objective, origin: item.origin,
        kind: item.notes?.kind ?? 'task',
        ...(this.contextChanged(item) ? { contextNeedsReview: true as const }
          : item.notes?.attention?.reviewed ? { assessment: item.notes.attention.reviewed.conclusion } : {}),
        ...(item.notes?.relation ? { relation: item.notes.relation } : {}),
        ...(item.requestSource ? { userQuote: item.requestSource.quote } : {}),
      })),
    })
  }

  async editNote(actor: WorkActor, key: string, version: number, data: unknown, signal?: AbortSignal,
    userInput?: { text: string; source: Omit<DecisionEvidence, 'quote'> }): Promise<WorkRecord> {
    const patch = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      definition: workDefinitionSchema.optional(),
      parentKey: z.string().min(1).max(600).nullable().optional(),
      dependencies: z.array(z.string().min(1).max(600)).max(100).optional(),
      notes: workNotePatchSchema.optional(),
      status: workProgressSchema.optional(),
      blockedReason: z.string().trim().min(1).max(2000).optional(),
      requestQuote: decisionEvidenceSchema.shape.quote.optional(),
    }).strict().parse(data)
    if (!Object.keys(patch).length) throw new WorkConflict('Provide the fields that changed.')
    signal?.throwIfAborted()
    const prior = this.get(key)
    if (prior.sequence !== version) throw new WorkConflict('This note changed. Read its current version before updating it.')
    const authority = this.store.workAuthority(prior.subject)
    const editor = actor.kind === 'session' ? this.executor(actor.sessionId) : 'human'
    if (actor.kind === 'session' && editor !== authority.executor && actor.sessionId !== authority.manager) {
      throw new WorkConflict('Update your assigned branch; only its coordinator or the human may edit another branch.')
    }
    if (actor.kind === 'session' && editor !== actor.sessionId && this.store.executionBinding(actor.sessionId) && this.store.executionBinding(actor.sessionId) !== key) {
      throw new WorkConflict('Update the branch linked to this temporary execution, not another assignment of its owner.')
    }
    if (!prior.workflow) throw new WorkConflict('This work has no notebook workflow.')
    const structural = patch.definition !== undefined || patch.parentKey !== undefined || patch.dependencies !== undefined
      || patch.title !== undefined || patch.notes?.relation !== undefined || patch.notes?.kind !== undefined
    if (structural) this.assertController(prior, actor)
    const parentKey = patch.parentKey === undefined ? prior.workflow.parentKey : patch.parentKey ?? undefined
    if (parentKey && parentKey !== prior.workflow.parentKey) {
      const parent = this.get(parentKey)
      if (!(actor.kind === 'session' && this.store.workAuthority(parent.subject).executor === editor)) this.assertController(parent, actor)
    }
    const definition = patch.definition ?? prior.definition
    const semantic = JSON.stringify(definition) !== JSON.stringify(prior.definition)
      || parentKey !== prior.workflow.parentKey
      || patch.notes?.kind !== undefined && patch.notes.kind !== prior.notes?.kind
      || patch.notes?.relation !== undefined && JSON.stringify(patch.notes.relation) !== JSON.stringify(prior.notes?.relation)
      || patch.dependencies !== undefined && JSON.stringify(patch.dependencies) !== JSON.stringify(prior.workflow.dependencies)
    let requestSource = prior.requestSource
    if (patch.requestQuote !== undefined) {
      if (!userInput || !userInput.text.includes(patch.requestQuote)) throw new WorkConflict('Quote the current authenticated user input, not a peer message.')
      requestSource = { ...userInput.source, kind: 'user', quote: patch.requestQuote }
      await this.deps.evidence(requestSource)
    }
    if (semantic && actor.kind === 'session' && (prior.origin === 'human' || prior.requestSource) && patch.requestQuote === undefined) {
      throw new WorkConflict('This goal was set by the human. Update the plan instead, or ask about the changed goal; a current user correction can be recorded with requestQuote.')
    }
    if (semantic && actor.kind === 'user' && patch.requestQuote === undefined) requestSource = undefined
    if (patch.definition) for (const source of patch.definition.evidence) await this.deps.evidence(source)
    const now = new Date().toISOString()
    const notes = workNotesSchema.parse({
      ...prior.notes, ...patch.notes,
      basis: parentKey !== prior.workflow.parentKey ? this.basis(parentKey) : prior.notes?.basis ?? this.basis(parentKey),
      attention: patch.notes?.attention
        ? { ...patch.notes.attention, version: version + 1, by: this.actorName(actor), at: now }
        : prior.notes?.attention,
    })
    if (parentKey && !notes.relation) throw new WorkConflict('Explain the link to the parent as supports, requires, or assumption.')
    if (!parentKey) notes.relation = undefined
    const status = patch.status ?? prior.workflow.status
    const blockedReason = status === 'blocked' ? patch.blockedReason ?? prior.workflow.blockedReason : undefined
    if (status === 'blocked' && !blockedReason) throw new WorkConflict('Describe the actual blocker.')
    if (status === 'blocked' && prior.workflow.status !== 'blocked' && !patch.notes?.attention) {
      notes.attention = { kind: 'blocker', summary: blockedReason!, version: version + 1, by: this.actorName(actor), at: now }
    }
    if (status === 'done' && !notes.summary) throw new WorkConflict('Summarize the outcome before reporting completion. Completion is not human acceptance.')
    const record: WorkRecord = {
      ...prior, revision: prior.revision + Number(semantic), sequence: version + 1,
      definition, notes, requestSource,
      origin: semantic ? actor.kind === 'user' ? 'human' : 'agent_interpretation' : prior.origin,
      changedBy: this.actorName(actor), changedAt: now, reason: 'Shared work note updated',
      workflow: { ...prior.workflow, title: patch.title ?? prior.workflow.title, parentKey,
        dependencies: patch.dependencies ?? prior.workflow.dependencies,
        status, blockedReason, blockedScope: status === 'blocked' ? 'step' : undefined,
        result: status === 'done' ? { summary: notes.summary, evidence: definition.evidence } : undefined,
      },
    }
    signal?.throwIfAborted()
    this.store.saveWork(record, version, this.actorName(actor), 'note', {
      fields: [...Object.keys(patch).filter(field => field !== 'notes'), ...Object.keys(patch.notes ?? {}).map(field => `notes.${field}`)],
    })
    await this.publishNote(record, prior)
    return record
  }

  async reviewNote(actor: WorkActor, key: string, version: number, conclusion: string, signal?: AbortSignal): Promise<WorkRecord> {
    signal?.throwIfAborted()
    const prior = this.get(key)
    this.assertController(prior, actor)
    if (prior.sequence !== version) throw new WorkConflict('The branch changed. Read its latest update before reviewing its impact.')
    if (!this.contextChanged(prior) && (!prior.notes?.attention || prior.notes.attention.reviewed)) throw new WorkConflict('There is no pending impact review.')
    const now = new Date().toISOString()
    const attention = prior.notes?.attention ?? { kind: 'scope' as const, summary: 'An ancestor goal or rationale changed.',
      version, by: 'runtime', at: now }
    const record: WorkRecord = { ...prior, sequence: version + 1, changedBy: this.actorName(actor), changedAt: now,
      notes: { ...workNotesSchema.parse(prior.notes ?? {}), basis: this.basis(prior.workflow?.parentKey),
      attention: { ...attention, reviewed: {
        by: this.actorName(actor), at: now, conclusion: z.string().trim().min(1).max(2000).parse(conclusion),
      } },
    } }
    this.store.saveWork(record, version, this.actorName(actor), 'impact_review')
    await this.publishNote(record, prior)
    return record
  }

  async assignNote(actor: WorkActor, key: string, version: number, assignee: string | null, signal?: AbortSignal): Promise<WorkRecord> {
    signal?.throwIfAborted()
    const prior = this.get(key)
    if (prior.sequence !== version || !prior.workflow) throw new WorkConflict('Read the current note before assigning it.')
    this.assertController(prior, actor)
    if (assignee) this.requireSession(assignee)
    if (assignee === prior.workflow.assignee) return prior
    const record: WorkRecord = { ...prior, sequence: version + 1,
      changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
      workflow: { ...prior.workflow, assignee, assignmentRevision: prior.workflow.assignmentRevision + 1 },
    }
    this.store.saveWork(record, version, this.actorName(actor), 'assignment')
    await this.publishNote(record, prior)
    return record
  }

  private view(records: WorkRecord[], selected: string | undefined, history: boolean) {
    const keys = new Set(records.map(record => record.key))
    const effects = this.store.workEffects().filter(effect => effect.stamps.some(stamp => keys.has(stamp.key)))
    const histories = new Map(records.map(record => [
      record.key, history || effects.length ? this.store.workHistory(record.key) : [],
    ]))
    const sources = new Map<string, z.infer<typeof effectResultSourceSchema>['resultSource']>()
    for (const entries of histories.values()) for (const entry of entries) {
      if (entry.kind !== 'tool_result') continue
      const parsed = effectResultSourceSchema.safeParse(entry.data)
      if (parsed.success) sources.set(parsed.data.invocationId, parsed.data.resultSource)
    }
    return { selected, records: records.map(record => ({
      ...record, contextChanged: this.contextChanged(record),
      authority: this.store.workAuthority(record.subject), history: history ? histories.get(record.key)! : [],
    })), effects: effects.map(effect => ({
      ...effect, ...(sources.has(effect.id) ? { resultSource: sources.get(effect.id) } : {}),
    })) }
  }

  private actorName(actor: WorkActor): string { return actor.kind === 'user' ? 'human' : actor.sessionId }

  private assertController(record: Pick<WorkRecord, 'subject'>, actor: WorkActor) {
    if (actor.kind === 'user') return
    if (this.deps.state(actor.sessionId)?.mode !== 'session' || this.store.workAuthority(record.subject).manager !== actor.sessionId) {
      throw new WorkConflict('Only the work controller or authenticated human may change the goal structure. Report a changed premise in your branch instead of rewriting another goal.')
    }
  }

  async execute(actor: WorkActor, action: string, key: string | undefined, revision: number | undefined, data: unknown, signal?: AbortSignal,
    userInput?: { text: string; source: Omit<DecisionEvidence, 'quote'> }): Promise<unknown> {
    signal?.throwIfAborted()
    if (action === 'context') {
      if (actor.kind !== 'session') throw new WorkConflict('Context needs a session identity.')
      const request = z.object({ includeSchema: z.boolean().optional() }).strict().parse(data ?? {})
      return { ...this.context(actor.sessionId, key, false),
        ...(request.includeSchema ? { schema: WORK_HELP } : {}), currentInput: { ownerFollowup: !!userInput } }
    }
    if (action === 'list' || action === 'tree') {
      const request = z.object({
        query: z.string().trim().max(500).default(''), limit: z.number().int().min(1).max(20).default(5),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      }).strict().parse(data ?? {})
      if (action === 'tree' && !key) throw new WorkConflict('Select a root work key for the Work view.')
      const tree = action === 'tree' ? this.store.initiativeView(key!) : undefined
      const terms = request.query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
      const records = (tree?.items ?? this.store.workRecords()).filter(record => {
        const text = [record.key, record.workflow?.title, record.definition.objective].join('\n').toLocaleLowerCase()
        return terms.every(term => text.includes(term))
      })
      const items = records.slice(request.offset, request.offset + request.limit).map(record => ({
        key: record.key, goalRevision: record.revision, version: record.sequence,
        title: record.workflow?.title, parentKey: record.workflow?.parentKey, status: record.workflow?.status,
        kind: record.notes?.kind, summary: record.notes?.summary, contextNeedsReview: this.contextChanged(record),
        authority: this.store.workAuthority(record.subject),
      }))
      const nextOffset = request.offset + items.length
      return { ...(tree ? { root: tree.root, progress: tree.progress } : {}), items, totalMatches: records.length,
        hasMore: nextOffset < records.length, nextOffset: nextOffset < records.length ? nextOffset : null }
    }
    if (action === 'create') {
      const request = z.object({
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        title: z.string().trim().min(1).max(160), parentKey: z.string().min(1).max(600).optional(),
        assignee: z.string().min(1).max(512).nullable().optional(),
        definition: workDefinitionSchema, reason: z.string().trim().min(1).max(2000).default('Working interpretation, not new authorization'),
        notes: workNotesSchema.omit({ attention: true, basis: true }).default({}),
        requestQuote: decisionEvidenceSchema.shape.quote.optional(),
      }).strict().parse(data)
      if (actor.kind === 'session') this.requireSession(actor.sessionId)
      const creator = actor.kind === 'session' ? `session:${actor.sessionId}` : 'user'
      const normalized = { ...request, assignee: request.assignee === undefined ? actor.kind === 'session' ? actor.sessionId : null : request.assignee }
      const creationRequest = request.idempotencyKey ? { creator, key: request.idempotencyKey, fingerprint: requestHash(normalized) } : undefined
      const identity = creationRequest ? requestHash([creator, creationRequest.key]) : undefined
      // A deterministic UUID makes the existing transactional primary key the concurrency arbiter.
      const createId = identity ? `${identity.slice(0, 8)}-${identity.slice(8, 12)}-8${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}` : randomUUID()
      const existing = () => {
        const found = this.store.workRecords().find(record => record.key === `work:${createId}`)
        if (found && (!creationRequest || canonicalRequest(found.creationRequest) !== canonicalRequest(creationRequest))) throw new WorkConflict('Creation idempotency key conflicts with a different request.')
        return found
      }
      const replay = creationRequest && existing()
      if (replay) return replay
      const parent = request.parentKey ? this.get(request.parentKey) : undefined
      if (parent) {
        if (!(actor.kind === 'session' && this.store.workAuthority(parent.subject).executor === actor.sessionId)) this.assertController(parent, actor)
        if (!this.store.workAuthority(parent.subject).active) throw new WorkConflict('Cannot add work to a terminal parent.')
      }
      const assignee = request.assignee === undefined ? actor.kind === 'session' ? actor.sessionId : null : request.assignee
      if (assignee) this.requireSession(assignee)
      if (request.notes && request.parentKey && !request.notes.relation) throw new WorkConflict('Explain why this branch supports, is required by, or assumes its parent.')
      if (request.notes?.relation && !request.parentKey) throw new WorkConflict('A causal relation needs a parent work key.')
      let requestSource: WorkRecord['requestSource']
      if (request.requestQuote !== undefined) {
        if (!userInput || !userInput.text.includes(request.requestQuote)) throw new WorkConflict('Quote the current authenticated user input.')
        requestSource = { ...userInput.source, kind: 'user', quote: request.requestQuote }
        await this.deps.evidence(requestSource)
      }
      for (const source of request.definition.evidence) await this.deps.evidence(source)
      signal?.throwIfAborted()
      if (parent && !(actor.kind === 'session' && this.store.workAuthority(this.get(parent.key).subject).executor === actor.sessionId)) this.assertController(this.get(parent.key), actor)
      const subject = { kind: 'work' as const, id: createId }
      const record: WorkRecord = {
        key: workKey(subject), subject, revision: 1, sequence: 1, creationRequest,
        definition: request.definition, origin: actor.kind === 'user' ? 'human' : 'agent_interpretation',
        changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
        change: 'understanding', reason: request.reason, paused: false,
        notes: { ...request.notes, basis: this.basis(request.parentKey) }, requestSource,
        workflow: { title: request.title, parentKey: request.parentKey,
          manager: actor.kind === 'session' ? actor.sessionId : parent ? this.store.workAuthority(parent.subject).manager : assignee,
          assignee, assignmentRevision: 1, status: 'pending', dependencies: [] },
      }
      try { this.store.saveWork(record, 0, this.actorName(actor), 'created') }
      catch (error) {
        const winner = creationRequest && existing()
        if (winner) return winner
        throw error
      }
      if (actor.kind === 'session') this.store.linkWorkSession(actor.sessionId, record.key)
      await this.publishNote(record)
      return record
    }
    if (action === 'link') {
      if (actor.kind !== 'session' || (this.deps.state(actor.sessionId)?.mode ?? 'session') !== 'session') throw new WorkConflict('Only ordinary durable sessions may associate Work.')
      this.requireSession(actor.sessionId)
      if (!key) throw new WorkConflict('Provide an existing Work key.')
      this.get(key)
      this.store.linkWorkSession(actor.sessionId, key)
      await this.publishNote(this.get(key), this.get(key))
      return { key, sessionId: actor.sessionId, selected: this.store.workFocus(actor.sessionId) ?? null, notice: 'Historical association only; focus, assignment, authority and completion are unchanged.' }
    }
    throw new WorkConflict('Unknown work action.')
  }

  private requireSession(id: string) {
    const state = this.deps.state(id)
    if (!state || state.mode && state.mode !== 'session') throw new WorkConflict('Work assignments require a durable Session in this Project, not a task, call or remote execution reference.')
  }

}
