import { withProviderRetry, providerRetryScope } from './retry.ts'
import type { ReasoningEffort, ThinkingConfig } from '../agent/llm-config.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import { spanAttributes } from '../otel/tracing.ts'
import {
  ProviderHttpError,
  providerTransportFailure,
  TokenLimitExceededError,
  type ChatMessage,
  type LLMResponse,
  type ResponsesOutputAnnotation,
  type ResponsesOutputItem,
  type ResponsesProviderState,
} from './provider.ts'

type ObjectValue = Record<string, unknown>
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function invalid(detail: string): never {
  throw new Error(`Invalid Responses payload: ${detail}`)
}
function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return invalid('malformed JSON') }
}

function reasoningItem(value: unknown): ResponsesProviderState['reasoning'][number] | undefined {
  if (!object(value) || value.type !== 'reasoning' ||
    typeof value.encrypted_content !== 'string' || !value.encrypted_content ||
    !Array.isArray(value.summary) || !value.summary.every((part) =>
      object(part) && part.type === 'summary_text' && typeof part.text === 'string')) return
  return {
    type: 'reasoning',
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    encrypted_content: value.encrypted_content,
    summary: value.summary.map((part) => ({ type: 'summary_text', text: part.text as string })),
  }
}

function text(value: unknown, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value)) invalid('invalid output string')
  return value
}
function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('invalid annotation index')
  return value
}
function annotation(value: unknown): ResponsesOutputAnnotation {
  if (!object(value)) invalid('invalid annotation')
  switch (value.type) {
    case 'file_citation':
      return { type: value.type, file_id: text(value.file_id, true), filename: text(value.filename), index: index(value.index) }
    case 'file_path':
      return { type: value.type, file_id: text(value.file_id, true), index: index(value.index) }
    case 'url_citation':
      return {
        type: value.type, start_index: index(value.start_index), end_index: index(value.end_index),
        url: text(value.url), title: text(value.title),
      }
    case 'container_file_citation':
      return {
        type: value.type, container_id: text(value.container_id, true), file_id: text(value.file_id, true),
        filename: text(value.filename), start_index: index(value.start_index), end_index: index(value.end_index),
      }
    default: return invalid('unsupported annotation')
  }
}

function outputItem(value: unknown, provider?: string): ResponsesOutputItem {
  if (!object(value)) invalid('invalid output item')
  if (value.status !== undefined && value.status !== 'completed') invalid('output item is not completed')
  const id = value.id === undefined ? {} : { id: text(value.id, true) }
  const status = value.status === undefined ? {} : { status: 'completed' as const }
  if (value.type === 'reasoning') {
    if (provider === 'deepseek') {
      if (!Array.isArray(value.content)) invalid('invalid DeepSeek reasoning content')
      return {
        type: 'reasoning', ...id, ...status, summary: [],
        content: value.content.map((part) => {
          if (!object(part) || part.type !== 'reasoning_text') invalid('invalid DeepSeek reasoning content')
          return { type: 'reasoning_text', text: text(part.text) }
        }),
      }
    }
    if (!Array.isArray(value.summary)) invalid('invalid reasoning summary')
    return {
      type: 'reasoning', ...id, ...status,
      ...(value.encrypted_content === undefined ? {} : {
        encrypted_content: value.encrypted_content === null ? null : text(value.encrypted_content, true),
      }),
      summary: value.summary.map((part) => {
        if (!object(part) || part.type !== 'summary_text') invalid('invalid reasoning summary')
        return { type: 'summary_text', text: text(part.text) }
      }),
    }
  }
  if (value.type === 'function_call') {
    const args = text(value.arguments)
    if (!object(parseJson(args))) invalid('function arguments must be a JSON object')
    return {
      type: 'function_call', ...id, ...status, call_id: text(value.call_id, true),
      name: text(value.name, true), arguments: args,
    }
  }
  if (value.type === 'message') {
    if (value.role !== 'assistant' || value.status !== 'completed' || !Array.isArray(value.content)) invalid('invalid output message')
    if (value.phase !== undefined && value.phase !== null &&
      value.phase !== 'commentary' && value.phase !== 'final_answer') invalid('invalid assistant phase')
    return {
      type: 'message', id: text(value.id, true), role: 'assistant', status: 'completed',
      ...(value.phase === undefined ? {} : {
        phase: value.phase as 'commentary' | 'final_answer' | null,
      }),
      content: value.content.map((part) => {
        if (!object(part)) invalid('invalid message content')
        if (part.type === 'refusal') return { type: 'refusal', refusal: text(part.refusal) }
        if (part.type !== 'output_text' || (part.annotations !== undefined && !Array.isArray(part.annotations))) invalid('invalid output text')
        return { type: 'output_text', text: text(part.text), annotations: (part.annotations ?? []).map(annotation) }
      }),
    }
  }
  return invalid('unsupported output item')
}

function input(messages: ChatMessage[], provider: string | undefined, model: string): unknown[] {
  const result: unknown[] = []
  for (const message of messages) {
    const state: unknown = message.provider_state
    if (message.role === 'assistant' && (provider === 'copilot' || provider === 'deepseek') &&
      object(state) && state.provider === provider && state.model === model) {
      if (state.outputItems !== undefined) {
        if (!Array.isArray(state.outputItems)) invalid('invalid provider continuation items')
        result.push(...state.outputItems.map(item => outputItem(item, provider)))
        continue
      }
      if (provider === 'deepseek') invalid('missing DeepSeek continuation items')
      if (!Array.isArray(state.reasoning)) invalid('invalid provider reasoning state')
      for (const value of state.reasoning) {
        const item = reasoningItem(value)
        if (!item) invalid('invalid provider reasoning state')
        result.push(item)
      }
    }
    if (message.role === 'assistant' && provider === 'deepseek') {
      // Legacy Chat Completions records have no Responses items to replay.
      const reasoning = state == null ? message.reasoning_content ?? '' : ''
      result.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] })
    }
    const parts = typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content ?? []
    const content = parts.map((part) => {
      if (part.type === 'image_url') {
        if (message.role === 'system' || message.role === 'assistant') {
          throw new Error('Responses image history requires a user or tool message')
        }
        return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto' }
      }
      return { type: 'input_text', text: part.text }
    })
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Responses tool result is missing its call ID')
      result.push({
        type: 'function_call_output', call_id: message.tool_call_id,
        output: message.content == null ? '' : typeof message.content === 'string' ? message.content : content,
      })
      continue
    }
    if (content.length > 0 || message.role !== 'assistant') {
      // Easy-input assistant messages do not require the output IDs absent from ChatMessage.
      result.push({
        type: 'message', role: message.role,
        content: message.role === 'assistant' ? content.map((part) => part.text ?? '').join('') : content,
      })
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        result.push({
          type: 'function_call', call_id: call.id,
          name: call.function.name, arguments: call.function.arguments,
        })
      }
    }
  }
  return result
}

function failure(value: unknown, status?: number, retryAfter?: string | null): never {
  const payload = object(value) ? value : {}
  const error = object(payload.error) ? payload.error : payload
  const incomplete = object(payload.incomplete_details) ? payload.incomplete_details : {}
  const rawCode = error.code || error.type || incomplete.reason
  const code = typeof rawCode === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(rawCode) ? rawCode : undefined
  // Never echo the server's message/body: it can contain prompt data or credentials.
  const state = ['failed', 'incomplete', 'cancelled'].includes(String(payload.status))
    ? String(payload.status) : 'failed'
  const message = `Responses request ${state}${status ? ` (HTTP ${status})` : ''}${code ? `: ${code}` : ''}`
  if (code && ['model_max_prompt_tokens_exceeded', 'context_length_exceeded',
    'context_window_exceeded', 'max_prompt_tokens_exceeded', 'input_token_limit_exceeded'].includes(code)) {
    throw new TokenLimitExceededError(message)
  }
  if (status !== undefined) throw new ProviderHttpError(status, message, code, { retryAfter, rejectedRequest: true })
  throw new Error(message)
}

async function* chunks(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!response.body) return invalid('missing response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const onAbort = () => {
    rejectAbort(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const next = await Promise.race([reader.read(), aborted])
      signal?.throwIfAborted()
      if (next.done) break
      yield decoder.decode(next.value, { stream: true })
    }
    yield decoder.decode()
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Do not await cancellation: custom/network stream cleanup itself can stall.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function streamResponse(response: Response, signal?: AbortSignal): Promise<ObjectValue> {
  const items = new Map<number, ObjectValue>()
  const pendingReasoning = new Set<number>()
  let buffer = ''
  let eventName = ''
  let data: string[] = []
  let completed: ObjectValue | undefined
  const dispatch = () => {
    if (data.length === 0) { eventName = ''; return }
    const text = data.join('\n')
    data = []
    const name = eventName
    eventName = ''
    if (text === '[DONE]') {
      if (!completed) invalid('stream ended before response.completed')
      return
    }
    const event = parseJson(text)
    if (!object(event)) invalid('invalid stream event')
    const type = event.type ?? name
    if (type === 'error' || type === 'response.error' || type === 'response.failed' || type === 'response.incomplete' ||
      type === 'response.cancelled') failure(event.response ?? event)
    if (type === 'response.completed') {
      if (!object(event.response) || event.response.status !== 'completed') invalid('missing completed response status')
      if (event.response.output === undefined && pendingReasoning.size) invalid('missing completed reasoning item')
      completed = {
        ...event.response,
        output: event.response.output === undefined
          ? [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
          : event.response.output,
      }
      return
    }
    const index = event.output_index
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (!object(event.item)) invalid('missing output item')
      const item = { ...event.item }
      // Added reasoning can contain unfinished ciphertext; only done/completed items are replayable.
      if (type === 'response.output_item.added' && item.type === 'reasoning') pendingReasoning.add(index)
      if (type === 'response.output_item.done') pendingReasoning.delete(index)
      items.set(index, item)
      return
    }
    const item = items.get(index)
    if (!item) return
    if (type === 'response.function_call_arguments.delta') {
      if (typeof event.delta !== 'string') invalid('invalid function argument delta')
      item.arguments = String(item.arguments ?? '') + event.delta
    } else if (type === 'response.function_call_arguments.done') {
      if (typeof event.arguments !== 'string') invalid('invalid function arguments')
      item.arguments = event.arguments
    } else if (typeof type === 'string') {
      const summary = type.startsWith('response.reasoning_summary_')
      const partIndex = summary ? event.summary_index : event.content_index
      if (typeof partIndex !== 'number' || !Number.isInteger(partIndex) || partIndex < 0) return
      const key = summary ? 'summary' : 'content'
      const parts = Array.isArray(item[key]) ? item[key] : []
      item[key] = parts
      if (type.endsWith('_part.added') || type.endsWith('_part.done')) {
        if (!object(event.part)) invalid('invalid content part')
        parts[partIndex] = event.part
      } else if (/\.(delta|done)$/.test(type) &&
        (summary || type.startsWith('response.reasoning_text.') || type.startsWith('response.output_text.') || type.startsWith('response.refusal.'))) {
        const refusal = type.startsWith('response.refusal.')
        const reasoningText = type.startsWith('response.reasoning_text.')
        const field = refusal ? 'refusal' : 'text'
        const part = parts[partIndex] ??= { type: summary ? 'summary_text' : reasoningText ? 'reasoning_text' : refusal ? 'refusal' : 'output_text' }
        if (!object(part)) invalid('invalid text content part')
        const value = type.endsWith('.delta') ? event.delta : event[field]
        if (typeof value !== 'string') invalid('invalid text delta')
        part[field] = type.endsWith('.delta') ? String(part[field] ?? '') + value : value
      }
    }
  }
  for await (const chunk of chunks(response, signal)) {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') dispatch()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) eventName = line.slice(6).trim()
      if (completed) return completed
    }
  }
  invalid('stream ended before response.completed')
}

function finalResponse(value: unknown, model: string, provider?: string): LLMResponse {
  if (!object(value)) invalid('expected a response object')
  if (value.status !== 'completed') failure(value)
  if (!Array.isArray(value.output)) invalid('missing output items')
  const content: string[] = []
  const reasoning: string[] = []
  const state: ResponsesProviderState['reasoning'] = []
  const toolCalls: LLMResponse['toolCalls'] = []
  const outputItems = value.output.map(item => outputItem(item, provider))
  for (const item of outputItems) {
    if (item.type === 'function_call') {
      const args = parseJson(item.arguments)
      if (!object(args)) invalid('function arguments must be a JSON object')
      toolCalls.push({ id: item.call_id, name: item.name, arguments: args })
    } else if (item.type === 'message') {
      for (const part of item.content) {
        content.push(part.type === 'output_text' ? part.text : part.refusal)
      }
    } else if (item.type === 'reasoning') {
      for (const part of provider === 'deepseek' ? item.content ?? [] : item.summary) reasoning.push(part.text)
      const opaque = reasoningItem(item)
      if (opaque) state.push(opaque)
    }
  }
  let usage: LLMResponse['usage']
  if (value.usage != null) {
    const u = value.usage
    if (!object(u) || ![u.input_tokens, u.output_tokens, u.total_tokens].every((n) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0)) invalid('invalid usage')
    usage = {
      promptTokens: u.input_tokens as number, completionTokens: u.output_tokens as number,
      totalTokens: u.total_tokens as number,
      ...(object(u.input_tokens_details) && u.input_tokens_details.cached_tokens != null
        ? { cachedTokens: u.input_tokens_details.cached_tokens as number } : {}),
    }
  }
  return {
    content: content.length ? content.join('\n') : null,
    reasoningContent: provider === 'deepseek' && reasoning.length ? reasoning.join('\n') : null,
    reasoningText: provider !== 'deepseek' && reasoning.length ? reasoning.join('\n') : null,
    toolCalls, model: typeof value.model === 'string' ? value.model : model, usage,
    ...(provider === 'copilot' || provider === 'deepseek' ? { providerState: { provider, model, reasoning: state, outputItems } } : {}),
  }
}

/** Stateless HTTP Responses transport; only terminal completed responses reach the agent loop. */
export async function openaiResponses(params: {
  url: string
  apiKey: string
  headers?: Record<string, string>
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  providerName?: string
  signal?: AbortSignal
  thinking?: ThinkingConfig
  reasoningEffort?: ReasoningEffort
}): Promise<LLMResponse> {
  params.signal?.throwIfAborted()
  spanAttributes({
    'llm.provider': params.providerName ?? 'unknown', 'llm.model': params.model,
    'llm.input_messages': params.messages.length, 'llm.input_tools': params.tools.length,
  })
  const body: ObjectValue = {
    model: params.model, input: input(params.messages, params.providerName, params.model),
    stream: true, store: false,
  }
  if (params.providerName !== 'deepseek') body.include = ['reasoning.encrypted_content']
  if (params.maxTokens !== undefined) body.max_output_tokens = params.maxTokens
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.thinking?.type === 'disabled') {
    body.reasoning = { effort: 'none' }
  } else if (params.providerName === 'deepseek') {
    body.reasoning = { effort: params.reasoningEffort ?? 'high' }
  } else if (params.reasoningEffort) body.reasoning = { effort: params.reasoningEffort }
  if (params.tools.length) body.tools = params.tools.map(({ function: fn }) => ({
    type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters, strict: false,
  }))
  return withProviderRetry(async () => {
    const response = await fetch(params.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${params.apiKey}`, ...params.headers },
      body: JSON.stringify(body), signal: params.signal,
    }).catch(error => { throw providerTransportFailure(error, 'connect', params.signal) })
    if (!response.ok) {
      let text = ''
      if (response.body) {
        try {
          for await (const chunk of chunks(response, params.signal)) text += chunk
        } catch {
          params.signal?.throwIfAborted()
          failure(undefined, response.status, response.headers.get('retry-after'))
        }
      }
      let error: unknown
      try { error = JSON.parse(text) } catch { /* HTTP status is still authoritative. */ }
      failure(error, response.status, response.headers.get('retry-after'))
    }
    let result: unknown
    try {
      if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        result = await streamResponse(response, params.signal)
      } else {
        let text = ''
        for await (const chunk of chunks(response, params.signal)) text += chunk
        result = parseJson(text)
      }
    } catch (error) {
      throw providerTransportFailure(error, 'response', params.signal)
    }
    params.signal?.throwIfAborted()
    return finalResponse(result, params.model, params.providerName)
  }, params.signal, { scope: providerRetryScope(params.url, params.apiKey), provider: params.providerName, model: params.model })
}
