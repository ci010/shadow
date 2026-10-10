import { z } from 'zod'
import { decisionEvidenceSchema, parseDecisionEvidence } from '../sessions/decision-brief.ts'
import { workNotesSchema } from './work-notes.ts'

const text = z.string().trim().min(1).max(2000)
const longText = z.string().trim().min(1).max(4000)
const list = z.array(text).max(12)
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
export const workAdoptionSchema = z.object({
  understanding: text, stop: list.default([]), retain: list.default([]), next: list.min(1),
}).strict()
export const workInventorySchema = z.object({
  completed: list, artifacts: list, inFlight: list, unknown: list, retired: list,
}).strict()
export type WorkInventory = z.infer<typeof workInventorySchema>
export const workChangeSchema = z.object({
  subject: workSubjectSchema, expectedRevision: z.number().int().min(0),
  change: z.enum(['understanding', 'goal', 'authorization', 'pause']),
  reason: text, definition: workDefinitionSchema, paused: z.boolean().default(false),
}).strict()
export type WorkChange = z.infer<typeof workChangeSchema>

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
export const workProposalSchema = z.object({
  id: z.string().uuid(),
  baseRevision: z.number().int().positive(),
  assignmentRevision: z.number().int().positive().optional(),
  change: workChangeSchema.shape.change,
  reason: text, definition: workDefinitionSchema, paused: z.boolean(),
  status: z.enum(['pending', 'applied', 'rejected']),
  appliedRevision: z.number().int().positive().optional(),
  request: z.object({ sessionId: z.string(), physicalId: z.string(), requestId: z.string() }).strict().optional(),
}).strict()
export type WorkProposal = z.infer<typeof workProposalSchema>
export const workDecisionSchema = workProposalSchema.pick({
  id: true, baseRevision: true, assignmentRevision: true, change: true, reason: true, definition: true, paused: true,
}).extend({ key: z.string().min(1).max(600) }).strict()
export type WorkDecision = z.infer<typeof workDecisionSchema>
export const WORK_APPROVE = 'Apply this work proposal'
export const WORK_REJECT = 'Keep the current work unchanged'

export const workRecordSchema = z.object({
  key: z.string().min(1).max(600), subject: workSubjectSchema,
  revision: z.number().int().positive(), sequence: z.number().int().positive(),
  definition: workDefinitionSchema,
  origin: z.enum(['human', 'agent_interpretation']),
  changedBy: z.string().min(1), changedAt: z.string().datetime(),
  change: workChangeSchema.shape.change, reason: text, paused: z.boolean(),
  requestSource: decisionEvidenceSchema.extend({ kind: z.literal('user') }).optional(),
  adoption: workAdoptionSchema.extend({
    id: z.string().uuid(), sessionId: z.string().min(1), revision: z.number().int().positive(),
  }).strict().optional(),
  checkpoint: workInventorySchema.extend({
    sessionId: z.string().min(1), revision: z.number().int().positive(),
  }).strict().optional(),
  transition: z.object({
    id: z.string().uuid(), strategy: z.enum(['fresh', 'successor']),
    sessionId: z.string().min(1), revision: z.number().int().positive(),
    status: z.enum(['pending', 'applied']), successorId: z.string().optional(),
  }).strict().optional(),
  answerReview: z.object({ requestId: z.string().min(1), text: longText }).strict().optional(),
  handoffFrom: z.object({ key: z.string().min(1), sessionId: z.string().min(1) }).strict().optional(),
  successors: z.array(z.object({ sessionId: z.string().min(1), fromSessionId: z.string().min(1) }).strict()).max(100).optional(),
  workflow: workWorkflowSchema.optional(),
  proposals: z.array(workProposalSchema).max(100).optional(),
  notes: workNotesSchema.optional(),
  observation: z.object({
    sessionId: z.string().min(1).max(512),
    sources: z.array(z.object({
      id: z.string().min(1).max(512), physicalId: z.string().min(1).max(1024),
    }).strict()).max(12),
    observedAt: z.string().datetime(),
  }).strict().optional(),
}).strict()
export type WorkRecord = z.infer<typeof workRecordSchema>
export interface WorkStamp { key: string; revision: number; adoptionId?: string; assignmentRevision?: number }
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
