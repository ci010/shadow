export function projectNavigationShortcut(event: Pick<KeyboardEvent, 'defaultPrevented' | 'repeat' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>): 'knowledge' | 'workflows' | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey
    || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
  return event.shiftKey ? 'workflows' : 'knowledge'
}
