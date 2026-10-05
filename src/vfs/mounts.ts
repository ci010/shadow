import type { ChatMessage } from '../providers/provider.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { TopicService } from '../sessions/topics.ts'
import {
  backgroundExecutionId,
  backgroundTaskId,
  type BackgroundTaskManager,
} from '../agent/background-task.ts'
import { assertExecutionActor, assertOwnedExecution } from '../sessions/execution-scope.ts'
import type { Skill, SkillsManager } from '../skills/loader.ts'
import { loadSingleSkill } from '../skills/parse.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { EventService } from '../events/service.ts'
import type { EventSubscription } from '../events/types.ts'
import type { VirtualFsHandler, VirtualFsListHandler, VirtualFsWriteHandler } from './virtual-fs.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isNotFoundError } from '../utils/runtime.ts'
import type { A2aSessions } from '../a2a/sessions.ts'
import { WriteTool } from '../tools/filesystem.ts'

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

function formatSessionHistory(messages: ChatMessage[]): string {
  return messages.map((message, index) => formatSessionMessage(message, index + 1).join('\n')).join('\n\n')
}

// ── Sessions ─────────────────────────────────────────────────────────────

export function createSessionsHandler(
  sessions: Pick<SessionManager, 'listSessions' | 'getSessionState' | 'getHistory'>,
  topics?: () => TopicService,
  remote?: Pick<A2aSessions, 'read' | 'entries' | 'canDiscover'>,
): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const read: VirtualFsHandler = async (subpath, context) => {
    topics?.().assertActor(context.projectId, context.sessionId)
    context.signal.throwIfAborted()
    if (subpath.startsWith('remote:')) {
      if (!remote) throw new Error('A2A is not configured in this Project.')
      return remote.read(subpath, context)
    }
    if (subpath.endsWith('/brief') && topics) {
      const summary = (await topics().summaries()).find(topic => topic.sessionId === subpath.slice(0, -6))
      if (!summary) throw new Error('Unknown Project session metadata.')
      return JSON.stringify(summary, null, 2)
    }
    if (!subpath) {
      const allList = await sessions.listSessions()
      // Hide internal pipeline sessions (heartbeat:*) from the default listing.
      // They can still be read directly by ID (e.g. v:sessions/heartbeat:reflector-...).
      const list = allList.filter((s) => !s.sessionId.startsWith('heartbeat:'))
      const external = remote?.canDiscover(context)
        ? remote.entries(context).filter(entry => !entry.name.includes('/')) : []
      if (list.length === 0 && external.length === 0) return 'No sessions.'
      const lines: string[] = [`Sessions (${list.length + external.length}):`]
      for (const s of list) {
        const state = await sessions.getSessionState(s.sessionId)
        const parts = [`- ${s.sessionId}`]
        if (state?.originUser) parts.push(`(by ${state.originUser})`)
        if (state?.parent?.id) parts.push(`←parent: ${state.parent.id}`)
        if (state?.mode && state.mode !== 'session') parts.push(`mode=${state.mode} status=${state.executionStatus ?? 'unknown'}`)
        if (s.lastActivityAt) parts.push(`[${s.lastActivityAt}]`)
        parts.push(`segments=${s.segmentIndex + 1}`)
        lines.push(parts.join(' '))
      }
      if (external.length) lines.push('', 'Owned remote conversations (cached):', ...external.map(entry => entry.content))
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
      ? physicalSessionId(state)
      : undefined
    if (state?.mode && state.mode !== 'session') {
      sessionLabel += `\nExecution: ${state.executionId ?? state.sessionId}; mode=${state.mode}; status=${state.executionStatus ?? 'unknown'}`
    }

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

  const list: VirtualFsListHandler = async (context, options) => {
    topics?.().assertActor(context.projectId, context.sessionId)
    context.signal.throwIfAborted()
    const all = await sessions.listSessions()
    const entries = []
    const subpath = options?.subpath
    const selected = (name: string) => !subpath || name === subpath || name.startsWith(`${subpath}/`)
    if (subpath?.startsWith('remote:')) {
      if (!remote) throw new Error('A2A is not configured in this Project.')
      return remote.entries(context, options)
    }
    // Handoff references name physical segments, not discoverable logical sessions.
    if (subpath && !/[:/?]/.test(subpath)) {
      const { messages, total } = await sessions.getHistory(subpath, {
        physicalId: subpath,
        maxMessages: Number.MAX_SAFE_INTEGER,
      })
      context.signal.throwIfAborted()
      if (total === 0) return []
      return [{
        name: subpath,
        content: options?.content === false ? ''
          : `Physical Session ID: ${subpath}\n\n${formatSessionHistory(messages)}`,
      }]
    }
    if (remote?.canDiscover(context)) entries.push(...remote.entries(context, options))
    for (const summary of await topics?.().summaries() ?? []) {
      if (selected(`${summary.sessionId}/brief`)) {
        entries.push({ name: `${summary.sessionId}/brief`, content: options?.content === false ? '' : JSON.stringify(summary, null, 2) })
      }
    }
    for (const s of all) {
      context.signal.throwIfAborted()
      if (!selected(s.sessionId)) continue
      if (options?.content === false) {
        entries.push({ name: s.sessionId, content: '' })
        continue
      }
      const state = await sessions.getSessionState(s.sessionId)
      const parts = [s.sessionId]
      if (state?.originUser) parts.push(`by=${state.originUser}`)
      if (state?.parent?.id) parts.push(`parent=${state.parent.id}`)
      if (state?.mode && state.mode !== 'session') parts.push(`mode=${state.mode} status=${state.executionStatus ?? 'unknown'}`)
      if (s.lastActivityAt) parts.push(`last=${s.lastActivityAt}`)
      parts.push(`segments=${s.segmentIndex + 1}`)

      const { messages: history } = await sessions.getHistory(s.sessionId, {
        maxMessages: Number.MAX_SAFE_INTEGER,
      })
      const historyText = formatSessionHistory(history)

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

export function createBgTasksHandler(
  backgroundTasks: BackgroundTaskManager,
  sessions: Pick<SessionManager, 'listSessions' | 'getSessionState' | 'getDelegationOwner' | 'assertFolderAccess' | 'getHistory'>,
  remote?: Pick<A2aSessions, 'read' | 'entries' | 'canDiscover'>,
): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const history = createSessionsHandler(sessions)
  const isRemoteExecution = (path: string) => /^remote:[^/]+\/executions\/[^/]+$/.test(path)
  const localSummary = (executionId: string, ctx: ExecutionContext) => {
    const state = assertOwnedExecution(sessions, executionId, ctx)
    return {
      executionId, sessionId: state.sessionId, ownerSessionId: ctx.sessionId,
      kind: 'local', mode: state.mode, agentType: state.agentType,
      status: state.executionStatus ?? 'unknown', lastActivityAt: state.lastActivityAt,
      history: `v:sessions/${state.sessionId}`,
    }
  }
  const list: VirtualFsListHandler = (ctx, options) => {
    assertExecutionActor(sessions, ctx)
    backgroundTasks.assertOwner(ctx)
    const selected = (name: string) => !options?.subpath || name === options.subpath || name.startsWith(`${options.subpath}/`)
    const content = (value: unknown) => options?.content === false ? '' : JSON.stringify(value, null, 2)
    const entries = backgroundTasks.listTasks(ctx.sessionId).filter(task => selected(backgroundExecutionId(task.id))).map(task => ({
      name: backgroundExecutionId(task.id),
      content: content({ ...task, executionId: backgroundExecutionId(task.id), ownerSessionId: task.sessionId }),
    }))
    for (const state of sessions.listSessions()) {
      if ((state.mode !== 'task' && state.mode !== 'call') || state.projectId !== ctx.projectId ||
        sessions.getDelegationOwner(state.sessionId) !== ctx.sessionId || !selected(state.sessionId)) continue
      ctx.signal.throwIfAborted()
      entries.push({ name: state.sessionId, content: content(localSummary(state.sessionId, ctx)) })
    }
    if (options?.subpath?.startsWith('remote:') || remote?.canDiscover(ctx)) {
      if (!remote) throw new Error('A2A is not configured in this Project.')
      entries.push(...remote.entries(ctx, options).filter(entry => isRemoteExecution(entry.name)))
    }
    return entries
  }
  const read: VirtualFsHandler = async (subpath, ctx) => {
    assertExecutionActor(sessions, ctx)
    if (!subpath) {
      const entries = await list(ctx)
      return entries.length ? entries.map(entry => entry.content).join('\n\n') : 'No owned executions.'
    }
    if (subpath.startsWith('remote:')) {
      if (!remote) throw new Error('A2A is not configured in this Project.')
      if (!isRemoteExecution(subpath)) throw new Error('Read an execution from v:bg; conversations belong in v:sessions.')
      return remote.read(subpath, ctx)
    }
    if (subpath.startsWith('bg:')) {
      const taskId = backgroundTaskId(subpath)
      backgroundTasks.assertOwner(ctx, taskId)
      const output = await backgroundTasks.getTaskOutput(taskId)
      assertExecutionActor(sessions, ctx)
      backgroundTasks.assertOwner(ctx, taskId)
      return output
    }
    const executionId = subpath.split('?')[0]
    assertOwnedExecution(sessions, executionId, ctx)
    const output = await history.read(subpath, ctx)
    const summary = localSummary(executionId, ctx)
    return `${JSON.stringify(summary, null, 2)}\n\n${output}`
  }

  return { read, list }
}

// ── Skills ───────────────────────────────────────────────────────────────

export function createSkillsHandler(
  skills: SkillsManager,
  registerTools?: (skill: Skill, context: ExecutionContext) => Promise<string[]>,
): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const read: VirtualFsHandler = async (subpath, context) => {
    if (!subpath) {
      const names = skills.availableSkills(context.admin).map(skill => skill.meta.name)
      if (names.length === 0) return 'No skills loaded.'
      return names.map((n) => `- ${n}`).join('\n')
    }

    const slashIdx = subpath.indexOf('/')
    const name = slashIdx >= 0 ? subpath.slice(0, slashIdx) : subpath
    const rest = slashIdx >= 0 ? subpath.slice(slashIdx + 1) : ''

    const cached = skills.getSkill(name, context.admin)
    const skill = cached && !rest ? await loadSingleSkill(cached.dirPath, name) : cached
    if (skill?.meta.admin && !context.admin) return `Unknown skill or category: ${name}`
    const skillBody = skill?.body
    if (skillBody !== undefined) {
      if (rest) {
        const resource = await skills.getSkillResource(name, rest)
        return resource ?? `Resource not found: ${rest} in skill "${name}"`
      }
      let content = skillBody
      if (skill) {
        if (skill.meta.toolsError) throw new Error(`Invalid tools in skill "${name}": ${skill.meta.toolsError}`)
        if (Object.keys(skill.meta.tools ?? {}).length && !registerTools) {
          throw new Error(`Skill "${name}" declares tools, but skill tool registration is not configured`)
        }
        const registered = await registerTools?.(skill, context) ?? []
        if (registered.length) {
          content += `\n\nRegistered for this session: ${registered.join(', ')}. Call with invoke_tool({name, args}); no separate loading step is needed. Modules run lazily. After sleep, read this skill again.`
        }
      }
      const related = skills.getLearnedSkills().filter((s) => {
        if (s.meta.admin && !context.admin) return false
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
      skills.markSkillUsed(name, context.sessionId)
      return content
    }

    const detail = skills.getCategoryDetail(name, context.admin)
    if (detail) return detail

    return `Unknown skill or category: ${name}`
  }

  const list: VirtualFsListHandler = async (context, options) => {
    const entries = []
    const subpath = options?.subpath
    for (const skill of skills.availableSkills(context.admin)) {
      context.signal.throwIfAborted()
      const name = skill.meta.name
      if (subpath && name !== subpath && !subpath.startsWith(`${name}/`)) continue
      entries.push({ name, content: options?.content === false ? '' : skill.body, warning: skill.meta.toolsError })
      for (const resource of await walkResourceFiles(skill.dirPath, context.signal)) {
        const path = `${name}/${resource}`
        if (subpath && path !== subpath && !path.startsWith(`${subpath}/`)) continue
        context.signal.throwIfAborted()
        entries.push({
          name: path,
          content: options?.content === false ? '' : await readFile(join(skill.dirPath, resource), 'utf8'),
        })
      }
    }
    return entries
  }

  return { read, list }
}

// ── Memory ───────────────────────────────────────────────────────────────

/**
 * Recursively collect file paths under `root`, relative to `root` and using
 * POSIX-style separators. Missing directories yield an empty list.
 */
async function walkResourceFiles(root: string, signal: AbortSignal, rel = ''): Promise<string[]> {
  signal.throwIfAborted()
  const out: string[] = []
  try {
    const dirents = await readdir(join(root, rel), { withFileTypes: true })
    for (const entry of dirents) {
      signal.throwIfAborted()
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out.push(...await walkResourceFiles(root, signal, childRel))
      } else if (entry.isFile()) {
        out.push(childRel)
      }
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error
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
 * Wiki writes share the filesystem writer; source records and internal state stay read-only here.
 */
export function createMemoryHandler(workspace: string, projectId?: string): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
  write: VirtualFsWriteHandler
} {
  const memoryRoot = join(workspace, 'memory')
  const writer = new WriteTool(workspace, undefined, true)

  const read: VirtualFsHandler = async (subpath, context) => {
    if (subpath.includes('..')) return 'Invalid path.'
    const target = subpath ? join(memoryRoot, subpath) : memoryRoot
    let info
    try {
      info = await stat(target)
    } catch {
      return `Not found: memory/${subpath}`
    }
    if (info.isDirectory()) {
      const files = await walkResourceFiles(memoryRoot, context.signal, subpath)
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

  const list: VirtualFsListHandler = async (context, options) => {
    const files = await walkResourceFiles(memoryRoot, context.signal)
    const entries: Array<{ name: string; content: string }> = []
    for (const f of files) {
      context.signal.throwIfAborted()
      if (options?.subpath && f !== options.subpath && !f.startsWith(`${options.subpath}/`)) continue
      const content = options?.content === false ? '' : await readFile(join(memoryRoot, f), 'utf8')
      entries.push({ name: f, content })
    }
    return entries
  }

  const write: VirtualFsWriteHandler = async (subpath, request, context) => {
    context.signal.throwIfAborted()
    if (projectId !== undefined && context.projectId !== projectId) throw new Error('Memory belongs to a different Project.')
    if (context.remoteWorkdir) throw new Error('Memory writes require a local workdir.')
    if (context.tools.executionMode === 'call') throw new Error('Memory writes are unavailable in call mode.')
    const parts = subpath.split('/')
    if (parts.some(part => !part || part.startsWith('.') || /[<>:"\\|?*\u0000-\u001f\u007f]/.test(part)
      || /[. ]$/.test(part) || /~\d/.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) {
      throw new Error('Invalid memory path; use a relative wiki filename under v:memory/.')
    }
    if (['sessions', 'events'].includes(parts[0].toLowerCase()) || !/\.md$/i.test(parts.at(-1)!)) {
      throw new Error('Only wiki Markdown files are writable through v:memory/. Session records and internal state are read-only; use log to append events.')
    }
    // Do not follow an alias into another Project, source records, or internal state.
    let target = resolve(workspace)
    for (const part of ['memory', ...parts]) {
      target = join(target, part)
      try {
        const info = await lstat(target)
        if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error('Memory writes cannot follow symlinks, junctions or hard links.')
      } catch (error) {
        if (!isNotFoundError(error)) throw error
      }
    }
    if (request.match !== undefined) {
      const text = await readFile(target, { encoding: 'utf8', signal: context.signal })
      if (!request.match || !text.includes(request.match)) throw new Error('Exact match not found in memory. Reread the file before editing.')
      const index = text.indexOf(request.match)
      if (!request.replaceAll && text.indexOf(request.match, index + request.match.length) !== -1) {
        throw new Error('Memory match is ambiguous; include more context or use flag "g".')
      }
    }
    return writer.execute({ path: target, content: request.content, match: request.match,
      flag: request.replaceAll ? 'g' : '' }, context)
  }

  return { read, list, write }
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
