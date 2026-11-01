import { InputRouter } from '../input/router.ts'
import { channelMessageEnvelope, observationEnvelope, requireChannelReceipt, requirePolicyReceipt, type ChannelInputPayload, type ChannelInputResult } from '../channels/input.ts'
import { sessionInputListeners, handleSessionInput, type InputSessions } from '../sessions/input-listeners.ts'
import { handleBotInput } from '../bots/input.ts'
import type { DirectoryBots } from '../bots/runtime.ts'
import type { BotInstanceStore } from '../channels/bot-store.ts'
import type { ReceiveChannelMessage, ReceiveChannelPolicy } from '../sessions/input.ts'

/** Test composition only. Production composes InputRouter directly in project-runtime.
 * No synthetic listeners are inferred from an incoming message. */
export function channelInputFixture(options: {
  projectId: string; bots: BotInstanceStore; directory: DirectoryBots; receive: ReceiveChannelMessage; sessions?: InputSessions
}) {
  const sessions: InputSessions = options.sessions ?? { listSessions: () => [], listRetiredSessions: () => [], getSessionState: () => null, assertFolderAccess: () => {} }
  const handlers = { ...options, sessions }
  if (options.projectId !== options.bots.projectId || options.projectId !== options.directory.deployments.projectId) throw new Error('Input Project mismatch')
  const router = new InputRouter<ChannelInputPayload, ChannelInputResult>(options.projectId, {
    listeners: () => [...sessionInputListeners(options.projectId, sessions, options.bots), ...options.directory.inputListeners()],
    deliver: (target, input) => target.kind === 'session' ? handleSessionInput(target.id, input, handlers) : handleBotInput(target.id, input, handlers),
  })
  const receive: ReceiveChannelMessage = async message => requireChannelReceipt(await router.route(channelMessageEnvelope(options.bots, message)))
  const policy: ReceiveChannelPolicy = async (message, run) => requirePolicyReceipt(await router.route(channelMessageEnvelope(options.bots, message, run)))
  const observation = async (connection: string, scopeId: string, run: () => Promise<void>) => requirePolicyReceipt(await router.route(observationEnvelope(options.bots, connection, scopeId, run)))
  return { router, receive, policy, observation }
}
