/** Isolated-world observer. Renderer flags/events are never evidence of consent.
 * Only the mic button and the exact, focused Ctrl+Shift chord can authorize a
 * single microphone-only reservation. No tracks are opened by this observer.
 */
export function observeComposerMicrophoneGesture(
  win: Window,
  doc: Document,
  now: () => number = Date.now,
): { consume: () => boolean; dispose: () => void } {
  let expires = 0
  const clear = () => { expires = 0 }
  const available = () => doc.hasFocus() && !doc.hidden
  const observe = (event: Event) => {
    clear()
    if (!event.isTrusted || !available()) return
    if (event.type === 'keydown') {
      const key = event as KeyboardEvent
      if ((key.key !== 'Control' && key.key !== 'Shift') || key.repeat || key.isComposing
        || !key.ctrlKey || !key.shiftKey || key.altKey || key.metaKey) return
      if (!doc.querySelector('[data-composer-microphone][data-keyboard-active="true"]:not(:disabled)')) return
    } else {
      const pointer = event as MouseEvent
      if (pointer.button !== 0 || !(event.target instanceof (win as Window & typeof globalThis).Element)) return
      const button = event.target.closest('[data-composer-microphone]') as HTMLButtonElement | null
      if (!button || button.disabled) return
    }
    expires = now() + 1000
  }
  const visibility = () => { if (doc.hidden) clear() }
  const start = ['pointerdown', 'click', 'keydown'] as const
  const end = ['pointerup', 'pointercancel', 'keyup', 'blur', 'pagehide'] as const
  for (const type of start) win.addEventListener(type, observe, true)
  for (const type of end) win.addEventListener(type, clear, true)
  doc.addEventListener('visibilitychange', visibility, true)
  return {
    consume: () => { const allowed = available() && expires > now(); clear(); return allowed },
    dispose: () => {
      clear()
      for (const type of start) win.removeEventListener(type, observe, true)
      for (const type of end) win.removeEventListener(type, clear, true)
      doc.removeEventListener('visibilitychange', visibility, true)
    },
  }
}
