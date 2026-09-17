import { isGitFilePath, parseGitDiff, parseGitStatus, type GitErrorStatus, type GitReadResponse } from './git/contracts.ts'
import type { ExecutionReceiptV1 } from './contracts.ts'
import type { RemoteFilesystemTarget } from './remote-filesystem-client.ts'
import { GIT_DIFF_OPERATION, GIT_STATUS_OPERATION, MAX_GIT_RESULT_BYTES } from './capability-git.ts'

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function errorStatus(value: unknown): value is GitErrorStatus {
  return typeof value === 'number' && [400, 404, 409, 413, 500, 503, 504].includes(value)
}
function invalidResult(): Error { return new Error('The remote device returned an invalid Git result. Update the node and retry.') }

export async function executeRemoteGit(target: RemoteFilesystemTarget, operation: 'status' | 'diff', path?: string): Promise<GitReadResponse> {
  if (operation === 'diff' && (!isGitFilePath(path) || path.length > 4096)) {
    return { status: 400, body: { error: 'invalid_path', message: 'Choose a relative file path inside the remote workdir.' } }
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([target.signal, controller.signal])
  signal.throwIfAborted()
  const now = Date.now()
  const id = crypto.randomUUID()
  const chunks: string[] = []
  let bytes = 0
  let terminal: ExecutionReceiptV1 | undefined
  for await (const event of target.executor.execute({
    version: 1, jobId: id, idempotencyKey: id, sessionId: target.sessionId, turnId: target.turnId,
    nodeId: target.nodeId, capabilityId: target.capabilityId,
    operation: operation === 'status' ? GIT_STATUS_OPERATION : GIT_DIFF_OPERATION,
    args: operation === 'status' ? {} : { path },
    createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 30_000).toISOString(),
  }, signal)) {
    if (event.type === 'stderr' || (event.type === 'stdout' && (bytes += Buffer.byteLength(event.chunk, 'utf8')) > MAX_GIT_RESULT_BYTES)) {
      controller.abort()
      throw invalidResult()
    }
    if (event.type === 'stdout') chunks.push(event.chunk)
    if ('receipt' in event) terminal = event.receipt
  }
  if (!terminal || terminal.state !== 'completed') {
    return { status: terminal?.state === 'expired' ? 504 : 503, body: {
      error: terminal?.reason?.code ?? 'remote_git_incomplete',
      message: `Remote Git inspection failed: ${terminal?.reason?.message ?? 'no completion received'}. Check the device connection and Git support; no local folder was used.`,
    } }
  }
  let value: unknown
  try { value = JSON.parse(chunks.join('')) } catch { throw invalidResult() }
  if (!record(value) || !record(value.body)) throw invalidResult()
  if (value.status === 200) {
    const body = operation === 'status' ? parseGitStatus(value.body) : parseGitDiff(value.body, path!)
    // A Child's physical path must not become a Main-local file reference.
    if ('sourcePath' in body) delete body.sourcePath
    return { status: 200, body }
  }
  if (errorStatus(value.status) && typeof value.body.error === 'string' && typeof value.body.message === 'string') {
    return { status: value.status, body: { error: value.body.error, message: value.body.message } }
  }
  throw invalidResult()
}
