import type { InboundMessage } from '../bus/events.ts'
import type { DeliveryReceipt, ReceiveChannelMessage, RunChannelPolicy } from '../sessions/input.ts'
import type { InputEnvelope, InputListener } from '../input/router.ts'
import { matchesInput } from '../input/router.ts'
import { channelInputSource, channelMessageEnvelope, observationEnvelope, type ChannelInputPayload, type ChannelInputResult } from '../channels/input.ts'
import type { BotInstanceStore } from '../channels/bot-store.ts'
import type { DirectoryBots } from './runtime.ts'
import { subscribedBindings, type BotDefinition } from './sdk.ts'

export function botInputListeners(bot: BotDefinition): InputListener[] {
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
  if (!botInputListeners(bot).some(sub => matchesInput(sub, channelInputSource(message))))
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
  if (!botInputListeners(bot).some(sub => matchesInput(sub, { source: { type: 'discord', id: connection }, kind: 'observation', topic: scopeId })))
    throw new Error('BOT is not subscribed to this observation')
  await runPolicy()
}

/** Final normalized output is rechecked before Session entry. Silent inputs use
 * the same authorized Session history, without commands or model execution. */
export async function handleBotChannelInput(bot: BotDefinition, message: InboundMessage, receive: ReceiveChannelMessage): Promise<DeliveryReceipt> {
  assertBotChannelInput(bot, message)
  // AgentApp + SessionManager recheck current policy/admission before commands or inference.
  return receive(message)
}

/** The router-selected BOT handler owns policy execution. Re-read deployment and
 * connection authority at delivery, not a captured definition from enumeration. */
export async function handleBotInput(id: string, input: InputEnvelope<ChannelInputPayload>, options: {
  bots: BotInstanceStore; directory: DirectoryBots; receive: ReceiveChannelMessage
}): Promise<ChannelInputResult> {
  const { bots, directory, receive } = options
  if (input.projectId !== bots.projectId || directory.deployments.projectId !== bots.projectId) throw new Error('BOT input Project mismatch')
  const bot = directory.definition(id)
  if (!bot || bot.mode !== 'service') throw new Error('Service BOT no longer deployed')
  if (!botInputListeners(bot).some(listener => matchesInput(listener, input))) throw new Error('BOT is not subscribed to this input')
  const payload = input.payload
  if (payload.kind === 'observation') {
    const expected = observationEnvelope(bots, input.source.id, input.topic, payload.runPolicy)
    if (!matchesInput({ ...expected, target: { kind: 'bot', id } }, input)) throw new Error('Observation input source mismatch')
    await handleBotObservationPolicy(bot, input.source.id, input.topic, payload.runPolicy)
    return true
  }
  const expected = channelMessageEnvelope(bots, payload.message, payload.kind === 'policy' ? payload.runPolicy : undefined)
  if (!matchesInput({ ...expected, target: { kind: 'bot', id } }, input) || bots.get(input.source.id).purpose !== 'service')
    throw new Error('BOT input source mismatch')
  if (payload.kind === 'policy') {
    await handleBotReceivePolicy(bot, payload.message, payload.runPolicy)
    return true
  }
  // A Service payload cannot elevate Session/command authority, even if a host
  // producer supplied a message-shaped object with an admin field.
  const message = payload.message.admin === false ? payload.message : { ...payload.message, admin: false }
  return handleBotChannelInput(bot, message, receive)
}
