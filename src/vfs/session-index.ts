import { isLightweightTopic } from '../sessions/lightweight-topic.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { VirtualDirectory } from './virtual-fs.ts'

/** Navigation is separate from exhaustive history/search discovery. */
export function isConversationRoot(state: SessionState): boolean {
  return !state.parent?.id && isLightweightTopic(state) &&
    !/^(heartbeat|cron|work-observer|work-organizer):/.test(state.sessionId)
}

function preview(value: string | undefined, limit: number): string {
  const text = value?.replace(/\s+/g, ' ').trim()
  if (!text) return '(not set)'
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

export function sessionMetadata(state: SessionState, compact = true): string[] {
  return [
    `title: ${preview(state.name ?? state.topic?.title ?? state.generatedTitle ?? state.chatName, compact ? 120 : Infinity)}`,
    `description: ${preview(state.description ?? (state.topic ? [state.topic.goal, state.topic.scope, state.topic.nonGoals].filter(Boolean).join(' ') : undefined), compact ? 240 : Infinity)}`,
  ]
}

export function sessionDirectory(states: SessionState[], view: 'root' | 'all' | 'tasks' | 'children', parentId?: string): VirtualDirectory {
  const children = new Map<string, number>()
  for (const state of states) {
    if (state.parent?.id) children.set(state.parent.id, (children.get(state.parent.id) ?? 0) + 1)
  }
  const selected = states.filter(state => view === 'all' || (view === 'children'
    ? state.parent?.id === parentId
    : view === 'root' ? isConversationRoot(state) : !isConversationRoot(state)))
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.sessionId.localeCompare(b.sessionId))
  const label = view === 'root' ? 'Conversations' : view === 'children' ? `Children of ${parentId}` : view === 'tasks' ? 'Tasks / internal sessions' : 'All sessions'
  const lines = [`${label} (${selected.length}):`]
  if (view === 'root') lines.push('Views: v:sessions/all | v:sessions/tasks | v:sessions/<id>/children; search includes all histories.')
  const header = lines.join('\n')
  const items = selected.map(state => {
    const lines: string[] = []
    const [title, description] = sessionMetadata(state)
    lines.push(`- ${title}`, `  id: ${state.sessionId}`, `  ${description}`)
    const details: string[] = view === 'root' ? [] : [`mode=${state.mode ?? 'session'}`]
    if (state.executionStatus) details.push(`status=${state.executionStatus}`)
    else if (state.completed) details.push('status=completed')
    if (state.lastActivityAt) details.push(`last=${state.lastActivityAt}`)
    if (state.parent?.id) details.push(`parent=${state.parent.id}`)
    if (details.length) lines.push(`  ${details.join(' ')}`)
    const count = children.get(state.sessionId)
    if (count) lines.push(`  children: ${count} → v:sessions/${state.sessionId}/children`)
    return lines.join('\n')
  })
  return { header, items }
}

export function renderSessionDirectory(directory: VirtualDirectory): string {
  return [directory.header, ...(directory.items.length ? directory.items : ['(none)'])].join('\n')
}
