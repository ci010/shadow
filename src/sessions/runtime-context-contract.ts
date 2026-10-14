import type { ChatMessage } from '../providers/provider.ts'

/** Recognize only a host event envelope, never event-looking text in a user's payload. */
export function isRuntimeContextEvent(message: ChatMessage): boolean {
  if (message.role !== 'user' || message.name !== 'runtime-context' || !Array.isArray(message.content)) return false
  const metadata = message.content[0]
  return metadata?.type === 'text' && /^<event type="runtime-context-(work|audience)" source="runtime-context" event-id="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" \/>$/.test(metadata.text)
}
