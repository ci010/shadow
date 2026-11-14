/** Consume one wheel axis only; preserve pinch/zoom and let unconsumed edges bubble. */
export function scrollEditorTabs(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'preventDefault'>, strip: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): boolean {
  if (event.ctrlKey || event.metaKey) return false
  const max = strip.scrollWidth - strip.clientWidth
  if (max <= 0) return false
  // Trackpads already supply horizontal movement. Never add their vertical axis.
  const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
  const movement = Math.max(-strip.clientWidth, Math.min(strip.clientWidth, delta * scale))
  if (!Number.isFinite(movement)) return false
  const next = Math.max(0, Math.min(max, strip.scrollLeft + movement))
  if (next === strip.scrollLeft) return false
  strip.scrollLeft = next
  event.preventDefault()
  return true
}

/** Reveal within the strip only, not scrollIntoView's page/ancestor chain. */
export function revealEditorTab(tab: HTMLElement) {
  const strip = tab.closest<HTMLElement>('.editor-tabs')
  const item = tab.closest<HTMLElement>('.editor-tab')
  if (!strip || !item) return
  const view = strip.getBoundingClientRect(), bounds = item.getBoundingClientRect()
  if (bounds.left < view.left) strip.scrollLeft -= view.left - bounds.left
  else if (bounds.right > view.right) strip.scrollLeft += bounds.right - view.right
}
