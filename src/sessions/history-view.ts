import type { ChatMessage } from '../providers/provider.ts'

type Call = NonNullable<ChatMessage['tool_calls']>[number]
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function parse(text: string): unknown {
  // Bound parsing as well as output; oversized payloads remain available via the call link.
  if (text.length > 32_000) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}
function compact(value: string): string {
  return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value)
}
function metadata(value: unknown): string {
  if (!object(value)) return '[invalid or oversized metadata object]'
  const fields = ['title', 'description', 'completed', 'projectDir', 'cwd']
  const parts = fields.filter(key => key in value).map(key => {
    const v = value[key]
    return `${key}=${typeof v === 'string' ? compact(v) : typeof v === 'boolean' || v === null ? String(v) : '[invalid type]'}`
  })
  if (Object.keys(value).some(key => !fields.includes(key))) parts.push('[unknown fields omitted]')
  return parts.join(', ') || '[no supported fields]'
}
function special(call: Call): { args: Record<string, unknown>; kind: 'folder' | 'self' } | undefined {
  const args = parse(call.function.arguments)
  if (!object(args)) return undefined
  if (call.function.name === 'use_project') return { args, kind: 'folder' }
  if (call.function.name === 'write' && args.path === 'v:session/self.json') return { args, kind: 'self' }
  return undefined
}
function attempt(call: Call): string {
  const state = special(call)
  if (!state) return call.function.name === 'use_project' ? '[attempt; invalid or oversized arguments]' : '…'
  const { args, kind } = state
  if (kind === 'folder') return `attempt folder=${typeof args.folder === 'string' ? compact(args.folder) : '[invalid or missing]'}`
  if (typeof args.flag === 'string' && args.flag.includes('a')) return 'attempt path="v:session/self.json"; append requested (unsupported); content omitted'
  if (args.match != null) return 'attempt path="v:session/self.json"; exact edit requested; replacement is not final state; content omitted'
  return `attempt path="v:session/self.json"; metadata: ${typeof args.content === 'string' ? metadata(parse(args.content)) : '[invalid content]'}`
}
function observed(call: Call | undefined, msg: ChatMessage): string {
  const state = call && special(call)
  if (!state) return 'omitted'
  if (typeof msg.content !== 'string') return 'status unknown; non-text result omitted'
  if (/^Error:/i.test(msg.content)) return `error evidence=${compact(msg.content)}`
  if (state.kind === 'self') {
    const value = parse(msg.content)
    return object(value) ? `observed metadata result (not inferred from request): ${metadata(value)}` : `status unknown; result evidence=${compact(msg.content)}`
  }
  return `observed result evidence=${compact(msg.content)}`
}

export function formatSessionMessage(
  msg: ChatMessage,
  index: number,
  highlight = false,
  overview = false,
  physicalId?: string,
  priorCall?: Call,
): string[] {
  const callPath = (id: string) => physicalId ? ` → v:sessions/${physicalId}/calls/${encodeURIComponent(id)}` : ''
  const role = msg.role.toUpperCase()
  let body: string
  if (overview && msg.role === 'tool') {
    body = `[result for ${msg.tool_call_id ?? '?'}; ${observed(priorCall, msg)}]${msg.tool_call_id ? callPath(msg.tool_call_id) : ''}`
  } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
    const calls = msg.tool_calls
      .map((tc: NonNullable<ChatMessage['tool_calls']>[number]) =>
        `  [call ${tc.id}] ${tc.function.name}(${overview ? attempt(tc) : tc.function.arguments})${overview ? callPath(tc.id) : ''}`
      )
      .join('\n')
    body = msg.content ? `${msg.content}\n${calls}` : calls
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
  }).join('\n\n')
}
