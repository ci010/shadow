import type { ExecutionReceiptV1 } from './contracts.ts'
import type { RemoteFilesystemTarget } from './remote-filesystem-client.ts'
import { DURABLE_SHELL_OPERATION, isUnknownShellReceipt, RECONCILE_SHELL_OPERATION } from './shell-journal.ts'
import { ToolOutcomeUnknownError } from '../tools/tool.ts'
import {
  REMOTE_SHELL_ADMISSION_TIMEOUT_MS,
  parseWorkdirProcessArgs,
} from './capability-shell.ts'

export async function executeRemoteShell(
  target: RemoteFilesystemTarget,
  args: unknown,
  timeoutMs: number,
  completedFailure?: () => void,
  options: { untilExit?: boolean; observe?: (output: string) => void; onReceipt?: (receipt: ExecutionReceiptV1) => void } = {},
): Promise<string> {
  target.signal.throwIfAborted()
  const parsed = parseWorkdirProcessArgs(args)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    return 'Error: `timeout_ms` must be a finite non-negative integer no greater than 2147483647'
  }
  const createdAt = new Date()
  const jobId = crypto.randomUUID()
  const stdout: string[] = []
  const stderr: string[] = []
  let terminal: ExecutionReceiptV1 | undefined
  let terminalType: string | undefined
  try {
  for await (const event of target.executor.execute({
    version: 2,
    jobId,
    idempotencyKey: target.executionKey ?? jobId,
    sessionId: target.sessionId,
    turnId: target.executionKey ?? target.turnId,
    nodeId: target.nodeId, workdirId: target.workdirId,
    operation: target.recovering ? RECONCILE_SHELL_OPERATION : DURABLE_SHELL_OPERATION,
    args: { ...parsed, ...(options.untilExit ? { lifetime: 'until-exit' } : {}) },
    createdAt: createdAt.toISOString(),
    deadlineAt: new Date(createdAt.getTime() + (options.untilExit ? REMOTE_SHELL_ADMISSION_TIMEOUT_MS : timeoutMs)).toISOString(),
  }, target.signal)) {
    if (event.type === 'stdout') stdout.push(event.chunk)
    if (event.type === 'stderr') stderr.push(event.chunk)
    if (event.type === 'stdout' || event.type === 'stderr') {
      if (stdout.join('').length + stderr.join('').length > 128 * 1024 + 1024) throw new ToolOutcomeUnknownError('Remote output limit exceeded; outcome unknown; command was not re-executed.')
      options.observe?.(stdout.join('') + (stderr.length ? `\n[stderr]\n${stderr.join('')}` : ''))
    }
    if ('receipt' in event) {
      if (event.jobId !== jobId || event.receipt.jobId !== jobId || event.receipt.nodeId !== target.nodeId ||
        (event.type === 'completed') !== (event.receipt.state === 'completed')) {
        throw new ToolOutcomeUnknownError('Remote exec returned an uncorrelated or inconsistent receipt. Execution outcome is unknown; no command was re-executed.')
      }
      terminal = event.receipt
      terminalType = event.type
    }
  }
  } catch (error) {
    if (!target.recovering || error instanceof ToolOutcomeUnknownError) throw error
    throw new ToolOutcomeUnknownError(
      `The reconciliation query failed without a verified original execution receipt: ${error instanceof Error ? error.message : String(error)}. ` +
      'The original execution outcome remains unknown; the command was not re-executed.',
    )
  }
  if (terminal) options.onReceipt?.(terminal)
  const output = stdout.join('') + (stderr.length ? `\n[stderr]\n${stderr.join('')}` : '')
  const state = terminal?.state
  if (!terminal || isUnknownShellReceipt(terminal) || (target.recovering && !terminal.reconciledJobId)) {
    throw new ToolOutcomeUnknownError(
      `Remote execution outcome is unknown: ${terminal?.reason?.message ?? 'No terminal receipt was received'}. ` +
      'Reconciliation checks only the original Child execution record; it does not re-execute this command. The command may still be running and partial side effects may remain.',
    )
  }
  if (state !== 'completed' || terminal?.exitCode !== 0) {
    const exitCode = terminal?.exitCode
    if (terminalType === state && (state === 'completed' || state === 'failed' && terminal?.reason?.code === 'process-exit') &&
      typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && exitCode > 0 && !terminal?.signal && !target.signal.aborted) completedFailure?.()
    const reason = terminal?.reason?.message ?? 'Remote command did not return a successful terminal receipt'
    const code = terminal?.reason?.code ?? 'remote-execution-incomplete'
    return `Error: remote exec ${state ?? 'incomplete'} [${code}]: ${reason}` +
      (terminal?.exitCode !== undefined ? ` (exit code ${terminal.exitCode})` : '') +
      (output ? `\n${output}` : '')
  }
  return output || '(no output, exit code 0)'
}
