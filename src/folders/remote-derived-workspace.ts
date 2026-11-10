import { randomUUID } from 'node:crypto'
import { validateJobEventV1, type ExecutionReceiptV1 } from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { managedProjectScope } from '../execution/managed-workdir.ts'
import {
  DERIVED_WORKSPACE_OPERATION, parseDerivedWorkspaceArgs, parseDerivedWorkspaceInspectResult,
  parseDerivedWorkspaceResult, type DerivedWorkspaceArgs, type DerivedWorkspaceResult,
} from '../execution/derived-workspace-contract.ts'
import type { RemoteFolderRecord } from './contracts.ts'

export interface DerivedWorkspaceRemoteBackend {
  inspectSource(folder: RemoteFolderRecord, signal: AbortSignal): Promise<{ branch: string }>
  create(folder: RemoteFolderRecord, request: { key: string; branch: string; description?: string; name?: string }, signal: AbortSignal): Promise<DerivedWorkspaceResult>
  verify(folder: RemoteFolderRecord, key: string, signal: AbortSignal): Promise<DerivedWorkspaceResult>
}

/** Fixed protocol bound, independent of advertised transport limits. Paths remain opaque. */
export const MAX_DERIVED_WORKSPACE_RESULT_BYTES = 256 * 1024

/** Main-side client. Use the Project's executor, not the shared/raw device executor. */
export class RemoteDerivedWorkspaceBackend implements DerivedWorkspaceRemoteBackend {
  constructor(private readonly options: { projectId: string; executor: Executor }) {}

  async inspectSource(folder: RemoteFolderRecord, signal: AbortSignal): Promise<{ branch: string }> {
    const result = parseDerivedWorkspaceInspectResult(await this.#execute(folder, { action: 'inspect' }, signal))
    this.#identity(folder, result)
    return { branch: result.branch }
  }

  async create(folder: RemoteFolderRecord, request: { key: string; branch: string; description?: string; name?: string }, signal: AbortSignal): Promise<DerivedWorkspaceResult> {
    return this.#result(folder, await this.#execute(folder, { ...request, action: 'create' }, signal))
  }

  async verify(folder: RemoteFolderRecord, key: string, signal: AbortSignal): Promise<DerivedWorkspaceResult> {
    return this.#result(folder, await this.#execute(folder, { action: 'verify', key }, signal))
  }

  #identity(folder: RemoteFolderRecord, result: { nodeId: string; sourceWorkdirId: string }): void {
    if (result.nodeId !== folder.workdir.nodeId || result.sourceWorkdirId !== folder.workdir.workdirId) {
      throw new Error('Remote derived workspace source identity mismatch; no alternate target was selected.')
    }
  }

  #result(folder: RemoteFolderRecord, value: unknown): DerivedWorkspaceResult {
    const result = parseDerivedWorkspaceResult(value)
    this.#identity(folder, result)
    if (result.receipt.projectId !== managedProjectScope(this.options.projectId) ||
      result.workdir.workdirId === folder.workdir.workdirId || result.receipt.workKey !== undefined) {
      throw new Error('Remote derived workspace Project/target identity mismatch.')
    }
    return result
  }

  async #execute(folder: RemoteFolderRecord, input: DerivedWorkspaceArgs, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (folder.kind !== 'remote' || folder.workdir.nodeId === 'local' ||
      (folder.projectId !== undefined && folder.projectId !== this.options.projectId)) {
      throw new Error('Remote derived workspace source is outside the current Project.')
    }
    const args = parseDerivedWorkspaceArgs(input)
    const id = randomUUID(), now = Date.now()
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    let output = '', bytes = 0, sequence = -1
    let terminal: ExecutionReceiptV1 | undefined
    try {
      for await (const event of this.options.executor.execute({
        version: 2, jobId: id, idempotencyKey: id,
        sessionId: `folder:${folder.id}`, turnId: id,
        nodeId: folder.workdir.nodeId, workdirId: folder.workdir.workdirId,
        operation: DERIVED_WORKSPACE_OPERATION, args,
        createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 120_000).toISOString(),
      }, combined)) {
        combined.throwIfAborted()
        const valid = validateJobEventV1(event)
        if (!valid.success || terminal || event.jobId !== id || event.sequence <= sequence ||
          event.type === 'stderr' || event.type === 'artifact-ready') throw new Error('Invalid remote derived workspace event stream.')
        sequence = event.sequence
        if (event.type === 'stdout') {
          bytes += Buffer.byteLength(event.chunk)
          if (bytes > MAX_DERIVED_WORKSPACE_RESULT_BYTES) throw new Error('Remote derived workspace result exceeded its output bound.')
          output += event.chunk
        }
        if ('receipt' in event) {
          if (event.receipt.jobId !== id || event.receipt.nodeId !== folder.workdir.nodeId ||
            event.receipt.state !== (event.type === 'cancel-acknowledged' ? 'cancelled' : event.type)) {
            throw new Error('Remote derived workspace terminal identity mismatch.')
          }
          terminal = event.receipt
        }
      }
      combined.throwIfAborted()
      if (terminal?.state !== 'completed' || terminal.reason || terminal.signal ||
        (terminal.exitCode !== undefined && terminal.exitCode !== 0)) {
        throw new Error(`Remote derived workspace operation did not complete (${terminal?.reason?.code ?? terminal?.state ?? 'unknown'}, ${args.action}): ${terminal?.reason?.message?.slice(0, 1000) ?? 'No successful terminal receipt'}; no local fallback or automatic retry.`)
      }
      return JSON.parse(output)
    } catch (error) {
      // A malformed/lost result says nothing about a create's side effects. Never
      // retry/cancel/recreate here; the caller can explicitly recover its saved key.
      controller.abort()
      throw error
    }
  }
}
