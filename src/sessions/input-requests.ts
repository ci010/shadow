import { watchUserWait, type UserWaitPolicy, type PresenceState } from './presence.ts'
import { randomUUID } from 'node:crypto'
import { channelAddressFromSessionId } from '../bus/events.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { SessionState } from './session-store.ts'
import { delegationOwner } from './execution-scope.ts'
import { physicalSessionId } from './session-identity.ts'
import { YieldError } from './yield.ts'
import { inlineInputAnswersSchema, inlineInputQuestionsSchema, inputTextSchema, type InputAnswer, type InputRecord, type InputRequest } from './input-request.ts'
import { answerMediaSchema, MAX_ANSWER_ATTACHMENTS } from './answer-media.ts'
import { supportsInlineAskRound } from '../tools/ask-policy.ts'
import { isImagePath, MAX_TOOL_IMAGES } from '../utils/image-input.ts'
import { workDecisionContextSchema, type WorkDecisionContext } from '../initiatives/work-notes.ts'

interface Dependencies {
  userWait?: (id: string) => UserWaitPolicy
  presence?: (id: string, user?: { channel: string; senderId: string }) => PresenceState
  currentContext?(context: WorkDecisionContext): boolean
  getState(id: string): SessionState | null | undefined
  resolveAgentName?(state: SessionState): string | undefined
  assertAccess(id: string): void
  hasDecision(id: string): boolean
  timeout(id: string): number | null
  changed(id: string): void
  write(record: InputRecord): Promise<void>
  notify(request: InputRequest, context: ExecutionContext): Promise<void>
}
interface Pending {
  request: InputRequest
  context: ExecutionContext
  phase: 'preparing' | 'waiting' | 'settling'
  published?: true
  saved: Promise<void>
  result: ReturnType<typeof Promise.withResolvers<InputAnswer>>
  abort: () => void
  callerController: AbortController
  stopWait?: () => void
  timer?: ReturnType<typeof setTimeout>
  interrupted?: { reason: unknown }
}

/** Ordinary input never enters the decision/approval journal or grants work authority. */
export class InputRequests {
  private pending = new Map<string, Pending>()
  private callers = new Map<string, (question: string, signal: AbortSignal) => Promise<string>>()
  private writes = new Set<Promise<unknown>>()
  private stopped = false

  constructor(private readonly deps: Dependencies) {}
  start(): void { this.stopped = false }
  get(sessionId: string, includePreparing = false): InputRequest | null {
    const pending = [...this.pending.values()].find(item => item.request.sessionId === sessionId)
    return pending && (includePreparing || pending.published) ? structuredClone(pending.request) : null
  }
  has(requestId: string): boolean { return this.pending.has(requestId) }

  bindCaller(sessionId: string, ask: (question: string, signal: AbortSignal) => Promise<string>): () => void {
    if (this.callers.has(sessionId)) throw new YieldError('conflict', 'An input caller is already bound.')
    this.callers.set(sessionId, ask)
    return () => {
      if (this.callers.get(sessionId) !== ask) return
      this.callers.delete(sessionId)
      this.cancelSession(sessionId)
    }
  }

  private assertInlineRound(state: SessionState | null | undefined, context: ExecutionContext): void {
    // Reply addresses can project Web onto event/session inputs; require direct user provenance too.
    if (!state || state.sessionId !== context.sessionId || state.projectId !== context.projectId || state.channelSource || state.channelBoundary
      || state.automation || state.automaticWork || state.statePersistence || state.serviceGeneration
      || (state.parent && state.parent.index === undefined) || this.callers.has(context.sessionId)
      || context.inputSource !== 'user' || context.channelAddress || context.isGroup || context.scriptInvocation || context.memoryAccess
      || !supportsInlineAskRound({ agentName: this.deps.resolveAgentName?.(state), mode: state.mode,
        channel: context.channel, sessionId: state.sessionId, parentSessionId: state.parentSessionId })) {
      throw new YieldError('forbidden', 'Inline rounds require a direct user turn in a root Web general session.')
    }
  }

  async ask(question: string | { questions: unknown }, context: ExecutionContext, workContext?: WorkDecisionContext): Promise<InputAnswer> {
    context.signal.throwIfAborted()
    const sessionId = context.sessionId
    this.deps.assertAccess(sessionId)
    const state = this.deps.getState(sessionId)
    if (!state || this.stopped) throw new YieldError('unavailable', 'Input requester is unavailable.')
    if (state.mode === 'call') throw new YieldError('forbidden', 'Leaf calls cannot ask for input.')
    if (this.get(sessionId, true) || this.deps.hasDecision(sessionId)) throw new YieldError('conflict', 'This session already has a pending question.')
    let questions: InputRequest['questions']
    let text: string
    if (typeof question === 'string') {
      const parsed = inputTextSchema.safeParse(question)
      if (!parsed.success) throw new YieldError('invalid_request', 'Supply a question of 1-4000 characters.')
      text = parsed.data
    } else {
      this.assertInlineRound(state, context)
      const parsed = inlineInputQuestionsSchema.safeParse(question.questions)
      if (!parsed.success) throw new YieldError('invalid_request', 'Supply one to three non-empty questions with exactly two distinct non-empty options each (up to 4000 characters).')
      questions = parsed.data
      text = questions[0].content
    }
    const caller = this.callers.get(sessionId)
    if (context.channel === 'a2a' && !caller) throw new YieldError('unavailable', 'The A2A input caller is no longer available.')
    const parent = delegationOwner(state)
    if (parent && !this.deps.getState(parent)) throw new YieldError('unavailable', 'The input recipient is unavailable.')
    const channel = channelAddressFromSessionId(sessionId)?.platform ?? sessionId.split(':')[0]
    if (!caller && !parent && ['qq', 'discord', 'feishu', 'wechat'].includes(channel)
      && (context.inputSource !== 'user' || context.channel !== channel || !context.senderId?.trim())) {
      throw new YieldError('forbidden', 'A channel input request requires an initiating human.')
    }
    const userWait = !caller && !parent ? this.deps.userWait?.(sessionId) : undefined
    const timeout = userWait ? userWait.timeoutMs : this.deps.timeout(sessionId)
    const request: InputRequest = {
      kind: 'input', id: randomUUID(), sessionId, question: text,
      ...(questions ? { questions } : {}),
      recipient: { kind: caller ? 'caller' : parent ? 'parent' : 'user', sessionId: parent && !caller ? parent : sessionId },
      origin: { physicalId: physicalSessionId(state), ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}) },
      createdAt: new Date().toISOString(), deadline: timeout === null ? null : new Date(Date.now() + timeout).toISOString(),
      ...(workContext ? { workContext: workDecisionContextSchema.parse(workContext) } : {}),
    }
    const result = Promise.withResolvers<InputAnswer>()
    // The ask awaits this promise after publication; cancellation may arrive during persistence.
    void result.promise.catch(() => {})
    const pending: Pending = {
      request, context, result, phase: 'preparing', callerController: new AbortController(),
      saved: this.track(Promise.resolve().then(() => this.deps.write({ version: 1, request }))),
      abort: () => { void this.close(pending, context.signal.reason).catch(error => console.error('[input] Could not record cancellation', error)) },
    }
    this.pending.set(request.id, pending)
    context.signal.addEventListener('abort', pending.abort, { once: true })
    if (context.signal.aborted) pending.abort()
    try {
      await pending.saved
      if (pending.phase === 'preparing') {
        if (request.workContext && this.deps.currentContext?.(request.workContext) === false) {
          await this.close(pending, new YieldError('conflict', 'The goal path changed while opening this input request. Re-evaluate its premise.'))
          return result.promise
        }
        pending.phase = 'waiting'
        pending.published = true
        this.deps.changed(sessionId)
        if (timeout !== null) pending.timer = setTimeout(() => {
          void this.close(pending, new YieldError('unavailable', 'Input deadline expired without an answer.'))
            .catch(error => console.error('[input] Could not record timeout', error))
        }, Math.max(0, Date.parse(request.deadline!) - Date.now()))
        if (userWait) pending.stopWait = watchUserWait(userWait,
          () => this.deps.presence?.(sessionId, { channel: context.channel, senderId: context.senderId }) ?? 'unknown',
          () => { if (pending.phase === 'waiting') void this.close(pending, new YieldError('unavailable', 'No human input received; no answer or approval was supplied.'))
            .catch(error => console.error('[input] Could not record unavailable input', error)) })
        if (caller) {
          void Promise.resolve().then(() => {
            pending.callerController.signal.throwIfAborted()
            return caller(request.question, pending.callerController.signal)
          }).then(
            answer => this.complete(pending, answer, 'caller'),
            error => this.close(pending, error),
          ).catch(error => {
            void this.close(pending, error).catch(cause => console.error('[input] Could not record caller failure', cause))
          })
        } else {
          void Promise.resolve().then(() => {
            context.signal.throwIfAborted()
            if (pending.phase !== 'waiting') return
            return this.deps.notify(structuredClone(request), context)
          }).catch(error =>
            this.close(pending, error)).catch(error => console.error('[input] Could not record delivery failure', error))
        }
      }
    } catch (error) {
      this.cleanup(pending)
      result.reject(error)
    }
    return result.promise
  }

  replyParent(sessionId: string, requestId: string, text: string): Promise<InputAnswer> {
    this.deps.assertAccess(sessionId)
    const pending = this.find(requestId)
    if (pending.request.recipient.kind !== 'parent' || pending.request.recipient.sessionId !== sessionId
      || !this.deps.getState(sessionId) || delegationOwner(this.deps.getState(pending.request.sessionId)) !== sessionId) {
      throw new YieldError('forbidden', 'Only the stored parent may reply to this input request.')
    }
    return this.complete(pending, text, 'parent')
  }

  private user(sessionId: string, requestId: string, channel?: string, senderId?: string): Pending {
    const pending = this.find(requestId)
    if (pending.request.sessionId !== sessionId || pending.request.recipient.kind !== 'user'
      || !this.deps.getState(sessionId) || delegationOwner(this.deps.getState(sessionId))) {
      throw new YieldError('forbidden', 'Only the requesting root session user may reply.')
    }
    if (channel !== undefined && (pending.context.inputSource !== 'user'
      || pending.context.channel !== channel || pending.context.senderId !== senderId)) {
      throw new YieldError('forbidden', 'Only the initiating channel user may reply.')
    }
    this.deps.assertAccess(sessionId)
    return pending
  }
  replyUser(sessionId: string, requestId: string, text: string, channel?: string, senderId?: string, media?: string[]): Promise<InputAnswer> {
    return this.complete(this.user(sessionId, requestId, channel, senderId), text, 'user', media)
  }
  async replyUserRound(sessionId: string, requestId: string, answers: unknown,
    validateMedia: (media: string[]) => Promise<void>): Promise<InputAnswer> {
    const pending = this.user(sessionId, requestId)
    const questions = pending.request.questions
    if (!questions) throw new YieldError('invalid_request', 'This input request requires a text reply, not a round.')
    this.assertInlineRound(this.deps.getState(sessionId), pending.context)
    const parsed = inlineInputAnswersSchema.safeParse(answers)
    if (!parsed.success || parsed.data.length !== questions.length) {
      throw new YieldError('invalid_request', 'Supply exactly one option or non-empty custom answer for each question in order.')
    }
    const text = parsed.data.map((answer, index) => {
      if ('text' in answer) return answer.text
      if (!questions[index].options.includes(answer.option)) {
        throw new YieldError('invalid_request', `Answer ${index + 1} must match one of its exact options.`)
      }
      return answer.option
    }).join('\n')
    const media = parsed.data.flatMap(answer => 'text' in answer ? answer.media ?? [] : [])
    if (media.length > MAX_ANSWER_ATTACHMENTS) throw new YieldError('invalid_request', 'Too many answer attachments in this round.')
    if (media.filter(isImagePath).length > MAX_TOOL_IMAGES) {
      throw new YieldError('invalid_request', `An inline round supports at most ${MAX_TOOL_IMAGES} image attachments.`)
    }
    if (media.length) {
      await validateMedia(media)
      // Upload validation crosses an async boundary; recheck ownership, deadline and pending phase.
      this.user(sessionId, requestId)
      this.assertInlineRound(this.deps.getState(sessionId), pending.context)
    }
    return this.settle(pending, { answeredBy: 'user', text, answers: parsed.data, ...(media.length ? { media } : {}) })
  }
  cancelUser(sessionId: string, requestId: string, channel?: string, senderId?: string): Promise<void> {
    return this.close(this.user(sessionId, requestId, channel, senderId), new DOMException('Input cancelled by user.', 'AbortError'))
  }
  async invalidatePending(sessionId: string, requestId: string, reason: string): Promise<void> {
    const pending = this.pending.get(requestId)
    if (pending?.request.sessionId === sessionId) await this.close(pending, new YieldError('conflict', reason))
  }
  cancelSession(sessionId: string): void {
    for (const pending of this.pending.values()) if (pending.request.sessionId === sessionId
      || pending.request.recipient.kind === 'parent' && pending.request.recipient.sessionId === sessionId) {
      void this.close(pending, new DOMException('Input session stopped.', 'AbortError'))
        .catch(error => console.error('[input] Could not record stopped request', error))
    }
  }
  stop(): void {
    this.stopped = true
    for (const pending of this.pending.values()) this.cancelSession(pending.request.sessionId)
  }
  async settled(): Promise<void> { while (this.writes.size) await Promise.allSettled([...this.writes]) }

  private find(id: string): Pending {
    const pending = this.pending.get(id)
    if (!pending) throw new YieldError('not_found', 'Input request is no longer pending.')
    if (pending.phase !== 'waiting') throw new YieldError('conflict', 'Input request is being recorded or answered.')
    pending.context.signal.throwIfAborted()
    if (pending.request.workContext && this.deps.currentContext?.(pending.request.workContext) === false) {
      throw new YieldError('conflict', 'The goal path changed. This input request is no longer current.')
    }
    if (pending.request.deadline && Date.now() >= Date.parse(pending.request.deadline)) {
      throw new YieldError('unavailable', 'Input deadline expired without an answer.')
    }
    return pending
  }
  private complete(pending: Pending, text: string, answeredBy: InputAnswer['answeredBy'], media?: string[]): Promise<InputAnswer> {
    this.find(pending.request.id)
    if (pending.request.questions) throw new YieldError('invalid_request', 'This inline round requires a complete answers array.')
    const parsed = inputTextSchema.safeParse(text)
    if (!parsed.success) throw new YieldError('invalid_request', 'Reply must contain 1-4000 characters.')
    const attachments = media === undefined ? undefined : answerMediaSchema.safeParse(media)
    if (attachments && !attachments.success) throw new YieldError('invalid_request', 'Invalid answer attachments.')
    return this.settle(pending, { text: parsed.data, answeredBy, ...(attachments?.data ? { media: attachments.data } : {}) })
  }
  private settle(pending: Pending, payload: Omit<InputAnswer, 'requestId' | 'answeredAt'>): Promise<InputAnswer> {
    pending.phase = 'settling'
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    const { text, answeredBy, ...details } = payload
    const answer: InputAnswer = { requestId: pending.request.id, text, answeredBy, answeredAt: new Date().toISOString(), ...details }
    return this.track(Promise.resolve().then(() => this.deps.write({ version: 1, request: pending.request, answer })).then(() => {
      this.cleanup(pending)
      if (pending.interrupted) pending.result.reject(pending.interrupted.reason)
      else pending.result.resolve(answer)
      return answer
    }, error => { this.cleanup(pending); pending.result.reject(error); throw error }))
  }
  private close(pending: Pending, error: unknown): Promise<void> {
    if (this.pending.get(pending.request.id) !== pending) return Promise.resolve()
    pending.callerController.abort(error)
    if (pending.phase === 'settling') {
      if (!(error instanceof YieldError && error.code === 'unavailable')) pending.interrupted ??= { reason: error }
      return Promise.resolve()
    }
    pending.phase = 'settling'
    return this.track((async () => {
      try {
        await pending.saved
        await this.deps.write({ version: 1, request: pending.request, closed: {
          status: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
          message: error instanceof Error ? error.message : String(error), at: new Date().toISOString(),
        } })
        pending.result.reject(error)
      } catch (cause) { pending.result.reject(cause); throw cause }
      finally { this.cleanup(pending) }
    })())
  }
  private cleanup(pending: Pending): void {
    pending.stopWait?.()
    this.pending.delete(pending.request.id)
    pending.callerController.abort(new DOMException('Input request settled.', 'AbortError'))
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.context.signal.removeEventListener('abort', pending.abort)
    this.deps.changed(pending.request.sessionId)
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.writes.add(operation)
    void operation.then(() => this.writes.delete(operation), () => this.writes.delete(operation))
    return operation
  }
}
