import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'
import { LEARNING_AUTOMATIONS } from '../../cron/contracts.ts'

export function createLearnCommand(
  sessions: SessionManager,
  trigger?: (pipeline: keyof typeof LEARNING_AUTOMATIONS) => Promise<unknown>,
): SlashCommandHandler {
  const VALID_NAMES = Object.values(LEARNING_AUTOMATIONS).map(p => p.agentType)

  return {
    name: 'learn',
    description: `Trigger a learning pipeline. Usage: /learn <${VALID_NAMES.join('|')}>`,
    adminOnly: true,
    async execute(_ctx, args): Promise<string> {
      const name = args.trim().toLowerCase()

      if (!name) {
        return `Usage: /learn <${VALID_NAMES.join('|')}>\n\nPipelines:\n${
          VALID_NAMES.map((n) => `  - ${n}`).join('\n')
        }`
      }

      const pipeline = (Object.keys(LEARNING_AUTOMATIONS) as Array<keyof typeof LEARNING_AUTOMATIONS>)
        .find(key => LEARNING_AUTOMATIONS[key].agentType === name)
      if (!pipeline) {
        return `Unknown pipeline "${name}". Available: ${VALID_NAMES.join(', ')}`
      }

      if (!trigger) throw new Error('Project learning service is unavailable. Restart Main before retrying.')
      const result = await trigger(pipeline)
      return result === false ? `No new activity for ${name}.`
        : `Triggered ${name}.${typeof result === 'string' ? ` Session: ${result}` : ''}`
    },
  }
}
