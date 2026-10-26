import { discoverFolderSkills, folderSkillsSummary, readFolderSkillResource, type FolderSkillScope } from '../skills/folder.ts'
import { delegationOwner } from '../sessions/execution-scope.ts'
import type { ChatMessage } from '../providers/provider.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { TopicService } from '../sessions/topics.ts'
import {
  backgroundExecutionId,
  backgroundTaskId,
  type BackgroundTaskManager,
} from '../agent/background-task.ts'
import { assertExecutionActor, assertOwnedExecution, assertOwnedHistoricalExecution } from '../sessions/execution-scope.ts'
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
import { formatSessionMessage, formatSessionHistory, shortPhysicalReference } from '../sessions/history-view.ts'

// ── Helpers ──────────────────────────────────────────────────────────────

// ── Sessions ─────────────────────────────────────────────────────────────

export function createSessionsHandler(
  sessions: Pick<SessionManager, 'listSessions' | 'getSessionState' | 'getHistory'> & Partial<Pick<SessionManager, 'listHistorySessions' | 'readSessionState'>>,
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
      const allList = await (sessions.listHistorySessions?.() ?? sessions.listSessions())
      // Hide internal pipeline sessions (heartbeat:*) from the default listing.
      // They can still be read directly by ID (e.g. v:sessions/heartbeat:reflector-...).
      const list = allList.filter((s) => !s.sessionId.startsWith('heartbeat:'))
      const external = remote?.canDiscover(context)
        ? remote.entries(context).filter(entry => !entry.name.includes('/')) : []
      if (list.length === 0 && external.length === 0) return 'No sessions.'
      const lines: string[] = [`Sessions (${list.length + external.length}):`]
      for (const s of list) {
        const state = await (sessions.readSessionState?.bind(sessions) ?? sessions.getSessionState.bind(sessions))(s.sessionId)
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

    const entries = await list(context, { subpath })
    const entry = entries.find(entry => entry.name === subpath)
    return entry?.content ?? `Session "${subpath}" not found or has no history.`
  }

  const list: VirtualFsListHandler = async (context, options) => {
    topics?.().assertActor(context.projectId, context.sessionId)
    context.signal.throwIfAborted()
    const all = await (sessions.listHistorySessions?.() ?? sessions.listSessions())
    const entries = []
    const requested = options?.subpath
    if (!requested?.startsWith('remote:') && requested?.includes('?')) throw new Error('Session query parameters are not supported. Use /overview or /full and read.offset/read.limit, not index/page_size.')
    // Resolve display aliases against all known physical segments, never the current
    // segment alone. Ambiguity fails closed rather than selecting a different history.
    let resolved = requested
    const alias = requested?.split('/')[0]
    if (alias?.startsWith('~')) {
      if (!/^~[0-9a-f]{16}$/.test(alias)) throw new Error('Invalid physical session reference.')
      const matches = new Set<string>()
      for (const summary of all) {
        const state = await (sessions.readSessionState?.bind(sessions) ?? sessions.getSessionState.bind(sessions))(summary.sessionId)
        if (!state) continue
        for (let index = 0; index <= state.segmentIndex; index++) {
          context.signal.throwIfAborted()
          const physical = physicalSessionId(state, index)
          if (shortPhysicalReference(physical) === alias) matches.add(physical)
        }
      }
      if (matches.size !== 1) throw new Error('Unknown or ambiguous physical session reference; use the full physical ID.')
      resolved = [...matches][0] + requested!.slice(alias.length)
    }
    if (resolved && !resolved.startsWith('remote:') && /\/(?:calls|c)\//.test(resolved)) {
      const match = /^([^/]+)\/(calls|c)\/([^/]+)$/.exec(resolved)
      if (!match || match[1].includes(':')) throw new Error('Tool-call references require a physical session ID and an encoded call ID.')
      let callId = decodeURIComponent(match[3])
      const { messages } = await sessions.getHistory(match[1], { physicalId: match[1], maxMessages: Number.MAX_SAFE_INTEGER })
      context.signal.throwIfAborted()
      if (match[2] === 'c') {
        const coordinate = /^([1-9]\d*)\.([1-9]\d*)$/.exec(callId)
        const message = coordinate ? messages[Number(coordinate[1]) - 1] : undefined
        const call = message?.role === 'assistant' ? message.tool_calls?.[Number(coordinate![2]) - 1] : undefined
        if (!call) throw new Error('Unknown tool call coordinate in physical session.')
        callId = call.id
      }
      const selected: string[] = []
      for (const [index, message] of messages.entries()) {
        const call = message.role === 'assistant' ? message.tool_calls?.find(call => call.id === callId) : undefined
        if (call) selected.push(formatSessionMessage({ ...message, tool_calls: [call] }, index + 1).join('\n'))
        if (message.role === 'tool' && message.tool_call_id === callId) selected.push(formatSessionMessage(message, index + 1).join('\n'))
      }
      if (!selected.length || !messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === callId))) throw new Error(`Unknown tool call ${JSON.stringify(callId)} in physical session ${match[1]}.`)
      return [{ name: requested!, content: options?.content === false ? '' : `Physical Session ID: ${match[1]}; tool call: ${callId}\n\n${selected.join('\n\n')}` }]
    }
    const overview = !resolved?.endsWith('/full')
    const subpath = requested?.startsWith('remote:') ? requested : resolved?.replace(/\/(overview|full)$/, '')
    const viewSuffix = requested?.match(/\/(overview|full)$/)?.[0] ?? ''
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
        name: requested ?? subpath + viewSuffix,
        content: options?.content === false ? ''
          : `Physical Session ID: ${subpath}\n\n${formatSessionHistory(messages, overview, subpath)}`,
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
        entries.push({ name: s.sessionId + viewSuffix, content: '' })
        continue
      }
      const state = await (sessions.readSessionState?.bind(sessions) ?? sessions.getSessionState.bind(sessions))(s.sessionId)
      const parts = [s.sessionId]
      if (state?.originUser) parts.push(`by=${state.originUser}`)
      if (state?.parent?.id) parts.push(`parent=${state.parent.id}`)
      if (state?.mode && state.mode !== 'session') parts.push(`mode=${state.mode} status=${state.executionStatus ?? 'unknown'}`)
      if (s.lastActivityAt) parts.push(`last=${s.lastActivityAt}`)
      parts.push(`segments=${s.segmentIndex + 1}`)

      const { messages: history } = await sessions.getHistory(s.sessionId, {
        maxMessages: Number.MAX_SAFE_INTEGER,
      })
      const historyText = formatSessionHistory(history, overview, state ? physicalSessionId(state) : undefined)

      entries.push({
        name: s.sessionId + viewSuffix,
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
  sessions: Pick<SessionManager, 'listSessions' | 'getSessionState' | 'getDelegationOwner' | 'assertFolderAccess' | 'getHistory'> & Partial<Pick<SessionManager, 'readSessionState' | 'assertHistoricalFolderAccess' | 'listHistoryStates' | 'listHistorySessions'>>,
  remote?: Pick<A2aSessions, 'read' | 'entries' | 'canDiscover'>,
): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const history = createSessionsHandler(sessions)
  const isRemoteExecution = (path: string) => /^remote:[^/]+\/executions\/[^/]+$/.test(path)
  const localSummary = async (executionId: string, ctx: ExecutionContext) => {
    const state = await assertOwnedHistoricalExecution(sessions, executionId, ctx)
    return {
      executionId, sessionId: state.sessionId, ownerSessionId: ctx.sessionId,
      kind: 'local', mode: state.mode, agentType: state.agentType,
      status: state.executionStatus ?? 'unknown', lastActivityAt: state.lastActivityAt,
      history: `v:sessions/${state.sessionId}`,
    }
  }
  const list: VirtualFsListHandler = async (ctx, options) => {
    assertExecutionActor(sessions, ctx)
    backgroundTasks.assertOwner(ctx)
    const selected = (name: string) => !options?.subpath || name === options.subpath || name.startsWith(`${options.subpath}/`)
    const content = (value: unknown) => options?.content === false ? '' : JSON.stringify(value, null, 2)
    const entries = backgroundTasks.listTasks(ctx.sessionId).filter(task => selected(backgroundExecutionId(task.id))).map(task => ({
      name: backgroundExecutionId(task.id),
      content: content({ ...task, executionId: backgroundExecutionId(task.id), ownerSessionId: task.sessionId }),
    }))
    for (const state of await (sessions.listHistoryStates?.() ?? sessions.listSessions())) {
      if ((state.mode !== 'task' && state.mode !== 'call') || state.projectId !== ctx.projectId ||
        !selected(state.sessionId)) continue
      const full = await (sessions.readSessionState?.(state.sessionId) ?? sessions.getSessionState(state.sessionId))
      if (delegationOwner(full) !== ctx.sessionId) continue
      ctx.signal.throwIfAborted()
      entries.push({ name: state.sessionId, content: content(await localSummary(state.sessionId, ctx)) })
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
    await assertOwnedHistoricalExecution(sessions, executionId, ctx)
    const output = await history.read(subpath, ctx)
    const summary = await localSummary(executionId, ctx)
    return `${JSON.stringify(summary, null, 2)}\n\n${output}`
  }

  return { read, list }
}

// ── Skills ───────────────────────────────────────────────────────────────

export function createSkillsHandler(
  skills: SkillsManager,
  registerTools?: (skill: Skill, context: ExecutionContext) => Promise<string[]>,
  folderScope?: (context: ExecutionContext) => FolderSkillScope | undefined,
): {
  read: VirtualFsHandler
  list: VirtualFsListHandler
} {
  const read: VirtualFsHandler = async (subpath, context) => {
    if (!subpath) {
      const names = skills.availableSkills(context.admin).map(skill => skill.meta.name)
      const scope = folderScope?.(context)
      const folderIndex = scope ? folderSkillsSummary(await discoverFolderSkills(scope, context.admin), scope) : ''
      return [names.map(n => `- ${n}`).join('\n') || 'No Project/global skills loaded.', folderIndex].filter(Boolean).join('\n\n')
    }

    if (subpath === 'folder' || subpath.startsWith('folder/')) {
      const scope = folderScope?.(context)
      if (!scope) return 'No selected local folder skill scope.'
      const scoped = await discoverFolderSkills(scope, context.admin)
      const scopedPath = subpath.replace(/\/+$/, '')
      if (scopedPath === 'folder') return folderSkillsSummary(scoped, scope)
      const [name, ...parts] = scopedPath.slice('folder/'.length).split('/')
      const skill = scoped.find(skill => skill.meta.name === name)
      if (!skill) return `Unknown selected-folder skill: ${name}`
      if (parts.length) return readFolderSkillResource(skill, parts.join('/'))
      if (skill.meta.toolsError) throw new Error(skill.meta.toolsError)
      if (Object.keys(skill.meta.tools ?? {}).length && !registerTools) throw new Error('Skill tool registration is not configured')
      const registered = await registerTools?.(skill, context) ?? []
      return `Selected-folder skill source: ${JSON.stringify(skill.dirPath)}; scope: ${JSON.stringify(scope)}\n\n${skill.body}`
        + (registered.length ? `\nRegistered for this session: ${registered.join(', ')}. Invoke with invoke_tool; modules run lazily.` : '')
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
    const scope = folderScope?.(context)
    if (scope) for (const skill of await discoverFolderSkills(scope, context.admin)) {
      const name = `folder/${skill.meta.name}`
      if (subpath && name !== subpath && !name.startsWith(`${subpath}/`) && !subpath.startsWith(`${name}/`)) continue
      entries.push({ name, content: options?.content === false ? '' : skill.body, warning: skill.meta.toolsError })
      for (const resource of await walkResourceFiles(skill.dirPath, context.signal)) {
        const path = `${name}/${resource}`
        if (subpath && path !== subpath && !path.startsWith(`${subpath}/`)) continue
        entries.push({ name: path, content: options?.content === false ? '' : await readFolderSkillResource(skill, resource) })
      }
    }
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
  const writer = new WriteTool(workspace, true)

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
