import type { PreviewPlugin } from '@open-file-viewer/core'

const textExtensions = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml',
  'ini', 'csv', 'tsv', 'log', 'js', 'ts', 'tsx', 'jsx', 'vue', 'css', 'html', 'htm', 'py', 'go', 'rs', 'sql', 'sh'])
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])
const videoExtensions = new Set(['mp4', 'webm', 'mov'])
const audioExtensions = new Set(['mp3', 'wav', 'ogg'])

/** Keep common archive entries readable without a second code/media renderer. */
export function nativeArchivePreviewPlugin(): PreviewPlugin {
  return {
    name: 'shadow-archive-entry',
    match: file => textExtensions.has(file.extension) || file.mimeType.startsWith('text/')
      || imageExtensions.has(file.extension) || videoExtensions.has(file.extension) || audioExtensions.has(file.extension),
    async render(ctx) {
      ctx.signal?.throwIfAborted()
      if (textExtensions.has(ctx.file.extension) || ctx.file.mimeType.startsWith('text/')) {
        const bytes = ctx.file.source instanceof ArrayBuffer ? ctx.file.source
          : await (ctx.file.blob ?? (ctx.file.source instanceof Blob ? ctx.file.source : undefined))?.arrayBuffer()
        if (!bytes) throw new Error('The archive entry does not contain local file bytes.')
        ctx.signal?.throwIfAborted()
        const pre = document.createElement('pre')
        pre.className = 'shadow-archive-source'
        pre.textContent = new TextDecoder().decode(bytes.slice(0, 65536))
        const note = document.createElement('p')
        note.className = 'shadow-archive-note'
        note.textContent = bytes.byteLength > 65536 ? 'Preview truncated. Download the archive for the full file.' : 'Read-only archive entry'
        ctx.viewport.append(note, pre)
        return { destroy() { note.remove(); pre.remove() } }
      }
      const blob = ctx.file.blob ?? (ctx.file.source instanceof Blob ? ctx.file.source
        : ctx.file.source instanceof ArrayBuffer ? new Blob([ctx.file.source], { type: ctx.file.mimeType }) : undefined)
      if (!blob) throw new Error('The archive entry does not contain local file bytes.')
      const url = URL.createObjectURL(blob)
      const media = imageExtensions.has(ctx.file.extension) ? document.createElement('img')
        : videoExtensions.has(ctx.file.extension) ? document.createElement('video') : document.createElement('audio')
      media.className = 'shadow-archive-media'
      media.src = url
      if (media instanceof HTMLImageElement) { media.alt = ctx.file.name; media.referrerPolicy = 'no-referrer' }
      else { media.controls = true; media.preload = 'metadata' }
      const failed = () => ctx.setError(new Error('The browser could not decode this archive entry. Download the archive to view it locally.'))
      media.addEventListener('error', failed)
      ctx.viewport.append(media)
      return {
        destroy() {
          media.removeEventListener('error', failed)
          if (media instanceof HTMLMediaElement) { media.pause(); media.removeAttribute('src'); media.load() }
          media.remove()
          URL.revokeObjectURL(url)
        },
      }
    },
  }
}
