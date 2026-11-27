import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'

export function createCompactCommand(
  sessions: Pick<SessionManager, 'requestCommandCompact'>,
): SlashCommandHandler {
  return {
    name: 'compact',
    description: 'Manually trigger session compaction (handoff).',
    adminOnly: true,
    async execute(ctx) {
      const result = await sessions.requestCommandCompact(ctx.sessionId, ctx.msg, ctx.llm)
      if (result === 'recovery') return 'Error: This conversation has an interrupted turn. Continue it before compacting, or start a fresh model context with /clear.'
      if (result === 'empty') return 'Error: This conversation has no model history to compact.'
      if (result === 'unsupported') return 'Error: /compact requires an existing writable persistent conversation.'
      return 'Compaction queued.'
    },
  }
}
