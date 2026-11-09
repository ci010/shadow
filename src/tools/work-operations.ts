import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { WorkAlignment } from '../sessions/work-alignment.ts'
import { WorkTool } from './work.ts'

// Catalog source and callable names intentionally coincide (v:tools/work_create, etc.).
export const WORK_OPERATIONS = ['create', 'update', 'assign', 'review', 'link'] as const
type Operation = typeof WORK_OPERATIONS[number]
const string = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength })
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const array = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems })
const key = string(600), version = { type: 'integer', minimum: 1 }
const evidence = object({ sessionId: string(512), physicalId: string(512), kind: { type: 'string', enum: ['user', 'tool'] }, id: string(512), quote: string(2000) }, ['sessionId', 'physicalId', 'kind', 'id', 'quote'])
const definition = object({ objective: string(4000), acceptance: array(string(4000), 12), boundaries: array(string(4000), 12), evidence: array(evidence, 8) }, ['objective'])
const relation = object({ kind: { type: 'string', enum: ['supports', 'requires', 'assumption'] }, reason: string(2000) }, ['kind', 'reason'])
const notes = {
  kind: { type: 'string', enum: ['goal', 'approach', 'task', 'finding'] }, relation,
  summary: string(2000, 0), plan: array(string(2000), 12), next: string(2000, 0),
  artifacts: array(object({ label: string(160), href: { ...string(2000), description: 'HTTP(S) artifact link without credentials, or Project-relative resource URL.' } }, ['label', 'href']), 20), html: string(48000, 0),
}
const nullable = (value: object) => ({ anyOf: [value, { type: 'null' }] })
const schemas: Record<Operation, ToolParameters> = {
  create: object({ idempotencyKey: string(200), title: string(160), parentKey: key, assignee: nullable(string(512)), definition,
    reason: string(2000), notes: object(notes), requestQuote: string(2000) }, ['title', 'definition']) as ToolParameters,
  update: object({ key, version, title: string(160), definition, parentKey: nullable(key), dependencies: array(key, 100),
    notes: object({ ...notes, attention: object({ kind: { type: 'string', enum: ['assumption', 'scope', 'dependency', 'decision', 'blocker'] }, summary: string(2000), awaitingResponse: { type: 'boolean', description: 'True when the assignee is waiting for a coordinator response. Not authorization.' } }, ['kind', 'summary']) }),
    status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'done', 'cancelled'] }, blockedReason: string(2000), requestQuote: string(2000) }, ['key', 'version']) as ToolParameters,
  assign: object({ key, version, assignee: nullable(string(512)) }, ['key', 'version', 'assignee']) as ToolParameters,
  review: object({ key, version, conclusion: string(2000), disposition: { type: 'string', enum: ['record', 'return_to_assignee'], description: 'Default return_to_assignee for attention.awaitingResponse=true; otherwise record. Does not change status or grant permission.' } }, ['key', 'version', 'conclusion']) as ToolParameters,
  link: object({ key }, ['key']) as ToolParameters,
}
const descriptions: Record<Operation, string> = {
  create: 'Create shared Work and associate this session. Optional idempotencyKey replays only the same normalized request in this Project/creator. Child notes need a causal relation. No new authorization.',
  update: 'Update only changed Work fields with its current version from v:works. Workers edit their branch; structural changes need coordinator authority. status done reports completion, not human acceptance. Routine progress stays silent; entering done/blocked or a new coordination attention can notify the Work manager.',
  assign: 'Assign Work using its current version. Only coordinator/human; never stops running operations or transfers file ownership. null clears assignment.',
  review: 'Record coordinator review of current Work attention using version and conclusion. Optional disposition record|return_to_assignee defaults to return for awaitingResponse=true, otherwise record. Does not change status, assignment or authorization; no acknowledgement is required.',
  link: 'Associate this durable conversation with existing Work. Does not change focus, assignment, authority or completion.',
}
export function createWorkTools(alignment: WorkAlignment): Tool[] {
  return WORK_OPERATIONS.map(operation => ({
    name: `work_${operation}`, description: `${descriptions[operation]} Read/list/search at v:works; no action/data wrapper.`,
    parameters: schemas[operation], supportsRemoteWorkdir: true,
    async execute(args: Record<string, unknown>, context: ExecutionContext) {
      const denied = context.tools.executionDenial(`work_${operation}`, args)
      if (denied) return denied
      // Also validate the published schema for direct callers, not just invoke_tool.
      const { key, version, ...data } = args
      if ('action' in data || 'data' in data) throw new Error('Use typed Work fields, not action/data.')
      if (operation === 'link') {
        if (Object.keys(data).length || version !== undefined) throw new Error('Only key is accepted.')
        if (operation === 'link' && key === undefined) throw new Error('Provide an existing Work key.')
        return new WorkTool(alignment, `work_${operation}`).execute({ action: operation, key }, context)
      }
      if (operation === 'create' && (key !== undefined || version !== undefined)) throw new Error('Create does not accept key/version.')
      return new WorkTool(alignment, `work_${operation}`).execute({ action: operation, key, version, data }, context)
    },
  }))
}
