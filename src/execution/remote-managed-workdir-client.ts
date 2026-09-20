import { randomUUID } from 'node:crypto'
import type { Executor } from './executor.ts'
import type { ExecutionReceiptV1 } from './contracts.ts'
import { MANAGED_SESSION_CAPABILITY, MANAGED_SESSION_OPERATION, managedSessionCapability } from './managed-workdir.ts'
import { parseWorkdirRefV1, type WorkdirRefV1 } from '../sessions/locality.ts'
import { FolderError } from '../folders/registry.ts'

export async function allocateRemoteSessionWorkdir(options: {
  executor: Executor
  projectId: string
  sessionId: string
  nodeId: string
  signal: AbortSignal
}): Promise<WorkdirRefV1> {
  options.signal.throwIfAborted()
  const id = randomUUID()
  const now = Date.now()
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  let output = ''
  let bytes = 0
  let terminal: ExecutionReceiptV1 | undefined
  for await (const event of options.executor.execute({
    version: 1, jobId: id, idempotencyKey: id, sessionId: options.sessionId, turnId: id,
    nodeId: options.nodeId, capabilityId: MANAGED_SESSION_CAPABILITY, operation: MANAGED_SESSION_OPERATION,
    args: {}, createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 30_000).toISOString(),
  }, signal)) {
    if (event.type === 'stderr' || (event.type === 'stdout' && (bytes += Buffer.byteLength(event.chunk)) > 16_384)) {
      controller.abort()
      throw new FolderError('invalid_managed_workdir', 'The node returned an invalid session allocation.', 503)
    }
    if (event.type === 'stdout') output += event.chunk
    if ('receipt' in event) terminal = event.receipt
  }
  options.signal.throwIfAborted()
  if (terminal?.state !== 'completed' || terminal.nodeId !== options.nodeId) {
    throw new FolderError('managed_session_allocation_failed', 'The node could not allocate a session workdir. Reconnect and retry; no local folder was used.', 503)
  }
  let value: unknown
  try { value = JSON.parse(output) } catch { /* Rejected by the wire validation below. */ }
  const ref = parseWorkdirRefV1(value)
  if (!ref || Object.keys(value as object).some(key =>
    !['version', 'nodeId', 'capabilityId', 'displayName', 'displayPathSnapshot'].includes(key)) ||
    ref.nodeId !== options.nodeId || ref.capabilityId !== managedSessionCapability(options.projectId, options.sessionId)) {
    throw new FolderError('invalid_managed_workdir', 'The node returned an unowned session workdir.', 503)
  }
  return ref
}
