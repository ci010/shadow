import type { ImageSource } from './image-context.ts'
import { apiUrl } from './api-url.ts'

export interface PendingChatAttachment {
  key: string
  file: File
  kind: 'image' | 'file'
  previewUrl?: string
  sourceKey?: string
  source?: ImageSource
}

export function updateImageAttachment(
  existing: readonly PendingChatAttachment[],
  sourceKey: string,
  file: File | null,
  options: {
    source?: ImageSource
    createObjectUrl?: (file: File) => string
    revokeObjectUrl?: (url: string) => void
    createId?: () => string
  } = {},
): PendingChatAttachment[] {
  const previous = existing.find(attachment => attachment.sourceKey === sourceKey)
  if (previous?.file === file) {
    return existing.map(attachment => attachment === previous && options.source
      ? { ...attachment, source: { ...options.source } } : attachment)
  }
  if (file && !isImageAttachment(file)) throw new Error('Only an image can be added from the image preview.')
  const next: PendingChatAttachment | undefined = file ? {
    key: previous?.key ?? (options.createId ?? (() => crypto.randomUUID()))(),
    sourceKey,
    ...(options.source ? { source: { ...options.source } } : {}),
    file,
    kind: 'image',
    previewUrl: (options.createObjectUrl ?? (image => URL.createObjectURL(image)))(file),
  } : undefined
  if (previous) revokeChatAttachmentPreviews([previous], options.revokeObjectUrl)
  if (!previous) return next ? [...existing, next] : [...existing]
  return existing.flatMap(attachment => attachment === previous ? next ? [next] : [] : [attachment])
}

export interface UploadedChatAttachment extends PendingChatAttachment {
  path: string
}

export function composeImageReferenceMessage(content: string, attachments: readonly UploadedChatAttachment[]): string {
  const lines = attachments.flatMap((attachment, index) => {
    const source = attachment.source
    if (!source) return []
    return [`- Attached image: ${JSON.stringify(attachment.path)}\n`
      + `  Original file: ${JSON.stringify(source.path)}\n`
      + `  Version: ${source.modified ? 'marked copy; original file unchanged.' : 'original image (unmarked).'}\n`
      + `  Media item: ${index + 1} of ${attachments.length} (message attachment order).`]
  })
  if (!lines.length) return content
  return [content, `Image references (source metadata):\n${lines.join('\n')}`].filter(Boolean).join('\n\n')
}

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'tif',
  'svg',
  'avif',
  'heic',
  'heif',
])

function attachmentSignature(file: Pick<File, 'name' | 'size' | 'lastModified' | 'type'>): string {
  return [file.name, file.size, file.lastModified, file.type].join('\u0000')
}

export function isImageAttachment(file: Pick<File, 'name' | 'type'>): boolean {
  if (typeof file.type === 'string' && file.type.toLowerCase().startsWith('image/')) return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(ext)
}

export function clipboardImageFiles(data: {
  files?: Iterable<File>
  items?: Iterable<Pick<DataTransferItem, 'kind' | 'type' | 'getAsFile'>>
} | null): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? []).filter(isImageAttachment)
  if (files.length) return files
  for (const item of data.items ?? []) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && isImageAttachment(file)) files.push(file)
    else if (!file && item.type.toLowerCase().startsWith('image/')) {
      throw new Error('Could not read the clipboard image. Paste again or use Add file.')
    }
  }
  return files
}

export function canSendChatMessage(
  text: string,
  contextCount: number,
  attachmentCount: number,
): boolean {
  return !!text.trim() || contextCount > 0 || attachmentCount > 0
}

export function appendChatAttachments(
  existing: readonly PendingChatAttachment[],
  files: readonly File[],
  options: {
    createObjectUrl?: (file: File) => string
    createId?: () => string
  } = {},
): PendingChatAttachment[] {
  const createObjectUrl = options.createObjectUrl ?? (file => URL.createObjectURL(file))
  const createId = options.createId ?? (() => crypto.randomUUID())
  const seen = new Set(existing.map(attachment => attachmentSignature(attachment.file)))
  const next = [...existing]
  for (const file of files) {
    const signature = attachmentSignature(file)
    if (seen.has(signature)) continue
    seen.add(signature)
    const image = isImageAttachment(file)
    next.push({
      key: createId(),
      file,
      kind: image ? 'image' : 'file',
      ...(image ? { previewUrl: createObjectUrl(file) } : {}),
    })
  }
  return next
}

export function revokeChatAttachmentPreviews(
  attachments: readonly Pick<PendingChatAttachment, 'previewUrl'>[],
  revokeObjectUrl: (url: string) => void = url => URL.revokeObjectURL(url),
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) revokeObjectUrl(attachment.previewUrl)
  }
}

function invalidUploadResponse(): Error {
  return new Error('Main returned an invalid attachment upload response. Retry.')
}

async function uploadOneChatAttachment(
  apiBase: string,
  chatId: string,
  attachment: PendingChatAttachment,
  signal: AbortSignal,
  request: typeof fetch,
  parentSessionId?: string,
): Promise<UploadedChatAttachment> {
  const form = new FormData()
  form.set('chatId', chatId)
  if (parentSessionId) form.set('parentSessionId', parentSessionId)
  form.set('file', attachment.file)
  const response = await request(apiUrl(apiBase, '/api/chat/upload'), {
    method: 'POST',
    body: form,
    signal,
  })
  if (!response.ok) {
    let message = 'Could not upload attachment. Retry.'
    try {
      const body = await response.json() as { error?: unknown }
      if (typeof body?.error === 'string' && body.error) message = body.error
    } catch { /* ignore non-JSON errors */ }
    throw new Error(message)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw invalidUploadResponse()
  }
  if (
    typeof body !== 'object' || body === null || Array.isArray(body) ||
    !('path' in body) || typeof body.path !== 'string' || !body.path
  ) {
    throw invalidUploadResponse()
  }
  return { ...attachment, path: body.path }
}

export async function uploadChatAttachments(
  apiBase: string,
  chatId: string,
  attachments: readonly PendingChatAttachment[],
  signal: AbortSignal,
  request: typeof fetch = fetch,
  parentSessionId?: string,
): Promise<UploadedChatAttachment[]> {
  if (attachments.length === 0) return []
  const batch = new AbortController()
  const combined = AbortSignal.any([signal, batch.signal, AbortSignal.timeout(60_000)])
  combined.throwIfAborted()
  try {
    return await Promise.all(attachments.map(attachment =>
      uploadOneChatAttachment(apiBase, chatId, attachment, combined, request, parentSessionId)))
  } catch (error) {
    batch.abort()
    throw error
  }
}
