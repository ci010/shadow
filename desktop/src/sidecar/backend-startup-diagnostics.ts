export const BACKEND_STARTUP_PHASES = [
  'catalog', 'ownership', 'cluster', 'gateway', 'projects', 'config', 'events',
  'folders', 'sessions', 'io', 'channels', 'agent', 'cron', 'recovery', 'ready',
  'agent-mcp', 'agent-skills', 'agent-types', 'agent-watchers', 'agent-sessions',
  'session-load', 'session-migrate', 'session-lineage', 'session-task-history', 'session-reports', 'session-recovery',
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

const ERROR_NAMES = ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'AggregateError', 'RuntimeCliError'] as const
const ERROR_CODES = [
  'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_REQUIRE_ESM', 'ERR_DLOPEN_FAILED', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE',
  'ERR_SQLITE_ERROR', 'EADDRINUSE', 'EACCES', 'EPERM', 'ENOENT', 'SYSTEM_PROXY_UNAVAILABLE',
  'config_read_failed', 'config_json_invalid', 'config_invalid', 'factory_failed', 'lifecycle_failed', 'environment_invalid',
] as const

export interface BackendStartupError {
  readonly name?: typeof ERROR_NAMES[number]
  readonly code?: typeof ERROR_CODES[number]
  readonly frames: readonly string[]
}

export function safeBackendError(value: unknown): BackendStartupError | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const name = ERROR_NAMES.find(name => name === record.name)
  const code = ERROR_CODES.find(code => code === record.code)
  const frames = Array.isArray(record.frames) ? record.frames.filter((frame): frame is string =>
    typeof frame === 'string' && frame.length <= 180
    && /^(?:node:internal\/[a-zA-Z0-9_./-]+|dist\/src\/[a-zA-Z0-9_./-]+\.js):\d{1,7}:\d{1,7}$/.test(frame)
    && !frame.includes('..'),
  ).slice(0, 8) : []
  if (!name && !code && frames.length === 0) return undefined
  return { ...(name ? { name } : {}), ...(code ? { code } : {}), frames }
}

/** Extract fixed error categories and source locations, never messages, paths or locals. */
export function backendStartupError(output: string): BackendStartupError | undefined {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const name = text.match(/(?:^|\n)(Error|TypeError|SyntaxError|ReferenceError|RangeError|AggregateError|RuntimeCliError)(?: \[[A-Z_]+\])?:/)?.[1]
  const code = ERROR_CODES.find(code => new RegExp(`\\b${code}\\b`).test(text))
  const frames: string[] = []
  for (const line of text.split('\n')) {
    if (!/^\s+at /.test(line)) continue
    const normalized = line.replaceAll('\\', '/')
    const frame = normalized.match(/(node:internal\/[a-zA-Z0-9_./-]+|dist\/src\/[a-zA-Z0-9_./-]+\.js):(\d+):(\d+)\)?\s*$/)
    if (frame) frames.push(`${frame[1]}:${frame[2]}:${frame[3]}`)
  }
  return safeBackendError({ name, code, frames })
}

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
