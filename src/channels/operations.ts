import { z } from 'zod'
import type { MessageContext } from '../bus/events.ts'

const discordId = z.string().regex(/^[0-9]{1,20}$/)

export const discordHistoryArguments = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  before: discordId.optional(),
}).strict()

export const discordMessageArguments = z.object({ messageId: discordId }).strict()

export const feishuHistoryArguments = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  pageToken: z.string().min(1).max(4096).optional(),
}).strict()

export const feishuMessageArguments = z.object({ messageId: z.string().regex(/^om_[a-zA-Z0-9_-]{1,200}$/) }).strict()

export type ChannelOperationRequest =
  | { name: 'discord_history'; args: z.infer<typeof discordHistoryArguments> }
  | { name: 'discord_message_get'; args: z.infer<typeof discordMessageArguments> }
  | { name: 'feishu_history'; args: z.infer<typeof feishuHistoryArguments> }
  | { name: 'feishu_message_get'; args: z.infer<typeof feishuMessageArguments> }

export type ChannelOperation = ChannelOperationRequest['name']
export const DISCORD_READ_OPERATIONS = ['discord_history', 'discord_message_get'] as const
export const FEISHU_READ_OPERATIONS = ['feishu_history', 'feishu_message_get'] as const

export interface ChannelOperationContext extends MessageContext {
  projectId?: string
  sessionId: string
  inputSource?: 'user' | 'session' | 'event'
  remoteWorkdir?: unknown
  signal: AbortSignal
}

export interface ChannelOperationTarget {
  chatId: string
  senderId: string
  platformMessageId?: string
  signal: AbortSignal
}
