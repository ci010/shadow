export interface EdgeSwipe {
  x: number
  y: number
  open: boolean
}

export function canStartDrawerSwipe(x: number, viewportWidth: number): boolean {
  return x >= 0 && x <= viewportWidth / 2
}

export function drawerSwipeProgress(start: EdgeSwipe, x: number, drawerWidth: number): number {
  return Math.max(0, Math.min(1, (start.open ? 1 : 0) + (x - start.x) / drawerWidth))
}

export function swipeIntent(start: EdgeSwipe, x: number, y: number): 'pending' | 'cancel' | 'horizontal' {
  const dx = x - start.x
  const dy = y - start.y
  if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) return 'cancel'
  if (Math.abs(dx) < 12) return 'pending'
  if (Math.abs(dx) < Math.abs(dy) * 1.5 || (start.open ? dx >= 0 : dx <= 0)) return 'cancel'
  return 'horizontal'
}

export function completesSwipe(start: EdgeSwipe, x: number, y: number): boolean {
  return swipeIntent(start, x, y) === 'horizontal' && Math.abs(x - start.x) >= 64
}
