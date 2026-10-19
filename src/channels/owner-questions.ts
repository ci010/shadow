import type { BotInstance } from './bot-store.ts'
import { channelSessionId, type ChannelAddress, type InboundMessage } from '../bus/events.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { YieldError } from '../sessions/yield.ts'

/** Human ingress only. Never expose this operation as an agent tool. Project Web
 * access currently has one owner; this is not a cross-platform identity mapping. */
export async function ownerQuestionCommand(manager: Pick<SessionManager, 'listSessions' | 'getSessionState' | 'yields' | 'inputs'>,
  bot: BotInstance, message: InboundMessage, address: ChannelAddress): Promise<string | undefined> {
  if (!/^\/shadow-(?:requests|reply)(?:\s|$)/.test(message.content)) return undefined
  if (bot.platform !== 'qq' || bot.purpose !== 'personal' || !bot.enabled
    || bot.projectId !== address.projectId || bot.id !== address.botInstanceId || address.platform !== 'qq'
    || message.channel !== 'qq' || address.conversationId !== message.chatId
    || message.isGroup !== false || !bot.verifiedOwner
    || bot.verifiedOwner.senderId !== message.senderId || bot.verifiedOwner.chatId !== message.chatId
    || message.displayMetadata?.author?.bot) {
    throw new YieldError('forbidden', 'Verified QQ personal owner direct message required.')
  }
  const ownSession = channelSessionId(address)
  const requests = manager.listSessions().flatMap(({ sessionId }) => {
    const state = manager.getSessionState(sessionId)
    // Exclude internal agent roots, delegations, automations and channel-bound children.
    if (!state || state.projectId !== bot.projectId || state.mode !== 'session'
      || state.parentSessionId || state.createdBySessionId || state.automation || state.channelBoundary
      || !(sessionId.startsWith('web:') || sessionId.startsWith('virtual:') || sessionId === ownSession)) return []
    const request = manager.yields.get(sessionId) ?? manager.inputs.get(sessionId)
    return request?.recipient.kind === 'user' && request.recipient.sessionId === sessionId ? [request] : []
  })
  if (message.content.trim() === '/shadow-requests') {
    return requests.length ? requests.map(request => JSON.stringify({ request_id: request.id, sessionId: request.sessionId,
      question: request.question, ...('options' in request ? { options: request.options } : { kind: 'input' }),
      ...('workContext' in request ? { workContext: request.workContext } : {}),
      ...('brief' in request ? { brief: request.brief } : {}), deadline: request.deadline })).join('\n') : 'No eligible pending questions.'
  }
  const match = /^\/shadow-reply (\S+) ([\s\S]+)$/.exec(message.content)
  if (!match) throw new YieldError('invalid_request', 'Use /shadow-requests or /shadow-reply <exact request_id> <exact option or input text>.')
  const request = requests.find(request => request.id === match[1])
  if (!request) throw new YieldError('not_found', 'This question is no longer pending or is not eligible.')
  const text = match[2]!
  if ('options' in request) {
    // No natural-language interpretation, custom text, or implicit default approval.
    if (!request.options.includes(text)) throw new YieldError('invalid_request', 'Answer must exactly match an offered option.')
    if (request.sessionId === ownSession) await manager.yields.answerChannel(request.sessionId, request.id, text, 'qq', message.senderId)
    else await manager.yields.answerUser(request.sessionId, request.id, text)
  } else {
    await manager.inputs.replyUser(request.sessionId, request.id, text,
      request.sessionId === ownSession ? 'qq' : undefined, request.sessionId === ownSession ? message.senderId : undefined)
  }
  return `Answered request ${request.id}; execution resumes in ${request.sessionId}.`
}
