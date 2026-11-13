import { z } from 'zod'
import { githubSubscriptionSchema } from '../projects/github/contracts.ts'

export const Drafts = z.array(z.object({ content: z.string().min(1).max(32768) }).strict()).max(16)
export const WorkflowId = z.string().min(1).max(256).refine(value => !Object.hasOwn(Object.prototype, value) && value !== 'prototype', 'Reserved identity')
export const Observation = z.object({ id: WorkflowId, item: WorkflowId.optional(), data: z.unknown() }).strict()
export const FirstBatch = z.enum(['baseline', 'emit'])
export const RevisionGate = z.object({ kind: z.literal('revision-dedupe'), first: FirstBatch }).strict()
const Field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine(v => !['constructor', 'prototype'].includes(v))
/** Only descriptive fields may be source-owned. Goals, assignment, status and acceptance remain local. */
export const WorkMap = z.object({ kind: z.literal('work-map'), objective: z.string().trim().min(1).max(4000),
  titleField: Field, summaryField: Field.optional(), revisionField: Field,
  ownership: z.literal('exclusive-until-local-edit'),
}).strict()
export const ExternalAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notify'), processor: z.string().min(1).max(64000) }).strict(),
  z.object({ kind: z.literal('record') }).strict(), WorkMap,
])
export const Node = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transform'), code: z.string().min(1).max(64000) }).strict(),
  z.object({ kind: z.literal('inbox') }).strict(),
  z.object({ kind: z.literal('record'), revisionField: Field.optional() }).strict(), WorkMap,
  z.object({ kind: z.literal('schedule-action'), action: z.enum(['agent', 'session', 'program']), job: z.unknown() }).strict(),
  z.object({ kind: z.literal('github-notify'), subscription: githubSubscriptionSchema }).strict(),
  z.object({ kind: z.literal('host-action'), handler: WorkflowId, replay: z.enum(['safe', 'confirm']) }).strict(),
])
export const WorkflowDefinition = z.object({
  id: WorkflowId, owner: z.string().min(1).optional(), revision: z.number().int().positive().default(1), name: z.string().trim().min(1).max(160).optional(),
  source: z.object({ kind: z.enum(['external', 'schedule', 'internal', 'github-resource']), id: WorkflowId }).strict(),
  binding: z.object({ demand: z.unknown() }).strict().optional(),
  gate: RevisionGate, nodes: z.array(Node).min(1).max(8), enabled: z.boolean(),
}).strict().superRefine((d, ctx) => {
  const invalid = d.source.kind === 'external' && (!d.owner || d.nodes.some(n => ['schedule-action', 'host-action', 'github-notify'].includes(n.kind))) ||
    d.source.kind === 'schedule' && (d.gate.first !== 'emit' || d.nodes.length !== 1 || d.nodes[0].kind !== 'schedule-action') ||
    d.source.kind === 'github-resource' && (d.nodes.length !== 1 || d.nodes[0].kind !== 'github-notify' || d.nodes[0].subscription.resourceId !== d.source.id) ||
    d.source.kind === 'internal' && (d.nodes.length !== 1 || d.nodes[0].kind !== 'host-action') ||
    d.nodes.some((n, i) => n.kind === 'inbox' && (i === 0 || d.nodes[i - 1].kind !== 'transform')) ||
    d.nodes.filter(n => n.kind === 'work-map').length > 1
  if (invalid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid source/action boundary or node ordering' })
})
export const AuthorDefinition = z.object({ id: WorkflowId.refine(id => !/^(schedule|internal|github):/.test(id), 'Host source namespace is reserved'), name: z.string().trim().min(1).max(160),
  source: z.object({ kind: z.literal('external'), id: WorkflowId }).strict(), binding: z.object({ demand: z.unknown() }).strict(),
  gate: RevisionGate, nodes: z.array(Node).min(1).max(8), enabled: z.boolean(),
}).strict().refine(d => d.nodes.every(n => !['schedule-action', 'host-action', 'github-notify'].includes(n.kind)), 'Host actions cannot be authored')
export const Mapping = z.object({ initial: Observation, objective: z.string(), key: z.string().optional(), title: z.string().optional(), summary: z.string().optional(), revision: z.string().optional() }).strict()
export const WorkflowRun = z.object({
  id: WorkflowId, workflow: WorkflowId, definition: WorkflowDefinition, observation: Observation,
  timestamp: z.string(), status: z.enum(['queued', 'running', 'retry', 'blocked', 'completed', 'cancelled']),
  cursor: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(), nextAt: z.number(),
  started: z.boolean(), delivered: z.number().int().nonnegative(), drafts: Drafts.optional(),
  output: z.object({ sessionId: z.string().min(1).optional(), workKey: z.string().optional(), stale: z.boolean().optional() }).strict().optional(),
  error: z.enum(['action_failed', 'interrupted_effect', 'authority_unavailable', 'mapping_conflict']).optional(),
}).strict()
export const WorkflowState = z.object({
  format: z.literal(1), projectId: z.string().min(1), definitions: z.array(WorkflowDefinition).max(512),
  dedupe: z.record(z.object({ baseline: z.boolean(), seen: z.array(z.string()).max(4096) }).strict()),
  runs: z.array(WorkflowRun).max(2500), records: z.record(z.record(Observation)),
  mappings: z.record(z.record(Mapping)).default({}),
}).strict()
export type GitHubNotifyNode = Extract<z.infer<typeof Node>, { kind: 'github-notify' }>
export type Definition = z.infer<typeof WorkflowDefinition>
export type Run = z.infer<typeof WorkflowRun>
export type SignalObservation = z.infer<typeof Observation>
export type State = z.infer<typeof WorkflowState>
export type WorkMapping = z.infer<typeof Mapping>
export type WorkMapNode = z.infer<typeof WorkMap>
export class MappingConflict extends Error {}
/** Timestamps are ordering evidence, not lexically comparable opaque revision IDs. */
export function revisionTime(observation: SignalObservation, field: string): string {
  const data = observation.data
  const value = data && typeof data === 'object' && Object.hasOwn(data, field) ? (data as Record<string, unknown>)[field] : undefined
  if (typeof value !== 'string' || !z.string().datetime({ offset: true }).safeParse(value).success) throw new MappingConflict('An explicit ISO timestamp revision is required')
  return new Date(value).toISOString()
}
