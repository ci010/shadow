import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import type { SessionInput, SessionMessageInput, SessionTurnFact } from './input.ts'
import { errMsg } from '../utils/truncate.ts'
import { BaseSession } from './base-session.ts'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import { resolveSessionLocations } from './locality.ts'

/** One admitted task or bounded leaf call, using the ordinary provider/tool loop. */
export class EphemeralSession extends BaseSession {
  private inbox: Array<{ input: SessionInput; llm: LlmRuntimeConfig }> = []
  private active: AbortController | undefined
  private executingTools = false
  private running = false
  private closed = false
  private ended = false
  private cancelled = false
  private corrections: SessionMessageInput[] = []
  private finishing = false
  private readonly stopped = Promise.withResolvers<void>()
  result?: SessionTurnFact
  onStopped?: (sessionId: string) => void

  get accepting(): boolean { return !this.closed && !this.cancelled && !this.result && !this.finishing }
  get completion(): Promise<void> { return this.stopped.promise }
  get phase(): 'idle' | 'llm' | 'tool' {
    return !this.active ? 'idle' : this.executingTools ? 'tool' : 'llm'
  }
  protected override onToolPhaseStart(): void { this.executingTools = true; this.activityChanged() }
  protected override onToolPhaseEnd(): void { this.executingTools = false; this.activityChanged() }
  protected override async finishTurn(fact: SessionTurnFact): Promise<void> {
    this.result = fact
    for (const input of this.corrections.splice(0)) {
      await this.store.appendRawEvents(this.physicalSessionId, [{
        execution_correction: { inputId: input.id, status: 'not_applied', outcome: fact.status, at: new Date().toISOString() },
      }])
    }
    await super.finishTurn(fact)
  }
  protected override hasPendingContext(): boolean { return this.corrections.length > 0 }
  protected override acceptFinalResponse(): boolean {
    if (this.hasPendingContext()) return false
    this.finishing = true
    return true
  }
  protected override async drainPendingMessages(llm: LlmRuntimeConfig): Promise<void> {
    const locations = resolveSessionLocations(this.workspace, this.state, undefined, this.workdirCapabilityLookup)
    const cwd = locations.workdir.available && locations.workdir.locality === 'local'
      ? locations.workdir.path : locations.sessionDataDir
    while (this.corrections.length) {
      const input = this.corrections.shift()!
      await this.appendMessages(llm, await buildUserChatMessage(input, this.workspace, cwd))
      await this.store.appendRawEvents(this.physicalSessionId, [{
        execution_correction: { inputId: input.id, status: 'applied', at: new Date().toISOString() },
      }])
    }
  }

  dispatch(input: SessionInput, llm: LlmRuntimeConfig): void {
    if (!this.accepting) throw new Error(`Session ${this.id} is stopped`)
    if (input.kind === 'control' && input.command.type !== 'retry') {
      if (input.command.type === 'compact') this.requestCompact(llm)
      if (input.command.type === 'cancel') this.cancel()
      if (!this.running) this.end()
      return
    }
    if (this.running) {
      if (this.state.mode !== 'task' || input.kind !== 'message' || input.policy !== 'next-step'
        || input.source.kind !== 'session' || input.source.sessionId !== this.state.parentSessionId) {
        throw new Error('An active task only accepts a next-step correction from its parent.')
      }
      this.corrections.push(input)
      return
    }
    this.inbox.push({ input, llm })
    if (!this.running) {
      this.running = true
      queueMicrotask(() => {
        void this.run().catch(error => console.error(`[session] ${this.id}:`, errMsg(error)))
      })
    }
  }

  requestCompact(_llm: LlmRuntimeConfig): never {
    throw new Error(`Compaction is not supported for ephemeral session "${this.id}"`)
  }
  cancel(): void { this.cancelled = true; this.active?.abort() }
  stop(): void {
    this.closed = true
    this.inbox = []
    this.cancel()
    if (!this.running) this.end()
  }
  private async run(): Promise<void> {
    try {
      while (this.inbox.length && !this.closed) {
        const { input, llm } = this.inbox.shift()!
        this.active = new AbortController()
        this.activityChanged()
        if (this.cancelled) this.active.abort()
        await this.processInput(input, llm, this.active.signal)
        this.active = undefined
        this.activityChanged()
      }
    } finally {
      try { await this.tools.waitForForeground() }
      finally { this.active = undefined; this.end() }
    }
  }
  private end(): void {
    if (this.ended) return
    this.ended = true
    this.closed = true
    this.running = false
    this.clearReadCache()
    this.tools.resetDynamic()
    try { this.onStopped?.(this.id) } finally { this.stopped.resolve() }
  }
}
