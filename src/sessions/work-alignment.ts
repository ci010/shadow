import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { InitiativeStore } from '../initiatives/store.ts'
import { WorkConflict, workAdoptionSchema, workChangeSchema, workDefinitionSchema, workInventorySchema, workKey,
  workProgressSchema, workDecisionSchema, WORK_APPROVE,
  type WorkActor, type WorkRecord, type WorkStamp, type WorkDecision } from '../initiatives/work-contract.ts'
import type { YieldDecisionRecord, YieldReference, YieldRequest } from './yield-contract.ts'
import type { DecisionEvidence } from './decision-brief.ts'
import { decisionEvidenceSchema, parseDecisionEvidence, toolEvidenceQuerySchema, type ToolEvidenceQuery } from './decision-brief.ts'
import type { SessionState } from './session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool as TypedTool, ToolResult } from '../tools/tool.ts'
import { delegationOwner } from './execution-scope.ts'
import { type WorkPolicy, type WorkBinding } from './work-policy.ts'
import { workNotesSchema, workNotePatchSchema, workDecisionContextSchema, type WorkDecisionContext } from '../initiatives/work-notes.ts'

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
  setPolicy?(sessionId: string, policy: WorkPolicy, validate: () => void): Promise<void>
  evidence(source: DecisionEvidence): Promise<void>
  resolveEvidence?(sessionId: string, sources: ToolEvidenceQuery, signal: AbortSignal): Promise<DecisionEvidence[]>
  changed(record: WorkRecord, previous?: WorkRecord): Promise<void>
  fresh(sessionId: string, record: WorkRecord): Promise<void>
  successor(sessionId: string, record: WorkRecord): Promise<string | undefined>
}

export const WORK_HELP = {
  notice: 'Notes orient work, never gate tools or grant permission. Completion is a reported result, not human acceptance.',
  create: { title: 'Short name', definition: { objective: 'Desired outcome; acceptance and boundaries are optional lists' },
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
  discovery: { query: 'Optional text filter for list/tree', limit: '1-20; defaults to 5', offset: 'Defaults to 0; use nextOffset' },
  version: 'Read the current note version before update, assign or review; send only changed fields. Goal revisions change only for semantic changes.',
  select: 'Select an assigned key for focus; omit key to clear focus. This does not restrict tool execution.',
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
    return this.store.workRecords().filter(record => {
      const authority = this.store.workAuthority(record.subject)
      return authority.executor === executor || record.successors?.some(edge => edge.fromSessionId === executor)
        || record.successors?.some(edge => edge.sessionId === executor)
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
    this.store.setWorkFocus(sessionId, record.key)
  }

  linkExecution(sessionId: string, parentId: string, binding?: WorkBinding): void {
    const state = this.deps.state(sessionId)
    if (!state || delegationOwner(state) !== parentId) throw new WorkConflict('Only the actual parent may link a temporary execution.')
    this.prepareDelegation(parentId, binding, state.mode === 'call' ? 'call' : 'task')
    const key = binding?.key ?? this.decisionContext(parentId)?.originKey
    if (key) this.store.setWorkFocus(sessionId, key)
  }

  private focus(sessionId: string): string | undefined {
    const key = this.store.workFocus(sessionId) ?? this.store.workFocus(this.executor(sessionId))
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
    if (this.current(request.workStamps ?? [])) return true
    const binding = request.workProposal
    if (!binding) return false
    const record = this.get(binding.key)
    return record.workflow?.assignmentRevision === binding.assignmentRevision && !!record.proposals?.some(proposal =>
      proposal.id === binding.id && proposal.status === 'applied' && proposal.appliedRevision === record.revision
      && proposal.request?.requestId === request.id && proposal.request.sessionId === request.sessionId
      && proposal.request.physicalId === request.origin?.physicalId)
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
    return '# Shared work notes\nNotes orient work, never gate tools or grant permission. Update meaningful changes once, without adoption or echoing. This bounded index omits detail; read work context by key for the full goal path and constraints. Reassess stale branches rather than repeating an obsolete premise.\n' +
      `Active notes: ${all.length}; shown: ${records.length}; omitted: ${all.length - records.length}. Use work context to discover your other notes; select a key or set ask workKey when assignments are ambiguous.\n` +
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
      if (!originKey) {
        const active = this.records(sessionId, true).filter(record => !['done', 'cancelled'].includes(record.workflow?.status ?? ''))
        if (active.length === 1) originKey = active[0].key
      }
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
    if (actor.kind === 'session' && editor !== actor.sessionId && this.focus(actor.sessionId) && this.focus(actor.sessionId) !== key) {
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

  reviewAnswer(sessionId: string, text: string, requestId: string, stamps = this.snapshot(sessionId)): void {
    for (const record of this.store.workRecords().filter(record => stamps.some(stamp =>
      stamp.key === record.key && stamp.revision === record.revision
      && stamp.assignmentRevision === record.workflow?.assignmentRevision))) {
      this.store.saveWork({ ...record, sequence: record.sequence + 1, adoption: undefined,
        answerReview: { requestId, text },
      }, record.sequence, 'human', 'custom_answer_review')
    }
  }

  private assertController(record: Pick<WorkRecord, 'subject'>, actor: WorkActor) {
    if (actor.kind === 'user') return
    if (this.deps.state(actor.sessionId)?.mode !== 'session' || this.store.workAuthority(record.subject).manager !== actor.sessionId) {
      throw new WorkConflict('Only the work controller or authenticated human may change the goal structure. Report a changed premise in your branch instead of rewriting another goal.')
    }
  }

  async execute(actor: WorkActor, action: string, key: string | undefined, revision: number | undefined, data: unknown, signal?: AbortSignal,
    userInput?: { text: string; source: Omit<DecisionEvidence, 'quote'> }): Promise<unknown> {
    signal?.throwIfAborted()
    if (action === 'policy') {
      const request = z.object({ mode: z.enum(['optional', 'required']), sessionId: z.string().min(1).max(512).optional() }).strict().parse(data)
      const target = request.sessionId ?? (actor.kind === 'session' ? actor.sessionId : undefined)
      if (!target) throw new WorkConflict('A target session is required.')
      this.requireSession(target)
      if (!this.deps.setPolicy) throw new WorkConflict('Work policy persistence is unavailable.')
      const previous = JSON.stringify(this.deps.state(target)?.workPolicy)
      const current = this.policy(target)
      const validate = () => {
        signal?.throwIfAborted()
        if (JSON.stringify(this.deps.state(target)?.workPolicy) !== previous) throw new WorkConflict('Work policy changed; reload before editing.')
        if (actor.kind === 'session' && (current.mode === 'required'
          ? current.controllerSessionId !== actor.sessionId
          : actor.sessionId !== target && (!key || this.store.workAuthority(this.get(key).subject).manager !== actor.sessionId))) {
          throw new WorkConflict('Only the Work policy controller or authenticated human may change these constraints.')
        }
        if (current.mode === 'required') {
          for (const bound of current.keys) {
            const record = this.get(bound)
            if (actor.kind === 'session' && this.deps.state(target)?.workPolicy === undefined
              && this.store.workAuthority(record.subject).manager !== actor.sessionId) {
              throw new WorkConflict('Legacy delegated Work can only be relaxed by its controller or a human.')
            }
            if (request.mode === 'optional' || key !== bound) {
              if (!['done', 'cancelled'].includes(record.workflow?.status ?? '')
                || this.store.workEffects().some(effect => effect.stamps.some(stamp => stamp.key === bound))) {
                throw new WorkConflict('Finish or cancel bound Work and settle its effects before removing constraints.')
              }
            }
          }
        }
        if (request.mode === 'required') {
          if (!key) throw new WorkConflict('Enabling Work requires a concrete key and revision.')
          const record = this.get(key)
          if (record.revision !== revision || this.store.workAuthority(record.subject).executor !== target) {
            throw new WorkConflict('Enable only the exact Work revision assigned to the target session.')
          }
        }
      }
      validate()
      const policy: WorkPolicy = request.mode === 'optional' ? { mode: 'optional' } : {
        mode: 'required', keys: [key!],
        controllerSessionId: current.mode === 'required' ? current.controllerSessionId
          : this.store.workAuthority(this.get(key!).subject).manager ?? target,
      }
      await this.deps.setPolicy(target, policy, validate)
      return { sessionId: target, policy, notice: 'Use a new inference round. Policy does not grant capabilities or accept results.' }
    }
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
      if (action === 'tree' && !key) throw new WorkConflict('Select a root work key for the Initiative view.')
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
        title: z.string().trim().min(1).max(160), parentKey: z.string().min(1).max(600).optional(),
        assignee: z.string().min(1).max(512).nullable().optional(),
        definition: workDefinitionSchema, reason: z.string().trim().min(1).max(2000).default('Working interpretation, not new authorization'),
        notes: workNotesSchema.omit({ attention: true, basis: true }).default({}),
        requestQuote: decisionEvidenceSchema.shape.quote.optional(),
      }).strict().parse(data)
      if (actor.kind === 'session') this.requireSession(actor.sessionId)
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
      const subject = { kind: 'work' as const, id: randomUUID() }
      const record: WorkRecord = {
        key: workKey(subject), subject, revision: 1, sequence: 1,
        definition: request.definition, origin: actor.kind === 'user' ? 'human' : 'agent_interpretation',
        changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
        change: 'understanding', reason: request.reason, paused: false,
        notes: { ...request.notes, basis: this.basis(request.parentKey) }, requestSource,
        workflow: { title: request.title, parentKey: request.parentKey,
          manager: actor.kind === 'session' ? actor.sessionId : parent ? this.store.workAuthority(parent.subject).manager : assignee,
          assignee, assignmentRevision: 1, status: 'pending', dependencies: [] },
      }
      this.store.saveWork(record, 0, this.actorName(actor), 'created')
      if (assignee && (actor.kind === 'user' || assignee === actor.sessionId)) this.store.setWorkFocus(assignee, record.key)
      await this.publishNote(record)
      return record
    }
    if (action === 'apply_proposal') {
      if (actor.kind !== 'user') throw new WorkConflict('Only an authenticated human may approve a work proposal.')
      const request = z.object({ proposalId: z.string().uuid() }).strict().parse(data)
      if (!key) throw new WorkConflict('A work key is required.')
      return this.applyProposal(key, request.proposalId)
    }
    if (action === 'select') {
      if (actor.kind !== 'session' || this.deps.state(actor.sessionId)?.mode !== 'session') throw new WorkConflict('Only a durable executor may select its own work scope.')
      if (key) {
        const record = this.get(key)
        if (record.revision !== revision || this.store.workAuthority(record.subject).executor !== actor.sessionId) throw new WorkConflict('Select an exact current revision assigned to you.')
      }
      this.store.setWorkFocus(actor.sessionId, key)
      return { selected: key ?? null, notice: 'This selects the note shown in your context and inferred for questions. It does not gate tools or grant permission.' }
    }
    if (action === 'update' || action === 'propose') {
      const update = key ? z.object({ definition: workDefinitionSchema, change: workChangeSchema.shape.change,
        reason: workChangeSchema.shape.reason, paused: z.boolean().default(false),
        requestQuote: decisionEvidenceSchema.shape.quote.optional() }).strict().parse(data) : undefined
      const change = key
        ? workChangeSchema.parse({ definition: update!.definition, change: update!.change, reason: update!.reason, paused: update!.paused,
          subject: this.get(key).subject, expectedRevision: revision })
        : workChangeSchema.parse(data)
      if (this.store.unifiedWork && !key) throw new WorkConflict('Use create for new work; revise existing work by key and revision.')
      const work = workKey(change.subject)
      const prior = this.store.workRecords().find(record => record.key === work)
      if ((prior?.revision ?? 0) !== change.expectedRevision) throw new WorkConflict('Work revision changed; reload before editing.')
      let requestSource: WorkRecord['requestSource']
      if (update?.requestQuote !== undefined) {
        if (action !== 'update' || actor.kind !== 'session' || !prior || !userInput
          || userInput.source.kind !== 'user' || userInput.source.sessionId !== actor.sessionId
          || !userInput.text.includes(update.requestQuote)) {
          throw new WorkConflict('requestQuote must quote the current authenticated owner input; external messages, Retry and Continue do not authorize a new goal. Use propose when human review is needed.')
        }
        const authority = this.store.workAuthority(prior.subject)
        const additive = (change.change === 'goal' || change.change === 'understanding')
          && !prior.paused && !change.paused && !prior.transition && !prior.answerReview
          && !prior.proposals?.some(proposal => proposal.status === 'pending')
          && authority.executor === actor.sessionId && authority.manager === actor.sessionId
          && change.definition.objective === prior.definition.objective
          && JSON.stringify(change.definition.boundaries) === JSON.stringify(prior.definition.boundaries)
          && change.definition.acceptance.length > prior.definition.acceptance.length
          && prior.definition.acceptance.every((entry, index) => entry === change.definition.acceptance[index])
          && prior.definition.evidence.every(entry => change.definition.evidence.some(source => JSON.stringify(source) === JSON.stringify(entry)))
        if (!additive) throw new WorkConflict('A user-directed update may only append acceptance while preserving objective, boundaries and evidence. It cannot resume paused work or resolve a pending decision. Use propose for other changes.')
        requestSource = { ...userInput.source, kind: 'user', quote: update.requestQuote }
        await this.deps.evidence(requestSource)
      }
      for (const source of change.definition.evidence) {
        await this.deps.evidence(source)
        signal?.throwIfAborted()
      }
      const authority = this.store.workAuthority(change.subject)
      if (!authority.active) throw new WorkConflict('Cannot revise terminal work.')
      if (action === 'propose') {
        if (!prior) throw new WorkConflict('Register the base agreement first; proposals cannot silently create or pause another session work scope.')
        const proposal = { id: randomUUID(), baseRevision: prior.revision,
          assignmentRevision: prior.workflow?.assignmentRevision, status: 'pending' as const,
          change: change.change, reason: change.reason, definition: change.definition, paused: change.paused }
        const next = { ...prior, sequence: prior.sequence + 1, proposals: [...(prior.proposals ?? []), proposal] }
        this.store.saveWork(next, prior.sequence, this.actorName(actor), 'proposal')
        await this.deps.changed(next, prior)
        return { status: 'proposed', key: work, proposalId: proposal.id,
          notice: 'Review this exact proposal with ask(kind=decision,proposal={key,id},brief=...) or the Work panel. One approval applies it; executor adoption remains separate.' }
      }
      const pauseOnly = !!prior && change.change === 'pause' && change.paused
        && JSON.stringify(change.definition) === JSON.stringify(prior.definition)
      if (!(pauseOnly && actor.kind === 'session' && actor.sessionId === authority.executor)) this.assertController({ subject: change.subject }, actor)
      if (actor.kind === 'session' && prior && !pauseOnly && !requestSource
        && (change.change === 'goal' || change.change === 'authorization' || prior.origin === 'human' || prior.requestSource
          || prior.paused !== change.paused
          || JSON.stringify(change.definition.boundaries) !== JSON.stringify(prior.definition.boundaries))) {
        throw new WorkConflict('Goal or authorization changes, and changes to human-confirmed agreements, require human review. Use propose; a quoted input alone does not prove your interpretation.')
      }
      const record: WorkRecord = { ...prior, key: work, subject: change.subject, revision: change.expectedRevision + 1,
        sequence: (prior?.sequence ?? 0) + 1, definition: change.definition,
        adoption: undefined, checkpoint: undefined, transition: undefined, answerReview: undefined,
        origin: pauseOnly ? prior!.origin : actor.kind === 'user' ? 'human' : 'agent_interpretation',
        requestSource: pauseOnly ? prior!.requestSource : requestSource,
        changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
        change: change.change, reason: change.reason, paused: change.paused,
        ...(prior?.handoffFrom ? { handoffFrom: prior.handoffFrom } : {}),
        ...(prior?.successors ? { successors: prior.successors } : {}) }
      this.store.saveWork(record, prior?.sequence ?? 0, this.actorName(actor), 'revision')
      // Publication errors are surfaced; the committed fence is never silently rolled back.
      await this.deps.changed(record, prior)
      return record
    }
    if (!key) throw new WorkConflict('A work key is required.')
    let record = this.get(key)
    if (revision !== record.revision) throw new WorkConflict('Work revision changed; reload before acting.')
    const authority = this.store.workAuthority(record.subject)
    const name = this.actorName(actor)
    const save = (kind: string, eventDetails?: unknown) => {
      const sequence = record.sequence
      record = { ...record, sequence: sequence + 1 }
      this.store.saveWork(record, sequence, name, kind, eventDetails)
    }
    if (['assign', 'manage', 'progress', 'dependencies'].includes(action)) {
      const previous = record
      if (!record.workflow) throw new WorkConflict('Migrate this historical work before managing it.')
      const request = z.object({
        expectedSequence: z.number().int().positive(),
        assignee: z.string().min(1).max(512).nullable().optional(), manager: z.string().min(1).max(512).nullable().optional(),
        reason: z.string().trim().min(1).max(2000).optional(), status: workProgressSchema.optional(),
        blockedReason: z.string().trim().min(1).max(2000).optional(),
        blockedScope: z.enum(['step', 'work']).optional(),
        result: z.object({ summary: z.string().trim().min(1).max(2000), evidence: workDefinitionSchema.shape.evidence,
          sources: toolEvidenceQuerySchema.max(8).optional(),
        }).strict().refine(value => value.evidence.length + (value.sources?.length ?? 0) <= 8,
          'Provide at most 8 combined evidence references and tool sources.').optional(),
        keys: z.array(z.string().min(1).max(600)).max(100).optional(),
      }).strict().parse(data)
      if (request.expectedSequence !== record.sequence) throw new WorkConflict('Work changed; reload before managing it.')
      const fields = action === 'assign' ? ['assignee', 'reason'] : action === 'manage' ? ['manager']
        : action === 'progress' ? ['status', 'blockedReason', 'blockedScope', 'result'] : ['keys']
      if (Object.keys(request).some(key => key !== 'expectedSequence' && !fields.includes(key))) throw new WorkConflict('Unexpected fields for this work action.')
      const workflow = { ...record.workflow }
      const orphanRecovery = actor.kind === 'user' && !!workflow.assignee && !this.deps.state(workflow.assignee)
      if (action === 'assign') {
        if (request.assignee === undefined) throw new WorkConflict('Provide an assignee or null to release.')
        if (workflow.assignee && (request.assignee !== null || actor.kind === 'session' && actor.sessionId !== workflow.assignee)) {
          throw new WorkConflict('Assigned work cannot be stolen; its current executor must release it first.')
        }
        if (!workflow.assignee && !(actor.kind === 'session' && actor.sessionId === request.assignee)) this.assertController(record, actor)
        if (request.assignee) this.requireSession(request.assignee)
        if (request.assignee && !authority.active) throw new WorkConflict('Cannot assign terminal work.')
        if (workflow.assignee && (!request.reason || this.store.workEffects().some(effect => effect.stamps.some(stamp => stamp.key === key))
          || !orphanRecovery && (workflow.assignmentStarted || record.adoption) && (!record.checkpoint || record.checkpoint.revision !== record.revision
            || record.checkpoint.sessionId !== workflow.assignee || record.checkpoint.inFlight.length || record.checkpoint.unknown.length))) {
          throw new WorkConflict('Release requires a reason and an executor checkpoint with no in-flight or unknown effects.')
        }
        workflow.assignee = request.assignee; workflow.assignmentRevision++; workflow.assignmentStarted = false
        record = { ...record, adoption: undefined, checkpoint: undefined, transition: undefined }
      } else if (action === 'manage') {
        if (request.manager === undefined) throw new WorkConflict('Provide a manager or null.')
        if (!(workflow.manager === null && actor.kind === 'session' && request.manager === actor.sessionId)) this.assertController(record, actor)
        if (request.manager) this.requireSession(request.manager)
        workflow.manager = request.manager
      } else if (action === 'dependencies') {
        this.assertController(record, actor)
        if (!request.keys) throw new WorkConflict('Provide dependency keys.')
        workflow.dependencies = [...new Set(request.keys)]
      } else {
        if (actor.kind === 'session' && actor.sessionId !== workflow.assignee) throw new WorkConflict('Only the assigned executor may report progress.')
        if (!request.status) throw new WorkConflict('Provide a work status.')
        if (request.blockedScope !== undefined && request.status !== 'blocked') throw new WorkConflict('blockedScope requires blocked progress.')
        if (['done', 'cancelled'].includes(workflow.status)) throw new WorkConflict('Terminal work cannot be silently reopened.')
        const result = request.result && { summary: request.result.summary, evidence: request.result.evidence }
        if (request.status === 'done') {
          if (actor.kind === 'session' && (record.adoption?.revision !== record.revision || record.adoption.sessionId !== actor.sessionId)) {
            throw new WorkConflict('Adopt the current work definition before claiming acceptance.')
          }
          if (!result || actor.kind === 'session' && !result.evidence.length && !request.result?.sources?.length) {
            throw new WorkConflict('Completion requires a result and verified acceptance evidence. Supply result.sources: [{id: "tool call ID", quote: "exact tool output"}] for your own recorded results, or full result.evidence references. Do not guess physicalId.')
          }
        }
        if (result && request.result?.sources) {
          if (actor.kind !== 'session') throw new WorkConflict('Short tool sources require an executing session; humans must supply full evidence references.')
          if (!this.deps.resolveEvidence) throw new WorkConflict('Tool source lookup is unavailable. Supply full result.evidence references instead.')
          const evidence = await this.deps.resolveEvidence(actor.sessionId, request.result.sources, signal ?? new AbortController().signal)
          result.evidence = workDefinitionSchema.shape.evidence.parse([...result.evidence, ...evidence])
        }
        if (request.status === 'done' && result) for (const source of result.evidence) {
          signal?.throwIfAborted()
          await this.deps.evidence(source)
        }
        if (request.status === 'done' && (workflow.dependencies.some(key => this.get(key).workflow?.status !== 'done')
          || this.store.workRecords().some(item => item.workflow?.parentKey === key && !['done', 'cancelled'].includes(item.workflow.status))
          || this.store.workEffects().some(effect => effect.stamps.some(stamp => stamp.key === key)))) {
          throw new WorkConflict('Dependencies, child work and unresolved effects must be settled before completion.')
        }
        workflow.blockedScope = request.status === 'blocked'
          ? request.blockedScope ?? (workflow.status === 'blocked' ? workflow.blockedScope ?? 'work' : 'step')
          : undefined
        workflow.status = request.status; workflow.blockedReason = request.blockedReason
        if (result) workflow.result = result
      }
      signal?.throwIfAborted()
      record = { ...record, workflow }
      save(action, action === 'assign' ? { from: previous.workflow?.assignee, to: request.assignee,
        reason: request.reason, orphanRecovery } : undefined)
      await this.deps.changed(record, previous)
      return record
    }
    if (action === 'release') {
      const successor = record.successors?.findLast(edge => edge.fromSessionId === authority.executor)
      if (actor.kind !== 'session' || actor.sessionId !== authority.executor || record.subject.kind !== 'item'
        || !successor) {
        throw new WorkConflict('Only the current assignee can explicitly release work after a successor has been prepared.')
      }
      const result = this.store.query(`UPDATE initiative_items SET assignee_session_id=NULL WHERE id='${record.subject.itemId}' AND assignee_session_id=actor_session_id()`, actor.sessionId)
      if (result.changes !== 1) throw new WorkConflict('Assignment changed; release was not applied.')
      this.store.workEvent(key, name, 'assignment_released', { successorId: successor.sessionId })
      return { status: 'released', notice: 'Unassigned, not transferred. The Initiative owner must explicitly assign the prepared successor using a guarded update.' }
    }
    if (action === 'settle') {
      const request = z.object({ effectId: z.string().uuid(), evidence: z.unknown().optional() }).strict().parse(data)
      this.assertController(record, actor)
      const effect = this.store.workEffects().find(item => item.id === request.effectId && item.status === 'unknown'
        && item.stamps.some(stamp => stamp.key === key))
      if (!effect) throw new WorkConflict('Unknown interrupted operation; running operations cannot be settled manually.')
      if (actor.kind === 'session') await this.deps.evidence(parseDecisionEvidence(request.evidence, 'data.evidence'))
      signal?.throwIfAborted()
      if (this.get(key).revision !== revision) throw new WorkConflict('Work changed during evidence review; reload before settling.')
      this.assertController(record, actor)
      this.store.workEvent(key, name, 'effect_settled', request)
      this.store.finishWorkEffect(effect.id, false)
      return { status: 'reconciled', effectId: effect.id, notice: 'An evidence review, not a rollback or proof of external cancellation.' }
    }
    if (action === 'adopt' || action === 'checkpoint') {
      if (actor.kind !== 'session' || actor.sessionId !== authority.executor || this.deps.state(actor.sessionId)?.mode !== 'session') {
        throw new WorkConflict('Only the current durable executor can acknowledge or inventory its work. A human/controller cannot impersonate acceptance.')
      }
      const previous = record
      if (action === 'adopt') {
        if (record.paused || record.transition?.status === 'pending' || !authority.active) throw new WorkConflict('Resume or finish the pending transition before adoption.')
        if (record.successors?.some(edge => edge.fromSessionId === actor.sessionId)) throw new WorkConflict('This execution was retired; use the prepared successor.')
        const { acceptance, ...adoption } = workAdoptionSchema.extend({
          acceptance: workDefinitionSchema.shape.acceptance.optional(),
        }).strict().parse(data)
        const additions = [...new Set(acceptance ?? [])].filter(criterion => !record.definition.acceptance.includes(criterion))
        if (additions.length) {
          if (authority.manager !== actor.sessionId || record.origin !== 'agent_interpretation' || record.requestSource
            || record.transition || record.proposals?.some(proposal => proposal.status === 'pending')) {
            throw new WorkConflict('Adoption cannot revise a human-confirmed, delegated or pending agreement. Use update with authenticated owner input or propose for review.')
          }
          record = { ...record, revision: record.revision + 1, checkpoint: undefined,
            definition: workDefinitionSchema.parse({ ...record.definition, acceptance: [...record.definition.acceptance, ...additions] }),
            changedBy: name, changedAt: new Date().toISOString(), change: 'understanding', reason: adoption.understanding }
        }
        record = { ...record, transition: record.transition?.strategy === 'successor' ? record.transition : undefined,
          ...(record.workflow ? { workflow: { ...record.workflow, assignmentStarted: true } } : {}),
          answerReview: undefined, adoption: { ...adoption,
          id: randomUUID(), sessionId: actor.sessionId, revision: record.revision } }
      } else {
        record = { ...record, checkpoint: { ...workInventorySchema.parse(data), sessionId: actor.sessionId, revision: record.revision } }
      }
      save(action)
      if (record.revision !== previous.revision) await this.deps.changed(record, previous)
      return record
    }
    if (action === 'transition') {
      const request = z.object({ strategy: z.enum(['fresh', 'successor']) }).strict().parse(data)
      if (!(actor.kind === 'session' && actor.sessionId === authority.executor && request.strategy === 'fresh')) this.assertController(record, actor)
      if (!authority.executor || !record.checkpoint || record.checkpoint.sessionId !== authority.executor
        || record.checkpoint.revision !== record.revision) throw new WorkConflict('The current executor must first provide a version-bound checkpoint.')
      if (record.checkpoint.inFlight.length || record.checkpoint.unknown.length
        || this.store.workEffects().some(effect => effect.sessionId === authority.executor)) {
        throw new WorkConflict('Resolve in-flight/unknown work before replacing context. External operations are never cancelled by reset.')
      }
      if (record.transition?.status === 'applied') {
        if (record.transition.sessionId === authority.executor) return record
        record = { ...record, transition: undefined }
      }
      if (record.transition && record.transition.strategy !== request.strategy) throw new WorkConflict('A different transition is already pending.')
      if (!record.transition) {
        record = { ...record, adoption: undefined, transition: {
          id: randomUUID(), strategy: request.strategy, sessionId: authority.executor,
          revision: record.revision, status: 'pending',
        } }
        save('transition_requested')
      }
      if (request.strategy === 'fresh') await this.deps.fresh(authority.executor, record)
      else {
        const successorId = await this.deps.successor(authority.executor, record)
        if (successorId) this.finishTransition(key, record.transition!.id, successorId)
      }
      return this.get(key)
    }
    throw new WorkConflict('Unknown work action.')
  }

  private requireSession(id: string) {
    const state = this.deps.state(id)
    if (!state || state.mode && state.mode !== 'session') throw new WorkConflict('Work assignments require a durable Session in this Project, not a task, call or remote execution reference.')
  }

  decision(key: string, proposalId: string): WorkDecision {
    const record = this.get(key)
    const proposal = record.proposals?.find(item => item.id === proposalId)
    if (!proposal || proposal.status !== 'pending' || proposal.baseRevision !== record.revision
      || proposal.assignmentRevision !== record.workflow?.assignmentRevision) throw new WorkConflict('Work proposal is missing, settled or stale.')
    const { id, baseRevision, assignmentRevision, change, reason, definition, paused } = proposal
    return workDecisionSchema.parse({ key, id, baseRevision, assignmentRevision, change, reason, definition, paused })
  }

  bindDecision(binding: WorkDecision, reference: YieldReference) {
    const current = this.decision(binding.key, binding.id)
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw new WorkConflict('Decision does not match the exact saved work proposal.')
    const record = this.get(binding.key)
    const proposal = record.proposals!.find(item => item.id === binding.id)!
    if (proposal.request && JSON.stringify(proposal.request) !== JSON.stringify(reference)) throw new WorkConflict('This proposal already has a decision request; resolve it there or use the Work panel.')
    this.store.saveWork({ ...record, sequence: record.sequence + 1,
      proposals: record.proposals!.map(item => item.id === binding.id ? { ...item, request: reference } : item),
    }, record.sequence, reference.sessionId, 'proposal_question')
  }

  async applyProposal(key: string, proposalId: string) {
    const record = this.get(key)
    const proposal = record.proposals?.find(item => item.id === proposalId)
    if (proposal?.status === 'applied') return record
    const binding = this.decision(key, proposalId)
    if (!this.store.workAuthority(record.subject).active) throw new WorkConflict('Cannot approve terminal work.')
    for (const source of binding.definition.evidence) await this.deps.evidence(source)
    const latest = this.get(key)
    if (latest.proposals?.find(item => item.id === proposalId)?.status === 'applied') return latest
    this.decision(key, proposalId)
    if (!this.store.workAuthority(latest.subject).active) throw new WorkConflict('Cannot approve terminal work.')
    const next: WorkRecord = {
      ...latest, revision: latest.revision + 1, sequence: latest.sequence + 1,
      definition: binding.definition, change: binding.change, reason: binding.reason, paused: binding.paused,
      origin: 'human', changedBy: 'human', changedAt: new Date().toISOString(),
      adoption: undefined, checkpoint: undefined, transition: undefined, answerReview: undefined,
      proposals: latest.proposals!.map(item => item.id === proposalId
        ? { ...item, status: 'applied', appliedRevision: latest.revision + 1 } : item),
    }
    this.store.saveWork(next, latest.sequence, 'human', 'proposal_applied')
    await this.deps.changed(next, latest)
    return next
  }

  async settleDecision(record: YieldDecisionRecord) {
    const binding = record.request.workProposal
    if (!binding || !record.answer) return
    const work = this.get(binding.key)
    const proposal = work.proposals?.find(item => item.id === binding.id)
    if (proposal && proposal.status !== 'pending') return
    const current = this.decision(binding.key, binding.id)
    if (record.invalidated || JSON.stringify(current) !== JSON.stringify(binding)
      || proposal?.request?.sessionId !== record.request.sessionId
      || proposal.request.physicalId !== record.request.origin?.physicalId
      || proposal.request.requestId !== record.request.id
      || record.answer.requestId !== record.request.id) {
      throw new WorkConflict('Decision does not match the bound work proposal and request.')
    }
    if (record.answer.answeredBy === 'user' && !record.answer.custom && record.answer.option === WORK_APPROVE) {
      await this.applyProposal(binding.key, binding.id)
    } else {
      this.store.saveWork({ ...work, sequence: work.sequence + 1,
        proposals: work.proposals!.map(item => item.id === binding.id ? { ...item, status: 'rejected' } : item),
      }, work.sequence, record.answer.answeredBy, 'proposal_not_approved')
    }
  }

  async recoverDecisions(read: (reference: YieldReference) => Promise<YieldDecisionRecord | undefined>) {
    for (const work of this.store.workRecords()) {
      for (const proposal of work.proposals ?? []) {
        if (proposal.status !== 'pending' || !proposal.request) continue
        const record = await read(proposal.request)
        if (!record?.answer) continue
        if (record.invalidated || proposal.baseRevision !== this.get(work.key).revision
          || proposal.assignmentRevision !== this.get(work.key).workflow?.assignmentRevision) {
          const current = this.get(work.key)
          this.store.saveWork({ ...current, sequence: current.sequence + 1,
            proposals: current.proposals!.map(item => item.id === proposal.id ? { ...item, status: 'rejected' } : item),
          }, current.sequence, 'recovery', 'stale_proposal_answer')
          continue
        }
        await this.settleDecision(record)
      }
    }
  }

  finishTransition(key: string, transitionId: string, successorId?: string): void {
    const record = this.get(key)
    if (record.transition?.id !== transitionId) throw new WorkConflict('Transition was superseded; do not adopt its old handoff.')
    if (record.transition.status === 'applied') return
    this.store.saveWork({ ...record, sequence: record.sequence + 1,
      transition: { ...record.transition, status: 'applied', ...(successorId ? { successorId } : {}) },
      ...(successorId ? { successors: [...(record.successors ?? []), {
        sessionId: successorId, fromSessionId: record.transition.sessionId,
      }] } : {}),
    }, record.sequence, record.transition.sessionId, 'transition_applied')
  }

  async resumeTransition(record: WorkRecord): Promise<void> {
    if (record.transition?.status !== 'pending') return
    if (record.transition.strategy === 'fresh') await this.deps.fresh(record.transition.sessionId, record)
    else {
      const successor = await this.deps.successor(record.transition.sessionId, record)
      if (successor) this.finishTransition(record.key, record.transition.id, successor)
    }
  }

  handoff(record: WorkRecord): string {
    return 'Intentional work realignment, not a continuity summary. The current contract is the authority; ' +
      'old reasoning/memory/documents are historical until checked against it. No permissions or Initiative assignments transfer.\n' +
      JSON.stringify({ contract: record.definition, origin: record.origin, key: record.key, revision: record.revision,
        inventory: record.checkpoint, transitionId: record.transition?.id })
  }
}
