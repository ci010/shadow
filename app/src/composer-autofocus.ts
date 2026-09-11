type ComposerKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented' | 'keyCode'>

export function isComposerTypingKey(event: ComposerKey): boolean {
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
    && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && /^[a-z1-9]$/i.test(event.key)
}

export function canRedirectComposerKey(event: ComposerKey, context: {
  available: boolean
  editing: boolean
  overlayOpen: boolean
}): boolean {
  return context.available && !context.editing && !context.overlayOpen && isComposerTypingKey(event)
}
