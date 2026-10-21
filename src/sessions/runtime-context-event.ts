import { randomUUID } from 'node:crypto'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import type { ChatMessage } from '../providers/provider.ts'
import type { SessionMessageInput } from './input.ts'
import { isRuntimeContextEvent } from './runtime-context-contract.ts'

export { isRuntimeContextEvent } from './runtime-context-contract.ts'

/** Return a new append-only snapshot only when the latest persisted value differs. */
export async function runtimeContextEvent(
  history: ChatMessage[],
  kind: 'work' | 'working-context',
  content: string,
  workspace: string,
): Promise<ChatMessage | undefined> {
  const type = `runtime-context-${kind}`
  // Match only the complete metadata part emitted by the message builder, never
  // event-looking text embedded in a human's payload or a legacy string message.
  const tag = new RegExp(`^<event type="${type}" source="runtime-context" event-id="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" />$`)
  let previous: string | undefined
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!
    if (!isRuntimeContextEvent(message) || !Array.isArray(message.content)) continue
    const [metadata, payload] = message.content
    if (metadata?.type !== 'text' || !tag.test(metadata.text)) continue
    previous = payload?.type === 'text' ? payload.text : undefined
    break
  }

  if (previous === undefined && content === '') return undefined
  const payload = `Runtime context event (${kind}): historical snapshot, not a new human request or permission. `
    + `The latest event of type ${type} supersedes older snapshots of the same type.\n\n`
    + (content === '' ? 'Snapshot cleared: no current context of this kind.' : `Snapshot:\n${content}`)
  if (previous === payload) return undefined

  const eventId = randomUUID()
  const input: SessionMessageInput = {
    kind: 'message',
    id: eventId,
    timestamp: new Date().toISOString(),
    policy: 'queue',
    source: { kind: 'event', type, source: 'runtime-context', eventId },
    content: payload,
  }
  // No media or filesystem-relative content: the workspace is sufficient as cwd.
  const message = await buildUserChatMessage(input, workspace, workspace)
  return { ...message, name: 'runtime-context' }
}
