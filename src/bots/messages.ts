import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ChannelMessageStream } from '../channels/message-stream.ts'
import { Watermarks } from '../watermarks/store.ts'
import { ChannelStreamTool } from '../tools/channel-stream.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { BotHostScope } from './host-contract.ts'

const attempt = z.string().min(1).max(64)
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), limit: z.number().int().min(1).max(100).default(50), attempt: attempt.optional() }).strict(),
  z.object({ action: z.literal('ack'), batch: z.string().uuid(), attempt }).strict(),
  z.object({ action: z.literal('retry'), batch: z.string().uuid(), attempt, error: z.string().min(1).max(256) }).strict(),
])
/** The already-received, original-conversation stream only. Reuses the existing
 * channel stream and fixed-range watermark engine; no new collector/queue, no
 * Discord history catch-up, and no fabricated recovery of offline QQ gaps.
 */
export class BotMessages {
  constructor(private workspace: string, private projectId: string,
    private authorize: (scope: BotHostScope) => void) {}
  async execute(scope: BotHostScope, input: Record<string, unknown>, context: ExecutionContext): Promise<unknown> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId || scope.projectId !== this.projectId || context.sessionId !== scope.sessionId || scope.address.projectId !== this.projectId) throw new Error('BOT message scope mismatch.')
    this.authorize(scope)
    const args = request.parse(input)
    const consumer = 'bot:' + createHash('sha256').update(JSON.stringify([scope.projectId, scope.botId, scope.bindingKey, scope.sessionId, scope.revision])).digest('hex')
    const state = new Watermarks(this.workspace, this.projectId, JSON.stringify(['channel-stream', consumer])).inspect()
    const pending = state.batches.find(batch => batch.state !== 'done')
    if (args.action === 'read') {
      if (state.batches.length >= 1000 && !pending) throw new Error('BOT message watermark capacity reached; host archival required.')
      if (args.attempt && pending?.state === 'pending' && pending.attempts.length >= 64) throw new Error('BOT message attempt capacity reached; host recovery required.')
      if (!pending) {
        const source = createHash('sha256').update(JSON.stringify([scope.address.botInstanceId, [scope.address.conversationId], false])).digest('hex')
        const cursor = state.cursors[source]
        const after = cursor?.startsWith('{') ? JSON.parse(cursor).position : Number(cursor ?? 0)
        const page = new ChannelMessageStream(this.workspace, this.projectId).page(scope.address.botInstanceId, [scope.address.conversationId], false, after, args.limit)
        let count = 0, bytes = 0
        for (const event of page.events) {
          const size = Buffer.byteLength(JSON.stringify(event))
          if (count && bytes + size > 180000) break
          bytes += size; count++
        }
        if (count) args.limit = count
      }
    }
    const tool = new ChannelStreamTool('channel_read', this.workspace, this.projectId, {
      authorized: id => id === scope.sessionId,
      assertConnection: (connection, conversation) => {
        context.signal.throwIfAborted(); this.authorize(scope)
        if (connection !== scope.address.botInstanceId || conversation !== undefined && conversation !== scope.address.conversationId) throw new Error('BOT message source mismatch.')
      },
      send: async () => { throw new Error('BOT message reads cannot send.') },
    })
    return JSON.parse(await tool.execute({ ...args, consumer, connection: scope.address.botInstanceId,
      conversations: [scope.address.conversationId], includeChildren: false }, context))
  }
}
