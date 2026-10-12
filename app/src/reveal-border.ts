/** Deliberate surface opt-ins, never generic borders or large panels. */
const MESSAGE_TARGETS = '.chat-bubble.chat-user, .chat-bubble.chat-assistant, .message-preview-card'
export const REVEAL_TARGETS = `.reveal-border, .provider-card, .work-item-card, .composer-box, .chat-working, .context-chip, .session-work-triggers > button, ${MESSAGE_TARGETS}`
export const REVEAL_REACH = 72
const EXCLUDED = ':focus-within, :disabled, [aria-disabled="true"], [aria-invalid="true"], [aria-selected="true"], [aria-current], .selected, .execution-selected, .event-selected, .active, [aria-expanded="true"], .waiting, .error, .is-error, .invalid, .attachment-drop-target, .composer-answering, .composer-working, :has([aria-invalid="true"]), :has(.composer-control[aria-expanded="true"]), [data-reveal-disabled]'

/** Distance to the perimeter, from outside or inside (not to the centre). */
export function borderDistance(x: number, y: number, rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right)
  const dy = Math.max(rect.top - y, 0, y - rect.bottom)
  return dx || dy ? Math.hypot(dx, dy) : Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y)
}

/** DOM-only registry + viewport shortlist; one pending pointer frame, no idle loop. */
export function installRevealBorder(doc: Document = document): () => void {
  const win = doc.defaultView
  // Fail closed on old engines rather than fall back to scanning full histories.
  if (!win || !win.IntersectionObserver || !win.MutationObserver) return () => {}
  const fine = win.matchMedia('(hover: hover) and (pointer: fine)')
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  const registered = new Set<HTMLElement>()
  const visible = new Set<HTMLElement>()
  const decorated = new Set<HTMLElement>()
  const active = new Set<HTMLElement>()
  const values = new Map<HTMLElement, { x: number; y: number; opacity: number }>()
  const fading = new Map<HTMLElement, number>()
  let frame = 0
  let point: { x: number; y: number } | undefined
  let disposed = false
  const enabled = () => fine.matches && !reduced.matches && !doc.hidden
  function reset() {
    point = undefined
    if (frame) win!.cancelAnimationFrame(frame)
    frame = 0
    for (const element of active) fade(element)
    active.clear()
  }
  function cancelFade(element: HTMLElement) {
    const timer = fading.get(element)
    if (timer !== undefined) win!.clearTimeout(timer)
    fading.delete(element)
  }
  function fade(element: HTMLElement) {
    if (fading.has(element)) return
    element.style.setProperty('--reveal-opacity', '0')
    const value = values.get(element)
    if (value) value.opacity = 0
    // The CSS fade lasts 180ms. A one-shot grace period retains the complete
    // visible transition; cancellation prevents an old fade deleting reactivation.
    fading.set(element, win!.setTimeout(() => {
      fading.delete(element)
      if (!active.has(element)) cleanupElement(element)
    }, 220))
  }
  function cleanupElement(element: HTMLElement) {
    cancelFade(element)
    values.delete(element)
    if (!decorated.has(element)) return
    element.classList.remove('reveal-border-target')
    for (const name of ['--reveal-x', '--reveal-y', '--reveal-opacity']) element.style.removeProperty(name)
    decorated.delete(element)
    active.delete(element)
  }
  const intersection = new win.IntersectionObserver(entries => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement
      if (!registered.has(element)) continue
      if (entry.isIntersecting) visible.add(element)
      else {
        visible.delete(element)
        if (active.delete(element)) fade(element)
      }
    }
  }, { rootMargin: `${REVEAL_REACH}px` })
  function reconcile(element: HTMLElement) {
    // Vue may replace the whole class attribute, including our decoration.
    if (decorated.has(element) && !element.classList.contains('reveal-border-target')) cleanupElement(element)
    if (element.isConnected && element.matches(REVEAL_TARGETS)) {
      if (!registered.has(element)) {
        registered.add(element)
        intersection.observe(element)
      }
    } else if (registered.delete(element)) {
      intersection.unobserve(element)
      visible.delete(element)
      cleanupElement(element)
    }
  }
  function scan(node: Node) {
    if (!(node instanceof win!.HTMLElement)) return
    reconcile(node)
    if (node.firstElementChild) for (const element of node.querySelectorAll<HTMLElement>(REVEAL_TARGETS)) reconcile(element)
  }
  // Class changes can opt Vue-reused nodes in/out. Ignore our own decoration
  // class, and do not observe style (pointer writes) or streaming characterData.
  const classes = (value: string | null) => (value ?? '').split(/\s+/).filter(c => c && c !== 'reveal-border-target').sort().join(' ')
  const mutation = new win.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const element = record.target as HTMLElement
        if (classes(record.oldValue) !== classes(element.getAttribute('class'))) reconcile(element)
      } else {
        for (const node of record.addedNodes) scan(node)
        for (const node of record.removedNodes) {
          if (!(node instanceof win!.HTMLElement)) continue
          // Walk only the removed subtree, not the history registry per removed
          // node. Membership also catches targets with classes changed pre-removal.
          if (registered.has(node)) reconcile(node)
          const walker = doc.createTreeWalker(node, win!.NodeFilter.SHOW_ELEMENT)
          for (let child = walker.nextNode(); child; child = walker.nextNode()) {
            const element = child as HTMLElement
            if (registered.has(element)) reconcile(element)
          }
        }
      }
    }
  })
  scan(doc.documentElement)
  mutation.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
  function update() {
    frame = 0
    if (!point || !enabled() || disposed) return reset()
    const { x, y } = point
    const nearby: Array<{ element: HTMLElement; x: number; y: number; opacity: number }> = []
    // Read only the observer's viewport shortlist, all reads before writes.
    for (const element of visible) {
      if (!element.isConnected || element.matches(EXCLUDED) || element.closest('[inert], [aria-hidden="true"], fieldset:disabled, [aria-disabled="true"]')) continue
      const rect = element.getBoundingClientRect()
      const message = element.matches(MESSAGE_TARGETS)
      if (!rect.width || !rect.height || (!message && (rect.height > 320 || rect.width > 1000)) || rect.bottom < -REVEAL_REACH || rect.top > win!.innerHeight + REVEAL_REACH || rect.right < -REVEAL_REACH || rect.left > win!.innerWidth + REVEAL_REACH) continue
      const distance = borderDistance(x, y, rect)
      if (distance >= REVEAL_REACH) continue
      nearby.push({ element, x: x - rect.left, y: y - rect.top, opacity: (1 - distance / REVEAL_REACH) * 0.7 })
    }
    const next = new Set(nearby.map(item => item.element))
    for (const element of active) if (!next.has(element)) fade(element)
    active.clear()
    for (const item of nearby) {
      active.add(item.element)
      cancelFade(item.element)
      const previous = values.get(item.element)
      if (!decorated.has(item.element)) {
        decorated.add(item.element)
        item.element.classList.add('reveal-border-target')
      }
      if (previous?.x !== item.x) item.element.style.setProperty('--reveal-x', `${item.x}px`)
      if (previous?.y !== item.y) item.element.style.setProperty('--reveal-y', `${item.y}px`)
      if (previous?.opacity !== item.opacity) item.element.style.setProperty('--reveal-opacity', String(item.opacity))
      values.set(item.element, { x: item.x, y: item.y, opacity: item.opacity })
    }
  }
  function move(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || !enabled()) return reset()
    point = { x: event.clientX, y: event.clientY }
    if (!frame) frame = win!.requestAnimationFrame(update)
  }
  function stateChanged() {
    reset()
    if (!enabled()) for (const element of decorated) cleanupElement(element)
  }
  doc.addEventListener('pointermove', move, { passive: true })
  doc.addEventListener('pointerleave', reset)
  doc.addEventListener('pointercancel', reset)
  doc.addEventListener('scroll', reset, { capture: true, passive: true })
  doc.addEventListener('focusin', reset)
  doc.addEventListener('visibilitychange', stateChanged)
  win.addEventListener('blur', reset)
  win.addEventListener('resize', reset)
  fine.addEventListener('change', stateChanged)
  reduced.addEventListener('change', stateChanged)
  return () => {
    disposed = true
    mutation.disconnect()
    intersection.disconnect()
    reset()
    for (const element of decorated) cleanupElement(element)
    registered.clear()
    visible.clear()
    doc.removeEventListener('pointermove', move)
    doc.removeEventListener('pointerleave', reset)
    doc.removeEventListener('pointercancel', reset)
    doc.removeEventListener('scroll', reset, true)
    doc.removeEventListener('focusin', reset)
    doc.removeEventListener('visibilitychange', stateChanged)
    win.removeEventListener('blur', reset)
    win.removeEventListener('resize', reset)
    fine.removeEventListener('change', stateChanged)
    reduced.removeEventListener('change', stateChanged)
  }
}
