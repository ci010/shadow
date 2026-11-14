import { assertServiceOutput, stampServiceOutput } from '../bots/service-output.ts'
import { channelAddressFromSessionId, channelSessionId } from '../bus/events.ts'
import type { ConversationPolicies } from '../bots/conversation-policy.ts'
import type { DirectoryBots } from '../bots/runtime.ts'
import type { BotInstanceStore } from './bot-store.ts'

/** Publication retirement includes the pre-address-format verified owner DM. */
export function isPersonalConnectionSession(store: BotInstanceStore, sessionId: string, connectionId: string): boolean {
  const bot = store.get(connectionId), address = channelAddressFromSessionId(sessionId)
  if (address) return address.projectId === store.projectId && address.botInstanceId === bot.id && address.platform === bot.platform
  return !!bot.legacySessionId && !!bot.verifiedOwner && sessionId === channelSessionId({ projectId: store.projectId, botInstanceId: bot.id, platform: bot.platform, conversationId: bot.verifiedOwner.chatId, legacySessionId: true })
}

/** Enforced on session admission and policy refresh, including non-adapter inputs. */
export function botConversationPolicies(store: BotInstanceStore, existing: ConversationPolicies, directory?: DirectoryBots): ConversationPolicies {
  const botFor = (id: string) => {
    const address = channelAddressFromSessionId(id)
    if (address) {
      if (address.projectId !== store.projectId) throw new Error('Bot Project mismatch')
      store.assertAccess(address.botInstanceId)
      const bot = store.get(address.botInstanceId)
      if (address.platform !== bot.platform) throw new Error('Bot platform mismatch')
      return bot
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
      if (directory && !directory.personal(bot.id)) throw new Error('Personal BOT deployment required')
      if (id !== channelSessionId({ projectId: store.projectId, botInstanceId: bot.id, platform: bot.platform,
        conversationId: bot.verifiedOwner.chatId, ...(bot.legacySessionId ? { legacySessionId: true } : {}) }))
        throw new Error('Verified owner direct conversation required')
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
      if (!definition) return undefined
      const generation = directory!.personalGeneration(bot.id), verify = store.accessGuard(bot.id)
      return { agent: definition.agent!, prompt: definition.prompt, assertCurrent: () => {
        verify(); resolve(id)
        if (!generation || directory!.personalGeneration(bot.id) !== generation) throw new Error('Personal BOT execution changed')
      } }
    },
    managed: id => botFor(id)?.purpose === 'personal' ? false : existing.managed(id),
    resolve,
    authorize: (id, input) => {
      const bot = botFor(id)
      resolve(id)
      if (bot?.purpose === 'personal') {
        const senders = directory?.personal(bot.id)?.connectionPolicies?.[bot.id]?.allowFrom
        if (input.source.kind === 'user' && senders && !senders.includes(input.source.sender.senderId)) throw new Error('Sender is outside BOT admission policy')
        if (input.source.kind === 'user' && (input.source.sender.isGroup !== false ||
          input.source.sender.senderId !== bot.verifiedOwner?.senderId || input.source.sender.chatId !== bot.verifiedOwner?.chatId)) throw new Error('Verified owner direct input required')
        return
      }
      existing.authorize(id, input)
    },
    tools: (policy, id, state) => {
      resolve(id)
      const tools = existing.tools(policy, id, state), bot = botFor(id)
      if (bot?.purpose === 'service' && tools.stampOutput) {
        const verify = store.accessGuard(bot.id), stamp = tools.stampOutput, snapshot = tools.assertSnapshot
        tools.assertSnapshot = () => { verify(); resolve(id); snapshot?.() }
        tools.stampOutput = message => {
          verify(); resolve(id)
          const inner = stamp(message)
          return stampServiceOutput(inner, () => { verify(); resolve(id); assertServiceOutput(inner) })
        }
      }
      return tools
    },
    prompt: (policy, id, state) => { resolve(id); return existing.prompt(policy, id, state) },
    boundary: (policy, id, state) => { resolve(id); return existing.boundary?.(policy, id, state) },
  }
}
