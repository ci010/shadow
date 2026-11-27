import type { ChatMessage, LLMResponse, ToolCall } from '../../providers/provider.ts'
import { CompactDraft, COMPACT_DRAFT_PATH } from './current-context.ts'
import type { HandoffContext } from './manager.ts'

const MAX_INFERENCES = 8
const MAX_TOOL_CALLS = 16
const MAX_TOOL_ARGUMENT_CHARS = 32_000
const MAX_READ_CHARS = 10_000
const TOTAL_READ_CHARS = 28_000
const MAX_PAGE_LINES = 200

export interface CompactReadArgs { path: string; offset?: number; limit?: number }

interface DraftRunnerOptions {
  messages: ChatMessage[]
  signal: AbortSignal
  assertCurrent(): void
  infer(messages: ChatMessage[]): Promise<LLMResponse>
  read(args: CompactReadArgs): Promise<string>
}

/** Request-local transcript and draft. Never enter ordinary turn dispatch or persist tool pairs. */
export async function runCompactDraft(options: DraftRunnerOptions): Promise<HandoffContext | undefined> {
  const { signal, assertCurrent } = options
  const messages = [...options.messages]
  const draft = new CompactDraft()
  let toolCalls = 0
  let remainingReadChars = TOTAL_READ_CHARS
  for (let iteration = 0; iteration < MAX_INFERENCES; iteration++) {
    signal.throwIfAborted()
    assertCurrent()
    const submitOnly = iteration === MAX_INFERENCES - 1 || toolCalls === MAX_TOOL_CALLS
    const response = await options.infer(messages.slice())
    signal.throwIfAborted()
    assertCurrent()
    const calls = response.toolCalls
    if (!calls.length || (submitOnly && calls.length !== 1)) return undefined
    // Reserve room for one final submit even when draft work exhausted the call budget.
    if (!submitOnly && (toolCalls += calls.length) > MAX_TOOL_CALLS) return undefined
    const encoded = calls.map(call => JSON.stringify(call.arguments))
    if (encoded.reduce((length, args) => length + (args?.length ?? 0), 0) > MAX_TOOL_ARGUMENT_CHARS ||
      new Set(calls.map(call => call.id)).size !== calls.length) return undefined
    messages.push({ role: 'assistant', content: response.content,
      reasoning_content: response.reasoningContent, reasoning_text: response.reasoningText,
      provider_state: response.providerState,
      tool_calls: calls.map((call, index) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: encoded[index] ?? '{}' } })),
    })
    for (const call of calls) {
      signal.throwIfAborted()
      let content: string
      try {
        const args = checkedArgs(call)
        if (call.name === 'invoke_tool') {
          if (!onlyKeys(args, ['name', 'args']) || args.name !== 'handoff_submit' || !args.args ||
            typeof args.args !== 'object' || Array.isArray(args.args) || Object.keys(args.args).length || calls.length !== 1) {
            throw new Error('Compact does not dispatch regular dynamic tools. Call only invoke_tool({name:"handoff_submit", args:{}}), by itself after writing the draft.')
          }
          return draft.finalize()
        }
        if (submitOnly) throw new Error('Draft work budget is exhausted. Submit via invoke_tool({name:"handoff_submit", args:{}}).')
        if (call.name === 'write') {
          if (args.path !== COMPACT_DRAFT_PATH || !onlyKeys(args, ['path', 'content'])) {
            throw new Error(`Compact can only replace ${COMPACT_DRAFT_PATH}; no other write was executed.`)
          }
          if (typeof args.content !== 'string') {
            draft.replace('')
            throw new Error('Draft content must be a Markdown string. Write a new draft before submitting.')
          }
          draft.replace(args.content)
          content = `Draft staged at ${COMPACT_DRAFT_PATH}. Read or revise it, then call invoke_tool({name:"handoff_submit", args:{}}) by itself.`
        } else if (call.name === 'read') {
          const read = checkedRead(args)
          if (remainingReadChars <= 0) throw new Error('Compact read budget exhausted. Use the context already available to finish the draft.')
          const text = read.path === COMPACT_DRAFT_PATH
            ? readDraft(draft.content, read)
            : await options.read({ ...read, limit: read.limit ?? 80 })
          const cap = Math.min(remainingReadChars, MAX_READ_CHARS)
          content = text.length <= cap ? text : text.slice(0, cap) + '\n[Read clipped; use a narrower offset/limit if needed.]'
          remainingReadChars -= Math.min(text.length, cap)
        } else {
          throw new Error('Tool not executed: Compact only supports read, write of the handoff draft, and submit via invoke_tool({name:"handoff_submit", args:{}}).')
        }
      } catch (error) {
        signal.throwIfAborted()
        content = `Error: ${error instanceof Error ? error.message.slice(0, 500) : 'Compact tool failed.'}`
      }
      signal.throwIfAborted()
      assertCurrent()
      messages.push({ role: 'tool', name: call.name, tool_call_id: call.id, content })
    }
  }
  return undefined
}

function onlyKeys(args: Record<string, unknown>, keys: string[]) {
  return Object.keys(args).every(key => keys.includes(key))
}

function checkedArgs(call: ToolCall): Record<string, unknown> {
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('Tool arguments must be an object.')
  return call.arguments
}

function checkedRead(args: Record<string, unknown>): CompactReadArgs {
  if (!onlyKeys(args, ['path', 'offset', 'limit']) || typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4096) {
    throw new Error('Read requires path and accepts only offset and limit for line paging.')
  }
  for (const key of ['offset', 'limit']) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < 1)) throw new Error(`${key} must be a positive integer.`)
  }
  return { path: args.path, offset: args.offset as number | undefined,
    limit: args.limit === undefined ? undefined : Math.min(MAX_PAGE_LINES, Number(args.limit)) }
}

function readDraft(content: string, { offset, limit }: CompactReadArgs) {
  if (!content) return '(no draft staged yet)'
  if (offset === undefined && limit === undefined) return content
  const first = (offset ?? 1) - 1
  return content.split('\n').slice(first, limit === undefined ? undefined : first + limit).join('\n')
}
