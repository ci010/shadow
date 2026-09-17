import type { ChatMessage, LLMProviderOptions } from '../providers/provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'

export interface PromptCapture {
  requestId: string
  capturedAt: string
  projectId?: string
  sessionId: string
  physicalSessionId: string
  turnId: string
  iteration: number
  provider: string
  source: 'captured'
  boundary: 'provider-input'
  scope: 'system-messages-and-tools'
  options: Omit<LLMProviderOptions, 'signal'>
  messageCount: number
  payloadBytes: number
  payload: 'complete' | 'omitted-size-limit'
  systemMessages?: ChatMessage[]
  tools?: ToolDefinition[]
}

/** Project-local, opt-in memory only. Never records headers or conversation bodies. */
export class PromptCaptureStore {
  private entries: PromptCapture[] = []
  private bytes = 0

  constructor(
    readonly projectId: string | undefined,
    private readonly maxEntries = 20,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('Prompt capture limits must be positive safe integers')
    }
  }

  capture(
    context: Pick<PromptCapture, 'projectId' | 'sessionId' | 'physicalSessionId' | 'turnId' | 'iteration' | 'provider'>,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): string {
    if (context.projectId !== this.projectId) throw new Error('Prompt capture project binding mismatch')
    const systemMessages = messages.filter(message => message.role === 'system').map(message => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    }))
    const payloadBytes = Buffer.byteLength(JSON.stringify({ systemMessages, tools }))
    const complete = payloadBytes <= this.maxBytes
    const entry: PromptCapture = {
      ...context,
      requestId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      source: 'captured',
      boundary: 'provider-input',
      scope: 'system-messages-and-tools',
      options: structuredClone({
        model: options.model,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        thinking: options.thinking,
        reasoningEffort: options.reasoningEffort,
      }),
      messageCount: messages.length,
      payloadBytes,
      payload: complete ? 'complete' : 'omitted-size-limit',
      ...(complete ? structuredClone({ systemMessages, tools }) : {}),
    }
    const retainedBytes = complete ? payloadBytes : 0
    while (this.entries.length && (this.entries.length >= this.maxEntries || this.bytes + retainedBytes > this.maxBytes)) {
      const removed = this.entries.shift()!
      if (removed.payload === 'complete') this.bytes -= removed.payloadBytes
    }
    this.entries.push(entry)
    this.bytes += retainedBytes
    return entry.requestId
  }

  list(sessionId: string): PromptCapture[] {
    return structuredClone(this.entries.filter(entry => entry.sessionId === sessionId).reverse())
  }

  deleteSession(sessionId: string): void {
    this.entries = this.entries.filter(entry => entry.sessionId !== sessionId)
    this.bytes = this.entries.reduce((sum, entry) => sum + (entry.payload === 'complete' ? entry.payloadBytes : 0), 0)
  }

  clear(): void {
    this.entries = []
    this.bytes = 0
  }
}

export function createPromptCaptureStore(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): PromptCaptureStore | undefined {
  const flag = env.SHADOW_DEBUG_PROMPTS
  if (flag === undefined || flag === '0') return undefined
  if (flag !== '1') throw new Error('SHADOW_DEBUG_PROMPTS must be 0 or 1')
  if (env.NODE_ENV === 'production') throw new Error('Prompt capture is unavailable in production')
  return new PromptCaptureStore(projectId)
}
