import { correctionRequest, type CorrectionRequest } from '../../agent/learning/recovery.ts'
import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'
import { LEARNING_AUTOMATIONS } from '../../cron/contracts.ts'

export function createLearnCommand(
  sessions: SessionManager,
  trigger?: (pipeline: keyof typeof LEARNING_AUTOMATIONS) => Promise<unknown>,
  recover?: (request: CorrectionRequest) => void,
  recoveryStatus?: (batchId: string) => unknown,
): SlashCommandHandler {
  const VALID_NAMES = Object.values(LEARNING_AUTOMATIONS).map(p => p.agentType)

  return {
    name: 'learn',
    description: `Trigger a learning pipeline. Usage: /learn <${VALID_NAMES.join('|')}>; /learn recover for bounded correction queue help`,
    adminOnly: true,
    async execute(_ctx, args): Promise<string> {
      if (args.trim().startsWith('recover-status ')) {
        if (!recoveryStatus) throw new Error('Project correction recovery status is unavailable')
        return JSON.stringify(recoveryStatus(args.trim().slice(15)))
      }
      if (args.trim() === 'recover') return 'Usage: /learn recover <JSON>\nQueue one bounded correction on a parked encapsulator batch (no immediate execution). Fields: batchId, target, revision (current learned_skill read revision), correction, evidence (exact original assigned v: refs), changed (new evidence or deployed fix). Once admitted this slot cannot refill; failures stay parked for review. Query /learn recover-status <batchId> for request/state/error. Example: /learn recover {"batchId":"<parked UUID>","target":"existing-lesson","revision":"<current SHA256>","correction":"Replace obsolete requirement, preserve constraints","evidence":["v:<exact assigned ref>"],"changed":"Deployed exact patch support; evidence date/ref"}. No production queue is implied by this help.'
      if (args.trim().startsWith('recover ')) {
        if (!recover) throw new Error('Project correction recovery is unavailable')
        const request = correctionRequest.parse(JSON.parse(args.trim().slice(8)))
        recover(request)
        return `Queued correction recovery for ${request.batchId}; not executed. Normal encapsulator scheduling and enablement apply.`
      }
      const name = args.trim().toLowerCase()

      if (name === 'help') return 'Use /learn recover for bounded correction queue help; /learn recover-status <batchId> for status.'
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
