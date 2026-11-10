import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { automaticWorkEligible, workDependenciesSatisfied, type InitiativeStore } from '../initiatives/store.ts'
import { workNotesSchema } from '../initiatives/work-notes.ts'
import { WorkConflict, type WorkRecord } from '../initiatives/work-contract.ts'
import { LOCAL_NODE_ID, localFolderWorkdirRef, type WorkdirRefV2 } from '../sessions/locality.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionTurnFact, SessionInput, DeliveryReceipt } from '../sessions/input.ts'
import type { CronJob } from './service.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema, AUTOMATIC_WORK_GUIDANCE, type WorkDispatchConfig, workDispatchSelectionSchema, type WorkDispatchSelection } from './work-dispatch-contract.ts'

export interface WorkDispatcherDeps {
  projectId: string
  store: InitiativeStore
  sessions: Pick<SessionManager, 'getSessionState' | 'isSessionBusy' | 'setAutomaticWorkAdmission' | 'buildSession' | 'deliver' | 'inputs' | 'yields' | 'isWaitingForCall' | 'isWaitingForExternalExecution' | 'getSessionRecovery' | 'resumeSession' | 'bindAutomaticWorkWorkspace'>
  validateTarget(config: WorkDispatchConfig, signal: AbortSignal): Promise<void>
  nodeForTarget?(config: WorkDispatchConfig): string
  capacityPolicy?(): Pick<WorkDispatchConfig, 'maxConcurrent' | 'maxConcurrentPerDevice'> | undefined
  targets?(): Array<{ folderId: string; name: string; nodeId: string; platform?: NodeJS.Platform; supported: boolean; reason?: string }>
  prepare(config: WorkDispatchConfig, sessionId: string, signal: AbortSignal): Promise<{ folderId: string; path: string; branch: string; workdir?: WorkdirRefV2 }>
  verify(config: WorkDispatchConfig, sessionId: string, execution: NonNullable<WorkRecord['automaticExecution']>, signal: AbortSignal): Promise<void>
  changed(record: WorkRecord, previous: WorkRecord): Promise<void>
}

/** Reliable admission and recovery; scheduling intelligence runs in a normal fresh Cron session. */
export class WorkDispatcher {
  private scanning?: Promise<void>
  private runner?: (job: CronJob, signal: AbortSignal) => Promise<void>

  setRunner(runner: (job: CronJob, signal: AbortSignal) => Promise<void>): void { this.runner = runner }

  private occupies(record: WorkRecord): boolean {
    return this.owned(record) && (this.busy(record.workflow!.assignee!) || !record.paused
      && !['done', 'cancelled'].includes(record.workflow!.status)
      && (record.automaticExecution!.stage === 'claimed' || record.workflow!.status !== 'blocked'))
  }
  private capacity(config: WorkDispatchConfig, excluding?: string) {
    const active = this.deps.store.workRecords().filter(record => record.key !== excluding && this.occupies(record))
    const nodeId = this.deps.nodeForTarget?.(config) ?? LOCAL_NODE_ID
    const onDevice = active.filter(record => (this.deps.sessions.getSessionState(record.workflow!.assignee!)?.workdir?.nodeId ?? LOCAL_NODE_ID) === nodeId).length
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
      records: records.slice(offset, offset + limit).map(record => ({ ...record, eligible: automaticWorkEligible(record, records),
        dependencies: record.workflow?.dependencies.map(key => ({ key, status: records.find(item => item.key === key)?.workflow?.status ?? 'missing' })) })) }
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
    deps.sessions.setAutomaticWorkAdmission((id, input, admit) => this.admit(id, input, admit))
  }

  private assertBoundaries(record: WorkRecord): void {
    const records = this.deps.store.workRecords(), byKey = new Map(records.map(item => [item.key, item]))
    const seen = new Set<string>()
    let current: WorkRecord | undefined = record
    while (current) {
      if (seen.has(current.key) || current.paused || ['done', 'cancelled'].includes(current.workflow?.status ?? '')
        || !workDependenciesSatisfied(current, records)) throw new WorkConflict('Work dependency or ancestor boundary prevents automatic admission.')
      seen.add(current.key)
      const parent: string | undefined = current.workflow?.parentKey
      if (parent && !byKey.has(parent)) throw new WorkConflict('Work ancestor is unavailable.')
      current = parent ? byKey.get(parent) : undefined
    }
  }

  private async admit(sessionId: string, input: SessionInput, admit: (beforeDispatch?: () => void) => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> {
    if (input.kind === 'control' && input.command.type === 'cancel') return admit()
    const run = async () => {
      const signal = this.admissionContext.getStore()?.signal ?? new AbortController().signal
      signal.throwIfAborted()
      const state = this.deps.sessions.getSessionState(sessionId)
      const record = state?.automaticWork && this.current(state.automaticWork.key)
      if (!record || !this.owned(record) || record.workflow!.assignee !== sessionId || record.paused
        || ['done', 'cancelled'].includes(record.workflow!.status)) throw new WorkConflict('Automatic Work is no longer admissible.')
      const check = () => {
        signal.throwIfAborted()
        const latest = this.current(record.key)
        if (!latest || !this.owned(latest) || latest.workflow!.assignee !== sessionId || latest.paused
          || ['done', 'cancelled'].includes(latest.workflow!.status)) throw new WorkConflict('Automatic Work is no longer admissible.')
        this.assertBoundaries(latest)
        if (!this.capacity(state!.automaticWork!.limits, record.key).available) throw new WorkConflict('Project or device automatic execution capacity is occupied.')
      }
      check()
      await this.deps.verify(state!.automaticWork!.limits, sessionId, record.automaticExecution!, signal)
      check()
      return admit(check) // Recheck after async Session preparation, immediately before dispatch().
    }
    return this.admissionContext.getStore()?.active ? run() : this.exclusive(run)
  }

  private current(key: string) { return this.deps.store.workRecords().find(record => record.key === key) }
  private owned(record: WorkRecord) {
    const execution = record.automaticExecution
    return !!execution && execution.jobId === WORK_DISPATCH_ID && record.workflow?.assignee === execution.sessionId
      && record.workflow.assignmentRevision === execution.assignmentRevision
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
    this.deps.store.saveWork(record, previous.sequence, previous.workflow!.assignee!, kind)
    await this.deps.changed(record, previous)
    return record
  }

  /** A host failure is never proof of done, release, cancellation or rollback. */
  async block(key: string, reason: string): Promise<void> {
    const record = this.current(key)
    if (!record || !this.owned(record) || ['done', 'cancelled'].includes(record.workflow!.status)
      || record.automaticExecution!.stage === 'blocked' || this.waiting(record.workflow!.assignee!)) return
    const execution = record.automaticExecution!
    const detail = `${record.workflow!.status === 'blocked' ? `Existing blocker: ${record.workflow!.blockedReason?.slice(0, 500)}. Host execution: ` : ''}${reason} Responsibility and artifacts are retained. Inspect Work notes, session history, branch ${execution.branch ?? '(not prepared)'} and recovery before continuing; ask the publisher for the specific missing input/authority.`.slice(0, 2000)
    const notes = record.notes ?? workNotesSchema.parse({})
    const publisher = record.workflow!.manager ?? record.botSource?.sessionId
    const help = publisher && publisher !== execution.sessionId
      ? { id: `work-blocked:${record.key}:${record.sequence + 1}`, recipient: publisher, attempts: 0, delivered: false } : undefined
    await this.save(record, { workflow: { ...record.workflow!, status: 'blocked', blockedScope: record.workflow!.status === 'blocked' ? record.workflow!.blockedScope ?? 'work' : 'step', blockedReason: detail },
      notes: { ...notes, next: 'Publisher/coordinator: inspect retained evidence and supply the specific missing input or use explicit recovery.',
        attention: { kind: 'blocker', summary: detail, version: record.sequence + 1, at: new Date().toISOString(), by: execution.sessionId } },
      automaticExecution: { ...execution, stage: 'blocked', lastError: detail, help } }, 'automatic_blocked')
    await this.deliverHelp(record.key)
  }

  private readonly notifying = new Set<string>()
  /** Persisted bounded help receipt; retries never replay the executor's tool operations. */
  private async deliverHelp(key: string): Promise<void> {
    if (this.notifying.has(key)) return
    let record = this.current(key)
    const help = record?.automaticExecution?.help
    if (!record || !this.owned(record) || record.workflow!.status !== 'blocked' || record.paused || !help || help.delivered || help.attempts >= 3) return
    this.notifying.add(key)
    try {
      record = await this.save(record, { automaticExecution: { ...record.automaticExecution!, help: { ...help, attempts: help.attempts + 1 } } }, 'automatic_help_attempt')
      let error: unknown
      try {
        if (!this.deps.sessions.getSessionState(help.recipient)) throw new Error('Publisher session is unavailable in this Project')
        const receipt = await this.deps.sessions.deliver(help.recipient, { id: help.id, kind: 'message', timestamp: new Date().toISOString(), policy: 'queue',
          source: { kind: 'event', eventId: help.id, type: 'work-blocked', source: 'work-dispatch' },
          content: `Assigned Work ${record.key} needs publisher help: ${record.workflow!.blockedReason}\nRead its retained notes and history. Notification ${help.id} may be retried after interruption; do not duplicate actions. It is not authorization to change scope or repeat external actions.` })
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
      if (!this.owned(record) || this.busy(record.workflow!.assignee!)) continue
      if (['done', 'cancelled'].includes(record.workflow!.status)) {
        if (record.automaticExecution!.stage !== 'settled') await this.save(record,
          { automaticExecution: { ...record.automaticExecution!, stage: 'settled' } }, 'automatic_settled')
        continue
      }
      if (record.paused) continue
      if (record.workflow!.status === 'blocked' && this.deps.sessions.getSessionState(record.workflow!.assignee!)?.executionStatus === 'completed') continue
      if (['delivering', 'running'].includes(record.automaticExecution!.stage)) {
        await this.block(record.key, 'Automatic execution interrupted or admission unconfirmed after restart; no write replay was attempted.')
      }
    }
  }

  async finished(fact: SessionTurnFact): Promise<void> {
    for (const record of this.deps.store.workRecords().filter(record => this.owned(record) && record.workflow!.assignee === fact.sessionId)) {
      if (this.waiting(fact.sessionId) || record.paused) continue
      if (record.workflow!.status === 'blocked' && fact.status === 'completed') {
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
      await this.deps.validateTarget(config, signal)
      await this.recover()
      for (const record of this.deps.store.workRecords()) {
        if (this.occupies(record) && record.automaticExecution!.stage === 'claimed') await this.launch(record, signal)
      }
      const records = this.deps.store.workRecords()
      // A full default device must not prevent considering another supported device,
      // but all-full/unsupported inventories do not spend a fresh inference every tick.
      const targets = this.deps.targets?.().filter(target => target.supported)
      const hasCapacity = targets ? targets.some(target => this.capacity({ ...config, folderId: target.folderId }).available) : this.capacity(config).available
      return hasCapacity && records.some(record => automaticWorkEligible(record, records))
    }, signal)
    if (!ready) return // no session and no inference when idle
    signal.throwIfAborted()
    if (!this.runner) throw new Error('Work dispatcher fresh-session runner is unavailable')
    // Do NOT hold admission while the model runs: its dispatch tool uses that same lock.
    await this.runner(job, signal)
  }

  dispatchWork(job: CronJob, key: string, version: number, selection: WorkDispatchSelection, signal: AbortSignal): Promise<WorkRecord> {
    return this.exclusive(() => this.claim(job, key, version, selection, signal), signal)
  }

  private async claim(job: CronJob, key: string, version: number, selection: WorkDispatchSelection, signal: AbortSignal): Promise<WorkRecord> {
    if (job.id !== WORK_DISPATCH_ID) throw new Error('Unknown Work dispatcher')
    const config = workDispatchConfigSchema.parse({ ...workDispatchConfigSchema.parse(job.program), ...workDispatchSelectionSchema.parse(selection) })
    signal.throwIfAborted()
    await this.deps.validateTarget(config, signal)
    const records = this.deps.store.workRecords()
    const candidate = records.find(record => record.key === key)
    if (!candidate || candidate.sequence !== version || !automaticWorkEligible(candidate, records)) throw new WorkConflict('Work changed or is not eligible; dependencies and ancestor boundaries must be satisfied.')
    if (!this.capacity(config).available) throw new WorkConflict('Project or device automatic execution capacity is occupied.')
    signal.throwIfAborted()
    const assignmentRevision = candidate.workflow!.assignmentRevision + 1
    const token = createHash('sha256').update(`${this.deps.projectId}\0${candidate.key}\0${assignmentRevision}`).digest('hex').slice(0, 40)
    const sessionId = `work-executor:${token}`
    let prepared: Awaited<ReturnType<WorkDispatcherDeps['prepare']>> | undefined
    let preparationError: unknown
    try { prepared = await this.deps.prepare(config, sessionId, signal) }
    catch (error) { preparationError = error }
    signal.throwIfAborted()
    let state = this.deps.sessions.getSessionState(sessionId)
    if (!state) {
      await this.deps.sessions.buildSession(sessionId, undefined, { mode: 'session', agentType: 'general',
        config: { ...(config.model ? { model: config.model } : {}), ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) },
        folderId: prepared?.folderId, workdir: prepared ? prepared.workdir ?? localFolderWorkdirRef(prepared.folderId) : undefined, automaticWork: { key: candidate.key, jobId: WORK_DISPATCH_ID, limits: config },
        automation: { jobId: job.id, name: job.name ?? 'Work auto-dispatch', runId: sessionId, startedAt: new Date().toISOString(), contextMode: 'fresh',
          config: { source: 'cron', schedule: job.schedule, agentType: 'general' } } })
      state = this.deps.sessions.getSessionState(sessionId)
    }
    if (!state || state.projectId && state.projectId !== this.deps.projectId || state.automaticWork?.key !== candidate.key) throw new WorkConflict('Automatic session identity conflict.')
    const claimed: WorkRecord = { ...candidate, sequence: candidate.sequence + 1, changedAt: new Date().toISOString(),
      workflow: { ...candidate.workflow!, assignee: sessionId, assignmentRevision, assignmentStarted: false },
      automaticExecution: { jobId: WORK_DISPATCH_ID, sessionId, assignmentRevision, inputId: `work-start:${token}`, stage: 'claimed',
        ...(prepared ? { folderId: prepared.folderId, path: prepared.path, branch: prepared.branch } : {}) } }
    this.deps.store.claimAutomaticWork(claimed, candidate.sequence)
    await this.deps.changed(claimed, candidate)
    if (preparationError) { await this.block(candidate.key, `Isolation preparation failed: ${String(preparationError).slice(0, 800)}. No source-directory execution occurred.`); return this.current(key)! }
    try { await this.launch(claimed, signal) }
    catch (error) { await this.block(claimed.key, `Automatic admission interrupted after claim: ${String(error).slice(0, 800)}`); throw error }
    return this.current(key)!
  }

  private async launch(record: WorkRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    record = this.current(record.key)!
    if (!this.owned(record) || record.paused || ['done', 'cancelled'].includes(record.workflow!.status)
      || record.workflow!.status === 'blocked' && record.automaticExecution!.stage !== 'claimed') return
    const execution = record.automaticExecution!
    if (!execution.folderId || this.deps.sessions.getSessionState(execution.sessionId)?.folderId !== execution.folderId) {
      await this.block(record.key, 'No verified isolated Workspace is bound to this executor.'); return
    }
    const state = this.deps.sessions.getSessionState(execution.sessionId)
    try {
      if (!state?.automaticWork) throw new Error('Automatic executor configuration missing')
      await this.deps.verify(state.automaticWork.limits, execution.sessionId, execution, signal)
    } catch (error) { await this.block(record.key, `Isolation identity verification failed: ${String(error).slice(0, 800)}`); return }
    // Write-ahead admission barrier: a crash here is blocked, never blindly resent.
    record = await this.save(record, { automaticExecution: { ...execution, stage: 'delivering' } }, 'automatic_delivery')
    try {
      signal.throwIfAborted()
      const latest = this.current(record.key)
      if (!latest || !this.owned(latest) || latest.paused || ['done', 'cancelled'].includes(latest.workflow!.status)
        || latest.automaticExecution!.inputId !== execution.inputId) return
      const receipt = await this.deps.sessions.deliver(execution.sessionId, {
        id: execution.inputId, kind: 'message', timestamp: new Date().toISOString(), policy: 'queue',
        source: { kind: 'event', eventId: execution.inputId, type: 'work-assignment', source: 'system' },
        content: `${AUTOMATIC_WORK_GUIDANCE}\n\nAssigned Work key: ${record.key}. Read v:works/keys/${encodeURIComponent(record.key)}. Isolated branch: ${execution.branch}.` +
          (record.workflow!.status === 'blocked' ? `\nExisting blocker is retained: ${record.workflow!.blockedReason}. This first assignment is for blocker clarification and publisher help, not permission to clear the blocker or execute blocked actions.` : ''),
      })
      if (receipt.status !== 'accepted' || receipt.disposition === 'filtered' || receipt.inputId !== execution.inputId || receipt.sessionId !== execution.sessionId) throw new Error('Unconfirmed Work admission')
      const current = this.current(record.key)!
      if (this.owned(current) && current.automaticExecution!.stage === 'delivering') await this.save(current,
        { automaticExecution: { ...current.automaticExecution!, stage: 'running' } }, 'automatic_admitted')
    } catch (error) { await this.block(record.key, `Work delivery failed or has an unknown outcome: ${String(error).slice(0, 800)}. Inspect admission before explicit recovery.`) }
  }

  isRunning(): boolean {
    return this.deps.store.workRecords().some(record => this.owned(record) && this.busy(record.workflow!.assignee!))
  }

  /** Stop the admitted executor, not just the short program scan. Work ownership is unchanged. */
  async cancel(): Promise<boolean> {
    let cancelled = false
    for (const record of this.deps.store.workRecords()) {
      if (!this.owned(record) || !this.busy(record.workflow!.assignee!)) continue
      const id = crypto.randomUUID()
      await this.deps.sessions.deliver(record.workflow!.assignee!, { id, kind: 'control', command: { type: 'cancel' }, timestamp: new Date().toISOString(),
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
    if (!record || !this.owned(record) || record.sequence !== version || record.paused || record.workflow!.status !== 'blocked') throw new WorkConflict('Recovery requires current, unpaused blocked automatic Work.')
    const execution = record.automaticExecution!
    if (this.busy(execution.sessionId)) throw new WorkConflict('Executor is running or normally waiting; answer its pending request instead.')
    const state = this.deps.sessions.getSessionState(execution.sessionId)
    if (!state?.automaticWork) throw new WorkConflict('Original executor is unavailable; explicit reassignment is required.')
    if (!this.capacity(state.automaticWork.limits, key).available) throw new WorkConflict('Project or device automatic execution capacity is occupied; finish or stop an executor first.')
    if (!execution.folderId) {
      await this.deps.validateTarget(state.automaticWork.limits, signal)
      const prepared = await this.deps.prepare(state.automaticWork.limits, execution.sessionId, signal)
      await this.deps.sessions.bindAutomaticWorkWorkspace(execution.sessionId, prepared.folderId, prepared.workdir)
      record = await this.save(record, { automaticExecution: { ...execution,
        folderId: prepared.folderId, path: prepared.path, branch: prepared.branch } }, 'automatic_isolation_recovered')
    }
    signal.throwIfAborted()
    await this.deps.verify(state.automaticWork.limits, execution.sessionId, record.automaticExecution!, signal)
    signal.throwIfAborted()
    const recovery = this.deps.sessions.getSessionRecovery(execution.sessionId)
    if (recovery?.pendingToolCalls && !acknowledgeToolReplay) throw new WorkConflict('Unfinished tools require explicit acknowledgeToolReplay after inspection.')
    record = await this.save(record, { workflow: { ...record.workflow!, status: 'in_progress', blockedReason: undefined, blockedScope: undefined },
      automaticExecution: { ...record.automaticExecution!, stage: 'delivering', lastError: undefined } }, 'automatic_resume')
    try {
      signal.throwIfAborted()
      const latest = this.current(key)
      if (!latest || !this.owned(latest) || latest.paused || ['done', 'cancelled'].includes(latest.workflow!.status)) return
      if (recovery) await this.deps.sessions.resumeSession(execution.sessionId, recovery.id, acknowledgeToolReplay)
      else await this.deps.sessions.deliver(execution.sessionId, { id: crypto.randomUUID(), kind: 'message', timestamp: new Date().toISOString(), policy: 'queue',
        source: { kind: 'event', eventId: crypto.randomUUID(), type: 'work-resume', source: 'user' },
        content: `Continue assigned Work ${key} after the publisher's explicit recovery request. Inspect history and artifacts before repeating operations. Missing authorization is not supplied by this recovery request.` })
      const current = this.current(key)!
      if (this.owned(current) && current.automaticExecution!.stage === 'delivering') await this.save(current,
        { automaticExecution: { ...current.automaticExecution!, stage: 'running' } }, 'automatic_resumed')
    } catch (error) { await this.block(key, `Recovery admission failed or is unknown: ${String(error).slice(0, 800)}`); throw error }
  }
}
