import { parseMediaFromContent } from '../../src/utils/media-parse.ts'

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

export function attachmentName(path: string): string {
  if (/^data:image\//i.test(path)) return 'Image'
  let name = path
  if (/^https?:\/\//i.test(path)) {
    try { name = decodeURIComponent(new URL(path).pathname) } catch { /* Keep the original name for malformed URLs. */ }
  }
  return name.split(/[\\/]/).pop() || 'Attachment'
}

export function attachmentExtension(path: string): string {
  const name = attachmentName(path)
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
}

export function attachmentKind(path: string): AttachmentKind {
  if (/^data:image\//i.test(path)) return 'image'
  const ext = attachmentExtension(path)
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'avif', 'heic', 'heif'].includes(ext)) return 'image'
  if (['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio'
  return 'file'
}

/** Keep literal code examples intact; file markers outside code represent message attachments. */
export function messageAttachments(content: string, media: readonly string[] = []): { text: string; paths: string[] } {
  const parsed = parseMediaFromContent(content)
  const paths = new Set([...media, ...(parsed.media ?? [])])
  const text = parsed.text.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\2|\[file:\s*([^\]\r\n]+)\]/g,
    (match, _fence: string | undefined, _ticks: string | undefined, file: string | undefined) => {
      if (!file?.trim()) return match
      paths.add(file.trim())
      return ''
    },
  ).trim()
  return { text, paths: [...paths] }
}
