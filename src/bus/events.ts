/** Stable routing identity; platform/chat alone is only a legacy default-org address. */
export interface ChannelAddress {
  projectId: string
  botInstanceId: string
  platform: string
  conversationId: string
  /** Only the default project's migrated platform instance retains old IDs. */
  legacySessionId?: boolean
}

export function channelSessionId(address: ChannelAddress): string {
  if ([address.projectId, address.botInstanceId, address.platform, address.conversationId]
    .some(value => typeof value !== 'string' || !value)
    || (address.legacySessionId !== undefined && typeof address.legacySessionId !== 'boolean')) {
    throw new TypeError('Incomplete channel address')
  }
  return address.legacySessionId ? `${address.platform}:${address.conversationId}`
    : `bot:${[address.projectId, address.botInstanceId, address.platform, address.conversationId].map(encodeURIComponent).join(':')}`
}

export function channelAddressFromSessionId(sessionId: string): ChannelAddress | undefined {
  if (!sessionId.startsWith('bot:')) return undefined
  const parts = sessionId.slice(4).split(':')
  if (parts.length !== 4 || parts.some(part => !part)) throw new TypeError('Invalid bot session ID')
  const [projectId, botInstanceId, platform, conversationId] = parts.map(decodeURIComponent)
  return { projectId, botInstanceId, platform, conversationId }
}

/** Shared inbound metadata and agent execution context. */
export interface MessageContext {
  channelAddress?: ChannelAddress
  /** Channel identifier (e.g. "discord", "telegram", "system") */
  channel: string
  /** Internal correlation/tracking ID. May be a UUID for synthetic messages (subagent, system, etc.). */
  messageId: string
  /**
   * Platform-native message ID for reply threading.
   * Only set for real platform messages (Discord snowflake, Feishu message_id, etc.).
   * Undefined for synthetic messages — channels must not use this for reply references in that case.
   */
  platformMessageId?: string
  /** Sender's user id within the channel */
  senderId: string
  /** Sender display name */
  senderName?: string
  /** Chat / conversation id within the channel */
  chatId: string
  /** Human-readable chat or channel name, if known */
  chatName?: string
  /** True when the message originates from a group / multi-participant chat */
  isGroup?: boolean
  /** True when the session has elevated (admin) privileges */
  admin?: boolean
}

/**
 * Message flowing from a channel into the agent.
 * Extends MessageContext so all context fields live at the top level.
 */
export interface InboundMessage extends MessageContext {
  /** Text content of the message */
  content: string
  /** ISO-8601 timestamp */
  timestamp: string
  /** Optional attached media URLs or base64 data URIs */
  media?: string[]
  /** Record message in history but suppress the bot's response */
  silent?: boolean
  /**
   * Re-run the agent loop on the existing session history without appending a
   * new user message. Used by the web "retry" action so a failed request can be
   * retried without duplicating the prompt in history.
   */
  retry?: boolean
  /**
   * Legacy adapter metadata, retained for wire compatibility only.
   * It does not choose source identity, scheduling, or prompt roles.
   */
  eventMeta?: Record<string, unknown>
}

/**
 * Message flowing from the agent out to a channel.
 */
export interface OutboundMessage {
  channelAddress?: ChannelAddress
  /** Target channel identifier */
  channel: string
  /** Target chat / conversation id */
  chatId: string

  event: 'response' | 'tool_call' | 'tool_result'
  /** Text content */
  content: string
  /** Optional id of the message being replied to */
  replyTo?: string
  /** Optional attached media */
  media?: string[]
  /** Full tool call data (for tool_call events). Channels that support rich display can use this instead of content. */
  toolCall?: { name: string; arguments: Record<string, unknown> }
  toolCallId?: string
  toolName?: string
  /** Structured decision, separate from ordinary progressive response output. */
  yieldRequest?: import('../sessions/yield-contract.ts').YieldRequest
  /**
   * When true, signals that this is the final message for this queryId.
   * The channel manager will release any stored message-ID tracking for this query.
   */
  done: boolean
  /** Token usage stats for the LLM call (attached on final response). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  /** Arbitrary channel-specific metadata */
  metadata?: Record<string, unknown>
}

/**
 * Derive a logical session ID from a message.
 */
export function deriveSessionId(msg: InboundMessage): string {
  if (msg.channelAddress) {
    if (msg.channelAddress.platform !== msg.channel || msg.channelAddress.conversationId !== msg.chatId) {
      throw new TypeError('Channel address does not match message destination')
    }
    return channelSessionId(msg.channelAddress)
  }
  return `${msg.channel}:${msg.chatId}`
}
