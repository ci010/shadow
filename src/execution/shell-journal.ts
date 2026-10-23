import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  type ExecutionReceiptV1, type JobEventV1, type JobRequestV1,
  validateJobEventV1, validateJobRequestV1,
} from './contracts.ts'
import type { Executor } from './executor.ts'
import { parseGuardianResult, type GuardianResult } from './processes/guardian.ts'
import { defaultManagedShell } from './processes/shells.ts'
import { decodeChunks } from '../utils/decode-chunks.ts'
import { parseWorkdirProcessArgs } from './capability-shell.ts'

export const DURABLE_SHELL_OPERATION = 'workdir.process.execute-once'
export const RECONCILE_SHELL_OPERATION = 'workdir.process.reconcile'

export function isUnknownShellReceipt(receipt: ExecutionReceiptV1): boolean {
  return ['remote-node-unavailable', 'execution-outcome-unknown', 'execution-journal-unavailable',
    'process-cleanup-failed', 'cleanup-failed', 'supervisor-failed', 'unsupported-operation']
    .includes(receipt.reason?.code ?? '')
}

export type ShellReconciliation =
  | { version: 1; outcome: 'known'; events: JobEventV1[] }
  | { version: 1; outcome: 'unknown'; reason: string }

export function parseShellReconciliation(value: unknown, jobId: string, nodeId: string): ShellReconciliation {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('outcome' in value)) {
    throw new Error('Invalid shell reconciliation')
  }
  if (value.outcome === 'unknown' && 'reason' in value && typeof value.reason === 'string') {
    return { version: 1, outcome: 'unknown', reason: value.reason }
  }
  if (value.outcome !== 'known' || !('events' in value) || !Array.isArray(value.events) || !value.events.length) {
    throw new Error('Invalid shell reconciliation')
  }
  const rawEvents = value.events
  const events = rawEvents.map((event, index) => {
    const parsed = validateJobEventV1(event)
    if (!parsed.success || parsed.value.jobId !== jobId || parsed.value.sequence !== index
      || ('receipt' in parsed.value && (index !== rawEvents.length - 1 || parsed.value.receipt.nodeId !== nodeId))) {
      throw new Error('Uncorrelated shell reconciliation')
    }
    return parsed.value
  })
  if (!('receipt' in events.at(-1)!)) throw new Error('Shell reconciliation has no terminal receipt')
  return { version: 1, outcome: 'known', events }
}

function sameExecution(left: JobRequestV1, right: JobRequestV1): boolean {
  const identity = (request: JobRequestV1) => [
    request.idempotencyKey, request.nodeId, request.capabilityId,
    request.sessionId, request.turnId, request.operation, request.managedProject,
    parseWorkdirProcessArgs(request.args),
  ]
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() }
  finally { await file.close() }
  await rename(temporary, path)
}

/** A claimed directory is a durable tombstone, including if its metadata write was interrupted. */
export class ShellJournal {
  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new TypeError('Shell journal root must be absolute')
  }

  #directory(idempotencyKey: string): string {
    return join(this.root, createHash('sha256').update(idempotencyKey).digest('hex'))
  }

  processResultPath(request: JobRequestV1): string | undefined {
    return request.operation === DURABLE_SHELL_OPERATION
      ? join(this.#directory(request.idempotencyKey), 'process.json') : undefined
  }

  async claim(request: JobRequestV1): Promise<boolean> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const directory = this.#directory(request.idempotencyKey)
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
      throw error
    }
    await writeJson(join(directory, 'request.json'), request)
    return true
  }

  async complete(request: JobRequestV1, events: JobEventV1[]): Promise<void> {
    const result = parseShellReconciliation({ version: 1, outcome: 'known', events }, request.jobId, request.nodeId)
    await writeJson(join(this.#directory(request.idempotencyKey), 'terminal.json'), result)
  }

  async reconcile(request: JobRequestV1): Promise<ShellReconciliation> {
    const directory = this.#directory(request.idempotencyKey)
    const unknown = (reason: string): ShellReconciliation => ({ version: 1, outcome: 'unknown', reason })
    let original: unknown
    try { original = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return unknown('No durable admission record was found. The command was not re-executed.')
      }
      throw error
    }
    const validation = validateJobRequestV1(original)
    if (!validation.success || !sameExecution(validation.value, request)) {
      throw new Error('Execution identity does not match its durable admission record')
    }
    let prior: ShellReconciliation | undefined
    try {
      prior = parseShellReconciliation(JSON.parse(await readFile(join(directory, 'terminal.json'), 'utf8')),
        validation.value.jobId, request.nodeId)
      if (prior.outcome === 'known') {
        const terminal = prior.events.at(-1)!
        if ('receipt' in terminal && !isUnknownShellReceipt(terminal.receipt)) return prior
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    let result: GuardianResult
    try { result = parseGuardianResult(JSON.parse(await readFile(join(directory, 'process.json'), 'utf8'))) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return prior ?? unknown('The command has no final ownership receipt. It may be running or interrupted; it was not re-executed.')
      }
      throw error
    }
    const events = guardianEvents(validation.value, result)
    const terminal = events.at(-1)!
    if (prior && 'receipt' in terminal && isUnknownShellReceipt(terminal.receipt)) return prior
    await this.complete(validation.value, events)
    return { version: 1, outcome: 'known', events }
  }
}

export class JournaledShellExecutor implements Executor {
  constructor(readonly executor: Executor, readonly journal: ShellJournal) {}

  getStatus(jobId: string) { return this.executor.getStatus(jobId) }
  cancel(jobId: string) { return this.executor.cancel(jobId) }

  async *execute(request: JobRequestV1, signal: AbortSignal): AsyncIterable<JobEventV1> {
    const validation = validateJobRequestV1(request)
    if (!validation.success) throw new TypeError(validation.errors.join('; '))
    if (request.operation !== DURABLE_SHELL_OPERATION && request.operation !== RECONCILE_SHELL_OPERATION) {
      yield* this.executor.execute(request, signal)
      return
    }
    let sequence = 0
    try {
      signal.throwIfAborted()
      parseWorkdirProcessArgs(request.args)
      if (request.operation === RECONCILE_SHELL_OPERATION) {
        const result = await this.journal.reconcile({ ...request, operation: DURABLE_SHELL_OPERATION })
        if (result.outcome === 'known') yield* replayEvents(request, result.events)
        else yield failureEvent(request, 'execution-outcome-unknown', result.reason)
        return
      }
      if (!await this.journal.claim(request)) {
        const result = await this.journal.reconcile(request)
        if (result.outcome === 'known') yield* replayEvents(request, result.events)
        else yield failureEvent(request, 'execution-outcome-unknown', result.reason)
        return
      }
      const events: JobEventV1[] = []
      for await (const event of this.executor.execute(request, signal)) {
        events.push(event)
        if ('receipt' in event) await this.journal.complete(request, events)
        yield event
        sequence++
      }
    } catch (error) {
      yield failureEvent(request, 'execution-journal-unavailable',
        `Execution could not be safely admitted or reconciled: ${error instanceof Error ? error.message : String(error)}`, sequence)
    }
  }
}

function failureEvent(request: JobRequestV1, code: string, message: string, sequence = 0): JobEventV1 {
  const timestamp = new Date().toISOString()
  return {
    version: 1, jobId: request.jobId, sequence, timestamp, type: 'failed',
    receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'failed', finishedAt: timestamp,
      reason: { code, message, retryable: false } },
  }
}

function* replayEvents(request: JobRequestV1, events: JobEventV1[]): Iterable<JobEventV1> {
  for (const event of events) yield {
    ...event, jobId: request.jobId,
    ...('receipt' in event ? { receipt: { ...event.receipt, jobId: request.jobId } } : {}),
  }
}

function guardianEvents(request: JobRequestV1, result: GuardianResult): JobEventV1[] {
  const events: JobEventV1[] = []
  const shell = parseWorkdirProcessArgs(request.args).shell ?? defaultManagedShell()
  const envelope = () => ({ version: 1 as const, jobId: request.jobId, sequence: events.length, timestamp: result.finishedAt })
  for (const type of ['stdout', 'stderr'] as const) {
    const text = decodeChunks([Buffer.from(result[type], 'base64')], shell)
    for (let offset = 0; offset < text.length; offset += 8192) {
      events.push({ ...envelope(), type, chunk: text.slice(offset, offset + 8192) })
    }
  }
  const state = result.reason === 'deadline-expired' ? 'expired' : result.reason === 'cancelled' ? 'cancelled'
    : result.reason === 'exited' && result.code === 0 && !result.signal ? 'completed' : 'failed'
  const reason = result.reason === 'owner-lost'
    ? { code: 'execution-interrupted', message: 'The supervising process exited. The owned process tree was stopped; partial side effects may remain.' }
    : result.reason === 'exited' ? { code: 'process-exit', message: `Process exited with code ${result.code}` }
    : { code: result.reason, message: result.error ?? `Process supervision ended: ${result.reason}. Partial side effects may remain.` }
  const receipt: ExecutionReceiptV1 = {
    version: 1, jobId: request.jobId, nodeId: request.nodeId, state,
    startedAt: result.startedAt, finishedAt: result.finishedAt, ...(result.pid ? { pid: result.pid } : {}),
    exitCode: result.code, ...(result.signal ? { signal: result.signal } : {}),
    ...(state === 'completed' ? {} : { reason: { ...reason, retryable: false } }),
  }
  events.push({ ...envelope(), type: state === 'cancelled' ? 'cancel-acknowledged' : state, receipt })
  return events
}
