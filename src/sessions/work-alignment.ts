import { workKeySchema } from '../initiatives/work-key.ts'
import { createHash, randomUUID } from 'node:crypto'
import { AUTOMATIC_WORK_GUIDANCE } from '../cron/work-dispatch-contract.ts'

import { z } from 'zod'
import type { WorkNoteReceipt } from '../initiatives/work-note.ts'
import type { InitiativeStore } from '../initiatives/store.ts'
import { WORK_DEFINITION_GUIDANCE } from '../initiatives/work-definition.ts'
import { WorkConflict, workDefinitionSchema, workProgressSchema, workCompletionSummaryIssue, type WorkActor, type WorkRecord, type WorkStamp } from '../initiatives/work-contract.ts'
import type { YieldRequest } from './yield-contract.ts'
import { decisionEvidenceSchema } from './decision-brief.ts'
import type { SessionState } from './session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool as TypedTool, ToolResult } from '../tools/tool.ts'
import { delegationOwner } from './execution-scope.ts'
import { type WorkPolicy, type WorkBinding } from './work-policy.ts'
import { workReportFields, workKindSchema, workSummarySchema, workArtifactsSchema, workDecisionContextSchema, type WorkDecisionContext } from '../initiatives/work-notes.ts'

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
  changed(record: WorkRecord, previous?: WorkRecord): Promise<void>
  projectId?: string
  wakeWorkNotifications?(): Promise<void>
}

export const WORK_HELP = {
  notice: 'Notes orient work, never gate tools or grant permission. Completion is a reported result, not human acceptance.',
  create: { title: 'Short name', definition: WORK_DEFINITION_GUIDANCE,
    idempotencyKey: 'Optional creator/Project-scoped retry key (max 200); normalized identical requests return existing Work, changed parameters conflict. Retries do not republish saved creation.',
    parentKey: 'Optional existing parent', assignee: 'Optional durable session ID or null',
    kind: 'goal|approach|task|finding', summary: 'Optional shared Markdown summary', artifacts: 'Optional structured links' },
  update: { summary: 'Current shared state or result in Markdown (max 2,000 characters); keep transient planning in the session',
    artifacts: [{ label: 'Result', href: 'HTTP(S) or Project-relative resource URL' }],
    status: 'Optional pending|in_progress|blocked|done|cancelled', blockedReason: 'Required when blocked',
    definition: 'Same free Markdown as create. Only the human can revise a human-authored goal; agents may revise interpretations only with controller authority. Do not turn implementation preferences into user requirements.' },
  assign: { assignee: 'Existing durable session ID or null; responsibility only, not cancellation or permission' },
  review: { conclusion: 'Reassess a stale ancestor basis using the current Work version. Does not unblock or authorize operations.' },
  note_create: { workKey: 'Existing Work key', body: 'Markdown (max 2,000 characters)', replyTo: 'Manager only: ID of the original comment on this Work; notifies its author', notifyManager: 'Assignee only: optional opt-in; otherwise silent' },
  discovery: { index: 'v:works/index; 20 receipts per page; follow next', context: 'v:works/context; associated keys', key: 'v:works/keys/<encodeURIComponent(key)>; optional /definition, /summary, /path, /comments', search: 'search at v:works; heed bounded-discovery warnings', writes: 'Discover v:tools/work_create, work_update, work_assign, work_review, work_link, work_note_create; invoke_tool with typed fields, no action/data' },
  version: 'Read the current Work version before update, assign or review; send only changed fields. Goal revisions change only for semantic changes.',
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

  async createWorkNote(sessionId: string, input: unknown, signal?: AbortSignal): Promise<WorkNoteReceipt> {
    const receipt = this.store.createWorkNote(sessionId, input, id => {
      const state = this.deps.state(id)
      return !!state && state.sessionId === id && state.projectId === this.deps.projectId
        && (state.mode ?? 'session') === 'session' && !state.retirement
    }, signal)
    if (receipt.notification === 'queued') {
      try { await this.deps.wakeWorkNotifications?.() }
      catch (error) { console.warn('[work-notifications] Comment saved; wake deferred:', error) }
    }
    return receipt
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
      const authority = this.store.workAuthority(record.key)
      return authority.executor === executor
        || (!executionOnly && authority.manager === sessionId)
    })
  }

  get(key: string): WorkRecord {
    workKeySchema.parse(key)
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
    while (record.parentKey) {
      record = this.get(record.parentKey)
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
    const authority = this.store.workAuthority(record.key)
    if (!authority.active) throw new WorkConflict('Choose active work or reopen this note before assigning it.')
    if (mode === 'session') {
      this.assertController(record, { kind: 'session', sessionId })
      if (record.assignee) throw new WorkConflict('A new peer requires unassigned Work; release an existing assignment first.')
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
    return JSON.stringify(record.basis) !== JSON.stringify(this.basis(record.parentKey))
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
      && record.assignmentRevision === stamp.assignmentRevision))
  }

  currentContext(context: WorkDecisionContext): boolean {
    const records = new Map(this.store.workRecords().map(record => [record.key, record]))
    return context.path.every(node => {
      const record = records.get(node.key)
      return record?.revision === node.revision && (node.assignmentRevision === undefined
        || record.assignmentRevision === node.assignmentRevision)
    })
  }

  currentDecision(request: YieldRequest): boolean {
    if (request.workContext && !this.currentContext(request.workContext)) return false
    return this.current(request.workStamps ?? [])
  }

  prompt(sessionId: string, _context?: ExecutionContext): string {
    const all = this.records(sessionId).filter(record => !['done', 'cancelled'].includes(record.status ?? ''))
    const focus = this.focus(sessionId)
    const records = focus ? all.filter(record => record.key === focus) : all.slice(0, 3)
    if (!records.length) return ''
    const payload = records.map(record => {
      const path = this.decisionContext(sessionId, record.key)!.path
      const visible = path.length > 5 ? [path[0], ...path.slice(-4)] : path
      return {
        key: record.key, version: record.sequence,
        path: visible.map(node => ({ key: node.key, title: node.title, origin: node.origin,
          definition: node.definition.slice(0, 300),
          contextNeedsReview: node.contextNeedsReview, assessment: node.assessment?.slice(0, 400),
        })),
        omittedAncestors: path.length - visible.length,
        summary: record.summary.slice(0, 600),
        contextNeedsReview: this.contextChanged(record),
      }
    })
    const content = JSON.stringify(payload)
    return (this.deps.state(sessionId)?.automaticWork ? '# Automatic Work execution\n' + AUTOMATIC_WORK_GUIDANCE + '\n' : '') + '# Shared work notes\nNotes orient work, never gate tools or grant permission. Update meaningful changes once, without adoption or echoing. This bounded index omits detail; read v:works/keys/<encoded-key> for the full goal path and constraints. Reassess stale branches rather than repeating an obsolete premise.\n' +
      `Active notes: ${all.length}; shown: ${records.length}; omitted: ${all.length - records.length}. Read v:works/context to discover your other notes; set ask workKey when assignments are ambiguous.\n` +
      (content.length <= 6000 ? content : JSON.stringify(records.map(record => ({
        key: record.key, version: record.sequence, title: record.title,
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
        assignmentRevision: item.assignmentRevision,
        title: item.title,
        definition: item.definition, origin: item.origin,
        kind: item.kind ?? 'task',
        ...(this.contextChanged(item) ? { contextNeedsReview: true as const }
          : item.contextAssessment ? { assessment: item.contextAssessment } : {}),
      })),
    })
  }

  async editNote(actor: WorkActor, key: string, version: number, data: unknown, signal?: AbortSignal): Promise<WorkRecord> {
    const patch = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      definition: workDefinitionSchema.optional(),
      parentKey: workKeySchema.nullable().optional(),
      dependencies: z.array(workKeySchema).max(100).optional(),
      kind: workKindSchema.optional(), summary: workSummarySchema.optional(),
      artifacts: workArtifactsSchema.optional(),
      status: workProgressSchema.optional(),
      blockedReason: z.string().trim().min(1).max(2000).optional(),
    }).strict().parse(data)
    if (!Object.keys(patch).length) throw new WorkConflict('Provide the fields that changed.')
    signal?.throwIfAborted()
    const prior = this.get(key)
    if (prior.sequence !== version) throw new WorkConflict('This note changed. Read its current version before updating it.')
    const authority = this.store.workAuthority(prior.key)
    const editor = actor.kind === 'session' ? this.executor(actor.sessionId) : 'human'
    if (actor.kind === 'session' && editor !== authority.executor && actor.sessionId !== authority.manager) {
      throw new WorkConflict('Update your assigned branch; only its coordinator or the human may edit another branch.')
    }
    if (actor.kind === 'session' && editor !== actor.sessionId && this.store.executionBinding(actor.sessionId) && this.store.executionBinding(actor.sessionId) !== key) {
      throw new WorkConflict('Update the branch linked to this temporary execution, not another assignment of its owner.')
    }
    const structural = patch.definition !== undefined || patch.parentKey !== undefined || patch.dependencies !== undefined
      || patch.title !== undefined || patch.kind !== undefined
    if (structural) this.assertController(prior, actor)
    const parentKey = patch.parentKey === undefined ? prior.parentKey : patch.parentKey ?? undefined
    if (parentKey && parentKey !== prior.parentKey) {
      const parent = this.get(parentKey)
      if (!(actor.kind === 'session' && this.store.workAuthority(parent.key).executor === editor)) this.assertController(parent, actor)
    }
    const definition = patch.definition ?? prior.definition
    const semantic = definition !== prior.definition
      || parentKey !== prior.parentKey
      || patch.kind !== undefined && patch.kind !== prior.kind
      || patch.dependencies !== undefined && JSON.stringify(patch.dependencies) !== JSON.stringify(prior.dependencies)
    if (semantic && actor.kind === 'session' && prior.origin === 'human') {
      throw new WorkConflict('This goal was set by the human. Keep your plan in the session, or ask the human to edit the goal directly.')
    }
    const now = new Date().toISOString()
    const basis = parentKey !== prior.parentKey ? this.basis(parentKey) : prior.basis
    const summary = patch.summary ?? prior.summary
    const status = patch.status ?? prior.status
    const blockedReason = status === 'blocked' ? patch.blockedReason ?? prior.blockedReason : undefined
    if (status === 'blocked' && !blockedReason) throw new WorkConflict('Describe the actual blocker.')
    if (status === 'done' && !summary) throw new WorkConflict(workCompletionSummaryIssue.message)
    const record: WorkRecord = {
      ...prior, revision: prior.revision + Number(semantic), sequence: version + 1,
      title: patch.title ?? prior.title, definition,
      kind: patch.kind ?? prior.kind, summary, artifacts: patch.artifacts ?? prior.artifacts, basis,
      contextAssessment: parentKey === prior.parentKey ? prior.contextAssessment : undefined,
      origin: semantic ? actor.kind === 'user' ? 'human' : 'agent_interpretation' : prior.origin,
      changedBy: this.actorName(actor), changedAt: now,
      parentKey, dependencies: patch.dependencies ?? prior.dependencies, status, blockedReason,
    }
    signal?.throwIfAborted()
    this.store.saveWork(record, version, this.actorName(actor), 'note', {
      fields: Object.keys(patch),
    })
    await this.publishNote(record, prior)
    return record
  }

  async reviewNote(actor: WorkActor, key: string, version: number, conclusion: string, signal?: AbortSignal): Promise<WorkRecord> {
    signal?.throwIfAborted()
    const prior = this.get(key)
    this.assertController(prior, actor)
    if (prior.sequence !== version) throw new WorkConflict('The branch changed. Read its latest update before reassessing ancestor context.')
    if (!this.contextChanged(prior)) throw new WorkConflict('There is no stale ancestor basis to reassess.')
    const record: WorkRecord = { ...prior, sequence: version + 1, changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
      basis: this.basis(prior.parentKey), contextAssessment: z.string().trim().min(1).max(2000).parse(conclusion),
    }
    this.store.saveWork(record, version, this.actorName(actor), 'context_review')
    await this.publishNote(record, prior)
    return record
  }

  async assignNote(actor: WorkActor, key: string, version: number, assignee: string | null, signal?: AbortSignal): Promise<WorkRecord> {
    signal?.throwIfAborted()
    const prior = this.get(key)
    if (prior.sequence !== version) throw new WorkConflict('Read the current note before assigning it.')
    this.assertController(prior, actor)
    if (assignee) this.requireSession(assignee)
    if (assignee === prior.assignee) return prior
    const record: WorkRecord = { ...prior, sequence: version + 1,
      changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
      assignee, assignmentRevision: prior.assignmentRevision + 1,
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
      authority: this.store.workAuthority(record.key), history: history ? histories.get(record.key)! : [],
    })), effects: effects.map(effect => ({
      ...effect, ...(sources.has(effect.id) ? { resultSource: sources.get(effect.id) } : {}),
    })) }
  }

  private actorName(actor: WorkActor): string { return actor.kind === 'user' ? 'human' : actor.sessionId }

  private assertController(record: Pick<WorkRecord, 'key'>, actor: WorkActor) {
    if (actor.kind === 'user') return
    if (this.deps.state(actor.sessionId)?.mode !== 'session' || this.store.workAuthority(record.key).manager !== actor.sessionId) {
      throw new WorkConflict('Only the work controller or authenticated human may change the goal structure. Report a changed premise in your branch instead of rewriting another goal.')
    }
  }

  async execute(actor: WorkActor, action: string, key: string | undefined, revision: number | undefined, data: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (action === 'context') {
      if (actor.kind !== 'session') throw new WorkConflict('Context needs a session identity.')
      const request = z.object({ includeSchema: z.boolean().optional() }).strict().parse(data ?? {})
      return { ...this.context(actor.sessionId, key, false),
        ...(request.includeSchema ? { schema: WORK_HELP } : {}) }
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
        const text = [record.key, record.title, record.definition, record.summary].join('\n').toLocaleLowerCase()
        return terms.every(term => text.includes(term))
      })
      const items = records.slice(request.offset, request.offset + request.limit).map(record => ({
        key: record.key, goalRevision: record.revision, version: record.sequence,
        title: record.title, parentKey: record.parentKey, status: record.status,
        kind: record.kind, summary: record.summary, contextNeedsReview: this.contextChanged(record),
        authority: this.store.workAuthority(record.key),
      }))
      const nextOffset = request.offset + items.length
      return { ...(tree ? { root: tree.root, progress: tree.progress } : {}), items, totalMatches: records.length,
        hasMore: nextOffset < records.length, nextOffset: nextOffset < records.length ? nextOffset : null }
    }
    if (action === 'create') {
      const request = z.object({
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        title: z.string().trim().min(1).max(160), parentKey: workKeySchema.optional(),
        assignee: z.string().min(1).max(512).nullable().optional(),
        definition: workDefinitionSchema,
        ...workReportFields,
        }).strict().parse(data)
      if (actor.kind === 'session') this.requireSession(actor.sessionId)
      const creator = actor.kind === 'session' ? `session:${actor.sessionId}` : 'user'
      const normalized = { ...request, assignee: request.assignee === undefined ? actor.kind === 'session' ? actor.sessionId : null : request.assignee }
      const creation = request.idempotencyKey ? { creator, idempotencyKey: request.idempotencyKey, fingerprint: requestHash(normalized) } : undefined
      const replay = creation && this.store.replayWorkCreation(creation)
      if (replay) return replay
      const parent = request.parentKey ? this.get(request.parentKey) : undefined
      if (parent) {
        if (!(actor.kind === 'session' && this.store.workAuthority(parent.key).executor === actor.sessionId)) this.assertController(parent, actor)
        if (!this.store.workAuthority(parent.key).active) throw new WorkConflict('Cannot add work to a terminal parent.')
      }
      const assignee = request.assignee === undefined ? actor.kind === 'session' ? actor.sessionId : null : request.assignee
      if (assignee) this.requireSession(assignee)
      signal?.throwIfAborted()
      const record: WorkRecord = {
        key: `work:${randomUUID()}`, revision: 1, sequence: 1,
        title: request.title, definition: request.definition, origin: actor.kind === 'user' ? 'human' : 'agent_interpretation',
        changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
        kind: request.kind, summary: request.summary, artifacts: request.artifacts, basis: this.basis(request.parentKey),
        parentKey: request.parentKey,
        manager: actor.kind === 'session' ? actor.sessionId : parent ? this.store.workAuthority(parent.key).manager : assignee,
        assignee, assignmentRevision: 1, status: 'pending', dependencies: [],
      }
      const committed = this.store.createWork(record, this.actorName(actor), creation)
      if (!committed.created) return committed.record
      if (actor.kind === 'session') this.store.linkWorkSession(actor.sessionId, record.key)
      await this.publishNote(committed.record)
      return committed.record
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
