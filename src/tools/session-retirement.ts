import { z } from 'zod'
import type { Tool } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionRetirement } from '../sessions/retirement.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { CronService } from '../cron/service.ts'
import { retirementProposalSchema } from '../sessions/retirement-contract.ts'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('inspect'), sessionId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('apply'), token: z.string().uuid(), proposal: retirementProposalSchema }).strict(),
])

/** Domain safeguards only. Admission, execution, cancellation and history belong to automation. */
export class SessionRetirementTool implements Tool {
  readonly name = 'session_retirement'
  readonly description = 'Inspect inactive sessions and apply verified recoverable retirement. list returns eligible IDs; inspect returns untrusted history, drafts, wiki and delivery roots plus a short-lived execution-owned token. apply accepts that token and a structured assessment. Never infer completion from inactivity. No physical purge.'
  readonly parameters = {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'inspect', 'apply'] },
      sessionId: { type: 'string' },
      token: { type: 'string' },
      proposal: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['complete', 'continued', 'blocked'] },
          reason: { type: 'string' },
          continuationSessionId: { type: 'string' },
          knowledge: { type: 'string', enum: ['none', 'already-preserved', 'preserve', 'unresolved'] },
          knowledgeFiles: { type: 'array', items: { type: 'string' }, maxItems: 30 },
          knowledgeEntries: { type: 'array', maxItems: 10, items: {
            type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } },
            required: ['name', 'content'], additionalProperties: false,
          } },
          files: { type: 'array', maxItems: 100, items: {
            type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } },
            required: ['source', 'destination'], additionalProperties: false,
          } },
        },
        required: ['outcome', 'reason', 'knowledge', 'knowledgeFiles', 'files'],
        additionalProperties: false,
      },
    },
    required: ['action'],
    additionalProperties: false,
  }
  readonly preserveOutput = true

  constructor(private retirement: SessionRetirement, private sessions: SessionManager, private cron: CronService) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const state = this.sessions.getSessionState(context.sessionId)
    const job = state?.automation && this.cron.listJobs().find(job => job.id === state.automation!.jobId)
    if (state?.mode !== 'task' || state.automation?.config?.source !== 'cron' ||
      state.executionStatus !== 'running' || !job?.executionLimits?.allowedTools.includes(this.name)) {
      throw new Error('Requires an active automation with a host-configured session_retirement tool grant')
    }
    const input = inputSchema.parse(args)
    if (input.action === 'list') return JSON.stringify(await this.retirement.candidates(context.signal))
    if (input.action === 'inspect') return JSON.stringify(await this.retirement.inspect(input.sessionId, context.sessionId, context.signal))
    return this.retirement.apply(input.token, input.proposal, context.sessionId, context.signal)
  }
}
