import { randomUUID } from 'node:crypto'
import { channelAddressFromSessionId } from '../bus/events.ts'
import type { SessionState } from './session-store.ts'
import {
  parseYieldPolicy, parseYieldQuestion, parseYieldCustomText,
  type YieldAnswer, type YieldOutcome, type YieldContinuation, type YieldReference, type YieldDecisionRecord, type YieldPolicy, type YieldQuestion, type YieldRequest,
} from './yield-contract.ts'

export class YieldError extends Error {
  override readonly name = 'YieldError'

  constructor(
    readonly code: 'invalid_request' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message)
  }
}

interface YieldManagerDeps {
  changed?: (sessionId: string) => void
  assertCanYield?: (id: string) => void
  getState: (id: string) => SessionState | null | undefined
  getPolicy: (id: string) => YieldPolicy
  notifyUser: (request: YieldRequest, replyTo?: string) => Promise<void>
  notifyParent: (request: YieldRequest) => Promise<void>
  notifyReporter?: (request: YieldRequest) => Promise<void>
  context?: (sessionId: string) => Promise<unknown>
  invalidate?: (reference: YieldReference, reason: string) => Promise<unknown>
  journal?: {
    open: (request: YieldRequest, toolCallId?: string) => Promise<YieldRequest>
    write: (record: YieldDecisionRecord) => Promise<void>
    replace?: (previous: YieldRequest, next: YieldRequest) => Promise<void>
  }
}

interface PendingYield {
  request: YieldRequest
  resolve: (answer: YieldOutcome) => void
  reject: (reason: unknown) => void
  signal: AbortSignal
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
  channelUser?: { channel: string; senderId: string }
  phase: 'preparing' | 'waiting' | 'answering' | 'closing'
  prepared?: Promise<void>
  prepareError?: unknown
  abortReason?: unknown
  timeoutPaused?: true
}

function snapshot(request: YieldRequest): YieldRequest {
  const copy = structuredClone(request)
  Object.freeze(copy.options)
  Object.freeze(copy.recipient)
  if (copy.origin) copy.origin = Object.freeze({ ...copy.origin })
  if (copy.supersedes) copy.supersedes = Object.freeze({ ...copy.supersedes })
  if (copy.sources) {
    copy.sources = copy.sources.map(source => Object.freeze({ ...source }))
    Object.freeze(copy.sources)
  }
  return Object.freeze(copy)
}

function abortError(reason?: string): DOMException {
  return new DOMException(reason ?? 'Yield cancelled.', 'AbortError')
}

/** Live authority stays in memory; the journal records facts without restoring waiters. */
export class YieldManager {
  private readonly pending = new Map<string, PendingYield>()
  private readonly requests = new Map<string, PendingYield>()
  private stopped = false
  private readonly writes = new Set<Promise<unknown>>()

  constructor(private readonly deps: YieldManagerDeps) {}

  start(): void { this.stopped = false }

  async ask(
    sessionId: string,
    question: YieldQuestion,
    signal: AbortSignal,
    channelUser?: { channel: string; senderId: string },
    replyTo?: string,
    toolCallId?: string,
    workStamps?: import('../initiatives/work-contract.ts').WorkStamp[],
  ): Promise<YieldOutcome> {
    signal.throwIfAborted()
    this.deps.assertCanYield?.(sessionId)
    if (this.deps.getState(sessionId)?.mode === 'call') throw new YieldError('forbidden', 'Leaf calls cannot yield.')
    if (this.stopped) throw new YieldError('unavailable', 'Yield coordinator has stopped.')
    if (this.pending.has(sessionId)) throw new YieldError('conflict', 'This session already has a pending yield request.')
    let parsed: YieldQuestion
    let policy: YieldPolicy
    try {
      parsed = parseYieldQuestion(question)
      policy = parseYieldPolicy(this.deps.getPolicy(sessionId))
    } catch (error) {
      throw new YieldError('invalid_request', error instanceof Error ? error.message : String(error))
    }
    if (parsed.sources && !this.deps.journal) throw new YieldError('unavailable', 'Decision references require a persistent journal.')
    const recipient = this.recipient(sessionId)
    const reportingSessionId = this.deps.getState(sessionId)?.decisionOwnerSessionId
    if (reportingSessionId && (!this.deps.getState(reportingSessionId) || this.deps.getState(reportingSessionId)?.mode === 'call'
      || this.deps.getState(reportingSessionId)?.mode === 'task')) throw new YieldError('unavailable', 'The decision reporting owner is unavailable; explicitly reassign responsibility.')
    const channelAddress = channelAddressFromSessionId(sessionId)
    if (recipient.kind === 'user' && (channelAddress || /^(discord|feishu|qq|wechat):/.test(sessionId)) && !channelUser) {
      throw new YieldError('forbidden', 'A channel decision needs an initiating human. Return the blocker instead of publishing an unanswerable question.')
    }
    if (channelUser && (!channelUser.senderId.trim() || !channelUser.channel
      || (channelAddress ? channelAddress.platform !== channelUser.channel : !sessionId.startsWith(`${channelUser.channel}:`)))) {
      throw new YieldError('invalid_request', 'The answering user must belong to this session channel.')
    }
    const now = Date.now()
    const request = snapshot({
      ...parsed, id: randomUUID(), sessionId, recipient, ...(reportingSessionId ? { reportingSessionId } : {}),
      ...(workStamps?.length ? { workStamps } : {}),
      createdAt: new Date(now).toISOString(),
      deadline: policy.timeoutMs === null ? null : new Date(now + policy.timeoutMs).toISOString(),
    })

    return new Promise<YieldOutcome>((resolve, reject) => {
      const pending: PendingYield = {
        request, resolve, reject, signal, phase: this.deps.journal ? 'preparing' : 'waiting',
        channelUser: channelUser ? { ...channelUser } : undefined,
        onAbort: () => { void this.fail(pending, signal.reason ?? abortError()) },
      }
      this.pending.set(sessionId, pending)
      this.requests.set(request.id, pending)
      signal.addEventListener('abort', pending.onAbort, { once: true })
      if (signal.aborted) {
        pending.onAbort()
        return
      }
      const publish = () => {
        if (pending.prepareError) { void this.fail(pending, pending.prepareError); return }
        if (pending.phase === 'closing') return
        pending.phase = 'waiting'
        this.deps.changed?.(sessionId)
        if (request.deadline !== null) {
          pending.timer = setTimeout(() => {
            if (signal.aborted) pending.onAbort()
            else if (pending.phase === 'waiting') void this.complete(pending, request.defaultOption, 'timeout')
          }, Math.max(0, Date.parse(request.deadline) - Date.now()))
        }
        // Delivery must not prevent an answer or cancellation if the recipient hangs.
        try {
          const delivery = recipient.kind === 'user'
            ? this.deps.notifyUser(snapshot(pending.request), replyTo)
            : this.deps.notifyParent(snapshot(pending.request))
          Promise.resolve(delivery).catch(error => this.deliveryFailed(pending, error))
          if (pending.request.reportingSessionId && pending.request.reportingSessionId !== sessionId) {
            Promise.resolve(this.deps.notifyReporter?.(snapshot(pending.request))).catch(error => this.deliveryFailed(pending, error))
          }
        } catch (error) {
          this.deliveryFailed(pending, error)
        }
      }
      if (this.deps.journal) {
        pending.prepared = this.deps.journal.open(snapshot(request), toolCallId).then(
          saved => { pending.request = snapshot(saved) },
          error => { pending.prepareError = this.persistenceError(error) },
        )
        this.track(pending.prepared.then(publish))
      } else publish()
    })
  }

  async context(sessionId: string): Promise<unknown> {
    if (!this.deps.context) throw new YieldError('unavailable', 'Decision context is not configured.')
    return this.deps.context(sessionId)
  }

  async invalidateOwn(sessionId: string, reference: YieldReference, reason: string): Promise<unknown> {
    if (reference.sessionId !== sessionId) throw new YieldError('forbidden', 'An agent may invalidate only its own decision; report other changed premises to their owner.')
    if (!this.deps.invalidate) throw new YieldError('unavailable', 'Decision invalidation is not configured.')
    return this.deps.invalidate(reference, parseYieldCustomText(reason))
  }

  continueUser(sessionId: string, requestId: string, disposition: 'investigation' | 'deferred', reason: string): Promise<YieldContinuation> {
    return this.continueWithoutAnswer(this.userRequest(sessionId, requestId), disposition, parseYieldCustomText(reason))
  }

  async invalidatePending(reference: YieldReference, reason: string): Promise<void> {
    const pending = this.requests.get(reference.requestId)
    if (!pending || pending.request.sessionId !== reference.sessionId || pending.request.origin?.physicalId !== reference.physicalId) return
    if (pending.phase !== 'waiting') return // The serialized journal rejects answers racing a saved invalidation.
    await this.continueWithoutAnswer(pending, 'invalidated', reason)
  }

  private continueWithoutAnswer(pending: PendingYield, disposition: YieldContinuation['disposition'], reason: string): Promise<YieldContinuation> {
    if (!this.deps.journal || !pending.request.origin) throw new YieldError('unavailable', 'Decision follow-up requires durable history.')
    const request = pending.request
    const result: YieldContinuation = { requestId: request.id, disposition, approved: false, reason,
      reference: { sessionId: request.sessionId, physicalId: request.origin!.physicalId, requestId: request.id },
      blocked: request.brief?.blocked ?? ['The action requiring this decision'],
      unaffected: request.brief?.unaffected ?? [] }
    pending.phase = 'answering'
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    return this.track(this.deps.journal.write({ request, closed: { reason: disposition, message: reason, at: new Date().toISOString() } }).then(() => {
      this.cleanup(pending)
      if (pending.abortReason) pending.reject(pending.abortReason)
      else pending.resolve(result)
      return result
    }, error => {
      const failure = this.persistenceError(error)
      this.cleanup(pending)
      pending.reject(failure)
      throw failure
    }))
  }

  get(sessionId: string): YieldRequest | null {
    const pending = this.pending.get(sessionId)
    return pending && (pending.phase === 'waiting' || pending.phase === 'answering')
      ? snapshot({ ...pending.request, ...(pending.timeoutPaused ? { timeoutPaused: true } : {}) }) : null
  }

  userRequestSnapshot(sessionId: string, requestId: string): YieldRequest {
    return snapshot(this.userRequest(sessionId, requestId).request)
  }

  pauseDefault(sessionId: string, requestId: string): void {
    const pending = this.userRequest(sessionId, requestId)
    pending.timeoutPaused = true
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.deps.changed?.(sessionId)
  }

  reviseUser(sessionId: string, requestId: string, question: YieldQuestion, reason: string, reviewerId: string): Promise<YieldRequest> {
    const pending = this.userRequest(sessionId, requestId)
    const previous = pending.request
    if (!previous.origin || !this.deps.journal?.replace) throw new YieldError('unavailable', 'Decision revisions require a journal.')
    const next = snapshot({
      ...parseYieldQuestion(question), sources: previous.sources,
      brief: question.brief ?? previous.brief, reportingSessionId: previous.reportingSessionId,
      id: randomUUID(), decisionId: previous.decisionId ?? previous.id, sessionId,
      recipient: { ...previous.recipient }, origin: { ...previous.origin }, createdAt: new Date().toISOString(), deadline: null,
      supersedes: { sessionId, physicalId: previous.origin.physicalId, requestId },
      revisionReason: parseYieldCustomText(reason), revisionSessionId: reviewerId,
    })
    pending.phase = 'answering'
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    return this.track(this.deps.journal.replace(previous, next).then(async () => {
      this.requests.delete(previous.id)
      pending.request = next
      pending.phase = 'waiting'
      pending.timeoutPaused = true
      this.requests.set(next.id, pending)
      this.deps.changed?.(sessionId)
      if (pending.abortReason) {
        await this.fail(pending, pending.abortReason)
        throw pending.abortReason
      }
      return snapshot(next)
    }, error => {
      const failure = this.persistenceError(error)
      this.cleanup(pending)
      pending.reject(failure)
      throw failure
    }))
  }

  answerUser(sessionId: string, requestId: string, option: string): Promise<YieldAnswer> {
    return this.answer(this.userRequest(sessionId, requestId), option, 'user')
  }

  answerUserText(sessionId: string, requestId: string, text: string): Promise<YieldAnswer> {
    return this.answerText(this.userRequest(sessionId, requestId), text)
  }

  cancelUser(sessionId: string, requestId: string): Promise<void> {
    return this.fail(this.userRequest(sessionId, requestId), abortError('Yield cancelled by user.'))
  }

  answerChannel(sessionId: string, requestId: string, option: string, channel: string, senderId: string): Promise<YieldAnswer> {
    return this.answer(this.channelRequest(sessionId, requestId, channel, senderId), option, 'user')
  }

  answerChannelText(sessionId: string, requestId: string, text: string, channel: string, senderId: string): Promise<YieldAnswer> {
    return this.answerText(this.channelRequest(sessionId, requestId, channel, senderId), text)
  }

  cancelChannel(sessionId: string, requestId: string, channel: string, senderId: string): Promise<void> {
    return this.fail(this.channelRequest(sessionId, requestId, channel, senderId), abortError('Yield cancelled by user.'))
  }

  private channelRequest(sessionId: string, requestId: string, channel: string, senderId: string): PendingYield {
    const pending = this.userRequest(sessionId, requestId)
    if (!pending.channelUser || pending.channelUser.channel !== channel || pending.channelUser.senderId !== senderId) {
      throw new YieldError('forbidden', 'Only the user who requested this turn may answer its channel decision.')
    }
    return pending
  }

  private userRequest(sessionId: string, requestId: string): PendingYield {
    const pending = this.find(requestId)
    const request = pending.request
    if (request.sessionId !== sessionId || request.recipient.kind !== 'user' || request.recipient.sessionId !== sessionId) {
      throw new YieldError('forbidden', 'Only the user of the requesting root session may answer this request.')
    }
    const state = this.deps.getState(sessionId)
    if (!state || this.parentId(state) !== undefined) throw new YieldError('forbidden', 'The requesting session lineage has changed.')
    return pending
  }

  answerParent(parentSessionId: string, requestId: string, option: string): Promise<YieldAnswer> {
    this.deps.assertCanYield?.(parentSessionId)
    const pending = this.find(requestId)
    const request = pending.request
    if (request.recipient.kind !== 'parent' || request.recipient.sessionId !== parentSessionId
      || !this.deps.getState(parentSessionId)
      || this.parentId(this.deps.getState(request.sessionId)) !== parentSessionId) {
      throw new YieldError('forbidden', 'Only the requesting session’s stored parent may answer this request.')
    }
    return this.answer(pending, option, 'parent')
  }

  cancelSession(sessionId: string, reason?: string): void {
    for (const pending of this.pending.values()) {
      const { request } = pending
      if (request.sessionId === sessionId
        || (request.recipient.kind === 'parent' && request.recipient.sessionId === sessionId)) {
        this.fail(pending, abortError(reason))
      }
    }
  }

  stop(): void {
    this.stopped = true
    for (const pending of this.pending.values()) this.fail(pending, abortError('Yield coordinator stopped.'))
  }

  private recipient(sessionId: string): YieldRequest['recipient'] {
    let state = this.deps.getState(sessionId)
    if (!state) throw new YieldError('not_found', 'The requesting session does not exist.')
    const parentId = this.parentId(state)
    const seen = new Set([sessionId])
    while (this.parentId(state) !== undefined) {
      const id = this.parentId(state)
      if (typeof id !== 'string' || !id || seen.has(id)) {
        throw new YieldError('unavailable', 'The requesting session has invalid or cyclic parent lineage.')
      }
      seen.add(id)
      state = this.deps.getState(id)
      if (!state) throw new YieldError('unavailable', 'The requesting session has a missing parent.')
    }
    return parentId ? { kind: 'parent', sessionId: parentId } : { kind: 'user', sessionId }
  }

  private parentId(state: SessionState | null | undefined): string | undefined {
    if (state && Object.hasOwn(state, 'parentSessionId')) return state.parentSessionId ?? undefined
    return state?.parent?.id
  }

  private find(requestId: string): PendingYield {
    const pending = this.requests.get(requestId)
    if (!pending) throw new YieldError('not_found', 'Yield request not found or already settled.')
    if (pending.phase !== 'waiting') throw new YieldError('conflict', 'The decision is being recorded. Wait for confirmation.')
    return pending
  }

  private answer(pending: PendingYield, option: string, by: 'user' | 'parent'): Promise<YieldAnswer> {
    if (typeof option !== 'string' || !pending.request.options.includes(option)) {
      throw new YieldError('invalid_request', 'Answer must exactly match one of the offered options.')
    }
    return this.complete(pending, option, by)
  }

  private answerText(pending: PendingYield, text: string): Promise<YieldAnswer> {
    let option: string
    try { option = parseYieldCustomText(text) }
    catch (error) {
      if (!(error instanceof TypeError)) throw error
      throw new YieldError('invalid_request', error.message)
    }
    return this.complete(pending, option, 'user', true)
  }

  private complete(pending: PendingYield, option: string, answeredBy: YieldAnswer['answeredBy'], custom = false): Promise<YieldAnswer> {
    const answer = Object.freeze<YieldAnswer>({
      requestId: pending.request.id, option, answeredBy, answeredAt: new Date().toISOString(),
      ...(custom ? { custom: true } : {}),
      ...(pending.request.supersedes ? { revisedQuestion: parseYieldQuestion(pending.request) } : {}),
      ...(pending.request.origin ? { reference: Object.freeze({
        sessionId: pending.request.sessionId, physicalId: pending.request.origin.physicalId, requestId: pending.request.id,
      }) } : {}),
    })
    pending.phase = 'answering'
    const finish = () => {
      this.cleanup(pending)
      if (pending.abortReason) pending.reject(pending.abortReason)
      else pending.resolve(answer)
      return answer
    }
    if (!this.deps.journal) return Promise.resolve(finish())
    return this.track(this.deps.journal.write({ request: pending.request, answer }).then(finish, error => {
      const failure = this.persistenceError(error)
      this.cleanup(pending)
      pending.reject(failure)
      throw failure
    }))
  }

  private fail(pending: PendingYield, error: unknown): Promise<void> {
    if (this.requests.get(pending.request.id) !== pending || pending.phase === 'closing') return Promise.resolve()
    if (pending.phase === 'answering') {
      if (pending.signal.aborted || this.stopped || (error instanceof Error && error.name === 'AbortError')) pending.abortReason = error
      return Promise.resolve()
    }
    pending.phase = 'closing'
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (!this.deps.journal) {
      this.cleanup(pending)
      pending.reject(error)
      return Promise.resolve()
    }
    return this.track((async () => {
      try {
        await pending.prepared
        if (pending.prepareError) throw pending.prepareError
        if (pending.request.origin) await this.deps.journal!.write({
          request: pending.request,
          closed: { at: new Date().toISOString(), reason: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
            message: error instanceof Error ? error.message : String(error) },
        })
        pending.reject(error)
      } catch (cause) {
        const failure = this.persistenceError(cause)
        pending.reject(failure)
        throw failure
      } finally { this.cleanup(pending) }
    })())
  }

  /** Drain writes before deleting logs or closing the store; individual callers receive errors. */
  async settled(): Promise<void> {
    while (this.writes.size) await Promise.allSettled([...this.writes])
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.writes.add(operation)
    // The originating ask also receives every persistence failure, including timer/abort paths.
    operation.then(() => this.writes.delete(operation), () => this.writes.delete(operation))
    return operation
  }

  private persistenceError(error: unknown): YieldError {
    return error instanceof YieldError ? error
      : new YieldError('unavailable', `Decision record could not be saved: ${error instanceof Error ? error.message : String(error)}`)
  }

  private deliveryFailed(pending: PendingYield, error: unknown): void {
    this.fail(pending, new YieldError('unavailable', `Yield delivery failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  private cleanup(pending: PendingYield): void {
    this.pending.delete(pending.request.sessionId)
    this.requests.delete(pending.request.id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)
    this.deps.changed?.(pending.request.sessionId)
  }
}
