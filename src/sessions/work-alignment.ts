import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { InitiativeStore } from '../initiatives/store.ts'
import { WorkConflict, workAdoptionSchema, workChangeSchema, workInventorySchema, workKey,
  type WorkActor, type WorkRecord, type WorkStamp } from '../initiatives/work-contract.ts'
import type { DecisionEvidence } from './decision-brief.ts'
import { parseDecisionEvidence } from './decision-brief.ts'
import type { SessionState } from './session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool } from '../tools/tool.ts'
import { delegationOwner } from './execution-scope.ts'

export interface WorkToolGuard {
  snapshot(sessionId: string): WorkStamp[]
  prompt(sessionId: string): string
  current(stamps: WorkStamp[]): boolean
  before(tool: Tool, args: Record<string, unknown>, context: ExecutionContext): { finish(failed: boolean): string } | undefined
}

export interface WorkAlignmentDeps {
  state(id: string): SessionState | null | undefined
  evidence(source: DecisionEvidence): Promise<void>
  changed(record: WorkRecord): Promise<void>
  fresh(sessionId: string, record: WorkRecord): Promise<void>
  successor(sessionId: string, record: WorkRecord): Promise<string | undefined>
}

export const WORK_HELP = {
  notice: 'Contracts describe work, never grant permissions or transfer assignments. Legacy untracked work has unknown provenance. Reporting responsibility is not control authority.',
  update: { subject: { kind: 'topic', sessionId: 'or kind:item with initiativeId,itemId' },
    expectedRevision: 0, change: 'understanding|goal|authorization|pause', reason: 'Why this is changing, not just the new plan',
    definition: { objective: 'Outcome, not the current phase', acceptance: ['Final acceptance'], boundaries: ['Existing limits; not new permission'], evidence: [] },
    paused: false },
  adopt: { understanding: 'Restate outcome and acceptance', stop: ['Obsolete actions'], retain: ['Still-valid evidence/work'], next: ['Agent-chosen phase, not user requirements'] },
  checkpoint: { completed: [], artifacts: [], inFlight: [], unknown: [], retired: ['Obsolete assumptions, summaries and memory conclusions'] },
  transition: { strategy: 'fresh|successor' },
  select: 'Use key + revision to select an assigned agreement for subsequent inference; omit key to restore the all-assigned-work fence.',
  settle: { effectId: 'interrupted invocation', evidence: 'an exact tool-receipt reference, or an authenticated human review' },
  workflow: 'context -> update/propose with expectedRevision -> executor adopt. Revisions fence old tool calls immediately. Use checkpoint then transition at a safe boundary. No cross-session reset or implicit ownership transfer. A paused contract must be revised before adoption. Custom yield text may correct the goal: propose/update the contract, never interpret it automatically as approval.',
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
      ...(record.adoption?.revision === record.revision && record.adoption.sessionId === this.executor(sessionId)
        ? { adoptionId: record.adoption.id } : {}),
    }))
  }

  current(stamps: WorkStamp[]): boolean {
    const records = this.store.workRecords()
    return stamps.every(stamp => records.some(record => record.key === stamp.key && record.revision === stamp.revision))
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
      'Use work context/adopt before executing an unacknowledged revision. Read-only investigation remains available. Unresolved effects need reconciliation.\n' +
      detail
  }

  assertCurrent(stamps: WorkStamp[], sessionId: string): void {
    const current = this.snapshot(sessionId)
    if (current.length !== stamps.length || current.some(now => !stamps.some(old =>
      old.key === now.key && old.revision === now.revision && old.adoptionId && old.adoptionId === now.adoptionId))) {
      throw new WorkConflict('Work basis changed or is not adopted. Read work context and explicitly adopt the current revision; regenerate this action afterward.')
    }
    for (const stamp of current) {
      const record = this.get(stamp.key)
      if (record.paused || record.successors?.some(edge => edge.fromSessionId === this.executor(sessionId))
        || (record.transition && record.transition.sessionId === this.executor(sessionId))
        || !this.store.workAuthority(record.subject).active) {
        throw new WorkConflict('Work is paused, terminal, or awaiting a context transition. No new execution is admitted.')
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
    if (['work', 'invoke_tool', 'yield', 'message', 'kill'].includes(tool.name)) return
    const readOnly = typeof tool.readonly === 'function' ? tool.readonly(args) : tool.readonly === true
    if (readOnly) return
    const stamps = context.workStamps ?? []
    if (!stamps.length && !this.records(context.sessionId, true).length && context.tools.has('work')
      && !['topic', 'initiative'].includes(tool.name)) {
      throw new WorkConflict('Untracked execution: register an attributed work agreement with work update and explicitly adopt it before starting side effects. Historical scope is unknown, not unrestricted.')
    }
    this.assertCurrent(stamps, context.sessionId)
    if (!stamps.length) return
    const id = randomUUID()
    this.store.startWorkEffect(id, context.sessionId, tool.name, stamps)
    return { finish: (failed: boolean): string => {
      this.store.finishWorkEffect(id, failed)
      const current = this.snapshot(context.sessionId)
      const stale = stamps.some(old => !current.some(now => now.key === old.key && now.revision === old.revision && now.adoptionId === old.adoptionId))
      for (const stamp of stamps) this.store.workEvent(stamp.key, context.sessionId, 'tool_result', {
        invocationId: id, tool: tool.name, revision: stamp.revision, stale, outcome: failed ? 'unknown' : 'returned',
      })
      return stale ? '\n[STALE WORK RESULT: archived evidence from an obsolete task basis. This does not complete, approve or update current work. Revalidate before reuse.]' : ''
    } }
  }

  context(sessionId: string, key?: string, history = true) {
    if (!this.deps.state(sessionId)) throw new WorkConflict('Session not found in this Project.')
    const records = this.records(sessionId).filter(record => key === undefined || record.key === key)
    const keys = new Set(records.map(record => record.key))
    return { schema: WORK_HELP, selected: this.store.workFocus(this.executor(sessionId)), records: records.map(record => ({
      ...record, authority: this.store.workAuthority(record.subject), history: history ? this.store.workHistory(record.key) : [],
    })), effects: this.store.workEffects().filter(effect => effect.stamps.some(stamp => keys.has(stamp.key))) }
  }

  private actorName(actor: WorkActor): string { return actor.kind === 'user' ? 'human' : actor.sessionId }

  reviewAnswer(sessionId: string, text: string, requestId: string): void {
    for (const record of this.records(sessionId, true)) {
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
      const change = workChangeSchema.parse(data)
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
        this.store.workEvent(work, this.actorName(actor), 'proposal', change)
        return { status: 'proposed', key: work, notice: 'Not applied, not acknowledged, and not an authorization.' }
      }
      const pauseOnly = !!prior && change.change === 'pause' && change.paused
        && JSON.stringify(change.definition) === JSON.stringify(prior.definition)
      if (!(pauseOnly && actor.kind === 'session' && actor.sessionId === authority.executor)) this.assertController({ subject: change.subject }, actor)
      if (actor.kind === 'session' && prior && !pauseOnly && (change.change === 'goal' || change.change === 'authorization' || prior.origin === 'human')) {
        throw new WorkConflict('Changing a confirmed goal or authorization requires human review. Use propose; a quoted input alone does not prove your interpretation.')
      }
      const record: WorkRecord = { key: work, subject: change.subject, revision: change.expectedRevision + 1,
        sequence: (prior?.sequence ?? 0) + 1, definition: change.definition,
        origin: pauseOnly ? prior!.origin : actor.kind === 'user' ? 'human' : 'agent_interpretation',
        changedBy: this.actorName(actor), changedAt: new Date().toISOString(),
        change: change.change, reason: change.reason, paused: change.paused,
        ...(prior?.handoffFrom ? { handoffFrom: prior.handoffFrom } : {}),
        ...(prior?.successors ? { successors: prior.successors } : {}) }
      this.store.saveWork(record, prior?.sequence ?? 0, this.actorName(actor), 'revision')
      // Publication errors are surfaced; the committed fence is never silently rolled back.
      await this.deps.changed(record)
      return record
    }
    if (!key) throw new WorkConflict('A work key is required.')
    let record = this.get(key)
    if (revision !== record.revision) throw new WorkConflict('Work revision changed; reload before acting.')
    const authority = this.store.workAuthority(record.subject)
    const name = this.actorName(actor)
    const save = (kind: string) => {
      const sequence = record.sequence
      record = { ...record, sequence: sequence + 1 }
      this.store.saveWork(record, sequence, name, kind)
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
      if (actor.kind === 'session') await this.deps.evidence(parseDecisionEvidence(request.evidence))
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
