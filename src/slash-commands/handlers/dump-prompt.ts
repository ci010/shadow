import type { AgentApp } from '../../agent/app.ts'
import type { SlashCommandHandler } from '../index.ts'

export function createDumpPromptCommand(agent: AgentApp): SlashCommandHandler {
  return {
    name: 'dump-prompt',
    description: 'Output the full system prompt for the current session.',
    adminOnly: true,
    async execute(ctx): Promise<string> {
      const { systemPrompt } = await agent.sessions.getContext({
        sessionId: `web:${ctx.msg.chatId}`,
        channel: 'web',
      })
      return ['```text', systemPrompt, '```'].join('\n')
    },
  }
}
