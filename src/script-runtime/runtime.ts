import { execFile, fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { checkTextSize, decodeJson, encodeJson } from './json-boundary.ts'
import {
  callFailureMessage, ChildPacketSchema, PolicySchema, SafeCallCodeSchema, ToolNameSchema,
  validateImports, type CallFailure, type ParentPacket,
} from './protocol.ts'

export interface ScriptOptions {
  code: string
  args: unknown
  signal: AbortSignal
  cwd?: string
  filename?: string
  entry: 'run' | 'script'
  policy: { kind: 'restricted'; imports: readonly string[]; mode?: 'live' | 'test' | 'probe' } | { kind: 'host' }
  callModule?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  toolNames?: readonly string[]
  timeoutMs?: number | null
  memoryLimitBytes?: number
  maxCalls?: number
  env?: NodeJS.ProcessEnv
}

export interface ScriptResult {
  value: unknown
  stdout: string
  stderr: string
}

export interface ScriptRun {
  pid?: number
  completion: Promise<ScriptResult>
  cancel(): void
  output(): { stdout: string; stderr: string }
}

/** A script error response was received and its owned runtime was closed. */
export class ScriptExecutionError extends Error {}

/** Only this error's allowlisted code/status are exposed in restricted mode. */
export class ScriptCallError extends Error {
  constructor(readonly code: string, message?: string, readonly status?: number) {
    super(message ?? 'Script module call failed.')
    this.name = 'ScriptCallError'
  }
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Script ${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

function safeFailure(error: unknown, host: boolean): CallFailure {
  const code = error instanceof ScriptCallError ? SafeCallCodeSchema.safeParse(error.code) : undefined
  return {
    code: code?.success ? code.data : 'capability_failed',
    ...(error instanceof ScriptCallError && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599
      ? { status: error.status } : {}),
    ...(host && error instanceof Error ? { message: error.message.slice(0, 4096) } : {}),
  }
}

interface BrokerState {
  send?: (packet: ParentPacket) => void
  fail?: (error: Error) => void
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      await promisify(execFile)(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 },
      )
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error('Script child process tree could not be terminated.')
      }
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

// Abandoned caller promises retain no child handle after teardown.
function launchCall(
  broker: NonNullable<ScriptOptions['callModule']>, signal: AbortSignal,
  name: string, input: Record<string, unknown>, id: number, state: BrokerState, host: boolean,
): void {
  void Promise.resolve().then(() => {
    if (signal.aborted || !state.send) return
    return broker(name, input, signal)
  }).then(value => {
    if (!state.send) return
    try {
      state.send({ type: 'response', id, json: encodeJson(value, 'module response') })
    } catch {
      state.fail?.(new Error('Script module response must be bounded finite JSON data.'))
    }
  }, error => state.send?.({ type: 'rejection', id, failure: safeFailure(error, host) }))
}

export async function executeScript(options: ScriptOptions): Promise<ScriptResult> {
  return await startScript(options).completion
}

/**
 * One disposable child for both profiles. Restricted imports are a direct-import
 * policy, not an OS sandbox; approved native modules retain host privileges.
 * The memory limit is V8 old-space, not RSS. Completion always waits for close.
 */
export function startScript(options: ScriptOptions): ScriptRun {
  const started = performance.now()
  const policy = PolicySchema.parse(options.policy)
  const host = policy.kind === 'host'
  if (policy.kind === 'restricted') validateImports(policy.imports, policy.mode)
  if (options.entry !== 'run' && options.entry !== 'script') throw new Error('Invalid script entry.')
  if (options.timeoutMs === null && !host) throw new Error('Only host scripts can disable their timeout.')
  const timeoutMs = options.timeoutMs === null ? null
    : boundedInteger(options.timeoutMs ?? 15_000, 'timeoutMs', 1, 2_147_483_647)
  const memoryLimitBytes = boundedInteger(options.memoryLimitBytes ?? 64 * 1024 * 1024,
    'memoryLimitBytes', 16 * 1024 * 1024, 256 * 1024 * 1024)
  const maxCalls = boundedInteger(options.maxCalls ?? (host ? Number.MAX_SAFE_INTEGER : 32),
    'maxCalls', 0, host ? Number.MAX_SAFE_INTEGER : 128)
  const toolNames = (options.toolNames ?? []).map(name => ToolNameSchema.parse(name))
  if (toolNames.length > 1024 || new Set(toolNames).size !== toolNames.length) throw new Error('Invalid script tool names.')
  if (typeof options.code !== 'string') throw new Error('Script source must be text.')
  checkTextSize(options.code, 'source')
  const args = encodeJson(options.args, 'input')
  const filename = resolve(options.cwd ?? process.cwd(), options.filename ?? 'script.mjs')
  const controller = new AbortController()
  const state: BrokerState = {}
  const development = import.meta.url.endsWith('.ts')
  const childUrl = new URL(development ? './worker.ts' : './worker.js', import.meta.url)
  const execArgv = [
    '--experimental-vm-modules', '--experimental-import-meta-resolve', '--no-warnings',
    `--max-old-space-size=${Math.floor(memoryLimitBytes / (1024 * 1024))}`,
    ...(development ? ['--import', import.meta.resolve('tsx')] : []),
  ]
  const env: NodeJS.ProcessEnv = host ? { ...options.env } : {}
  if (!host) {
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key]
  env.TSX_DISABLE_CACHE = '1'
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  const packet: ParentPacket = {
    type: 'start', code: options.code, args, policy, entry: options.entry, filename,
    toolNames, maxCalls, envKeys: Object.keys(env),
  }
  let child: ChildProcess | undefined
  let cancel = () => {}
  let stdout = ''
  let stderr = ''
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const output = () => ({ stdout, stderr })
  const completion = new Promise<ScriptResult>((resolveResult, reject) => {
    let ended = false
    let failure: Error | undefined
    let value: unknown
    let calls = 0
    let outputBytes = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let termination = Promise.resolve()
    const finish = (error?: Error, result?: unknown) => {
      if (ended) return
      ended = true
      failure = error
      value = result
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      state.send = undefined
      state.fail = undefined
      controller.abort(error ?? new Error('Script execution ended.'))
      if (child) {
        const worker = child
        termination = terminateTree(worker).catch(error => {
          failure = new Error('Script child process tree cleanup failed.', { cause: error })
          worker.kill('SIGKILL')
        })
      }
      else reject(error ?? new Error('Script child failed to start.'))
    }
    const abort = () => finish(new Error('Script aborted.'))
    cancel = abort
    if (timeoutMs !== null) {
      timer = setTimeout(() => finish(new Error('Script timed out (deadline exceeded).')),
        Math.max(1, timeoutMs - (performance.now() - started)))
    }
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) {
      abort()
      return
    }
    try {
      const forkOptions: ForkOptions & { windowsHide: boolean } = {
        execArgv, env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json', windowsHide: true, detached: process.platform !== 'win32',
      }
      child = fork(childUrl, [], forkOptions)
    } catch (error) {
      finish(new Error(host && error instanceof Error ? error.message : 'Script child failed to start.'))
      return
    }
    const worker = child
    const send = (message: ParentPacket) => {
      if (ended) return
      try {
        worker.send(message, error => { if (error) finish(new Error('Script child IPC failed.')) })
      } catch {
        finish(new Error('Script child IPC failed.'))
      }
    }
    state.send = send
    state.fail = finish
    const drain = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (host) {
        // Long-lived developer scripts may log indefinitely. Capture only the
        // first 64 KiB; restricted execution instead treats flooding as failure.
        const captured = chunk.subarray(0, Math.max(0, 64 * 1024 - outputBytes))
        outputBytes += captured.length
        if (stream === 'stdout') stdout += stdoutDecoder.write(captured)
        else stderr += stderrDecoder.write(captured)
        return
      }
      outputBytes += chunk.length
      if (outputBytes > 64 * 1024) {
        const error = new Error('Script child output limit exceeded.')
        // A result IPC packet may arrive before the last buffered stdio chunk.
        if (ended) failure ??= error
        else finish(error)
        return
      }
    }
    worker.stdout!.on('data', chunk => drain('stdout', chunk))
    worker.stderr!.on('data', chunk => drain('stderr', chunk))
    worker.on('error', error => finish(new Error(host ? error.message : 'Script child process failed.')))
    worker.on('exit', (code, signal) => {
      if (!ended) {
        if (host && options.entry === 'script' && code === 0) finish(undefined, null)
        else finish(new Error(`Script child exited without a result (${signal ?? code}).`))
      }
    })
    worker.on('close', async () => {
      if (!ended) finish(new Error('Script child closed without a result.'))
      await termination
      if (host && outputBytes < 64 * 1024) {
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
      }
      worker.removeAllListeners()
      worker.stdout?.removeAllListeners()
      worker.stderr?.removeAllListeners()
      if (failure) reject(failure)
      else resolveResult({ value, ...output() })
    })
    worker.on('message', raw => {
      if (ended) return
      try {
        const message = ChildPacketSchema.parse(raw)
        if (message.type === 'result') {
          finish(undefined, decodeJson(message.json, 'output'))
        } else if (message.type === 'error') {
          const diagnostic = policy.kind === 'restricted' && policy.mode === 'test'
            && message.code === 'guest_failed' && !message.failure ? message.diagnostic : undefined
          const detail = host ? message.message ?? message.failure?.message
            : diagnostic ? `Script guest_failed: ${diagnostic}` : undefined
          const Failure = host && calls === 0 ? ScriptExecutionError : Error
          finish(new Failure(detail ?? (message.failure
            ? callFailureMessage(message.failure) : `Script ${message.code}.`)))
        } else {
          if (message.id !== calls + 1 || ++calls > maxCalls) {
            finish(new Error('Script module call limit or sequence violated.'))
            return
          }
          const allowed = policy.kind === 'restricted'
            ? policy.imports.includes(`@shadow/${message.name}`) : toolNames.includes(message.name)
          if (!allowed || !options.callModule) {
            finish(new Error('Script module call denied.'))
            return
          }
          const input = decodeJson(message.json, 'module input', true) as Record<string, unknown>
          launchCall(options.callModule, controller.signal, message.name, input, message.id, state, host)
        }
      } catch {
        finish(new Error('Script invalid IPC or JSON payload.'))
      }
    })
    send(packet)
  })
  return { pid: child?.pid, completion, cancel: () => cancel(), output }
}
