import type {
  CancelReceiptV1,
  JobEventV1,
  JobRequestV1,
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
  execute(
    request: JobRequestV1,
    signal: AbortSignal,
  ): AsyncIterable<JobEventV1>
  getStatus(jobId: string): Promise<JobStatusV1 | null>
  cancel(jobId: string): Promise<CancelReceiptV1>
}