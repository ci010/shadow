import { dirname, join } from 'node:path'
import { appendFile, mkdir, open, readdir, stat, writeFile } from 'node:fs/promises'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import { streamJsonlLines, streamJsonlObjects } from '../utils/jsonl.ts'

const MEMORY_DIR = 'memory'

interface LogEntry {
  when?: string
  who?: string
  summary?: string
  detailLine?: number
  what?: string
  why?: string
  challenge?: string
  refs?: unknown[]
  /** Session that produced this log (provenance). */
  origin?: string
}

function boundedInline(value: string, max: number): string {
  const points = Array.from(sanitizeMarkdownInline(value))
  return points.length > max ? points.slice(0, max).join('') + '…' : points.join('')
}

function formatLogEntry(log: LogEntry, date: string, showOrigin = false): string {
  const when = boundedInline(formatLogTime(log.when), 40)
  const who = boundedInline(log.who ?? 'unknown', 60)
  const origin = showOrigin && log.origin ? ` [${boundedInline(log.origin, 100)}]` : ''
  const summary = log.summary && Array.from(log.summary).length <= 280
    ? sanitizeMarkdownInline(log.summary) : ''
  // Old records have no authored summary. Never present an excerpt as one.
  const brief = summary || `[legacy/detail preview, not a summary] ${boundedInline(log.what ?? '', 180)}`
  return `- ${when}${origin} **${who}** — ${brief} (details: v:memory/events/${date}.jsonl, line ${log.detailLine})`
}

function formatLogTime(value?: string): string {
  if (!value) return 'unknown time'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return sanitizeMarkdownInline(value)
  return date.toISOString()
}

function sanitizeMarkdownInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** A deliberately small metadata subset, not a YAML evaluator. Never infer from body prose. */
function keywordPurpose(prefix: string, truncated: boolean): string {
  const lines = prefix.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  // The final line may have been cut by the byte limit; only use complete lines.
  if (truncated) lines.pop()
  let bodyStart = 0
  let description = ''
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end < 0) return '' // Incomplete metadata must not become a body/title.
    bodyStart = end + 1
    for (let i = 1; i < end; i++) {
      const match = /^description:[ \t]*(.*)$/u.exec(lines[i]!)
      if (!match) continue
      let value = match[1]!.trim()
      if (/^[|>][-+]?$/u.test(value)) {
        const parts: string[] = []
        while (i + 1 < end && /^[ \t]+\S/u.test(lines[i + 1]!)) parts.push(lines[++i]!.trim())
        value = parts.join(' ')
      } else if (value.startsWith('"')) {
        try { value = JSON.parse(value) as string } catch { value = '' }
      } else if (/^'.*'$/u.test(value)) {
        value = value.slice(1, -1).replace(/''/gu, "'")
      } else if (/^[!&*[{]/u.test(value)) {
        value = '' // Tags, aliases, anchors and collections are not strings here.
      }
      description = value
      break
    }
  }
  const title = lines.slice(bodyStart).find(line => /^#{1,6}\s+\S/u.test(line))?.replace(/^#{1,6}\s+/u, '') ?? ''
  // Strip markup delimiters/control characters and flatten authored multiline text.
  return boundedInline((description || title).replace(/[\x00-\x1f\x7f`<>]/gu, ' '), 160)
}

/**
 * Persistent memory store:
 *
 * 1. **Session memory** (`memory/sessions/<session>.md`) — persistent context
 *    for a logical conversation.
 *
 * 2. **Daily log** (`memory/events/YYYY-MM-DD.jsonl`) — structured daily
 *    history rendered to markdown before injection into the system prompt.
 */
export class MemoryStore {
  private memoryDir: string

  constructor(workspace: string) {
    this.memoryDir = workspacePath(workspace, MEMORY_DIR)
  }

  // ── Daily log ───────────────────────────────────────────────────

  private logPath(date?: string): string {
    const d = date ?? new Date().toISOString().slice(0, 10)
    return join(this.memoryDir, 'events', `${d}.jsonl`)
  }

  /**
   * The set of file paths this session has touched (for relevance / collision).
   */
  private async workingSetPaths(sessionKey: string): Promise<Set<string>> {
    const paths = new Set<string>()
    for await (
      const e of streamJsonlObjects<{ path?: string }>(
        this.modifiedFilesPath(sessionKey),
      )
    ) {
      if (e.path) paths.add(e.path)
    }
    return paths
  }

  /**
   * Read today's shared log pool, split by provenance:
   * - **this session** (origin === currentSessionId) → eager, `### Recent Logs`.
   * - **other sessions** → `### Related Logs`, **relevance-gated** (same
   *   project or a shared modified file), capped with a `+N more` fold.
   *
   * Without a Work or working-set signal, other sessions stay out of default
   * context. Their original records remain available through the memory VFS.
   */
  async readLogs(
    currentSessionId: string,
    opts: {
      maxOwn?: number
      maxRelated?: number
      maxChars?: number
      currentInitiative?: string
      initiativeOf?: (sessionId: string) => string | undefined
      since?: string
    } = {},
  ): Promise<string> {
    const { maxOwn = 40, maxRelated = 15, currentInitiative, initiativeOf } = opts
    const date = new Date().toISOString().slice(0, 10)

    const own: LogEntry[] = []
    const related: LogEntry[] = []
    let detailLine = 0
    for await (const line of streamJsonlLines(this.logPath(date), { skipEmpty: false })) {
      detailLine++
      let log: LogEntry
      try { log = JSON.parse(line) } catch { continue }
      if (!log || typeof log !== 'object') continue
      log.detailLine = detailLine
      if (opts.since && !(Date.parse(log.when ?? '') > Date.parse(opts.since))) continue
      if (log.origin && log.origin === currentSessionId) own.push(log)
      else related.push(log)
    }

    // ─ Relevance gate for related logs ─
    const myFiles = await this.workingSetPaths(currentSessionId)
    const gatingEnabled = !!currentInitiative || myFiles.size > 0
    const relevanceCache = new Map<string, boolean>()
    const isRelevant = async (origin?: string): Promise<boolean> => {
      if (!gatingEnabled) return false
      if (!origin) return false
      const cached = relevanceCache.get(origin)
      if (cached !== undefined) return cached
      let relevant = false
      if (currentInitiative && initiativeOf?.(origin) === currentInitiative) {
        relevant = true
      } else if (myFiles.size) {
        const theirs = await this.workingSetPaths(origin)
        for (const p of theirs) {
          if (myFiles.has(p)) {
            relevant = true
            break
          }
        }
      }
      relevanceCache.set(origin, relevant)
      return relevant
    }

    const relevant: LogEntry[] = []
    let irrelevant = 0
    for (const e of related) {
      if (await isRelevant(e.origin)) relevant.push(e)
      else irrelevant++
    }

    const shownOwn = own.slice(-Math.max(0, maxOwn) || own.length)
    const shownRelated = relevant.slice(-Math.max(0, maxRelated) || relevant.length)
    let omitted = 0
    const render = (): string => {
      const sections: string[] = []
      if (shownOwn.length) sections.push(['### Recent Logs (this session)',
        ...shownOwn.map(e => formatLogEntry(e, date))].join('\n'))
      const hidden = gatingEnabled ? relevant.length - shownRelated.length + irrelevant : 0
      if (shownRelated.length || hidden) sections.push(['### Related Logs (other sessions)',
        ...shownRelated.map(e => formatLogEntry(e, date, true)),
        ...(hidden ? [`- +${hidden} more in other sessions`] : [])].join('\n'))
      if (omitted) sections.push(`- ${omitted} log briefings omitted by budget; details: v:memory/events/${date}.jsonl`)
      return sections.join('\n\n')
    }
    const budget = Math.max(0, Math.floor(opts.maxChars ?? 6000))
    let output = render()
    while (output.length > budget && (shownRelated.length || shownOwn.length)) {
      if (shownRelated.length) shownRelated.shift()
      else shownOwn.shift()
      omitted++
      output = render()
    }
    // An unusually small requested budget cannot even fit the honest omission notice.
    return output.length <= budget ? output : ''
  }

  // ── Combined context for the system prompt ────────────────────────────

  /**
   * Build a combined memory block for inclusion in the system prompt.
   * Includes session memory + today's log rendered as markdown.
   */

  // ── Session memory (per-logical-session persistent context) ──────────

  private sessionMemoryDir(): string {
    return join(this.memoryDir, 'sessions')
  }

  private sanitizeSessionKey(sessionKey: string): string {
    return sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  /**
   * Read the session memory file for a logical session key.
   * Truncates to `maxLines` for bounded, explicit reads.
   * Returns empty string if no file exists.
   */
  async readSessionMemory(sessionKey: string, maxLines = 200, since?: string): Promise<string> {
    const safe = this.sanitizeSessionKey(sessionKey)
    const filePath = join(this.sessionMemoryDir(), `${safe}.md`)
    if (since) {
      try {
        if ((await stat(filePath)).mtimeMs <= Date.parse(since)) return ''
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      }
    }
    const content = await readFileIfExists(filePath)
    if (!content?.trim()) return ''
    const lines = content.split('\n')
    if (lines.length <= maxLines) return content
    return lines.slice(0, maxLines).join('\n') +
      '\n\n...[session memory truncated]'
  }

  // ── Modified Files / Working Set (deterministic, runtime-captured) ───

  private modifiedFilesPath(sessionKey: string): string {
    const safe = this.sanitizeSessionKey(sessionKey)
    return join(this.sessionMemoryDir(), `${safe}.files.jsonl`)
  }

  /**
   * Deterministically record a file the agent modified this session.
   * Append-only; called by the runtime (a tool hook), never by the LLM
   * — the worker does no bookkeeping. See MEM.md "Modified Files".
   */
  async recordModifiedFile(
    sessionKey: string,
    path: string,
    action: 'write' | 'edit',
  ): Promise<void> {
    const entry = JSON.stringify({
      when: new Date().toISOString(),
      path,
      action,
    })
    await mkdir(this.sessionMemoryDir(), { recursive: true })
    await appendFile(this.modifiedFilesPath(sessionKey), entry + '\n')
  }

  /**
   * Render this session's working set (files touched), collapsed by path
   * (latest action wins, most-recent last). Returns '' when nothing modified.
   */
  async readWorkingSet(sessionKey: string, maxFiles = 50, since?: string): Promise<string> {
    const latest = new Map<string, string>() // path -> action
    for await (
      const e of streamJsonlObjects<{ path?: string; action?: string; when?: string }>(
        this.modifiedFilesPath(sessionKey),
      )
    ) {
      if (since && !(Date.parse(e.when ?? '') > Date.parse(since))) continue
      if (!e.path) continue
      latest.delete(e.path) // re-touched file moves to the end (recency)
      latest.set(e.path, e.action ?? 'write')
    }
    if (!latest.size) return ''

    const entries = [...latest.entries()].slice(-maxFiles)
    const lines = ['### Working Set (this session)']
    for (const [path, action] of entries) {
      lines.push(`- ${path}${action === 'edit' ? ' (edit)' : ''}`)
    }
    return lines.join('\n')
  }

  // ── Long-term keyword index (lazy reference knowledge) ────────────

  /**
   * A compact keyword index derived from the wiki-item files the scribe
   * produces, **grouped by source category** (topics / identities / concepts /
   * tools). Only filenames and bounded authored descriptions/titles are injected; content is fetched on
   * demand via VFS (`v:memory/<group>/<kw>.md`). See MEM.md long-term index
   * (main-agent-only, lazy lookup, grouped by source).
   */
  async readKeywords(maxPerGroup = 40): Promise<string> {
    const dirs = ['decisions', 'topics', 'identities', 'concepts', 'tools']
    const heading = '**Long-term keywords** (lazy — expand via `v:memory/<group>/<kw>.md`):'
    const groups: string[] = []
    // Hard ceilings apply even when a caller requests an unbounded group size.
    const perGroup = Number.isFinite(maxPerGroup) ? Math.min(40, Math.max(0, Math.floor(maxPerGroup))) : 40
    let remainingEntries = 100
    let remainingReadBytes = 128 * 1024
    let remainingChars = 12000 - heading.length
    for (const d of dirs) {
      let names: string[]
      try {
        names = await readdir(join(this.memoryDir, d))
      } catch {
        continue
      }
      const entries: string[] = []
      for (const name of names.filter(n => n.endsWith('.md')).sort().slice(0, perGroup)) {
        if (!remainingEntries) break
        // Unusual names remain readable via VFS, but must not break index syntax.
        const keyword = name.slice(0, -3)
        if (keyword.length > 120 || /[\x00-\x1f`<>]/u.test(keyword)) continue
        let purpose = ''
        if (remainingReadBytes > 0) {
          try {
            const file = await open(join(this.memoryDir, d, name), 'r')
            try {
              if ((await file.stat()).isFile()) {
                const buffer = Buffer.alloc(Math.min(4096, remainingReadBytes))
                // Charge the requested size: failed/short reads cannot amplify the budget.
                remainingReadBytes -= buffer.length
                const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
                purpose = keywordPurpose(buffer.subarray(0, bytesRead).toString('utf8'), (await file.stat()).size > bytesRead)
              }
            } finally { await file.close() }
          } catch { /* Missing/unreadable content still has a filename entry. */ }
        }
        const entry = purpose ? `${keyword} — ${purpose}` : keyword
        const cost = entry.length + (entries.length ? 2 : d.length + 5)
        if (cost > remainingChars) continue
        remainingChars -= cost
        remainingEntries--
        entries.push(entry)
      }
      if (entries.length) groups.push(`- ${d}: ${entries.join(', ')}`)
    }
    return groups.length ? [heading, ...groups].join('\n') : ''
  }
}
