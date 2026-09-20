export const BACKEND_STARTUP_PHASES = [
  'catalog', 'ownership', 'cluster', 'gateway', 'projects', 'config', 'events',
  'folders', 'sessions', 'io', 'channels', 'agent', 'cron', 'recovery', 'ready',
] as const

export interface BackendStartupTiming {
  readonly version: 1
  readonly component: 'host' | 'project'
  readonly phase: typeof BACKEND_STARTUP_PHASES[number]
  readonly status: 'started' | 'completed' | 'failed'
  readonly elapsedMs: number
  readonly durationMs?: number
  readonly projectOrdinal?: number
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000
}

export function safeBackendTiming(value: unknown): BackendStartupTiming | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (
    entry.version !== 1
    || (entry.component !== 'host' && entry.component !== 'project')
    || !BACKEND_STARTUP_PHASES.includes(entry.phase as BackendStartupTiming['phase'])
    || (entry.status !== 'started' && entry.status !== 'completed' && entry.status !== 'failed')
    || !isDuration(entry.elapsedMs)
    || (entry.durationMs !== undefined && !isDuration(entry.durationMs))
    || (entry.projectOrdinal !== undefined && (
      !Number.isSafeInteger(entry.projectOrdinal) || (entry.projectOrdinal as number) < 1 || (entry.projectOrdinal as number) > 128
    ))
  ) return undefined
  return {
    version: 1, component: entry.component, phase: entry.phase as BackendStartupTiming['phase'],
    status: entry.status, elapsedMs: entry.elapsedMs,
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs as number }),
    ...(entry.projectOrdinal === undefined ? {} : { projectOrdinal: entry.projectOrdinal as number }),
  }
}

const PREFIX = '[startup] '
const MAX_LINE_LENGTH = 2_048
const MAX_RECORDS = 512
const WIRE_FIELDS = ['version', 'component', 'phase', 'status', 'elapsedMs', 'durationMs', 'projectId']

/** Only fixed-shape timing markers are eligible for persistence, never arbitrary child lines. */
export class BackendStartupDiagnostics {
  private readonly streams = {
    stdout: { line: '', dropping: false },
    stderr: { line: '', dropping: false },
  }
  private readonly projects = new Map<string, number>()
  private count = 0

  constructor(private readonly emit: (entry: BackendStartupTiming) => void) {}

  push(stream: 'stdout' | 'stderr', chunk: string): void {
    if (this.count >= MAX_RECORDS) return
    const state = this.streams[stream]
    let offset = 0
    while (offset < chunk.length && this.count < MAX_RECORDS) {
      const newline = chunk.indexOf('\n', offset)
      const end = newline === -1 ? chunk.length : newline
      if (state.line.length + end - offset > MAX_LINE_LENGTH) {
        state.line = ''
        state.dropping = true
      } else if (!state.dropping) {
        state.line += chunk.slice(offset, end)
      }
      if (newline !== -1) {
        if (!state.dropping) this.accept(state.line.replace(/\r$/, ''))
        state.line = ''
        state.dropping = false
      }
      offset = end + 1
    }
  }

  private accept(line: string): void {
    if (!line.startsWith(PREFIX)) return
    let value: unknown
    try { value = JSON.parse(line.slice(PREFIX.length)) } catch { return }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => !WIRE_FIELDS.includes(key))) return
    const timing = safeBackendTiming(record)
    if (!timing) return
    let projectOrdinal: number | undefined
    if (record.projectId !== undefined) {
      if (record.component !== 'project' || typeof record.projectId !== 'string'
        || record.projectId.length === 0 || record.projectId.length > 200) return
      projectOrdinal = this.projects.get(record.projectId)
      if (projectOrdinal === undefined) {
        if (this.projects.size >= 128) return
        projectOrdinal = this.projects.size + 1
        this.projects.set(record.projectId, projectOrdinal)
      }
    }
    this.count++
    this.emit({ ...timing, ...(projectOrdinal === undefined ? {} : { projectOrdinal }) })
  }
}
