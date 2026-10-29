import { createHash } from 'node:crypto'
import type { ChatMessage } from '../providers/provider.ts'

import { isRuntimeContextEvent } from './runtime-context-contract.ts'

type Call = NonNullable<ChatMessage['tool_calls']>[number]

/** A display-only reference; persisted IDs and physical segment selection stay unchanged. */
export function shortPhysicalReference(physicalId: string): string {
  return '~' + createHash('sha256').update(physicalId).digest('hex').slice(0, 16)
}

const collaborationFields: Record<string, readonly string[]> = {
  subagent: ['mode', 'task', 'title', 'description', 'agent_type'],
  call: ['task', 'title', 'description'],
  session: ['action', 'title', 'description', 'initialMessage', 'sessionId'],
  message: ['sessionId', 'content', 'delivery', 'intent', 'attention'],
}
function collaborationFieldNames(name: string): readonly string[] | undefined {
  return Object.hasOwn(collaborationFields, name) ? collaborationFields[name] : undefined
}
function preview(value: string, limit = 480): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return JSON.stringify(text.length > limit ? text.slice(0, limit) + '…[truncated]' : text)
}
function collaborationArgs(call: Call): string {
  const fields = collaborationFieldNames(call.function.name)
  if (!fields) return ''
  try {
    const args: unknown = JSON.parse(call.function.arguments)
    if (!args || typeof args !== 'object' || Array.isArray(args)) return ' [invalid arguments]'
    return fields.flatMap(key => {
      const value = (args as Record<string, unknown>)[key]
      return typeof value === 'string' ? [` ${key}=${preview(value, 240)}`] : []
    }).join('')
  } catch { return ' [invalid arguments]' }
}

/** Display filtering only: recognizing an envelope never establishes trust or authority. */
export function isOverviewHidden(message: ChatMessage): boolean {
  if (message.role === 'system' || isRuntimeContextEvent(message)) return true
  if (message.role !== 'user') return false
  if (message.name === '__work_realignment__') return true
  const first = Array.isArray(message.content) ? message.content[0] : undefined
  if (first?.type === 'text' && /^<event type="(?:subagent-(?:complete|failed|cancelled|review-requested)|session-message|background-task-complete)" source="[^"]*" event-id="[^"]*"(?: [A-Za-z_][A-Za-z0-9_.-]*="[^"]*")* \/>$/.test(first.text)) return false
  return first?.type === 'text' && /^<event type="[^"]*" source="[^"]*" event-id="[^"]*"(?: [A-Za-z_][A-Za-z0-9_.-]*="[^"]*")* \/>$/.test(first.text)
}

export function formatSessionMessage(
  msg: ChatMessage,
  index: number,
  highlight = false,
  overview = false,
  physicalId?: string,
  priorCall?: Call,
  callReferences?: Map<string, string>,
): string[] {
  if (overview && isOverviewHidden(msg)) return []
  const ref = (id: string) => callReferences?.get(id) ?? id
  const callPath = (id: string) => physicalId ? ` → v:sessions/${shortPhysicalReference(physicalId)}/${callReferences?.has(id) ? 'c' : 'calls'}/${encodeURIComponent(ref(id))}` : ''
  const role = msg.role.toUpperCase()
  let body: string
  if (overview && msg.role === 'tool') {
    body = `[result for ${ref(msg.tool_call_id ?? '?')}] name=${priorCall?.function.name ?? msg.name ?? '?'} status=result-recorded${msg.tool_call_id ? callPath(msg.tool_call_id) : ''}${priorCall && collaborationFieldNames(priorCall.function.name) ? ` preview=${preview(contentText(msg))}` : ''}`
  } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
    const calls = msg.tool_calls
      .map((tc: NonNullable<ChatMessage['tool_calls']>[number]) =>
        `  [call ${overview ? ref(tc.id) : tc.id}] ${tc.function.name}${overview ? ` status=requested${callPath(tc.id)}${collaborationArgs(tc)}` : `(${tc.function.arguments})`}`
      )
      .join('\n')
    body = msg.content && (!overview || msg.tool_calls.some(call => collaborationFieldNames(call.function.name))) ? `${overview ? `commentary=${preview(contentText(msg))}` : contentText(msg)}\n${calls}` : calls
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
              const url = part.image_url?.url ?? ''
              // History is text, not an image transport. Never expand embedded bytes.
              if (/^https?:\/\//i.test(url)) return `[image: ${preview(url, 480)}]`
              return '[image attachment: inline data omitted]'
            }
            return `[${part.type}]`
          },
        )
        .join(' ')
    } else {
      body = String(c ?? '')
    }
  }
  if (overview && !msg.tool_calls?.length && !isOverviewHidden(msg) && Array.isArray(msg.content) && msg.content[0]?.type === 'text' && msg.content[0].text.startsWith('<event ')) body = `event preview=${preview(body)}`
  const prefix = highlight ? `>>> #${index} ` : `    #${index} `
  const time = msg.timestamp ? ` ${msg.timestamp}` : ''
  return [
    `${prefix}[${role}]${msg.name ? ` (${msg.name})` : ''}${time}`,
    body,
  ]
}

export function formatSessionHistory(messages: ChatMessage[], overview = false, physicalId?: string): string {
  const calls = new Map<string, Call>()
  const refs = new Map<string, string>()
  return messages.map((message, index) => {
    for (const [callIndex, call] of (message.tool_calls ?? []).entries()) refs.set(call.id, `${index + 1}.${callIndex + 1}`)
    const lines = formatSessionMessage(message, index + 1, false, overview, physicalId, calls.get(message.tool_call_id ?? ''), refs)
    for (const call of message.tool_calls ?? []) calls.set(call.id, call)
    return lines.join('\n')
  }).filter(Boolean).join('\n\n')
}

/** One-based next-entry line in the physical VFS view (two header lines). */
export function sessionHistoryLineAt(messages: ChatMessage[], index: number, overview: boolean): number {
  const prefix = formatSessionHistory(messages.slice(0, index), overview)
  return prefix ? 3 + prefix.split('\n').length + 1 : 3
}

function contentText(message: ChatMessage): string {
  return Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'text').map(part => part.text).join(' ')
    : String(message.content ?? '')
}
