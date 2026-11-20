export function selectionAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>): 'quote' | 'copy' | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.repeat) return
  if (event.key === 'q') return 'quote'
  if (event.key === 'c') return 'copy'
}

export function insertQuote(draft: string, quote: string): { text: string; caret: number } {
  const block = quote.split(/\r?\n/).map(line => `> ${line}`).join('\n')
  const separator = !draft || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n'
  const text = `${draft}${separator}${block}\n\n`
  return { text, caret: text.length }
}
