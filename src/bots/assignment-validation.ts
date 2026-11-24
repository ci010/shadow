import type { BotInstanceStore } from '../channels/bot-store.ts'
import { channelSessionId } from '../bus/events.ts'
import { parseChannelSource, type ChannelSource } from '../channels/passive-contract.ts'
import { botReadResources, type BotDefinition } from './sdk.ts'

/** Production and synthetic chat-assignment validation share the same exact inbox
 * connection/ownership rules. Discord's live identity/role/epoch validation stays
 * in its existing integration store, not inferred from QQ/Feishu semantics. */
export async function validateServiceAssignments(projectId: string, bots: BotInstanceStore,
  candidate: BotDefinition, other: readonly BotDefinition[], requireFolder: (id: string) => Promise<unknown>, readChannelSource?: (sessionId: string) => ChannelSource | undefined): Promise<void> {
  if (bots.projectId !== projectId) throw new Error('BOT assignment Project mismatch')
  for (const id of botReadResources(candidate)?.folders ?? []) await requireFolder(id)
  const keys = new Set<string>()
  for (const bot of [...other, candidate]) {
    if (bot !== candidate && bot.bindings.some(binding => binding.platform !== 'discord')) {
      for (const id of botReadResources(bot)?.folders ?? []) await requireFolder(id)
    }
    for (const binding of bot.bindings) {
      if (binding.platform === 'discord') continue
      bots.assertAccess(binding.botInstanceId)
      const connection = bots.get(binding.botInstanceId)
      if (connection.platform !== binding.platform) throw new Error('BOT bindings require a matching connection platform.')
      if (bot === candidate && binding.platform === 'wechat') {
        const sessionId = channelSessionId({ ...binding, projectId })
        const source = readChannelSource?.(sessionId)
        if (bot.mode !== 'personal' || !source || parseChannelSource(source, sessionId, projectId)?.kind !== 'direct')
          throw new Error('WeChat BOT assignments require an exact host-recorded direct inbox and a Personal BOT')
      }
      const key = JSON.stringify([binding.botInstanceId, binding.platform, binding.conversationId])
      if (keys.has(key)) throw new Error('Conversation already belongs to another BOT.')
      keys.add(key)
    }
  }
}
