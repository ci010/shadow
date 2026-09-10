// ── Domain types ──────────────────────────────────────────────────────

export interface ActiveFileEntry {
  path: string
  description: string
}

export interface RejectedApproachEntry {
  approach: string
  outcome: string
  lesson: string
}

export interface ArchiveEntry {
  timestamp: string
  content: string
}

export interface ExtraSection {
  heading: string
  content: string
}

export interface SessionMemoryState {
  updatedAt: string
  currentFocus: string
  themes: string[]
  activeFiles: ActiveFileEntry[]
  decisions: string[]
  openTasks: string[]
  progressSummary: string
  rejectedApproaches: RejectedApproachEntry[]
  archive: ArchiveEntry[]
  extras: ExtraSection[]
}

// ── Update operations (tool arguments) ──────────────────────────────

export interface SessionMemoryUpdate {
  current_focus?: string
  progress_summary?: string
  add_themes?: string[]
  remove_themes?: string[]
  add_active_files?: ActiveFileEntry[]
  remove_active_files?: string[]
  add_decisions?: string[]
  remove_decisions?: string[]
  add_open_tasks?: string[]
  remove_open_tasks?: string[]
  add_rejected_approaches?: RejectedApproachEntry[]
  remove_rejected_approaches?: string[]
}

// ── Heading alias map ───────────────────────────────────────────────

type CanonicalField =
  | 'currentFocus'
  | 'themes'
  | 'activeFiles'
  | 'decisions'
  | 'openTasks'
  | 'progressSummary'
  | 'rejectedApproaches'
  | 'archive'

const HEADING_ALIASES: Record<string, CanonicalField> = {
  'current focus': 'currentFocus',
  'themes': 'themes',
  'active files': 'activeFiles',
  'article files': 'activeFiles',
  'files': 'activeFiles',
  'decisions': 'decisions',
  'open tasks': 'openTasks',
  'tasks': 'openTasks',
  'pending tasks': 'openTasks',
  'progress summary': 'progressSummary',
  'progress': 'progressSummary',
  'rejected approaches': 'rejectedApproaches',
  'archive': 'archive',
}

// ── Parser ──────────────────────────────────────────────────────────

interface RawSection {
  heading: string
  body: string
}

export class SessionMemoryParser {
  static parse(markdown: string): SessionMemoryState {
    const state = SessionMemoryParser.emptyState()
    if (!markdown.trim()) return state

    const timestampMatch = markdown.match(/_Updated:\s*(.+?)_/)
    if (timestampMatch) {
      state.updatedAt = timestampMatch[1].trim()
    }

    const sections = SessionMemoryParser.splitSections(markdown)

    for (const { heading, body } of sections) {
      // Strip trailing parenthetical notes from heading for alias matching
      const normalized = heading
        .replace(/\s*[（(].+[）)]$/, '')
        .toLowerCase()
        .trim()
      const field = HEADING_ALIASES[normalized]

      if (!field) {
        state.extras.push({ heading, content: body.trim() })
        continue
      }

      switch (field) {
        case 'currentFocus':
          state.currentFocus = body.trim()
          break
        case 'themes':
          state.themes = extractBulletItems(body)
          break
        case 'activeFiles':
          state.activeFiles = extractActiveFiles(body)
          break
        case 'decisions':
          state.decisions = extractBulletItems(body)
          break
        case 'openTasks':
          state.openTasks = extractBulletItems(body)
          break
        case 'progressSummary':
          state.progressSummary = body.trim()
          break
        case 'rejectedApproaches':
          state.rejectedApproaches = extractRejectedApproaches(body)
          break
        case 'archive':
          state.archive = extractArchive(body)
          break
      }
    }

    return state
  }

  static emptyState(): SessionMemoryState {
    return {
      updatedAt: '',
      currentFocus: '',
      themes: [],
      activeFiles: [],
      decisions: [],
      openTasks: [],
      progressSummary: '',
      rejectedApproaches: [],
      archive: [],
      extras: [],
    }
  }

  /**
   * Split markdown by ## headings (level 2 only, not ### or deeper).
   * Content before the first ## heading is discarded.
   */
  private static splitSections(markdown: string): RawSection[] {
    const sections: RawSection[] = []
    const lines = markdown.split(/\r?\n/)

    let currentHeading: string | null = null
    let bodyLines: string[] = []

    for (const line of lines) {
      // Match ## heading but not ### or deeper
      const match = line.match(/^##\s+(?!#)(.+)$/)
      if (match) {
        // Flush previous section
        if (currentHeading !== null) {
          sections.push({ heading: currentHeading, body: bodyLines.join('\n') })
        }
        currentHeading = match[1].trim()
        bodyLines = []
      } else if (currentHeading !== null) {
        bodyLines.push(line)
      }
      // Lines before the first ## heading are discarded (title/timestamp area)
    }

    // Flush final section
    if (currentHeading !== null) {
      sections.push({ heading: currentHeading, body: bodyLines.join('\n') })
    }

    return sections
  }
}

// ── Renderer ────────────────────────────────────────────────────────

export class SessionMemoryRenderer {
  static render(state: SessionMemoryState): string {
    const parts: string[] = []

    parts.push('# Session Context')
    parts.push(`_Updated: ${state.updatedAt || new Date().toISOString()}_`)
    parts.push('')

    parts.push('## Current Focus')
    parts.push(state.currentFocus || '(No current focus set)')
    parts.push('')

    parts.push('## Themes')
    if (state.themes.length > 0) {
      for (const theme of state.themes) {
        parts.push(`- ${theme}`)
      }
    } else {
      parts.push('(No active themes)')
    }
    parts.push('')

    parts.push('## Active Files')
    if (state.activeFiles.length > 0) {
      for (const f of state.activeFiles) {
        parts.push(`- [${f.path}](${f.path}) — ${f.description}`)
      }
    } else {
      parts.push('(No active files)')
    }
    parts.push('')

    parts.push('## Decisions')
    if (state.decisions.length > 0) {
      for (const d of state.decisions) {
        parts.push(`- ${d}`)
      }
    } else {
      parts.push('(No active decisions)')
    }
    parts.push('')

    parts.push('## Open Tasks')
    if (state.openTasks.length > 0) {
      for (const t of state.openTasks) {
        parts.push(`- ${t}`)
      }
    } else {
      parts.push('(No open tasks)')
    }
    parts.push('')

    parts.push('## Progress Summary')
    parts.push(state.progressSummary || '(No progress recorded yet)')
    parts.push('')

    parts.push('## Rejected Approaches')
    if (state.rejectedApproaches.length > 0) {
      for (const r of state.rejectedApproaches) {
        if (r.outcome || r.lesson) {
          parts.push(`- **${r.approach}**`)
          if (r.outcome) parts.push(`  - Outcome: ${r.outcome}`)
          if (r.lesson) parts.push(`  - Lesson: ${r.lesson}`)
        } else {
          parts.push(`- ${r.approach}`)
        }
      }
    } else {
      parts.push('(No rejected approaches recorded)')
    }
    parts.push('')

    if (state.archive.length > 0) {
      parts.push('---')
      parts.push('## Archive')
      for (const a of state.archive) {
        parts.push(`### ${a.timestamp}`)
        parts.push(a.content)
        parts.push('')
      }
    }

    return parts.join('\n')
  }
}

// ── Update logic ────────────────────────────────────────────────────

const MAX_ARCHIVE_ENTRIES = 5

export function applySessionMemoryUpdate(
  state: SessionMemoryState,
  update: SessionMemoryUpdate,
): SessionMemoryState {
  const next = structuredClone(state)
  next.updatedAt = new Date().toISOString()

  // Archive previous state summary if there was meaningful content
  if (state.updatedAt && state.currentFocus) {
    next.archive.unshift({
      timestamp: state.updatedAt,
      content: buildArchiveSummary(state),
    })
  }

  // Narrative replacements
  if (update.current_focus !== undefined) {
    next.currentFocus = update.current_focus
  }
  if (update.progress_summary !== undefined) {
    next.progressSummary = update.progress_summary
  }

  // Item operations: remove first, then add
  if (update.remove_themes?.length) {
    next.themes = removeBySubstring(next.themes, update.remove_themes)
  }
  if (update.add_themes?.length) {
    next.themes.push(...update.add_themes)
  }

  if (update.remove_active_files?.length) {
    next.activeFiles = next.activeFiles.filter(
      (f) =>
        !update.remove_active_files!.some((r) =>
          f.path.toLowerCase().includes(r.toLowerCase())
        ),
    )
  }
  if (update.add_active_files?.length) {
    next.activeFiles.push(...update.add_active_files)
  }

  if (update.remove_decisions?.length) {
    next.decisions = removeBySubstring(next.decisions, update.remove_decisions)
  }
  if (update.add_decisions?.length) {
    next.decisions.push(...update.add_decisions)
  }

  if (update.remove_open_tasks?.length) {
    next.openTasks = removeBySubstring(next.openTasks, update.remove_open_tasks)
  }
  if (update.add_open_tasks?.length) {
    next.openTasks.push(...update.add_open_tasks)
  }

  if (update.remove_rejected_approaches?.length) {
    next.rejectedApproaches = next.rejectedApproaches.filter(
      (r) =>
        !update.remove_rejected_approaches!.some((pat) =>
          r.approach.toLowerCase().includes(pat.toLowerCase())
        ),
    )
  }
  if (update.add_rejected_approaches?.length) {
    next.rejectedApproaches.push(...update.add_rejected_approaches)
  }

  // Archive extras (migration from old-format files)
  if (next.extras.length > 0) {
    const extrasContent = next.extras
      .map((e) => `**${e.heading}**: ${e.content.slice(0, 300)}`)
      .join('\n')
    next.archive.push({
      timestamp: `extras-migrated-${next.updatedAt}`,
      content: extrasContent,
    })
    next.extras = []
  }

  // Trim archive
  next.archive = next.archive.slice(0, MAX_ARCHIVE_ENTRIES)

  return next
}

// ── Helpers ─────────────────────────────────────────────────────────

function removeBySubstring(items: string[], patterns: string[]): string[] {
  return items.filter(
    (item) =>
      !patterns.some((pat) => item.toLowerCase().includes(pat.toLowerCase())),
  )
}

function buildArchiveSummary(state: SessionMemoryState): string {
  const lines: string[] = []
  if (state.currentFocus) {
    lines.push(`Focus: ${state.currentFocus.slice(0, 120)}`)
  }
  if (state.progressSummary) {
    lines.push(`Progress: ${state.progressSummary.slice(0, 200)}`)
  }
  if (state.openTasks.length) {
    lines.push(`Open tasks: ${state.openTasks.length}`)
  }
  return lines.join('\n') || '(empty state)'
}

/**
 * Extract top-level bullet items from markdown body.
 * Handles `- item`, `* item`, and `1. item` formats.
 * Sub-bullets (indented) are folded into the parent item.
 */
function extractBulletItems(body: string): string[] {
  const items: string[] = []
  let currentItem: string | null = null

  for (const line of body.split(/\r?\n/)) {
    // Top-level bullet: starts at column 0 with - or * or N.
    const topMatch = line.match(/^[-*]\s+(.+)/) || line.match(/^\d+\.\s+(.+)/)
    if (topMatch) {
      if (currentItem !== null) {
        items.push(currentItem.trim())
      }
      currentItem = topMatch[1]
      continue
    }

    // Indented continuation or sub-bullet — fold into current item
    const indented = line.match(/^\s{2,}(.+)/)
    if (indented && currentItem !== null) {
      currentItem += ' ' + indented[1].trim()
      continue
    }

    // Blank or non-matching line: flush
    if (currentItem !== null && line.trim() === '') {
      // Keep accumulating — blank lines within bullet lists are common
      continue
    }
  }

  if (currentItem !== null) {
    items.push(currentItem.trim())
  }

  return items.filter((i) => i.length > 0)
}

/**
 * Extract ActiveFileEntry from bullet items.
 * Handles formats:
 *   - `path` — description
 *   - `path` + `.ext`
 *   - plain path or description text
 */
function extractActiveFiles(body: string): ActiveFileEntry[] {
  const items = extractBulletItems(body)
  return items.map((item) => {
    // Try: [path](path) — description  OR  [path](path) - description
    const linkMatch = item.match(/^\[([^\]]+)\]\([^)]+\)\s*[—–-]\s*(.+)/)
    if (linkMatch) {
      return { path: linkMatch[1], description: linkMatch[2].trim() }
    }

    // Try: [path](path) (no description)
    const linkOnly = item.match(/^\[([^\]]+)\]\([^)]+\)(.*)/)
    if (linkOnly) {
      return {
        path: linkOnly[1],
        description: linkOnly[2].trim().replace(/^[—–-]\s*/, '') || '',
      }
    }

    // Try: `path` — description  OR  `path` - description
    const backtickMatch = item.match(/^`([^`]+)`\s*[—–-]\s*(.+)/)
    if (backtickMatch) {
      return { path: backtickMatch[1], description: backtickMatch[2].trim() }
    }

    // Try: `path` (no description)
    const backtickOnly = item.match(/^`([^`]+)`(.*)/)
    if (backtickOnly) {
      return {
        path: backtickOnly[1],
        description: backtickOnly[2].trim().replace(/^[—–-]\s*/, '') || '',
      }
    }

    // Fallback: treat the whole item as a path-like entry
    const dashSplit = item.split(/\s*[—–]\s*/)
    if (dashSplit.length >= 2) {
      return {
        path: dashSplit[0].trim(),
        description: dashSplit.slice(1).join(' — ').trim(),
      }
    }

    return { path: item, description: '' }
  })
}

/**
 * Extract RejectedApproachEntry from section body.
 * Handles both simple format and structured format with field markers.
 */
function extractRejectedApproaches(body: string): RejectedApproachEntry[] {
  const items = extractBulletItems(body)
  return items.map((item) => {
    // Try structured format with bold field markers
    const approachMatch = item.match(
      /\*?\*?approach\*?\*?:\s*(.+?)(?:\s*\|\s*|\s+outcome:)/i,
    )
    if (approachMatch) {
      const outcomeMatch = item.match(
        /\*?\*?outcome\*?\*?:\s*(.+?)(?:\s*\|\s*|\s+lesson:)/i,
      )
      const lessonMatch = item.match(/\*?\*?lesson\*?\*?:\s*(.+?)$/i)
      return {
        approach: approachMatch[1].trim(),
        outcome: outcomeMatch?.[1]?.trim() ?? '',
        lesson: lessonMatch?.[1]?.trim() ?? '',
      }
    }

    // Try bold approach with sub-items folded in
    const boldMatch = item.match(/^\*\*(.+?)\*\*\s*(.*)/)
    if (boldMatch) {
      const rest = boldMatch[2]
      const outcomeMatch = rest.match(/Outcome:\s*(.+?)(?:\s+Lesson:|$)/i)
      const lessonMatch = rest.match(/Lesson:\s*(.+?)$/i)
      return {
        approach: boldMatch[1].trim(),
        outcome: outcomeMatch?.[1]?.trim() ?? '',
        lesson: lessonMatch?.[1]?.trim() ?? '',
      }
    }

    // Fallback: simple format "approach — reason"
    const dashSplit = item.split(/\s*[—–]\s*/)
    if (dashSplit.length >= 2) {
      return {
        approach: dashSplit[0].trim(),
        outcome: dashSplit.slice(1).join(' — ').trim(),
        lesson: '',
      }
    }

    // Single text item
    return { approach: item, outcome: '', lesson: '' }
  })
}

/**
 * Extract archive entries from ### sub-headings.
 */
function extractArchive(body: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  const lines = body.split(/\r?\n/)
  let currentTimestamp: string | null = null
  let contentLines: string[] = []

  for (const line of lines) {
    const match = line.match(/^###\s+(.+)$/)
    if (match) {
      if (currentTimestamp !== null) {
        entries.push({
          timestamp: currentTimestamp,
          content: contentLines.join('\n').trim(),
        })
      }
      currentTimestamp = match[1].trim()
      contentLines = []
    } else if (currentTimestamp !== null) {
      contentLines.push(line)
    }
  }

  if (currentTimestamp !== null) {
    entries.push({
      timestamp: currentTimestamp,
      content: contentLines.join('\n').trim(),
    })
  }

  return entries
}
