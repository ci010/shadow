import type { Executor } from '../execution/executor.ts'
import type { ToolBridgeFactory } from '../script-runtime/bridge.ts'
import { cleanupTempFiles } from '../utils/paths.ts'
import { physicalSessionId } from './session-identity.ts'
import { inputContent, sessionReplyAddress, type SessionInput, type SessionMessageInput } from './input.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { estimateTokens } from '../utils/estimate-tokens.ts'
import { Span } from '../otel/tracing.ts'
import { errDetail, errMsg } from '../utils/truncate.ts'
import type { Bus } from '../bus/bus.ts'
import type { CompactResult, HandoffManager } from './handoff/manager.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import { withCurrentWork } from '../agent/context/builder.ts'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import type { SessionStore } from './session-store.ts'
import type { SessionStartEvent, SessionState } from './session-store.ts'
import type { SessionTools } from '../tools/registry.ts'
import { BaseSession } from './base-session.ts'
import {
  resolveSessionLocations,
  type WorkdirCapabilityLookup,
} from './locality.ts'
import { SessionResumeError } from './recovery.ts'
import type { PromptCaptureStore } from './prompt-capture.ts'

/** Tracks whether the LLM loop is calling the provider or executing tools. */
export type TurnPhase = 'llm' | 'tool'

export interface PhaseRef {
  current: TurnPhase
  /** Timestamp (Date.now()) when the current tool execution started. */
  toolStartedAt?: number
}

/** Tool execution shorter than this (ms) always steers; longer triggers quickModel classification. */
const TOOL_STEER_THRESHOLD_MS = 20_000 // 20 seconds

type LoopEvent =
  | { type: 'message'; msg: SessionInput; llm: LlmRuntimeConfig }
  | { type: 'sleep'; llm: LlmRuntimeConfig }
  | { type: 'compact'; llm: LlmRuntimeConfig }
  | { type: 'realign'; apply: () => Promise<void> }

export class Session extends BaseSession {
  private running = false
  private inbox: LoopEvent[] = []
  private inboxWaiter: ((event: LoopEvent) => void) | null = null
  private stopController = new AbortController()
  private readonly stopped: Promise<void>
  private promptRevision = 0
  private builtPromptRevision = 0

  get completion(): Promise<void> { return this.stopped }
  get accepting(): boolean { return !this.stopController.signal.aborted }
  get quiescent(): boolean { return this.inboxWaiter !== null && this.inbox.length === 0 && this.turn === null }

  // ── Active turn state ─────────────────────────────────────────────────
  private turn: SessionTurn | null = null

  /** Debounced sleep timer — fires at lastActivity + inactivityMs. */
  private sleepTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    workspace: string,
    id: string,
    state: SessionState,
    messages: ChatMessage[],
    provider: LLMProvider,
    tools: SessionTools,
    bus: Bus,
    store: SessionStore,
    private readonly handoffManager: HandoffManager,
    private readonly onStopped: (sessionId: string) => void,
    private readonly rebuildSystemPrompt?: () => Promise<string>,
    private readonly quickModel?: string,
    private readonly sleepInactivityMs?: number,
    workdirCapabilityLookup?: WorkdirCapabilityLookup,
    remoteExecutor?: Executor,
    evalBridge?: ToolBridgeFactory,
    promptCaptures?: PromptCaptureStore,
  ) {
    super(
      workspace,
      id,
      state,
      messages,
      provider,
      tools,
      bus,
      store,
      workdirCapabilityLookup,
      remoteExecutor,
      evalBridge,
      promptCaptures,
    )
    this.stopped = this.run()
    this.stopped.catch((err) =>
      console.error(`[session-manager] Session ${id} crashed:`, errMsg(err))
    )
  }

  // ── Public API ──────────────────────────────────────────────────────────

  invalidateSystemPrompt(): void {
    this.promptRevision++
  }

  /** Current turn phase: idle (no turn), llm (waiting on LLM), or tool (executing tools). */
  get phase(): 'idle' | 'llm' | 'tool' {
    if (!this.turn) return 'idle'
    return this.turn.toolStartedAt ? 'tool' : 'llm'
  }

  /** Channel correlation or event input ID, never inferred from a session ID. */
  get activeRequestId(): string | undefined {
    return this.turn?.message.replyTo?.platformMessageId ?? this.turn?.message.id
  }

  /** Push a message into this session's inbox or handle it mid-turn. */
  dispatch(msg: SessionInput, llm: LlmRuntimeConfig): void {
    if (!this.accepting) throw new Error(`Session ${this.id} is stopped`)
    if (msg.kind === 'control' && msg.command.type === 'resume' && !this.quiescent) {
      throw new SessionResumeError('The conversation has active or queued work. Wait before continuing.')
    }
    // Cancel sleep timer — we have work.
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer)
      this.sleepTimer = null
    }

    if (msg.kind === 'control') {
      if (msg.command.type === 'cancel') {
        this.cancel()
        this.scheduleSleepCheck(llm)
      }
      else if (msg.command.type === 'compact') this.requestCompact(llm)
      else {
        // Retry replays history, never a steerable prompt. Interrupt an active
        // provider request, but let running tools finish/persist their results.
        if (this.turn && !this.turn.toolStartedAt) this.turn.abort()
        this.pushEvent({ type: 'message', msg, llm })
      }
      return
    }

    // Silent / non-urgent events never interrupt an active turn: enqueue them
    // so they are handled (or, for silent, merely recorded) after this turn.
    if (
      msg.policy === 'silent' || msg.policy === 'queue' ||
      (this.id === 'web:orchestrator' && msg.source.kind !== 'user')
    ) {
      this.pushEvent({ type: 'message', msg, llm })
      return
    }

    // If no turn is active, push straight to inbox.
    if (!this.turn) {
      this.pushEvent({ type: 'message', msg, llm })
      return
    }

    if (msg.policy === 'next-step') {
      this.turn.steerQueue.push(msg)
      return
    }

    if (!this.turn.toolStartedAt) {
      this.turn.abort()
      console.log(
        `[session-loop] Aborting ${this.id} turn for new message during llm request phase`,
      )
      this.pushEvent({ type: 'message', msg, llm })
      return
    }

    // Tool phase. A declared `steering` event skips the quickModel classifier
    // and steers into the active turn deterministically.
    if (msg.policy === 'steering') {
      console.log(
        `[session-loop] Steering ${this.id} declared-urgent event into active turn`,
      )
      this.turn.steerQueue.push(msg)
      return
    }

    const elapsed = Date.now() - this.turn.toolStartedAt
    if (elapsed < TOOL_STEER_THRESHOLD_MS || !this.quickModel) {
      console.log(
        `[session-loop] Steering ${this.id} message into active turn during tool phase (elapsed ${elapsed}ms)`,
      )
      this.turn.steerQueue.push(msg)
      return
    }

    // Long-running tool with quickModel — classify intent.
    // Abort any in-flight classification so the newest message wins.
    if (this.turn.classifyAbortController) {
      this.turn.classifyAbortController.abort()
    }
    const controller = new AbortController()
    this.turn.classifyAbortController = controller
    const capturedTurn = this.turn

    console.log(
      `[session-loop] Classifying message intent with quickModel during tool phase (elapsed ${elapsed}ms):`,
      {
        session: this.id,
        elapsed,
      },
    )
    this.classifyToolIntent(
      msg,
      capturedTurn.message,
      controller.signal,
    )
      .then((intent) => {
        if (!this.accepting) return
        if (this.turn?.classifyAbortController !== controller) {
          console.log(
            `[session-loop] Turn changed during intent classification — defaulting to inbox for message:`,
            {
              session: this.id,
            },
          )
          this.pushEvent({ type: 'message', msg, llm })
          return
        }
        if (intent === 'abort') {
          this.turn.abort()
          console.log(
            `[session-loop] Classified intent as ABORT — aborting turn for message:`,
            {
              session: this.id,
            },
          )
          this.pushEvent({ type: 'message', msg, llm })
        } else {
          console.log(
            `[session-loop] Classified intent as STEER — steering into active turn for message:`,
            {
              session: this.id,
            },
          )
          capturedTurn.steerQueue.push(msg)
        }
      })
      .catch((err) => {
        if (!this.accepting) return
        console.warn(
          '[session-loop] classifyToolIntent error, falling back to steer:',
          errMsg(err),
        )
        if (this.turn === capturedTurn) {
          capturedTurn.steerQueue.push(msg)
        } else {
          this.pushEvent({ type: 'message', msg, llm })
        }
      })
  }

  /** Trigger compaction manually (routed through the event loop to avoid races). */
  requestCompact(llm: LlmRuntimeConfig): void {
    this.pushEvent({ type: 'compact', llm })
  }

  /** Runs between turns, preserving already admitted inputs and in-flight tool results. */
  requestRealignment(apply: () => Promise<void>): void {
    if (!this.accepting) throw new Error('Session is stopping.')
    const event: LoopEvent = { type: 'realign', apply }
    if (this.inboxWaiter) this.pushEvent(event)
    else this.inbox.unshift(event)
  }

  async replaceWorkContext(prompt: string, transitionId: string): Promise<void> {
    if (this.turn) throw new Error('Work context replacement requires a tool-safe boundary.')
    const previous = physicalSessionId(this.state)
    const timestamp = new Date().toISOString()
    const next = { ...this.state, segmentIndex: this.state.segmentIndex + 1, contextResetAt: timestamp,
      lastKnownTokens: 0, lastActivityAt: timestamp, recovery: undefined, preloadTools: undefined }
    const target = physicalSessionId(next)
    const system = this.rebuildSystemPrompt ? await this.rebuildSystemPrompt()
      : this.messages.find(message => message.role === 'system')?.content
    if (typeof system !== 'string') throw new Error('Cannot rebuild the work context.')
    await this.store.createSessionLog(target, [{
      sessionId: this.id, physicalIdVersion: next.physicalIdVersion, previous_physical_id: previous,
      timestamp, context_reset: true, work_transition_id: transitionId, summary_context: prompt,
    }])
    try { await this.store.saveState(this.id, next) }
    catch (error) {
      try { await this.store.deleteSessionLog(target) }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Work context publication and cleanup failed.') }
      throw error
    }
    Object.assign(this.state, next)
    this.messages = [{ role: 'system', content: system }, { role: 'user', name: '__work_handoff__', content: prompt }]
    this.usage = undefined
    this.clearReadCache()
    await this.tools.resetDynamicAndWait()
    this.bus.emit('session.handoff', { sessionId: this.id, sourceSessionId: previous, targetSessionId: target })
  }

  /** Cancel only the active turn; already queued inputs remain admitted. */
  cancel(): void {
    this.turn?.abort()
  }

  /**
   * Start the per-session event loop.
   * Returns a promise that resolves when the loop stops (sleep timeout or
   * explicit {@link stop}).
   */
  private async run(): Promise<void> {
    this.running = true
    console.debug(`[session-loop] Started: ${this.id}`)

    while (this.running) {
      let event: LoopEvent
      try {
        event = await this.consumeEvent()
        if (!this.accepting) break
      } catch {
        // consumeEvent rejects when stopController aborts — exit the loop.
        break
      }

      try {
        if (event.type === 'realign') {
          await event.apply()
        } else if (event.type === 'sleep') {
          await this.sleep(event.llm)
          // If messages arrived during compaction, keep running to process them.
          if (this.inbox.length > 0) continue
          this.stop()
          break
        } else if (event.type === 'compact') {
          await this.compact(event.llm)
        } else {
          this.turn = new SessionTurn(event.msg)
          this.activityChanged()
          await this.processInput(
            this.turn.message,
            event.llm,
            this.turn.abortController.signal,
          ).finally(() => {
            const turn = this.turn
            turn?.finish()
            // Steering admitted while a provider/tool was aborting still needs
            // its own turn if it was never consumed by the active one.
            if (this.accepting && turn) {
              this.inbox.unshift(...turn.steerQueue.map((msg): LoopEvent => ({
                type: 'message', msg, llm: event.llm,
              })))
            }
            this.turn = null
            this.activityChanged()
          })
        }
      } catch (err) {
        console.error(errDetail(err), `[session-loop] Error in ${this.id}`)
        if (event.type === 'realign') {
          const reply = sessionReplyAddress(this.id)
          this.bus.emit('message.outbound', {
            event: 'response', channel: reply?.channel ?? 'system', chatId: reply?.chatId ?? this.id,
            channelAddress: reply?.channelAddress, done: true,
            content: `Work transition remains pending: ${errMsg(err)}. Inspect work state and retry; no successful replacement is implied.`,
          })
        }
      }

      // After processing, if no queued messages remain start the sleep timer.
      if (this.inbox.length === 0 && event.type !== 'realign') {
        this.scheduleSleepCheck(event.llm)
      }
    }

    console.debug(`[session-loop] Stopped: ${this.id}`)
    this.clearReadCache()
    this.tools.resetDynamic()
    this.onStopped(this.id)
  }

  /** Signal the loop to stop. */
  stop(): void {
    this.running = false
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer)
      this.sleepTimer = null
    }
    this.stopController.abort()
    this.turn?.abort()
    this.inbox = []
  }

  // ── BaseSession overrides ─────────────────────────────────────────────

  protected override async appendMessages(
    llm: LlmRuntimeConfig,
    ...messages: ChatMessage[]
  ): Promise<void> {
    if (messages.length === 0) return

    // Check if we need compaction
    const usage = this.usage
    if (usage) {
      const totalTokens = usage.totalTokens
      this.state.lastKnownTokens = totalTokens
      await this.saveState()

      const extra = estimateTokens(messages)

      // Never compact in the middle of a tool call / result cycle.
      const hasToolResults = messages.some((m) => m.role === 'tool')
      const hasPendingToolCalls = messages.some((m) =>
        m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
      )

      if (
        !hasToolResults && !hasPendingToolCalls &&
        this.handoffManager.shouldHandoff(usage, true, extra)
      ) {
        await this.compact(llm)
      }
    }

    await super.appendMessages(llm, ...messages)
    this.scheduleSleepCheck(llm)
  }

  protected async saveState(): Promise<void> {
    await this.store.saveState(this.id, this.state)
  }

  protected override async drainPendingMessages(
    llm: LlmRuntimeConfig,
  ): Promise<void> {
    if (!this.turn) return
    const locations = resolveSessionLocations(
      this.workspace,
      this.state,
      undefined,
      this.workdirCapabilityLookup,
    )
    if (!locations.workdir.available) {
      throw new Error(
        `Session workdir unavailable: ${locations.workdir.reason}`,
      )
    }
    const cwd = locations.workdir.locality === 'local'
      ? locations.workdir.path
      : locations.sessionDataDir
    while (this.turn.steerQueue.length > 0) {
      const steerQueue = this.turn.steerQueue
      this.turn.steerQueue = []
      await this.appendMessages(
        llm,
        ...await Promise.all(
          steerQueue.map((m) => buildUserChatMessage(m, this.workspace, cwd)),
        ),
      )
      if (this.responseContext && steerQueue.some(input => input.source.kind === 'user')) {
        this.responseContext = { ...this.responseContext, userInvolved: true }
      }
    }
    while (this.rebuildSystemPrompt && this.builtPromptRevision !== this.promptRevision) {
      const revision = this.promptRevision
      const content = await this.rebuildSystemPrompt()
      const message: ChatMessage = { role: 'system', content }
      if (this.messages[0]?.role === 'system') this.messages[0] = message
      else this.messages.unshift(message)
      this.builtPromptRevision = revision
    }
  }

  protected override onToolPhaseStart(): void {
    if (this.turn) this.turn.toolStartedAt = Date.now()
    this.activityChanged()
  }

  protected override onToolPhaseEnd(): void {
    if (this.turn) this.turn.toolStartedAt = undefined
    this.activityChanged()
  }

  protected override async handleTokenLimitExceeded(
    llm: LlmRuntimeConfig,
  ): Promise<boolean> {
    console.warn(`[${this.id}] Token limit exceeded, compacting session`)
    await this.compact(llm)
    return true
  }

  // ── Inbox helpers ──────────────────────────────────────────────────────

  private pushEvent(event: LoopEvent): void {
    if (!this.accepting) return
    if (this.inboxWaiter) {
      const waiter = this.inboxWaiter
      this.inboxWaiter = null
      waiter(event)
    } else {
      this.inbox.push(event)
    }
  }

  private consumeEvent(): Promise<LoopEvent> {
    if (!this.accepting) return Promise.reject(new Error('Session stopped'))
    const buffered = this.inbox.shift()
    if (buffered) return Promise.resolve(buffered)

    return new Promise<LoopEvent>((resolve, reject) => {
      const abort = () => {
        this.inboxWaiter = null
        reject(new Error('Session stopped'))
      }
      this.inboxWaiter = (event) => {
        this.stopController.signal.removeEventListener('abort', abort)
        resolve(event)
      }
      this.stopController.signal.addEventListener('abort', abort, { once: true })
    })
  }

  // ── Sleep ───────────────────────────────────────────────────────────────

  @Span('session.sleep')
  private async sleep(llm: LlmRuntimeConfig): Promise<void> {
    try {
      if (this.state.recovery) return
      const messages = this.messages
      console.info(
        `[sleep] Putting session to sleep: ${this.id} (${messages.length} messages)`,
      )

      // Compact if token usage exceeds handoff threshold
      const tokens = this.state.lastKnownTokens ?? 0
      const usage = {
        promptTokens: tokens,
        completionTokens: 0,
        totalTokens: tokens,
      }
      if (this.handoffManager.shouldHandoff(usage, false)) {
        await this.compact(llm)
        console.info(`[sleep] Session compacted (cold): ${this.id}`)
      }

      // Session memory (summary) is intentionally retained across sleep so the
      // session can resume with its context (MEM.md: under-threshold sleep only
      // flushes, keeps state). Modified Files / conventions live in separate
      // files and always persist.

      this.tools.resetDynamic()
      this.clearReadCache()
      await cleanupTempFiles(this.workspace, 15 * 60_000)
    } catch (err) {
      console.error(
        `[session-loop] sleepSession failed for ${this.id}:`,
        errMsg(err),
      )
    }
  }

  // ── Long-running tool intent classification ─────────────────────────────

  private async classifyToolIntent(
    msg: SessionMessageInput,
    previousMsg: SessionInput | undefined,
    signal: AbortSignal,
  ): Promise<'steer' | 'abort'> {
    const model = this.quickModel
    if (!model) return 'steer'

    const systemPrompt = [
      'You are a concurrency router for a chat bot.',
      'A tool call is currently running. A new user message has arrived.',
      'Decide: should the new message be injected into the current turn (steer),',
      'or should the current work be aborted to handle the new message (abort)?',
      '',
      'Respond with exactly one word: steer or abort.',
    ].join('\n')

    const content = [
      ...(previousMsg
        ? [
          `Previous message (currently being processed): ${inputContent(previousMsg)}`,
          '',
        ]
        : []),
      `New message: ${msg.content}`,
    ].join('\n')

    const combined = AbortSignal.any([signal, AbortSignal.timeout(5000)])

    try {
      const response = await this.provider.chat(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
        [],
        {
          model,
          maxTokens: 10,
          temperature: 0,
          signal: combined,
        },
      )
      const word = (response.content ?? '').trim().toLowerCase().replace(
        /[^a-z]/g,
        '',
      )
      if (word === 'abort' || word === 'steer') return word
      console.warn(
        `[session-loop] classifyToolIntent unexpected: "${response.content}", falling back to steer`,
      )
      return 'steer'
    } catch (err) {
      console.warn(
        '[session-loop] classifyToolIntent failed, falling back to steer:',
        errMsg(err),
      )
      return 'steer'
    }
  }

  /**
   * Synthesize a compact continuity context and persist it as a handoff snapshot.
   */
  private async compact(llm: LlmRuntimeConfig): Promise<CompactResult> {
    await this.tools.boundary?.beforeInference(this.stopController.signal)
    const sessionId = this.id
    const state = this.state
    const work = this.tools.getWorkGuard()?.prompt(this.id)
    const messages = work ? this.messages.map((message, index) => index === 0 && message.role === 'system'
      ? { ...message, content: withCurrentWork(String(message.content ?? ''), work) } : message) : this.messages

    const sourcePhysicalId = physicalSessionId(state)
    const targetPhysicalId = physicalSessionId(state, state.segmentIndex + 1)
    const handoff = await this.handoffManager.create(
      sessionId,
      sourcePhysicalId,
      targetPhysicalId,
      messages,
      llm.model,
      this.tools.boundary,
      this.state,
    )
    this.tools.boundary?.assertCurrent()

    const startEvent: SessionStartEvent = {
      sessionId,
      physicalIdVersion: state.physicalIdVersion,
      previous_physical_id: sourcePhysicalId,
      timestamp: handoff.timestamp,
      summary_context: handoff.prompt,
    }
    await this.store.createSessionLog(targetPhysicalId, [startEvent])

    this.state.segmentIndex++
    // Regenerate system prompt so it reflects current time/context
    const newMessages: ChatMessage[] = []
    if (this.rebuildSystemPrompt) {
      try {
        const systemPrompt = await this.rebuildSystemPrompt()
        newMessages.push({ role: 'system', content: systemPrompt })
      } catch (err) {
        if (this.tools.boundary) throw err
        // Fall back to preserving the existing system prompt
        const existing = this.messages.find((m) => m.role === 'system')
        if (existing) newMessages.push(existing)
        console.warn(
          `[session] Failed to rebuild system prompt: ${errMsg(err)}`,
        )
      }
    } else {
      const existing = this.messages.find((m) => m.role === 'system')
      if (existing) newMessages.push(existing)
    }
    newMessages.push({ role: 'user', content: handoff.prompt })
    this.messages = newMessages
    // Previous usage describes the old segment, not the continuation prompt.
    this.usage = undefined
    this.state.lastKnownTokens = 0
    await this.saveState()

    this.bus.emit('session.handoff', {
      sessionId: this.id,
      sourceSessionId: sourcePhysicalId,
      targetSessionId: targetPhysicalId,
    })

    return handoff
  }

  // ── Debounced sleep check ──────────────────────────────────────────────

  /**
   * (Re)schedule the sleep timer. Fires at
   * `lastActivityAt + sleepInactivityMs`; puts the session to sleep
   * (compacts if over threshold; session memory is retained).
   */
  private scheduleSleepCheck(llm: LlmRuntimeConfig): void {
    if (!this.sleepInactivityMs || !this.accepting || this.turn || this.inbox.length) return
    if (this.sleepTimer) clearTimeout(this.sleepTimer)

    const lastActive = this.state.lastActivityAt
      ? new Date(this.state.lastActivityAt).getTime()
      : Date.now()
    const delay = Math.max(
      0,
      (lastActive + this.sleepInactivityMs) - Date.now(),
    )

    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null
      this.pushEvent({ type: 'sleep', llm })
    }, delay)
  }
}

class SessionTurn {
  abortController: AbortController = new AbortController()
  steerQueue: SessionMessageInput[] = []
  toolStartedAt?: number
  message: SessionInput
  classifyAbortController: AbortController | null = null

  constructor(currentMsg: SessionInput) {
    this.message = currentMsg
  }

  finish(): void {
    if (this.classifyAbortController) {
      this.classifyAbortController.abort()
    }
  }

  abort(): void {
    this.classifyAbortController?.abort()
    this.abortController.abort()
  }
}
