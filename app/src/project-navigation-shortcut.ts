export function projectNavigationShortcut(event: Pick<KeyboardEvent, 'defaultPrevented' | 'repeat' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>): 'knowledge' | 'workflows' | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey
    || !(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  return key === 'k' ? 'knowledge' : key === 'j' ? 'workflows' : undefined
}
