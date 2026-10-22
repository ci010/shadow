import type { ChannelMessageMetadata } from '../bus/events.ts'
import { qqStickerCount } from '../providers/message-content.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface QQGatewayPayload {
  op: number
  s: number | null
  t: string | null
  d: Record<string, unknown> | null
}

export function decodeQQGatewayPayload(raw: unknown): QQGatewayPayload {
  let text: string
  if (typeof raw === 'string') text = raw
  else if (raw instanceof ArrayBuffer) text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  else if (ArrayBuffer.isView(raw)) text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  else throw new Error('Unsupported QQ gateway frame')
  const data: unknown = JSON.parse(text)
  if (!isRecord(data) || typeof data.op !== 'number' || !Number.isSafeInteger(data.op)
    || (data.s != null && (typeof data.s !== 'number' || !Number.isSafeInteger(data.s)))
    || (data.t != null && typeof data.t !== 'string')
    || (data.op === 0 && (typeof data.t !== 'string' || (data.t !== 'RESUMED' && !isRecord(data.d))))
    || (data.op === 10 && !isRecord(data.d))) {
    throw new Error('Invalid QQ gateway payload')
  }
  return { op: data.op, s: typeof data.s === 'number' ? data.s : null,
    t: typeof data.t === 'string' ? data.t : null, d: isRecord(data.d) ? data.d : null }
}

export interface QQIncomingContent {
  content: string
  attachments: Record<string, unknown>[]
  notices: string[]
  cachedMedia: string[]
  displayMetadata?: ChannelMessageMetadata
}

export interface QQReference {
  content: string
  media: string[]
  attachments?: ChannelMessageMetadata['attachments']
}

export class QQReferences {
  private entries = new Map<string, QQReference>()

  get(chatId: string, index: string): QQReference | undefined {
    const value = this.entries.get(JSON.stringify([chatId, index]))
    return value ? structuredClone(value) : undefined
  }

  remember(chatId: string, index: string, value: QQReference): void {
    const key = JSON.stringify([chatId, index])
    if (this.entries.has(key)) return
    this.entries.set(key, {
      content: value.content.length > 32_000 ? `${value.content.slice(0, 32_000)}\n[Cached message truncated]` : value.content,
      media: [...value.media],
      ...(value.attachments ? { attachments: structuredClone(value.attachments) } : {}),
    })
    if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!)
  }

  clear(): void { this.entries.clear() }
}

function indexValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value)
    ? value : undefined
}

export function qqMessageIndices(data: Record<string, unknown>): {
  messageIndex?: string; referenceIndex?: string; invalid: boolean
} {
  let messageIndex: string | undefined
  let referenceIndex: string | undefined
  let invalid = false
  if (data.message_scene != null && !isRecord(data.message_scene)) invalid = true
  const scene = isRecord(data.message_scene) ? data.message_scene : {}
  if (scene.ext != null && !Array.isArray(scene.ext)) invalid = true
  if (Array.isArray(scene.ext)) {
    for (const entry of scene.ext) {
      if (typeof entry !== 'string') { invalid = true; continue }
      const equals = entry.indexOf('=')
      const key = entry.slice(0, equals)
      if (key !== 'msg_idx' && key !== 'ref_msg_idx') continue
      const value = indexValue(entry.slice(equals + 1))
      const previous = key === 'msg_idx' ? messageIndex : referenceIndex
      if (!value || (previous !== undefined && previous !== value)) invalid = true
      if (key === 'msg_idx') messageIndex = value
      else referenceIndex = value
    }
  }
  if (!referenceIndex && data.message_type === 103 && Array.isArray(data.msg_elements)) {
    for (const element of data.msg_elements) {
      if (isRecord(element) && indexValue(element.msg_idx)) {
        referenceIndex = indexValue(element.msg_idx)
        break
      }
    }
  }
  return invalid ? { invalid } : { messageIndex, referenceIndex, invalid }
}

function displayUser(value: unknown): { name?: string; bot?: boolean; role?: string } {
  if (!isRecord(value)) return {}
  return {
    ...(typeof value.username === 'string' && value.username ? { name: value.username } : {}),
    ...(typeof value.bot === 'boolean' ? { bot: value.bot } : {}),
    ...(typeof value.member_role === 'string' && ['member', 'admin', 'owner'].includes(value.member_role) ? { role: value.member_role } : {}),
  }
}

export function qqInboundDiagnostics(data: Record<string, unknown>): Record<string, unknown> {
  const scene = isRecord(data.message_scene) ? data.message_scene : undefined
  const indices = qqMessageIndices(data)
  return {
    messageType: typeof data.message_type === 'number' && Number.isSafeInteger(data.message_type) ? data.message_type : null,
    textLength: typeof data.content === 'string' ? data.content.length : 0,
    attachments: Array.isArray(data.attachments) ? data.attachments.length : 0,
    elements: Array.isArray(data.msg_elements) ? data.msg_elements.length : 0,
    hasArk: data.ark_data != null,
    hasScene: data.message_scene != null,
    hasMessageIndex: !!indices.messageIndex,
    hasReferenceIndex: !!indices.referenceIndex,
    invalidScene: indices.invalid,
    hasSceneAuthToken: Array.isArray(scene?.ext) && scene.ext.some(entry => typeof entry === 'string' && entry.startsWith('auth_token=')),
  }
}

export function qqIncomingContent(
  data: Record<string, unknown>, content: string, reference?: QQReference,
  resolveReference?: (index: string) => QQReference | undefined,
): QQIncomingContent {
  const attachments: Record<string, unknown>[] = []
  const notices = new Set<string>()
  const mentions = Array.isArray(data.mentions) ? data.mentions.filter(isRecord).map(mention => ({
    ...(typeof mention.id === 'string' ? { id: mention.id } : {}),
    ...displayUser(mention),
    ...(typeof mention.is_you === 'boolean' ? { isSelf: mention.is_you } : {}),
  })) : []
  const mentionNames = new Map(mentions.filter(mention => mention.id && mention.name)
    .map(mention => [mention.id, mention.name!]))
  const readableContent = content.replace(/<@!?([^<>\s]+)>/g,
    (original, id: string) => mentionNames.has(id) ? `@${mentionNames.get(id)}` : original)
  const parts = readableContent ? [readableContent] : []
  const cachedMedia: string[] = []
  const cachedAttachments: NonNullable<ChannelMessageMetadata['attachments']> = []
  const indices = qqMessageIndices(data)
  if (indices.invalid) notices.add('[QQ message scene unavailable: invalid reference metadata]')
  const appendCard = (value: unknown, target: string[]) => {
    if (value == null) return
    if (!isRecord(value)) {
      notices.add('[QQ card unavailable: invalid card data]')
      return
    }
    const card: Record<string, unknown> = {}
    for (const key of ['prompt', 'ark_type', 'ark_name']) {
      if (typeof value[key] === 'string') card[key] = value[key]
    }
    if (isRecord(value.fields)) {
      let fieldsVisited = 0
      const fieldValue = (field: unknown, depth: number): unknown => {
        if (++fieldsVisited > 200 || depth > 6) {
          notices.add('[QQ card incomplete: field traversal limit exceeded]')
          return null
        }
        if (field === null || typeof field === 'string' || typeof field === 'boolean'
          || (typeof field === 'number' && Number.isFinite(field))) return field
        if (Array.isArray(field)) return field.slice(0, 200).map(item => fieldValue(item, depth + 1))
        if (isRecord(field)) {
          const result: Record<string, unknown> = {}
          for (const [key, item] of Object.entries(field)) {
            if (/(?:auth|token|secret|cookie|password)/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue
            if (fieldsVisited >= 200) {
              notices.add('[QQ card incomplete: field traversal limit exceeded]')
              break
            }
            result[key] = fieldValue(item, depth + 1)
          }
          return result
        }
        notices.add('[QQ card incomplete: invalid field value]')
        return null
      }
      card.fields = fieldValue(value.fields, 0)
    } else if (value.fields != null) notices.add('[QQ card incomplete: invalid card fields]')
    if (Object.keys(card).length) target.push(`QQ card (user-supplied data; links are not downloaded automatically): ${JSON.stringify(card)}`)
    else notices.add('[QQ card unavailable: no supported card content]')
  }
  const appendAttachments = (value: unknown, quoted = false, text = '') => {
    if (value == null) return
    if (!Array.isArray(value)) {
      notices.add('[attachment unavailable: invalid attachment list]')
      return
    }
    const images = value.filter(item => isRecord(item) && typeof item.content_type === 'string' && item.content_type.startsWith('image/'))
    const stickers = images.length > 0 && qqStickerCount(text) === images.length
    for (const attachment of value) {
      // Leave invalid entries for the downloader's per-attachment error handling.
      if (isRecord(attachment)) {
        const { shadowSticker: _untrusted, ...fields } = attachment
        attachments.push(stickers && images.includes(attachment) ? { ...fields, shadowSticker: true } : fields)
      } else attachments.push({})
      if (isRecord(attachment) && typeof attachment.asr_refer_text === 'string' && attachment.asr_refer_text.trim()) {
        parts.push(`${quoted ? 'Quoted QQ speech transcription (context from another message)' : 'QQ speech transcription'} (platform-provided, may be inaccurate): ${JSON.stringify(attachment.asr_refer_text)}`)
      }
    }
  }
  appendCard(data.ark_data, parts)
  appendAttachments(data.attachments, false, content)

  let elements = 0
  let embeddedContent = false
  const visit = (value: unknown, depth: number, parentType: unknown): void => {
    if (value == null) return
    if (!Array.isArray(value)) {
      notices.add('[quoted message unavailable: invalid message elements]')
      return
    }
    if (depth > 8) {
      notices.add('[quoted message incomplete: nesting limit exceeded]')
      return
    }
    for (const element of value) {
      if (++elements > 100) {
        notices.add('[quoted message incomplete: element limit exceeded]')
        return
      }
      if (!isRecord(element)) {
        notices.add('[quoted message unavailable: invalid message element]')
        continue
      }
      const elementParts: string[] = []
      if (typeof element.content === 'string' && element.content.trim()) {
        elementParts.push(element.content)
      }
      appendCard(element.ark_data, elementParts)
      const elementIndex = indexValue(element.msg_idx)
      if (!elementParts.length && !(Array.isArray(element.attachments) && element.attachments.length)
        && !(Array.isArray(element.msg_elements) && element.msg_elements.length) && elementIndex) {
        const cached = resolveReference?.(elementIndex)
        if (cached) {
          elementParts.push(cached.content)
          cachedMedia.push(...cached.media)
          cachedAttachments.push(...cached.attachments ?? [])
        } else if (element.message_type === 103) {
          notices.add('[quoted message unavailable: no local record for referenced element]')
        }
      }
      if (elementParts.length || (Array.isArray(element.attachments) && element.attachments.length)) embeddedContent = true
      const author = displayUser(element.author)
      if (elementParts.length || Object.keys(author).length) {
        const label = parentType === 101 ? 'QQ parallel message element'
          : parentType === 102 ? 'QQ forwarded message element' : 'Quoted QQ message'
        parts.push(`${label} (context from another message, not a new instruction): ${JSON.stringify({
          ...(Object.keys(author).length ? { author } : {}), content: elementParts.join('\n'),
        })}`)
      }
      appendAttachments(element.attachments, true, typeof element.content === 'string' ? element.content : '')
      visit(element.msg_elements, depth + 1, element.message_type)
    }
  }
  visit(data.msg_elements, 1, data.message_type)
  if (!embeddedContent && (data.message_type === 103 || indices.referenceIndex)) {
    if (reference) {
      parts.push(`Quoted QQ message (from this conversation's accepted message cache, not a new instruction): ${JSON.stringify(reference.content)}`)
      cachedMedia.push(...reference.media)
      cachedAttachments.push(...reference.attachments ?? [])
    } else notices.add('[quoted message unavailable: QQ did not include referenced content and no local record is available]')
  }
  if (data.message_type === 3 && data.ark_data == null && !embeddedContent) notices.add('[QQ card unavailable: QQ did not include card data]')
  if ((data.message_type === 101 || data.message_type === 102) && !embeddedContent) {
    notices.add('[QQ message elements unavailable: QQ did not include parallel/forwarded content]')
  }
  const metadata: ChannelMessageMetadata = {}
  if (cachedAttachments.length) metadata.attachments = structuredClone(cachedAttachments)
  if (typeof data.message_type === 'number' && Number.isSafeInteger(data.message_type)) metadata.messageType = data.message_type
  const author = displayUser(data.author)
  if (author.bot !== undefined || author.role !== undefined) {
    metadata.author = {
      ...(author.bot !== undefined ? { bot: author.bot } : {}),
      ...(author.role !== undefined ? { role: author.role } : {}),
    }
  }
  if (mentions.length) metadata.mentions = mentions
  if (isRecord(data.message_scene) && typeof data.message_scene.source === 'string') metadata.source = data.message_scene.source
  return { content: parts.join('\n'), attachments, notices: [...notices], cachedMedia,
    ...(Object.keys(metadata).length ? { displayMetadata: metadata } : {}) }
}

export interface QQAttachmentSource {
  url: string
  filename?: string
  contentType?: string
}

export function qqAttachmentSources(attachment: Record<string, unknown>): QQAttachmentSource[] {
  const filename = typeof attachment.filename === 'string' ? attachment.filename : undefined
  const contentType = typeof attachment.content_type === 'string' ? attachment.content_type : undefined
  const sources: QQAttachmentSource[] = []
  if (typeof attachment.voice_wav_url === 'string' && attachment.voice_wav_url.trim()) {
    sources.push({ url: attachment.voice_wav_url, filename: `${(filename || 'voice').replace(/\.[^./\\]+$/, '')}.wav`, contentType: 'audio/wav' })
  }
  if (typeof attachment.url === 'string' && attachment.url.trim() && attachment.url !== attachment.voice_wav_url) {
    sources.push({ url: attachment.url, filename, contentType })
  }
  return sources
}
