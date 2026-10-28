import { channelAddressFromSessionId } from '../bus/events.ts'
import type { ConversationPolicies } from '../agent-authoring/service.ts'
import type { DirectoryBots } from '../agent-authoring/bot-runtime.ts'
import type { BotInstanceStore } from './bot-store.ts'

/** Enforced on session admission and policy refresh, including non-adapter inputs. */
export function botConversationPolicies(store: BotInstanceStore, existing: ConversationPolicies, directory?: DirectoryBots): ConversationPolicies {
  const botFor = (id: string) => {
    const address = channelAddressFromSessionId(id)
    if (address) {
      if (address.projectId !== store.projectId) throw new Error('Bot Project mismatch')
      store.assertAccess(address.botInstanceId)
      return store.get(address.botInstanceId)
    }
    const bot = store.list().find(bot => bot.legacySessionId && id.startsWith(`${bot.platform}:`))
    if (bot) store.assertAccess(bot.id)
    return bot
  }
  const resolve = (id: string) => {
    const bot = botFor(id)
    if (!bot) return existing.resolve(id)
    if (!bot.enabled || bot.purpose === 'legacy') throw new Error('Bot disabled or role not configured')
    if (bot.purpose === 'personal') {
      if (!bot.verifiedOwner) throw new Error('Verified owner required')
      return undefined // Normal Project dynamic skills, not a published service Agent.
    }
    const policy = existing.resolve(id)
    if (!policy?.binding.enabled) throw new Error('Explicit service assignment required')
    return policy
  }
  return {
    personal: id => {
      const bot = botFor(id)
      resolve(id) // Live purpose, enabled state, verified owner and Project checks.
      if (bot?.purpose !== 'personal') return undefined
      const definition = directory?.personal(bot.id)
      return definition ? { agent: definition.agent!, prompt: definition.prompt } : undefined
    },
    managed: id => botFor(id)?.purpose === 'personal' ? false : existing.managed(id),
    resolve,
    authorize: (id, input) => {
      const bot = botFor(id)
      resolve(id)
      if (bot?.purpose === 'personal') {
        if (input.source.kind === 'user' && (input.source.sender.isGroup !== false ||
          input.source.sender.senderId !== bot.verifiedOwner?.senderId)) throw new Error('Verified owner direct input required')
        return
      }
      existing.authorize(id, input)
    },
    tools: (policy, id, state) => { resolve(id); return existing.tools(policy, id, state) },
    prompt: (policy, id, state) => { resolve(id); return existing.prompt(policy, id, state) },
    boundary: (policy, id, state) => { resolve(id); return existing.boundary?.(policy, id, state) },
  }
}
