import { z } from 'zod'
import { parseDecisionEvidence } from '../sessions/decision-brief.ts'

const text = z.string().trim().min(1).max(2000)
const longText = z.string().trim().min(1).max(4000)
const list = z.array(text).max(12)
export const workSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('topic'), sessionId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('item'), initiativeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    itemId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
])
export type WorkSubject = z.infer<typeof workSubjectSchema>
export type WorkActor = { kind: 'user' } | { kind: 'session'; sessionId: string }
export const workDefinitionSchema = z.object({
  objective: longText,
  acceptance: z.array(longText).min(1).max(12), boundaries: z.array(longText).max(12),
  evidence: z.array(z.unknown().transform(value => parseDecisionEvidence(value))).max(8).default([]),
}).strict()
export type WorkDefinition = z.infer<typeof workDefinitionSchema>
export const workAdoptionSchema = z.object({
  understanding: text, stop: list, retain: list, next: list.min(1),
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

export const workRecordSchema = z.object({
  key: z.string().min(1).max(600), subject: workSubjectSchema,
  revision: z.number().int().positive(), sequence: z.number().int().positive(),
  definition: workDefinitionSchema,
  origin: z.enum(['human', 'agent_interpretation']),
  changedBy: z.string().min(1), changedAt: z.string().datetime(),
  change: workChangeSchema.shape.change, reason: text, paused: z.boolean(),
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
}).strict()
export type WorkRecord = z.infer<typeof workRecordSchema>
export interface WorkStamp { key: string; revision: number; adoptionId?: string }
export interface WorkAuthority { manager: string | null; executor: string | null; active: boolean }
export function workKey(subject: WorkSubject): string {
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
