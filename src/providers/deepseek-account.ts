import type { ChatMessage, LLMProvider, LLMProviderOptions, LLMResponse, ToolCall } from './provider.ts'
import { ProviderHttpError } from './provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import { DEEPSEEK_INFERENCE, type DeepSeekAccountAuth } from './deepseek-account-auth.ts'

/** Text/tool Messages subset. Images fail explicitly rather than being silently lost. */
export function deepseekAccountRequest(messages: ChatMessage[], tools: ToolDefinition[], options: LLMProviderOptions): Record<string, unknown> {
  const text = (content: ChatMessage['content']): string => {
    if (!Array.isArray(content)) return content ?? ''
    if (content.some(part => part.type !== 'text')) throw new Error('DeepSeek Account currently supports text and tools only')
    return content.map(part => part.type === 'text' ? part.text : '').join('')
  }
  const converted: Array<{ role: string; content: Record<string, unknown>[] }> = []
  const system: string[] = []
  const pending = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'system') { system.push(text(msg.content)); continue }
    const content: Record<string, unknown>[] = []
    if (msg.role === 'tool') {
      if (!msg.tool_call_id || !pending.delete(msg.tool_call_id)) throw new Error('DeepSeek Account tool result has no matching call')
      content.push({ type: 'tool_result', tool_use_id: msg.tool_call_id, content: text(msg.content) })
    } else {
      if (pending.size) throw new Error('DeepSeek Account tool calls need immediate results')
      if (msg.role === 'assistant' && msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content })
      const value = text(msg.content)
      if (value) content.push({ type: 'text', text: value })
      for (const call of msg.tool_calls ?? []) {
        const input: unknown = JSON.parse(call.function.arguments)
        if (!input || typeof input !== 'object' || Array.isArray(input) || pending.has(call.id)) throw new Error('Invalid DeepSeek Account tool arguments')
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
        pending.add(call.id)
      }
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    if (content.length) {
      const previous = converted.at(-1)
      if (previous?.role === role) previous.content.push(...content)
      else converted.push({ role, content })
    }
  }
  if (pending.size) throw new Error('DeepSeek Account history ends with unresolved tools')
  // Shadow's shared default is medium; map its aliases just like the API-key route.
  const effort = options.reasoningEffort === 'medium' || options.reasoningEffort === 'xhigh'
    ? 'high' : options.reasoningEffort ?? 'high'
  if (!['low', 'high', 'max'].includes(effort)) throw new Error(`DeepSeek Account does not support reasoning effort ${effort}`)
  const thinking = options.thinking?.type ?? 'enabled'
  return {
    model: options.model, stream: true, messages: converted, max_tokens: options.maxTokens ?? 8192,
    thinking: { type: thinking }, ...(thinking === 'enabled' ? { output_config: { effort } } : {}),
    ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(tools.length ? { tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}),
  }
}

/** Strict, bounded SSE framing. CR/LF boundaries and arbitrary UTF-8 chunks are supported. */
async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frame: string[] = []
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      if (buffer.length > 4 * 1024 * 1024) throw new Error('DeepSeek Account SSE frame too large')
      let end: number
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === '\r' && end === buffer.length - 1 && !next.done) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + (buffer.slice(end, end + 2) === '\r\n' ? 2 : 1))
        if (line) { frame.push(line); if (frame.join('\n').length > 4 * 1024 * 1024) throw new Error('DeepSeek Account SSE frame too large'); continue }
        const data = frame.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        const eventName = frame.find(line => line.startsWith('event:'))?.slice(6).trim()
        frame = []
        if (!data) continue
        const event = JSON.parse(data) as Record<string, any>
        if (!event || typeof event !== 'object' || typeof event.type !== 'string' || (eventName && eventName !== event.type)) throw new Error('Malformed DeepSeek Account SSE event')
        yield event
      }
      if (next.done) break
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel(); reader.releaseLock() }
}

export class DeepSeekAccountProvider implements LLMProvider {
  readonly name = 'deepseek-account'
  constructor(private readonly auth: DeepSeekAccountAuth, private readonly request: typeof fetch = fetch) {}
  listModels(): string[] { return ['deepseek-v4-flash', 'deepseek-v4-pro'] }
  async listModelInfos() { return this.listModels().map(id => ({ id, vision: false, contextWindow: 1_000_000, supportedEndpoints: ['/v1/messages'], reasoningEfforts: ['low', 'high', 'max'] })) }
  async chat(messages: ChatMessage[], tools: ToolDefinition[], options: LLMProviderOptions): Promise<LLMResponse> {
    const endpoint = `${DEEPSEEK_INFERENCE}/v1/messages`
    const grant = this.auth.resolve(endpoint)
    const signal = AbortSignal.any([grant.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(300_000)])
    signal.throwIfAborted()
    const response = await this.request(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', 'anthropic-version': '2023-06-01', 'x-dsh-auth-token': grant.token },
      redirect: 'error', body: JSON.stringify(deepseekAccountRequest(messages, tools, options)), signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) { try { this.auth.reject(grant.token) } catch { /* Rejected token remains blocked in memory if removal fails. */ } }
      // Do not surface arbitrary server text, which may contain secrets.
      throw new ProviderHttpError(response.status, 'DeepSeek Account request rejected', response.status === 401 ? 'ACCOUNT_TOKEN_INVALID' : undefined, { provider: this.name })
    }
    if (!response.body) throw new Error('DeepSeek Account response body missing')
    const blocks = new Map<number, { type: string; text: string; id?: string; name?: string; input?: Record<string, unknown>; json: string; stopped: boolean }>()
    const result: LLMResponse = { content: null, toolCalls: [], model: options.model }
    let started = false
    let stopped = false
    let usage: Record<string, number> = {}
    for await (const event of events(response.body, signal)) {
      if (event.type === 'error') throw new Error('DeepSeek Account stream reported an error')
      if (event.type === 'ping') continue
      if (event.type === 'message_start') {
        if (started || !event.message || typeof event.message !== 'object') throw new Error('Malformed DeepSeek Account message start')
        started = true
        result.model = typeof event.message.model === 'string' ? event.message.model : options.model
        usage = { ...event.message.usage }
      } else if (event.type === 'content_block_start') {
        if (!started || !Number.isSafeInteger(event.index) || event.index < 0 || blocks.has(event.index) || blocks.size >= 1024) throw new Error('Malformed DeepSeek Account block start')
        const block = event.content_block
        if (!block || !['text', 'thinking', 'tool_use'].includes(block.type) || (block.type === 'text' && typeof block.text !== 'string') || (block.type === 'thinking' && typeof block.thinking !== 'string')) throw new Error('Unsupported DeepSeek Account content block')
        blocks.set(event.index, { type: block.type, text: block.text ?? block.thinking ?? '', id: block.id, name: block.name, input: block.input, json: '', stopped: false })
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index)
        if (!block || block.stopped) throw new Error('Malformed DeepSeek Account block delta')
        const delta = event.delta
        if (delta?.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') block.text += delta.text
        else if (delta?.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string') block.text += delta.thinking
        else if (delta?.type === 'input_json_delta' && block.type === 'tool_use' && typeof delta.partial_json === 'string') block.json += delta.partial_json
        else if (delta?.type !== 'signature_delta') throw new Error('Malformed DeepSeek Account delta')
        if (block.text.length + block.json.length > 8 * 1024 * 1024) throw new Error('DeepSeek Account output block too large')
      } else if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index)
        if (!block || block.stopped) throw new Error('Malformed DeepSeek Account block stop')
        block.stopped = true
      } else if (event.type === 'message_delta') {
        usage = { ...usage, ...event.usage }
      } else if (event.type === 'message_stop') {
        if (!started || [...blocks.values()].some(block => !block.stopped)) throw new Error('Incomplete DeepSeek Account message')
        stopped = true
        break
      } else throw new Error('Unsupported DeepSeek Account SSE event')
    }
    signal.throwIfAborted()
    if (!stopped) throw new Error('DeepSeek Account stream ended before message_stop')
    for (const [, block] of [...blocks].sort(([a], [b]) => a - b)) {
      if (block.type === 'text') result.content = (result.content ?? '') + block.text
      if (block.type === 'thinking') result.reasoningContent = (result.reasoningContent ?? '') + block.text
      if (block.type === 'tool_use') {
        const input: unknown = block.json ? JSON.parse(block.json) : block.input
        if (!block.id || !block.name || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Malformed DeepSeek Account tool call')
        result.toolCalls.push({ id: block.id, name: block.name, arguments: input } as ToolCall)
      }
    }
    const count = (name: string) => {
      if (usage[name] === undefined) return 0
      if (!Number.isSafeInteger(usage[name]) || usage[name]! < 0) throw new Error('Malformed DeepSeek Account usage')
      return usage[name]!
    }
    const cachedTokens = count('cache_read_input_tokens')
    const cacheWriteTokens = count('cache_creation_input_tokens')
    const promptTokens = count('input_tokens') + cachedTokens + cacheWriteTokens
    const completionTokens = count('output_tokens')
    result.usage = { costIncomplete: true, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens, cacheWriteTokens }
    return result
  }
}
