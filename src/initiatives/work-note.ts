import { z } from 'zod'
import { workKeySchema } from './work-key.ts'

export const workNoteIdSchema = z.string().uuid()
const body = z.string().trim().min(1).max(2000)
export const workNoteInputSchema = z.object({
  workKey: workKeySchema,
  body: z.string().transform(value => value.replace(/\r\n?/g, '\n')).pipe(body),
  replyTo: workNoteIdSchema.optional(),
  notifyManager: z.boolean().optional(),
}).strict().refine(input => input.replyTo === undefined || input.notifyManager === undefined,
  { path: ['notifyManager'], message: 'A reply automatically notifies the original author.' })
export const workNoteSchema = z.object({
  id: workNoteIdSchema, workKey: workKeySchema, author: z.string().min(1).max(512),
  createdAt: z.string().datetime(), body, replyTo: workNoteIdSchema.optional(),
}).strict()
export type WorkNote = z.infer<typeof workNoteSchema>
export type WorkNoteReceipt = { note: WorkNote; notification: 'queued' | 'not_queued' }
export const workNotePath = (workKey: string, id: string) => `v:works/keys/${encodeURIComponent(workKey)}/comments/id/${id}`

export const WORK_NOTE_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_notes (
  append_order INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  work_key TEXT NOT NULL REFERENCES work_contracts(id),
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  UNIQUE(work_key, id),
  FOREIGN KEY(work_key, reply_to) REFERENCES work_notes(work_key, id)
) STRICT;
CREATE INDEX IF NOT EXISTS work_notes_key_order ON work_notes(work_key, append_order DESC);
`
