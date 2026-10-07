import { t } from './i18n.ts'
export const MAX_ANNOTATION_BYTES = 20 * 1024 * 1024
export const MAX_ANNOTATION_PIXELS = 20_000_000
export const MAX_ANNOTATION_DIMENSION = 8192

export class AnnotationLoadError extends Error {
  override name = 'AnnotationLoadError'
}

export function annotationLoadErrorMessage(error: unknown): string {
  return error instanceof AnnotationLoadError
    ? error.message : t('This image could not be decoded safely. Retry or open the raw image.')
}

export function annotationSizeError(bytes: number, width?: number, height?: number): string | null {
  if (bytes > MAX_ANNOTATION_BYTES) return t('This image exceeds the 20 MiB annotation limit. Open the raw image instead.')
  if (width === undefined || height === undefined) return null
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return t('This image has no readable dimensions. Open the raw image instead.')
  }
  if (width > MAX_ANNOTATION_DIMENSION || height > MAX_ANNOTATION_DIMENSION || width * height > MAX_ANNOTATION_PIXELS) {
    return t('This image exceeds the 20 megapixel or 8192 px per-side annotation limit. Open the raw image instead.')
  }
  return null
}

export function markedImageName(name: string): string {
  const filename = name.split(/[\\/]/).pop() || 'image'
  const basename = filename.replace(/\.[^.]+$/, '') || 'image'
  return `${basename}-marked.png`
}

export interface AnnotationPoint { x: number; y: number }

export interface AnnotationStroke {
  color: string
  width: number
  points: AnnotationPoint[]
}

type AnnotationDrawingContext = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineCap' | 'lineJoin'
  | 'beginPath' | 'arc' | 'fill' | 'moveTo' | 'lineTo' | 'stroke'>

export function drawAnnotationStroke(context: AnnotationDrawingContext, stroke: AnnotationStroke): void {
  const [first] = stroke.points
  if (!first) return
  context.fillStyle = stroke.color
  context.beginPath()
  context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = stroke.color
  context.lineWidth = stroke.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (let index = 1; index < stroke.points.length; index++) {
    const previous = stroke.points[index - 1]!
    const point = stroke.points[index]!
    context.beginPath()
    context.moveTo(previous.x, previous.y)
    context.lineTo(point.x, point.y)
    context.stroke()
  }
}

export function isAnnotationUndo(event: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'metaKey' | 'altKey' | 'isComposing' | 'keyCode' | 'repeat' | 'defaultPrevented'>): boolean {
  return event.type === 'keydown' && event.key.toLowerCase() === 'z' && event.ctrlKey
    && !event.shiftKey && !event.metaKey && !event.altKey && !event.isComposing
    && event.keyCode !== 229 && !event.repeat && !event.defaultPrevented
}

export function annotationPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
): AnnotationPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  // Keep out-of-bounds coordinates: the canvas clips each segment without drawing along its edge.
  return {
    x: (clientX - rect.left) * width / rect.width,
    y: (clientY - rect.top) * height / rect.height,
  }
}

export class AnnotationPointer {
  private id: number | null = null

  start(event: { pointerId: number; button: number; isPrimary: boolean; ctrlKey: boolean }, allowed: boolean): boolean {
    if (!allowed || this.id !== null || !event.isPrimary || event.button !== 0 || event.ctrlKey) return false
    this.id = event.pointerId
    return true
  }

  owns(pointerId: number): boolean { return this.id === pointerId }
  get active(): boolean { return this.id !== null }
  release(): number | null {
    const id = this.id
    this.id = null
    return id
  }
}
