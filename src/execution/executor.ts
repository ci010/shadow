import type {
  CancelReceiptV1,
  JobEventV1,
  ExecutionRequestV2,
  JobStatusV1,
} from './contracts.ts'
import type { ManagedProcess } from './processes/manager.ts'
import type { ManagedShell } from './processes/shells.ts'
import type { ProcessSupervision } from './processes/guardian.ts'

export interface ProcessExecuteArgsV1 {
  script: string
  cwd: string
  env?: Record<string, string>
  shell?: ManagedShell
  args?: string[]
}

export interface LocalProcessExecutor {
  startProcess(args: ProcessExecuteArgsV1, options?: { isolated?: boolean; signal?: AbortSignal; supervision?: ProcessSupervision }): Promise<ManagedProcess>
}

export interface Executor {
  /** Side-effect-free admission; durable wrappers invoke this before claiming a journal slot. */
  assertCanExecute?(request: ExecutionRequestV2, signal: AbortSignal): void | Promise<void>
  execute(
    request: ExecutionRequestV2,
    signal: AbortSignal,
  ): AsyncIterable<JobEventV1>
  getStatus(jobId: string): Promise<JobStatusV1 | null>
  cancel(jobId: string): Promise<CancelReceiptV1>
}