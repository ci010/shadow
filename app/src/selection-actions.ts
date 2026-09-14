export function selectionAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>): 'quote' | 'copy' | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.repeat) return
  if (event.key === 'q') return 'quote'
  if (event.key === 'c') return 'copy'
}

export function insertQuote(draft: string, quote: string, start: number, end: number): { text: string; caret: number } {
  const before = draft.slice(0, start)
  const after = draft.slice(end)
  const block = quote.split(/\r?\n/).map(line => `> ${line}`).join('\n')
  const insertion = `${before && !before.endsWith('\n\n') ? '\n\n' : ''}${block}\n\n`
  return { text: before + insertion + after, caret: before.length + insertion.length }
}
