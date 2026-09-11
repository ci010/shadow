import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import type { SessionInput } from './input.ts'
import { ReadTool } from '../tools/read.ts'
import { errMsg } from '../utils/truncate.ts'
import { BaseSession } from './base-session.ts'

/**
 * Short-lived session that serializes inputs admitted during its lifetime.
 *
 * Key differences from the persistent {@link Session}:
 *  - No idle timer; ends when the admitted work finishes.
 *  - No mid-turn steering or abort classification.
 *  - No compaction / handoff — if the token limit is hit the turn errors out.
 *  - Messages are persisted to the {@link SessionStore} via BaseSession.
 *  - Concurrent admissions share history and never run simultaneous tool loops.
 */
export class EphemeralSession extends BaseSession {
  private inbox: Array<{ input: SessionInput; llm: LlmRuntimeConfig }> = []
  private active: AbortController | undefined
  private executingTools = false
  private running = false
  private closed = false
  private ended = false
  private readonly stopped = Promise.withResolvers<void>()
  onStopped?: (sessionId: string) => void

  get accepting(): boolean { return !this.closed }
  get completion(): Promise<void> { return this.stopped.promise }
  get phase(): 'idle' | 'llm' | 'tool' {
    return !this.active ? 'idle' : this.executingTools ? 'tool' : 'llm'
  }

  protected override onToolPhaseStart(): void { this.executingTools = true }
  protected override onToolPhaseEnd(): void { this.executingTools = false }

  dispatch(input: SessionInput, llm: LlmRuntimeConfig): void {
    if (!this.accepting) throw new Error(`Session ${this.id} is stopped`)
    if (input.kind === 'control' && input.command.type !== 'retry') {
      if (input.command.type === 'compact') this.requestCompact(llm)
      if (input.command.type === 'cancel') this.cancel()
      if (!this.running) this.end()
      return
    }
    this.inbox.push({ input, llm })
    if (!this.running) {
      this.running = true
      queueMicrotask(() => {
        void this.run().catch((err) => console.error(`[session] ${this.id}:`, errMsg(err)))
      })
    }
  }

  requestCompact(_llm: LlmRuntimeConfig): never {
    throw new Error(`Compaction is not supported for ephemeral session "${this.id}"`)
  }

  cancel(): void { this.active?.abort() }

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
        await this.processInput(input, llm, this.active.signal)
        this.active = undefined
      }
    } finally {
      this.active = undefined
      this.end()
    }
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    this.closed = true
    this.running = false
    ReadTool.clearSession(this.physicalSessionId)
    try {
      this.onStopped?.(this.id)
    } finally {
      this.stopped.resolve()
    }
  }
}
