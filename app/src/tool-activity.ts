import { isRecord } from './projects-sidebar.ts'

export interface ToolActivityMessage {
  event?: string
  content: string
  toolName?: string
  toolCallId?: string
  toolCall?: { name: string; arguments: Record<string, unknown> }
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface LineChanges {
  added: number
  removed: number
}

export interface ToolActivity {
  index: number
  name: string
  title: string
  summary: string
  icon: 'write' | 'read' | 'search' | 'exec' | 'tool'
  arguments: string
  result?: string
  usage?: ToolActivityMessage['usage']
  file?: string
  changes?: LineChanges
  failed: boolean
}

export interface ToolActivityBatch {
  end: number
  entries: ToolActivity[]
  files: number
  changes?: LineChanges
  incomplete: boolean
}

export function parseToolCall(message: ToolActivityMessage): { name: string; args: Record<string, unknown>; raw: string } {
  if (message.toolCall) return { name: message.toolCall.name, args: message.toolCall.arguments, raw: JSON.stringify(message.toolCall.arguments, null, 2) }
  const match = /^([^(\n]+)\(([\s\S]*)\)$/.exec(message.content)
  if (match) {
    try {
      const args: unknown = JSON.parse(match[2])
      if (isRecord(args)) return { name: match[1], args, raw: JSON.stringify(args, null, 2) }
    } catch { /* Legacy display text is not always JSON. Keep it visible. */ }
  }
  return { name: message.toolName || match?.[1] || message.content || 'Tool', args: {}, raw: match?.[2] ?? '' }
}

export function parseLineChanges(result: string): LineChanges | undefined {
  const lines = result.split('\n', 3)
  if (!/^Success: (?:write|edit|append) /.test(lines[0])
    || !/^UTF-8 bytes written: \d+; /.test(lines[1] ?? '')) return
  const match = /^Line changes: \+(\d+) -(\d+)\.$/.exec(lines[2] ?? '')
  if (!match) return
  const added = Number(match[1])
  const removed = Number(match[2])
  if (Number.isSafeInteger(added) && Number.isSafeInteger(removed)) return { added, removed }
}

function activity(message: ToolActivityMessage, index: number, result?: ToolActivityMessage): ToolActivity {
  const call = parseToolCall(message)
  let { name, args } = call
  if (name === 'invoke_tool' && typeof args.name === 'string' && isRecord(args.args)) {
    name = args.name
    args = args.args
  }
  const path = typeof args.path === 'string' ? args.path : ''
  const basename = path.split(/[\\/]/).filter(Boolean).at(-1) || path
  const write = name === 'write'
  const read = /^(read|read_file|view)$/.test(name)
  const search = /^(search|grep|rg|glob|find_files)$/.test(name)
  const exec = /^(exec|shell|bash|powershell)$/.test(name)
  const description = typeof args.description === 'string' ? args.description : ''
  const title = write ? `${args.match !== undefined ? 'Edit' : String(args.flag ?? '').includes('a') ? 'Append' : 'Write'} ${basename || 'file'}`
    : read ? `View ${basename || 'file'}` : search ? 'Search files' : description || name
  const summary = write || read ? (path === basename ? '' : path)
    : typeof args.command === 'string' ? args.command
    : typeof args.pattern === 'string' ? args.pattern
    : Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')
  const text = result?.content
  const success = write && text !== undefined && /^Success: (?:write|edit|append) /.test(text)
  return {
    index, name, title, summary, arguments: call.raw, result: text, usage: result?.usage,
    icon: write ? 'write' : read ? 'read' : search ? 'search' : exec ? 'exec' : 'tool',
    file: success && path ? path : undefined,
    changes: success ? parseLineChanges(text) : undefined,
    failed: text !== undefined && /^(?:Error:|ERROR\b|Failed\b)/i.test(text.trimStart()),
  }
}

export function pairToolResults(messages: readonly ToolActivityMessage[]): Map<number, number> {
  const pairs = new Map<number, number>()
  const pending: number[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.event === 'tool_call') pending.push(index)
    if (message.event !== 'tool_call' && message.event !== 'tool_result') {
      for (let position = pending.length - 1; position >= 0; position--) {
        if (!messages[pending[position]].toolCallId) pending.splice(position, 1)
      }
    }
    if (message.event !== 'tool_result') continue
    const position = pending.findIndex(callIndex => message.toolCallId
      ? messages[callIndex].toolCallId === message.toolCallId
      : !messages[callIndex].toolCallId)
    if (position < 0) continue
    const [callIndex] = pending.splice(position, 1)
    pairs.set(callIndex, index)
  }
  return pairs
}

/** Prose, events, and inline executions separate tool groups without losing ID pairing. */
export function groupToolActivity(messages: readonly ToolActivityMessage[], excluded: ReadonlySet<number> = new Set()): Map<number, ToolActivityBatch> {
  const groups = new Map<number, ToolActivityBatch>()
  const pairs = pairToolResults(messages)
  const pairedResults = new Set(pairs.values())
  for (let index = 0; index < messages.length;) {
    if (excluded.has(index) || !['tool_call', 'tool_result'].includes(messages[index].event ?? '')) { index++; continue }
    const start = index
    const entries: ToolActivity[] = []
    while (index < messages.length && !excluded.has(index) && ['tool_call', 'tool_result'].includes(messages[index].event ?? '')) {
      const message = messages[index]
      if (message.event === 'tool_call') {
        const resultIndex = pairs.get(index)
        const result = resultIndex === undefined ? undefined : messages[resultIndex]
        entries.push(activity(message, index, result))
        index++
      } else if (pairedResults.has(index)) {
        index++
      } else {
        entries.push({ index, name: message.toolName || 'Tool', title: `${message.toolName || 'Tool'} result`,
          summary: '', arguments: '', result: message.content, icon: 'tool', usage: message.usage,
          failed: /^Error:/i.test(message.content.trimStart()) })
        index++
      }
    }
    const changes = entries.filter(entry => entry.changes).map(entry => entry.changes!)
    if (entries.length) groups.set(start, {
      end: index,
      entries,
      files: new Set(entries.flatMap(entry => entry.file ? [entry.file] : [])).size,
      changes: changes.length ? changes.reduce((sum, next) => ({ added: sum.added + next.added, removed: sum.removed + next.removed }), { added: 0, removed: 0 }) : undefined,
      incomplete: entries.some(entry => !!entry.file && !entry.changes),
    })
  }
  return groups
}
