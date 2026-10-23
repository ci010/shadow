import type { ExecutionReceiptV1 } from './contracts.ts'
import type { Executor } from './executor.ts'

export interface RemoteFilesystemTarget {
  readonly executor: Executor
  readonly nodeId: string
  readonly capabilityId: string
  readonly sessionId: string
  readonly turnId: string
  readonly signal: AbortSignal
  readonly executionKey?: string
  readonly recovering?: boolean
}

export class RemoteFilesystemError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'RemoteFilesystemError'
  }
}

export async function executeRemoteFilesystemText(
  target: RemoteFilesystemTarget,
  operation: string,
  args: unknown,
  maxOutputBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const createdAt = new Date()
  const jobId = crypto.randomUUID()
  const output: string[] = []
  let bytes = 0
  const controller = new AbortController()
  const signal = AbortSignal.any([target.signal, controller.signal])
  let terminal: ExecutionReceiptV1 | undefined
  for await (
    const event of target.executor.execute({
      version: 1,
      jobId,
      idempotencyKey: jobId,
      sessionId: target.sessionId,
      turnId: target.turnId,
      nodeId: target.nodeId,
      capabilityId: target.capabilityId,
      operation,
      args,
      createdAt: createdAt.toISOString(),
      deadlineAt: new Date(createdAt.getTime() + 60_000).toISOString(),
    }, signal)
  ) {
    if (event.type === 'stdout' || event.type === 'stderr') {
      bytes += Buffer.byteLength(event.chunk)
      if (bytes > maxOutputBytes) {
        controller.abort()
        throw new RemoteFilesystemError('result-too-large', 'The remote result exceeded its size limit.', false)
      }
      output.push(event.chunk)
    }
    if ('receipt' in event) terminal = event.receipt
  }
  if (!terminal || terminal.state !== 'completed') {
    throw new RemoteFilesystemError(
      terminal?.reason?.code ?? 'remote-operation-incomplete',
      terminal?.reason?.message ??
        `Remote filesystem operation ${operation} did not complete`,
      terminal?.reason?.retryable ?? true,
    )
  }
  return output.join('')
}
