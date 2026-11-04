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

const VALIDATION_STAGES = ['cron', 'sessions', 'jsonl', 'sqlite', 'ownership', 'reserve'] as const
const VALIDATION_SOURCES = ['cron', 'sessions', 'jsonl', 'sqlite', 'catalog'] as const
const VALIDATION_ERRORS = ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EISDIR', 'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'ERR_SQLITE_ERROR', 'SyntaxError', 'TypeError', 'RangeError', 'Error', 'OwnershipValidationError', 'SessionIdentityError', 'unknown'] as const

// Independent receiving boundary: only these source files and bounded numeric positions.
const STORAGE_FRAME = /^src\/(?:sessions\/(?:session-store-jsonl|fresh-automation-state|session-metadata|session-name|task-record|initiative-metadata|topic-contract|session-identity|session-store|work-policy|locality|retirement-contract)|projects\/ownership|cron\/contracts|channels\/integration-contract)\.(?:ts|js):[1-9]\d{0,5}:[1-9]\d{0,5}$/

// Match the producer's Vite layout, not arbitrary paths or function/message text.
const STORAGE_ENTRY_FRAME = /^dist\/src\/index\.js:[1-9]\d{0,5}:[1-9]\d{0,5}$/

const STORAGE_BUNDLE_FRAME = /^dist\/_chunks\/[A-Za-z0-9_][A-Za-z0-9_-]{0,79}-[A-Za-z0-9_-]{8}\.js:[1-9]\d{0,5}:[1-9]\d{0,5}$/

export interface BackendStorageValidationFailure {
  readonly frames?: readonly string[]
  readonly stage: typeof VALIDATION_STAGES[number]
  readonly source: typeof VALIDATION_SOURCES[number]
  readonly error: typeof VALIDATION_ERRORS[number]
}

/** Exact fixed vocabulary only; reject additional fields rather than persisting private data. */
export function safeStorageValidationFailure(value: unknown): BackendStorageValidationFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['stage', 'source', 'error', 'frames'].includes(key))) return undefined
  const frames = record.frames
  if (frames !== undefined && (!Array.isArray(frames) || frames.length < 1 || frames.length > 4
    || !frames.every(frame => typeof frame === 'string' && (STORAGE_FRAME.test(frame) || STORAGE_BUNDLE_FRAME.test(frame) || STORAGE_ENTRY_FRAME.test(frame))))) return undefined
  const stage = VALIDATION_STAGES.find(value => value === record.stage)
  const source = VALIDATION_SOURCES.find(value => value === record.source)
  const error = VALIDATION_ERRORS.find(value => value === record.error)
  if (!stage || !source || !error) return undefined
  return { stage, source, error, ...(frames ? { frames: [...frames as string[]] } : {}) }
}

const VALIDATION_MARKER = /^\[projects\] session_storage_validation_failed stage=([A-Za-z]+) source=([A-Za-z]+) error=([A-Za-z_]+)(?: frames=([^\s]+))?$/
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

  constructor(
    private readonly emit: (entry: BackendStartupTiming) => void,
    private readonly emitValidationFailure?: (entry: BackendStorageValidationFailure) => void,
  ) {}

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
    const validation = VALIDATION_MARKER.exec(line)
    if (validation) {
      const failure = safeStorageValidationFailure({ stage: validation[1], source: validation[2], error: validation[3], ...(validation[4] ? { frames: validation[4].split(',') } : {}) })
      if (failure) {
        this.count++
        this.emitValidationFailure?.(failure)
      }
      return
    }
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
