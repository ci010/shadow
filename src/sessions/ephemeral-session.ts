import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import type { InboundMessage } from '../bus/events.ts'
import { BaseSession } from './base-session.ts'

/**
 * Fire-and-forget session that processes exactly one inbound message.
 *
 * Key differences from the persistent {@link Session}:
 *  - No event loop, inbox, or idle timer.
 *  - No mid-turn steering or abort classification.
 *  - No compaction / handoff — if the token limit is hit the turn errors out.
 *  - Messages are persisted to the {@link SessionStore} via BaseSession.
 *  - The session cannot be resumed — callers should create a fresh instance
 *    for every message.
 */
export class EphemeralSession extends BaseSession {
  /**
   * Dispatch one inbound message end-to-end: build the user message, run the
   * LLM ↔ tool loop, persist all messages, then return.
   *
   * The returned promise resolves when the full turn is complete — the caller
   * can discard this instance afterwards.
   */
  async dispatch(msg: InboundMessage, llm: LlmRuntimeConfig): Promise<void> {
    const abortController = new AbortController()
    await this.processInboundMessage(msg, llm, abortController.signal)
  }
}
