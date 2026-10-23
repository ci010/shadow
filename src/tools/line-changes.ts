import { diffLines } from 'diff'

export const MAX_LINE_DIFF_CHARS = 2 * 1024 * 1024
export const MAX_LINE_DIFF_LINES = 50_000
export const MAX_LINE_DIFF_EDITS = 1024

export type LineChanges =
  | { added: number; removed: number; unavailable?: never }
  | { unavailable: string; added?: never; removed?: never }

function lineCount(text: string): number {
  if (!text) return 0
  let count = text.endsWith('\n') ? 0 : 1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

/** Exact line diff of observed text; resource limits produce unknown, never estimates. */
export function countLineChanges(before: string, after: string): LineChanges {
  if (before.length + after.length > MAX_LINE_DIFF_CHARS) {
    return { unavailable: `Text exceeds the ${MAX_LINE_DIFF_CHARS}-character diff limit.` }
  }
  const beforeLines = lineCount(before)
  const afterLines = lineCount(after)
  if (beforeLines + afterLines > MAX_LINE_DIFF_LINES) {
    return { unavailable: `Text exceeds the ${MAX_LINE_DIFF_LINES}-line diff limit.` }
  }
  if (!before || !after) return { added: afterLines, removed: beforeLines }
  const changes = diffLines(before, after, {
    stripTrailingCr: true,
    maxEditLength: MAX_LINE_DIFF_EDITS,
    timeout: 100,
  })
  if (!changes) {
    return { unavailable: `Diff exceeded the ${MAX_LINE_DIFF_EDITS}-edit or 100ms computation limit.` }
  }
  let added = 0
  let removed = 0
  for (const change of changes) {
    if (change.added) added += change.count
    if (change.removed) removed += change.count
  }
  return { added, removed }
}
