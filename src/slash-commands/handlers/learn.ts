import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'
import { createPipelines, triggerLearningPipeline } from '../../agent/learning/pipelines.ts'

export function createLearnCommand(
  sessions: SessionManager,
): SlashCommandHandler {
  const VALID_NAMES = Object.keys(createPipelines())

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

      const pipeline = createPipelines()[name]
      if (!pipeline) {
        return `Unknown pipeline "${name}". Available: ${VALID_NAMES.join(', ')}`
      }

      await triggerLearningPipeline(sessions, name, pipeline)

      return `Triggered ${name}.`
    },
  }
}
