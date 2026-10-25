import { prepareWorkingContext } from '../agent/context/working-context.ts'
import { withRateLimitWaiting, type RateLimitWait } from '../providers/retry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import { InferenceBudget } from '../agent/context/execution-budget.ts'
import { runtimeContextEvent } from './runtime-context-event.ts'
import { createNodeInference } from '../script-runtime/infer.ts'
import { continuedUserInvolvement, createResponseContext, reconcileResponseContinuity, type ResponseContext } from './response-context.ts'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import { mkdir } from 'node:fs/promises'
import type { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import {
  inputContext,
  retryMessage,
  type SessionInput,
  type SessionTurnFact,
} from './input.ts'
import {
  type ChatMessage,
  type ContentPart,
  type LLMProvider,
  type LLMResponseUsage,
  type ToolCall,
  isContextSizeError,
} from '../providers/provider.ts'
import type { SessionTools } from '../tools/registry.ts'
import { toolResultText, transientToolSummary, type ToolDefinition, type ToolResult } from '../tools/tool.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'
import { activeSpan, Span, spanAttributes, uspan } from '../otel/tracing.ts'
import { physicalSessionId } from './session-identity.ts'
import { readSessionFileChange } from './file-changes.ts'
import { groupTools } from '../utils/tools-group.ts'
import { errDetail, errMsg } from '../utils/truncate.ts'
import type { SessionStore } from './session-manager.ts'
import {
  resolveSessionLocations,
  type WorkdirCapabilityLookup,
} from './locality.ts'
import type { SessionState, StoredMessage } from './session-store.ts'
import type { Executor } from '../execution/executor.ts'
import type { ToolBridgeFactory } from '../script-runtime/bridge.ts'
import { ReadTool } from '../tools/read.ts'
import { pendingToolCalls } from './recovery.ts'
import type { PromptCaptureStore } from './prompt-capture.ts'
import { saveToolImages } from './tool-images.ts'
import { modelMessages } from '../providers/message-content.ts'
import { usageProvider } from './usage.ts'
import { providerFailureKind, type ProviderFailureKind } from '../providers/provider.ts'

/**
 * Shared base for all session types.
 *
 * Contains the core LLM ↔ tool loop, message persistence, and public state
 * accessors.  Subclasses add lifecycle-specific behaviour (event loop with
 * steering for {@link Session}, fire-and-forget for {@link EphemeralSession}).
 */
export abstract class BaseSession {
  protected usage: LLMResponseUsage | undefined
  protected responseContext: ResponseContext | undefined
  private messagePersistenceFailed = false
  private boundedSystemTask = false
  private providerFailure?: ProviderFailureKind
  private providerWaiting?: RateLimitWait
  get rateLimitWait(): RateLimitWait | undefined { return this.providerWaiting }

  constructor(
    protected readonly workspace: string,
    readonly id: string,
    protected state: SessionState,
    protected messages: ChatMessage[],
    protected readonly provider: LLMProvider,
    protected readonly tools: SessionTools,
    protected readonly bus: Bus,
    protected readonly store: SessionStore,
    protected readonly workdirCapabilityLookup?: WorkdirCapabilityLookup,
    protected readonly remoteExecutor?: Executor,
    protected readonly evalBridge?: ToolBridgeFactory,
    protected readonly promptCaptures?: PromptCaptureStore,
  ) {
    this.provider = usageProvider(provider, store, () => this.usageDestination)
  }

  protected get usageDestination(): { sessionId: string; physicalId: string } {
    return { sessionId: this.id, physicalId: this.physicalSessionId }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** The current physical session ID (segment in the handoff chain). */
  get physicalSessionId(): string {
    return physicalSessionId(this.state)
  }

  /** The current conversation history (cached in-memory). */
  get history(): ChatMessage[] {
    return this.messages
  }

  /** The cached session state. */
  getState(): SessionState {
    return this.state
  }

  getTools(): ToolDefinition[] {
    return this.tools.getDefinitions()
  }

  protected clearReadCache(): void {
    const read = this.tools.get('read')
    if (read instanceof ReadTool) read.clearSession(this.physicalSessionId)
  }

  // ── Protected persistence ───────────────────────────────────────────────

  /**
   * Append messages to the in-memory history and persist to disk.
   * Subclasses may override to add compaction checks (see {@link Session}).
   */
  protected async appendMessages(
    llm: LlmRuntimeConfig,
    ...messages: ChatMessage[]
  ): Promise<void> {
    await this.persistMessages(llm, ...messages)
  }

  private async persistMessages(
    _llm: LlmRuntimeConfig,
    ...messages: ChatMessage[]
  ): Promise<void> {
    if (messages.length === 0) return
    if (messages.some(message => message.role === 'user')) await this.ensureWorkingContext()
    const now = new Date().toISOString()
    const stampedMessages = messages.map(message => ({ ...message, timestamp: now }))
    this.messages.push(...stampedMessages)
    try {
      const stored: StoredMessage[] = stampedMessages.map((e) => ({
        role: e.role,
        content: e.content,
        reasoning_content: e.role === 'assistant'
          ? e.reasoning_content
          : undefined,
        reasoning_text: e.role === 'assistant' ? e.reasoning_text : undefined,
        provider_state: e.role === 'assistant' ? e.provider_state : undefined,
        responseContext: e.role === 'assistant' ? e.responseContext : undefined,
        tool_calls: e.tool_calls,
        tool_call_id: e.tool_call_id,
        name: e.name,
        timestamp: now,
        usage: e.role === 'assistant' ? e.usage ?? this.usage : undefined,
      }))
      await this.store.appendMessages(this.physicalSessionId, stored)
      for (const message of stampedMessages) {
        if (message.role === 'user') this.bus.emit('session.message.appended', {
          sessionId: this.id, physicalSessionId: this.physicalSessionId, message,
        })
      }
    } catch (err) {
      this.messagePersistenceFailed = true
      console.error(
        `[session] Failed to persist messages for ${this.id}:`,
        errMsg(err),
      )
      if (this.tools.boundary) throw err
    }

    // Record activity time so listings can show a "last active" timestamp.
    // Lives here (not in the Session override) so ephemeral sessions
    // (reflector, encapsulator, …) also get a timestamp.
    this.state.lastActivityAt = new Date().toISOString()
    try {
      await this.store.saveState(this.id, this.state)
    } catch (err) {
      console.error(
        `[session] Failed to persist state for ${this.id}:`,
        errMsg(err),
      )
      if (this.tools.boundary) throw err
    }
  }

  // ── Hooks for subclasses ────────────────────────────────────────────────

  /** Drain any pending messages (e.g. steer queue) before each LLM call. No-op by default. */
  protected async drainPendingMessages(_llm: LlmRuntimeConfig): Promise<void> {}
  protected hasPendingContext(): boolean { return false }
  protected acceptFinalResponse(): boolean { return !this.hasPendingContext() }
  protected activityChanged(): void {
    this.bus.emit('session.activity.changed', { sessionId: this.id })
  }
  protected async finishTurn(fact: SessionTurnFact): Promise<void> {
    if (this.state.task?.activeRunId) fact.runId = this.state.task.activeRunId
    this.state.executionStatus = fact.status
    if (this.state.mode === 'session' && fact.status !== 'completed'
      && this.messages.some(message => message.role !== 'system')) {
      this.state.recovery = { id: fact.turnId, reason: fact.status === 'cancelled' ? 'stopped' : 'failed',
        userInvolved: this.responseContext?.userInvolved ?? false, pendingToolCalls: pendingToolCalls(this.messages).length,
        ...(fact.status === 'failed' && this.providerFailure ? { providerFailure: this.providerFailure } : {}) }
    } else delete this.state.recovery
    await this.store.saveState(this.id, this.state)
    if (this.state.mode && this.state.mode !== 'session') {
      await this.store.appendRawEvents(this.physicalSessionId, [{ execution_receipt: fact }])
    }
    this.bus.emit('session.turn.finished', fact)
  }
  /** Called when tool execution starts in the LLM loop. No-op by default. */
  protected onToolPhaseStart(): void {}

  /** Handle token-limit-exceeded errors. Return `true` to retry the iteration. */
  protected handleTokenLimitExceeded(_llm: LlmRuntimeConfig): Promise<boolean> {
    return Promise.resolve(false)
  }

  protected onToolPhaseEnd(): void {}

  protected emitOutbound(message: OutboundMessage): void {
    this.bus.emit('message.outbound', this.tools.boundary?.stamp(message) ?? message)
  }

  /** Persist snapshots before use. Fail closed rather than send an event absent from recovery history. */
  protected async recordContextEvent(kind: 'work' | 'working-context', content: string): Promise<void> {
    const event = await runtimeContextEvent(this.messages, kind, content, this.workspace)
    if (!event) return
    const timestamp = new Date().toISOString()
    const message = { ...event, timestamp }
    await this.store.appendMessages(this.physicalSessionId, [{
      role: message.role, content: message.content, name: message.name, timestamp,
    }])
    this.messages.push(message)
    this.bus.emit('session.message.appended', {
      sessionId: this.id, physicalSessionId: this.physicalSessionId, message,
    })
  }

  /** Same host-owned task boundary used for Work-context publication below. */
  private isBoundedSystemTask(channel: string): boolean {
    return this.state.mode === 'task' && this.state.agentType === channel && channel === 'work-organizer'
  }

  /** Initialize before first user input; replay committed snapshots after interrupted publication. */
  protected async ensureWorkingContext(admin = false): Promise<void> {
    if (this.boundedSystemTask) return
    if (this.state.workingContext === undefined) {
      const workdir = resolveSessionLocations(this.workspace, this.state, undefined, this.workdirCapabilityLookup).workdir
      const folder = this.state.folderId ? this.tools.workingContextFolder(this.state.folderId) : undefined
      const content = await prepareWorkingContext(workdir, this.state.folderId, folder, undefined, admin)
      await this.store.saveState(this.id, { ...this.state, workingContext: content })
      this.state.workingContext = content
    }
    await this.recordContextEvent('working-context', this.state.workingContext)
  }

  // ── Core LLM ↔ tool loop ───────────────────────────────────────────────

  protected async runLlmLoop(
    executionContext: ExecutionContext,
    llm: LlmRuntimeConfig,
    signal: AbortSignal,
    turnId: string = crypto.randomUUID(),
  ): Promise<string> {
    this.boundedSystemTask = this.isBoundedSystemTask(executionContext.channel)
    const model = executionContext.model ?? llm.model
    const temperature = executionContext.temperature ?? llm.temperature
    const maxTokens = executionContext.maxTokens ?? llm.maxTokens
    const thinking = executionContext.thinking ?? llm.thinking
    const reasoningEffort = executionContext.reasoningEffort ??
      llm.reasoningEffort
    executionContext = { ...executionContext, model, temperature, maxTokens, thinking, reasoningEffort }
    const budget = new InferenceBudget(this.tools.inferenceRequestLimit)
    let contextRecoveryAttempted = false
    const transientResults = new Map<string, ContentPart[]>()
    executionContext.infer = createNodeInference({
      provider: this.provider, budget,
      llm: { model, temperature, maxTokens, thinking, reasoningEffort },
      projectId: executionContext.projectId, turnId,
    })

    const pending = pendingToolCalls(this.messages)
    if (pending.length) {
      await this.executeToolCalls(pending.map(call => {
        const args: unknown = JSON.parse(call.function.arguments)
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error(`Saved tool call ${call.id} has invalid arguments`)
        }
        return { id: call.id, name: call.function.name, arguments: args as Record<string, unknown> }
      }), { ...executionContext, recoveringToolCall: true }, llm, signal, transientResults)
    }

    await this.ensureWorkingContext()
    for (let i = 0; budget.remaining > 0; i++) {
      // Resolve at inference boundaries, not by mutating any in-flight call's context.
      const current = resolveSessionLocations(this.workspace, this.state, undefined, this.workdirCapabilityLookup).workdir
      if (!current.available) throw new Error(`Session workdir unavailable: ${current.reason}`)
      executionContext = { ...executionContext,
        folderId: this.state.folderId,
        cwd: current.locality === 'local' ? current.path : undefined,
        remoteWorkdir: current.locality === 'remote' ? {
          nodeId: current.workdir.nodeId, capabilityId: current.workdir.capabilityId,
          executor: this.remoteExecutor ?? failMissingRemoteExecutor(),
        } : undefined,
      }
      if (!this.boundedSystemTask && this.state.workingContext !== undefined) await this.recordContextEvent('working-context', this.state.workingContext)
      const toolDefs = this.tools.getDefinitions()
      signal.throwIfAborted()

      // Hook: drain pending messages (e.g. steer queue in Session).
      await this.drainPendingMessages(llm)
      const responseContext = this.responseContext
        ? { ...this.responseContext, responseId: `${turnId}:${i}` } : undefined
      const workGuard = this.tools.getWorkGuard()
      executionContext = { ...executionContext, workStamps: workGuard?.snapshot(this.id) }
      const boundedSystemTask = this.isBoundedSystemTask(executionContext.channel)
      await this.recordContextEvent('work', boundedSystemTask ? '' : workGuard?.prompt(this.id, executionContext) ?? '')
      const durableMessages = modelMessages(this.messages, executionContext.channel === 'qq')
      const inferenceMessages = transientResults.size ? modelMessages(this.messages.map(message =>
        message.role === 'tool' && message.tool_call_id && transientResults.has(message.tool_call_id)
          ? { ...message, content: transientResults.get(message.tool_call_id)! } : message,
      ), executionContext.channel === 'qq') : durableMessages
      transientResults.clear()
      await this.tools.boundary?.beforeInference(signal)
      if (this.tools.boundary) await this.store.saveState(this.id, this.state)

      const traceAttributes = {
        sessionId: this.id,
        physicalSessionId: this.physicalSessionId,
        iteration: i,
      }
      using span = uspan('agent.loop', {
        attributes: traceAttributes,
      })

      const response = await withAbort(activeSpan(
        'agent.chat',
        async (chatSpan) => {
          const captureId = this.promptCaptures?.capture({
            projectId: this.state.projectId,
            sessionId: this.id,
            physicalSessionId: this.physicalSessionId,
            turnId,
            iteration: i,
            provider: this.provider.name,
          }, durableMessages, toolDefs, { model, maxTokens, temperature, thinking, reasoningEffort })
          if (captureId) chatSpan.setAttribute('prompt.capture.request_id', captureId)
          budget.take()
          this.providerFailure = undefined
          const response = await withRateLimitWaiting(wait => {
            this.providerWaiting = wait
            this.activityChanged()
            this.bus.emit('session.provider.waiting', { sessionId: this.id, wait })
          }, () => this.provider.chat(inferenceMessages, toolDefs, {
            model,
            maxTokens,
            temperature,
            signal,
            thinking,
            reasoningEffort,
          })).catch(error => {
            this.providerFailure = providerFailureKind(error)
            throw error
          })
          signal.throwIfAborted()
          this.tools.boundary?.assertCurrent()
          // Keep the returned message with its call, including across compaction.
          // Provider continuity (including encrypted state) is not display content.
          chatSpan.addEvent('model.response', {
            message: JSON.stringify({
              role: 'assistant',
              content: response.content,
              reasoning_text: response.reasoningText ?? response.reasoningContent,
              tool_calls: response.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
              usage: response.usage,
            }),
          })
          return response
        },
        { attributes: { ...traceAttributes, model } },
        span.context,
      ).catch((err) => err as Error), signal)

      signal.throwIfAborted()
      if (isContextSizeError(response)) {
        console.warn(`[${this.id}] Provider context/request size limit exceeded`)
        // One forced handoff per turn: oversized system prompts/tools or a
        // provider limit smaller than the summary cannot be repaired by looping.
        if (!contextRecoveryAttempted) {
          contextRecoveryAttempted = true
          if (await this.handleTokenLimitExceeded(llm)) continue
        }
        throw response
      } else if (response instanceof Error) {
        throw response
      }

      const priorWork = executionContext.workStamps ?? []
      const workChanged = () => {
        const latestWork = workGuard?.snapshot(this.id) ?? []
        return latestWork.length !== priorWork.length
          || latestWork.some(now => !priorWork.some(old => old.key === now.key && old.revision === now.revision))
      }
      const staleInference = workChanged()
      if (staleInference && !response.toolCalls.length) {
        response.content = `[Historical response from a superseded work agreement; not completion of current work.]\n${response.content ?? ''}`
      }

      if (response.usage) {
        this.usage = response.usage
      }
      // Appending the response can compact and reset context usage.
      const responseUsage = this.usage

      await this.appendMessages(llm, {
        role: 'assistant',
        content: response.content,
        reasoning_content: response.reasoningContent,
        reasoning_text: response.reasoningText,
        provider_state: response.providerState,
        responseContext,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
        usage: responseUsage,
      })

      const done = response.toolCalls.length === 0
      if (!done && this.hasPendingContext()) {
        for (const call of response.toolCalls) await this.appendMessages(llm, {
          role: 'tool', name: call.name, tool_call_id: call.id,
          content: 'Not executed: corrective context arrived during inference. Reassess before issuing tools.',
        })
        continue
      }
      if (done && (staleInference || workChanged())) {
        if (this.state.mode && this.state.mode !== 'session') {
          throw new Error('The bounded task work agreement changed during execution. Its partial results are historical, not completion of the new assignment.')
        }
        await this.appendMessages(llm, { role: 'user', name: '__work_realignment__',
          content: 'The referenced goal changed during the previous inference. Re-evaluate the affected plan against its current context. The previous response is not evidence of completing the revised goal.' })
        continue
      }
      if (done && !this.acceptFinalResponse()) continue
      if (response.content || done) {
        await this.tools.boundary?.beforeOutput(signal)
        const { text, media } = parseMediaFromContent(response.content ?? '')
        this.emitOutbound({
          event: 'response',
          channel: executionContext.channel,
          chatId: executionContext.chatId,
          channelAddress: executionContext.channelAddress,
          replyTo: executionContext.platformMessageId,
          content: text,
          media,
          done,
          usage: done ? responseUsage : undefined,
          responseContext,
        })
      }

      if (done) {
        console.log(`[${this.id}] LLM response complete, exiting loop`)
        return response.content ?? ''
      }

      const terminal = await this.executeToolCalls(response.toolCalls, executionContext, llm, signal, transientResults)
      if (terminal !== undefined) return terminal
    }
    throw new Error('Session turn exceeded the maximum number of iterations')
  }

  private async executeToolCalls(
    calls: ToolCall[],
    executionContext: ExecutionContext,
    llm: LlmRuntimeConfig,
    signal: AbortSignal,
    transientResults: Map<string, ContentPart[]>,
  ): Promise<string | undefined> {
    let terminal: string | undefined
    const groups = groupTools(calls, this.tools)
    const pendingResults = new Map(calls.map(call => [call.id, call]))
    const traceAttributes = { sessionId: this.id, physicalSessionId: this.physicalSessionId }
    using span = uspan('agent.tools', { attributes: traceAttributes })
    const publishedCallbacks = new Map<string, Array<() => void>>()
    const recordResult = async (call: ToolCall, result: ToolResult) => {
      // Only the host-bounded dedicated organizer terminates on its finish receipt.
      if (this.state.mode === 'task' && this.state.agentType === 'work-organizer'
        && executionContext.channel === 'work-organizer' && this.tools.inferenceRequestLimit !== undefined
        && call.name === 'organization_finish' && typeof result === 'string') {
        try {
          const receipt = JSON.parse(result)
          if (receipt.status === 'completed' || receipt.status === 'partial') terminal = result
        } catch { /* Tool errors are not terminal receipts. */ }
      }
      const transient = transientToolSummary(result)
      const media = typeof result === 'string' || transient !== undefined ? [] : await saveToolImages(
        resolveSessionLocations(this.workspace, this.state, undefined, this.workdirCapabilityLookup).sessionDataDir,
        result.content, signal,
      )
      const snapshotText = media.length ? '\nImage snapshots (read these paths to view the same images again):\n' + media.map(path => JSON.stringify(path)).join('\n') : ''
      const content = transient ?? (typeof result === 'string' ? result : [
        ...result.content, ...(snapshotText ? [{ type: 'text' as const, text: snapshotText }] : []),
      ])
      await this.appendMessages(llm, { role: 'tool', content, tool_call_id: call.id, name: call.name })
      // Legacy unbounded sessions log persistence errors and continue. Deferred
      // process-lifecycle effects must instead fail closed on an unsafe history.
      if (publishedCallbacks.has(call.id) && this.messagePersistenceFailed) {
        throw new Error('Cannot run deferred tool action after session message persistence failure')
      }
      if (transient !== undefined && typeof result !== 'string') transientResults.set(call.id, result.content)
      pendingResults.delete(call.id)
      await this.tools.boundary?.beforeOutput(signal)
      this.emitOutbound({
        event: 'tool_result',
        channel: executionContext.channel,
        chatId: executionContext.chatId,
        channelAddress: executionContext.channelAddress,
        replyTo: executionContext.platformMessageId,
        content: transient ?? toolResultText(result) + snapshotText,
        media: media.length ? media : undefined,
        toolCallId: call.id,
        toolName: call.name,
        done: false,
      })
      for (const callback of publishedCallbacks.get(call.id) ?? []) callback()
      publishedCallbacks.delete(call.id)
    }

    this.onToolPhaseStart()
    try {
      for (const group of groups) {
        signal.throwIfAborted()
        for (const tc of group.calls) {
          const display = this.tools.getChatTextDisplay(tc.name, tc.arguments)
          await this.tools.boundary?.beforeOutput(signal)
          this.emitOutbound({
            event: 'tool_call',
            channel: executionContext.channel,
            chatId: executionContext.chatId,
            channelAddress: executionContext.channelAddress,
            replyTo: executionContext.platformMessageId,
            content: display || tc.name,
            toolCall: { name: tc.name, arguments: tc.arguments },
            toolCallId: tc.id,
            toolName: tc.name,
            done: false,
          })
        }
        // Persist each completed result without waiting for sibling tools.
        // Serialize writes to keep the JSONL log and state file ordered.
        let writes = Promise.resolve()
        const executions = group.calls.map(async tc => {
          const fileChangePhysicalId = this.physicalSessionId
          const context: ExecutionContext = {
            ...executionContext, toolCallId: tc.id, toolCallName: tc.name,
            switchProjectFolder: calls.length === 1 && tc.name === 'use_project' ? async prepared => {
              signal.throwIfAborted()
              const next = { ...this.state, folderId: prepared.folderId, workdir: prepared.workdir }
              const resolved = resolveSessionLocations(this.workspace, next, undefined, this.workdirCapabilityLookup).workdir
              if (!resolved.available || resolved.locality !== 'local') throw new Error('Target folder execution unavailable; prior context retained.')
              const content = prepared.content
              // The existing state store is the commit point. Recovery replays this
              // snapshot if interrupted before the result/context event is appended.
              await this.store.saveState(this.id, { ...next, workingContext: content })
              Object.assign(this.state, next, { workingContext: content })
              this.clearReadCache()
              this.bus.emit('session.changed', { sessionId: this.id })
              return `Working context committed: folder=${JSON.stringify(prepared.folderId)}. Canonical runtime-context-working-context snapshot follows this tool result before inference.`
            } : undefined,
            afterToolResultPublished: callback => {
              const callbacks = publishedCallbacks.get(tc.id) ?? []
              callbacks.push(callback)
              publishedCallbacks.set(tc.id, callbacks)
            },
            recordFileChange: file_change => this.store.appendRawEvents(fileChangePhysicalId, [{ file_change }]),
            readFileChange: (id, signal) => readSessionFileChange(this.store, this.state, id, signal),
          }
          const result = await activeSpan('agent.tool',
            () => this.tools.execute(tc.name, tc.arguments, context),
            { attributes: { ...traceAttributes, 'tool.call_id': tc.id, 'tool.name': tc.name } },
            span.context,
          )
          if (this.state.mode !== 'call') {
            writes = writes.then(() => recordResult(tc, result))
            await writes
          }
          return result
        })

        if (this.state.mode === 'call') {
          const results = await withAbort(Promise.all(executions), signal)
          for (let index = 0; index < group.calls.length; index++) {
            await recordResult(group.calls[index], results[index])
          }
        } else {
          const outcomes = await Promise.allSettled(executions)
          const failure = outcomes.find(outcome => outcome.status === 'rejected')
          if (failure?.status === 'rejected') throw failure.reason
        }
      }
    } catch (error) {
      // Reusable sessions retain unfinished calls for Continue. Bounded
      // executions are terminal and must close their call/result pairs.
      if (this.state.mode && this.state.mode !== 'session') {
        await this.appendMessages(llm, ...Array.from(pendingResults.values(), (call) => ({
          role: 'tool' as const,
          content: signal.aborted ? 'Tool execution cancelled.' : `Tool execution failed: ${errMsg(error)}`,
          tool_call_id: call.id,
          name: call.name,
        })))
      }
      throw error
    } finally {
      this.onToolPhaseEnd()
    }
    return terminal
  }

  // ── Shared message processing ──────────────────────────────────────────

  /**
   * Process an admitted input through the full LLM pipeline.
   * Builds the user ChatMessage, appends it, constructs an ExecutionContext,
   * runs the LLM loop, and handles errors.
   */
  @Span('session.processMessage')
  protected async processInput(
    input: SessionInput,
    llm: LlmRuntimeConfig,
    signal: AbortSignal,
  ): Promise<SessionTurnFact | undefined> {
    if (input.kind === 'control' && input.command.type !== 'retry' && input.command.type !== 'resume') return
    if (input.kind === 'message' && input.source.kind === 'session' && input.source.workStamps?.length
      && this.tools.getWorkGuard()?.current(input.source.workStamps) === false) {
      input = { ...input, policy: 'silent', content: `[Historical input from an obsolete work revision; archive only, not new authority.]\n${input.content}` }
    }
    const silent = input.kind === 'message' && input.policy === 'silent'
    const msg = inputContext(this.id, input)
    this.boundedSystemTask = this.isBoundedSystemTask(msg.channel)
    const senderName = msg.senderName ?? msg.senderId
    const isGroup = !!msg.isGroup
    const queryId = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    const continuity = reconcileResponseContinuity(this.messages)
    this.messages = continuity.messages
    this.responseContext = createResponseContext(queryId, input.source, this.state.mode, msg.channel)
    if (input.kind === 'message' && !silent && this.responseContext
      && (this.state.recovery?.userInvolved || continuity.unfinishedUserResponse)) {
      this.responseContext = { ...this.responseContext, userInvolved: true }
    }
    if (input.kind === 'control' && input.command.type === 'resume' && this.responseContext
      && (this.state.recovery?.userInvolved ?? continuedUserInvolvement(this.messages))) {
      this.responseContext = { ...this.responseContext, userInvolved: true }
    }

    const attributes = {
      channel: msg.channel,
      chatId: msg.chatId,
      chatName: msg.chatName,
      senderId: msg.senderId,
      senderName,
      sessionId: this.id,
      messageId: msg.messageId,
      isGroup,
      admin: msg.admin ?? false,
      physicalSessionId: this.physicalSessionId,
      platformMessageId: msg.platformMessageId,
      queryId,
    }
    this.providerFailure = undefined
    const fact: SessionTurnFact = {
      sessionId: this.id,
      turnId: queryId,
      inputId: input.id,
      source: input.source,
      status: 'completed',
      content: '',
    }
    const attempted = !silent
    try {
      if (this.tools.boundary) {
        signal = AbortSignal.any([signal, this.tools.boundary.signal])
        await this.tools.boundary.begin(input, signal)
      }
      spanAttributes(attributes)
      if (attempted) {
        this.state.executionStatus = 'running'
        delete this.state.recovery
        await this.store.saveState(this.id, this.state)
        this.bus.emit('session.turn.started', { sessionId: this.id, turnId: queryId, inputId: input.id, source: input.source })
      }

      console.log(`[${this.id}] Processing message`)

      // Resolve only locally available workdirs; remote display paths are not
      // filesystem paths on this node. Uploads stay in private session data.
      const locations = resolveSessionLocations(
        this.workspace,
        this.state,
        undefined,
        this.workdirCapabilityLookup,
      )
      if (!locations.workdir.available) {
        throw new Error(`Session workdir unavailable: ${locations.workdir.reason}`)
      }
      const remoteWorkdir = locations.workdir.locality === 'remote'
        ? {
          nodeId: locations.workdir.workdir.nodeId,
          capabilityId: locations.workdir.workdir.capabilityId,
          executor: this.remoteExecutor ?? failMissingRemoteExecutor(),
        }
        : undefined
      const cwd = locations.workdir.locality === 'local' ? locations.workdir.path : undefined
      const messageWorkdir = cwd ?? locations.sessionDataDir
      await mkdir(locations.sessionDataDir, { recursive: true })

      if (input.kind === 'control') {
        if (input.command.type === 'resume') {
          if (!this.messages.some(message => message.role !== 'system')) throw new Error('No saved history to continue.')
        } else {
          // Retry alone supports fallback content when the original send was lost.
          const hasReplayable = this.messages.some((m) => m.role !== 'system')
          if (hasReplayable) {
            console.info(`[${this.id}] Retrying last request on existing history`)
          } else if (input.command.type === 'retry' && input.command.fallbackContent?.trim()) {
            await this.appendMessages(llm, await buildUserChatMessage(
              retryMessage(input), this.workspace, messageWorkdir,
            ))
          } else {
            throw new Error('Nothing to retry: no previous request or fallback content')
          }
        }
      } else {
        if (input.source.kind === 'user') {
          await this.store.appendRawEvents(this.physicalSessionId, [{
            decision_input: { id: input.id, text: input.content, at: input.timestamp },
          }])
        }
        // A new input supersedes unfinished calls; only Continue/Retry execute
        // them. Close their pairs before appending the newly admitted context.
        await this.persistMessages(llm, ...pendingToolCalls(this.messages).map(call => ({
          role: 'tool' as const,
          content: remoteWorkdir
            ? 'Tool outcome unknown. A new message superseded recovery without re-executing this call; partial side effects may remain.'
            : 'Tool execution cancelled.',
          tool_call_id: call.id,
          name: call.function.name,
        })))
        await this.ensureWorkingContext(msg.admin === true)
        const message = await buildUserChatMessage(
          input, this.workspace, messageWorkdir,
        )
        if (silent) {
          // A silent admission must not trigger compaction/model inference.
          await this.persistMessages(llm, message)
          console.info(`[${this.id}] Recorded silent message`)
          return
        }
        if (signal.aborted) await this.persistMessages(llm, message)
        else await this.appendMessages(llm, message)
      }

      console.debug(`[${this.id}] Loaded ${this.messages.length} session history`)
      const executionContext: ExecutionContext = {
        memoryAccess: this.tools.boundary?.memoryAccess,
        projectId: this.state.projectId,
        evalBridge: this.evalBridge,
        channelAddress: msg.channelAddress,
        ...attributes,
        inputSource: input.source.kind,
        ...(input.kind === 'message' && input.source.kind === 'user' && msg.admin === true && !isGroup
          ? { workUserInput: input.content } : {}),
        cwd,
        folderId: this.state.folderId,
        remoteWorkdir,
        tools: this.tools,
        signal,
        defaultExecShell: this.state.config?.defaultShell,
        model: this.state.config?.model,
        temperature: this.state.config?.temperature,
        maxTokens: this.state.config?.maxTokens,
        thinking: this.state.config?.thinking,
        reasoningEffort: this.state.config?.reasoningEffort,
      }

      signal.throwIfAborted()
      fact.content = await this.runLlmLoop(executionContext, llm, signal, queryId)
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        fact.status = 'cancelled'
        if (!silent && !this.tools.boundary) {
          this.bus.emit('message.outbound', {
            channel: msg.channel,
            chatId: msg.chatId,
            channelAddress: msg.channelAddress,
            content: '',
            replyTo: msg.platformMessageId,
            done: true,
            event: 'response',
          })
        }
        return fact
      }
      fact.status = 'failed'
      fact.error = errMsg(err)
      console.error(errDetail(err), 'LLM provider error')
      this.bus.emit('message.outbound', {
        channel: msg.channel,
        chatId: msg.chatId,
        channelAddress: msg.channelAddress,
        content: `⚠️ Request failed: ${errMsg(err)}`,
        inferenceError: true,
        replyTo: msg.platformMessageId,
        done: true,
        event: 'response',
      })
    } finally {
      try {
        if (attempted) await this.finishTurn(fact)
      } finally {
        this.tools.boundary?.finish()
        this.responseContext = undefined
      }
    }

    return attempted ? fact : undefined
  }
}

function failMissingRemoteExecutor(): never {
  throw new Error('Session workdir requires the remote executor')
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}
