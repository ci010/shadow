import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WatermarkTool } from '../tools/watermark.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { BotHostScope } from './host-contract.ts'

const request = z.object({ action: z.enum(['inspect', 'prepare', 'claim', 'ack', 'retry']),
  source: z.string().min(1).max(128).optional(), from: z.string().max(256).nullable().optional(), to: z.string().max(256).nullable().optional(),
  id: z.string().uuid().optional(), attempt: z.string().min(1).max(64).optional(), error: z.string().min(1).max(256).optional() }).strict()

/** A bounded binding+deployment namespace over the existing watermark service.
 * Source cursors remain opaque. This grants no source read or send permission.
 * Cancellation/failure never implicitly acks; inspect and retry the recorded
 * running attempt after a crash before claiming a fresh attempt.
 */
export class BotWatermark {
  private readonly tool: WatermarkTool
  constructor(workspace: string, private projectId: string) { this.tool = new WatermarkTool(workspace, projectId) }
  async execute(scope: BotHostScope, input: Record<string, unknown>, context: ExecutionContext): Promise<unknown> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId || scope.projectId !== this.projectId || context.sessionId !== scope.sessionId) throw new Error('BOT watermark scope mismatch.')
    if (Object.hasOwn(input, 'consumer')) throw new Error('BOT watermark consumer is fixed by the host; use source for independent incremental feeds.')
    input = request.parse(input)
    const namespace = createHash('sha256').update(JSON.stringify([scope.projectId, scope.botId, scope.bindingKey, scope.sessionId, scope.revision])).digest('hex')
    const scoped = { ...context, sessionId: `bot:${namespace}` }
    if (input.action === 'claim') {
      const state = JSON.parse(await this.tool.execute({ action: 'inspect', consumer: 'incremental' }, scoped))
      const batch = state.batches.find((batch: { id: string }) => batch.id === input.id)
      if (batch?.attempts.length >= 64) throw new Error('BOT watermark attempt capacity reached; host recovery required.')
    }
    if (input.action === 'prepare') {
      const state = JSON.parse(await this.tool.execute({ action: 'inspect', consumer: 'incremental' }, scoped))
      if (state.batches.length >= 1000 || (!state.batches.some((batch: { source: string }) => batch.source === input.source) && new Set([...Object.keys(state.cursors), ...state.batches.map((batch: { source: string }) => batch.source)]).size >= 32)) throw new Error('BOT watermark capacity reached; host archival required.')
    }
    context.signal.throwIfAborted()
    const result = JSON.parse(await this.tool.execute({ ...input, consumer: 'incremental' }, scoped))
    // Avoid returning an ever-growing completed-batch archive through the 256 KiB
    // script boundary. Cursors and unfinished attempts suffice for safe recovery.
    if (input.action === 'inspect') result.batches = result.batches.filter((batch: { state: string }) => batch.state !== 'done').map((batch: { attempts: string[] }) => ({ ...batch, attempts: batch.attempts.slice(-1) }))
    return result
  }
}
