import type { LineChanges } from './line-changes.ts'

export const MAX_WRITE_REGIONS = 4
export const MAX_WRITE_RESULT_CHARS = 8000

export interface ReplacementResult {
  content: string
  strategy: 'exact' | 'line-trimmed' | 'indentation-flexible'
  count: number
  /** Character offsets in the resulting text; end is exclusive. */
  ranges: Array<{ start: number; end: number }>
}

interface WriteResult {
  path: string
  mode: 'write' | 'edit' | 'append'
  content: string
  writtenBytes: number
  lineChanges?: LineChanges
  edit?: ReplacementResult
  appendStart?: number
  unchanged?: boolean
  normalizedNewlines?: boolean
  global?: boolean
  /** Append-only preview when the previous remote contents could not be read. */
  boundaryUnavailable?: string
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') + ' ... [truncated]'
}

/** Describe successful writes without claiming a separate read-back verification. */
export function formatWriteResult(result: WriteResult): string {
  const lines = result.content ? result.content.split('\n') : []
  if (result.content.endsWith('\n')) lines.pop()
  const starts = [0]
  for (let i = 0; i < result.content.length; i++) {
    if (result.content[i] === '\n') starts.push(i + 1)
  }
  const lineAt = (offset: number): number => {
    let low = 0
    let high = starts.length
    while (low + 1 < high) {
      const mid = (low + high) >>> 1
      if (starts[mid] <= offset) low = mid
      else high = mid
    }
    return low + 1
  }
  const output = [
    `Success: ${result.mode} ${clip(result.path.replace(/\r/g, '\\r').replace(/\n/g, '\\n'), 1000)}`,
    `UTF-8 bytes written: ${result.writtenBytes}; ${result.boundaryUnavailable ? 'appended text' : 'result'} lines: ${lines.length}.`,
    result.lineChanges?.added !== undefined
      ? `Line changes: +${result.lineChanges.added} -${result.lineChanges.removed}.`
      : 'Line changes: unavailable.',
  ]
  if (result.lineChanges?.added === undefined) {
    output.push(`Line changes unavailable: ${clip(result.lineChanges?.unavailable ?? 'Previous file text was not observed.', 500)}`)
  }
  output.push(
    'Preview uses written text and pre-write context, not a post-write read-back.',
  )
  if (result.unchanged) output.push('Content unchanged.')
  if (result.normalizedNewlines) output.push('CRLF line endings were normalized to LF.')
  const samples = new Set<number>()
  const columns = new Map<number, Set<number>>()
  const focus = (offset: number) => {
    const line = lineAt(offset)
    const anchors = columns.get(line) ?? new Set<number>()
    anchors.add(offset - starts[line - 1])
    columns.set(line, anchors)
  }
  const sample = (from: number, to: number) => {
    for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) samples.add(i)
  }
  if (result.edit) {
    const edit = result.edit
    output.push(`Replacements: ${edit.count}; match: ${edit.strategy}.`)
    if (result.global && edit.strategy !== 'exact') output.push('Global flag: the fuzzy fallback replaces one region only.')
    for (const range of edit.ranges) {
      focus(range.start)
      focus(Math.max(range.start, range.end - 1))
      const start = lineAt(range.start)
      const end = lineAt(Math.max(range.start, range.end - 1))
      output.push(range.start === range.end ? `Empty replacement at L${start}.` : `Written range: L${start}-L${end}.`)
      sample(start - 2, start + 2)
      sample(end - 2, end + 2)
    }
    if (edit.count > edit.ranges.length) output.push(`Showing first ${edit.ranges.length} of ${edit.count} replacement boundaries.`)
  } else if (result.mode === 'append' && result.appendStart !== undefined) {
    focus(result.appendStart)
    focus(Math.max(result.appendStart, result.content.length - 1))
    const start = lineAt(result.appendStart)
    const end = lineAt(Math.max(result.appendStart, result.content.length - 1))
    output.push(result.appendStart === result.content.length ? 'No text appended.' : `Appended range: L${start}-L${end}.`)
    sample(start - 2, start + 2)
    sample(lines.length - 2, lines.length)
  } else {
    focus(0)
    focus(Math.max(0, result.content.length - 1))
    sample(1, 3)
    sample(lines.length - 2, lines.length)
  }
  if (result.boundaryUnavailable) {
    output.push(`Append boundary unavailable: ${result.boundaryUnavailable}`)
    output.push('Line numbers below are relative to the appended text, not the whole file.')
  }
  if (!lines.length) output.push(result.boundaryUnavailable ? '(Appended text is empty.)' : '(File is empty.)')
  let previous = 0
  let snippets = 0
  for (const number of [...samples].sort((a, b) => a - b).slice(0, 24)) {
    if (snippets >= 24) break
    if (number > previous + 1) output.push(`... lines ${previous + 1}-${number - 1} omitted ...`)
    const text = lines[number - 1].replace(/\r$/, '')
    const windows = new Set([...columns.get(number) ?? [0]].map(column => Math.max(0, Math.min(column - 60, text.length - 180))))
    for (const start of windows) {
      if (snippets >= 24) { output.push('... additional boundary snippets omitted ...'); break }
      let from = start
      let end = Math.min(text.length, start + 180)
      if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from])) from--
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      output.push(text.length <= 180 ? `L${number}: ${text}`
        : `L${number} (UTF-16 columns ${from + 1}-${end}): ${from ? '... ' : ''}${text.slice(from, end)}${end < text.length ? ' ... [truncated]' : ''}`)
      snippets++
    }
    previous = number
  }
  if (previous < lines.length) output.push(`... lines ${previous + 1}-${lines.length} omitted ...`)
  return clip(output.join('\n'), MAX_WRITE_RESULT_CHARS - 20)
}
