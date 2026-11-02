// Shared interaction grammar for pixel-mark and anchored-annotation previews.
export type ImageDrawingTool = 'freehand' | 'line' | 'rectangle' | 'select'
export function isStraightImageGesture(tool: ImageDrawingTool, shiftKey: boolean): boolean {
  return tool === 'line' || ((tool === 'freehand') && shiftKey)
}
export function appendImageDrawingPoint<T>(points: T[], point: T, straight: boolean, limit = 10000): void {
  if (straight) { points[1] = point; return }
  if (points.length < limit) points.push(point)
}
