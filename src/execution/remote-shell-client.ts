import type { ExecutionReceiptV1 } from './contracts.ts'
import type { RemoteFilesystemTarget } from './remote-filesystem-client.ts'
import {
  MAX_REMOTE_SHELL_TIMEOUT_MS,
  parseWorkdirProcessArgs,
  WORKDIR_PROCESS_EXECUTE_OPERATION,
} from './capability-shell.ts'

export async function executeRemoteShell(
  target: RemoteFilesystemTarget,
  args: unknown,
  timeoutMs: number,
): Promise<string> {
  target.signal.throwIfAborted()
  const parsed = parseWorkdirProcessArgs(args)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REMOTE_SHELL_TIMEOUT_MS) {
    return `Error: remote exec requires timeout_ms between 1 and ${MAX_REMOTE_SHELL_TIMEOUT_MS}; background execution (timeout_ms=0) is unsupported. Remote commands are terminated on timeout.`
  }
  const createdAt = new Date()
  const jobId = crypto.randomUUID()
  const stdout: string[] = []
  const stderr: string[] = []
  let terminal: ExecutionReceiptV1 | undefined
  for await (const event of target.executor.execute({
    version: 1,
    jobId,
    idempotencyKey: jobId,
    sessionId: target.sessionId,
    turnId: target.turnId,
    nodeId: target.nodeId,
    capabilityId: target.capabilityId,
    operation: WORKDIR_PROCESS_EXECUTE_OPERATION,
    args: parsed,
    createdAt: createdAt.toISOString(),
    deadlineAt: new Date(createdAt.getTime() + timeoutMs).toISOString(),
    approval: 'none',
  }, target.signal)) {
    if (event.type === 'stdout') stdout.push(event.chunk)
    if (event.type === 'stderr') stderr.push(event.chunk)
    if ('receipt' in event) {
      if (event.receipt.jobId !== jobId || event.receipt.nodeId !== target.nodeId ||
        (event.type === 'completed') !== (event.receipt.state === 'completed')) {
        return 'Error: remote exec returned an uncorrelated or inconsistent terminal receipt; process state is unknown.'
      }
      terminal = event.receipt
    }
  }
  const output = stdout.join('') + (stderr.length ? `\n[stderr]\n${stderr.join('')}` : '')
  const state = terminal?.state
  if (state !== 'completed' || terminal?.exitCode !== 0) {
    const reason = terminal?.reason?.message ?? 'Remote command did not return a successful terminal receipt'
    const code = terminal?.reason?.code ?? 'remote-execution-incomplete'
    return `Error: remote exec ${state ?? 'incomplete'} [${code}]: ${reason}` +
      (terminal?.exitCode !== undefined ? ` (exit code ${terminal.exitCode})` : '') +
      (code === 'remote-node-unavailable' ? '; remote process state is unknown until the Child reconnects.' : '') +
      (output ? `\n${output}` : '')
  }
  return output || '(no output, exit code 0)'
}
