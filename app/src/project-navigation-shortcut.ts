export function projectNavigationShortcut(event: Pick<KeyboardEvent, 'defaultPrevented' | 'repeat' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'> & Partial<Pick<KeyboardEvent, 'target'>>): 'knowledge' | 'workflows' | 'board' | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey
    || !(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  if (key === 'b' && event.ctrlKey && !event.metaKey) {
    const target = event.target as Element | null | undefined
    if (target?.closest?.('input, textarea, select, [contenteditable], [role="textbox"], .xterm, [role="terminal"]')) return
    return 'board'
  }
  return key === 'k' ? 'knowledge' : key === 'j' ? 'workflows' : undefined
}
