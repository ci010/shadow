import { z } from 'zod'
import type { Tool, ToolParameters } from './tool.ts'
import { currentOwnerWorkInput, type ExecutionContext } from './context.ts'
import type { WorkAlignment } from '../sessions/work-alignment.ts'
import { workRecordSchema, type WorkRecord } from '../initiatives/work-contract.ts'

const request = z.object({
  action: z.enum(['context', 'list', 'tree', 'create', 'update', 'propose', 'assign', 'manage', 'progress', 'dependencies', 'adopt', 'checkpoint', 'transition', 'settle', 'select']),
  key: z.string().min(1).max(600).optional(), revision: z.number().int().positive().optional(),
  data: z.unknown().optional(),
}).strict()

const recordActions = new Set(['create', 'update', 'assign', 'manage', 'progress', 'dependencies', 'adopt', 'checkpoint', 'transition'])

export function workReceipt(record: WorkRecord, context: Pick<ReturnType<WorkAlignment['context']>, 'records' | 'effects'>, previousRevision?: number) {
  return {
    key: record.key, revision: record.revision, sequence: record.sequence, origin: record.origin, paused: record.paused,
    definitionChanged: record.revision !== (previousRevision ?? 0),
    acceptanceCount: record.definition.acceptance.length, ownerDirected: !!record.requestSource,
    authority: context.records[0].authority,
    workflow: record.workflow,
    adoption: record.adoption ? { id: record.adoption.id, sessionId: record.adoption.sessionId, revision: record.adoption.revision } : null,
    checkpoint: record.checkpoint, transition: record.transition, answerReview: record.answerReview,
    handoffFrom: record.handoffFrom, successors: record.successors,
    pendingProposals: record.proposals?.filter(proposal => proposal.status === 'pending').map(({ definition: _definition, ...proposal }) => proposal),
    effects: context.effects,
    detail: { action: 'context', key: record.key },
  }
}

export class WorkTool implements Tool {
  readonly name = 'work'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Manage work definitions, assignments, dependencies and progress. context returns full state; data.includeSchema=true adds action schemas (automatic when no work exists). Mutations return compact receipts; use context with key for full definitions. Create only for execution/tracking, not ordinary conversation. Blocked progress defaults to a step wait, not a whole-work stop; use pause for a stop. Record missing in-scope requirements with adopt data.acceptance for your own agent interpretation; this appends acceptance and adopts the new revision without changing boundaries. Human-confirmed changes need update + owner requestQuote or reviewed proposals. Only the assigned executor adopts and reports progress; completion is not acceptance.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: request.shape.action.options },
      key: { type: 'string', description: 'Work key returned by context.' },
      revision: { type: 'integer', description: 'Exact current semantic revision for mutations and selection.' },
      data: { type: 'object', description: 'Action-specific bounded payload; context data.includeSchema=true returns schemas.' },
    }, required: ['action'], additionalProperties: false,
  }
  constructor(private readonly alignment: WorkAlignment) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const denied = context.tools.executionDenial('work', args)
    if (denied) return denied
    const parsed = request.parse(args)
    const result = await this.alignment.execute({ kind: 'session', sessionId: context.sessionId },
      parsed.action, parsed.key, parsed.revision, parsed.data, context.signal,
      currentOwnerWorkInput(context))
    if (!recordActions.has(parsed.action)) return JSON.stringify(result)
    const record = workRecordSchema.parse(result)
    return JSON.stringify(workReceipt(record, this.alignment.context(context.sessionId, record.key, false), parsed.revision))
  }
}
