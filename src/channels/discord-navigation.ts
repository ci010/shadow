import { z } from 'zod'
import { channelAddressFromSessionId } from '../bus/events.ts'
import { ChannelBoundarySchema } from './integration-contract.ts'

const snowflake = z.string().regex(/^\d{1,32}$/)
/** Presentation only. Never use navigation metadata as a routing or access grant. */
export const DiscordChannelNavigationSchema = z.object({
  id: snowflake, name: z.string().max(100).nullable(), type: z.number().int(),
  guildId: snowflake.nullable(), parentId: snowflake.nullable(), parentName: z.string().max(100).nullable(),
}).strict()
export type DiscordChannelNavigation = z.infer<typeof DiscordChannelNavigationSchema>
const passiveOrigin = z.object({
  version: z.literal(1), projectId: z.string().min(1), botInstanceId: z.string().min(1),
  platform: z.literal('discord'), conversationId: snowflake,
  kind: z.enum(['direct', 'channel', 'thread']), parentId: snowflake.optional(),
  guildId: snowflake.optional(), recipientId: snowflake.optional(), botUserId: snowflake,
  name: z.string().max(100).optional(),
})

/** Project an exact persisted origin; do not fetch Discord, inspect bindings, or guess ancestry. */
export function discordChannelNavigation(state: {
  sessionId: string; projectId?: string; mode?: string; channelBoundary?: unknown; channelSource?: unknown
}, projectId: string): DiscordChannelNavigation | undefined {
  if (state.projectId !== projectId || state.mode && state.mode !== 'session') return undefined
  const passive = state.sessionId.startsWith('channel-inbox:')
  let address
  try { address = channelAddressFromSessionId(passive ? `bot:${state.sessionId.slice('channel-inbox:'.length)}` : state.sessionId) }
  catch { return undefined }
  if (!address || address.projectId !== projectId || address.platform !== 'discord') return undefined
  if (!passive) {
    const parsed = ChannelBoundarySchema.safeParse(state.channelBoundary)
    if (!parsed.success) return undefined
    const boundary = parsed.data, location = boundary.location
    if (boundary.ownerSessionId || boundary.botInstanceId !== address.botInstanceId
      || boundary.conversationId !== address.conversationId || location.id !== address.conversationId) return undefined
    return DiscordChannelNavigationSchema.parse({ id: location.id, name: location.name, type: location.type,
      guildId: location.guildId, parentId: location.parentId, parentName: location.parentName })
  }
  const parsed = passiveOrigin.safeParse(state.channelSource)
  if (!parsed.success) return undefined
  const source = parsed.data
  if (source.projectId !== projectId || source.botInstanceId !== address.botInstanceId || source.conversationId !== address.conversationId
    || (source.kind === 'thread') !== !!source.parentId
    || (source.kind === 'direct' ? !source.recipientId || !!source.guildId : !source.guildId || !!source.recipientId)) return undefined
  return { id: source.conversationId, name: source.name ?? null, type: source.kind === 'thread' ? 11 : source.kind === 'direct' ? 1 : 0,
    guildId: source.guildId ?? null, parentId: source.parentId ?? null, parentName: null }
}
