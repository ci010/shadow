import type { ExecutionContext } from '../agent/agent.ts'
import type { ToolExecutionHook } from '../tools/tool.ts'
import type { MemoryStore } from '../agent/memory.ts'

/**
 * Deterministically records files the agent modifies (write / edit) into the
 * session's working set.
 *
 * This runs in the runtime tool-execution pipeline — **no LLM, no agent
 * bookkeeping**. It mirrors the philosophy in MEM.md "Modified Files": the
 * record is a by-product of doing work, captured from real tool calls, so it
 * is always current and fully auditable (not model-authored).
 */
export class WorkingSetHook implements ToolExecutionHook {
  readonly name = 'working-set'

  constructor(private memory: MemoryStore) {}

  async afterExecute(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    context: ExecutionContext,
  ): Promise<undefined> {
    if (toolName !== 'write') return undefined
    // The write tool returns "Error: ..." on failure — don't record those.
    if (typeof result === 'string' && result.startsWith('Error')) {
      return undefined
    }
    const path = typeof args.path === 'string' ? args.path : undefined
    if (!path) return undefined

    const action = args.match != null ? 'edit' : 'write'
    try {
      await this.memory.recordModifiedFile(context.sessionId, path, action)
    } catch (err) {
      console.warn(`[working-set] failed to record ${path}:`, err)
    }
    return undefined
  }
}
