import { randomUUID } from 'node:crypto'
import type { InboundMessage } from '../bus/events.ts'
import { deriveSessionId } from '../bus/events.ts'
import type { ReceiveChannelMessage, DeliveryReceipt, RunChannelPolicy } from '../sessions/input.ts'
import type { DirectoryBots } from '../agent-authoring/bot-runtime.ts'
import type { BotInstanceStore } from '../channels/bot-store.ts'
import { ChannelAdmissionError } from '../channels/base.ts'
import { channelInputSource, handleBotChannelInput, handleBotReceivePolicy, handleBotObservationPolicy } from '../bots/input.ts'
import { InputRouter } from './router.ts'

type ChannelPayload = { kind: 'message'; message: InboundMessage }
  | { kind: 'policy'; message: InboundMessage; runPolicy: RunChannelPolicy }
  | { kind: 'observation'; runPolicy: () => Promise<void> }

/** Project composition boundary, called only by ChannelManager after connection admission.
 * Web and the verified personal owner are explicit Session targets, never fallbacks.
 */
export class ChannelInputRouter {
  private readonly router: InputRouter<ChannelPayload, DeliveryReceipt | true>
  constructor(private readonly options: {
    projectId: string
    bots: BotInstanceStore
    directory: DirectoryBots
    receive: ReceiveChannelMessage
  }) {
    if (options.bots.projectId !== options.projectId || options.directory.deployments.projectId !== options.projectId)
      throw new Error('External input router ownership mismatch')
    this.router = new InputRouter(options.projectId, {
      subscriptions: () => options.directory.inputSubscriptions(),
      deliver: async (target, input) => {
        if (target.kind === 'session') {
          if (input.payload.kind !== 'message' || target.id !== deriveSessionId(input.payload.message)) throw new Error('Explicit input target mismatch')
          return options.receive(input.payload.message)
        }
        const bot = options.directory.definition(target.id)
        if (!bot || bot.mode !== 'service') throw new Error('Service BOT no longer deployed')
        if (input.payload.kind === 'observation') {
          await handleBotObservationPolicy(bot, input.source.id, input.topic, input.payload.runPolicy); return true
        }
        if (input.payload.kind === 'policy') {
          await handleBotReceivePolicy(bot, input.payload.message, input.payload.runPolicy); return true
        }
        return handleBotChannelInput(bot, input.payload.message, options.receive)
      },
    })
  }

  readonly receive: ReceiveChannelMessage = async message => {
    const { projectId, bots } = this.options
    const address = message.channelAddress
    if (message.channel === 'web') {
      if (address) throw new ChannelAdmissionError('Web cannot impersonate a Bot connection', 403)
      return await this.router.route({ projectId, id: message.messageId, source: { type: 'web', id: 'web' }, kind: 'message', topic: message.chatId, payload: { kind: 'message', message } },
        { kind: 'session', id: deriveSessionId(message) }) as DeliveryReceipt
    }
    if (!address || address.projectId !== projectId || address.platform !== message.channel || address.conversationId !== message.chatId)
      throw new ChannelAdmissionError('External input Project or address mismatch', 403)
    bots.assertAccess(address.botInstanceId)
    const bot = bots.get(address.botInstanceId)
    if (!bot.enabled || bot.platform !== address.platform || !!bot.legacySessionId !== !!address.legacySessionId)
      throw new ChannelAdmissionError('External input connection mismatch', 403)
    if (bot.purpose === 'personal') {
      if (message.isGroup !== false || bot.verifiedOwner?.senderId !== message.senderId || bot.verifiedOwner?.chatId !== message.chatId)
        throw new ChannelAdmissionError('Verified owner direct messages only', 403)
      return await this.router.route({ projectId, id: message.messageId, source: { type: bot.platform, id: bot.id }, kind: 'message', topic: message.chatId, payload: { kind: 'message', message } },
        { kind: 'session', id: deriveSessionId(message) }) as DeliveryReceipt
    }
    if (bot.purpose !== 'service') throw new ChannelAdmissionError('Explicit service assignment required', 403)
    const result = await this.router.route({ projectId, id: message.messageId, ...channelInputSource(message), reply: { channelAddress: address, platformMessageId: message.platformMessageId }, payload: { kind: 'message', message } })
    if (!result || result === true) throw new ChannelAdmissionError('No Service BOT subscription; input not delivered', 403)
    return result
  }

  /** Route a lazy Service strategy before trigger/processor evaluation. The final
   * normalized message still passes receive() for live subscription/Session checks. */
  async policy(message: InboundMessage, runPolicy: RunChannelPolicy): Promise<void> {
    const { projectId, bots } = this.options, address = message.channelAddress
    if (!address || address.projectId !== projectId || address.platform !== message.channel || address.conversationId !== message.chatId)
      throw new ChannelAdmissionError('External input Project or address mismatch', 403)
    bots.assertAccess(address.botInstanceId)
    const bot = bots.get(address.botInstanceId)
    if (!bot.enabled || bot.purpose !== 'service' || bot.platform !== address.platform || !!bot.legacySessionId !== !!address.legacySessionId)
      throw new ChannelAdmissionError('Service input connection mismatch', 403)
    const result = await this.router.route({ projectId, id: message.messageId, ...channelInputSource(message), payload: { kind: 'policy', message, runPolicy } })
    if (!result) throw new ChannelAdmissionError('No Service BOT subscription; policy not executed', 403)
  }

  /** Used before observation strategy evaluation, every processor attempt, and final
   * wake. Unsubscribed inputs never execute the supplied strategy/classifier. */
  async observation(connection: string, bindingId: string, runPolicy: () => Promise<void>): Promise<void> {
    this.options.bots.assertAccess(connection)
    const bot = this.options.bots.get(connection)
    if (!bot.enabled || bot.platform !== 'discord' || bot.purpose !== 'service') throw new ChannelAdmissionError('Service observation unavailable', 403)
    const result = await this.router.route({ projectId: this.options.projectId, id: randomUUID(), correlationId: bindingId,
      source: { type: 'discord', id: connection }, kind: 'observation', topic: bindingId, payload: { kind: 'observation', runPolicy } })
    if (!result) throw new ChannelAdmissionError('No Service BOT observation subscription', 403)
  }
}
