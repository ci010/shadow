import { z } from 'zod'
import type { ConnectionSinkProjection } from '../channels/sink-contract.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
const address = z.object({ projectId: z.string().min(1), botInstanceId: id,
  platform: z.enum(['qq', 'feishu', 'discord', 'wechat']), conversationId: z.string().min(1).max(512) }).strict()
export const channelSinkNavigationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), address, inboxSessionId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('channel-content'), address: address.extend({ platform: z.literal('discord') }),
    channelType: z.union([z.literal(0), z.literal(5), z.literal(15), z.null()]), guildId: z.string().min(1).max(512).nullable(),
    view: z.enum(['messages-and-threads', 'threads']) }).strict(),
  z.object({ kind: z.literal('connection-content'), projectId: z.string().min(1), connectionId: id }).strict(),
])
export const connectionSinkProjectionSchema = z.object({
  kind: z.literal('connection-sink'), id: z.string().min(1).max(512), projectId: z.string().min(1), connectionId: id,
  connectionPath: z.string(), sinkPath: z.string(),
  sink: z.object({ kind: z.literal('common-receipt'), reacts: z.literal(false), navigation:
    z.object({ kind: z.literal('connection-content'), projectId: z.string().min(1), connectionId: id }).strict() }).strict(),
  receivers: z.array(z.object({ id: z.string().min(1).max(256), address, name: z.string().max(512).optional(),
    path: z.string(), navigation: channelSinkNavigationSchema }).strict()).max(5000),
  bots: z.array(z.object({ botId: id, path: z.string().min(1).max(512), workflowIds: z.array(z.string().min(1).max(512)).max(1000) }).strict()).max(1024),
  guidePath: z.literal('v:bots/authoring'),
}).strict().superRefine((value, context) => {
  const canonical = `v:connections/${value.connectionId}`
  if (value.connectionPath !== `${canonical}/overview.json` || value.sinkPath !== `${canonical}/sink.json`)
    context.addIssue({ code: 'custom', message: 'Connection paths must match canonical identity.' })
  const target = value.sink.navigation
  const scope = target
  if (scope.projectId !== value.projectId || scope.connectionId !== value.connectionId)
    context.addIssue({ code: 'custom', message: 'Sink navigation ownership mismatch.' })
  if (target.kind !== 'connection-content') context.addIssue({ code: 'custom', message: 'Section navigation must address Connection content.' })
  const seen = new Set<string>()
  for (const receiver of value.receivers) {
    if (seen.has(receiver.id) || receiver.path !== `${canonical}/receivers/${encodeURIComponent(receiver.id)}.json` ||
      receiver.address.projectId !== value.projectId || receiver.address.botInstanceId !== value.connectionId)
      context.addIssue({ code: 'custom', message: 'Receiver identity/path ownership mismatch.' })
    seen.add(receiver.id)
    const nav = receiver.navigation
    if (nav.kind === 'connection-content' || nav.address.projectId !== value.projectId || nav.address.botInstanceId !== value.connectionId ||
      nav.address.platform !== receiver.address.platform || nav.address.conversationId !== receiver.address.conversationId)
      context.addIssue({ code: 'custom', message: 'Receiver navigation must match its parent address.' })
    if (nav.kind === 'channel-content' && nav.channelType !== null && (nav.channelType === 15) !== (nav.view === 'threads'))
      context.addIssue({ code: 'custom', message: 'Forum navigation must show threads.' })
  }
})
export function parseConnectionSinkProjection(raw: unknown, projectId?: string): ConnectionSinkProjection {
  const result = connectionSinkProjectionSchema.parse(raw)
  if (projectId !== undefined && result.projectId !== projectId) throw new Error('Connection sink Project ownership mismatch.')
  return result
}
