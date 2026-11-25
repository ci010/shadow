import { randomUUID } from 'node:crypto'
import { BotBindingSchema, botReadResources, bindingSubscription, botSubscriptionKey, parseBotPackage } from './sdk.ts'
import { parseChannelSource, type ChannelSource } from '../channels/passive-contract.ts'

/** Target identity comes exclusively from a host-recorded inbox, never the model's policy JSON. */
export function assignChannelSource(files: Record<string, string>, source: ChannelSource, policy: unknown, scope: 'conversation' | 'parent' = 'conversation') {
  parseChannelSource(source)
  if ((source.platform === 'discord' && source.kind === 'direct') || (source.kind === 'thread' && scope !== 'parent'))
    throw new Error('Assign BOTs to top-level groups/channels or supported private chats; direct thread assignment is not supported')
  const { bot, configPath } = parseBotPackage(files)
  if (source.platform === 'wechat' && bot.mode !== 'personal') throw new Error('WeChat direct inboxes require a Personal BOT')
  if (bot.mode === 'personal' && source.platform === 'discord')
    throw new Error('Discord requires a Service BOT')
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Explicit binding policy object required')
  for (const key of ['id', 'platform', 'botInstanceId', 'botUserId', 'target', 'conversationId']) if (Object.hasOwn(policy, key)) throw new Error('Binding targets must come from the referenced channel session')
  for (const key of ['readResources', 'readFolders', 'sourceFolders']) if (Object.hasOwn(policy, key)) throw new Error('Read scope is inherited from the BOT; configure top-level readResources instead')
  const permissions = policy as Record<string, unknown>
  if (scope === 'parent' && (source.platform !== 'discord' || source.kind !== 'thread' || !source.parentId || !source.guildId || permissions.inheritThreads !== true)) throw new Error('Parent rules require a verified public Discord thread and explicit inheritThreads:true')
  const conversationId = scope === 'parent' ? source.parentId! : source.conversationId
  if (!['mention', 'all'].includes(String(permissions.trigger)) || typeof permissions.enabled !== 'boolean') throw new Error('Choose an explicit trigger and enabled state')
  const existing = bot.bindings.find(binding => binding.botInstanceId === source.connectionId && binding.platform === source.platform && (binding.platform === 'discord'
    ? binding.target.kind === 'dm' ? binding.target.userId === source.recipientId : binding.target.channelId === conversationId && binding.target.guildId === source.guildId
    : binding.conversationId === source.conversationId))
  let target: Record<string, unknown>
  if (source.platform === 'discord') {
    if (!source.botUserId || !source.guildId) throw new Error('Verified Discord source identity required')
    target = { platform: 'discord', botInstanceId: source.connectionId, botUserId: source.botUserId, id: existing?.platform === 'discord' ? existing.id : randomUUID(),
      target: { kind: 'channel', guildId: source.guildId, channelId: conversationId } }
  } else {
    target = { platform: source.platform, botInstanceId: source.connectionId, conversationId: source.conversationId }
  }
  // Assign admits the conversation, not a second list of people. Legacy
  // packages and callers can still carry explicit sender restrictions.
  const defaults = source.platform === 'discord' ? { participants: { everyone: true, userIds: [], roleIds: [] } } : {}
  const binding = BotBindingSchema.parse({ ...defaults, ...permissions, ...target })
  const config = JSON.parse(files[configPath]!)
  const readResources = botReadResources(bot)
  config.bindings = [...bot.bindings.filter(item => item !== existing), binding]
  if (bot.subscriptions !== undefined) {
    const ref = bindingSubscription(binding), key = botSubscriptionKey(ref)
    config.subscriptions = [...bot.subscriptions.filter(item => botSubscriptionKey(item) !== key), ...(binding.enabled ? [ref] : [])]
  }
  const eol = files[configPath]!.match(/\r\n|\n/)?.[0] ?? '\n'
  const content = (JSON.stringify(config, null, 2) + '\n').replace(/\n/g, eol)
  const updated = { ...files, [configPath]: content }
  parseBotPackage(updated)
  return { files: updated, configPath, content, binding, readResources }
}


/** Read-only address projection. Evidence supplies identity, never permissions.
 * Source authors choose policy and reload performs all live authorization checks.
 */
export function channelSourceAddresses(source: ChannelSource, bindings: ReturnType<typeof parseBotPackage>['bot']['bindings'] = []) {
  parseChannelSource(source)
  if (source.platform !== 'discord') {
    const address = { platform: source.platform, botInstanceId: source.connectionId, conversationId: source.conversationId }
    return { conversation: { binding: address, subscription: address } }
  }
  const address = (channelId: string) => {
    const target = { kind: 'channel' as const, guildId: source.guildId!, channelId }
    const existing = bindings.find(binding => binding.platform === 'discord' && binding.botInstanceId === source.connectionId && binding.target.kind === 'channel' && binding.target.guildId === source.guildId && binding.target.channelId === channelId)
    const id = existing?.platform === 'discord' ? existing.id : randomUUID()
    return { binding: { id, platform: 'discord', botInstanceId: source.connectionId, botUserId: source.botUserId, target },
      subscription: { platform: 'discord', bindingId: id } }
  }
  // Do not turn a thread reference into an implicit broad parent subscription.
  if (source.kind === 'thread') return { parent: { ...address(source.parentId!), requires: 'Explicit inheritThreads:true; new child events only, no history replay or shared child context.' } }
  if (source.kind === 'direct') return { unsupported: 'Discord DM assignment is not supported by this authoring guide.' }
  return { conversation: address(source.conversationId), note: 'Choose a unique binding id and explicit policy; preserve existing binding ids when editing.' }
}
