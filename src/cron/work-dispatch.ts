import { isDeepStrictEqual } from 'node:util'
import type { WorkKickoff } from '../initiatives/work-kickoff.ts'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { automaticWorkEligible, workDependenciesSatisfied, type InitiativeStore } from '../initiatives/store.ts'
import { WorkConflict, type WorkRecord } from '../initiatives/work-contract.ts'
import { LOCAL_NODE_ID, localFolderWorkdirRef, type WorkdirRefV2 } from '../sessions/locality.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionTurnFact, SessionInput, DeliveryReceipt } from '../sessions/input.ts'
import type { CronJob } from './service.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema, AUTOMATIC_WORK_GUIDANCE, AUTOMATIC_WORK_BOOTSTRAP_GUIDANCE, type WorkDispatchConfig, workDispatchSelectionSchema, type WorkDispatchSelection } from './work-dispatch-contract.ts'

export interface WorkDispatcherDeps {
  projectId: string
  store: InitiativeStore
  sessions: Pick<SessionManager, 'getSessionState' | 'isSessionBusy' | 'setAutomaticWorkAdmission' | 'buildSession' | 'validateAutomaticWorkTarget' | 'wakeAutomaticWorkKickoffs' | 'deliver' | 'inputs' | 'yields' | 'isWaitingForCall' | 'isWaitingForExternalExecution' | 'getSessionRecovery' | 'resumeSession' | 'bindAutomaticWorkWorkspace' | 'prepareAutomaticWorkWorkspace'>
  validateProgram?(config: WorkDispatchConfig, signal: AbortSignal): Promise<void>
  validateTarget(config: WorkDispatchConfig, signal: AbortSignal): Promise<void>
  nodeForTarget?(config: WorkDispatchConfig): string
  capacityPolicy?(): Pick<WorkDispatchConfig, 'maxConcurrent' | 'maxConcurrentPerDevice'> | undefined
  targets?(): Array<{ folderId: string; name: string; nodeId: string; platform?: NodeJS.Platform; supported: boolean; reason?: string }>
  prepare(config: WorkDispatchConfig, sessionId: string, signal: AbortSignal): Promise<{ folderId: string; path: string; branch: string; workdir?: WorkdirRefV2 }>
  verify(config: WorkDispatchConfig, sessionId: string, execution: NonNullable<WorkRecord['automaticExecution']>, signal: AbortSignal): Promise<void>
  changed(record: WorkRecord, previous: WorkRecord): Promise<void>
  workerInstructions?(): Promise<string>
}

/** Reliable admission and recovery; scheduling intelligence runs in a normal fresh Cron session. */
export class WorkDispatcher {
  private scanning?: Promise<void>
  private runner?: (job: CronJob, signal: AbortSignal) => Promise<void>

  setRunner(runner: (job: CronJob, signal: AbortSignal) => Promise<void>): void { this.runner = runner }

  private occupies(record: WorkRecord): boolean {
    return this.owned(record) && (this.busy(record.assignee!) || !['done', 'cancelled'].includes(record.status)
      && (record.automaticExecution!.stage === 'claimed' || record.status !== 'blocked'))
  }
  private capacity(config: WorkDispatchConfig, excluding?: string, draining = false) {
    // Claims reserve capacity. At drain, idle inbox entries must not deadlock
    // each other if the live capacity policy shrank since acceptance.
    const pending = draining ? new Set(this.deps.store.pendingWorkKickoffs().map(entry => entry.input.id)) : undefined
    const active = this.deps.store.workRecords().filter(record => record.key !== excluding && this.occupies(record)
      && (!pending?.has(record.automaticExecution!.inputId) || this.busy(record.assignee!)))
    const nodeId = this.deps.nodeForTarget?.(config) ?? LOCAL_NODE_ID
    const onDevice = active.filter(record => {
      const state = this.deps.sessions.getSessionState(record.assignee!)
      return (state?.automaticWork?.prepared?.nodeId ?? state?.workdir?.nodeId ?? LOCAL_NODE_ID) === nodeId
    }).length
    // Recovery retains the worker's budgets/model/source, not a stale Project capacity.
    const policy = this.deps.capacityPolicy?.() ?? config
    return { nodeId, active: active.length, onDevice, maxConcurrent: policy.maxConcurrent, maxConcurrentPerDevice: policy.maxConcurrentPerDevice,
      available: active.length < policy.maxConcurrent && onDevice < policy.maxConcurrentPerDevice }
  }

  snapshot(config: WorkDispatchConfig, offset = 0, limit = 50) {
    const records = this.deps.store.workRecords()
    return { capacity: this.capacity(config), targets: this.deps.targets?.().map(target => {
      const capacity = this.capacity({ ...config, folderId: target.folderId })
      return { ...target, capacity: { ...capacity, available: target.supported && capacity.available } }
    }) ?? [], total: records.length,
      next: offset + limit < records.length ? offset + limit : undefined,
      records: records.slice(offset, offset + limit).map(record => {
        const owner = record.assignee ? this.deps.sessions.getSessionState(record.assignee) : undefined
        // Keep the definition and notes, not mirrored intake or observations.
        const { botSource: _bot, observation: _observation, ...current } = record
        return { ...current, detailsPath: `v:works/keys/${encodeURIComponent(record.key)}`,
          eligible: automaticWorkEligible(record, records), needsReview: this.needsReview(record),
          ownerState: record.assignee ? { available: !!owner, executionStatus: owner?.executionStatus,
            busy: this.busy(record.assignee), waiting: this.waiting(record.assignee) } : undefined,
          dependencies: record.dependencies.map(key => ({ key, status: records.find(item => item.key === key)?.status ?? 'missing' })) }
      }) }
  }

  /** Stopped blocked owners need coordinator reconciliation, never replacement admission.
   * Pending input/external waits and live executions are not stalled work.
   */
  private needsReview(record: WorkRecord): boolean {
    return !!record.assignee && !!record.manager && record.status === 'blocked'
      && !this.busy(record.assignee)
      && this.reviewAncestorsPermit(record)
  }

  private reviewAncestorsPermit(record: WorkRecord): boolean {
    const records = this.deps.store.workRecords(), seen = new Set<string>()
    let current: WorkRecord | undefined = record
    while (current) {
      if (seen.has(current.key)
        || ['done', 'cancelled'].includes(current.status ?? '')) return false
      seen.add(current.key)
      const parent: string | undefined = current.parentKey
      if (!parent) return true
      current = records.find(item => item.key === parent)
      if (!current) return false
    }
    return true
  }

  /** Read-only validation used immediately before a narrow coordinator notification. */
  reviewTarget(key: string, version: number): { record: WorkRecord; recipient: string } {
    const record = this.current(key), records = this.deps.store.workRecords()
    if (!record || record.sequence !== version) throw new WorkConflict('Work changed; read the current sequence before requesting review.')
    if (!automaticWorkEligible(record, records) && !this.needsReview(record)) throw new WorkConflict('Work is not eligible for dispatch or stopped-owner review.')
    const recipient = record.manager
    const manager = recipient ? this.deps.sessions.getSessionState(recipient) : undefined
    if (!recipient || !manager || manager.mode !== 'session' || manager.projectId !== this.deps.projectId) {
      throw new WorkConflict('An available durable coordinator in this Project is required; no arbitrary recipient fallback.')
    }
    return { record, recipient }
  }
  private admission: Promise<unknown> = Promise.resolve()
  private readonly admissionContext = new AsyncLocalStorage<{ active: boolean; signal?: AbortSignal }>()
  private exclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = () => this.admissionContext.run({ active: true, signal }, async () => {
      const token = this.admissionContext.getStore()!
      try { return await operation() } finally { token.active = false }
    })
    const pending = this.admission.then(run, run)
    this.admission = pending.catch(() => {})
    return pending
  }
  constructor(private readonly deps: WorkDispatcherDeps) {
    deps.sessions.setAutomaticWorkAdmission((id, input, admit) => this.admit(id, input, admit), async (kickoff, inspectReason) => {
      const record = this.current(kickoff.key)
      if (!record || !this.owned(record) || record.assignee !== kickoff.target || record.assignmentRevision !== kickoff.revision
        || record.automaticExecution!.inputId !== kickoff.input.id || record.automaticExecution!.stage !== 'claimed') return
      await this.block(record.key, inspectReason ?? 'Automatic kickoff was recorded but its turn was interrupted or not confirmed. Inspect history before explicit recovery; no tools were replayed.')
    })
  }

  private assertBoundaries(record: WorkRecord): void {
    const records = this.deps.store.workRecords(), byKey = new Map(records.map(item => [item.key, item]))
    const seen = new Set<string>()
    let current: WorkRecord | undefined = record
    while (current) {
      if (seen.has(current.key) || ['done', 'cancelled'].includes(current.status ?? '')
        || !workDependenciesSatisfied(current, records)) throw new WorkConflict('Work dependency or ancestor boundary prevents automatic admission.')
      seen.add(current.key)
      const parent: string | undefined = current.parentKey
      if (parent && !byKey.has(parent)) throw new WorkConflict('Work ancestor is unavailable.')
      current = parent ? byKey.get(parent) : undefined
    }
  }

  private assertInitialEligibility(record: WorkRecord): void {
    // The claim already owns an assignee; reconsider all other scheduling gates.
    const candidate = { ...record, assignee: null }
    if (!automaticWorkEligible(candidate, this.deps.store.workRecords())) {
      throw new WorkConflict('Automatic first-admission eligibility changed; check dependencies and ancestors, and retain the claimed owner for coordinator review.')
    }
  }

  private async admit(sessionId: string, input: SessionInput, admit: (beforeDispatch?: () => void, verifyKickoff?: (signal: AbortSignal) => Promise<void>) => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> {
    if (input.kind === 'control' && input.command.type === 'cancel') return admit()
    const run = async () => {
      const signal = this.admissionContext.getStore()?.signal ?? new AbortController().signal
      signal.throwIfAborted()
      const state = this.deps.sessions.getSessionState(sessionId)
      const record = state?.automaticWork && this.current(state.automaticWork.key)
      if (!record || !this.owned(record) || record.assignee !== sessionId
        || ['done', 'cancelled'].includes(record.status)) throw new WorkConflict('Automatic Work is no longer admissible.')
      const execution = record.automaticExecution!
      const kickoff = input.id === execution.inputId
      const inbox = this.deps.store.workKickoff(execution.inputId)
      if (inbox?.state === 'inspect') throw new WorkConflict('Automatic kickoff requires inspection; this assignment cannot be replayed or resumed.')
      if (!kickoff && inbox?.state === 'pending') {
        throw new WorkConflict('Automatic kickoff is still pending; other turns cannot overtake the accepted input.')
      }
      const prepared = structuredClone({ folderId: state!.folderId, workdir: state!.workdir, work: state!.automaticWork })
      const check = () => {
        signal.throwIfAborted()
        const latest = this.current(record.key)
        if (!latest || !this.owned(latest) || latest.assignee !== sessionId
          || ['done', 'cancelled'].includes(latest.status)) throw new WorkConflict('Automatic Work is no longer admissible.')
        this.assertBoundaries(latest)
        if (kickoff) {
          const target = this.deps.sessions.getSessionState(sessionId)
          const currentExecution = latest.automaticExecution!
          if (currentExecution.inputId !== input.id || currentExecution.folderId !== execution.folderId
            || currentExecution.path !== execution.path || currentExecution.branch !== execution.branch
            || !target || target.sessionId !== sessionId || target.projectId !== this.deps.projectId
            || !isDeepStrictEqual({ folderId: target.folderId, workdir: target.workdir, work: target.automaticWork }, prepared)) {
            throw new WorkConflict('Automatic kickoff identity or isolated Workspace changed.')
          }
          this.assertInitialEligibility(latest)
        }
        if (!this.capacity(state!.automaticWork!.limits, record.key, kickoff).available) throw new WorkConflict('Project or device automatic execution capacity is occupied.')
      }
      const verify = async (turnSignal: AbortSignal) => {
        const activeSignal = AbortSignal.any([signal, turnSignal])
        activeSignal.throwIfAborted()
        check()
        if (prepared.work!.phase !== 'bootstrap') {
          const latest = this.current(record.key)!
          await this.deps.verify(prepared.work!.limits, sessionId, latest.automaticExecution!, activeSignal)
        }
        activeSignal.throwIfAborted()
        check()
      }
      if (kickoff) {
        check() // The queue re-verifies actual isolation before append and first inference.
        return admit(check, verify)
      }
      await verify(signal)
      return admit(check) // Recheck after async Session preparation, immediately before dispatch().
    }
    // Inbox wakes are never a nested operation, even if a Session timer
    // inherited an active AsyncLocalStorage admission token.
    return !input.id.startsWith('work-start:') && this.admissionContext.getStore()?.active ? run() : this.exclusive(run)
  }

  private current(key: string) { return this.deps.store.workRecords().find(record => record.key === key) }
  private owned(record: WorkRecord) {
    const execution = record.automaticExecution
    return !!execution && execution.jobId === WORK_DISPATCH_ID && record.assignee === execution.sessionId
      && record.assignmentRevision === execution.assignmentRevision
  }
  private waiting(id: string) {
    return !!this.deps.sessions.inputs.get(id) || !!this.deps.sessions.yields.get(id) || this.deps.sessions.isWaitingForCall(id)
      || this.deps.sessions.isWaitingForExternalExecution(id)
  }
  private busy(id: string) {
    return this.deps.sessions.isSessionBusy(id) || this.waiting(id)
  }
  private async save(previous: WorkRecord, patch: Partial<WorkRecord>, kind: string) {
    const record = { ...previous, ...patch, sequence: previous.sequence + 1, changedAt: new Date().toISOString() }
    this.deps.store.saveWork(record, previous.sequence, previous.assignee!, kind)
    await this.deps.changed(record, previous)
    return record
  }

  /** A host failure is never proof of done, release, cancellation or rollback. */
  async block(key: string, reason: string): Promise<void> {
    const record = this.current(key)
    if (!record || !this.owned(record) || ['done', 'cancelled'].includes(record.status)
      || record.automaticExecution!.stage === 'blocked' || this.waiting(record.assignee!)) return
    const execution = record.automaticExecution!
    const detail = `${record.status === 'blocked' ? `Existing blocker: ${record.blockedReason?.slice(0, 400)}. Host execution: ` : ''}${reason.slice(0, 950)} Responsibility and artifacts are retained. Inspect Work, session history and branch ${execution.branch?.slice(0, 160) ?? '(not prepared)'}. Ask the publisher for specific missing input or authority, or use explicit recovery.`.slice(0, 2000)
    const publisher = record.manager ?? record.botSource?.sessionId
    const help = publisher && publisher !== execution.sessionId
      ? { id: `work-blocked:${record.key}:${record.sequence + 1}`, recipient: publisher, attempts: 0, delivered: false } : undefined
    await this.save(record, { status: 'blocked', blockedReason: detail,
      automaticExecution: { ...execution, stage: 'blocked', lastError: detail, help } }, 'automatic_blocked')
    await this.deliverHelp(record.key)
  }

  private readonly notifying = new Set<string>()
  /** Persisted bounded help receipt; retries never replay the executor's tool operations. */
  private async deliverHelp(key: string): Promise<void> {
    if (this.notifying.has(key)) return
    let record = this.current(key)
    const help = record?.automaticExecution?.help
    if (!record || !this.owned(record) || record.status !== 'blocked' || !help || help.delivered || help.attempts >= 3) return
    this.notifying.add(key)
    try {
      record = await this.save(record, { automaticExecution: { ...record.automaticExecution!, help: { ...help, attempts: help.attempts + 1 } } }, 'automatic_help_attempt')
      let error: unknown
      try {
        if (!this.deps.sessions.getSessionState(help.recipient)) throw new Error('Publisher session is unavailable in this Project')
        const receipt = await this.deps.sessions.deliver(help.recipient, { id: help.id, kind: 'message', timestamp: new Date().toISOString(), policy: 'queue',
          source: { kind: 'event', eventId: help.id, type: 'work-blocked', source: 'work-dispatch' },
          content: `Assigned Work ${record.key} needs publisher help: ${record.blockedReason}\nRead its retained notes and history. Notification ${help.id} may be retried after interruption; do not duplicate actions. It is not authorization to change scope or repeat external actions.` })
        if (receipt.status !== 'accepted' || receipt.disposition === 'filtered' || receipt.inputId !== help.id || receipt.sessionId !== help.recipient) throw new Error('Publisher help admission was unconfirmed')
      } catch (failure) { error = failure }
      const current = this.current(key)
      if (current && this.owned(current) && current.automaticExecution!.help?.id === help.id) {
        await this.save(current, { automaticExecution: { ...current.automaticExecution!, help: { ...current.automaticExecution!.help!,
          delivered: !error, lastError: error ? String(error).slice(0, 2000) : undefined } } }, error ? 'automatic_help_failed' : 'automatic_help_accepted')
      }
    } finally { this.notifying.delete(key) }
  }

  /** Startup does not replay an unconfirmed admission or interrupted tool effects. */
  async recover(): Promise<void> {
    for (let record of this.deps.store.workRecords()) {
      if (!this.owned(record)) continue
      await this.deliverHelp(record.key)
      record = this.current(record.key)!
      if (!this.owned(record) || this.busy(record.assignee!)) continue
      if (['done', 'cancelled'].includes(record.status)) {
        if (record.automaticExecution!.stage !== 'settled') await this.save(record,
          { automaticExecution: { ...record.automaticExecution!, stage: 'settled' } }, 'automatic_settled')
        continue
      }
      if (record.status === 'blocked' && this.deps.sessions.getSessionState(record.assignee!)?.executionStatus === 'completed') continue
      const execution = record.automaticExecution!
      const inbox = this.deps.store.workKickoff(execution.inputId)
      if (inbox?.state === 'pending') continue
      if (inbox?.state === 'inspect') {
        await this.block(record.key, inbox.inspectReason ?? 'Automatic kickoff requires inspection; no replay is permitted.')
        continue
      }
      if (['claimed', 'delivering', 'running'].includes(execution.stage)) {
        await this.block(record.key, 'Automatic execution interrupted or admission unconfirmed after restart; no write replay was attempted.')
      }
    }
  }

  async finished(fact: SessionTurnFact): Promise<void> {
    for (const record of this.deps.store.workRecords().filter(record => this.owned(record) && record.assignee === fact.sessionId)) {
      if (this.waiting(fact.sessionId) || fact.inputId.startsWith('work-start:') && fact.inputId !== record.automaticExecution!.inputId) continue
      if (record.status === 'blocked' && fact.status === 'completed') {
        if (record.automaticExecution!.stage !== 'blocked') await this.save(record,
          { automaticExecution: { ...record.automaticExecution!, stage: 'blocked' } }, 'automatic_blocker_reported')
        continue
      }
      await this.block(record.key, fact.status === 'completed'
        ? 'Executor ended without recording a delivered result or an explicit blocker.'
        : `Executor ${fact.status}: ${(fact.error ?? 'interrupted; inspect retained history').slice(0, 800)}. Host/provider retries, if applicable, are exhausted.`)
    }
  }

  dispatch(job: CronJob, signal: AbortSignal): Promise<void> {
    if (this.scanning) return this.scanning
    const pending = this.round(job, signal)
    this.scanning = pending
    const clear = () => { if (this.scanning === pending) this.scanning = undefined }
    void pending.then(clear, clear)
    return pending
  }

  private async round(job: CronJob, signal: AbortSignal): Promise<void> {
    if (job.id !== WORK_DISPATCH_ID) throw new Error('Unknown Work dispatcher')
    const config = workDispatchConfigSchema.parse(job.program)
    const ready = await this.exclusive(async () => {
      await (this.deps.validateProgram ?? this.deps.validateTarget)(config, signal)
      await this.recover()
      const records = this.deps.store.workRecords()
      // A full default device must not prevent considering another supported device,
      // but all-full/unsupported inventories do not spend a fresh inference every tick.
      const targets = this.deps.targets?.()
      const hasCapacity = targets?.length ? targets.some(target => target.supported && this.capacity({ ...config, folderId: target.folderId }).available) : this.capacity(config).available
      return hasCapacity && records.some(record => automaticWorkEligible(record, records))
        || records.some(record => this.needsReview(record))
    }, signal)
    if (!ready) return // no session and no inference when idle
    signal.throwIfAborted()
    if (!this.runner) throw new Error('Work dispatcher fresh-session runner is unavailable')
    // Do NOT hold admission while the model runs: its dispatch tool uses that same lock.
    await this.runner(job, signal)
  }

  async dispatchWork(job: CronJob, key: string, version: number, selection: WorkDispatchSelection, signal: AbortSignal,
    assertGrant?: () => void): Promise<WorkRecord> {
    const claimed = await this.exclusive(() => this.claim(job, key, version, selection, signal, assertGrant), signal)
    this.deps.sessions.wakeAutomaticWorkKickoffs()
    // Work and the inbox already committed. Notification failure cannot undo acceptance.
    try { await this.deps.changed(claimed.record, claimed.previous) }
    catch (error) { console.warn(`[work-dispatch] Accepted ${key}; change notification deferred: ${String(error)}`) }
    return claimed.record
  }

  private async claim(job: CronJob, key: string, version: number, selection: WorkDispatchSelection, signal: AbortSignal,
    assertGrant?: () => void): Promise<{ record: WorkRecord; previous: WorkRecord }> {
    if (job.id !== WORK_DISPATCH_ID) throw new Error('Unknown Work dispatcher')
    const config = workDispatchConfigSchema.parse({ ...workDispatchConfigSchema.parse(job.program), ...workDispatchSelectionSchema.parse(selection) })
    signal.throwIfAborted()
    await (config.folderId ? this.deps.validateTarget : this.deps.validateProgram ?? this.deps.validateTarget)(config, signal)
    const records = this.deps.store.workRecords()
    const candidate = records.find(record => record.key === key)
    if (!candidate || candidate.sequence !== version || !automaticWorkEligible(candidate, records)) throw new WorkConflict('Work changed or is not eligible; dependencies and ancestor boundaries must be satisfied.')
    if (!this.capacity(config).available) throw new WorkConflict('Project or device automatic execution capacity is occupied.')
    signal.throwIfAborted()
    const assignmentRevision = candidate.assignmentRevision + 1
    const token = createHash('sha256').update(`${this.deps.projectId}\0${candidate.key}\0${assignmentRevision}`).digest('hex').slice(0, 40)
    const sessionId = `work-executor:${token}`
    const prepared = config.folderId ? await this.deps.prepare(config, sessionId, signal) : undefined
    if (config.folderId && (!prepared || prepared.folderId === config.folderId)) throw new WorkConflict('Isolation preparation did not return a separate Workspace.')
    const workdir = prepared ? prepared.workdir ?? localFolderWorkdirRef(prepared.folderId) : undefined
    signal.throwIfAborted()
    if (!this.deps.sessions.getSessionState(sessionId)) {
      // Only the dispatcher round is an automation run. Its Work executor is an
      // ordinary root conversation; automaticWork retains host admission/budgets.
      await this.deps.sessions.buildSession(sessionId, undefined, { mode: 'session', agentType: 'general',
        config: { ...(config.model ? { model: config.model } : {}), ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) },
        folderId: prepared?.folderId, workdir, automaticWork: { key: candidate.key, jobId: WORK_DISPATCH_ID, limits: config, ...(!config.folderId ? { phase: 'bootstrap' as const } : {}) },
      })
    }
    const checkTarget = () => {
      const target = this.deps.sessions.getSessionState(sessionId)
      if (!target || target.sessionId !== sessionId || target.projectId !== this.deps.projectId || target.mode !== 'session'
        || target.automaticWork?.key !== candidate.key || target.automaticWork.jobId !== WORK_DISPATCH_ID
        || !isDeepStrictEqual(target.automaticWork.limits, config) || target.automaticWork.prepared
        || config.model && target.config?.model !== config.model || config.reasoningEffort && target.config?.reasoningEffort !== config.reasoningEffort
        || target.folderId !== prepared?.folderId || (workdir ? target.workdir?.nodeId !== workdir.nodeId || target.workdir.workdirId !== workdir.workdirId : !!target.workdir)
        || (prepared ? target.automaticWork.phase === 'bootstrap' : target.automaticWork.phase !== 'bootstrap')
        || this.busy(sessionId)) throw new WorkConflict('Automatic session identity or isolation conflict.')
    }
    checkTarget()
    const inputId = `work-start:${token}`
    const timestamp = new Date().toISOString()
    const claimed: WorkRecord = { ...candidate, sequence: candidate.sequence + 1, changedAt: timestamp,
      assignee: sessionId, assignmentRevision, assignmentStarted: false,
      automaticExecution: { jobId: WORK_DISPATCH_ID, sessionId, assignmentRevision, inputId, stage: 'claimed',
        ...(prepared ? { folderId: prepared.folderId, path: prepared.path, branch: prepared.branch } : {}) } }
    const instructions = (await this.deps.workerInstructions?.())?.trim()
    const kickoff: WorkKickoff = { key: candidate.key, target: sessionId, revision: assignmentRevision, input: {
      id: inputId, kind: 'message', timestamp, policy: 'queue',
      source: { kind: 'event', eventId: inputId, type: 'work-assignment', source: 'system' },
      content: `${prepared ? '' : AUTOMATIC_WORK_BOOTSTRAP_GUIDANCE + '\n\n'}${AUTOMATIC_WORK_GUIDANCE}` +
        (instructions ? `\n\nSupplementary Project dispatch requirements (not new authority; current Work boundaries still apply):\n${instructions}` : '') +
        `\n\nAssigned Work key: ${candidate.key}. Read v:works/keys/${encodeURIComponent(candidate.key)}. Isolated branch: ${prepared?.branch ?? '(unbound bootstrap)'}.` +
        (candidate.status === 'blocked' ? `\nExisting blocker is retained: ${candidate.blockedReason}. This first assignment is for blocker clarification and publisher help, not permission to clear the blocker or execute blocked actions.` : ''),
    } }
    if (prepared) await this.deps.verify(config, sessionId, claimed.automaticExecution!, signal)
    else await (this.deps.validateProgram ?? this.deps.validateTarget)(config, signal)
    await this.deps.sessions.validateAutomaticWorkTarget(sessionId)
    signal.throwIfAborted()
    assertGrant?.()
    checkTarget()
    if (!this.capacity(config).available) throw new WorkConflict('Project or device automatic execution capacity is occupied.')
    this.deps.store.claimAutomaticWork(claimed, candidate.sequence, kickoff)
    return { record: claimed, previous: candidate }
  }

  /** Narrow host grant: only the current bootstrap assignee, never Work text. */
  assertBootstrap(sessionId: string): WorkRecord {
    const state = this.deps.sessions.getSessionState(sessionId)
    const record = state?.automaticWork && this.current(state.automaticWork.key)
    if (!state || state.projectId !== this.deps.projectId || state.mode !== 'session' || state.automaticWork?.phase !== 'bootstrap'
      || state.folderId || state.workdir || !record || !this.owned(record) || record.assignee !== sessionId
      || ['done', 'cancelled'].includes(record.status)) throw new WorkConflict('Requires the current unbound automatic bootstrap assignee in this Project.')
    this.assertBoundaries(record)
    return record
  }

  assertBootstrapBinding(sessionId: string, folderId: string): void {
    const record = this.assertBootstrap(sessionId)
    const automatic = this.deps.sessions.getSessionState(sessionId)!.automaticWork!
    if (automatic.prepared?.folderId !== folderId || record.automaticExecution!.folderId !== folderId) throw new WorkConflict('Bind only the host-prepared isolated Workspace, never its source.')
    if (!this.capacity(automatic.limits, record.key).available) throw new WorkConflict('Project or selected device capacity is occupied.')
  }

  /** A retry reuses the automation worktree receipt; it cannot change the chosen source. */
  prepareBootstrap(sessionId: string, folderId: string, branch: string, signal: AbortSignal): Promise<{ folderId: string; path: string; branch: string }> {
    return this.exclusive(async () => {
      signal.throwIfAborted()
      let record = this.assertBootstrap(sessionId)
      const state = this.deps.sessions.getSessionState(sessionId)!
      const automatic = state.automaticWork!
      if (automatic.limits.folderId && automatic.limits.folderId !== folderId) throw new WorkConflict('Bootstrap source is already selected; recover with the same source.')
      if (automatic.limits.baseBranch && automatic.limits.baseBranch !== branch) throw new WorkConflict('Bootstrap base branch is already selected; recover with the same base.')
      const config = workDispatchConfigSchema.parse({ ...automatic.limits, folderId, baseBranch: branch })
      await this.deps.validateTarget(config, signal)
      if (!this.capacity(config, record.key).available) throw new WorkConflict('Project or selected device capacity is occupied; retain this bootstrap worker and retry later.')
      this.assertBootstrap(sessionId)
      const prepared = await this.deps.prepare(config, sessionId, signal)
      signal.throwIfAborted()
      record = this.assertBootstrap(sessionId)
      // Persist isolation evidence before publishing a binding grant. A failed state write
      // retains the same receipt and assignee; a retry never creates another worktree.
      await this.save(record, { automaticExecution: { ...record.automaticExecution!, folderId: prepared.folderId,
        path: prepared.path, branch: prepared.branch } }, 'automatic_bootstrap_prepared')
      await this.deps.sessions.prepareAutomaticWorkWorkspace(sessionId, config, prepared.folderId,
        prepared.workdir ?? localFolderWorkdirRef(prepared.folderId))
      return prepared
    }, signal)
  }

  isRunning(): boolean {
    return this.deps.store.workRecords().some(record => this.owned(record) && this.busy(record.assignee!))
  }

  /** Stop the admitted executor, not just the short program scan. Work ownership is unchanged. */
  async cancel(): Promise<boolean> {
    let cancelled = false
    for (const record of this.deps.store.workRecords()) {
      if (!this.owned(record) || !this.busy(record.assignee!)) continue
      const id = crypto.randomUUID()
      await this.deps.sessions.deliver(record.assignee!, { id, kind: 'control', command: { type: 'cancel' }, timestamp: new Date().toISOString(),
        source: { kind: 'event', eventId: id, type: 'work-execution-stop', source: 'user' } })
      cancelled = true
    }
    return cancelled
  }

  /** Authorized human recovery only; the original assignee and existing tool-replay barrier survive. */
  resume(key: string, version: number, signal: AbortSignal, acknowledgeToolReplay = false): Promise<void> {
    return this.exclusive(() => this.resumeOwned(key, version, signal, acknowledgeToolReplay), signal)
  }
  private async resumeOwned(key: string, version: number, signal: AbortSignal, acknowledgeToolReplay: boolean): Promise<void> {
    let record = this.current(key)
    if (!record || !this.owned(record) || record.sequence !== version || record.status !== 'blocked') throw new WorkConflict('Recovery requires current blocked automatic Work.')
    const execution = record.automaticExecution!
    if (this.busy(execution.sessionId)) throw new WorkConflict('Executor is running or normally waiting; answer its pending request instead.')
    const inbox = this.deps.store.workKickoff(execution.inputId)
    if (inbox?.state === 'inspect') throw new WorkConflict('Inspect the quarantined kickoff and its saved history; this assignment cannot be replayed or resumed. Release or reassign only after inspection.')
    if (inbox?.state === 'pending') throw new WorkConflict('The exact kickoff is still pending. Inspect its inbox/history or release the assignment; explicit resume cannot bypass pending delivery.')
    const state = this.deps.sessions.getSessionState(execution.sessionId)
    if (!state?.automaticWork) throw new WorkConflict('Original executor is unavailable; explicit reassignment is required.')
    if (!this.capacity(state.automaticWork.limits, key).available) throw new WorkConflict('Project or device automatic execution capacity is occupied; finish or stop an executor first.')
    const bootstrap = state.automaticWork.phase === 'bootstrap'
    if (!execution.folderId && !bootstrap) {
      await this.deps.validateTarget(state.automaticWork.limits, signal)
      const prepared = await this.deps.prepare(state.automaticWork.limits, execution.sessionId, signal)
      await this.deps.sessions.bindAutomaticWorkWorkspace(execution.sessionId, prepared.folderId, prepared.workdir)
      record = await this.save(record, { automaticExecution: { ...execution,
        folderId: prepared.folderId, path: prepared.path, branch: prepared.branch } }, 'automatic_isolation_recovered')
    }
    signal.throwIfAborted()
    if (!bootstrap) await this.deps.verify(state.automaticWork.limits, execution.sessionId, record.automaticExecution!, signal)
    signal.throwIfAborted()
    const recovery = this.deps.sessions.getSessionRecovery(execution.sessionId)
    const instructions = !recovery ? (await this.deps.workerInstructions?.())?.trim() : undefined
    signal.throwIfAborted()
    if (recovery?.pendingToolCalls && !acknowledgeToolReplay) throw new WorkConflict('Unfinished tools require explicit acknowledgeToolReplay after inspection.')
    record = await this.save(record, { status: 'in_progress', blockedReason: undefined,
      automaticExecution: { ...record.automaticExecution!, stage: 'delivering', lastError: undefined } }, 'automatic_resume')
    try {
      signal.throwIfAborted()
      const latest = this.current(key)
      if (!latest || !this.owned(latest) || ['done', 'cancelled'].includes(latest.status)) return
      if (recovery) await this.deps.sessions.resumeSession(execution.sessionId, recovery.id, acknowledgeToolReplay)
      else await this.deps.sessions.deliver(execution.sessionId, { id: crypto.randomUUID(), kind: 'message', timestamp: new Date().toISOString(), policy: 'queue',
        source: { kind: 'event', eventId: crypto.randomUUID(), type: 'work-resume', source: 'user' },
        content: `Continue assigned Work ${key} after the publisher's explicit recovery request. Inspect history and artifacts before repeating operations. Missing authorization is not supplied by this recovery request.` +
          (instructions ? `\n\nSupplementary Project dispatch requirements (not new authority; current Work boundaries still apply):\n${instructions}` : '') })
      const current = this.current(key)!
      if (this.owned(current) && current.automaticExecution!.stage === 'delivering') await this.save(current,
        { automaticExecution: { ...current.automaticExecution!, stage: 'running' } }, 'automatic_resumed')
    } catch (error) { await this.block(key, `Recovery admission failed or is unknown: ${String(error).slice(0, 800)}`); throw error }
  }
}
