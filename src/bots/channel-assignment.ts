import { randomUUID } from 'node:crypto'
import { BotBindingSchema, botReadResources, bindingSubscription, botSubscriptionKey, parseBotPackage } from './sdk.ts'
import { parseChannelSource, type ChannelSource } from '../channels/passive-contract.ts'

/** Target identity comes exclusively from a host-recorded inbox, never the model's policy JSON. */
export function assignChannelSource(files: Record<string, string>, source: ChannelSource, policy: unknown, scope: 'conversation' | 'parent' = 'conversation') {
  parseChannelSource(source)
  if (source.kind === 'direct' || source.kind === 'thread' && scope !== 'parent') throw new Error('Assign BOTs to top-level groups/channels only; threads remain history under their parent')
  const { bot, configPath } = parseBotPackage(files)
  if (bot.mode !== 'service') throw new Error('Personal BOTs cannot receive service channel assignments')
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Explicit binding policy object required')
  for (const key of ['id', 'platform', 'botInstanceId', 'botUserId', 'target', 'conversationId']) if (Object.hasOwn(policy, key)) throw new Error('Binding targets must come from the referenced channel session')
  for (const key of ['readResources', 'readFolders', 'sourceFolders']) if (Object.hasOwn(policy, key)) throw new Error('Read scope is inherited from the BOT; configure top-level readResources instead')
  const permissions = policy as Record<string, unknown>
  if (scope === 'parent' && (source.platform !== 'discord' || source.kind !== 'thread' || !source.parentId || !source.guildId || permissions.inheritThreads !== true)) throw new Error('Parent rules require a verified public Discord thread and explicit inheritThreads:true')
  if (source.platform === 'discord' && source.kind === 'thread' && scope === 'conversation' && permissions.inheritThreads !== false) throw new Error('Exact thread assignment requires inheritThreads:false; choose scope:parent explicitly for a parent rule')
  const conversationId = scope === 'parent' ? source.parentId! : source.conversationId
  if (!['mention', 'all'].includes(String(permissions.trigger)) || typeof permissions.enabled !== 'boolean') throw new Error('Choose an explicit trigger and enabled state')
  const existing = bot.bindings.find(binding => binding.botInstanceId === source.connectionId && binding.platform === source.platform && (binding.platform === 'discord'
    ? binding.target.kind === 'dm' ? binding.target.userId === source.recipientId : binding.target.channelId === conversationId && binding.target.guildId === source.guildId
    : binding.conversationId === source.conversationId))
  let target: Record<string, unknown>
  if (source.platform === 'discord') {
    if (!source.botUserId || !source.guildId) throw new Error('Verified Discord source identity required')
    if (!Object.hasOwn(permissions, 'participants')) throw new Error('Choose Discord participants explicitly')
    target = { platform: 'discord', botInstanceId: source.connectionId, botUserId: source.botUserId, id: existing?.platform === 'discord' ? existing.id : randomUUID(),
      target: { kind: 'channel', guildId: source.guildId, channelId: conversationId } }
  } else {
    if (!Array.isArray(permissions.allowFrom)) throw new Error('Choose allowed senders explicitly; [] permits nobody')
    target = { platform: source.platform, botInstanceId: source.connectionId, conversationId: source.conversationId }
  }
  const binding = BotBindingSchema.parse({ ...permissions, ...target })
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

