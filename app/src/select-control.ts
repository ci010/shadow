export interface SelectOption {
  value: unknown
  text: string
  disabled: boolean
  lang?: string
}

/** Native selects compare string and numeric values equivalently. */
export function selectValueEqual(left: unknown, right: unknown): boolean {
  const primitive = (value: unknown) => typeof value === 'string' || typeof value === 'number'
  return Object.is(left, right) || (primitive(left) && primitive(right) && String(left) === String(right))
}

export function moveSelectOption(options: readonly SelectOption[], current: number, direction: 1 | -1): number {
  for (let step = 1; step <= options.length; step++) {
    const index = (current + direction * step + options.length) % options.length
    if (!options[index]?.disabled) return index
  }
  return -1
}

export function findSelectOption(options: readonly SelectOption[], query: string, current: number): number {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return -1
  for (let step = 1; step <= options.length; step++) {
    const index = (current + step + options.length) % options.length
    const option = options[index]!
    if (!option.disabled && option.text.trim().toLocaleLowerCase().startsWith(normalized)) return index
  }
  return -1
}

/** Coordinates are layout-viewport CSS pixels (also handles a panned visual viewport). */
export function selectPopupPosition(
  anchor: { left: number; top: number; bottom: number; width: number },
  viewport: { width: number; height: number; left?: number; top?: number },
  desiredHeight = 288,
  desiredWidth = anchor.width,
) {
  const gutter = 8
  const gap = 4
  const leftEdge = (viewport.left ?? 0) + gutter
  const topEdge = (viewport.top ?? 0) + gutter
  const rightEdge = (viewport.left ?? 0) + viewport.width - gutter
  const bottomEdge = (viewport.top ?? 0) + viewport.height - gutter
  const below = Math.max(0, bottomEdge - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - gap - topEdge)
  const down = below >= desiredHeight || below >= above
  const maxHeight = Math.min(desiredHeight, down ? below : above)
  const width = Math.max(0, Math.min(Math.max(anchor.width, desiredWidth), rightEdge - leftEdge))
  return {
    left: Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)),
    top: Math.max(topEdge, Math.min(down ? anchor.bottom + gap : anchor.top - gap - maxHeight, bottomEdge - maxHeight)),
    width,
    maxHeight,
    placement: down ? 'bottom' as const : 'top' as const,
  }
}

/** For ancestor overlays' capture-phase outside handlers: a teleported option is still inside its owner. */
export function isSelectPopupEventInside(event: Event, container: Element): boolean {
  return event.composedPath().some(target => {
    if (!(target instanceof Element)) return false
    const owner = target.getAttribute('data-ui-select-owner')
    return owner != null && !!container.querySelector(`[data-ui-select-trigger="${CSS.escape(owner)}"]`)
  })
}
