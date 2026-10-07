import { t } from './i18n.ts'
import { parseMediaFromContent } from '../../src/utils/media-parse.ts'
import { conversationFilePath } from './conversation-file-link.ts'
import type { OpenFile } from './file-workbench.ts'
import type { SessionDetails } from './session-details.ts'

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

/** Map local attachment paths to the existing workdir browser; remote display paths are not roots. */
export function attachmentFile(path: string, workdir?: SessionDetails['workdir']): OpenFile | undefined {
  if (workdir?.kind !== 'local' || workdir.available === false || !workdir.displayPath
    || !path || /[\u0000-\u001f\u007f]/.test(path)) return undefined
  const root = workdir.displayPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^[a-z]:\//i.test(`${root}/`) || root.startsWith('//')
  let relative = path.replace(/\\/g, '/')
  if (/^(?:[a-z]:\/|\/)/i.test(relative)) {
    const prefix = `${root}/`
    if (!(windows ? relative.toLowerCase().startsWith(prefix.toLowerCase()) : relative.startsWith(prefix))) return undefined
    relative = relative.slice(prefix.length)
  }
  // MEDIA contains raw filenames, not URLs: preserve literal %, #, and ? characters.
  return conversationFilePath(relative)
}

export function attachmentName(path: string): string {
  if (/^data:image\//i.test(path)) return t('Image')
  let name = path
  if (/^https?:\/\//i.test(path)) {
    try { name = decodeURIComponent(new URL(path).pathname) } catch { /* Keep the original name for malformed URLs. */ }
  }
  return name.split(/[\\/]/).pop() || t('Attachment')
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
