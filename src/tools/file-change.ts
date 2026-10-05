import { structuredPatch } from 'diff'
import { MAX_FILE_CHANGE_CHARS, type RecordedFileChange } from '../sessions/file-change-contract.ts'
import type { ExecutionContext } from './context.ts'
import { MAX_LINE_DIFF_CHARS, MAX_LINE_DIFF_EDITS, MAX_LINE_DIFF_LINES } from './line-changes.ts'
import { ToolOutcomeUnknownError } from './tool.ts'

export function recordedFileChange(options: {
  sessionId: string; toolCallId: string; path: string; mode: RecordedFileChange['mode']
  before?: string; after: string; unavailable?: string; scope?: RecordedFileChange['scope']; timestamp?: string
}): RecordedFileChange {
  const { before, after } = options
  const change: RecordedFileChange = {
    version: 1, id: crypto.randomUUID(), sessionId: options.sessionId, toolCallId: options.toolCallId,
    timestamp: options.timestamp ?? new Date().toISOString(), path: options.path, mode: options.mode,
    scope: options.scope ?? 'file', hunks: [],
  }
  if (before === undefined) change.unavailable = options.unavailable ?? 'The previous file content was not recorded.'
  else if (before.length + after.length > MAX_LINE_DIFF_CHARS
    || before.split('\n').length + after.split('\n').length > MAX_LINE_DIFF_LINES) {
    change.unavailable = 'This write exceeds the recorded diff size limit.'
  } else if (before !== after) {
    const patch = structuredPatch(options.path, options.path, before, after, '', '', {
      context: 3, stripTrailingCr: true, maxEditLength: MAX_LINE_DIFF_EDITS, timeout: 100,
    })
    if (!patch) change.unavailable = 'This write exceeds the recorded diff computation limit.'
    else if (patch.hunks.length > 1024 || patch.hunks.some(hunk => hunk.lines.length > 4096)
      || JSON.stringify(patch.hunks).length > MAX_FILE_CHANGE_CHARS) change.unavailable = 'This diff exceeds the recorded preview size limit.'
    else change.hunks = patch.hunks
  }
  if (change.unavailable && after.length <= MAX_FILE_CHANGE_CHARS) change.writtenContent = after
  return change
}

export async function recordFileWrite(context: ExecutionContext, options: {
  path: string; mode: RecordedFileChange['mode']; before?: string; after: string; unavailable?: string
}): Promise<void> {
  if (!context.recordFileChange || !context.toolCallId) return
  try {
    const after = options.after.length <= MAX_LINE_DIFF_CHARS ? Buffer.from(options.after, 'utf8').toString('utf8') : options.after
    await context.recordFileChange(recordedFileChange({ ...options, after, sessionId: context.sessionId, toolCallId: context.toolCallId }))
  } catch (cause) {
    throw new ToolOutcomeUnknownError('The file was written, but its historical diff could not be saved. Do not retry this write automatically.', { cause })
  }
}
