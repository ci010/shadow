import type { BotInstanceStore } from '../channels/bot-store.ts'
import type { BotDefinition } from './sdk.ts'

/** Production and synthetic chat-assignment validation share the same service
 * connection/ownership rules. Discord's live identity/role/epoch validation stays
 * in its existing integration store, not inferred from QQ/Feishu semantics. */
export async function validateServiceAssignments(projectId: string, bots: BotInstanceStore,
  candidate: BotDefinition, other: readonly BotDefinition[], requireFolder: (id: string) => Promise<unknown>): Promise<void> {
  if (bots.projectId !== projectId) throw new Error('BOT assignment Project mismatch')
  const keys = new Set<string>()
  for (const binding of [...other.flatMap(bot => bot.bindings), ...candidate.bindings]) {
    if (binding.platform === 'discord') continue
    bots.assertAccess(binding.botInstanceId)
    const connection = bots.get(binding.botInstanceId)
    if (connection.platform !== binding.platform || connection.purpose !== 'service') throw new Error('BOT bindings require a matching service connection/platform.')
    const key = JSON.stringify([binding.botInstanceId, binding.platform, binding.conversationId])
    if (keys.has(key)) throw new Error('Conversation already belongs to another BOT.')
    keys.add(key)
    for (const id of binding.readFolders) await requireFolder(id)
  }
}
