import type { RecordedFileChange } from '../sessions/file-change-contract.ts'
import type { LineChanges } from './line-changes.ts'

export const MAX_WRITE_REGIONS = 4
export const MAX_WRITE_RESULT_CHARS = 1600

export interface ReplacementResult {
  content: string
  strategy: 'exact'
  count: number
  /** Character offsets in the resulting text; end is exclusive. */
  ranges: Array<{ start: number; end: number }>
}

interface WriteResult {
  mode: 'write' | 'edit' | 'append'
  change?: RecordedFileChange
  lineChanges: LineChanges
  edit?: ReplacementResult
  unchanged?: boolean
  global?: boolean
}

/** Detailed content stays in the session log, never in the default model receipt. */
export function formatWriteResult(result: WriteResult): string {
  const counts = result.lineChanges.added === undefined ? '' : ` +${result.lineChanges.added} -${result.lineChanges.removed}`
  const output = [`OK ${result.mode}${counts}${result.change ? ` edit=${result.change.id}` : ''}`]
  if (result.edit) output.push(`Replacements: ${result.edit.count}; match: ${result.edit.strategy}.`)
  if (result.unchanged) output.push('Content unchanged.')
  const unavailable = result.change?.unavailable ?? result.lineChanges.unavailable
  if (unavailable) output.push(`Diff unavailable: ${unavailable.slice(0, 500)}`)
  if (!result.change) output.push('Historical edit details were not recorded.')
  return output.join('\n')
}
