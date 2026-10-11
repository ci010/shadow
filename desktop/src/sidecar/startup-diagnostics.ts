import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeBackendError, safeBackendTiming, type BackendStartupError, type BackendStartupTiming } from './backend-startup-diagnostics.js'

export const STARTUP_FAILURE_KINDS = [
  'spawn-error', 'configuration-error', 'port-conflict', 'readiness-timeout',
  'early-exit', 'migration-failure', 'main-unreachable', 'crash',
] as const

export type StartupFailureKind = typeof STARTUP_FAILURE_KINDS[number]

export interface StartupFailure {
  readonly role: 'main' | 'child'
  readonly kind: StartupFailureKind
  readonly elapsedMs?: number
}

export function startupFailure(value: {
  readonly role?: unknown
  readonly kind?: unknown
  readonly elapsedMs?: unknown
}): StartupFailure | undefined {
  if (
    (value.role !== 'main' && value.role !== 'child')
    || !STARTUP_FAILURE_KINDS.includes(value.kind as StartupFailureKind)
  ) return undefined
  return {
    role: value.role,
    kind: value.kind as StartupFailureKind,
    ...(typeof value.elapsedMs === 'number' && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0
      ? { elapsedMs: value.elapsedMs } : {}),
  }
}

const EVENTS = [
  'starting', 'spawned', 'ready', 'failed', 'probe-error',
  'shutdown-fallback', 'shutdown-forced', 'stopped',
  'backend-phase',
] as const

export interface StartupDiagnosticEntry {
  readonly timestamp: string
  readonly role: 'main' | 'child'
  readonly event: typeof EVENTS[number]
  readonly elapsedMs: number
  readonly kind?: StartupFailureKind
  readonly exitCode?: number
  readonly backend?: BackendStartupTiming
  readonly backendError?: BackendStartupError
}

export function startupLogPath(userDataPath: string): string {
  return join(userDataPath, 'logs', 'startup.jsonl')
}

/** Persist only known fields, never error messages, environment or child output. */
function safeEntry(entry: StartupDiagnosticEntry): StartupDiagnosticEntry | undefined {
  const backend = entry.event === 'backend-phase' ? safeBackendTiming(entry.backend) : undefined
  const backendError = entry.event === 'failed' ? safeBackendError(entry.backendError) : undefined
  if (
    (entry.role !== 'main' && entry.role !== 'child')
    || !EVENTS.includes(entry.event)
    || !Number.isSafeInteger(entry.elapsedMs) || entry.elapsedMs < 0
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.timestamp)
    || (entry.event === 'backend-phase' && backend === undefined)
  ) return undefined
  return {
    timestamp: entry.timestamp,
    role: entry.role,
    event: entry.event,
    elapsedMs: entry.elapsedMs,
    ...(STARTUP_FAILURE_KINDS.includes(entry.kind!) ? { kind: entry.kind } : {}),
    ...(Number.isSafeInteger(entry.exitCode) ? { exitCode: entry.exitCode } : {}),
    ...(backend ? { backend } : {}),
    ...(backendError ? { backendError } : {}),
  }
}

export class StartupDiagnosticsLog {
  private warned = false

  constructor(
    readonly path: string,
    private readonly maxBytes = 256 * 1024,
    private readonly terminal: (line: string) => void = (line) => console.info(line),
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) throw new TypeError('Startup log limit must be at least 512 bytes')
  }

  write(entry: StartupDiagnosticEntry): void {
    const safe = safeEntry(entry)
    if (!safe) return
    const line = `${JSON.stringify(safe)}\n`
    this.terminal(`[desktop:startup] ${line.trimEnd()}`)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      let size = 0
      try { size = statSync(this.path).size } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        rmSync(`${this.path}.2`, { force: true })
        try { renameSync(`${this.path}.1`, `${this.path}.2`) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        renameSync(this.path, `${this.path}.1`)
      }
      appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      if (!this.warned) {
        this.warned = true
        this.terminal('[desktop:startup] Startup log could not be saved; diagnostics remain available in the terminal.')
      }
    }
  }
}
