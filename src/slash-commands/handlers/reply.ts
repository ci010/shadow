import type { SlashCommandHandler } from '../index.ts'
import type { SessionManager } from '../../sessions/session-manager.ts'
import { YieldError } from '../../sessions/yield.ts'

export function createReplyCommand(sessions: SessionManager): SlashCommandHandler {
  return {
    name: 'reply',
    description: 'Answer or cancel a pending question: /reply <request-id> <1|2|3|cancel>, or /reply <request-id> text <your response>.',
    adminOnly: false,
    async execute(ctx, args) {
      const match = /^(\S+)\s+(?:([123]|cancel)|(text)(?:\s+([\s\S]*))?)$/.exec(args.trim())
      if (!match) return 'Error: use /reply <request-id> <1|2|3|cancel>, or /reply <request-id> text <your response>.'
      const input = sessions.inputs.get(ctx.sessionId)
      if (input?.id === match[1]) {
        try {
          const channel = ctx.msg.channel === 'web' ? undefined : ctx.msg.channel
          if (match[2] === 'cancel') {
            await sessions.inputs.cancelUser(ctx.sessionId, input.id, channel, ctx.msg.senderId)
            sessions.getActiveSession(ctx.sessionId)?.cancel()
            return 'Question cancelled.'
          }
          if (match[3] !== 'text') return 'Error: this input request needs a text reply, not an option number.'
          const answer = await sessions.inputs.replyUser(ctx.sessionId, input.id, match[4] ?? '', channel, ctx.msg.senderId)
          return `Answered: ${answer.text}`
        } catch (error) {
          if (!(error instanceof YieldError)) throw error
          return `Error: ${error.message}`
        }
      }
      const request = sessions.yields.get(ctx.sessionId)
      if (!request || request.id !== match[1]) return 'Error: this question is no longer pending. Use the current request ID.'
      try {
        if (match[3] === 'text') {
          const answer = ctx.msg.channel === 'web'
            ? await sessions.yields.answerUserText(ctx.sessionId, request.id, match[4] ?? '')
            : await sessions.yields.answerChannelText(ctx.sessionId, request.id, match[4] ?? '', ctx.msg.channel, ctx.msg.senderId)
          return `Answered: ${answer.option}`
        }
        if (match[2] === 'cancel') {
          if (ctx.msg.channel === 'web') await sessions.yields.cancelUser(ctx.sessionId, request.id)
          else await sessions.yields.cancelChannel(ctx.sessionId, request.id, ctx.msg.channel, ctx.msg.senderId)
          sessions.getActiveSession(ctx.sessionId)?.cancel()
          return 'Question cancelled.'
        }
        const option = request.options[Number(match[2]) - 1]
        if (option === undefined) return 'Error: choose one of the options offered by this question.'
        const answer = ctx.msg.channel === 'web'
          ? await sessions.yields.answerUser(ctx.sessionId, request.id, option)
          : await sessions.yields.answerChannel(ctx.sessionId, request.id, option, ctx.msg.channel, ctx.msg.senderId)
        return `Selected: ${answer.option}`
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        return `Error: ${error.message}`
      }
    },
  }
}
