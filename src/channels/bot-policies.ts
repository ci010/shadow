import { assertServiceOutput, stampServiceOutput } from '../bots/service-output.ts'
import { channelAddressFromSessionId, channelSessionId } from '../bus/events.ts'
import { ConversationAssignmentUnavailable, type ConversationPolicies } from '../bots/conversation-policy.ts'
import type { DirectoryBots } from '../bots/runtime.ts'
import type { BotInstanceStore } from './bot-store.ts'
import { ChannelSetupError } from './setup.ts'
import { IntegrationError } from './integration-store.ts'

/** Enforced on session admission and policy refresh, including non-adapter inputs. */
export function botConversationPolicies(store: BotInstanceStore, existing: ConversationPolicies, directory?: DirectoryBots): ConversationPolicies {
  const retiredAddress = /^(bot|qq|feishu|discord|wechat):/
  const botFor = (id: string) => {
    const address = channelAddressFromSessionId(id)
    if (address) {
      if (id !== channelSessionId(address)) throw new Error('Non-canonical channel session cannot execute')
      if (address.projectId !== store.projectId) throw new Error('Bot Project mismatch')
      store.assertAccess(address.botInstanceId)
      const bot = store.get(address.botInstanceId)
      if (address.platform !== bot.platform) throw new Error('Bot platform mismatch')
      return bot
    }
    if (retiredAddress.test(id)) throw new Error('Unscoped channel session cannot execute')
    return undefined
  }
  const explicitPersonal = (id: string) => {
    const address = channelAddressFromSessionId(id)
    if (!address || !['qq', 'feishu', 'wechat'].includes(address.platform)) return undefined
    const bot = botFor(id)
    return bot?.enabled ? directory?.personalInbox(address) : undefined
  }
  const resolve = (id: string) => {
    const bot = botFor(id)
    if (!bot) return existing.resolve(id)
    if (!bot.enabled) throw new ConversationAssignmentUnavailable('Connection is disabled')
    const assigned = explicitPersonal(id)
    if (assigned) {
      if (!assigned.enabled) throw new ConversationAssignmentUnavailable('Personal inbox assignment is not active')
      return undefined
    }
    if (bot.platform === 'wechat') throw new ConversationAssignmentUnavailable('Explicit Personal WeChat direct inbox assignment required')
    const policy = existing.resolve(id)
    if (!policy?.binding.enabled) throw new ConversationAssignmentUnavailable('Explicit service assignment required')
    return policy
  }
  return {
    personal: id => {
      const bot = botFor(id)
      resolve(id) // Live assignment, connection and Project checks.
      const assigned = explicitPersonal(id)
      if (bot && assigned) {
        const verify = store.accessGuard(bot.id)
        return { agent: assigned.bot.agent, prompt: assigned.bot.prompt, assertCurrent: () => {
          verify()
          directory!.assertExecution(assigned.bot.id)
          const live = explicitPersonal(id)
          if (!live?.enabled || live.bot.id !== assigned.bot.id || live.generation !== assigned.generation) throw new Error('Personal BOT execution changed')
        } }
      }
      return undefined
    },
    managed: id => retiredAddress.test(id) || (botFor(id) ? !explicitPersonal(id)?.enabled : existing.managed(id)),
    resolve,
    inspect(id) {
      try { return resolve(id) }
      catch (error) {
        if (error instanceof ConversationAssignmentUnavailable || error instanceof ChannelSetupError && error.code === 'unknown_bot'
          || error instanceof IntegrationError && ['binding_required', 'bot_disabled', 'observation_disabled'].includes(error.code)) return undefined
        throw error
      }
    },
    authorize: (id, input) => {
      resolve(id)
      if (explicitPersonal(id)?.enabled) {
        existing.assertInputAvailable?.(id)
        if (input.source.kind === 'user') {
          const { sender } = input.source, address = channelAddressFromSessionId(id)!
          if (address.platform === 'wechat' && (sender.isGroup !== false || sender.senderId !== address.conversationId || !sender.channelInputGuard))
            throw new Error('WeChat Personal input requires a verified direct arrival')
          if (sender.channel !== address.platform || sender.chatId !== address.conversationId || sender.channelAddress?.projectId !== address.projectId || sender.channelAddress?.botInstanceId !== address.botInstanceId || sender.channelAddress?.platform !== address.platform || sender.channelAddress?.conversationId !== address.conversationId)
            throw new Error('Personal input source does not match the assigned inbox')
        }
        return
      }
      existing.authorize(id, input)
    },
    tools: (policy, id, state) => {
      resolve(id)
      const tools = existing.tools(policy, id, state), bot = botFor(id)
      if (bot && tools.stampOutput) {
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
