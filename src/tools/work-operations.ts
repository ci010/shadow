import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { WorkAlignment } from '../sessions/work-alignment.ts'
import { WORK_DEFINITION_GUIDANCE, WORK_DEFINITION_MAX_LENGTH } from '../initiatives/work-definition.ts'
import { WORK_KEY_PATTERN } from '../initiatives/work-key.ts'
import { WorkTool } from './work.ts'

// Catalog source and callable names intentionally coincide (v:tools/work_create, etc.).
export const WORK_OPERATIONS = ['create', 'update', 'assign', 'review', 'link', 'note_create'] as const
type Operation = typeof WORK_OPERATIONS[number]
const string = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength })
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const array = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems })
const key = { type: 'string', pattern: WORK_KEY_PATTERN }, version = { type: 'integer', minimum: 1 }
const definition = { ...string(WORK_DEFINITION_MAX_LENGTH), description: WORK_DEFINITION_GUIDANCE }
const report = {
  kind: { type: 'string', enum: ['goal', 'approach', 'task', 'finding'] },
  summary: { ...string(2000, 0), description: 'Shared state or result in free Markdown. Keep transient plans in the session.' },
  artifacts: array(object({ label: string(160), href: { ...string(2000), description: 'HTTP(S) artifact link without credentials, or Project-relative resource URL.' } }, ['label', 'href']), 20),
}
const nullable = (value: object) => ({ anyOf: [value, { type: 'null' }] })
const schemas: Record<Operation, ToolParameters> = {
  create: object({ idempotencyKey: string(200), title: string(160), parentKey: key, assignee: nullable(string(512)), definition,
    ...report }, ['title', 'definition']) as ToolParameters,
  update: object({ key, version, title: string(160), definition, parentKey: nullable(key), dependencies: array(key, 100),
    ...report,
    status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'done', 'cancelled'] }, blockedReason: string(2000) }, ['key', 'version']) as ToolParameters,
  assign: object({ key, version, assignee: nullable(string(512)) }, ['key', 'version', 'assignee']) as ToolParameters,
  review: object({ key, version, conclusion: string(2000) }, ['key', 'version', 'conclusion']) as ToolParameters,
  link: object({ key }, ['key']) as ToolParameters,
  note_create: object({ workKey: key, body: string(2000), replyTo: { type: 'string', format: 'uuid' }, notifyManager: { type: 'boolean' } }, ['workKey', 'body']) as ToolParameters,
}
const descriptions: Record<Operation, string> = {
  create: 'Create shared Work for durable coordination facts: deliverables, dependencies, blockers and responsibility. Reuse relevant Work first; one-off discussion belongs in message and observation in read. Associates this session. Optional idempotencyKey replays only the same normalized request in this Project/creator. Use parentKey for children and dependencies for prerequisites. No new authorization.',
  update: 'Persist only changed shared facts using the current version from v:works. Workers edit their branch; structural changes need coordinator authority. Routine progress stays silent; entering done/blocked can notify the Work manager. Do not send a duplicate message. done reports completion, not acceptance or permission to execute.',
  assign: 'Assign Work using its current version. Only coordinator/human; never stops running operations or transfers file ownership. null clears assignment.',
  review: 'Reassess a stale ancestor basis using the current Work version and a conclusion. Does not change status, assignment or authorization.',
  note_create: 'Append shared Markdown to existing Work. The current assignee may post an original (silent unless notifyManager is true). The current manager may reply to an original on the same Work using replyTo, which notifies the original author and does not accept notifyManager. Queued is not delivered, approved or read. Comments do not unblock or authorize.',
  link: 'Associate this durable conversation with existing Work. Does not change focus, assignment, authority or completion.',
}
export function createWorkTools(alignment: WorkAlignment): Tool[] {
  return WORK_OPERATIONS.map(operation => ({
    name: `work_${operation}`, description: `${descriptions[operation]} Read/list/search at v:works; no action/data wrapper.`,
    parameters: schemas[operation], supportsRemoteWorkdir: true,
    async execute(args: Record<string, unknown>, context: ExecutionContext) {
      const denied = context.tools.executionDenial(`work_${operation}`, args)
      if (denied) return denied
      if (operation === 'note_create') return JSON.stringify(await alignment.createWorkNote(context.sessionId, args, context.signal))
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
