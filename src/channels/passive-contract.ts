import { z } from 'zod'
import type { ChannelAddress, InboundMessage } from '../bus/events.ts'

export function parseServiceGeneration(value: unknown): string | undefined { return value === undefined ? undefined : z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/).parse(value) }

const id = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)
export const ChannelSourceSchema = z.object({
  version: z.literal(1), projectId: id, botInstanceId: id,
  platform: z.enum(['qq', 'feishu', 'discord', 'wechat']), conversationId: id,
  kind: z.enum(['direct', 'group', 'channel', 'thread']),
  parentId: id.optional(), guildId: id.optional(), recipientId: id.optional(), botUserId: id.optional(),
  name: z.string().max(100).optional(),
}).strict().superRefine((source, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  if ((source.kind === 'thread') !== !!source.parentId) issue('Thread origins require exact parent ancestry')
  if (source.platform === 'discord') {
    if (!source.botUserId || source.kind === 'group') issue('Verified Discord identity and location required')
    if (source.kind === 'direct' ? !source.recipientId || !!source.guildId : !source.guildId || !!source.recipientId) issue('Discord origin ancestry mismatch')
  } else if (source.guildId || source.recipientId || source.botUserId) issue('Discord ancestry cannot be supplied by another platform')
})
/** Host-recorded origin evidence, not an execution or platform-output grant. */
export type ChannelSource = z.infer<typeof ChannelSourceSchema>
export const PASSIVE_CHANNEL_PREFIX = 'channel-inbox:'
export function passiveChannelId(source: Pick<ChannelAddress, 'projectId' | 'botInstanceId' | 'platform' | 'conversationId'>): string {
  return PASSIVE_CHANNEL_PREFIX + [source.projectId, source.botInstanceId, source.platform, source.conversationId].map(encodeURIComponent).join(':')
}
export function parseChannelSource(value: unknown, sessionId?: string, projectId?: string): ChannelSource | undefined {
  if (value === undefined) {
    if (sessionId?.startsWith(PASSIVE_CHANNEL_PREFIX)) throw new Error('Passive channel origin metadata is missing')
    return undefined
  }
  const source = ChannelSourceSchema.parse(value)
  if (sessionId && passiveChannelId(source) !== sessionId || projectId && source.projectId !== projectId) throw new Error('Passive channel origin mismatch')
  return source
}
export interface PassiveArrival { eligible: boolean; fresh?: boolean; assertCurrent: () => void }
export type PassiveAdmission = boolean | PassiveArrival
export type PassiveChannelMessage = InboundMessage & { passiveParentId?: string; attachmentReferences?: Array<{ id?: string; type?: string; size?: number; reference?: string }> }
/** No signed URLs, downloads, embedded images or executable attachment data. */
export function passiveAttachmentReferences(value: unknown): NonNullable<PassiveChannelMessage['attachmentReferences']> {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const data = item as Record<string, unknown>, result: NonNullable<PassiveChannelMessage['attachmentReferences']>[number] = {}
    for (const key of ['id', 'file_key', 'image_key']) if (typeof data[key] === 'string') { result.id = data[key].replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512); break }
    if (typeof data.content_type === 'string') result.type = data.content_type.slice(0, 100)
    if (typeof data.size === 'number' && Number.isSafeInteger(data.size) && data.size >= 0) result.size = data.size
    if (!result.id && typeof data.url === 'string') {
      try { const url = new URL(data.url); if (url.protocol === 'https:' && !url.username && !url.password) { result.id = `attachment:${index}`; result.reference = url.origin.slice(0, 512) } } catch { /* malformed reference is not persisted */ }
    }
    return Object.keys(result).length ? [result] : []
  })
}

/** Bounded rich-text extraction only; no SDK calls, downloads, reactions or content processors. */
export function passiveFeishuBody(type: string, raw: unknown): { text: string; attachments: NonNullable<PassiveChannelMessage['attachmentReferences']> } {
  let value: unknown
  try { value = JSON.parse(typeof raw === 'string' ? raw : '{}') } catch { return { text: `[${type}: malformed platform content]`, attachments: [] } }
  const text: string[] = [], attachments: unknown[] = []
  let remaining = 200
  const visit = (item: unknown, depth: number) => {
    if (--remaining < 0 || depth > 8 || !item || typeof item !== 'object') return
    if (Array.isArray(item)) { for (const child of item.slice(0, 100)) visit(child, depth + 1); return }
    const record = item as Record<string, unknown>
    if (typeof record.title === 'string') text.push(record.title)
    if (typeof record.text === 'string') text.push(record.text)
    if (typeof record.file_key === 'string' || typeof record.image_key === 'string') attachments.push(record)
    for (const key of ['content', 'zh_cn', 'en_us', 'ja_jp']) if (record[key]) visit(record[key], depth + 1)
  }
  visit(value, 0)
  return { text: text.join('\n').slice(0, 32000) || `[${type}]`, attachments: passiveAttachmentReferences(attachments) }
}
