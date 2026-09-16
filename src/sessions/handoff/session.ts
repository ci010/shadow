import type { ExecutionContext } from '../../tools/context.ts'
import type { LlmRuntimeConfig } from '../../agent/llm-config.ts'
import { BaseSession } from '../base-session.ts'

/**
 * Lightweight session for internal handoff context synthesis.
 *
 * Differences from {@link EphemeralSession}:
 *  - No {@link InboundMessage} required — accepts a pre-built {@link ExecutionContext}.
 *  - No outbound event emission — caller passes a subscriber-less Bus.
 *  - Messages are persisted to the {@link SessionStore} via BaseSession.
 */
export class HandoffSession extends BaseSession {
  /** Run the LLM ↔ tool loop with the given execution context. */
  async run(ctx: ExecutionContext, llm: LlmRuntimeConfig): Promise<void> {
    await this.runLlmLoop(ctx, llm, ctx.signal)
  }
}
