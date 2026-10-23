import type { FileHighlightToken } from './file-highlighting.ts'

export function splitHighlightLines(tokens: readonly FileHighlightToken[]): FileHighlightToken[][] {
  const lines: FileHighlightToken[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i) lines.push([])
      if (parts[i]) lines.at(-1)!.push({ ...token, text: parts[i]! })
    }
  }
  return lines
}

export function quoteDiffSelection(root: HTMLElement, range: Range, path: string, text: string): string | undefined {
  const oldLines: number[] = []
  const newLines: number[] = []
  for (const row of root.querySelectorAll<HTMLElement>('[data-diff-row]')) {
    const code = row.querySelector('.diff-code')
    if (!code || !range.intersectsNode(code)) continue
    const selected = root.ownerDocument.createRange()
    selected.selectNodeContents(code)
    if (range.compareBoundaryPoints(Range.START_TO_START, selected) > 0) selected.setStart(range.startContainer, range.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, selected) < 0) selected.setEnd(range.endContainer, range.endOffset)
    if (!selected.toString().length) continue
    for (const [attribute, lines] of [['data-old-line', oldLines], ['data-new-line', newLines]] as const) {
      const value = row.getAttribute(attribute)
      if (value && Number.isSafeInteger(Number(value)) && Number(value) > 0) lines.push(Number(value))
    }
  }
  if (!oldLines.length && !newLines.length) return
  const span = (lines: number[]) => {
    const min = Math.min(...lines)
    const max = Math.max(...lines)
    return min === max ? `${min}` : `${min}-${max}`
  }
  return [
    `File: ${JSON.stringify(path)}`,
    'Diff: HEAD -> working tree',
    ...(oldLines.length ? [`HEAD lines: ${span(oldLines)}`] : []),
    ...(newLines.length ? [`Working tree lines: ${span(newLines)}`] : []),
    '', text,
  ].join('\n')
}
