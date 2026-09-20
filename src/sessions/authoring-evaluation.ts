import { randomUUID } from 'node:crypto'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import { Bus } from '../bus/bus.ts'
import { createProjectScope } from '../projects/scope.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import type { SessionTools } from '../tools/registry.ts'
import { EphemeralSession } from './ephemeral-session.ts'
import { inputContext, type SessionInput, type SessionTurnFact } from './input.ts'
import type { SessionState, SessionStore, StoredMessage } from './session-store.ts'

export interface AuthoringEvaluationResult {
  status: 'completed' | 'failed' | 'cancelled'
  sessionId: string
  messages: ChatMessage[]
  result?: SessionTurnFact
  error?: string
  modelRounds: number
  llmExecuted: boolean
  syntheticTools: true
}

export interface AuthoringEvaluationOptions {
  workspace: string
  projectId: string
  provider: LLMProvider
  llm: LlmRuntimeConfig
  prompt: string
  /** Must be a fresh, fixture-only registry; never pass runtime session tools. */
  tools: SessionTools
  input: string
  signal: AbortSignal
  /** May shorten, but never extend, the two-minute execution deadline. */
  timeoutMs?: number
}

/** Full store contract, private to a single bounded evaluation. No normal history is loaded. */
class EvaluationStore implements SessionStore {
  private states = new Map<string, SessionState>()
  private logs = new Map<string, Record<string, unknown>[]>()
  private logBytes = new Map<string, number>()
  async init(): Promise<void> {}
  async getState(key: string) { return structuredClone(this.states.get(key) ?? null) }
  async saveState(key: string, state: SessionState) { this.states.set(key, structuredClone(state)) }
  async listAllStates() { return structuredClone(Object.fromEntries(this.states)) }
  async listSessions() { return structuredClone([...this.states.values()]) }
  async deleteState(key: string) { this.states.delete(key) }
  async *readSessionLog(id: string) { yield* structuredClone(this.logs.get(id) ?? []) }
  async appendMessages(id: string, messages: StoredMessage[]) {
    await this.appendRawEvents(id, messages.map(message => ({ ...message })))
  }
  async createSessionLog(id: string, events: Record<string, unknown>[]) {
    await this.deleteSessionLog(id)
    await this.appendRawEvents(id, events)
  }
  async appendRawEvents(id: string, events: Record<string, unknown>[]) {
    const records = this.logs.get(id) ?? []
    const bytes = (this.logBytes.get(id) ?? 0) + Buffer.byteLength(JSON.stringify(events), 'utf8')
    if (records.length + events.length > 512 || bytes > 16 * 1024 * 1024) {
      throw new Error('Scenario history exceeded its memory budget.')
    }
    records.push(...structuredClone(events))
    this.logs.set(id, records)
    this.logBytes.set(id, bytes)
  }
  async deleteSessionLog(id: string) { this.logs.delete(id); this.logBytes.delete(id) }
  async countSessionLog(id: string) { return this.logs.get(id)?.length ?? 0 }
  async readFirstRecord(id: string) { return structuredClone(this.logs.get(id)?.[0] ?? null) }
  close() { this.states.clear(); this.logs.clear(); this.logBytes.clear() }
}

/**
 * Only admission is specialized: plain synthetic text needs neither workdir
 * creation nor attachment loading. The provider/tool loop and lifecycle remain
 * BaseSession/EphemeralSession's ordinary implementation.
 */
class EvaluationSession extends EphemeralSession {
  protected override async processInput(input: SessionInput, llm: LlmRuntimeConfig, signal: AbortSignal) {
    const fact: SessionTurnFact = {
      sessionId: this.id, turnId: randomUUID(), inputId: input.id,
      source: input.source, status: 'completed', content: '',
    }
    try {
      signal.throwIfAborted()
      if (input.kind !== 'message') throw new Error('Evaluation accepts one plain message.')
      this.state.executionStatus = 'running'
      await this.appendMessages(llm, { role: 'user', content: input.content })
      fact.content = await this.runLlmLoop({
        ...inputContext(this.id, input),
        projectId: this.state.projectId, sessionId: this.id,
        physicalSessionId: this.physicalSessionId,
        inputSource: 'user', tools: this.tools, signal,
      }, llm, signal, fact.turnId)
    } catch (error) {
      fact.status = signal.aborted ? 'cancelled' : 'failed'
      fact.error = error instanceof Error ? error.message : String(error)
    } finally {
      await this.finishTurn(fact)
    }
    return fact
  }
}

function limitedText(value: string, label: string, bytes: number): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > bytes) {
    throw new Error(`${label} must be nonempty and at most ${bytes} UTF-8 bytes.`)
  }
}

/** Runs the configured provider, not an evaluator model or a second agent loop. */
export async function evaluateAuthoringScenario(options: AuthoringEvaluationOptions): Promise<AuthoringEvaluationResult> {
  limitedText(options.prompt, 'Candidate prompt', 256 * 1024)
  limitedText(options.input, 'Scenario input', 32 * 1024)
  const definitions = options.tools.getDefinitions()
  if (definitions.length > 64 || Buffer.byteLength(JSON.stringify(definitions), 'utf8') > 256 * 1024) {
    throw new Error('Scenario tool definitions exceed the evaluation budget.')
  }
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Scenario timeout must be between 1 and 120000 milliseconds.')
  }
  const sessionId = `authoring-scenario:${randomUUID()}`
  const store = new EvaluationStore()
  const scope = createProjectScope(options.projectId)
  const bus = new Bus()
  let modelRounds = 0
  let totalToolCalls = 0
  let timedOut = false
  const provider: LLMProvider = {
    name: options.provider.name,
    listModels: () => [],
    chat: async (messages, tools, config) => {
      config.signal?.throwIfAborted()
      if (modelRounds >= 12) throw new Error('Scenario exceeded 12 model rounds.')
      if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > 2 * 1024 * 1024) {
        throw new Error('Scenario conversation exceeded its memory budget.')
      }
      modelRounds++
      const response = await options.provider.chat(messages, tools, config)
      config.signal?.throwIfAborted()
      totalToolCalls += response.toolCalls.length
      if (response.toolCalls.length > 32 || totalToolCalls > 128 ||
        Buffer.byteLength(JSON.stringify(response), 'utf8') > 256 * 1024) {
        throw new Error('Scenario model response exceeded its evaluation budget.')
      }
      return response
    },
  }
  const llm = {
    ...options.llm,
    maxTokens: Math.min(4096, Math.max(1, options.llm.maxTokens ?? 4096)),
  }
  const session = new EvaluationSession(options.workspace, sessionId, {
    sessionId, segmentIndex: 0, physicalIdVersion: 2,
    projectId: options.projectId, mode: 'call', executionStatus: 'pending',
  }, [{ role: 'system', content: options.prompt }], provider, options.tools, bus, store)
  const cancel = () => session.stop()
  const timer = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
  options.signal.addEventListener('abort', cancel, { once: true })
  try {
    // An unregistered project scope isolates both spans and provider logs from
    // the calling runtime's telemetry store; the private bus has no observers.
    return await scope.run(async () => {
      if (options.signal.aborted) cancel()
      else session.dispatch({
        id: randomUUID(), timestamp: new Date().toISOString(), kind: 'message',
        policy: 'interactive', content: options.input,
        source: { kind: 'user', sender: {
          channel: 'authoring-scenario', chatId: sessionId,
          senderId: 'synthetic-user', messageId: randomUUID(),
        } },
      }, llm)
      await session.completion
      const result = session.result && structuredClone(session.result)
      if (timedOut && result) {
        result.status = 'failed'
        result.error = 'Scenario evaluation timed out.'
      }
      return {
        status: timedOut ? 'failed' : result?.status ?? 'cancelled',
        sessionId, messages: structuredClone(session.history),
        result, error: timedOut ? 'Scenario evaluation timed out.' : result?.error,
        modelRounds, llmExecuted: modelRounds > 0, syntheticTools: true,
      }
    })
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', cancel)
    session.stop()
    store.close()
    scope.close()
  }
}
