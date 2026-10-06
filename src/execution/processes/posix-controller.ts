import { spawn, type ChildProcess } from 'node:child_process'
import {
  deliverGuardianResult, GUARDED_OUTPUT_LIMIT, persistGuardianResult,
  type GuardianReason, type GuardianRequest, type GuardianResult,
} from './guardian.ts'

let child: ChildProcess | undefined
let request: GuardianRequest | undefined
let stopping: Exclude<GuardianReason, 'exited'> | undefined
let cleanupError: string | undefined
let groupSignalled = false
let admitted = false

function killGroup(): void {
  if (!child?.pid || groupSignalled) return
  try { process.kill(-child.pid, 'SIGKILL'); groupSignalled = true }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      cleanupError = error instanceof Error ? error.message : String(error)
    }
  }
}

function stop(reason: Exclude<GuardianReason, 'exited'>): void {
  if (reason === 'cancelled' && request && Date.now() >= request.deadlineAt) reason = 'deadline-expired'
  stopping ??= reason
  killGroup()
}

function send(value: object): void {
  if (process.connected) process.send?.(value, error => {
    if (error) stop('owner-lost')
  })
}

process.on('disconnect', () => stop('owner-lost'))
process.on('SIGTERM', () => stop('cancelled'))
process.on('SIGINT', () => stop('cancelled'))
process.on('message', value => {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    stop('supervisor-failed')
  } else if (value.type === 'start' && 'request' in value && !request) {
    request = value.request as GuardianRequest
    void run(request).catch(async error => {
      stop('supervisor-failed')
      console.error(error)
      process.exitCode = 1
      if (process.connected) process.disconnect()
    })
  } else if (value.type === 'admit' && child && !admitted) {
    admitted = true
    if (stopping) stop(stopping)
    else if (Date.now() >= request!.deadlineAt) stop('deadline-expired')
    else child.stdin!.end('start\n')
  } else if (value.type === 'stop' && 'reason' in value) {
    const reasons: readonly string[] = ['cancelled', 'deadline-expired', 'owner-lost', 'output-limit', 'supervisor-failed']
    if (typeof value.reason === 'string' && reasons.includes(value.reason)) {
      stop(value.reason as Exclude<GuardianReason, 'exited'>)
    } else stop('supervisor-failed')
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
  if (input.deadlineAt <= Date.now()) stopping ??= 'deadline-expired'
  if (!stopping) {
    // Until the outer guardian knows the group ID, controller loss closes this
    // gate instead of leaving an untracked command running.
    child = spawn('/bin/sh', ['-c', 'IFS= read -r start && exec "$@"', 'shadow-command-gate',
      input.command, ...input.args], {
      cwd: input.cwd, env: input.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const execution = child
    execution.stdin!.on('error', error => {
      if (!('code' in error) || error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        failure = error.message
        stop('supervisor-failed')
      }
    })
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
    execution.stdout!.on('data', chunk => output('stdout', chunk))
    execution.stderr!.on('data', chunk => output('stderr', chunk))
    execution.once('spawn', () => {
      send({ type: 'started', pid: execution.pid })
      if (stopping) stop(stopping)
    })
    execution.on('error', error => { failure = error.message; stop('supervisor-failed') })
    execution.once('exit', killGroup)
    const timer = setTimeout(() => stop('deadline-expired'), Math.max(0, input.deadlineAt - Date.now()))
    const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      execution.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }))
    })
    clearTimeout(timer)
    code = status.code ?? -1
    signal = status.signal
  }
  const result: GuardianResult = {
    version: 1, ...(child?.pid ? { pid: child.pid } : {}), startedAt, finishedAt: new Date().toISOString(),
    code, signal, reason: cleanupError ? 'cleanup-failed' : failure ? 'supervisor-failed' : stopping ?? 'exited',
    ...(cleanupError || failure ? { error: cleanupError ?? failure } : {}),
    stdout: Buffer.concat(stdout).toString('base64'), stderr: Buffer.concat(stderr).toString('base64'),
  }
  if (input.resultPath) await persistGuardianResult(input.resultPath, result)
  await deliverGuardianResult(result)
  if (process.connected) process.disconnect()
}
