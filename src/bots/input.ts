import type { InboundMessage } from '../bus/events.ts'
import { deriveSessionId } from '../bus/events.ts'
import type { DeliveryReceipt, ReceiveChannelMessage, RunChannelPolicy } from '../sessions/input.ts'
import type { InputRoute, InputSubscription } from '../input/router.ts'
import { matchesInput } from '../input/router.ts'
import { subscribedBindings, type BotDefinition } from './sdk.ts'

/** Only entry-verified platform locations may supply ancestry or DM identity. */
export function channelInputSource(message: InboundMessage): InputRoute & { parents?: string[] } {
  const address = message.channelAddress
  if (!address || address.platform !== message.channel || address.conversationId !== message.chatId)
    throw new Error('External input address mismatch')
  const location = message.channelLocation
  if (message.channel === 'discord') {
    if (!location || location.id !== message.chatId) throw new Error('Verified Discord location required')
    return { source: { type: 'discord', id: address.botInstanceId }, kind: 'message',
      topic: location.type === 1 ? `dm:${location.recipientId}` : `guild:${location.guildId}:channel:${location.id}`,
      ...(location.parentId ? { parents: [`guild:${location.guildId}:channel:${location.parentId}`] } : {}) }
  }
  return { source: { type: message.channel, id: address.botInstanceId }, kind: 'message', topic: message.chatId }
}

export function botInputSubscriptions(bot: BotDefinition): InputSubscription[] {
  return subscribedBindings(bot).filter(binding => binding.enabled).flatMap(binding => {
    const target = { kind: 'bot' as const, id: bot.id }
    if (binding.platform !== 'discord') return [{ target, source: { type: binding.platform, id: binding.botInstanceId }, kind: 'message', topic: binding.conversationId }]
    if (binding.observation) return binding.observation.enabled ? [{ target, source: { type: 'discord', id: binding.botInstanceId }, kind: 'observation', topic: binding.id }] : []
    return [{ target, source: { type: 'discord', id: binding.botInstanceId }, kind: 'message',
      topic: binding.target.kind === 'dm' ? `dm:${binding.target.userId}` : `guild:${binding.target.guildId}:channel:${binding.target.channelId}`,
      descendants: binding.target.kind === 'channel' && binding.inheritThreads }]
  })
}

/** Shared host admission for both the lazy strategy and its eventual normalized output. */
function assertBotChannelInput(bot: BotDefinition, message: InboundMessage) {
  if (!botInputSubscriptions(bot).some(sub => matchesInput(sub, channelInputSource(message))))
    throw new Error('BOT is not subscribed to this input')
  const binding = subscribedBindings(bot).find(binding => binding.platform !== 'discord' &&
    binding.platform === message.channel && binding.botInstanceId === message.channelAddress?.botInstanceId && binding.conversationId === message.chatId)
  if (binding && binding.platform !== 'discord' && binding.allowFrom !== undefined && !binding.allowFrom.includes(message.senderId))
    throw new Error('This sender is not authorized for the configured conversation agent')
  return binding
}

/** The selected BOT owns execution of its lazy platform strategy. Source/connection
 * and Discord security proofs may precede routing; business triggers, processors,
 * classifiers and normalization side effects may not. Algorithms stay reusable in
 * platform code, but adapters cannot start them before this handler is invoked.
 */
export async function handleBotReceivePolicy(bot: BotDefinition, message: InboundMessage, runPolicy: RunChannelPolicy): Promise<void> {
  const binding = assertBotChannelInput(bot, message)
  if (message.channel === 'discord') {
    await runPolicy(Object.freeze({ platform: 'discord' }))
  } else {
    if (!binding || binding.platform === 'discord') throw new Error('Selected BOT receive binding required')
    await runPolicy(Object.freeze({ platform: binding.platform, trigger: binding.trigger }))
  }
}

export async function handleBotObservationPolicy(bot: BotDefinition, connection: string, scopeId: string, runPolicy: () => Promise<void>): Promise<void> {
  if (!botInputSubscriptions(bot).some(sub => matchesInput(sub, { source: { type: 'discord', id: connection }, kind: 'observation', topic: scopeId })))
    throw new Error('BOT is not subscribed to this observation')
  await runPolicy()
}

/** Final normalized output is rechecked before Session entry; silent is a strategy
 * verdict, not permission to create a dormant Session. */
export async function handleBotChannelInput(bot: BotDefinition, message: InboundMessage, receive: ReceiveChannelMessage): Promise<DeliveryReceipt> {
  assertBotChannelInput(bot, message)
  if (message.silent) return { status: 'accepted', disposition: 'filtered', sessionId: deriveSessionId(message), inputId: message.messageId, delivery: 'silent' }
  // AgentApp + SessionManager recheck current policy/admission before commands or inference.
  return receive(message)
}
