type SubmitKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'keyCode' | 'repeat' | 'defaultPrevented'>

export function composerSubmitIntent(event: SubmitKey, mobile: boolean): 'send' | 'queue' | null {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229
    || event.repeat || event.defaultPrevented || mobile && !event.ctrlKey && !event.metaKey) return null
  return event.ctrlKey ? 'queue' : 'send'
}
