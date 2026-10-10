import { z } from 'zod'
import type { Tool, ToolParameters } from './tool.ts'
import { currentOwnerWorkInput, type ExecutionContext } from './context.ts'
import { WORK_HELP, type WorkAlignment } from '../sessions/work-alignment.ts'
import { WorkConflict, workRecordSchema, type WorkRecord } from '../initiatives/work-contract.ts'

const request = z.object({
  action: z.enum(['context', 'list', 'tree', 'create', 'update', 'assign', 'review', 'select']),
  key: z.string().min(1).max(600).optional(),
  version: z.number().int().positive().optional(),
  data: z.unknown().optional(),
}).strict()

export function workReceipt(record: WorkRecord) {
  return {
    key: record.key, version: record.sequence, goalRevision: record.revision,
    title: record.workflow?.title, status: record.workflow?.status,
    parentKey: record.workflow?.parentKey, assignee: record.workflow?.assignee,
    impactPending: !!record.notes?.attention && !record.notes.attention.reviewed,
  }
}

export class WorkTool implements Tool {
  readonly name = 'work'
  readonly supportsRemoteWorkdir = true
  readonly readonly = (args: Record<string, unknown>) => ['context', 'list', 'tree'].includes(String(args.action))
  readonly description = 'Shared work notes and Project goal map, never a prerequisite for tools. create needs data={title,definition:{objective},notes:{kind}}; child notes need relation={kind:supports|requires|assumption,reason}. update needs key, version and only changed fields: data.notes={summary,plan,next,artifacts,html,attention?}, data.status/blockedReason. Workers update their branch; coordinators maintain goals and causal links. Report meaningful findings once here, not again by message. Only attention wakes a coordinator; routine notes update the dashboard silently. context returns current notes and ancestor paths; data.includeSchema=true adds help. No adopt, policy, checkpoint or per-step bookkeeping. Completion is a reported result, not user acceptance. Ask consequential questions at the affected goal with ask workKey/decisionKey.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: request.shape.action.options },
      key: { type: 'string', description: 'Stable work key.' },
      version: { type: 'integer', description: 'Current note version for update, assign or review; returned by reads and writes.' },
      data: { type: 'object', description: 'Only action-specific fields. context data.includeSchema=true returns help.' },
    }, required: ['action'], additionalProperties: false,
  }

  constructor(private readonly alignment: WorkAlignment) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const denied = context.tools.executionDenial('work', args)
    if (denied) return denied
    const { action, key, version, data } = request.parse(args)
    const actor = { kind: 'session' as const, sessionId: context.sessionId }
    if (action === 'context') {
      const options = z.object({ includeSchema: z.boolean().optional() }).strict().parse(data ?? {})
      const view = this.alignment.context(context.sessionId, key, false)
      return JSON.stringify({
        selected: view.selected,
        records: view.records.map(record => ({
          ...workReceipt(record), definition: record.definition, origin: record.origin,
          userQuote: record.requestSource?.quote, notes: record.notes, authority: record.authority,
          contextNeedsReview: record.contextChanged,
          path: this.alignment.decisionContext(context.sessionId, record.key)?.path,
        })),
        ...(options.includeSchema ? { schema: WORK_HELP } : {}),
      })
    }
    if (action === 'list' || action === 'tree') {
      return JSON.stringify(await this.alignment.execute(actor, action, key, undefined, data, context.signal))
    }
    if (action === 'select') {
      return JSON.stringify(await this.alignment.execute(actor, action, key,
        key ? this.alignment.get(key).revision : undefined, data, context.signal))
    }
    let record: WorkRecord
    if (action === 'create') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WorkConflict('Create needs a title and definition.objective.')
      record = workRecordSchema.parse(await this.alignment.execute(actor, 'create', undefined, undefined,
        data, context.signal, currentOwnerWorkInput(context)))
    } else {
      if (!key || version === undefined) throw new WorkConflict('Read the note first and provide its key and version.')
      if (action === 'update') {
        record = await this.alignment.editNote(actor, key, version, data, context.signal, currentOwnerWorkInput(context))
      } else if (action === 'assign') {
        const input = z.object({ assignee: z.string().min(1).max(512).nullable() }).strict().parse(data)
        record = await this.alignment.assignNote(actor, key, version, input.assignee, context.signal)
      } else {
        const input = z.object({ conclusion: z.string().trim().min(1).max(2000) }).strict().parse(data)
        record = await this.alignment.reviewNote(actor, key, version, input.conclusion, context.signal)
      }
    }
    return JSON.stringify(workReceipt(record))
  }
}
