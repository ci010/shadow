import type { AgentApp } from '../../agent/agent.ts'
import type { SlashCommandHandler } from '../index.ts'

export function createSessionsCommand(agent: AgentApp): SlashCommandHandler {
  return {
    name: 'sessions',
    description: 'List all active sessions with last-activity timestamps.',
    adminOnly: true,
    async execute(): Promise<string> {
      const sessions = await agent.sessions.listActiveSessions()
      if (sessions.length === 0) {
        return 'No active sessions.'
      }

      const lines = [
        `Active sessions: ${sessions.length}`,
        '',
        ...sessions.map((session: { sessionId: string; lastActivityAt?: string }) =>
          `- ${session.sessionId} — last activity ${
            session.lastActivityAt ?? 'unknown'
          }`
        ),
      ]
      return lines.join('\n')
    },
  }
}
