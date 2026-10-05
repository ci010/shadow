import { z } from 'zod'

export const MAX_FILE_CHANGE_CHARS = 64 * 1024
const line = z.number().int().nonnegative().safe()
const hunk = z.object({
  oldStart: line, oldLines: line, newStart: line, newLines: line,
  lines: z.array(z.string()).max(4096),
}).refine(value => value.lines.every(text => /^[ +\\-]/.test(text))
  && value.lines.filter(text => /^[ -]/.test(text)).length === value.oldLines
  && value.lines.filter(text => /^[ +]/.test(text)).length === value.newLines, 'Invalid diff hunk')

export const fileChangeSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  timestamp: z.string().datetime().optional(),
  path: z.string().min(1).max(4096),
  mode: z.enum(['write', 'edit', 'append']),
  scope: z.enum(['file', 'requested-edit', 'written-content']),
  hunks: z.array(hunk).max(1024),
  unavailable: z.string().optional(),
  writtenContent: z.string().max(MAX_FILE_CHANGE_CHARS).optional(),
}).refine(value => JSON.stringify(value.hunks).length <= MAX_FILE_CHANGE_CHARS, 'Recorded diff exceeds its limit')

export type RecordedFileChange = z.infer<typeof fileChangeSchema>

export const fileChangesPageSchema = z.object({
  changes: z.array(fileChangeSchema).max(30),
  total: line,
  offset: line,
})
export type FileChangesPage = z.infer<typeof fileChangesPageSchema>
