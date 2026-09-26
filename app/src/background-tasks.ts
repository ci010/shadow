import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export interface ActiveBackgroundTask {
  id: string
  sessionId: string
  kind: 'process' | 'tool' | 'subagent'
  title: string
  status: 'running' | 'cancelling'
  createdAt: string
}
export interface ActiveBackgroundTasks {
  sessionId: string
  total: number
  tasks: ActiveBackgroundTask[]
}

export async function fetchBackgroundTasks(
  base: string, sessionId: string, signal: AbortSignal, request: typeof fetch = fetch,
): Promise<ActiveBackgroundTasks> {
  const response = await request(apiUrl(base, `/api/sessions/${encodeURIComponent(sessionId)}/background-tasks`), { signal, cache: 'no-store' })
  if (response.status === 401 || response.status === 403) throw new Error('Access to background tasks was denied.')
  if (response.status === 404) {
    const detail: unknown = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : undefined
    throw new Error(isRecord(detail) && detail.error === 'session_not_found'
      ? 'This conversation is no longer available.'
      : 'Background tasks are unavailable. Restart Main after updating.')
  }
  if (!response.ok) throw new Error('Background task status is unavailable. Check Main and retry.')
  const value: unknown = await response.json()
  const invalid = () => new Error('Main returned invalid background task data. Refresh to retry.')
  if (!isRecord(value) || value.sessionId !== sessionId || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0
    || !Array.isArray(value.tasks) || value.tasks.length !== Math.min(value.total, 100)) throw invalid()
  const ids = new Set<string>()
  const tasks = value.tasks.map((task: unknown): ActiveBackgroundTask => {
    if (!isRecord(task) || typeof task.id !== 'string' || !task.id || ids.has(task.id)
      || task.sessionId !== sessionId || (task.kind !== 'process' && task.kind !== 'tool' && task.kind !== 'subagent')
      || typeof task.title !== 'string' || task.title.length > 512 || (task.status !== 'running' && task.status !== 'cancelling')
      || typeof task.createdAt !== 'string' || !Number.isFinite(Date.parse(task.createdAt))) throw invalid()
    ids.add(task.id)
    return {
      id: task.id, sessionId, kind: task.kind,
      title: task.title, status: task.status, createdAt: task.createdAt,
    }
  })
  return { sessionId, total: value.total, tasks }
}
