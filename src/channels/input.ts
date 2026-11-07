import { randomUUID } from 'node:crypto'
import type { InboundMessage } from '../bus/events.ts'
import type { InputEnvelope, InputRoute } from '../input/router.ts'
import type { DeliveryReceipt, RunChannelPolicy } from '../sessions/input.ts'
import type { BotInstanceStore } from './bot-store.ts'
import { ChannelAdmissionError } from './base.ts'

/** In-process adapter data. Callbacks are installed by the host, never deserialized. */
export type ChannelInputPayload = { kind: 'message'; message: InboundMessage }
  | { kind: 'policy'; message: InboundMessage; runPolicy: RunChannelPolicy }
  | { kind: 'observation'; runPolicy: () => Promise<void> }
export type ChannelInputResult = DeliveryReceipt | true

/** Only adapter-verified platform locations may supply ancestry or DM identity. */
export function channelInputSource(message: InboundMessage): InputRoute & { parents?: string[] } {
  const address = message.channelAddress
  if (!address || address.platform !== message.channel || address.conversationId !== message.chatId)
    throw new ChannelAdmissionError('External input address mismatch', 403)
  const location = message.channelLocation
  if (message.channel === 'discord') {
    if (!location || location.id !== message.chatId) throw new ChannelAdmissionError('Verified Discord location required', 403)
    return { source: { type: 'discord', id: address.botInstanceId }, kind: 'message',
      topic: location.type === 1 ? `dm:${location.recipientId}` : `guild:${location.guildId}:channel:${location.id}`,
      ...(location.parentId ? { parents: [`guild:${location.guildId}:channel:${location.parentId}`] } : {}) }
  }
  return { source: { type: message.channel, id: address.botInstanceId }, kind: 'message', topic: message.chatId }
}

/** Receipt permission, used at ingress and again by the selected handler. Web
 * authentication is performed on the real Request before this in-process boundary. */
export function assertChannelMessage(bots: BotInstanceStore, message: InboundMessage) {
  if (message.channelInputGuard !== undefined) { if (typeof message.channelInputGuard !== 'function') throw new ChannelAdmissionError('Invalid arrival lease', 403); message.channelInputGuard() }
  const address = message.channelAddress
  if (message.channel === 'web') {
    if (address) throw new ChannelAdmissionError('Web cannot impersonate a Bot connection', 403)
    return undefined
  }
  if (!address || address.projectId !== bots.projectId || address.platform !== message.channel || address.conversationId !== message.chatId)
    throw new ChannelAdmissionError('External input Project or address mismatch', 403)
  bots.assertAccess(address.botInstanceId)
  const bot = bots.get(address.botInstanceId)
  if (!bot.enabled || bot.platform !== address.platform || !!bot.legacySessionId !== !!address.legacySessionId)
    throw new ChannelAdmissionError('External input connection mismatch', 403)
  if (bot.purpose === 'personal') {
    if (message.isGroup !== false || bot.verifiedOwner?.senderId !== message.senderId || bot.verifiedOwner?.chatId !== message.chatId)
      throw new ChannelAdmissionError('Verified owner direct messages only', 403)
  } else if (bot.purpose !== 'service') throw new ChannelAdmissionError('Explicit service assignment required', 403)
  return bot
}

/** Pure entry encoding, not a router or a listener registrar. The connection store
 * and adapter metadata belong to the host. No target is selected here. */
export function channelMessageEnvelope(bots: BotInstanceStore, message: InboundMessage, runPolicy?: RunChannelPolicy): InputEnvelope<ChannelInputPayload> {
  const bot = assertChannelMessage(bots, message)
  if (runPolicy && !bot) throw new ChannelAdmissionError('Platform policy connection required', 403)
  const route = !bot ? { source: { type: 'web', id: 'web' }, kind: 'message', topic: message.chatId }
    : bot.purpose === 'personal' ? { source: { type: bot.platform, id: bot.id }, kind: 'message', topic: bot.verifiedOwner!.chatId }
    : channelInputSource(message)
  return { projectId: bots.projectId, id: message.messageId, ...route,
    reply: { channelAddress: message.channelAddress, platformMessageId: message.platformMessageId },
    payload: runPolicy ? { kind: 'policy', message, runPolicy } : { kind: 'message', message } }
}

export function observationEnvelope(bots: BotInstanceStore, connection: string, bindingId: string, runPolicy: () => Promise<void>): InputEnvelope<ChannelInputPayload> {
  bots.assertAccess(connection)
  const bot = bots.get(connection)
  if (!bot.enabled || bot.platform !== 'discord' || bot.purpose !== 'service') throw new ChannelAdmissionError('Service observation unavailable', 403)
  return { projectId: bots.projectId, id: randomUUID(), correlationId: bindingId,
    source: { type: 'discord', id: connection }, kind: 'observation', topic: bindingId, payload: { kind: 'observation', runPolicy } }
}

export function requireChannelReceipt(result: ChannelInputResult | undefined): DeliveryReceipt {
  if (!result || result === true) throw new ChannelAdmissionError('No input listener subscription; input not delivered', 403)
  return result
}
export function requirePolicyReceipt(result: ChannelInputResult | undefined): void {
  if (result !== true) throw new ChannelAdmissionError('No input listener subscription; policy not executed', 403)
}
