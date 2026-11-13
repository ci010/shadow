import { z } from 'zod'
import type { Hono } from 'hono'
import type { WorkflowRuntime } from './runtime.ts'
import { AuthorDefinition } from './contracts.ts'
import type { Tool, ToolParameters } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from '../vfs/virtual-fs.ts'

const Control = z.object({ action: z.enum(['pause', 'resume', 'retry', 'cancel']), id: z.string().min(1).max(256), acknowledgeReplay: z.boolean().default(false) }).strict()
const Author = z.object({ action: z.enum(['create', 'update', 'validate']), definition: AuthorDefinition,
  expectedRevision: z.number().int().positive().optional() }).strict()
export interface WorkflowAuthorAdapters {
  source: Tool
  schedule(action: 'schedule-create' | 'schedule-update' | 'schedule-remove', input: Record<string, unknown>, context: ExecutionContext): Promise<unknown>
}
export class WorkflowTool implements Tool {
  readonly name = 'workflow'
  readonly description = 'Create, validate, read and revise Project Workflows through chat; the management page is a read-only visualization. Read v:workflows/authoring for schemas and examples. External definitions have a bounded typed plan; gate is optional fixed leading revision deduplication, not arbitrary node placement; absent gate admits each observation independently; source actions manage authorized Signal Sources; schedule-create/update/remove configure time signals using existing session permission checks. Mutations require direct user + durable Project owner. Updates use expectedRevision and affect future runs only. Source identity/demand and materialized mapping ownership are immutable: create a new ID to change them, choosing baseline/emit explicitly. Pause/resume uses flow ID; retry/cancel uses run ID. Blocked retry requires inspecting effects and acknowledgeReplay:true. Runs are not sessions; no exactly-once promise.'
  readonly parameters: ToolParameters = { type: 'object', properties: {
    action: { type: 'string', enum: ['read', 'create', 'update', 'validate', 'remove', 'source', 'schedule-create', 'schedule-update', 'schedule-remove', 'pause', 'resume', 'retry', 'cancel'] },
    id: { type: 'string' }, definition: { type: 'object', description: 'External definition; read v:workflows/authoring. No owner, revision or host actions accepted.' },
    expectedRevision: { type: 'number' }, input: { type: 'object', description: 'source: signal_provider arguments; schedule: cron authoring parameters, update additionally id and expectedRevision.' }, acknowledgeReplay: { type: 'boolean' },
  }, required: ['action'], additionalProperties: false }
  constructor(private runtime: WorkflowRuntime, private adapters?: WorkflowAuthorAdapters) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.runtime.projectId) throw new Error('Wrong Project')
    this.runtime.authorize(context.sessionId)
    if (args.action === 'read') {
      const input = z.object({ action: z.literal('read'), id: z.string().optional() }).strict().parse(args)
      const state = this.runtime.snapshot(context.sessionId)
      if (!input.id) return JSON.stringify(state)
      const result = state.definitions.find(d => d.id === input.id) ?? state.runs.find(r => r.id === input.id)
      if (!result) throw new Error('Unknown Workflow/run')
      return JSON.stringify(result)
    }
    if (args.action === 'validate') {
      const input = Author.parse(args)
      return JSON.stringify({ valid: true, definition: this.runtime.author(context.sessionId, input.definition, input.expectedRevision, true) })
    }
    if (context.inputSource !== 'user') throw new Error('Workflow changes require direct user input')
    if (args.action === 'create' || args.action === 'update') {
      const input = Author.parse(args)
      if (input.action === 'create' && input.expectedRevision !== undefined || input.action === 'update' && input.expectedRevision === undefined) throw new Error('Update requires expectedRevision; create must omit it')
      return JSON.stringify(this.runtime.author(context.sessionId, input.definition, input.expectedRevision))
    }
    if (args.action === 'remove') {
      const input = z.object({ action: z.literal('remove'), id: z.string(), expectedRevision: z.number().int().positive() }).strict().parse(args)
      this.runtime.retire(context.sessionId, input.id, input.expectedRevision)
      return JSON.stringify({ retired: input.id, historyRetained: true })
    }
    if (args.action === 'source' || String(args.action).startsWith('schedule-')) {
      const input = z.object({ action: z.enum(['source', 'schedule-create', 'schedule-update', 'schedule-remove']), input: z.record(z.unknown()) }).strict().parse(args)
      if (!this.adapters) throw new Error('Source authoring unavailable')
      return input.action === 'source' ? await this.adapters.source.execute(input.input, context) as string : JSON.stringify(await this.adapters.schedule(input.action, input.input, context))
    }
    const input = Control.parse(args)
    this.runtime.control(context.sessionId, input.id, input.action, input.acknowledgeReplay)
    return JSON.stringify({ saved: true, id: input.id, action: input.action })
  }
}
export function createWorkflowHandler(runtime: WorkflowRuntime) {
  const entries = (ctx: ExecutionContext) => {
    ctx.signal.throwIfAborted()
    if (ctx.projectId !== runtime.projectId) throw new Error('Wrong Project')
    const state = runtime.snapshot(ctx.sessionId)
    return [{ name: 'overview', content: 'Workflow runs are not model sessions. Schedule and external sources share durable node execution. Authoring and controls: workflow; schema/examples: v:workflows/authoring. State is Project-local. Integration is a use, not an execution engine. Overview: first 100 definitions, first 50 pending and last 50 terminal runs. List definitions/ and runs/ for exact files.\n' + JSON.stringify({ projectId: state.projectId, runtimeError: state.runtimeError, totalWorkflows: state.definitions.length, totalRuns: state.runs.length,
      workflows: state.definitions.slice(0, 100).map(d => ({ id: d.id, revision: d.revision, name: d.name, source: d.source, enabled: d.enabled, owner: d.owner, nodes: [...(d.gate ? [d.gate.kind] : []), ...d.nodes.map(n => n.kind)] })),
      runs: [...state.runs.filter(r => !['completed', 'cancelled'].includes(r.status)).slice(0, 50), ...state.runs.filter(r => ['completed', 'cancelled'].includes(r.status)).slice(-50)].map(r => ({ id: r.id, workflow: r.workflow, status: r.status, cursor: r.cursor, attempts: r.attempts, nextAt: r.nextAt, error: r.error })),
    }, null, 2) },
    { name: 'authoring', content: JSON.stringify({ description: 'Chat-only definition editing. Integration is a preset, Schedule is a source. gate is an optional fixed leading revision-dedupe stage; absent gate means every observation admission creates an independent run. No arbitrary node placement, tool or target execution.', example: { action: 'create', definition: { id: 'issue-intake', name: 'Issue intake', source: { kind: 'external', id: 'authorized-instance' }, binding: { demand: { repository: 'owner/repository' } }, gate: { kind: 'revision-dedupe', first: 'baseline' }, nodes: [{ kind: 'work-map', objective: 'Triage external issue; review before assignment', titleField: 'title', revisionField: 'updatedAt', ownership: 'exclusive-until-local-edit' }], enabled: true } }, nodes: ['record (optional revisionField ISO timestamp; without it arrival order wins)', 'work-map (title/optional summary only; ISO revisionField required, preserves goals/status/assignee)', 'transform(code no IO) → inbox(self only)'], update: 'Same definition + action:update + expectedRevision. Pending runs retain snapshots. Source/demand and gate presence/first policy are immutable; omit gate only for a new flow that does not need revision deduplication. New schedule flows have no gate; durable run recovery and overlapping-tick protection remain independent.', source: 'action:source, input: signal_provider arguments (all mutations direct-user)', schedule: 'action:schedule-create input:{schedule,task,session:existing|fresh,name?,agentType?,targetSessionId?,once?,urgency?,debounce_ms?}; schedule-update adds id (schedule job ID), expectedRevision (Workflow revision); schedule-remove input:{id,expectedRevision}. Existing-session target checks remain enforced.' }, null, 2) },
    ...Object.entries(state.mappings).map(([id, entries]) => ({ name: `mappings/${encodeURIComponent(id)}.json`, content: JSON.stringify(entries, null, 2) })),
    ...state.definitions.map(d => ({ name: `definitions/${encodeURIComponent(d.id)}.json`, content: JSON.stringify(d, null, 2) })),
    ...state.runs.map(r => ({ name: `runs/${r.id}.json`, content: JSON.stringify(r, null, 2) })),
    ...Object.entries(state.records).map(([id, records]) => ({ name: `records/${encodeURIComponent(id)}.json`, content: JSON.stringify(records, null, 2) }))]
  }
  const read: VirtualFsHandler = async (path, ctx) => {
    const all = entries(ctx)
    const file = all.find(e => e.name === (path || 'overview'))
    if (file) return file.content
    const children = all.filter(e => e.name.startsWith(`${path}/`)).map(e => e.name)
    if (!children.length) throw new Error('Unknown Workflow view')
    return children.join('\n')
  }
  const list: VirtualFsListHandler = async (ctx, options) => entries(ctx).filter(e => !options?.subpath || e.name === options.subpath || e.name.startsWith(`${options.subpath}/`)).map(e => options?.content === false ? { ...e, content: '' } : e)
  return { read, list }
}

/** Project router + explicit existing host authentication; external payloads never become executable plans. */
export function registerWorkflowRoutes(app: Hono, runtime: WorkflowRuntime, authorize: (request: Request) => boolean | Promise<boolean>) {
  app.get('/api/workflows', async c => {
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 403)
    return c.json(runtime.inspect())
  })
  app.post('/api/workflows/control', async c => {
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 403)
    const input = Control.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'invalid_workflow_control' }, 400)
    try { runtime.manage(input.data.id, input.data.action, input.data.acknowledgeReplay); return c.json({ saved: true }) }
    catch { return c.json({ error: 'workflow_control_rejected' }, 409) }
  })
}
