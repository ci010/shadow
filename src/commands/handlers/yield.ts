import type { SlashCommandHandler } from '../index.ts'
import type { SessionManager } from '../../sessions/session-manager.ts'
import { YieldError } from '../../sessions/yield.ts'

export function createYieldCommand(sessions: SessionManager): SlashCommandHandler {
  return {
    name: 'yield',
    description: 'Answer or cancel a pending question: /yield <request-id> <1|2|3|cancel>.',
    adminOnly: false,
    async execute(ctx, args) {
      const match = /^(\S+)\s+([123]|cancel)$/.exec(args.trim())
      if (!match) return 'Error: use /yield <request-id> <1|2|3|cancel>.'
      const request = sessions.yields.get(ctx.sessionId)
      if (!request || request.id !== match[1]) return 'Error: this question is no longer pending. Use the current request ID.'
      try {
        if (match[2] === 'cancel') {
          if (ctx.msg.channel === 'web') sessions.yields.cancelUser(ctx.sessionId, request.id)
          else sessions.yields.cancelChannel(ctx.sessionId, request.id, ctx.msg.channel, ctx.msg.senderId)
          sessions.getActiveSession(ctx.sessionId)?.cancel()
          return 'Question cancelled.'
        }
        const option = request.options[Number(match[2]) - 1]!
        const answer = ctx.msg.channel === 'web'
          ? sessions.yields.answerUser(ctx.sessionId, request.id, option)
          : sessions.yields.answerChannel(ctx.sessionId, request.id, option, ctx.msg.channel, ctx.msg.senderId)
        return `Selected: ${answer.option}`
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        return `Error: ${error.message}`
      }
    },
  }
}
