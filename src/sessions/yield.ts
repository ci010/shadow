import { randomUUID } from 'node:crypto'
import type { SessionState } from './session-store.ts'
import {
  parseYieldPolicy, parseYieldQuestion,
  type YieldAnswer, type YieldPolicy, type YieldQuestion, type YieldRequest,
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
  assertCanYield?: (id: string) => void
  getState: (id: string) => SessionState | null | undefined
  getPolicy: (id: string) => YieldPolicy
  notifyUser: (request: YieldRequest) => Promise<void>
  notifyParent: (request: YieldRequest) => Promise<void>
}

interface PendingYield {
  request: YieldRequest
  resolve: (answer: YieldAnswer) => void
  reject: (reason: unknown) => void
  signal: AbortSignal
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
  channelUser?: { channel: string; senderId: string }
}

function snapshot(request: YieldRequest): YieldRequest {
  const copy = { ...request, options: [...request.options] as YieldQuestion['options'], recipient: { ...request.recipient } }
  Object.freeze(copy.options)
  Object.freeze(copy.recipient)
  return Object.freeze(copy)
}

function abortError(reason?: string): DOMException {
  return new DOMException(reason ?? 'Yield cancelled.', 'AbortError')
}

/** In-memory coordination only; ordinary session tool-call persistence owns the history. */
export class YieldManager {
  private readonly pending = new Map<string, PendingYield>()
  private readonly requests = new Map<string, PendingYield>()
  private stopped = false

  constructor(private readonly deps: YieldManagerDeps) {}

  start(): void { this.stopped = false }

  async ask(
    sessionId: string,
    question: YieldQuestion,
    signal: AbortSignal,
    channelUser?: { channel: string; senderId: string },
  ): Promise<YieldAnswer> {
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
    const recipient = this.recipient(sessionId)
    if (recipient.kind === 'user' && /^(discord|feishu|qq|wechat):/.test(sessionId) && !channelUser) {
      throw new YieldError('forbidden', 'A channel decision needs an initiating human. Return the blocker instead of publishing an unanswerable question.')
    }
    if (channelUser && (!channelUser.senderId.trim() || !channelUser.channel
      || !sessionId.startsWith(`${channelUser.channel}:`))) {
      throw new YieldError('invalid_request', 'The answering user must belong to this session channel.')
    }
    const now = Date.now()
    const request = snapshot({
      ...parsed, id: randomUUID(), sessionId, recipient,
      createdAt: new Date(now).toISOString(),
      deadline: policy.timeoutMs === null ? null : new Date(now + policy.timeoutMs).toISOString(),
    })

    return new Promise<YieldAnswer>((resolve, reject) => {
      const pending: PendingYield = {
        request, resolve, reject, signal,
        channelUser: channelUser ? { ...channelUser } : undefined,
        onAbort: () => this.fail(pending, signal.reason ?? abortError()),
      }
      this.pending.set(sessionId, pending)
      this.requests.set(request.id, pending)
      signal.addEventListener('abort', pending.onAbort, { once: true })
      if (signal.aborted) {
        pending.onAbort()
        return
      }
      if (policy.timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          if (signal.aborted) pending.onAbort()
          else if (this.requests.get(request.id) === pending) this.complete(pending, request.defaultOption, 'timeout')
        }, policy.timeoutMs)
      }
      // Do not await delivery: cancellation and answers must settle even if delivery hangs.
      // Attach rejection handling immediately, including when delivery throws synchronously.
      try {
        const delivery = recipient.kind === 'user'
          ? this.deps.notifyUser(snapshot(request))
          : this.deps.notifyParent(snapshot(request))
        Promise.resolve(delivery).catch(error => this.deliveryFailed(pending, error))
      } catch (error) {
        this.deliveryFailed(pending, error)
      }
    })
  }

  get(sessionId: string): YieldRequest | null {
    const pending = this.pending.get(sessionId)
    return pending ? snapshot(pending.request) : null
  }

  answerUser(sessionId: string, requestId: string, option: string): YieldAnswer {
    return this.answer(this.userRequest(sessionId, requestId), option, 'user')
  }

  cancelUser(sessionId: string, requestId: string): void {
    this.fail(this.userRequest(sessionId, requestId), abortError('Yield cancelled by user.'))
  }

  answerChannel(sessionId: string, requestId: string, option: string, channel: string, senderId: string): YieldAnswer {
    return this.answer(this.channelRequest(sessionId, requestId, channel, senderId), option, 'user')
  }

  cancelChannel(sessionId: string, requestId: string, channel: string, senderId: string): void {
    this.fail(this.channelRequest(sessionId, requestId, channel, senderId), abortError('Yield cancelled by user.'))
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

  answerParent(parentSessionId: string, requestId: string, option: string): YieldAnswer {
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
    return pending
  }

  private answer(pending: PendingYield, option: string, by: 'user' | 'parent'): YieldAnswer {
    if (typeof option !== 'string' || !pending.request.options.includes(option)) {
      throw new YieldError('invalid_request', 'Answer must exactly match one of the three options.')
    }
    return this.complete(pending, option, by)
  }

  private complete(pending: PendingYield, option: string, answeredBy: YieldAnswer['answeredBy']): YieldAnswer {
    const answer: YieldAnswer = Object.freeze({
      requestId: pending.request.id, option, answeredBy, answeredAt: new Date().toISOString(),
    })
    this.cleanup(pending)
    pending.resolve(answer)
    return answer
  }

  private fail(pending: PendingYield, error: unknown): void {
    if (this.requests.get(pending.request.id) !== pending) return
    this.cleanup(pending)
    pending.reject(error)
  }

  private deliveryFailed(pending: PendingYield, error: unknown): void {
    this.fail(pending, new YieldError('unavailable', `Yield delivery failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  private cleanup(pending: PendingYield): void {
    this.pending.delete(pending.request.sessionId)
    this.requests.delete(pending.request.id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)
  }
}
