import { spawn, type ChildProcess } from 'node:child_process'
import { open, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ManagedProcessStatus } from './manager.ts'

export const GUARDED_OUTPUT_LIMIT = 128 * 1024

export interface ProcessSupervision {
  deadlineAt: number
  resultPath?: string
}

export interface GuardianRequest extends ProcessSupervision {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments: boolean
}

export type GuardianReason =
  | 'exited' | 'cancelled' | 'deadline-expired' | 'owner-lost'
  | 'output-limit' | 'supervisor-failed' | 'cleanup-failed'

export interface GuardianResult {
  version: 1
  pid?: number
  startedAt: string
  finishedAt: string
  code: number
  signal: NodeJS.Signals | null
  reason: GuardianReason
  error?: string
  stdout: string
  stderr: string
}

export interface GuardedProcess {
  process: ChildProcess
  pid: number
  stdoutChunks: Uint8Array[]
  stderrChunks: Uint8Array[]
  exitPromise: Promise<ManagedProcessStatus>
  terminate(): Promise<ManagedProcessStatus>
}

export async function persistGuardianResult(path: string, result: GuardianResult): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(result)); await file.sync() }
  finally { await file.close() }
  await rename(temporary, path)
}

export async function deliverGuardianResult(result: GuardianResult): Promise<void> {
  if (!process.connected) return
  await new Promise<void>((resolve, reject) => {
    process.send?.({ type: 'result', result }, error => {
      if (error && process.connected) reject(error)
      else resolve()
    })
  })
}

export function parseGuardianResult(value: unknown): GuardianResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid process guardian result')
  const result = value as Partial<GuardianResult>
  const reasons: readonly string[] = [
    'exited', 'cancelled', 'deadline-expired', 'owner-lost', 'output-limit', 'supervisor-failed', 'cleanup-failed',
  ]
  if (result.version !== 1 || !Number.isInteger(result.code)
    || (result.pid !== undefined && (!Number.isSafeInteger(result.pid) || result.pid <= 0))
    || typeof result.startedAt !== 'string' || !Number.isFinite(Date.parse(result.startedAt))
    || typeof result.finishedAt !== 'string' || !Number.isFinite(Date.parse(result.finishedAt))
    || (result.signal !== null && typeof result.signal !== 'string')
    || typeof result.reason !== 'string' || !reasons.includes(result.reason)
    || (result.error !== undefined && typeof result.error !== 'string')
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || result.stdout.length + result.stderr.length > Math.ceil(GUARDED_OUTPUT_LIMIT / 3) * 4 + 8) {
    throw new Error('Invalid process guardian result')
  }
  return result as GuardianResult
}

export async function spawnGuardedProcess(request: GuardianRequest, signal?: AbortSignal): Promise<GuardedProcess> {
  signal?.throwIfAborted()
  const source = import.meta.url.endsWith('.ts')
  const child = spawn(process.execPath, [
    ...(source ? ['--import', import.meta.resolve('tsx')] : []),
    fileURLToPath(new URL(source ? './guardian-worker.ts' : './guardian-worker.js', import.meta.url)),
  ], {
    env: { ...request.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
    // Also escape libuv's Windows kill-on-parent-close job; otherwise no receipt can survive a runtime crash.
    detached: true,
  })
  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []
  let diagnostics = ''
  child.stderr!.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString('utf8').slice(0, Math.max(0, 4096 - diagnostics.length))
  })
  const ready = Promise.withResolvers<number>()
  const finished = Promise.withResolvers<ManagedProcessStatus>()
  let result: GuardianResult | undefined
  let failure: Error | undefined
  const abort = () => {
    if (child.connected) child.send({ type: 'cancel' }, error => {
      if (error && (!('code' in error) || error.code !== 'ERR_IPC_CHANNEL_CLOSED')) failure = error
    })
  }
  child.on('error', error => { failure = error; ready.reject(error) })
  child.on('message', value => {
    if (!value || typeof value !== 'object' || !('type' in value)) {
      failure = new Error('Invalid process guardian message')
      abort()
      return
    }
    if (value.type === 'started' && 'pid' in value && typeof value.pid === 'number') ready.resolve(value.pid)
    else if ((value.type === 'stdout' || value.type === 'stderr') && 'chunk' in value && typeof value.chunk === 'string') {
      const chunks = value.type === 'stdout' ? stdoutChunks : stderrChunks
      chunks.push(Buffer.from(value.chunk, 'base64'))
    } else if (value.type === 'result' && 'result' in value) {
      try { result = parseGuardianResult(value.result) }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)) }
    } else {
      failure = new Error('Invalid process guardian message')
      abort()
    }
  })
  child.once('close', () => {
    signal?.removeEventListener('abort', abort)
    if (!result) failure ??= new Error(
      `Process guardian exited without a final result (code=${child.exitCode}, signal=${child.signalCode}); execution outcome is unknown` +
      (diagnostics ? `: ${diagnostics}` : ''),
    )
    if (failure || !result) {
      const error = Object.assign(failure ?? new Error('Process guardian result is unavailable'), { code: 'supervisor-failed' })
      ready.reject(error)
      finished.reject(error)
    } else {
      ready.reject(new Error(result.error ?? `Process did not start: ${result.reason}`))
      finished.resolve({
        success: result.reason === 'exited' && result.code === 0 && result.signal === null,
        code: result.code, signal: result.signal, guardian: result,
      })
    }
  })
  // A spawn failure can occur before the caller receives the exit promise.
  void finished.promise.catch(() => {})
  child.send({ type: 'start', request }, error => {
    if (error) { failure = error; ready.reject(error) }
  })
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const pid = await ready.promise
  return {
    process: child, pid, stdoutChunks, stderrChunks, exitPromise: finished.promise,
    terminate() { abort(); return finished.promise },
  }
}
