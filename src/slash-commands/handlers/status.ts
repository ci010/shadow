import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'
import { physicalSessionId } from '../../sessions/session-identity.ts'

export function createStatusCommand(
  sessions: SessionManager,
): SlashCommandHandler {
  return {
    name: 'status',
    description: 'Show the current session ID, tokens, and active tools.',
    adminOnly: true,
    async execute(ctx): Promise<string> {
      const state = await sessions.getSessionState(ctx.sessionId)
      const toolNames = sessions.getToolDefinitions(ctx.sessionId).map((t) => t.name)

      const lines = [
        'Session status:',
        '',
        `- Session ID: ${ctx.sessionId}`,
        `- Channel: ${ctx.msg.channel}`,
        `- Admin: ${ctx.admin ? 'true' : 'false'}`,
        `- Active Tools: ${toolNames.length}`,
        `- Tool Names: ${toolNames.join(', ') || '(none)'}`,
      ]

      if (state) {
        lines.push(
          `- Physical Session ID: ${physicalSessionId(state)}`,
          `- Session Chain Length: ${state.segmentIndex + 1}`,
          `- Last Activity: ${state.lastActivityAt ?? 'unknown'}`,
          `- Last Known Tokens: ${state.lastKnownTokens ?? 0}`,
        )
      } else {
        lines.push('- Session State: not initialized yet')
      }

      return lines.join('\n')
    },
  }
}
