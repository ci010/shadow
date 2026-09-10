import type { ChatMessage } from '../providers/provider.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type {
  BackgroundTaskManager,
  BackgroundTaskSummary,
} from '../agent/background-task.ts'
import type { SkillsManager } from '../skills/loader.ts'
import type { EventService } from '../events/service.ts'
import type { EventSubscription } from '../events/types.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// ── Helpers ──────────────────────────────────────────────────────────────

function formatSessionMessage(
  msg: ChatMessage,
  index: number,
  highlight = false,
): string[] {
  const role = msg.role.toUpperCase()
  let body: string
  if (msg.role === 'assistant' && msg.tool_calls?.length) {
    const calls = msg.tool_calls
      .map((tc: NonNullable<ChatMessage['tool_calls']>[number]) =>
        `  [call ${tc.id}] ${tc.function.name}(${tc.function.arguments})`
      )
      .join('\n')
    body = msg.content ? `${msg.content}\n${calls}` : calls
  } else if (msg.role === 'tool') {
    body = `[result for ${msg.tool_call_id ?? '?'}] ${msg.content ?? ''}`
  } else {
    const c = msg.content
    if (Array.isArray(c)) {
      body = c
        .map(
          (
            part: { type: string; text?: string; image_url?: { url: string } },
          ) => {
            if (part.type === 'text') return part.text ?? ''
            if (part.type === 'image_url') {
              return `[image: ${part.image_url?.url ?? ''}]`
            }
            return `[${part.type}]`
          },
        )
        .join(' ')
    } else {
      body = String(c ?? '')
    }
  }
  const prefix = highlight ? `>>> #${index} ` : `    #${index} `
  const time = msg.timestamp ? ` ${msg.timestamp}` : ''
  return [
    `${prefix}[${role}]${msg.name ? ` (${msg.name})` : ''}${time}`,
    body,
  ]
}

// ── Sessions ─────────────────────────────────────────────────────────────

export function createSessionsHandler(sessions: SessionManager): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const read: VirtualFsHandler = async (subpath) => {
    if (!subpath) {
      const allList = await sessions.listSessions()
      // Hide internal pipeline sessions (heartbeat:*) from the default listing.
      // They can still be read directly by ID (e.g. v:sessions/heartbeat:reflector-...).
      const list = allList.filter((s) => !s.sessionId.startsWith('heartbeat:'))
      if (list.length === 0) return 'No sessions.'
      const lines: string[] = [`Sessions (${list.length}):`]
      for (const s of list) {
        const state = await sessions.getSessionState(s.sessionId)
        const parts = [`- ${s.sessionId}`]
        if (state?.originUser) parts.push(`(by ${state.originUser})`)
        if (state?.parent?.id) parts.push(`←parent: ${state.parent.id}`)
        if (s.lastActivityAt) parts.push(`[${s.lastActivityAt}]`)
        parts.push(`segments=${s.segmentIndex + 1}`)
        lines.push(parts.join(' '))
      }
      return lines.join('\n')
    }

    const qIdx = subpath.indexOf('?')
    const sessionKey = qIdx >= 0 ? subpath.slice(0, qIdx) : subpath
    const params = qIdx >= 0
      ? new URLSearchParams(subpath.slice(qIdx + 1))
      : null

    const rawIndex = params?.has('index')
      ? parseInt(params.get('index')!, 10)
      : -20
    const pageSize = params?.has('page_size')
      ? Math.min(100, Math.max(1, parseInt(params.get('page_size')!, 10)))
      : 20

    const isPhysicalId = !sessionKey.includes(':')

    let sessionLabel = isPhysicalId
      ? `Physical Session ID: ${sessionKey}`
      : `Session: ${sessionKey}`

    const state = isPhysicalId
      ? undefined
      : (await sessions.getSessionState(sessionKey))
    const physicalId = isPhysicalId
      ? sessionKey
      : state
      ? newPhysicalSessionId(state.sessionId, state.segmentIndex)
      : undefined

    if (!physicalId && !isPhysicalId) {
      return `Session "${sessionKey}" not found. It may have been lost during a restart.`
    }

    if (physicalId) {
      const sessionState = await sessions.getSessionState(sessionKey)
      const originUser = sessionState?.originUser
      const parentId = sessionState?.parent?.id
      if (originUser || parentId) {
        const meta: string[] = []
        if (originUser) meta.push(`triggered by: ${originUser}`)
        if (parentId) meta.push(`parent: ${parentId}`)
        sessionLabel += ` (${meta.join(', ')})`
      }
    }

    const { total } = await sessions.getHistory(sessionKey, {
      physicalId: isPhysicalId ? sessionKey : undefined,
      offset: 0,
      pageSize: 0,
    })

    if (total === 0) return `${sessionLabel}\nNo history yet.`

    const offset = rawIndex < 0
      ? Math.max(0, total + rawIndex)
      : Math.min(rawIndex, total)

    const { messages } = await sessions.getHistory(sessionKey, {
      physicalId: isPhysicalId ? sessionKey : undefined,
      offset,
      pageSize,
    })

    const start = offset + 1
    const end = offset + messages.length
    const lines: string[] = [
      sessionLabel,
      `Messages ${start}–${end} of ${total}`,
      '',
    ]

    for (const [idx, msg] of messages.entries()) {
      lines.push('')
      lines.push(...formatSessionMessage(msg, offset + idx + 1))
    }

    if (end < total) {
      lines.push(
        `→ ${
          total - end
        } more message(s). Use read("v:sessions/${sessionKey}?index=${end}") to continue.`,
      )
    }
    if (offset > 0) {
      lines.push(
        `← ${offset} earlier message(s). Use read("v:sessions/${sessionKey}?index=0") to read from the start.`,
      )
    }

    return lines.join('\n')
  }

  const list: VirtualFsListHandler = async () => {
    const all = await sessions.listSessions()
    const entries = []
    for (const s of all) {
      const state = await sessions.getSessionState(s.sessionId)
      const parts = [s.sessionId]
      if (state?.originUser) parts.push(`by=${state.originUser}`)
      if (state?.parent?.id) parts.push(`parent=${state.parent.id}`)
      if (s.lastActivityAt) parts.push(`last=${s.lastActivityAt}`)
      parts.push(`segments=${s.segmentIndex + 1}`)

      const { messages: history } = await sessions.getHistory(s.sessionId, {
        maxMessages: 50,
      })
      const historyText = history
        .map((m, i) => formatSessionMessage(m, i + 1).join('\n'))
        .join('\n\n')

      entries.push({
        name: s.sessionId,
        content: parts.join('  ') + '\n\n' + historyText,
      })
    }
    return entries
  }

  return { read, list }
}

// ── Background tasks ─────────────────────────────────────────────────────

export function createBgTasksHandler(backgroundTasks: BackgroundTaskManager): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const read: VirtualFsHandler = async (subpath, ctx) => {
    if (subpath) {
      return await backgroundTasks.getTaskOutput(subpath)
    }
    const tasks = backgroundTasks.listTasks(ctx.sessionId)
    if (tasks.length === 0) return 'No background tasks.'
    return tasks
      .map((t: BackgroundTaskSummary) => {
        const parts = [t.id, t.kind, t.status, t.title]
        parts.push(`created=${t.createdAt}`)
        if (t.completedAt) parts.push(`completed=${t.completedAt}`)
        if (t.error) parts.push(`error=${t.error}`)
        return parts.join('  ')
      })
      .join('\n')
  }

  const list: VirtualFsListHandler = (ctx) => {
    const tasks = backgroundTasks.listTasks(ctx.sessionId)
    return tasks.map((t: BackgroundTaskSummary) => {
      const parts = [t.id, t.kind, t.status, t.title]
      parts.push(`created=${t.createdAt}`)
      if (t.completedAt) parts.push(`completed=${t.completedAt}`)
      if (t.error) parts.push(`error=${t.error}`)
      return { name: t.id, content: parts.join('  ') }
    })
  }

  return { read, list }
}

// ── Skills ───────────────────────────────────────────────────────────────

export function createSkillsHandler(skills: SkillsManager): {
  read: VirtualFsHandler
} {
  const read: VirtualFsHandler = async (subpath) => {
    if (!subpath) {
      const names = skills.skillNames()
      if (names.length === 0) return 'No skills loaded.'
      return names.map((n) => `- ${n}`).join('\n')
    }

    const slashIdx = subpath.indexOf('/')
    const name = slashIdx >= 0 ? subpath.slice(0, slashIdx) : subpath
    const rest = slashIdx >= 0 ? subpath.slice(slashIdx + 1) : ''

    const skillBody = skills.getSkillBody(name)
    if (skillBody !== undefined) {
      if (rest) {
        const resource = await skills.getSkillResource(name, rest)
        return resource ?? `Resource not found: ${rest} in skill "${name}"`
      }
      let content = skillBody
      const related = skills.getLearnedSkills().filter((s) => {
        const relatedNames = s.learnedMeta?.related?.split(',').map((n) =>
          n.trim()
        )
        return relatedNames?.includes(name)
      })
      if (related.length > 0) {
        content += `\n\n---\nRelated learnings for "${name}":\n`
        for (const s of related) {
          content += `\n--- ${s.meta.name} ---\n${s.body}\n`
        }
      }
      return content
    }

    const detail = skills.getCategoryDetail(name)
    if (detail) return detail

    return `Unknown skill or category: ${name}`
  }

  return { read }
}

// ── Memory ───────────────────────────────────────────────────────────────

/**
 * Recursively collect file paths under `root`, relative to `root` and using
 * POSIX-style separators. Missing directories yield an empty list.
 */
async function walkMemoryFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  try {
    const dirents = await readdir(join(root, rel), { withFileTypes: true })
    for (const entry of dirents) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out.push(...await walkMemoryFiles(root, childRel))
      } else if (entry.isFile()) {
        out.push(childRel)
      }
    }
  } catch {
    // memory dir (or subdir) may not exist yet
  }
  return out
}

/**
 * Browse and search the long-term memory store under `<workspace>/memory/`.
 *
 * - `read('')` / a directory subpath → recursive file listing.
 * - a file subpath → the file's contents.
 * - `list` → every memory file with its content, powering glob/grep search.
 *
 * Reads only; the agent still writes memory through the real `memory/` path.
 */
export function createMemoryHandler(workspace: string): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const memoryRoot = join(workspace, 'memory')

  const read: VirtualFsHandler = async (subpath) => {
    if (subpath.includes('..')) return 'Invalid path.'
    const target = subpath ? join(memoryRoot, subpath) : memoryRoot
    let info
    try {
      info = await stat(target)
    } catch {
      return `Not found: memory/${subpath}`
    }
    if (info.isDirectory()) {
      const files = await walkMemoryFiles(memoryRoot, subpath)
      if (files.length === 0) {
        return subpath ? `Empty: memory/${subpath}` : 'No memories yet.'
      }
      const base = subpath ? `memory/${subpath}` : 'memory'
      return [
        `${base}/ (${files.length} file(s)):`,
        ...files.map((f) => `- ${f}`),
      ]
        .join('\n')
    }
    return await readFile(target, 'utf8')
  }

  const list: VirtualFsListHandler = async () => {
    const files = await walkMemoryFiles(memoryRoot)
    const entries: Array<{ name: string; content: string }> = []
    for (const f of files) {
      const content = await readFile(join(memoryRoot, f), 'utf8').catch(() =>
        ''
      )
      entries.push({ name: f, content })
    }
    return entries
  }

  return { read, list }
}

// ── Event subscriptions ──────────────────────────────────────────────────

function formatSubscription(s: EventSubscription): string {
  const filters: string[] = []
  if (s.source) filters.push(`source=${s.source}`)
  if (s.channel) filters.push(`channel=${s.channel}`)
  if (s.chatId) filters.push(`chat=${s.chatId}`)
  if (s.cronJobId) filters.push(`cron=${s.cronJobId}`)
  if (s.delivery) filters.push(`urgency=${s.delivery.urgency}`)
  return `• ${s.id}: event=${s.event}${
    filters.length ? ` (${filters.join(', ')})` : ''
  }`
}

/**
 * List the current session's event subscriptions and registered event sources.
 *
 * - `read('')` → all subscriptions for the calling session.
 * - `read('sources')` → all registered event sources (with default urgency).
 * - a subscription-id subpath → details for that single subscription.
 * - `list` → subscriptions as entries, powering glob/grep search.
 */
export function createEventsHandler(events: EventService): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const read: VirtualFsHandler = (subpath, ctx) => {
    if (subpath === 'sources') {
      const sources = events.listSources()
      if (sources.length === 0) return 'No event sources registered.'
      return sources.map((s) =>
        `• ${s.source} (${s.kind})${s.delivery ? ` [urgency=${s.delivery.urgency}]` : ''}${
          s.description ? ` — ${s.description}` : ''
        }`
      ).join('\n')
    }
    if (subpath) {
      const sub = events.list().find((s) => s.id === subpath)
      return sub ? formatSubscription(sub) : `Subscription "${subpath}" not found.`
    }
    const list = events.list(ctx.sessionId)
    if (list.length === 0) return 'No event subscriptions for this session.'
    return list.map(formatSubscription).join('\n')
  }

  const list: VirtualFsListHandler = (ctx) => {
    return events.list(ctx.sessionId).map((s) => ({
      name: s.id,
      content: formatSubscription(s),
    }))
  }

  return { read, list }
}
