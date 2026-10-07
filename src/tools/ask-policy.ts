import { channelAddressFromSessionId } from '../bus/events.ts'

export function channelSupportsAsk(channel?: string, sessionId?: string): boolean {
  const sessionChannel = sessionId
    ? channelAddressFromSessionId(sessionId)?.platform ?? sessionId.split(':', 1)[0]
    : undefined
  return ![channel, sessionChannel].some(value => value === 'qq' || value === 'discord')
}

export const CHAT_QUESTION_GUIDANCE = 'The ask tool is unavailable in QQ and Discord conversations. Ask necessary clarification questions in your normal chat response and end the turn; continue when the user replies. Do not create a waiting input/decision form, invent an answer, or treat silence as consent. Protected changes still require their dedicated owner approval flow in Shadow.'
