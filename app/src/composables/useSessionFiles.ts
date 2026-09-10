// Shared helpers for browsing a session's workspace files via the
// `/api/sessions/:key/...` endpoints. Kept framework-light so both the
// sidebar tree and the main "desktop" view can reuse the same logic.

export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  ext: string
  size: number
  mtime: string | null
}

export interface DirListing {
  path: string
  entries: FileEntry[]
}

export interface FilePreview {
  binary: boolean
  size: number
  truncated?: boolean
  content?: string
}

export type FileKind = 'image' | 'video' | 'audio' | 'text' | 'html' | 'pdf' | 'other'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg'])
const PDF_EXTS = new Set(['.pdf'])
const HTML_EXTS = new Set(['.html', '.htm'])
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.xml', '.yml', '.yaml', '.csv', '.log',
  '.py', '.sh', '.bash', '.zsh', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.vue', '.go', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.kt',
  '.rb', '.php', '.sql', '.gitignore', '.dockerfile',
])

/** Classify a file by extension for choosing a preview renderer. */
export function fileKind(ext: string): FileKind {
  const e = ext.toLowerCase()
  if (IMAGE_EXTS.has(e)) return 'image'
  if (VIDEO_EXTS.has(e)) return 'video'
  if (AUDIO_EXTS.has(e)) return 'audio'
  if (PDF_EXTS.has(e)) return 'pdf'
  if (HTML_EXTS.has(e)) return 'html'
  if (TEXT_EXTS.has(e)) return 'text'
  return 'other'
}

/** A monochrome glyph used as a fallback icon per file kind / directory. */
export function fileGlyph(entry: Pick<FileEntry, 'type' | 'ext'>): string {
  if (entry.type === 'dir') return '\u{1F4C1}' // 📁
  switch (fileKind(entry.ext)) {
    case 'image': return '\u{1F5BC}' // 🖼
    case 'video': return '\u{1F3AC}' // 🎬
    case 'audio': return '\u{1F3B5}' // 🎵
    case 'pdf': return '\u{1F4D5}' // 📕
    case 'html': return '\u{1F310}' // 🌐
    case 'text': return '\u{1F4C4}' // 📄
    default: return '\u{1F4E6}' // 📦
  }
}

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Join a directory path and a child name into a normalized relative path. */
export function joinPath(dir: string, name: string): string {
  const cleanDir = dir.replace(/^[/]+|[/]+$/g, '')
  return cleanDir ? `${cleanDir}/${name}` : name
}

/** Break a relative path into breadcrumb segments with cumulative paths. */
export function breadcrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean)
  const crumbs: Array<{ name: string; path: string }> = []
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    crumbs.push({ name: p, path: acc })
  }
  return crumbs
}

function buildUrl(apiBase: string, path: string, params: Record<string, string>): string {
  const url = new URL(path, apiBase)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

/** Client for a session's workspace file endpoints. */
export function useSessionFiles(apiBase: string) {
  const encKey = (sessionId: string) => encodeURIComponent(sessionId)

  async function listDir(sessionId: string, path = ''): Promise<DirListing> {
    const url = buildUrl(apiBase, `/api/sessions/${encKey(sessionId)}/files`, { path })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`listDir failed: ${res.status}`)
    return await res.json() as DirListing
  }

  function rawUrl(sessionId: string, path: string): string {
    return buildUrl(apiBase, `/api/sessions/${encKey(sessionId)}/raw`, { path })
  }

  /**
   * Path-based URL for static serving. Unlike {@link rawUrl}, the file path is
   * part of the URL path (not a query param) so an HTML page's relative asset
   * references (CSS, fonts, images, scripts) resolve correctly.
   */
  function staticUrl(sessionId: string, path: string): string {
    const segments = path
      .replace(/^[/]+/, '')
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/')
    return new URL(`/api/sessions/${encKey(sessionId)}/static/${segments}`, apiBase).toString()
  }

  async function preview(sessionId: string, path: string, maxBytes = 4096): Promise<FilePreview> {
    const url = buildUrl(apiBase, `/api/sessions/${encKey(sessionId)}/preview`, {
      path,
      maxBytes: String(maxBytes),
    })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`preview failed: ${res.status}`)
    return await res.json() as FilePreview
  }

  return { listDir, rawUrl, staticUrl, preview }
}
