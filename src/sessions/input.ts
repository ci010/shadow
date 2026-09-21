import type { InboundMessage, MessageContext } from '../bus/events.ts'
import { channelAddressFromSessionId, type ChannelAddress } from '../bus/events.ts'
import type { CommandReceipt } from '../slash-commands/receipt.ts'

export interface ReplyAddress {
  channelAddress?: ChannelAddress
  channel: string
  chatId: string
  platformMessageId?: string
}

export interface UserInputSource {
  kind: 'user'
  sender: MessageContext
}

export interface SessionInputSource {
  kind: 'session'
  sessionId: string
  inputId?: string
  senderName?: string
  workStamps?: import('../initiatives/work-contract.ts').WorkStamp[]
  /** Work references are context, never an assignment or authorization grant. */
  coordination?: {
    intent: 'request' | 'question' | 'progress' | 'handoff' | 'acknowledgement'
    initiativeId?: string
    itemId?: string
  }
}

export interface InputOrigin {
  sessionId: string
  inputId: string
  source: UserInputSource | SessionInputSource
}

export interface EventInputSource {
  kind: 'event'
  eventId: string
  type: string
  source: string
  senderId?: string
  senderName?: string
  isGroup?: boolean
  origin?: InputOrigin
  coalesced?: { count: number; eventIds: string[]; origins: InputOrigin[] }
  /** Display data only; never used for scheduling or authorization. */
  attributes?: Record<string, unknown>
}

export type InputSource = UserInputSource | SessionInputSource | EventInputSource
export type DeliveryPolicy = 'interactive' | 'queue' | 'steering' | 'silent'

interface InputEnvelope {
  id: string
  timestamp: string
  source: InputSource
  replyTo?: ReplyAddress
}

export interface SessionMessageInput extends InputEnvelope {
  kind: 'message'
  content: string
  media?: string[]
  policy: DeliveryPolicy
}

export interface SessionControlInput extends InputEnvelope {
  kind: 'control'
  command:
    | { type: 'retry'; fallbackContent?: string; media?: string[] }
    | { type: 'resume'; recoveryId: string }
    | { type: 'cancel' }
    | { type: 'compact' }
}

export type SessionInput = SessionMessageInput | SessionControlInput

export interface DeliveryReceipt {
  status: 'accepted'
  sessionId: string
  inputId: string
  commandReceipt?: CommandReceipt
}

export interface AcceptedSessionInput {
  sessionId: string
  input: SessionInput
}

export interface SessionTurnFact {
  sessionId: string
  turnId: string
  inputId: string
  source: InputSource
  status: 'completed' | 'failed' | 'cancelled'
  content: string
  error?: string
}

export type DeliverInput = (sessionId: string, input: SessionInput) => Promise<DeliveryReceipt>
export type ReceiveChannelMessage = (message: InboundMessage) => Promise<DeliveryReceipt>

/** Compatibility belongs at the channel boundary, not in the mailbox. */
export function channelMessageInput(message: InboundMessage): SessionInput {
  if (message.retry && message.silent) {
    throw new TypeError('An input cannot be both retry and silent')
  }
  const sender: MessageContext = {
    ...(message.channelAddress ? { channelAddress: message.channelAddress } : {}),
    channel: message.channel,
    chatId: message.chatId,
    messageId: message.messageId,
    platformMessageId: message.platformMessageId,
    senderId: message.senderId,
    senderName: message.senderName,
    chatName: message.chatName,
    isGroup: message.isGroup,
    admin: message.admin,
  }
  const envelope: InputEnvelope = {
    id: message.messageId,
    timestamp: message.timestamp,
    source: { kind: 'user', sender },
    replyTo: {
      ...(message.channelAddress ? { channelAddress: message.channelAddress } : {}),
      channel: message.channel,
      chatId: message.chatId,
      platformMessageId: message.platformMessageId,
    },
  }
  return message.retry
    ? {
      ...envelope,
      kind: 'control',
      command: { type: 'retry', fallbackContent: message.content, media: message.media },
    }
    : {
      ...envelope,
      kind: 'message',
      content: message.content,
      media: message.media,
      policy: message.silent ? 'silent' : 'interactive',
    }
}

/** Legacy channel IDs are interpreted only for reply projection. */
export function sessionReplyAddress(sessionId: string): ReplyAddress | undefined {
  const channelAddress = channelAddressFromSessionId(sessionId)
  if (channelAddress) return { channel: channelAddress.platform, chatId: channelAddress.conversationId, channelAddress }
  const colon = sessionId.indexOf(':')
  return colon > 0 && colon < sessionId.length - 1
    ? { channel: sessionId.slice(0, colon), chatId: sessionId.slice(colon + 1) }
    : undefined
}

export function inputSender(input: SessionInput): { id: string; name: string } {
  const source = input.source
  if (source.kind === 'user') {
    return { id: source.sender.senderId, name: source.sender.senderName ?? source.sender.senderId }
  }
  if (source.kind === 'session') {
    return { id: source.sessionId, name: source.senderName ?? source.sessionId }
  }
  return {
    id: source.senderId ?? `event:${source.type}`,
    name: source.senderName ?? 'System Event',
  }
}

/** Tool/channel context is a projection, never the identity of the input target. */
export function inputContext(sessionId: string, input: SessionInput): MessageContext {
  const reply = input.replyTo ?? sessionReplyAddress(sessionId)
  const sender = inputSender(input)
  const user = input.source.kind === 'user' ? input.source.sender : undefined
  return {
    ...((reply?.channelAddress ?? user?.channelAddress) ? { channelAddress: reply?.channelAddress ?? user?.channelAddress } : {}),
    channel: reply?.channel ?? 'system',
    chatId: reply?.chatId ?? sessionId,
    messageId: input.id,
    platformMessageId: reply?.platformMessageId,
    senderId: sender.id,
    senderName: sender.name,
    chatName: user?.chatName,
    isGroup: user?.isGroup ?? (input.source.kind === 'event' ? input.source.isGroup : undefined),
    admin: user?.admin ?? false,
  }
}

export function inputContent(input: SessionInput): string {
  return input.kind === 'message' ? input.content
    : input.command.type === 'retry' ? input.command.fallbackContent ?? '' : ''
}

export function retryMessage(input: SessionControlInput): SessionMessageInput {
  if (input.command.type !== 'retry') throw new TypeError('Only retry has fallback content')
  return {
    id: input.id,
    timestamp: input.timestamp,
    source: input.source,
    replyTo: input.replyTo,
    kind: 'message',
    policy: 'queue',
    content: input.command.fallbackContent ?? '',
    media: input.command.media,
  }
}
