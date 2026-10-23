import { z } from 'zod'
import { parsePatch } from 'diff'

export const MAX_FILE_CHANGE_CHARS = 64 * 1024
const line = z.number().int().nonnegative().safe()
const hunk = z.object({
  oldStart: line, oldLines: line, newStart: line, newLines: line,
  lines: z.array(z.string()).max(4096),
}).refine(value => value.lines.every(text => /^[ +-]/.test(text) || text === '\\ No newline at end of file')
  && value.lines.filter(text => /^[ -]/.test(text)).length === value.oldLines
  && value.lines.filter(text => /^[ +]/.test(text)).length === value.newLines, 'Invalid diff hunk')

export type FileChangeHunk = z.infer<typeof hunk>

export function formatFilePatch(hunks: readonly FileChangeHunk[]): string {
  return hunks.map(hunk =>
    `@@ -${hunk.oldLines ? hunk.oldStart : hunk.oldStart - 1},${hunk.oldLines} +${hunk.newLines ? hunk.newStart : hunk.newStart - 1},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`,
  ).join('')
}

/** Only canonical, headerless unified hunks belong in a file-change record. */
export function parseFilePatch(patch: string): FileChangeHunk[] {
  if (patch.length > MAX_FILE_CHANGE_CHARS) throw new Error('Recorded patch exceeds its limit.')
  if (!patch) return []
  const files = parsePatch(patch)
  if (files.length !== 1) throw new Error('Expected one recorded file patch.')
  const hunks = z.array(hunk).max(1024).parse(files[0].hunks)
  if (formatFilePatch(hunks) !== patch) throw new Error('Invalid recorded patch.')
  return hunks
}

function validPatch(patch: string): boolean {
  try { parseFilePatch(patch); return true }
  catch { return false }
}

export const fileChangeSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  timestamp: z.string().datetime().optional(),
  path: z.string().min(1).max(4096),
  mode: z.enum(['write', 'edit', 'append']),
  patch: z.string().max(MAX_FILE_CHANGE_CHARS).refine(validPatch, 'Invalid recorded patch'),
  unavailable: z.string().optional(),
  writtenContent: z.string().max(MAX_FILE_CHANGE_CHARS).optional(),
})

export type RecordedFileChange = z.infer<typeof fileChangeSchema>

export const fileChangesPageSchema = z.object({
  changes: z.array(fileChangeSchema).max(30),
  total: line,
  offset: line,
})
export type FileChangesPage = z.infer<typeof fileChangesPageSchema>
