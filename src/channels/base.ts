import type { InboundMessage, OutboundMessage } from '../bus/events.ts'
import { channelSessionId, type ChannelAddress } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { Hono } from 'hono'
import type { DeliveryReceipt, ReceiveChannelMessage } from '../sessions/input.ts'
import type { ChannelState } from './setup-contract.ts'
import { unavailableCapabilities, type ChannelCapabilities } from './capabilities.ts'
import type { YieldRequest } from '../sessions/yield-contract.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getProjectScope, type ProjectScope } from '../projects/scope.ts'
import type { ChannelOperation, ChannelOperationRequest, ChannelOperationTarget } from './operations.ts'

export interface ChannelDecision {
  channelAddress?: ChannelAddress
  chatId: string
  senderId: string
  requestId: string
  option: 1 | 2 | 3 | 'cancel'
}

export interface ChannelDecisionHandler {
  (decision: ChannelDecision): Promise<string>
}

export class ChannelAdmissionError extends Error {
  constructor(message: string, readonly status: 403 | 503) {
    super(message)
    this.name = 'ChannelAdmissionError'
  }
}

/**
 * Abstract base for all communication channels (Discord, Telegram, Feishu, etc.).
 *
 * Each channel:
 * - Connects to its platform and listens for incoming messages
 * - Submits InboundMessages to an explicit session receiver
 * - Receives OutboundMessages and delivers them to the platform
 */
export interface BaseChannel {
  /** Channel identifier (e.g., "discord", "telegram"). */
  readonly name: string
  setBotScope?(scope: Omit<ChannelAddress, 'conversationId'>): void
  setProjectScope?(scope: ProjectScope): void
  setIdentityHandler?(handler: (identity: string) => void): void
  withConnection?<T>(operation: () => T): T
  connectionGuard?(): () => void

  /** Configure explicit message admission before starting the channel. */
  setReceiver(receiver: ReceiveChannelMessage): void

  setStatusListener?(listener: (state: ChannelState) => void): void
  getCapabilities?(chatId: string): ChannelCapabilities | Promise<ChannelCapabilities>
  readonly operationNames?: readonly ChannelOperation[]
  executeOperation?(request: ChannelOperationRequest, target: ChannelOperationTarget): Promise<unknown>
  setDecisionHandler?(handler: ChannelDecisionHandler): void
  presentDecision?(chatId: string, request: YieldRequest, content: string): Promise<void>
  presentDecisionText?(chatId: string, content: string, replyTo?: string): Promise<void>

  /** Start listening for messages (long-running). Receives the gateway Hono app so the channel can register its own routes. */
  start(app: Hono): Promise<void>

  /** Gracefully disconnect. */
  stop(): Promise<void>

  onMessage(msg: OutboundMessage): Promise<void>

  /** Check whether a sender is allowed to interact. */
  isAllowed(senderId: string): boolean

  /**
   * Create a thread/sub-conversation within a chat.
   * Returns the new thread's chatId, or null if unsupported.
   */
  createThread?(parentChatId: string, name: string): Promise<string | null>
}

/**
 * Base class providing common channel logic.
 */
export abstract class AbstractChannel implements BaseChannel {
  abstract readonly name: string
  private receiver?: ReceiveChannelMessage
  private botScope?: Omit<ChannelAddress, 'conversationId'>
  private identityHandler?: (identity: string) => void
  private statusListener?: (state: ChannelState) => void
  private accepting = true
  private decisionHandler?: ChannelDecisionHandler
  private requestController = new AbortController()
  private connectionContext = new AsyncLocalStorage<AbortSignal>()
  private projectScope = getProjectScope()
  protected chatActiveMessage: Map<string, {
    messageId: string
    bufferedChunks: string[]
  }> = new Map()

  constructor(
    protected bus: Bus,
    protected allowFrom?: string[],
    /** When true, all sessions on this channel are admin regardless of chat type. */
    protected alwaysAdmin = false,
    /** Group-chat IDs that have admin privileges. DMs are admin by default. */
    protected adminChats?: string[],
  ) { }

  acceptToolResults: boolean = false

  setBotScope(scope: Omit<ChannelAddress, 'conversationId'>): void {
    if (this.botScope) throw new Error('Channel scope is immutable')
    if (!scope.projectId || !scope.botInstanceId || scope.platform !== this.name) throw new TypeError('Invalid bot scope')
    if (this.projectScope && this.projectScope.projectId !== scope.projectId) throw new TypeError('Bot telemetry scope mismatch')
    this.botScope = Object.freeze({ ...scope })
  }

  setProjectScope(scope: ProjectScope): void {
    if ((this.projectScope && this.projectScope !== scope)
      || (this.botScope && this.botScope.projectId !== scope.projectId)) {
      throw new TypeError('Channel project scope is immutable')
    }
    this.projectScope = scope
  }

  protected bindCallback<A extends unknown[]>(callback: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      if (this.projectScope?.closed) return
      if (this.projectScope) this.projectScope.run(() => callback(...args))
      else callback(...args)
    }
  }

  setIdentityHandler(handler: (identity: string) => void): void {
    this.identityHandler = handler
  }

  protected reportIdentity(identity: string): void {
    this.identityHandler?.(identity)
  }

  protected address(chatId: string): ChannelAddress | undefined {
    return this.botScope ? { ...this.botScope, conversationId: chatId } : undefined
  }

  protected logicalSessionId(chatId: string): string {
    this.assertConnection()
    const address = this.address(chatId)
    return address ? channelSessionId(address) : `${this.name}:${chatId}`
  }

  protected mediaSourceId(nativeId: string): string {
    this.assertConnection()
    return (this.botScope
      ? `${this.botScope.projectId}_${this.botScope.botInstanceId}_${this.name}_${nativeId}`
      : `${this.name}_${nativeId}`).replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  setReceiver(receiver: ReceiveChannelMessage): void {
    this.receiver = message => this.projectScope
      ? this.projectScope.run(() => receiver(message)) : receiver(message)
  }

  setStatusListener(listener: (state: ChannelState) => void): void {
    this.statusListener = this.bindCallback(listener)
  }

  getCapabilities(_chatId: string): ChannelCapabilities | Promise<ChannelCapabilities> {
    return unavailableCapabilities()
  }

  setDecisionHandler(handler: ChannelDecisionHandler): void {
    this.decisionHandler = decision => this.projectScope
      ? this.projectScope.run(() => handler(decision)) : handler(decision)
  }

  protected async answerDecision(decision: ChannelDecision): Promise<string> {
    this.assertConnection()
    if (!this.accepting) throw new ChannelAdmissionError('Channel is disconnected', 503)
    if (!this.isAllowed(decision.senderId)) throw new ChannelAdmissionError('Sender is not authorized', 403)
    if (!this.decisionHandler) throw new ChannelAdmissionError('Decision handler is unavailable', 503)
    return this.decisionHandler({
      ...decision, ...(this.botScope ? { channelAddress: this.address(decision.chatId) } : {}),
    })
  }

  async presentDecision(chatId: string, _request: YieldRequest, content: string): Promise<void> {
    await this.presentDecisionText(chatId, content)
  }

  async presentDecisionText(chatId: string, content: string, replyTo?: string): Promise<void> {
    const messageId = await this.send({
      channel: this.name, chatId, content, event: 'response', done: true,
      ...(replyTo ? { replyTo } : {}),
      ...(this.botScope ? { channelAddress: this.address(chatId) } : {}),
    })
    if (!messageId) throw new Error('Channel decision message was not acknowledged')
  }

  protected reportState(state: ChannelState): void {
    this.statusListener?.(state)
  }

  protected setAccepting(accepting: boolean): void {
    this.accepting = accepting
    this.requestController.abort()
    if (accepting) this.requestController = new AbortController()
    else this.chatActiveMessage.clear()
  }

  withConnection<T>(operation: () => T): T {
    this.assertConnection()
    const run = () => this.connectionContext.run(this.requestController.signal, operation)
    return this.projectScope ? this.projectScope.run(run) : run()
  }

  protected assertConnection(): void {
    const source = this.connectionContext.getStore()
    if (source && (source.aborted || source !== this.requestController.signal)) {
      throw new ChannelAdmissionError('The source bot connection has changed', 503)
    }
  }

  connectionGuard(): () => void {
    const signal = this.requestController.signal
    return () => {
      if (signal.aborted || signal !== this.requestController.signal) {
        throw new ChannelAdmissionError('The source bot connection has changed', 503)
      }
    }
  }

  protected async request(input: string | URL, init: RequestInit = {}): Promise<Response> {
    try {
      this.assertConnection()
      const signal = AbortSignal.any([
        this.requestController.signal, AbortSignal.timeout(60_000),
        ...(init.signal ? [init.signal] : []),
      ])
      signal.throwIfAborted()
      return await fetch(input, { ...init, signal })
    } catch {
      // Network/SDK errors can contain request headers or credential-bearing URLs.
      throw new Error('Channel request failed')
    }
  }

  abstract start(app: Hono): Promise<void>
  abstract stop(): Promise<void>
  abstract send(msg: OutboundMessage): Promise<string | null>
  abstract update?(
    messageId: string,
    chatId: string,
    content: string,
    media?: string[],
  ): Promise<void>

  async onMessage(msg: OutboundMessage) {
    if (msg.done && !msg.content && !msg.media?.length) {
      this.chatActiveMessage.delete(msg.chatId)
      return
    }

    if (msg.event === 'tool_result') {
      if (!this.acceptToolResults) return
    }

    if (!this.update || (await this.getCapabilities(msg.chatId)).updates === 'none') {
      this.chatActiveMessage.delete(msg.chatId)
      await this.send(msg)
      return
    }
    // Progressive update: if append=true and we have a stored messageId, edit instead of send
    const stored = this.chatActiveMessage.get(msg.chatId)
    if (stored) {
      if (msg.media) {
        stored.bufferedChunks = [msg.content]
        const messageId = await this.send(msg)
        stored.messageId = messageId ?? stored.messageId
      } else {
        stored.bufferedChunks.push(msg.content)
        await this.update(
          stored.messageId,
          msg.chatId,
          stored.bufferedChunks.join('\n'),
          msg.media,
        )
      }
      if (msg.done) this.chatActiveMessage.delete(msg.chatId)
      return
    }

    // New message: send and store the returned ID for this chatId
    const messageId = await this.send(msg)
    if (messageId && !msg.done) {
      this.chatActiveMessage.set(msg.chatId, {
        messageId,
        bufferedChunks: [],
      })
      // Trim map if it grows too large (concurrent queries are few, this is a safety valve)
      if (this.chatActiveMessage.size > 500) {
        const firstKey = this.chatActiveMessage.keys().next().value!
        this.chatActiveMessage.delete(firstKey)
      }
    }
  }

  isAllowed(senderId: string): boolean {
    if (!this.allowFrom || this.allowFrom.length === 0) return true
    return this.allowFrom.includes(senderId)
  }

  /**
   * Validate the sender and await admission, not the completed model response.
   */
  protected async handleIncoming(
    senderId: string,
    chatId: string,
    content: string,
    messageId: string,
    fields?: Partial<
      Omit<
        InboundMessage,
        | 'channel'
        | 'senderId'
        | 'chatId'
        | 'content'
        | 'timestamp'
        | 'media'
        | 'admin'
      >
    >,
    media?: string[],
  ): Promise<DeliveryReceipt> {
    this.assertConnection()
    if (!this.accepting) {
      throw new ChannelAdmissionError(`[${this.name}] Channel is disconnected`, 503)
    }
    if (!this.isAllowed(senderId)) {
      throw new ChannelAdmissionError(`[${this.name}] Sender is not authorized`, 403)
    }
    if (!this.receiver) {
      throw new ChannelAdmissionError(`[${this.name}] Message receiver is not configured`, 503)
    }

    const admin = this.alwaysAdmin || !fields?.isGroup ||
      !!this.adminChats?.includes(chatId)

    this.chatActiveMessage.delete(chatId)

    const msg: InboundMessage = {
      ...fields,
      ...(this.botScope ? { channelAddress: this.address(chatId) } : {}),
      channel: this.name,
      messageId,
      platformMessageId: messageId,
      senderId,
      chatId,
      content,
      timestamp: new Date().toISOString(),
      media,
      admin,
    }
    return await this.receiver(msg)
  }
}
