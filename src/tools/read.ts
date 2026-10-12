import { projectStoragePath } from '../utils/data-paths.ts'
import { extname, isAbsolute, join, relative } from 'node:path'
import {
  mkdir,
  readdir,
  readFile,
  stat as nodeStat,
  writeFile,
} from 'node:fs/promises'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import type { ExecutionContext } from './context.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { Tool, ToolParameters, ToolResult } from './tool.ts'
import { isImagePath, readImage } from '../utils/image-input.ts'
import type { VirtualFs } from '../vfs/virtual-fs.ts'
import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemText } from '../execution/remote-filesystem-client.ts'
import { isSkillRootPath } from '../skills/paths.ts'

const MAX_SIZE_BYTES = 256 * 1024 // 256 KB
const MAX_TOKENS = 25_000
const URL_RE = /^https?:\/\//i

// ── Dedup cache ─────────────────────────────────────────────────────────────

interface ReadCacheEntry {
  mtime: number
  offset: number
  limit: number | undefined
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function displayPath(absPath: string, workspace: string): string {
  const rel = relative(workspace, absPath)
  return rel.startsWith('..') ? absPath : rel
}

/**
 * Read a file returning only the requested line range.
 * If no limit is given, caps at maxSizeBytes of raw content.
 */
async function readFileInRange(
  path: string,
  offset: number,
  limit: number | undefined,
  maxSizeBytes = MAX_SIZE_BYTES,
): Promise<{ lines: string[]; totalLines: number; clipped: boolean }> {
  const raw = await readFile(path)
  if (raw.subarray(0, 8192).includes(0)) throw new Error('Binary file cannot be read as text. Use a tool for its format.')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const text = raw.byteLength > maxSizeBytes && limit === undefined
    ? decoder.decode(raw.subarray(0, maxSizeBytes))
    : decoder.decode(raw)

  const allLines = text.split('\n')
  const totalLines = allLines.length
  const start = Math.max(0, offset)
  const end = limit !== undefined ? start + limit : totalLines
  const clipped = (raw.byteLength > maxSizeBytes && limit === undefined) ||
    end < totalLines

  return { lines: allLines.slice(start, end), totalLines, clipped }
}

/**
 * Rough token count heuristic that varies by file extension.
 * Returns an approximate token count for the content.
 */
function roughTokenCountEstimation(content: string, ext: string): number {
  // Minified / data-heavy files have fewer "words" per character
  const dataExts = new Set(['.json', '.csv', '.tsv', '.xml', '.svg', '.lock'])
  const codeExts = new Set([
    '.ts',
    '.js',
    '.tsx',
    '.jsx',
    '.py',
    '.rs',
    '.go',
    '.c',
    '.cpp',
    '.h',
    '.java',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.kt',
  ])
  const charsPerToken = dataExts.has(ext) ? 3 : codeExts.has(ext) ? 3.5 : 4 // prose / markdown / unknown
  return Math.ceil(content.length / charsPerToken)
}

/**
 * Validate that content doesn't exceed maxTokens.
 * Uses a fast rough estimate first, only throws if over limit.
 */
function validateContentTokens(
  content: string,
  ext: string,
  maxTokens = MAX_TOKENS,
): void {
  const estimate = roughTokenCountEstimation(content, ext)
  if (estimate <= maxTokens) return
  throw new MaxFileReadTokenExceededError(estimate, maxTokens)
}

export class MaxFileReadTokenExceededError extends Error {
  constructor(public actual: number, public max: number) {
    super(
      `File content (~${actual} tokens) exceeds maximum allowed tokens (${max}). ` +
        `Use offset and limit parameters to read specific portions of the file.`,
    )
    this.name = 'MaxFileReadTokenExceededError'
  }
}

/**
 * Format lines with line numbers in cat -n style.
 */
function formatWithLineNumbers(
  lines: string[],
  startLine: number,
): string {
  const width = String(startLine + lines.length).length
  return lines
    .map((line, i) => `${String(startLine + i + 1).padStart(width)}  ${line}`)
    .join('\n')
}

// ── URL fetch helpers ───────────────────────────────────────────────────────

const TEXT_CONTENT_TYPES = [
  'text/',
  'json',
  'xml',
  'javascript',
  'yaml',
  'svg',
]

function isTextContentType(contentType: string): boolean {
  return TEXT_CONTENT_TYPES.some((t) => contentType.includes(t))
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('xhtml')
}

const MIME_EXT_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
}

function guessExtension(contentType: string, url: string): string {
  for (const [mime, ext] of Object.entries(MIME_EXT_MAP)) {
    if (contentType.includes(mime)) return ext
  }
  try {
    const urlExt = new URL(url).pathname.split('.').pop()
    if (urlExt && urlExt.length <= 5 && /^[a-zA-Z0-9]+$/.test(urlExt)) {
      return urlExt
    }
  } catch { /* invalid URL */ }
  return 'bin'
}

// ── HTML → Markdown ─────────────────────────────────────────────────────────

const nhm = new NodeHtmlMarkdown({
  ignore: ['script', 'style', 'nav', 'footer', 'noscript', 'iframe'],
})

// ── ReadTool ────────────────────────────────────────────────────────────────

export class ReadTool implements Tool<ToolResult> {
  private readCache = new Map<string, ReadCacheEntry>()
  readonly name = 'read'
  readonly readonly = (args: Record<string, unknown>) => !isSkillRootPath(args.path)
  readonly supportsRemoteWorkdir = true
  readonly description =
    'Read a file, list a directory, or fetch a URL. Auto-detects mode from the path. ' +
    'Text supports offset/limit, including URLs and virtual text. Session line ranges use the same view as grep; omit ranges for recent messages. Local PNG, JPEG, GIF and WebP images return visual content (max 5 MiB, 25 million pixels); no line paging. Read images directly, not through exec/scripts. Remote image reads are not supported.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path, directory path, or URL (http/https)',
      },
      offset: {
        type: 'number',
        description:
          '1-based starting line for files, URLs and virtual text. With flag "l": item index.',
      },
      limit: {
        type: 'number',
        description: 'Number of lines (or items with flag "l") to read.',
      },
      flag: {
        type: 'string',
        description:
          'n = line numbers, r = raw URL text, l = list mode (paginate by items). Combine: "nl".',
      },
    },
    required: ['path'],
  }

  constructor(private workspace: string, private virtualFs?: VirtualFs) {}

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const raw = String(args.path)
    const flags = typeof args.flag === 'string' ? args.flag : ''
    const showLineNumbers = flags.includes('n')
    const rawFormat = flags.includes('r')
    const listMode = flags.includes('l')
    for (const key of ['offset', 'limit']) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < 1)) {
        throw new TypeError(`${key} must be a positive safe integer.`)
      }
    }

    // ── Virtual filesystem ──
    if (this.virtualFs) {
      const rel = isAbsolute(raw) ? relative(this.workspace, raw) : raw
      // Only check virtual mounts for paths that don't escape the workspace
      if (!rel.startsWith('..')) {
        if (!listMode && (args.offset !== undefined || args.limit !== undefined)
          && /^v:sessions\/(?!remote:)[^?]+$/.test(rel.replace(/\\/g, '/'))) {
          const entries = await this.virtualFs.list(rel, context)
          const entry = entries?.find(entry => entry.path === rel.replace(/\\/g, '/'))
          if (!entry) throw new Error('Session search view not found. Use the returned session reference; message paging uses ?index=0&page_size=20.')
          return this.pageText(entry.content, args, showLineNumbers)
        }
        const result = this.virtualFs.resolve(rel, context)
        if (result != null) {
          const content = await result
          if (listMode) {
            const page = this.applyListPaging(content, args)
            validateContentTokens(page, '.txt')
            return page
          }
          return this.pageText(content, args, showLineNumbers)
        }
      }
    }

    // ── URL fetch ──
    if (URL_RE.test(raw)) return await this.fetchUrl(raw, rawFormat, args, context.signal)

    if (context.remoteWorkdir) {
      if (isImagePath(raw)) throw new Error('Remote image reads are not supported by this executor. No Main filesystem fallback is allowed.')
      return await this.readRemoteFile(
        raw,
        args,
        context,
        showLineNumbers,
      )
    }

    // ── File or directory ──
    const resolved = this.resolve(raw, context)
    const stat = await nodeStat(resolved)
    if (stat.isDirectory()) return this.pageText(await this.listDir(resolved), args, showLineNumbers)
    if (!stat.isFile()) throw new Error('Read requires a regular file or directory.')
    if (isImagePath(resolved)) {
      if (args.offset !== undefined || args.limit !== undefined || flags) {
        throw new Error('Images do not support line paging or flags. Read the image without offset, limit or flag.')
      }
      const image = await readImage(resolved, context.signal, { optimizeForModel: true })
      return { content: [
        { type: 'text', text: `Image from ${JSON.stringify(resolved)} (${image.mime}, ${image.width} x ${image.height}).` },
        image.part,
      ] }
    }

    // ── Dedup check: same file + same range + unchanged mtime? ──
    const offset = typeof args.offset === 'number'
      ? Math.max(0, args.offset - 1) // convert 1-based to 0-based
      : 0
    const limit = typeof args.limit === 'number'
      ? Math.max(1, args.limit)
      : undefined
    const mtime = stat.mtime?.getTime() ?? 0
    const sessionId = context.physicalSessionId
    const cacheKey = `${sessionId}\0${resolved}`
    const cached = this.readCache.get(cacheKey)
    if (
      cached &&
      cached.mtime === mtime &&
      cached.offset === offset &&
      cached.limit === limit
    ) {
      return '[file unchanged, content already in context]'
    }

    // ── Read file in range ──
    const { lines, totalLines, clipped } = await readFileInRange(
      resolved,
      offset,
      limit,
    )

    const content = lines.join('\n')
    const ext = extname(resolved).toLowerCase()

    // ── Token validation ──
    validateContentTokens(content, ext)

    // ── Cache this read ──
    this.readCache.set(cacheKey, { mtime, offset, limit })

    // ── Format output ──
    let result = showLineNumbers
      ? formatWithLineNumbers(lines, offset)
      : lines.join('\n')

    if (clipped) {
      const nextOffset = offset + lines.length + 1 // back to 1-based
      result += `\n\n[truncated: showing lines ${offset + 1}–${
        offset + lines.length
      } of ${totalLines} — use offset=${nextOffset} to read more]`
    }

    return result
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const raw = String(args.path)
    if (URL_RE.test(raw)) return `🌐 ${raw}`
    const resolved = this.resolve(raw)
    const offset = typeof args.offset === 'number' && args.offset > 0
      ? `:${args.offset}`
      : ''
    const limit = typeof args.limit === 'number' ? `+${args.limit}` : ''
    return `📄 ${displayPath(resolved, this.workspace)}${offset}${limit}`
  }

  private resolve(p: string, context?: ExecutionContext): string {
    return resolveAgentPath(this.workspace, context?.cwd ?? this.workspace, p)
  }

  private async readRemoteFile(
    path: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
    showLineNumbers: boolean,
  ): Promise<string> {
    const remote = context.remoteWorkdir
    if (!remote) throw new Error('Remote workdir is unavailable')
    const output = await executeRemoteFilesystemText(
      {
        ...remote,
        sessionId: context.sessionId,
        turnId: context.messageId,
        signal: context.signal,
      },
      FILESYSTEM_READ_OPERATION,
      { path },
    )
    const allLines = output.split('\n')
    const offset = typeof args.offset === 'number'
      ? Math.max(0, args.offset - 1)
      : 0
    const limit = typeof args.limit === 'number'
      ? Math.max(1, args.limit)
      : undefined
    const end = limit === undefined ? allLines.length : offset + limit
    const lines = allLines.slice(offset, end)
    const content = lines.join('\n')
    validateContentTokens(content, extname(path).toLowerCase())
    let result = showLineNumbers
      ? formatWithLineNumbers(lines, offset)
      : content
    if (end < allLines.length) {
      const nextOffset = offset + lines.length + 1
      result += `\n\n[truncated: showing lines ${offset + 1}–${
        offset + lines.length
      } of ${allLines.length} — use offset=${nextOffset} to read more]`
    }
    return result
  }

  /**
   * Apply list-mode paging: split content by blank-line-separated items,
   * then apply offset/limit by item count.
   */
  private applyListPaging(
    content: string,
    args: Record<string, unknown>,
  ): string {
    // Split by double newline (blank-line-separated blocks) or single newline for simple lists
    const lines = content.split('\n')
    // Detect list items: lines starting with "- " or numbered items, or blank-line-separated blocks
    const items: string[] = []
    let current: string[] = []
    for (const line of lines) {
      if (line.trim() === '' && current.length > 0) {
        items.push(current.join('\n'))
        current = []
      } else if (current.length > 0) {
        current.push(line)
      } else if (line.trim()) {
        current.push(line)
      }
    }
    if (current.length > 0) items.push(current.join('\n'))

    const total = items.length
    const offset = typeof args.offset === 'number'
      ? Math.max(0, args.offset - 1)
      : 0
    const limit = typeof args.limit === 'number'
      ? Math.max(1, args.limit)
      : total
    const sliced = items.slice(offset, offset + limit)
    const end = offset + sliced.length

    let result = sliced.join('\n\n')
    if (end < total) {
      result += `\n\n[${total - end} more item(s) — use offset=${
        end + 1
      } to continue]`
    }
    return result
  }

  private async listDir(dirPath: string): Promise<string> {
    const entries: string[] = []
    for (const entry of await readdir(dirPath, { withFileTypes: true })) {
      entries.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
    }
    return entries.join('\n')
  }

  private async fetchUrl(
    url: string,
    rawFormat: boolean,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const res = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!res.ok) return `Error: HTTP ${res.status}`

    const contentType = res.headers.get('content-type') ??
      'application/octet-stream'

    if (!isTextContentType(contentType)) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      const ext = guessExtension(contentType, url)
      const filename = `web-fetch-${Date.now()}.${ext}`
      const tmpDir = projectStoragePath(this.workspace, '.tmp')
      try {
        await mkdir(tmpDir, { recursive: true })
      } catch { /* exists */ }
      const filePath = join(tmpDir, filename)
      await writeFile(filePath, bytes)

      return [
        `Downloaded non-text content from: ${url}`,
        `Content-Type: ${contentType}`,
        `Size: ${bytes.length} bytes`,
        `Saved to: .tmp/${filename}`,
        '',
        'Read PNG, JPEG, GIF or WebP images directly. Other binary formats require a format-specific tool.',
      ].join('\n')
    }

    const text = await res.text()
    const format = rawFormat ? 'raw' : 'markdown'

    let content: string
    if (format === 'markdown' && isHtmlContentType(contentType)) {
      content = nhm.translate(text)
    } else {
      content = text
    }
    if (String(args.flag ?? '').includes('l')) {
      const page = this.applyListPaging(content, args)
      validateContentTokens(page, '.txt')
      return page
    }
    if (args.offset !== undefined || args.limit !== undefined || String(args.flag ?? '').includes('n')) {
      return this.pageText(content, args, String(args.flag ?? '').includes('n'))
    }

    // Enforce token limit — if the fetched content is too large, write it to
    // a temp file and return the path so the agent can page through it with
    // offset/limit instead of blowing up the context window.
    const tokenEstimate = roughTokenCountEstimation(content, '.md')
    if (tokenEstimate > MAX_TOKENS) {
      const filename = `web-fetch-${Date.now()}.md`
      const tmpDir = projectStoragePath(this.workspace, '.tmp')
      try {
        await mkdir(tmpDir, { recursive: true })
      } catch { /* exists */ }
      const filePath = join(tmpDir, filename)
      await writeFile(filePath, content)

      const preview = content.slice(0, 2000)
      return [
        `Fetched ${url} (~${tokenEstimate} tokens, exceeds inline limit of ${MAX_TOKENS}).`,
        `Full content saved to: .tmp/${filename}`,
        `Use \`read(path=".tmp/${filename}", offset=1, limit=200)\` to page through it.`,
        '',
        '--- Preview (first ~2000 chars) ---',
        preview,
        '[...]',
      ].join('\n')
    }

    return content
  }

  private pageText(content: string, args: Record<string, unknown>, numbered: boolean): string {
    if (args.offset === undefined && args.limit === undefined && !numbered) {
      validateContentTokens(content, '.txt')
      return content
    }
    const lines = content.split('\n')
    const start = args.offset === undefined ? 0 : Number(args.offset) - 1
    const page = lines.slice(start, args.limit === undefined ? undefined : start + Number(args.limit))
    let result = numbered ? formatWithLineNumbers(page, start) : page.join('\n')
    validateContentTokens(result, '.txt')
    if (start + page.length < lines.length) result += `\n\n[truncated: showing lines ${start + 1}-${start + page.length} of ${lines.length}; use offset=${start + page.length + 1} to continue]`
    return result
  }

  /** Remove all cached read entries for a given session. Call on sleep/stop. */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`
    for (const key of this.readCache.keys()) {
      if (key.startsWith(prefix)) this.readCache.delete(key)
    }
  }
}
