import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'

export function createCompactCommand(
  sessions: SessionManager,
): SlashCommandHandler {
  return {
    name: 'compact',
    description: 'Manually trigger session compaction (handoff).',
    adminOnly: true,
    execute(ctx): Promise<string> {
      if (!sessions.requestCompact(ctx.sessionId, ctx.llm)) {
        return Promise.resolve('Session is not active — cannot compact.')
      }
      return Promise.resolve('Compaction queued.')
    },
  }
}
