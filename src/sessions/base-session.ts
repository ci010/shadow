import type { ExecutionContext } from '../agent/agent.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import { mkdir } from 'node:fs/promises'
import type { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import {
  type ChatMessage,
  type LLMProvider,
  type LLMResponseUsage,
  TokenLimitExceededError,
} from '../providers/provider.ts'
import type { SessionTools } from '../tools/registry.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'
import { activeSpan, Span, spanAttributes, uspan } from '../utils/otel.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import { groupTools } from '../utils/tools-group.ts'
import { errDetail, errMsg } from '../utils/truncate.ts'
import type { SessionStore } from './session-manager.ts'
import {
  resolveSessionLocations,
  type WorkdirCapabilityLookup,
} from './locality.ts'
import type { SessionState, StoredMessage } from './session-store.ts'
import type { Executor } from '../execution/executor.ts'

/**
 * Shared base for all session types.
 *
 * Contains the core LLM ↔ tool loop, message persistence, and public state
 * accessors.  Subclasses add lifecycle-specific behaviour (event loop with
 * steering for {@link Session}, fire-and-forget for {@link EphemeralSession}).
 */
export abstract class BaseSession {
  protected usage: LLMResponseUsage | undefined

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
  ) {
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** The current physical session ID (segment in the handoff chain). */
  get physicalSessionId(): string {
    return newPhysicalSessionId(this.state.sessionId, this.state.segmentIndex)
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

  // ── Protected persistence ───────────────────────────────────────────────

  /**
   * Append messages to the in-memory history and persist to disk.
   * Subclasses may override to add compaction checks (see {@link Session}).
   */
  protected async appendMessages(
    _llm: LlmRuntimeConfig,
    ...messages: ChatMessage[]
  ): Promise<void> {
    if (messages.length === 0) return
    this.messages.push(...messages)
    try {
      const now = new Date().toISOString()
      const stored: StoredMessage[] = messages.map((e) => ({
        role: e.role,
        content: e.content,
        reasoning_content: e.role === 'assistant'
          ? e.reasoning_content
          : undefined,
        reasoning_text: e.role === 'assistant' ? e.reasoning_text : undefined,
        provider_state: e.role === 'assistant' ? e.provider_state : undefined,
        tool_calls: e.tool_calls,
        tool_call_id: e.tool_call_id,
        name: e.name,
        timestamp: now,
        usage: e.role === 'assistant' ? this.usage : undefined,
      }))
      await this.store.appendMessages(this.physicalSessionId, stored)
    } catch (err) {
      console.error(
        `[session] Failed to persist messages for ${this.id}:`,
        errMsg(err),
      )
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
    }
  }

  // ── Hooks for subclasses ────────────────────────────────────────────────

  /** Drain any pending messages (e.g. steer queue) before each LLM call. No-op by default. */
  protected async drainPendingMessages(_llm: LlmRuntimeConfig): Promise<void> {}
  /** Called when tool execution starts in the LLM loop. No-op by default. */
  protected onToolPhaseStart(): void {}

  /** Handle token-limit-exceeded errors. Return `true` to retry the iteration. */
  protected handleTokenLimitExceeded(_llm: LlmRuntimeConfig): Promise<boolean> {
    return Promise.resolve(false)
  }

  protected onToolPhaseEnd(): void {}

  // ── Core LLM ↔ tool loop ───────────────────────────────────────────────

  protected async runLlmLoop(
    executionContext: ExecutionContext,
    llm: LlmRuntimeConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const model = executionContext.model ?? llm.model
    const temperature = executionContext.temperature ?? llm.temperature
    const maxTokens = executionContext.maxTokens ?? llm.maxTokens
    const thinking = executionContext.thinking ?? llm.thinking
    const reasoningEffort = executionContext.reasoningEffort ??
      llm.reasoningEffort

    for (let i = 0; i < 100; i++) {
      const toolDefs = this.tools.getDefinitions()
      signal.throwIfAborted()

      // Hook: drain pending messages (e.g. steer queue in Session).
      await this.drainPendingMessages(llm)

      using span = uspan('agent.loop', {
        attributes: { iteration: i },
      })

      const response = await activeSpan(
        'agent.chat',
        () =>
          this.provider.chat(this.messages, toolDefs, {
            model,
            maxTokens,
            temperature,
            signal,
            thinking,
            reasoningEffort,
          }),
        {},
        span.context,
      ).catch((err) => err as Error)

      if (response instanceof TokenLimitExceededError) {
        console.warn(`[${this.id}] Token limit exceeded`)
        if (await this.handleTokenLimitExceeded(llm)) continue
        throw response
      } else if (response instanceof Error) {
        throw response
      }

      if (response.usage) {
        this.usage = response.usage
      }

      await this.appendMessages(llm, {
        role: 'assistant',
        content: response.content,
        reasoning_content: response.reasoningContent,
        reasoning_text: response.reasoningText,
        provider_state: response.providerState,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
        usage: response.usage,
      })

      const done = response.toolCalls.length === 0
      if (response.content) {
        const { text, media } = parseMediaFromContent(response.content)
        this.bus.emit('message.outbound', {
          event: 'response',
          channel: executionContext.channel,
          chatId: executionContext.chatId,
          replyTo: executionContext.platformMessageId,
          content: text,
          media,
          done,
          usage: done ? this.usage : undefined,
        })
      }

      if (done) {
        console.log(`[${this.id}] LLM response complete, exiting loop`)
        return
      }

      signal.throwIfAborted()

      const groups = groupTools(response.toolCalls, this.tools)

      this.onToolPhaseStart()
      try {
        for (const group of groups) {
          signal.throwIfAborted()

          for (const tc of group.calls) {
            const display = this.tools.getChatTextDisplay(tc.name, tc.arguments)
            this.bus.emit('message.outbound', {
              event: 'tool_call',
              channel: executionContext.channel,
              chatId: executionContext.chatId,
              replyTo: executionContext.platformMessageId,
              content: display || tc.name,
              toolCall: { name: tc.name, arguments: tc.arguments },
              done,
            })
          }
          const results = await Promise.all(
            group.calls.map((tc) =>
              activeSpan(
                `agent.tool`,
                () =>
                  this.tools.execute(tc.name, tc.arguments, executionContext),
                {},
                span.context,
              )
            ),
          )
          await this.appendMessages(
            llm,
            ...group.calls.map((call, idx) => ({
              role: 'tool',
              content: results[idx],
              tool_call_id: call.id,
              name: call.name,
            } satisfies ChatMessage)),
          )

          for (let idx = 0; idx < group.calls.length; idx++) {
            this.bus.emit('message.outbound', {
              event: 'tool_result',
              channel: executionContext.channel,
              chatId: executionContext.chatId,
              replyTo: executionContext.platformMessageId,
              content: results[idx],
              done,
            })
          }
        }
      } finally {
        this.onToolPhaseEnd()
      }
    }
  }

  // ── Shared message processing ──────────────────────────────────────────

  /**
   * Process a single inbound message through the full LLM pipeline.
   * Builds the user ChatMessage, appends it, constructs an ExecutionContext,
   * runs the LLM loop, and handles errors.
   */
  @Span('session.processMessage')
  protected async processInboundMessage(
    msg: InboundMessage,
    llm: LlmRuntimeConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const senderName = msg.senderName ?? msg.senderId
    const isGroup = !!msg.isGroup
    const queryId = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

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
    spanAttributes(attributes)

    console.log(`[${this.id}] Processing message`)

    // Per-session working directory — created lazily so the agent's relative
    // file paths (and the media it reads) land here instead of cluttering the
    // shared workspace root.
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
    const remoteWorkdir = locations.workdir.locality === 'remote'
      ? {
        nodeId: locations.workdir.workdir.nodeId,
        capabilityId: locations.workdir.workdir.capabilityId,
        executor: this.remoteExecutor ?? failMissingRemoteExecutor(),
      }
      : undefined
    const cwd = locations.workdir.locality === 'local'
      ? locations.workdir.path
      : undefined
    const messageWorkdir = cwd ?? locations.sessionDataDir
    await mkdir(messageWorkdir, { recursive: true })

    if (msg.retry === true) {
      // Retry: re-run the agent loop on the existing history without appending
      // a new user message (avoids duplicating the prompt after a failed call).
      // If there is nothing to replay (e.g. the original request never reached
      // the backend), fall back to appending the provided content once.
      const hasReplayable = this.messages.some((m) => m.role !== 'system')
      if (hasReplayable) {
        console.info(`[${this.id}] Retrying last request on existing history`)
      } else if (msg.content && msg.content.trim()) {
        const userMsg = await buildUserChatMessage(
          msg,
          this.workspace,
          messageWorkdir,
        )
        await this.appendMessages(llm, userMsg)
      } else {
        console.warn(
          `[${this.id}] Retry requested but nothing to replay — ignoring`,
        )
        return
      }
    } else {
      const userMsg = await buildUserChatMessage(
        msg,
        this.workspace,
        messageWorkdir,
      )
      await this.appendMessages(llm, userMsg)

      if (msg.silent === true) {
        console.info(`[${this.id}] Recorded silent message`)
        return
      }
    }

    console.debug(`[${this.id}] Loaded ${this.messages.length} session history`)

    const executionContext: ExecutionContext = {
      ...attributes,
      cwd,
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

    try {
      signal.throwIfAborted()
      await this.runLlmLoop(executionContext, llm, signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.error(errDetail(err), 'LLM provider error')
      this.bus.emit('message.outbound', {
        channel: msg.channel,
        chatId: msg.chatId,
        content: `⚠️ Request failed: ${errMsg(err)}`,
        replyTo: msg.platformMessageId,
        done: true,
        event: 'response',
      })
    }
  }
}

function failMissingRemoteExecutor(): never {
  throw new Error('Session workdir requires the remote executor')
}
