export function hoverInfoPosition(
  anchor: { left: number; right: number; top: number },
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const gap = 8
  const maxLeft = Math.max(gap, viewport.width - popup.width - gap)
  const left = anchor.right + gap + popup.width <= viewport.width - gap
    ? anchor.right + gap
    : anchor.left - gap - popup.width >= gap ? anchor.left - gap - popup.width : anchor.left
  return {
    left: Math.max(gap, Math.min(left, maxLeft)),
    top: Math.max(gap, Math.min(anchor.top, viewport.height - popup.height - gap)),
  }
}
