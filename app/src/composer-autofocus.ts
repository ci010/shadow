type ComposerKey = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented' | 'keyCode'>

export function isComposerFocusKey(event: ComposerKey): boolean {
  if (event.defaultPrevented || event.isComposing
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  // IMEs may report Process/229 before composition starts. Never synthesize text from this key.
  if (event.key === 'Process' || event.keyCode === 229) {
    return /^(Key[A-Z]|Digit[1-9]|Backspace)$/.test(event.code)
  }
  return /^[a-z1-9]$/i.test(event.key) || event.key === 'Backspace'
}

export function canRedirectComposerKey(event: ComposerKey, context: {
  available: boolean
  editing: boolean
  overlayOpen: boolean
}): boolean {
  return context.available && !context.editing && !context.overlayOpen && isComposerFocusKey(event)
}
