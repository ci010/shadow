import type { ChatMessage } from '../providers/provider.ts'

/**
 * Remove incomplete tool-use / orphaned tool-result pairs.
 *
 * Keeps only assistant messages whose every tool_call has a matching
 * tool result, and tool messages whose tool_call_id was declared by
 * an assistant message.
 */
export function sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const declaredIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) declaredIds.add(tc.id)
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      resultIds.add(msg.tool_call_id)
    }
  }

  return messages.filter((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const ok = msg.tool_calls.every((tc) => resultIds.has(tc.id))
      if (!ok) {
        console.warn(
          `[session] Dropping incomplete tool_use (ids: ${msg.tool_calls.map((tc) => tc.id).join(', ')
          })`,
        )
      }
      return ok
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      const ok = declaredIds.has(msg.tool_call_id)
      if (!ok) {
        console.warn(
          `[session] Dropping orphaned tool_result (id: ${msg.tool_call_id})`,
        )
      }
      return ok
    }
    return true
  })
}

/**
 * Truncate a message array to `maxMessages`, then sanitize to avoid
 * broken tool-use / tool-result pairs at the truncation boundary.
 */
export function truncatePreservingToolPairs(
  messages: ChatMessage[],
  maxMessages: number,
): ChatMessage[] {
  if (messages.length <= maxMessages) return messages
  return sanitizeToolPairs(messages.slice(-maxMessages))
}
