import { randomUUID } from 'node:crypto'
import { toolEvidenceQuerySchema, type DecisionEvidence, type ToolEvidenceQuery } from '../sessions/decision-brief.ts'
import { YieldError, type YieldManager } from '../sessions/yield.ts'
import type { YieldQuestion } from '../sessions/yield-contract.ts'
import type { SessionTurnFact } from '../sessions/input.ts'
import type { WorkStamp } from '../initiatives/work-contract.ts'
import { appTestReportSchema, appWorkScopeSchema, microAppCapabilities, MicroAppError, type AppAcceptance, type AppRecord, type AppObservation, type AppTestReport, type AppWorkScope } from './contracts.ts'
import type { MicroAppStore } from './store.ts'

const CONTINUE = 'Continue runtime testing'
const PAUSE = 'Not now; I will test it myself'
export function appTestQuestion(record: AppRecord): YieldQuestion {
  return {
    question: `Let the author of "${record.manifest.name}" continue testing approved revision ${record.revision}? ` +
      'This uses agent calls and may use the app model allowance. No reply within 60 seconds continues testing. ' +
      'This does not approve new versions or additional device access.',
    options: [CONTINUE, PAUSE], defaultOption: CONTINUE,
  }
}
export interface AppAcceptanceHost {
  ownerSession: YieldManager['ownerSession']
  ask: YieldManager['askOwner']
  notify: (record: AppRecord, acceptance: AppAcceptance) => Promise<void>
  evidence: (source: DecisionEvidence) => Promise<void>
  resolveEvidence?: (sessionId: string, sources: ToolEvidenceQuery, signal: AbortSignal) => Promise<DecisionEvidence[]>
  work?: (sessionId: string, stamps: WorkStamp[]) => AppWorkScope[]
  blocker?: (record: AppRecord) => string | undefined
}

export class AppReportValidationError extends MicroAppError {}

type CheckCategory = AppTestReport['checks'][number]['category']
const observationRules: Record<CheckCategory, string> = {
  startup: 'Cite started and sdk_connected.',
  state: 'Cite state_saved and a later state_read with the same stateVersion on a different run.',
  reopen: 'Cite stopped and a later sdk_connected on a different run. A full Shadow restart is not required by this check.',
  recovery: 'Cite model_failed/model_cancelled then later model_completed, or backend_failed/backend_cancelled then later backend_completed.',
  business: 'Cite sdk_connected; prove the claimed behavior separately with recorded tool evidence.',
  device: 'Cite sdk_connected; prove authorized device behavior separately with recorded tool evidence.',
}

function matchingObservations(category: CheckCategory, observations: AppObservation[]): AppObservation[] | undefined {
  if (category === 'startup') {
    const started = observations.find(item => item.kind === 'started')
    const connected = observations.find(item => item.kind === 'sdk_connected')
    return started && connected ? [started, connected] : undefined
  }
  if (category === 'business' || category === 'device') {
    const connected = observations.find(item => item.kind === 'sdk_connected')
    return connected ? [connected] : undefined
  }
  for (const first of observations) for (const second of observations) {
    if (second.lastSequence <= first.firstSequence) continue
    const matches = category === 'state'
      ? first.kind === 'state_saved' && second.kind === 'state_read' && second.runId !== first.runId && second.stateVersion === first.stateVersion
      : category === 'reopen'
        ? first.kind === 'stopped' && second.kind === 'sdk_connected' && second.runId !== first.runId
        : /_(failed|cancelled)$/.test(first.kind) && second.kind === `${first.kind.split('_')[0]}_completed`
    if (matches) return [first, second]
  }
}

export class AppAcceptanceFlow {
  private pending = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private stopped = false
  constructor(private store: MicroAppStore, private host?: AppAcceptanceHost) {}
  get available() { return !!this.host }
  publicationWork(sessionId: string, stamps: WorkStamp[]) {
    return appWorkScopeSchema.array().max(20).parse(this.host?.work?.(sessionId, stamps) ?? [])
  }

  create(record: AppRecord): AppAcceptance | undefined {
    if (!this.host) return undefined
    return { id: randomUUID(), revision: record.revision, approvalAt: record.approval!.at, status: 'asking', sequence: 0, observations: [],
      ...(record.work?.length ? { work: structuredClone(record.work) } : {}) }
  }
  start(id: string) {
    if (!this.host || this.stopped || this.pending.has(id)) return
    const record = this.store.get(id), acceptance = record.acceptance
    if (!acceptance || acceptance.status !== 'asking') return
    const controller = new AbortController()
    const done = Promise.resolve().then(() => this.decide(record, acceptance.id, controller.signal)).catch(error => {
      const current = this.store.get(id)
      if (current.acceptance?.id !== acceptance.id || !current.approval) return
      const cancelled = current.acceptance.status === 'asking' && error instanceof Error && error.name === 'AbortError'
      current.acceptance.status = controller.signal.aborted ? 'interrupted' : cancelled ? 'paused' : 'failed'
      current.acceptance.error = controller.signal.aborted
        ? 'Testing confirmation was interrupted. Ask again in Apps; no timeout permission was restored.'
        : cancelled ? 'Testing confirmation was cancelled; the author was not resumed.'
        : 'Could not complete testing confirmation or notify the author. Inspect the author before retrying; delivery may be uncertain.'
      this.store.save(current)
      if (!controller.signal.aborted && !cancelled) console.error('[microapps] Acceptance handoff failed:', error instanceof Error ? error.name : 'Error')
    }).finally(() => { if (this.pending.get(id)?.controller === controller) this.pending.delete(id) })
    this.pending.set(id, { controller, done })
    // A persistence failure is observable in logs; it must not become an unhandled rejection.
    void done.catch(error => console.error('[microapps] Acceptance status persistence failed:', error instanceof Error ? error.name : 'Error'))
  }
  private current(id: string, acceptanceId: string) {
    const record = this.store.get(id)
    if (record.acceptance?.id !== acceptanceId || record.acceptance.revision !== record.revision ||
      record.approval?.revision !== record.revision || record.approval.at !== record.acceptance.approvalAt) {
      throw new MicroAppError('acceptance_changed', 'The exact app approval or testing request changed. Reload Apps.', 409)
    }
    return record
  }
  private async decide(record: AppRecord, acceptanceId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    record = this.current(record.id, acceptanceId)
    record.acceptance!.decisionSessionId = this.host!.ownerSession(record.createdBy)
    this.store.save(record)
    const outcome = await this.host!.ask(record.createdBy, appTestQuestion(record), signal, microAppCapabilities.acceptance.timeoutMs, request => {
      const current = this.current(record.id, acceptanceId)
      current.acceptance!.decisionRequestId = request.id
      this.store.save(current)
    })
    signal.throwIfAborted()
    record = this.current(record.id, acceptanceId)
    const acceptance = record.acceptance!
    if (outcome.option !== CONTINUE || outcome.custom || !['user', 'timeout'].includes(outcome.answeredBy ?? '') || outcome.revisedQuestion) {
      acceptance.status = 'paused'
      if (outcome.custom) acceptance.error = 'Custom response saved with the owner question. Testing is paused; this response did not grant continuation.'
      this.store.save(record)
      return
    }
    if (outcome.answeredBy !== 'user' && outcome.answeredBy !== 'timeout') throw new Error('Invalid testing decision authority')
    acceptance.decision = outcome.answeredBy
    acceptance.status = 'dispatching'
    this.store.save(record)
    await this.host!.notify(record, acceptance)
    signal.throwIfAborted()
    record = this.current(record.id, acceptanceId)
    // The author may have already opened the app or saved its report during admission.
    if (record.acceptance!.status === 'dispatching') {
      record.acceptance!.status = 'notified'
      this.store.save(record)
    }
  }
  async cancel(id: string) {
    const pending = this.pending.get(id)
    if (pending) {
      pending.controller.abort()
      const record = this.store.get(id)
      if (record.acceptance && ['asking', 'dispatching'].includes(record.acceptance.status)) {
        record.acceptance.status = 'interrupted'
        this.store.save(record)
      }
      await pending.done
    }
  }
  async retry(id: string, revision: string) {
    if (!this.host || this.stopped) throw new MicroAppError('acceptance_unavailable', 'Author testing is unavailable', 409)
    const record = this.store.get(id)
    if (record.revision !== revision || record.approval?.revision !== revision) throw new MicroAppError('approval_required', 'Review the current revision first', 403)
    if (this.pending.has(id) || ['asking', 'dispatching', 'notified', 'running', 'testing'].includes(record.acceptance?.status ?? '')) {
      throw new MicroAppError('acceptance_busy', 'An author testing request is already active', 409)
    }
    record.acceptance = this.create(record)
    this.store.save(record)
    this.start(id)
  }
  authorize(id: string, revision: string, sessionId: string) {
    const record = this.store.get(id), acceptance = record.acceptance
    if (this.stopped || record.createdBy !== sessionId) throw new MicroAppError('not_app_author', 'Only the original author session can test this app', 403)
    if (!acceptance || record.revision !== revision) throw new MicroAppError('acceptance_required', 'The owner must review this revision and choose runtime testing in Apps', 403)
    this.current(id, acceptance.id)
    if (!acceptance.decision || !['dispatching', 'notified', 'running', 'testing'].includes(acceptance.status)) {
      throw new MicroAppError('acceptance_required', `Author testing is ${acceptance.status}; a timeout cannot replace version approval`, 403)
    }
    return acceptance.id
  }
  observe(id: string, acceptanceId: string | undefined, runId: string, kind: AppObservation['kind'], stateVersion?: number) {
    const record = this.store.get(id), acceptance = record.acceptance
    if (!acceptanceId || acceptance?.id !== acceptanceId) return
    if (kind === 'started' && ['dispatching', 'notified', 'running'].includes(acceptance.status)) acceptance.status = 'testing'
    const at = new Date().toISOString()
    const sequence = ++acceptance.sequence
    const previous = acceptance.observations.find(item => item.runId === runId && item.kind === kind && item.stateVersion === stateVersion)
    if (previous) { previous.lastAt = at; previous.lastSequence = sequence; previous.count++ }
    else if (acceptance.observations.length < 128) acceptance.observations.push({
      id: randomUUID(), runId, kind, firstAt: at, lastAt: at, count: 1, firstSequence: sequence, lastSequence: sequence,
      ...(stateVersion === undefined ? {} : { stateVersion }),
    })
    else acceptance.observationsTruncated = true
    this.store.save(record)
  }
  authorTurn(fact: Pick<SessionTurnFact, 'sessionId' | 'inputId' | 'turnId' | 'source' | 'error'>, finished?: SessionTurnFact['status']) {
    if (this.stopped || fact.source.kind !== 'event' || fact.source.type !== 'microapp.testing.ready' || fact.source.source !== 'system') return
    const record = this.store.list().find(record => record.createdBy === fact.sessionId &&
      record.acceptance?.id === (fact.source.kind === 'event' ? fact.source.eventId : undefined) &&
      fact.inputId === `microapp-test:${record.acceptance?.id}`)
    if (!record?.acceptance || record.approval?.revision !== record.revision) return
    const acceptance = record.acceptance
    if (!acceptance.decision || !['dispatching', 'notified', 'running', 'testing', 'reported'].includes(acceptance.status)) return
    if (acceptance.authorTurn && acceptance.authorTurn.id !== fact.turnId) return
    const at = new Date().toISOString()
    acceptance.authorTurn ??= { id: fact.turnId, startedAt: at }
    if (finished) {
      acceptance.authorTurn.finishedAt = at
      acceptance.authorTurn.outcome = finished
      if (acceptance.status !== 'reported') {
        const blocker = finished === 'completed' ? this.host?.blocker?.(record) : undefined
        acceptance.status = finished === 'cancelled' ? 'interrupted' : finished === 'failed' ? 'failed' : blocker ? 'blocked' : 'incomplete'
        acceptance.error = (finished === 'failed' && fact.error ? `Author testing failed: ${fact.error}` :
          blocker ? `Author testing is blocked: ${blocker}` :
          `The author turn ${finished} without an acceptance report. Inspect its conversation and any running app before asking again.`).slice(0, 1000)
      }
    } else if (['dispatching', 'notified'].includes(acceptance.status)) acceptance.status = 'running'
    this.store.save(record)
  }
  async evidence(id: string, revision: string, sessionId: string, sources: ToolEvidenceQuery, signal: AbortSignal) {
    signal.throwIfAborted()
    const acceptanceId = this.authorize(id, revision, sessionId)
    if (!this.host?.resolveEvidence) throw new MicroAppError('evidence_unavailable', 'Canonical tool evidence lookup is unavailable', 409)
    const evidence = await this.host.resolveEvidence(sessionId, toolEvidenceQuerySchema.parse(sources), signal)
    signal.throwIfAborted()
    if (this.authorize(id, revision, sessionId) !== acceptanceId) throw new MicroAppError('acceptance_changed', 'Testing request changed while resolving evidence', 409)
    return { acceptanceId, revision, evidence }
  }
  async report(id: string, revision: string, sessionId: string, value: unknown, signal: AbortSignal) {
    let prepared: Awaited<ReturnType<AppAcceptanceFlow['validateReport']>>
    try {
      prepared = await this.validateReport(id, revision, sessionId, value, signal)
      signal.throwIfAborted()
      if (this.authorize(id, revision, sessionId) !== prepared.record.acceptance!.id) {
        throw new MicroAppError('acceptance_changed', 'Testing request changed while preparing the report', 409)
      }
      prepared.record = this.current(id, prepared.record.acceptance!.id)
    }
    catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof Error)) throw error
      const rejected = new AppReportValidationError(error instanceof MicroAppError ? error.code : 'invalid_report',
        error.message, error instanceof MicroAppError ? error.status : 400)
      rejected.cause = error
      throw rejected
    }
    const { record, report } = prepared
    record.acceptance!.report = { at: new Date().toISOString(), sessionId, result: report }
    record.acceptance!.status = 'reported'
    this.store.save(record)
    return record.acceptance
  }
  private async validateReport(id: string, revision: string, sessionId: string, value: unknown, signal: AbortSignal) {
    const acceptanceId = this.authorize(id, revision, sessionId)
    const report = appTestReportSchema.parse(value)
    const acceptance = this.store.get(id).acceptance!
    const expected = (acceptance.work ?? []).flatMap(work => work.acceptance.map((_text, criterion) =>
      JSON.stringify([work.key, work.revision, criterion])))
    const supplied = (report.requirements ?? []).map(item => JSON.stringify([item.workKey, item.workRevision, item.criterion]))
    if (expected.length !== supplied.length || new Set(supplied).size !== supplied.length || supplied.some(key => !expected.includes(key))) {
      throw new MicroAppError('requirement_coverage', 'Report every published Work acceptance criterion exactly once using workKey, workRevision and zero-based criterion. Use blocked/not_tested when unavailable; do not invent a pass.')
    }
    const observations = acceptance.observations
    const checks = [
      ...report.checks.map((check, index) => ({ ...check, path: `checks[${index}]` })),
      ...(report.requirements ?? []).map((check, index) => ({ ...check, category: 'business' as const, path: `requirements[${index}]` })),
    ]
    const issues: Array<{
      path: string; category: CheckCategory; code: 'unknown_observation' | 'insufficient_observations'
      unknownObservationIds?: string[]; required?: string
      candidateObservationIds?: string[]; missingCitationIds?: string[]; observationsTruncated?: boolean
    }> = []
    for (const check of checks) {
      const unknown = check.observations.filter(id => !observations.some(item => item.id === id))
      if (unknown.length) issues.push({ path: check.path, category: check.category, code: 'unknown_observation', unknownObservationIds: unknown })
      const cited = observations.filter(item => check.observations.includes(item.id))
      if (check.result === 'passed' && check.basis === 'runtime') {
        if (!matchingObservations(check.category, cited)) {
          const candidates = matchingObservations(check.category, observations)?.map(item => item.id) ?? []
          issues.push({ path: check.path, category: check.category, code: 'insufficient_observations',
            required: observationRules[check.category], candidateObservationIds: candidates,
            missingCitationIds: candidates.filter(id => !check.observations.includes(id)),
            ...(acceptance.observationsTruncated ? { observationsTruncated: true } : {}),
          })
        }
      }
    }
    if (issues.length) throw new MicroAppError(issues[0].code,
      'Report not saved. Fix all listed observation citations using this exact testing request; other evidence has not yet been validated. ' +
      'Candidate IDs establish host lifecycle only, not business success: read get.acceptance and cite them only if they support the stated check. ' +
      'Keep unrelated supported results and their tool evidence; do not downgrade the whole report for a missing citation. ' +
      'An empty candidate list means the retained observations cannot establish that check; exercise it within existing permission or mark only that item blocked/not_tested.\n' +
      JSON.stringify({ acceptanceId, revision, issues, detail: { action: 'get', id } }))
    for (const check of checks) {
      for (const [index, source] of check.evidence.entries()) {
        const path = `${check.path}.evidence[${index}]`
        signal.throwIfAborted()
        if (source.sessionId !== sessionId) throw new MicroAppError('foreign_evidence', `${path}: Use tool results recorded by this author session`, 403)
        if (!this.host) throw new MicroAppError('acceptance_unavailable', 'Evidence validation is unavailable', 409)
        try { await this.host.evidence(source) }
        catch (error) {
          signal.throwIfAborted()
          if (!(error instanceof YieldError) || !['not_found', 'invalid_request'].includes(error.code)) throw error
          throw new MicroAppError('invalid_evidence', `${path}: ${error.message} ` +
            'Do not construct physicalId from a session ID. Resolve this recorded tool ID and exact excerpt, then copy the returned evidence reference:\n' +
            JSON.stringify({ action: 'evidence', id, revision, sources: [{ id: source.id, quote: source.quote }] }))
        }
      }
    }
    signal.throwIfAborted()
    if (this.authorize(id, revision, sessionId) !== acceptanceId) throw new MicroAppError('acceptance_changed', 'Testing request changed while checking evidence', 409)
    const record = this.current(id, acceptanceId)
    return { record, report }
  }
  async shutdown() {
    this.stopped = true
    await Promise.all([...this.pending.keys()].map(id => this.cancel(id)))
  }
}
