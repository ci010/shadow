import { createHash } from 'node:crypto'
import type { ChatMessage, ToolCall } from '../providers/provider.ts'
import type { ExecutionContext } from '../tools/context.ts'

const kind = 'shadow_tool_uncertainty_v1'

/** Stable for JSON argument key order; direct and lazy invocation share identity. */
export function toolInvocationKey(call: ToolCall, context: ExecutionContext): string {
  const lazy = call.name === 'invoke_tool' && typeof call.arguments.name === 'string'
    && call.arguments.args !== null && typeof call.arguments.args === 'object' && !Array.isArray(call.arguments.args)
  const value = { name: lazy ? call.arguments.name : call.name,
    args: lazy ? call.arguments.args : call.arguments,
    instance: lazy ? call.arguments.instance : undefined,
    projectId: context.projectId, folderId: context.folderId, cwd: context.cwd,
    remoteWorkdir: context.remoteWorkdir ? { nodeId: context.remoteWorkdir.nodeId, workdirId: context.remoteWorkdir.workdirId } : undefined }
  return createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
}

/** A result records missing evidence, not successful completion or rollback. */
export function toolUncertaintyResult(invocation: string, callId: string, message: string, blocked = false): string {
  return JSON.stringify({ kind, status: blocked ? 'replay_blocked' : 'outcome_unknown', invocation,
    originalToolCallId: callId, message, retryAllowed: false,
    guidance: 'The original operation may have completed, partially changed state, or still be running. Do not repeat it or assume rollback. Explain the uncertainty; use distinct read-only status/history checks to reconcile it. This result closes the tool-call/result pair, not the underlying operation.' })
}

export function isToolUncertaintyResult(content: unknown): boolean {
  return uncertainty(content) !== undefined
}

function uncertainty(content: unknown): { invocation: string; originalToolCallId: string } | undefined {
  if (typeof content !== 'string') return
  try {
    const value = JSON.parse(content)
    if (value?.kind === kind && (value.status === 'outcome_unknown' || value.status === 'replay_blocked')
      && value.retryAllowed === false && typeof value.invocation === 'string' && /^[a-f0-9]{64}$/.test(value.invocation)
      && typeof value.originalToolCallId === 'string') return value
  } catch { /* Ordinary tool text is not an uncertainty receipt. */ }
}

/** Rehydrated ordinary tool results prevent exact replay after provider recovery too.
 * This is a conservative duplicate guard, not a semantic/OS side-effect sandbox.
 * Tool implementations must still enforce their resource-specific recovery rules.
 */
export function uncertainInvocations(messages: ChatMessage[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const value = uncertainty(message.content)
    if (value) result.set(value.invocation, value.originalToolCallId)
  }
  return result
}
