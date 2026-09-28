import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { InitiativeStore } from '../initiatives/store.ts'
import { WorkConflict, workAdoptionSchema, workChangeSchema, workDefinitionSchema, workInventorySchema, workKey,
  workProgressSchema, workDecisionSchema, WORK_APPROVE,
  type WorkActor, type WorkRecord, type WorkStamp, type WorkDecision } from '../initiatives/work-contract.ts'
import type { YieldDecisionRecord, YieldReference, YieldRequest } from './yield-contract.ts'
import type { DecisionEvidence } from './decision-brief.ts'
import { DECISION_EVIDENCE_HELP, parseDecisionEvidence } from './decision-brief.ts'
import type { SessionState } from './session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool as TypedTool, ToolResult } from '../tools/tool.ts'
import { delegationOwner } from './execution-scope.ts'
import { isSkillRootPath } from '../skills/paths.ts'

type Tool = TypedTool<ToolResult>

export interface WorkToolGuard {
  snapshot(sessionId: string): WorkStamp[]
  prompt(sessionId: string): string
  current(stamps: WorkStamp[]): boolean
  before(tool: Tool, args: Record<string, unknown>, context: ExecutionContext): { finish(failed: boolean, effect?: 'none'): string } | undefined
}

export interface WorkAlignmentDeps {
  state(id: string): SessionState | null | undefined
  evidence(source: DecisionEvidence): Promise<void>
  changed(record: WorkRecord, previous?: WorkRecord): Promise<void>
  fresh(sessionId: string, record: WorkRecord): Promise<void>
  successor(sessionId: string, record: WorkRecord): Promise<string | undefined>
}

export const WORK_HELP = {
  notice: 'Contracts describe work, never grant permissions or transfer assignments. Legacy untracked work has unknown provenance. Reporting responsibility is not control authority.',
  evidenceSchema: DECISION_EVIDENCE_HELP,
  update: { change: 'understanding|goal|authorization|pause', reason: 'Why this is changing, not just the new plan',
    definition: { objective: 'Outcome, not the current phase', acceptance: ['Final acceptance'], boundaries: ['Existing limits; not new permission'], evidence: [] },
    paused: false },
  adopt: { understanding: 'Restate outcome and acceptance', stop: ['Obsolete actions'], retain: ['Still-valid evidence/work'], next: ['Agent-chosen phase, not user requirements'] },
  checkpoint: { completed: [], artifacts: [], inFlight: [], unknown: [], retired: ['Obsolete assumptions, summaries and memory conclusions'] },
  transition: { strategy: 'fresh|successor' },
  select: 'Use key + revision to select an assigned agreement for subsequent inference; omit key to restore the all-assigned-work fence.',
  settle: { effectId: 'interrupted invocation', evidence: DECISION_EVIDENCE_HELP },
  workflow: 'context -> create or update/propose by key + revision -> executor adopt. Revisions and assignments fence old calls. Use checkpoint then transition at a safe boundary. No implicit ownership transfer. Custom answer text may correct the goal; never interpret it automatically as approval.',
  create: { title: 'Short work name', parentKey: 'optional root/parent work key',
    assignee: 'optional durable Session ID; defaults to the creating session',
    definition: { objective: 'Outcome', acceptance: ['Observable completion'], boundaries: [], evidence: [] },
    reason: 'Source and interpretation' },
  discovery: { query: 'optional text filter for list', limit: '1-20; defaults to 5', offset: 'defaults to 0; use nextOffset', detail: 'Read context with a key for the full work definition.' },
  management: {
    assign: { expectedSequence: 1, assignee: 'Session ID, or null to release; assigned work cannot be stolen', reason: 'Explicit handoff' },
    manage: { expectedSequence: 1, manager: 'Session ID or null; only current manager may hand off' },
    progress: { expectedSequence: 1, status: 'pending|in_progress|blocked|done|cancelled', blockedReason: 'required only when blocked',
      result: { summary: 'What was verified', evidence: ['genuine evidence references; required for agent completion'] } },
    dependencies: { expectedSequence: 1, keys: ['existing work keys'] },
  },
  unified: 'Use create for new work, update/propose with key + revision and {definition,change,reason,paused}; no separate Initiative SQL or session goal. Initiative is action=tree with a root key. Assignments, progress and definitions are one work item. Definitions and assignment generations fence execution; progress does not revise goals. Session creation never creates work. Propose returns a proposalId; ask(kind=decision, proposal={key,id}, brief=...) or the human Work panel reviews that exact proposal once.',
}

export class WorkAlignment implements WorkToolGuard {
  constructor(readonly store: InitiativeStore, private readonly deps: WorkAlignmentDeps) {}

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

  snapshot(sessionId: string): WorkStamp[] {
    const focus = this.store.workFocus(this.executor(sessionId))
    const all = this.records(sessionId, true)
    const selected = all.filter(record => !focus || record.key === focus)
    if (focus && !selected.length) return [{ key: focus, revision: this.get(focus).revision }]
    for (const record of [...selected]) {
      const parent = all.find(item => item.key === record.handoffFrom?.key && item.subject.kind === 'item')
      if (parent && !selected.includes(parent)) selected.push(parent)
    }
    return selected.map(record => ({
      key: record.key, revision: record.revision,
      ...(record.workflow ? { assignmentRevision: record.workflow.assignmentRevision } : {}),
      ...(record.adoption?.revision === record.revision && record.adoption.sessionId === this.executor(sessionId)
        ? { adoptionId: record.adoption.id } : {}),
    }))
  }

  current(stamps: WorkStamp[]): boolean {
    const records = this.store.workRecords()
    return stamps.every(stamp => records.some(record => record.key === stamp.key && record.revision === stamp.revision
      && record.workflow?.assignmentRevision === stamp.assignmentRevision))
  }

  currentDecision(request: YieldRequest): boolean {
    if (this.current(request.workStamps ?? [])) return true
    const binding = request.workProposal
    if (!binding) return false
    const record = this.get(binding.key)
    return record.workflow?.assignmentRevision === binding.assignmentRevision && !!record.proposals?.some(proposal =>
      proposal.id === binding.id && proposal.status === 'applied' && proposal.appliedRevision === record.revision
      && proposal.request?.requestId === request.id && proposal.request.sessionId === request.sessionId
      && proposal.request.physicalId === request.origin?.physicalId)
  }

  prompt(sessionId: string): string {
    const records = this.records(sessionId)
    if (!records.length) return ''
    const scope = this.store.workFocus(this.executor(sessionId)) ?? 'all assigned agreements'
    const payload = JSON.stringify(records.map(record => ({ ...record, authority: this.store.workAuthority(record.subject) })))
    const detail = payload.length <= 32000 ? payload : JSON.stringify(records.map(record => ({
      key: record.key, revision: record.revision, origin: record.origin, paused: record.paused,
      adopted: record.adoption?.revision === record.revision,
    }))) + '\nFull agreements exceed automatic context: read work action=context with a key for exact objectives, boundaries and checkpoints. This index is not the full agreement.'
    return `# Current work contracts (runtime facts)\nExecution scope: ${scope}\n` +
      'These supersede incompatible old plans, summaries and memory conclusions. Agent interpretations and next steps are NOT user requirements. Boundaries do not grant permission. ' +
      'Only definition is the current goal; pending proposals are not applied. Use work context/adopt before executing an unacknowledged revision. Read-only investigation remains available. Unresolved effects need reconciliation.\n' +
      detail
  }

  assertCurrent(stamps: WorkStamp[], sessionId: string): void {
    const current = this.snapshot(sessionId)
    if (current.length !== stamps.length || current.some(now => !stamps.some(old =>
      old.key === now.key && old.revision === now.revision && old.assignmentRevision === now.assignmentRevision
      && old.adoptionId && old.adoptionId === now.adoptionId))) {
      throw new WorkConflict('Work basis changed or is not adopted. Read work context and explicitly adopt the current revision; regenerate this action afterward.')
    }
    for (const stamp of current) {
      const record = this.get(stamp.key)
      if (record.workflow?.status === 'blocked'
        || record.workflow?.dependencies.some(key => this.get(key).workflow?.status !== 'done')) {
        throw new WorkConflict('Work is blocked or has unfinished dependencies. Select independent ready work instead.')
      }
      if (record.paused) {
        throw new WorkConflict(`Work "${record.key}" is paused. No new side-effecting execution is admitted.`)
      }
      if (!this.store.workAuthority(record.subject).active) {
        throw new WorkConflict(`Work "${record.key}" is terminal (${record.workflow?.status ?? 'inactive'}). No new side-effecting execution is admitted.`)
      }
      if (record.successors?.some(edge => edge.fromSessionId === this.executor(sessionId))
        || (record.transition && record.transition.sessionId === this.executor(sessionId))) {
        throw new WorkConflict(`Work "${record.key}" is awaiting a context transition. No new side-effecting execution is admitted.`)
      }
      if (record.handoffFrom) {
        const source = this.get(record.handoffFrom.key)
        if (source.successors?.findLast(edge => edge.fromSessionId === record.handoffFrom!.sessionId)?.sessionId !== this.executor(sessionId)) {
          throw new WorkConflict('Successor publication was not completed. This prepared context cannot execute.')
        }
        if (source.subject.kind === 'item' && this.store.workAuthority(source.subject).executor !== this.executor(sessionId)) {
          throw new WorkConflict('Successor context is ready, but Initiative assignment has not been explicitly transferred.')
        }
      }
      if (this.store.workEffects().some(effect => effect.status === 'unknown' && effect.stamps.some(ref => ref.key === stamp.key))) {
        throw new WorkConflict('An interrupted work operation has an unknown outcome. Inspect work context and settle it with evidence before continuing.')
      }
    }
  }

  before(tool: Tool, args: Record<string, unknown>, context: ExecutionContext) {
    if (['work', 'session', 'sql', 'invoke_tool', 'ask', 'reply', 'message', 'cancel'].includes(tool.name)) return
    const readOnly = typeof tool.readonly === 'function' ? tool.readonly(args) : tool.readonly === true
    if (readOnly || (tool.name === 'read' && isSkillRootPath(args.path))) return
    const stamps = context.workStamps ?? []
    try {
      if (!stamps.length && !this.records(context.sessionId, true).length && context.tools.has('work')
        && !['session', 'topic', 'initiative'].includes(tool.name)) {
        throw new WorkConflict('Untracked execution: create an attributed work item and explicitly adopt it before starting side effects. Historical scope is unknown, not unrestricted.')
      }
      this.assertCurrent(stamps, context.sessionId)
    } catch (error) {
      if (error instanceof WorkConflict && tool.readonly === undefined) {
        throw new WorkConflict(`${error.message} Tool "${tool.name}" is not confirmed read-only; Work execution checks apply.`)
      }
      throw error
    }
    if (!stamps.length) return
    const id = randomUUID()
    this.store.startWorkEffect(id, context.sessionId, tool.name, stamps)
    return { finish: (failed: boolean, effect?: 'none'): string => {
      this.store.finishWorkEffect(id, failed && effect !== 'none')
      const current = this.snapshot(context.sessionId)
      const stale = stamps.some(old => !current.some(now => now.key === old.key && now.revision === old.revision && now.adoptionId === old.adoptionId))
      for (const stamp of stamps) this.store.workEvent(stamp.key, context.sessionId, 'tool_result', {
        invocationId: id, tool: tool.name, revision: stamp.revision, stale, outcome: effect === 'none' ? 'not_applied' : failed ? 'unknown' : 'returned',
      })
      return stale ? '\n[STALE WORK RESULT: archived evidence from an obsolete task basis. This does not complete, approve or update current work. Revalidate before reuse.]' : ''
    } }
  }

  context(sessionId: string, key?: string, history = true) {
    if (!this.deps.state(sessionId)) throw new WorkConflict('Session not found in this Project.')
    const records = key === undefined ? this.records(sessionId) : [this.get(key)]
    return this.view(records, this.store.workFocus(this.executor(sessionId)), history)
  }

  inspect(key: string) { return this.view([this.get(key)], key, true) }

  private view(records: WorkRecord[], selected: string | undefined, history: boolean) {
    const keys = new Set(records.map(record => record.key))
    return { schema: WORK_HELP, selected, records: records.map(record => ({
      ...record, authority: this.store.workAuthority(record.subject), history: history ? this.store.workHistory(record.key) : [],
    })), effects: this.store.workEffects().filter(effect => effect.stamps.some(stamp => keys.has(stamp.key))) }
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
      throw new WorkConflict('Only the work controller or authenticated human may apply changes. Peers and reporting owners may propose, not reset or take over.')
    }
  }

  async execute(actor: WorkActor, action: string, key: string | undefined, revision: number | undefined, data: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (action === 'context') {
      if (actor.kind !== 'session') throw new WorkConflict('Context needs a session identity.')
      return this.context(actor.sessionId, key, false)
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
        key: record.key, revision: record.revision, sequence: record.sequence,
        title: record.workflow?.title, parentKey: record.workflow?.parentKey, status: record.workflow?.status,
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
        definition: workDefinitionSchema, reason: z.string().trim().min(1).max(2000),
      }).strict().parse(data)
      if (actor.kind === 'session') this.requireSession(actor.sessionId)
      const parent = request.parentKey ? this.get(request.parentKey) : undefined
      if (parent) {
        this.assertController(parent, actor)
        if (!this.store.workAuthority(parent.subject).active) throw new WorkConflict('Cannot add work to a terminal parent.')
      }
      const assignee = request.assignee === undefined ? actor.kind === 'session' ? actor.sessionId : null : request.assignee
      if (assignee) this.requireSession(assignee)
      for (const source of request.definition.evidence) await this.deps.evidence(source)
      signal?.throwIfAborted()
      if (parent) this.assertController(this.get(parent.key), actor)
      const subject = { kind: 'work' as const, id: randomUUID() }
      const record: WorkRecord = {
        key: workKey(subject), subject, revision: 1, sequence: 1,
        definition: request.definition, origin: actor.kind === 'user' ? 'human' : 'agent_interpretation',
        changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
        change: 'understanding', reason: request.reason, paused: false,
        workflow: { title: request.title, parentKey: request.parentKey,
          manager: parent ? this.store.workAuthority(parent.subject).manager : actor.kind === 'session' ? actor.sessionId : assignee,
          assignee, assignmentRevision: 1, status: 'pending', dependencies: [] },
      }
      this.store.saveWork(record, 0, this.actorName(actor), 'created')
      if (assignee && (actor.kind === 'user' || assignee === actor.sessionId)) this.store.setWorkFocus(assignee, record.key)
      await this.deps.changed(record)
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
      return { selected: key ?? null, notice: 'Subsequent inference is scoped to this work. This is not filesystem isolation or new permission. Omitting key restores the conservative all-assigned-work fence.' }
    }
    if (action === 'update' || action === 'propose') {
      const change = key
        ? workChangeSchema.parse({ ...z.object({ definition: workDefinitionSchema, change: workChangeSchema.shape.change,
          reason: workChangeSchema.shape.reason, paused: z.boolean().default(false) }).strict().parse(data),
          subject: this.get(key).subject, expectedRevision: revision })
        : workChangeSchema.parse(data)
      if (this.store.unifiedWork && !key) throw new WorkConflict('Use create for new work; revise existing work by key and revision.')
      const work = workKey(change.subject)
      const prior = this.store.workRecords().find(record => record.key === work)
      if ((prior?.revision ?? 0) !== change.expectedRevision) throw new WorkConflict('Work revision changed; reload before editing.')
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
      if (actor.kind === 'session' && prior && !pauseOnly && (change.change === 'goal' || change.change === 'authorization' || prior.origin === 'human')) {
        throw new WorkConflict('Changing a confirmed goal or authorization requires human review. Use propose; a quoted input alone does not prove your interpretation.')
      }
      const record: WorkRecord = { ...prior, key: work, subject: change.subject, revision: change.expectedRevision + 1,
        sequence: (prior?.sequence ?? 0) + 1, definition: change.definition,
        adoption: undefined, checkpoint: undefined, transition: undefined, answerReview: undefined,
        origin: pauseOnly ? prior!.origin : actor.kind === 'user' ? 'human' : 'agent_interpretation',
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
        result: z.object({ summary: z.string().trim().min(1).max(2000), evidence: workDefinitionSchema.shape.evidence }).strict().optional(),
        keys: z.array(z.string().min(1).max(600)).max(100).optional(),
      }).strict().parse(data)
      if (request.expectedSequence !== record.sequence) throw new WorkConflict('Work changed; reload before managing it.')
      const fields = action === 'assign' ? ['assignee', 'reason'] : action === 'manage' ? ['manager']
        : action === 'progress' ? ['status', 'blockedReason', 'result'] : ['keys']
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
        if (['done', 'cancelled'].includes(workflow.status)) throw new WorkConflict('Terminal work cannot be silently reopened.')
        if (request.status === 'done') {
          if (actor.kind === 'session' && (record.adoption?.revision !== record.revision || record.adoption.sessionId !== actor.sessionId)) {
            throw new WorkConflict('Adopt the current work definition before claiming acceptance.')
          }
          if (!request.result || actor.kind === 'session' && !request.result.evidence.length) throw new WorkConflict('Completion requires a result and verified acceptance evidence.')
          if (workflow.dependencies.some(key => this.get(key).workflow?.status !== 'done')
            || this.store.workRecords().some(item => item.workflow?.parentKey === key && !['done', 'cancelled'].includes(item.workflow.status))
            || this.store.workEffects().some(effect => effect.stamps.some(stamp => stamp.key === key))) {
            throw new WorkConflict('Dependencies, child work and unresolved effects must be settled before completion.')
          }
          for (const source of request.result.evidence) await this.deps.evidence(source)
        }
        workflow.status = request.status; workflow.blockedReason = request.blockedReason
        if (request.result) workflow.result = request.result
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
      if (action === 'adopt') {
        if (record.paused || record.transition?.status === 'pending' || !authority.active) throw new WorkConflict('Resume or finish the pending transition before adoption.')
        if (record.successors?.some(edge => edge.fromSessionId === actor.sessionId)) throw new WorkConflict('This execution was retired; use the prepared successor.')
        record = { ...record, transition: record.transition?.strategy === 'successor' ? record.transition : undefined,
          ...(record.workflow ? { workflow: { ...record.workflow, assignmentStarted: true } } : {}),
          answerReview: undefined, adoption: { ...workAdoptionSchema.parse(data),
          id: randomUUID(), sessionId: actor.sessionId, revision: record.revision } }
      } else {
        record = { ...record, checkpoint: { ...workInventorySchema.parse(data), sessionId: actor.sessionId, revision: record.revision } }
      }
      save(action)
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
