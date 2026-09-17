import { dirname, join } from 'node:path'
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import { streamJsonlObjects } from '../utils/jsonl.ts'

const MEMORY_DIR = 'memory'

interface EventLogEntry {
  when?: string
  who?: string
  what?: string
  why?: string
  challenge?: string
  refs?: unknown[]
  /** Session that produced this event (provenance). */
  origin?: string
}

function formatEventLogEntry(
  event: EventLogEntry,
  showOrigin = false,
): string {
  const when = formatEventTime(event.when)
  const who = sanitizeMarkdownInline(event.who ?? 'unknown')
  const what = sanitizeMarkdownInline(event.what ?? '')
  const origin = showOrigin && event.origin
    ? ` [${sanitizeMarkdownInline(event.origin)}]`
    : ''
  const details: string[] = []

  if (event.why) details.push(`why: ${sanitizeMarkdownInline(event.why)}`)
  if (event.challenge) {
    details.push(`challenge: ${sanitizeMarkdownInline(event.challenge)}`)
  }
  if (Array.isArray(event.refs) && event.refs.length) {
    details.push(
      `refs: ${
        event.refs.map((ref) => sanitizeMarkdownInline(String(ref))).join(', ')
      }`,
    )
  }

  const suffix = details.length ? ` (${details.join('; ')})` : ''
  return `- ${when}${origin} **${who}** — ${what}${suffix}`
}

function formatEventTime(value?: string): string {
  if (!value) return 'unknown time'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return sanitizeMarkdownInline(value)
  return date.toISOString().slice(11, 16)
}

function sanitizeMarkdownInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Persistent memory store:
 *
 * 1. **Session memory** (`memory/sessions/<session>.md`) — persistent context
 *    for a logical conversation.
 *
 * 2. **Daily event log** (`memory/events/YYYY-MM-DD.jsonl`) — structured daily
 *    history rendered to markdown before injection into the system prompt.
 */
export class MemoryStore {
  private memoryDir: string

  constructor(workspace: string) {
    this.memoryDir = workspacePath(workspace, MEMORY_DIR)
  }

  // ── Daily event log ───────────────────────────────────────────────────

  private eventLogPath(date?: string): string {
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
   * Read today's shared event pool, split by provenance:
   * - **this session** (origin === currentSessionId) → eager, `### Recent Events`.
   * - **other sessions** → `### Related Events`, **relevance-gated** (same
   *   project or a shared modified file), capped with a `+N more` fold.
   *
   * Relevance gating only applies when the current session has signals
   * (a project or a working set); otherwise related events pass through capped.
   */
  async readEvents(
    currentSessionId: string,
    opts: {
      maxOwn?: number
      maxRelated?: number
      currentInitiative?: string
      initiativeOf?: (sessionId: string) => string | undefined
    } = {},
  ): Promise<string> {
    const { maxOwn = 40, maxRelated = 15, currentInitiative, initiativeOf } = opts
    const date = new Date().toISOString().slice(0, 10)

    const own: EventLogEntry[] = []
    const related: EventLogEntry[] = []
    for await (
      const event of streamJsonlObjects<EventLogEntry>(this.eventLogPath(date))
    ) {
      if (event.origin && event.origin === currentSessionId) own.push(event)
      else related.push(event)
    }

    // ─ Relevance gate for related events ─
    const myFiles = await this.workingSetPaths(currentSessionId)
    const gatingEnabled = !!currentInitiative || myFiles.size > 0
    const relevanceCache = new Map<string, boolean>()
    const isRelevant = async (origin?: string): Promise<boolean> => {
      if (!gatingEnabled) return true
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

    const relevant: EventLogEntry[] = []
    let irrelevant = 0
    for (const e of related) {
      if (await isRelevant(e.origin)) relevant.push(e)
      else irrelevant++
    }

    const sections: string[] = []

    if (own.length) {
      const shown = own.slice(-maxOwn)
      const lines = ['### Recent Events (this session)']
      for (const e of shown) lines.push(formatEventLogEntry(e))
      sections.push(lines.join('\n'))
    }

    if (relevant.length || irrelevant) {
      const shown = relevant.slice(-maxRelated)
      const lines = ['### Related Events (other sessions)']
      for (const e of shown) lines.push(formatEventLogEntry(e, true))
      const hidden = (relevant.length - shown.length) + irrelevant
      if (hidden > 0) lines.push(`- +${hidden} more in other sessions`)
      sections.push(lines.join('\n'))
    }

    return sections.join('\n\n')
  }

  // ── Combined context for the system prompt ────────────────────────────

  /**
   * Build a combined memory block for inclusion in the system prompt.
   * Includes session memory + today's event log rendered as markdown.
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
   * Truncates to `maxLines` to prevent oversized system prompts.
   * Returns empty string if no file exists.
   */
  async readSessionMemory(sessionKey: string, maxLines = 200): Promise<string> {
    const safe = this.sanitizeSessionKey(sessionKey)
    const filePath = join(this.sessionMemoryDir(), `${safe}.md`)
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
  async readWorkingSet(sessionKey: string, maxFiles = 50): Promise<string> {
    const latest = new Map<string, string>() // path -> action
    for await (
      const e of streamJsonlObjects<{ path?: string; action?: string }>(
        this.modifiedFilesPath(sessionKey),
      )
    ) {
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

  // ── Conventions (scoped, always-on constraints) ─────────────────

  private conventionsPath(
    scope: 'session' | 'initiative' | 'project' | 'agent',
    key?: string,
  ): string {
    if (scope === 'agent') return join(this.memoryDir, 'agent.conventions.md')
    if (scope === 'initiative' || scope === 'project') {
      if (key && (key === '.' || key === '..' || /[/\\:\0]/.test(key))) {
        throw new TypeError('Project memory key must be a single directory name')
      }
      return join(this.memoryDir, 'projects', key ?? '_', 'conventions.md')
    }
    return join(
      this.sessionMemoryDir(),
      `${this.sanitizeSessionKey(key ?? '')}.conventions.md`,
    )
  }

  private static parseBullets(content: string): string[] {
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean)
  }

  private async writeConventions(
    filePath: string,
    items: string[],
  ): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(
      filePath,
      items.length ? items.map((i) => `- ${i}`).join('\n') + '\n' : '',
    )
  }

  /** Add a convention to a scope (no-op if it already exists). */
  async addConvention(
    scope: 'session' | 'initiative' | 'project' | 'agent',
    key: string | undefined,
    text: string,
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    const filePath = this.conventionsPath(scope, key)
    const items = MemoryStore.parseBullets(
      (await readFileIfExists(filePath)) ?? '',
    )
    if (items.includes(trimmed)) return
    items.push(trimmed)
    await this.writeConventions(filePath, items)
  }

  /** Remove conventions from a scope whose text contains `text` (case-insensitive). */
  async removeConvention(
    scope: 'session' | 'initiative' | 'project' | 'agent',
    key: string | undefined,
    text: string,
  ): Promise<void> {
    const filePath = this.conventionsPath(scope, key)
    const existing = await readFileIfExists(filePath)
    if (!existing) return
    const needle = text.trim().toLowerCase()
    const items = MemoryStore.parseBullets(existing).filter(
      (i) => !i.toLowerCase().includes(needle),
    )
    await this.writeConventions(filePath, items)
  }

  /**
   * Merge active conventions across scopes (agent → initiative → session)
   * into one `### Conventions` section, each tagged with its `[scope]`.
   * Injected for main + sub agents (read-only). Returns '' if none.
   */
  async readConventions(
    sessionId: string,
    initiativeId?: string,
  ): Promise<string> {
    const groups: { tag: string; path: string }[] = [
      { tag: 'agent', path: this.conventionsPath('agent') },
    ]
    if (initiativeId) {
      groups.push({
        tag: `initiative:${initiativeId}`,
        path: this.conventionsPath('initiative', initiativeId),
      })
    }
    groups.push({
      tag: 'session',
      path: this.conventionsPath('session', sessionId),
    })

    const lines: string[] = []
    for (const { tag, path } of groups) {
      const content = await readFileIfExists(path)
      if (!content) continue
      for (const item of MemoryStore.parseBullets(content)) {
        lines.push(`- [${tag}] ${item}`)
      }
    }
    if (!lines.length) return ''
    return ['### Conventions (always in effect)', ...lines].join('\n')
  }

  // ── Long-term keyword index (lazy reference knowledge) ────────────

  /**
   * A compact keyword index derived from the wiki-item files the scribe
   * produces, **grouped by source category** (topics / identities / concepts /
   * tools). Only the keyword list is injected — full content is fetched on
   * demand via VFS (`v:memory/<group>/<kw>.md`). See MEM.md long-term index
   * (main-agent-only, lazy lookup, grouped by source).
   */
  async readKeywords(maxPerGroup = 40): Promise<string> {
    const dirs = ['topics', 'identities', 'concepts', 'tools']
    const groups: string[] = []
    for (const d of dirs) {
      let names: string[]
      try {
        names = await readdir(join(this.memoryDir, d))
      } catch {
        continue // directory doesn't exist yet
      }
      const kws = names
        .filter((n) => n.endsWith('.md'))
        .map((n) => n.slice(0, -3))
        .slice(0, maxPerGroup)
      if (kws.length) groups.push(`- ${d}: ${kws.join(', ')}`)
    }
    if (!groups.length) return ''

    return [
      '**Long-term keywords** (lazy — expand via `v:memory/<group>/<kw>.md`):',
      ...groups,
    ].join('\n')
  }
}
