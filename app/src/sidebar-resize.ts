export interface SidebarWidthBounds {
  min: number
  max: number
}
export type SidebarResizeEdge = 'left' | 'right'

export function sidebarWidthBounds(containerWidth: number, min: number, max: number, contentMin = 360): SidebarWidthBounds {
  const available = Math.max(0, Math.floor(containerWidth - contentMin))
  const upper = Math.min(max, available)
  return { min: Math.min(min, upper), max: upper }
}

export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(width)))
}

export function sidebarDragWidth(startWidth: number, startX: number, clientX: number, bounds: SidebarWidthBounds, edge: SidebarResizeEdge = 'right'): number {
  return clampSidebarWidth(startWidth + (clientX - startX) * (edge === 'left' ? -1 : 1), bounds)
}

export function sidebarKeyWidth(key: string, width: number, bounds: SidebarWidthBounds, edge: SidebarResizeEdge = 'right'): number | undefined {
  if (key === 'Home') return bounds.min
  if (key === 'End') return bounds.max
  const step = edge === 'left' ? -24 : 24
  if (key === 'ArrowLeft') return clampSidebarWidth(width - step, bounds)
  if (key === 'ArrowRight') return clampSidebarWidth(width + step, bounds)
  return undefined
}
