import type { ChannelSinkReceiver } from '../../src/channels/sink-contract.ts'
import { t } from './i18n.ts'

/** Shared by graph and receiver directory; never borrow a name from another scope. */
export function receiverLabel(receiver: ChannelSinkReceiver): string {
  return receiver.name?.trim() || conversationTargetLabel(receiver.address.platform, receiver.address.conversationId, receiver.kind ?? (receiver.navigation.kind === 'channel-content' ? 'channel' : undefined))
}
export function conversationTargetLabel(platform: string, id: string, kind?: ChannelSinkReceiver['kind']): string {
  const type = kind === 'direct' ? t('Direct message') : kind === 'group' ? t('Group') : kind === 'channel' ? t('Channel') : t('Conversation')
  return `${platform} · ${type} · ${id}`
}
