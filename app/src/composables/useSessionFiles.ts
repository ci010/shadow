// Shared helpers for browsing session workdirs or registered Main-local folders.
import { isTextEncoding, type DecodedTextEncoding, type TextEncoding } from '../../../src/execution/filesystem/text-encoding.ts'
import { apiUrl } from '../api-url.ts'
import { nodeOfflineError, workdirUnavailableMessage } from '../workdir-request-error.ts'

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
  workdir?: { kind: 'local' | 'remote'; displayPath: string | null; scope?: 'home' }
}

export interface FilePreview {
  encoding?: DecodedTextEncoding
  encodingWarning?: string
  sourcePath?: string
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
/** Unknown extensions use the bounded text preview, which detects binary data. */
export function fileKind(ext: string): FileKind {
  const e = ext.toLowerCase()
  if (IMAGE_EXTS.has(e)) return 'image'
  if (VIDEO_EXTS.has(e)) return 'video'
  if (AUDIO_EXTS.has(e)) return 'audio'
  if (PDF_EXTS.has(e)) return 'pdf'
  if (HTML_EXTS.has(e)) return 'html'
  return 'text'
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
  const url = apiUrl(apiBase, path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

/** A folder ID selects registry-backed routes, never a renderer-supplied path. */
export function useSessionFiles(apiBase: string, folderId?: string) {
  async function requestFile(url: string, signal?: AbortSignal): Promise<Response> {
    const deadline = AbortSignal.timeout(30_000)
    try {
      return await fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) {
        throw new Error('File request timed out. Check the device connection and retry.')
      }
      throw error
    }
  }
  const root = (sessionId: string) => folderId
    ? `/api/folders/${encodeURIComponent(folderId)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}`

  async function listDir(sessionId: string, path = '', signal?: AbortSignal): Promise<DirListing> {
    const url = buildUrl(apiBase, `${root(sessionId)}/files`, { path })
    const res = await requestFile(url, signal)
    if (!res.ok) throw await fileRequestError(res)
    const data: unknown = await res.json()
    if (!isRecord(data) || typeof data.path !== 'string' || !Array.isArray(data.entries) || !data.entries.every(isFileEntry)) {
      throw new Error('Invalid file listing received. Refresh to retry.')
    }
    let workdir: DirListing['workdir']
    if (data.workdir !== undefined) {
      if (!isRecord(data.workdir) || (data.workdir.kind !== 'local' && data.workdir.kind !== 'remote')
        || (data.workdir.displayPath !== null && typeof data.workdir.displayPath !== 'string')
        || (data.workdir.scope !== undefined && (data.workdir.scope !== 'home' || data.workdir.kind !== 'local'))) {
        throw new Error('Invalid workspace information received. Refresh to retry.')
      }
      workdir = { kind: data.workdir.kind, displayPath: data.workdir.displayPath,
        ...(data.workdir.scope === 'home' ? { scope: 'home' as const } : {}) }
    }
    return { path: data.path, entries: data.entries, ...(workdir ? { workdir } : {}) }
  }

  async function searchPaths(sessionId: string, query: string, signal?: AbortSignal): Promise<{ paths: string[]; truncated: boolean }> {
    const res = await requestFile(buildUrl(apiBase, `${root(sessionId)}/files/search`, { query }), signal)
    if (!res.ok) throw await fileRequestError(res)
    const data: unknown = await res.json()
    if (!isRecord(data) || !Array.isArray(data.paths) || data.paths.length > 200
      || data.paths.some(path => typeof path !== 'string' || !path || path.startsWith('/')
        || /^[a-z]:/i.test(path) || path.includes('\\') || path.split('/').includes('..'))
      || typeof data.truncated !== 'boolean') throw new Error('Invalid file search result. Retry.')
    return { paths: data.paths as string[], truncated: data.truncated }
  }

  function rawUrl(sessionId: string, path: string): string {
    return buildUrl(apiBase, `${root(sessionId)}/raw`, { path })
  }

  async function readBlob(sessionId: string, path: string, signal?: AbortSignal): Promise<Blob> {
    const deadline = AbortSignal.timeout(30_000)
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
    try {
      const response = await fetch(rawUrl(sessionId, path), {
        signal: combined, credentials: 'same-origin', referrerPolicy: 'no-referrer', redirect: 'error',
      })
      if (!response.ok) throw await fileRequestError(response)
      // Consume the body inside the deadline, not just its response headers.
      return await response.blob()
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) {
        throw new Error('File request timed out. Check the device connection and retry.')
      }
      throw error
    }
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
    return apiUrl(apiBase, `${root(sessionId)}/static/${segments}`).toString()
  }

  async function preview(sessionId: string, path: string, maxBytes = 4096, signal?: AbortSignal, encoding: TextEncoding = 'auto'): Promise<FilePreview> {
    const url = buildUrl(apiBase, `${root(sessionId)}/preview`, {
      path,
      maxBytes: String(maxBytes),
      ...(encoding !== 'auto' ? { encoding } : {}),
    })
    const res = await requestFile(url, signal)
    if (!res.ok) throw await fileRequestError(res)
    const data: unknown = await res.json()
    if (!isRecord(data) || typeof data.binary !== 'boolean' || typeof data.size !== 'number' || !Number.isFinite(data.size) || data.size < 0
      || (!data.binary && typeof data.content !== 'string')
      || (data.sourcePath !== undefined && typeof data.sourcePath !== 'string')
      || (data.encoding !== undefined && (!isTextEncoding(data.encoding) || data.encoding === 'auto'))
      || (data.encodingWarning !== undefined && typeof data.encodingWarning !== 'string')
      || (data.content !== undefined && typeof data.content !== 'string') || (data.truncated !== undefined && typeof data.truncated !== 'boolean')) {
      throw new Error('Invalid file preview received. Reopen the file to retry.')
    }
    if (encoding !== 'auto' && data.encoding !== encoding) {
      throw new Error('Main did not apply the selected text encoding. Restart Main and reopen the file.')
    }
    return { binary: data.binary, size: data.size, content: data.content, truncated: data.truncated,
      ...(data.encoding !== undefined ? { encoding: data.encoding } : {}),
      ...(typeof data.encodingWarning === 'string' ? { encodingWarning: data.encodingWarning } : {}),
      ...(typeof data.sourcePath === 'string' ? { sourcePath: data.sourcePath } : {}) }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }
  function isFileEntry(value: unknown): value is FileEntry {
    return isRecord(value) && typeof value.name === 'string' && !!value.name && !/[\/\\]/.test(value.name)
      && value.name !== '.' && value.name !== '..' && (value.type === 'dir' || value.type === 'file')
      && typeof value.ext === 'string' && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
      && (value.mtime === null || typeof value.mtime === 'string')
  }
  async function fileRequestError(response: Response): Promise<Error> {
    const data: unknown = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null
    const code = isRecord(data) ? data.error : undefined
    const offline = nodeOfflineError(response.status, data)
    if (offline) return offline
    if (response.status === 401 || response.status === 403) return new Error('Access to these files was denied.')
    if (response.status === 404) return new Error('This file or folder is no longer available. Refresh the file tree.')
    if (code === 'invalid_text_encoding') return new Error('This text encoding is unsupported. Choose another encoding.')
    if (code === 'remote_encoding_unavailable') return new Error('Encoding changes are not supported by this remote workdir. No local file was used.')
    if (code === 'remote_workdir_requires_executor') return new Error('This remote workdir does not support this file operation yet. No local folder was used.')
    const unavailable = workdirUnavailableMessage(data)
    if (unavailable) return new Error(unavailable)
    if (code === 'remote_filesystem_failed' && isRecord(data) && data.code === 'path-denied') return new Error('Access to this file or folder was denied by the owning node.')
    if (isRecord(data) && typeof data.message === 'string') return new Error(data.message)
    if (code === 'workdir_unavailable' || code === 'remote_filesystem_failed') return new Error('The session workdir is unavailable. Check the owning node and retry.')
    if (code === 'folder_unavailable') return new Error('The folder is unavailable or has changed. Restore it or open the folder again.')
    return new Error(`Could not load files (${response.status}). Retry when Main is available.`)
  }

  return { listDir, searchPaths, rawUrl, staticUrl, preview, readBlob }
}
