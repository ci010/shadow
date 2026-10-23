import type { ExecutionReceiptV1 } from './contracts.ts'
import type { RemoteFilesystemTarget } from './remote-filesystem-client.ts'
import { MAX_WORKDIR_IDENTITY_BYTES, parseWorkdirIdentity, WORKDIR_IDENTITY_OPERATION, type WorkdirIdentityV1 } from './workdir-identity.ts'

export class RemoteWorkdirIdentityError extends Error {
  constructor(readonly code: string, message: string, readonly status: 409 | 503 = 503) {
    super(message)
    this.name = 'RemoteWorkdirIdentityError'
  }
}

export async function executeRemoteWorkdirIdentity(target: RemoteFilesystemTarget): Promise<WorkdirIdentityV1> {
  const controller = new AbortController()
  const signal = AbortSignal.any([target.signal, controller.signal])
  const id = crypto.randomUUID()
  const now = Date.now()
  let output = ''
  let bytes = 0
  let terminal: ExecutionReceiptV1 | undefined
  for await (const event of target.executor.execute({
    version: 1, jobId: id, idempotencyKey: id, sessionId: target.sessionId, turnId: target.turnId,
    nodeId: target.nodeId, capabilityId: target.capabilityId, operation: WORKDIR_IDENTITY_OPERATION,
    args: {}, createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 30_000).toISOString(),
  }, signal)) {
    if (event.type === 'stderr' || (event.type === 'stdout' && (bytes += Buffer.byteLength(event.chunk)) > MAX_WORKDIR_IDENTITY_BYTES)) {
      controller.abort()
      throw new RemoteWorkdirIdentityError('invalid_remote_workdir_identity', 'The device returned an invalid workdir identity. Update the node and retry.')
    }
    if (event.type === 'stdout') output += event.chunk
    if ('receipt' in event) terminal = event.receipt
  }
  if (terminal?.state !== 'completed') {
    throw new RemoteWorkdirIdentityError('remote_workdir_identity_unavailable',
      'The device could not verify folder ownership. Reconnect or update the node and retry; no local folder was used.')
  }
  try { return parseWorkdirIdentity(JSON.parse(output)) } catch {
    throw new RemoteWorkdirIdentityError('invalid_remote_workdir_identity', 'The device returned an invalid workdir identity. Update the node and retry.')
  }
}
