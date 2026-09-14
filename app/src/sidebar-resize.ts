export interface SidebarWidthBounds {
  min: number
  max: number
}

export function sidebarWidthBounds(containerWidth: number, min: number, max: number, contentMin = 360): SidebarWidthBounds {
  const available = Math.max(0, Math.floor(containerWidth - contentMin))
  const upper = Math.min(max, available)
  return { min: Math.min(min, upper), max: upper }
}

export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(width)))
}

export function sidebarDragWidth(startWidth: number, startX: number, clientX: number, bounds: SidebarWidthBounds): number {
  return clampSidebarWidth(startWidth + clientX - startX, bounds)
}

export function sidebarKeyWidth(key: string, width: number, bounds: SidebarWidthBounds): number | undefined {
  if (key === 'Home') return bounds.min
  if (key === 'End') return bounds.max
  if (key === 'ArrowLeft') return clampSidebarWidth(width - 24, bounds)
  if (key === 'ArrowRight') return clampSidebarWidth(width + 24, bounds)
  return undefined
}
