import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'

export function createClearCommand(sessions: Pick<SessionManager, 'clearSessionContext'>): SlashCommandHandler {
  return {
    name: 'clear',
    description: 'Start a fresh AI context with current agent instructions; keep session identity and history.',
    adminOnly: true,
    async execute(ctx, args) {
      if (args) return 'Error: use `/clear` without arguments.'
      const result = await sessions.clearSessionContext(ctx.sessionId)
      if (result === 'busy') return 'Error: This session has active or queued work. Stop or finish it, then run `/clear` again.'
      if (result === 'unsupported') return 'Error: `/clear` is only available for ordinary persistent conversations.'
      return 'AI context cleared. The next message starts fresh with current agent instructions and tools, without previous messages or a handoff summary. Session identity, history, files, and long-term memory are preserved.'
    },
  }
}
