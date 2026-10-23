import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  deliverGuardianResult, GUARDED_OUTPUT_LIMIT, parseGuardianResult, persistGuardianResult,
  type GuardianReason, type GuardianRequest, type GuardianResult,
} from './guardian.ts'

let child: ChildProcess | undefined
let stopping: Exclude<GuardianReason, 'exited'> | undefined
let request: GuardianRequest | undefined
let cleanupError: string | undefined
let force: ReturnType<typeof setTimeout> | undefined
let groupSignalled = false
let commandPid: number | undefined

function send(value: object): void {
  if (process.connected) process.send?.(value, error => {
    if (error && (!('code' in error) || error.code !== 'ERR_IPC_CHANNEL_CLOSED')) stop('owner-lost')
  })
}

function killGroup(): void {
  if (!commandPid || groupSignalled) return
  try { process.kill(-commandPid, 'SIGKILL'); groupSignalled = true }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      cleanupError = error instanceof Error ? error.message : String(error)
    }
  }
}

function stop(reason: Exclude<GuardianReason, 'exited'>): void {
  if (reason === 'cancelled' && request && Date.now() >= request.deadlineAt) reason = 'deadline-expired'
  stopping ??= reason
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // EOF also covers a killed watchdog: the PowerShell owner closes its Job Object.
    child.stdin?.end()
    force ??= setTimeout(() => child?.kill('SIGKILL'), 2000)
  } else {
    if (child.connected) child.send({ type: 'stop', reason: stopping }, error => {
      if (error) killGroup()
    })
    else killGroup()
    force ??= setTimeout(() => { killGroup(); child?.kill('SIGKILL') }, 5000)
  }
}

process.on('disconnect', () => stop('owner-lost'))
process.on('SIGTERM', () => stop('cancelled'))
process.on('SIGINT', () => stop('cancelled'))
process.on('message', value => {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    stop('supervisor-failed')
  } else if (value.type === 'cancel') {
    stop('cancelled')
  } else if (value.type === 'start' && 'request' in value && !request) {
    request = value.request as GuardianRequest
    void run(request).catch(async error => {
      stop('supervisor-failed')
      if (process.connected) await deliverGuardianResult({
        version: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        code: -1, signal: null, reason: 'supervisor-failed',
        error: error instanceof Error ? error.message : String(error), stdout: '', stderr: '',
      })
      process.exitCode = 1
      if (process.connected) process.disconnect()
    })
  } else stop('supervisor-failed')
})

async function run(input: GuardianRequest): Promise<void> {
  const startedAt = new Date().toISOString()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let code = -1
  let signal: NodeJS.Signals | null = null
  let failure: string | undefined
  let controllerResult: GuardianResult | undefined
  if (input.deadlineAt <= Date.now()) stopping ??= 'deadline-expired'
  let timer: ReturnType<typeof setTimeout> | undefined
  if (!stopping) {
    const windows = process.platform === 'win32'
    const source = import.meta.url.endsWith('.ts')
    const temporary = windows ? await mkdtemp(join(tmpdir(), 'shadow-guardian-')) : undefined
    const statusPath = temporary ? join(temporary, 'status.json') : undefined
    if (stopping) {
      if (temporary) await rmdir(temporary)
      child = undefined
    } else {
      child = spawn(windows
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : process.execPath, windows
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          fileURLToPath(new URL('./windows-guardian.ps1', import.meta.url))]
        : [...(source ? ['--import', import.meta.resolve('tsx')] : []),
          fileURLToPath(new URL(source ? './posix-controller.ts' : './posix-controller.js', import.meta.url))], {
        cwd: input.cwd, env: windows ? input.env : { ...input.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: !windows, windowsHide: true,
        stdio: windows ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      const execution = child
      execution.stdin?.on('error', error => {
        if (!('code' in error) || error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
          failure = error.message
          stop('supervisor-failed')
        }
      })
      if (windows) execution.stdin?.write(`${JSON.stringify({ ...input, statusPath })}\n`)
      const output = (type: 'stdout' | 'stderr', chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, GUARDED_OUTPUT_LIMIT - bytes))
        bytes += kept.length
        if (kept.length) {
          const chunks = type === 'stdout' ? stdout : stderr
          chunks.push(kept)
          send({ type, chunk: kept.toString('base64') })
        }
        if (chunk.length > kept.length) stop('output-limit')
      }
      execution.stdout?.on('data', chunk => output('stdout', chunk))
      execution.stderr?.on('data', chunk => output('stderr', chunk))
      if (!windows) {
        execution.on('message', value => {
          if (value && typeof value === 'object' && 'type' in value) {
            if (value.type === 'started' && 'pid' in value && typeof value.pid === 'number'
              && Number.isSafeInteger(value.pid) && value.pid > 1 && !commandPid) {
              commandPid = value.pid
              send(value)
              if (stopping) stop(stopping)
              else execution.send({ type: 'admit' }, error => {
                if (error) { failure = error.message; stop('supervisor-failed') }
              })
              return
            }
            if ((value.type === 'stdout' || value.type === 'stderr') && 'chunk' in value && typeof value.chunk === 'string') {
              output(value.type, Buffer.from(value.chunk, 'base64'))
              return
            }
            if (value.type === 'result' && 'result' in value) {
              try { controllerResult = parseGuardianResult(value.result); return }
              catch (error) { failure = error instanceof Error ? error.message : String(error) }
            }
          }
          failure ??= 'Invalid POSIX controller message'
          stop('supervisor-failed')
        })
        execution.send({ type: 'start', request: input }, error => {
          if (error) { failure = error.message; stop('supervisor-failed') }
        })
      }
      execution.on('error', error => { failure = error.message; stop('supervisor-failed') })
      execution.once('spawn', () => {
        if (windows) send({ type: 'started', pid: execution.pid })
        if (stopping) stop(stopping)
      })
      timer = setTimeout(() => stop('deadline-expired'), Math.max(0, input.deadlineAt - Date.now()))
      const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        execution.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }))
      })
      code = status.code ?? -1
      signal = status.signal
      clearTimeout(timer)
      clearTimeout(force)
      if (!windows) {
        if (!controllerResult) {
          killGroup()
          failure ??= 'POSIX controller exited without a final receipt; process outcome is unknown'
        } else {
          code = controllerResult.code
          signal = controllerResult.signal
          if (controllerResult.reason !== 'exited'
            && (!stopping || stopping === 'cancelled' && controllerResult.reason === 'deadline-expired')) {
            stopping = controllerResult.reason
          }
          if (controllerResult.error) failure ??= controllerResult.error
        }
      }
      if (statusPath && temporary) {
        try {
          const status: unknown = JSON.parse(await readFile(statusPath, 'utf8'))
          if (!status || typeof status !== 'object' || !('code' in status) || !Number.isInteger(status.code)
            || !('reason' in status) || !['exited', 'cancelled', 'deadline-expired', 'supervisor-failed'].includes(String(status.reason))) {
            throw new Error('Windows guardian returned an invalid ownership receipt')
          }
          code = Number(status.code)
          if (status.reason === 'supervisor-failed') {
            failure = 'error' in status ? String(status.error) : 'Windows process supervision failed'
          } else if (status.reason === 'cancelled' || status.reason === 'deadline-expired') stopping ??= status.reason
        } catch (error) {
          failure = `Windows process supervision receipt unavailable: ${error instanceof Error ? error.message : String(error)}`
        } finally {
          await rm(statusPath, { force: true })
          await rmdir(temporary)
        }
      }
    }
  }
  const result: GuardianResult = {
    version: 1, ...((commandPid ?? child?.pid) ? { pid: commandPid ?? child?.pid } : {}), startedAt, finishedAt: new Date().toISOString(),
    code, signal, reason: cleanupError ? 'cleanup-failed' : failure ? 'supervisor-failed' : stopping ?? 'exited',
    ...(cleanupError || failure ? { error: cleanupError ?? failure } : {}),
    stdout: Buffer.concat(stdout).toString('base64'), stderr: Buffer.concat(stderr).toString('base64'),
  }
  if (input.resultPath && (process.platform === 'win32' || !child)) await persistGuardianResult(input.resultPath, result)
  // Flush the final (potentially 128 KiB) receipt before closing the IPC channel.
  await deliverGuardianResult(result)
  if (process.connected) process.disconnect()
}
