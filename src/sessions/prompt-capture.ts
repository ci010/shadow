import { z } from 'zod'
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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
  scope: 'system-messages-and-tools' | 'learning-inference-messages-and-tools'
  options: Omit<LLMProviderOptions, 'signal'>
  messageCount: number
  payloadBytes: number
  payload: 'complete' | 'omitted-size-limit' | 'partial-media-omitted' | 'partial-fields-omitted'
  messages?: ChatMessage[]
  omissions?: Array<{ message: number; part?: number; reason: 'media-not-retained' | 'field-not-retained'; sha256?: string; field?: string }>
  expiresAt?: string
  systemMessages?: ChatMessage[]
  tools?: ToolDefinition[]
}

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.null(), z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image_url'), displayOnly: z.boolean().optional(), image_url: z.object({ url: z.string(), detail: z.enum(['auto', 'low', 'high']).optional() }).strict() }).strict(),
  ]))]),
  name: z.string().optional(), tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }).strict() }).strict()).optional(),
  reasoning_content: z.string().nullable().optional(), reasoning_text: z.string().nullable().optional(),
}).strict()
const entrySchema = z.object({
  requestId: z.string(), capturedAt: z.string(), expiresAt: z.string(), projectId: z.string(),
  sessionId: z.string(), physicalSessionId: z.string(), turnId: z.string(), iteration: z.number().int().nonnegative(), provider: z.string(),
  source: z.literal('captured'), boundary: z.literal('provider-input'), scope: z.literal('learning-inference-messages-and-tools'),
  options: z.object({ model: z.string(), maxTokens: z.number().optional(), temperature: z.number().optional(),
    thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }).strict(),
  messageCount: z.number().int().nonnegative(), payloadBytes: z.number().int().nonnegative(),
  payload: z.enum(['complete', 'partial-media-omitted', 'partial-fields-omitted', 'omitted-size-limit']),
  messages: z.array(messageSchema).optional(),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) }).strict() }).strict()).optional(),
  omissions: z.array(z.union([
    z.object({ message: z.number().int().nonnegative(), part: z.number().int().nonnegative(), reason: z.literal('media-not-retained'), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ message: z.number().int().nonnegative(), reason: z.literal('field-not-retained'), field: z.string() }).strict(),
  ])).optional(),
}).strict()

export interface LearningAuditOptions {
  directory: string
  ttlMs?: number
  now?: () => number
  debugEnabled?: boolean
}

/** Project-local diagnostics. Full conversation capture requires explicit learning audit admission. */
export class PromptCaptureStore {
  private entries: PromptCapture[] = []
  private bytes = 0
  private closed = false
  private readonly debug?: PromptCaptureStore
  private losses: Array<{ sessionId: string; reason: 'expired' | 'capacity'; at: string }> = []
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly file?: string

  private persist(): void {
    if (!this.file || this.closed) return
    const data = JSON.stringify({ version: 1, projectId: this.projectId,
      entries: this.entries.filter(e => e.scope === 'learning-inference-messages-and-tools'), losses: this.losses })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, data, { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  private removeFirst(reason: 'expired' | 'capacity', index = 0): void {
    const [entry] = this.entries.splice(index, 1)
    this.losses.push({ sessionId: entry!.sessionId, reason, at: new Date(this.now()).toISOString() })
    this.losses = this.losses.slice(-1000)
    this.bytes = this.entries.reduce((n, e) => n + (e.payload === 'omitted-size-limit' ? 0 : e.payloadBytes), 0)
  }

  private prune(): void {
    const losses = this.losses.filter(e => Date.parse(e.at) + this.ttlMs > this.now())
    let changed = losses.length !== this.losses.length
    this.losses = losses
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.expiresAt && Date.parse(this.entries[i]!.expiresAt!) <= this.now()) {
        this.removeFirst('expired', i); changed = true
      }
    }
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
      this.removeFirst('capacity'); changed = true
    }
    if (changed) this.persist()
  }

  status(sessionId: string) {
    this.prune()
    return { learningAuditEnabled: !!this.audit, debugEnabled: this.audit?.debugEnabled ?? true,
      boundary: 'provider.chat-input-not-adapter-wire', ttlMs: this.audit ? this.ttlMs : undefined,
      maxEntries: this.maxEntries, maxBytes: this.maxBytes, debugLimits: { maxEntries: 20, maxBytes: 16 * 1024 * 1024 }, persistent: !!this.file,
      retained: this.entries.filter(e => e.sessionId === sessionId).length + (this.debug?.list(sessionId).length ?? 0),
      recentLosses: this.losses.filter(e => e.sessionId === sessionId),
      missing: 'Not captured, disabled at request time, excluded scoped learning, or outside bounded loss history; never substituted with preview.' }
  }

  constructor(
    readonly projectId: string | undefined,
    private readonly maxEntries = 20,
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly audit?: LearningAuditOptions,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('Prompt capture limits must be positive safe integers')
    }
    this.now = audit?.now ?? Date.now
    this.ttlMs = audit?.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 7 * 24 * 60 * 60 * 1000) throw new RangeError('Learning audit TTL must be at most seven days')
    if (audit) {
      if (audit.debugEnabled !== false) this.debug = new PromptCaptureStore(projectId)
      mkdirSync(audit.directory, { recursive: true, mode: 0o700 })
      this.file = join(audit.directory, 'provider-input.json')
      try {
        if (statSync(this.file).size > this.maxBytes * 2 + 1024 * 1024) throw new Error('Learning audit file exceeds bounded storage')
        const saved = JSON.parse(readFileSync(this.file, 'utf8'))
        if (saved.version !== 1 || saved.projectId !== projectId || !Array.isArray(saved.entries) || !Array.isArray(saved.losses)) throw new Error('Invalid learning audit store')
        saved.entries = z.array(entrySchema).parse(saved.entries)
        if (saved.entries.some((e: PromptCapture) => !e || e.projectId !== projectId || e.scope !== 'learning-inference-messages-and-tools'
          || typeof e.sessionId !== 'string' || typeof e.requestId !== 'string'
          || !Number.isFinite(Date.parse(e.capturedAt)) || !Number.isFinite(Date.parse(e.expiresAt ?? ''))
          || Date.parse(e.expiresAt!) - Date.parse(e.capturedAt) > this.ttlMs
          || !Number.isSafeInteger(e.payloadBytes) || e.payloadBytes < 0
          || !['complete', 'partial-media-omitted', 'partial-fields-omitted', 'omitted-size-limit'].includes(e.payload))) throw new Error('Invalid learning audit entry')
        if (saved.losses.some((e: { sessionId: string; reason: string; at: string }) => !e || typeof e.sessionId !== 'string'
          || !['expired', 'capacity'].includes(e.reason) || !Number.isFinite(Date.parse(e.at)))) throw new Error('Invalid learning audit loss record')
        for (const entry of saved.entries as PromptCapture[]) {
          if (entry.payload === 'omitted-size-limit') {
            if (entry.messages || entry.tools || entry.omissions || entry.payloadBytes <= this.maxBytes) throw new Error('Invalid omitted payload')
          } else {
            if (!entry.messages || !entry.tools || !entry.omissions || entry.messages.length !== entry.messageCount) throw new Error('Invalid retained payload')
            const actual = Buffer.byteLength(JSON.stringify({ messages: entry.messages, tools: entry.tools, omissions: entry.omissions }))
            if (actual !== entry.payloadBytes || actual > this.maxBytes) throw new Error('Invalid payload byte count')
            const fields = entry.omissions.some(o => o.reason === 'field-not-retained')
            const media = entry.omissions.some(o => o.reason === 'media-not-retained')
            if (entry.payload !== (fields ? 'partial-fields-omitted' : media ? 'partial-media-omitted' : 'complete')) throw new Error('Invalid payload completeness')
            for (const omission of entry.omissions) {
              if (omission.message >= entry.messages.length) throw new Error('Invalid omission index')
              if (omission.reason === 'media-not-retained') {
                const content = entry.messages[omission.message]!.content
                if (!Array.isArray(content) || omission.part === undefined || content[omission.part]?.type !== 'image_url') throw new Error('Invalid media omission')
              }
            }
          }
        }
        this.entries = saved.entries
        this.losses = saved.losses.slice(-1000)
        this.bytes = this.entries.reduce((n, e) => n + (e.payload === 'omitted-size-limit' ? 0 : e.payloadBytes), 0)
        this.prune()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Learning audit store could not be loaded (invalid, inaccessible, or oversized file)')
      }
    }
  }

  capture(
    context: Pick<PromptCapture, 'projectId' | 'sessionId' | 'physicalSessionId' | 'turnId' | 'iteration' | 'provider'>,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
    learning = false,
  ): string | undefined {
    if (this.closed) throw new Error('Prompt capture store is closed')
    if (context.projectId !== this.projectId) throw new Error('Prompt capture project binding mismatch')
    this.prune()
    const full = learning && !!this.audit
    if (!full && this.audit) return this.debug?.capture(context, messages, tools, options)
    const omissions: NonNullable<PromptCapture['omissions']> = []
    const allowed = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning_content', 'reasoning_text'])
    const capturedMessages = full ? messages.map((message, index) => {
      const safe: Record<string, unknown> = {}
      for (const [field, value] of Object.entries(message)) {
        if (allowed.has(field)) safe[field] = structuredClone(value)
        else if (value !== undefined) omissions.push({ message: index, reason: 'field-not-retained', field })
      }
      return safe as unknown as ChatMessage
    }) : undefined
    capturedMessages?.forEach((message, index) => {
      if (Array.isArray(message.content)) message.content.forEach((part, partIndex) => {
        if (part.type === 'image_url') {
          omissions.push({ message: index, part: partIndex, reason: 'media-not-retained', sha256: createHash('sha256').update(part.image_url.url).digest('hex') })
          part.image_url.url = '[omitted: media-not-retained; see omissions sha256]'
        }
      })
    })
    const systemMessages = messages.filter(message => message.role === 'system').map(message => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    }))
    const contents = full ? { messages: capturedMessages, tools, omissions } : { systemMessages, tools }
    const payloadBytes = Buffer.byteLength(JSON.stringify(contents))
    const complete = payloadBytes <= this.maxBytes
    const entry: PromptCapture = {
      ...context,
      requestId: crypto.randomUUID(),
      capturedAt: new Date(this.now()).toISOString(),
      source: 'captured',
      boundary: 'provider-input',
      scope: full ? 'learning-inference-messages-and-tools' : 'system-messages-and-tools',
      ...(full ? { expiresAt: new Date(this.now() + this.ttlMs).toISOString() } : {}),
      options: structuredClone({
        model: options.model,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        thinking: options.thinking,
        reasoningEffort: options.reasoningEffort,
      }),
      messageCount: messages.length,
      payloadBytes,
      payload: complete ? (omissions.some(o => o.reason === 'field-not-retained') ? 'partial-fields-omitted' : omissions.length ? 'partial-media-omitted' : 'complete') : 'omitted-size-limit',
      ...(complete ? structuredClone(contents) : {}),
    }
    const retainedBytes = complete ? payloadBytes : 0
    while (this.entries.length && (this.entries.length >= this.maxEntries || this.bytes + retainedBytes > this.maxBytes)) {
      this.removeFirst('capacity')
    }
    this.entries.push(entry)
    this.bytes += retainedBytes
    if (full || this.audit) this.persist()
    return entry.requestId
  }

  list(sessionId: string): PromptCapture[] {
    this.prune()
    return structuredClone([...this.entries.filter(entry => entry.sessionId === sessionId).reverse(), ...(this.debug?.list(sessionId) ?? [])].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)))
  }

  deleteSession(sessionId: string): void {
    this.debug?.deleteSession(sessionId)
    this.entries = this.entries.filter(entry => entry.sessionId !== sessionId)
    this.bytes = this.entries.reduce((sum, entry) => sum + (entry.payload !== 'omitted-size-limit' ? entry.payloadBytes : 0), 0)
    this.losses = this.losses.filter(e => e.sessionId !== sessionId)
    this.persist()
  }

  close(): void {
    if (this.closed) return
    this.debug?.close()
    this.prune(); this.persist(); this.entries = []; this.bytes = 0; this.closed = true
  }

  clear(): void {
    this.debug?.clear()
    this.entries = []
    this.bytes = 0
    this.losses = []
    this.persist()
  }
}

export function createPromptCaptureStore(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
  auditDirectory?: string,
): PromptCaptureStore | undefined {
  const flag = env.SHADOW_DEBUG_PROMPTS
  if (flag !== undefined && flag !== '0' && flag !== '1') throw new Error('SHADOW_DEBUG_PROMPTS must be 0 or 1')
  const audit = env.SHADOW_LEARNING_AUDIT
  if (audit !== undefined && audit !== '0' && audit !== '1') throw new Error('SHADOW_LEARNING_AUDIT must be 0 or 1')
  if (flag === '1' && env.NODE_ENV === 'production') throw new Error('Prompt capture is unavailable in production')
  const debugEnabled = flag === '1' || (flag === undefined && env.NODE_ENV === 'development')
  if (audit === '1') {
    if (!auditDirectory) throw new Error('Learning audit requires a Project-private storage directory')
    return new PromptCaptureStore(projectId, 500, 32 * 1024 * 1024, { directory: auditDirectory, debugEnabled })
  }
  return debugEnabled ? new PromptCaptureStore(projectId) : undefined
}
