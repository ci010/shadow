import type { ChatMessage } from '../providers/provider.ts'

import { isRuntimeContextEvent } from './runtime-context-contract.ts'

type Call = NonNullable<ChatMessage['tool_calls']>[number]

/** Only host metadata envelopes are hidden, not event-looking human strings. */
export function isOverviewHidden(message: ChatMessage): boolean {
  if (message.role === 'system' || isRuntimeContextEvent(message)) return true
  if (message.role !== 'user') return false
  if (message.name === '__work_realignment__') return true
  const first = Array.isArray(message.content) ? message.content[0] : undefined
  return first?.type === 'text' && /^<event type="[^"]*" source="[^"]*" event-id="[^"]*"(?: [A-Za-z_][A-Za-z0-9_.-]*="[^"]*")* \/>$/.test(first.text)
}

export function formatSessionMessage(
  msg: ChatMessage,
  index: number,
  highlight = false,
  overview = false,
  physicalId?: string,
  priorCall?: Call,
): string[] {
  if (overview && isOverviewHidden(msg)) return []
  const callPath = (id: string) => physicalId ? ` → v:sessions/${physicalId}/calls/${encodeURIComponent(id)}` : ''
  const role = msg.role.toUpperCase()
  let body: string
  if (overview && msg.role === 'tool') {
    body = `[result for ${msg.tool_call_id ?? '?'}] name=${priorCall?.function.name ?? msg.name ?? '?'} status=result-recorded${msg.tool_call_id ? callPath(msg.tool_call_id) : ''}`
  } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
    const calls = msg.tool_calls
      .map((tc: NonNullable<ChatMessage['tool_calls']>[number]) =>
        `  [call ${tc.id}] ${tc.function.name}${overview ? ` status=requested${callPath(tc.id)}` : `(${tc.function.arguments})`}`
      )
      .join('\n')
    body = !overview && msg.content ? `${msg.content}\n${calls}` : calls
  } else if (msg.role === 'tool') {
    body = `[result for ${msg.tool_call_id ?? '?'}] ${msg.content ?? ''}`
  } else {
    const c = msg.content
    if (Array.isArray(c)) {
      body = c
        .map(
          (
            part: { type: string; text?: string; image_url?: { url: string } },
          ) => {
            if (part.type === 'text') return part.text ?? ''
            if (part.type === 'image_url') {
              return `[image: ${part.image_url?.url ?? ''}]`
            }
            return `[${part.type}]`
          },
        )
        .join(' ')
    } else {
      body = String(c ?? '')
    }
  }
  const prefix = highlight ? `>>> #${index} ` : `    #${index} `
  const time = msg.timestamp ? ` ${msg.timestamp}` : ''
  return [
    `${prefix}[${role}]${msg.name ? ` (${msg.name})` : ''}${time}`,
    body,
  ]
}

export function formatSessionHistory(messages: ChatMessage[], overview = false, physicalId?: string): string {
  const calls = new Map<string, Call>()
  return messages.map((message, index) => {
    const lines = formatSessionMessage(message, index + 1, false, overview, physicalId, calls.get(message.tool_call_id ?? ''))
    for (const call of message.tool_calls ?? []) calls.set(call.id, call)
    return lines.join('\n')
  }).filter(Boolean).join('\n\n')
}

/** One-based next-entry line in the physical VFS view (two header lines). */
export function sessionHistoryLineAt(messages: ChatMessage[], index: number, overview: boolean): number {
  const prefix = formatSessionHistory(messages.slice(0, index), overview)
  return prefix ? 3 + prefix.split('\n').length + 1 : 3
}
