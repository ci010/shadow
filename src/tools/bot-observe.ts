import { z } from 'zod'
import { botObservation } from '../bots/observation.ts'
import type { BotWorkflowProjection } from '../bots/workflow-projection.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

/** Project runtime owns the source. SessionTools owns availability, not channel roles. */
export class BotObserveTool implements Tool {
  readonly name = 'bot_observe'
  readonly supportsRemoteWorkdir = false
  readonly description = 'Read current Project BOT/connection inventory and receiver evidence. Read-only, bounded, opaque identifiers; no messages, user identities, secrets, navigation or management. Session metadata/discovery is not a message receipt. Configured bindings/listeners are not admission or execution. No scope arguments.'
  readonly parameters: ToolParameters = { type: 'object', properties: {}, additionalProperties: false }
  constructor(private projectId: string, private snapshot: () => BotWorkflowProjection) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId) throw new Error('BOT observation Project mismatch')
    z.object({}).strict().parse(args)
    // Same host tool filter as catalog discovery/import/invocation. No model full flag.
    if (!context.tools.has('invoke_tool') || !context.tools.canUseDynamic(this.name)) throw new Error('BOT observation tool is unavailable')
    return JSON.stringify(botObservation(this.projectId, this.snapshot()))
  }
}
