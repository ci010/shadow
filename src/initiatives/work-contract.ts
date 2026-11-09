import { z } from 'zod'
import { workDispatchExecutionSchema } from '../cron/work-dispatch-contract.ts'
import { decisionEvidenceSchema, parseDecisionEvidence } from '../sessions/decision-brief.ts'
import { workNotesSchema } from './work-notes.ts'

const text = z.string().trim().min(1).max(2000)
const longText = z.string().trim().min(1).max(4000)
export const workSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('work'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('initiative'), initiativeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
  z.object({ kind: z.literal('topic'), sessionId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('item'), initiativeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    itemId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
])
export type WorkSubject = z.infer<typeof workSubjectSchema>
export type WorkActor = { kind: 'user' } | { kind: 'session'; sessionId: string }
export const workDefinitionSchema = z.object({
  objective: longText,
  acceptance: z.array(longText).max(12).default([]), boundaries: z.array(longText).max(12).default([]),
  evidence: z.array(z.unknown().transform((value, ctx) => {
    try { return parseDecisionEvidence(value, ctx.path.join('.')) }
    catch (error) {
      if (!(error instanceof TypeError)) throw error
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message })
      return z.NEVER
    }
  })).max(8).default([]),
}).strict()
export type WorkDefinition = z.infer<typeof workDefinitionSchema>
export const workProgressSchema = z.enum(['pending', 'in_progress', 'blocked', 'done', 'cancelled'])
export const workWorkflowSchema = z.object({
  title: z.string().trim().min(1).max(160),
  parentKey: z.string().min(1).max(600).optional(),
  manager: z.string().min(1).max(512).nullable(),
  assignee: z.string().min(1).max(512).nullable(),
  assignmentRevision: z.number().int().positive(),
  assignmentStarted: z.boolean().optional(),
  status: workProgressSchema,
  blockedReason: text.optional(),
  blockedScope: z.enum(['step', 'work']).optional(),
  dependencies: z.array(z.string().min(1).max(600)).max(100),
  result: z.object({ summary: text, evidence: workDefinitionSchema.shape.evidence }).strict().optional(),
}).strict().refine(value => (value.status === 'blocked') === !!value.blockedReason,
  'Blocked work needs a reason; clear it when leaving blocked.')
  .refine(value => value.blockedScope === undefined || value.status === 'blocked',
    'A blocked scope requires blocked progress.')
/** Display-only model interpretation. Never execution authority or a user quotation. */
export const workFocusInferenceSchema = z.object({
  category: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(500),
  motivation: z.string().trim().min(1).max(1000),
  evidence: z.array(z.object({
    id: z.string().min(1).max(512), physicalId: z.string().min(1).max(1024),
  }).strict()).min(1).max(12),
}).strict()
export const botWorkSourceSchema = z.object({
  projectId: z.string().min(1).max(512), botId: z.string().min(1).max(128), bindingKey: z.string().min(1).max(2048),
  revision: z.string().min(1).max(512), sessionId: z.string().min(1).max(512), sourceInputId: z.string().min(1).max(512),
  idempotencyKey: z.string().min(1).max(200), fingerprint: z.string().length(64),
  title: z.string().min(1).max(160), definition: workDefinitionSchema,
  supplements: z.array(z.object({
    id: z.string().uuid(), idempotencyKey: z.string().min(1).max(200), fingerprint: z.string().length(64),
    content: z.string().min(1).max(4000), revision: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512), sourceInputId: z.string().min(1).max(512), at: z.string().datetime(),
  }).strict()).max(100),
}).strict()
export const workRecordSchema = z.object({
  /** Host-owned automatic execution receipt; never an authorization grant. */
  automaticExecution: workDispatchExecutionSchema.optional(),
  /** Host-stamped external intake, never an assignment or owner authorization. */
  botSource: botWorkSourceSchema.optional(),
  key: z.string().min(1).max(600), subject: workSubjectSchema,
  revision: z.number().int().positive(), sequence: z.number().int().positive(),
  definition: workDefinitionSchema,
  origin: z.enum(['human', 'agent_interpretation']),
  changedBy: z.string().min(1), changedAt: z.string().datetime(),
  change: z.enum(['understanding', 'goal', 'authorization', 'pause']), reason: text, paused: z.boolean(),
  /** Immutable creation request identity; scoped by the owning Project database. */
  creationRequest: z.object({ creator: z.string().min(1), key: z.string().min(1).max(200), fingerprint: z.string().length(64) }).strict().optional(),
  requestSource: decisionEvidenceSchema.extend({ kind: z.literal('user') }).optional(),
  workflow: workWorkflowSchema.optional(),
  notes: workNotesSchema.optional(),
  observation: z.object({
    sessionId: z.string().min(1).max(512),
    sources: z.array(z.object({
      id: z.string().min(1).max(512), physicalId: z.string().min(1).max(1024),
    }).strict()).max(12),
    observedAt: z.string().datetime(),
    focus: workFocusInferenceSchema.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.focus && !value.focus.evidence.every(ref => value.sources.some(source =>
      source.id === ref.id && source.physicalId === ref.physicalId))) {
      ctx.addIssue({ code: 'custom', path: ['focus', 'evidence'], message: 'Focus evidence must reference observation sources.' })
    }
  }).optional(),
}).strict()
/** Storage-only compatibility: discard only named retired fields, validate everything else strictly.
 * Do not use for current writes or wire input. Historical proposals confer no authority.
 */
export function parseStoredWorkRecord(value: unknown): WorkRecord {
  return workRecordSchema.parse(omitRetiredStoredWorkFields(value))
}

/** Work audit payloads may be partial snapshots; omit only the same top-level retired keys. */
export function omitRetiredStoredWorkFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { adoption: _adoption, checkpoint: _checkpoint, transition: _transition,
    answerReview: _answerReview, handoffFrom: _handoffFrom, successors: _successors,
    proposals: _proposals, ...current } = value as Record<string, unknown>
  return current
}
export type WorkRecord = z.infer<typeof workRecordSchema>
export interface WorkStamp { key: string; revision: number; assignmentRevision?: number }
export const workStampsSchema = z.array(z.object({
  key: z.string().min(1).max(600), revision: z.number().int().positive(),
  assignmentRevision: z.number().int().positive().optional(),
}).strict()).max(100)

/** Historical effect/decision receipts only; current input remains strict. */
export function parseStoredWorkStamps(value: unknown): WorkStamp[] {
  return workStampsSchema.parse(Array.isArray(value) ? value.map(stamp => {
    if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) return stamp
    const { adoptionId: _adoptionId, ...current } = stamp as Record<string, unknown>
    return current
  }) : value)
}
export interface WorkAuthority { manager: string | null; executor: string | null; active: boolean }
export function workKey(subject: WorkSubject): string {
  if (subject.kind === 'work') return `work:${subject.id}`
  if (subject.kind === 'initiative') return `initiative:${subject.initiativeId}`
  return subject.kind === 'topic' ? `topic:${subject.sessionId}` : `item:${subject.itemId}`
}

export const WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_contracts (
 id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, data TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS work_contract_events (
 id TEXT PRIMARY KEY, work_key TEXT NOT NULL, actor TEXT NOT NULL,
 kind TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS work_contract_events_key ON work_contract_events(work_key, created_at);
CREATE TABLE IF NOT EXISTS work_effects (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL,
 status TEXT NOT NULL, stamps TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS work_focus (
 session_id TEXT PRIMARY KEY, work_key TEXT REFERENCES work_contracts(id)
) STRICT;
`
export const workCompletionReferenceSchema = z.object({
  key: z.string().min(1).max(600), completionId: z.string().min(1).max(700),
}).strict()
export const workCompletionReadSchema = z.object({
  items: z.array(workCompletionReferenceSchema).max(5000),
}).strict()
export const workCompletionsSchema = z.object({
  items: z.array(workCompletionReferenceSchema.extend({
    sequence: z.number().int().positive(), completedAt: z.string().datetime().nullable(), unread: z.boolean(),
  }).strict()),
}).strict()
export type WorkCompletion = z.infer<typeof workCompletionsSchema>['items'][number]

/** Separate presentation receipts: never Work progress, acceptance or agent input. */
export const WORK_COMPLETION_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_completions (
 id TEXT PRIMARY KEY, work_key TEXT NOT NULL REFERENCES work_contracts(id),
 sequence INTEGER NOT NULL, completed_at TEXT,
 UNIQUE(work_key, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS work_completion_reads (
 principal TEXT NOT NULL, completion_id TEXT NOT NULL REFERENCES work_completions(id),
 read_at TEXT NOT NULL, PRIMARY KEY(principal, completion_id)
) STRICT;
`
export class WorkConflict extends Error {}

export const workObservationSchema = z.object({
  sessionId: z.string().min(1).max(512),
  parentSessionId: z.string().max(512).optional(),
  version: z.number().int().positive(),
  processed: z.number().int().nonnegative(),
  events: z.array(z.object({
    id: z.string().min(1).max(512), physicalId: z.string().min(1).max(1024),
    kind: z.enum(['request', 'delegation', 'result']),
    text: z.string().max(6000), at: z.string().datetime(),
  }).strict()).max(12),
  error: z.string().max(2000).optional(),
}).strict()
export type WorkObservation = z.infer<typeof workObservationSchema>
