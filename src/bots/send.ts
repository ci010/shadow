import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ChannelStreamTool } from '../tools/channel-stream.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { BotHostScope } from './host-contract.ts'

const request = z.object({ content: z.string().trim().min(1).max(2000), idempotencyKey: z.string().min(1).max(200) }).strict()
type Dependencies = ConstructorParameters<typeof ChannelStreamTool>[3]
/** An explicit original-conversation send, backed by the existing channel send
 * ledger. No event bus message masquerades as a successful platform receipt.
 */
export class BotSend {
  constructor(private workspace: string, private projectId: string, private deps: {
    assertCurrent(scope: BotHostScope): void
    assertConnection: Dependencies['assertConnection']
    send: Dependencies['send']
    sendBotText?: (address: BotHostScope['address'], content: string, signal: AbortSignal) => Promise<{ id: string }>
  }) {}
  async execute(scope: BotHostScope, input: Record<string, unknown>, context: ExecutionContext): Promise<unknown> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId || scope.projectId !== this.projectId || context.sessionId !== scope.sessionId || scope.address.projectId !== this.projectId) throw new Error('BOT send scope mismatch.')
    this.deps.assertCurrent(scope)
    const args = request.parse(input)
    if (scope.address.platform !== 'discord' && !this.deps.sendBotText) throw new Error('Explicit BOT sending is not supported on this platform; no message was sent.')
    const sender = new ChannelStreamTool('channel_send', this.workspace, this.projectId, {
      authorized: id => id === scope.sessionId,
      assertConnection: (connection, conversation) => {
        context.signal.throwIfAborted(); this.deps.assertCurrent(scope)
        if (connection !== scope.address.botInstanceId || conversation !== scope.address.conversationId) throw new Error('BOT send destination mismatch.')
        this.deps.assertConnection(connection, conversation)
      },
      send: (...args) => {
        context.signal.throwIfAborted(); this.deps.assertCurrent(scope)
        return scope.address.platform === 'discord' ? this.deps.send(...args)
          : this.deps.sendBotText!(scope.address, args[2], context.signal)
      },
    })
    return JSON.parse(await sender.execute({ ...args, connection: scope.address.botInstanceId, conversation: scope.address.conversationId,
      idempotencyKey: createHash('sha256').update(JSON.stringify([scope.botId, scope.bindingKey, args.idempotencyKey])).digest('hex') }, context))
  }
}
