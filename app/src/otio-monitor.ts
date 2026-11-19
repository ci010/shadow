import { annotationSizeError } from './image-annotation.ts'

// A synchronization threshold, not a frame rate or frame-accuracy claim.
export const PLAYBACK_DRIFT_SECONDS = 0.25
export const SEEK_TIMEOUT_MS = 8_000

export function validMediaPosition(seconds: number | null): seconds is number {
  return seconds !== null && Number.isFinite(seconds) && seconds >= 0
}

export function withinMediaDuration(seconds: number, duration: number): boolean {
  return validMediaPosition(seconds) && Number.isFinite(duration) && seconds < duration
}

export function atRequestedPosition(current: number, requested: number): boolean {
  // Allow browser floating-point rounding only, not a whole frame of drift.
  return Math.abs(current - requested) <= 0.0001
}

export async function exportMonitorPicture(
  source: CanvasImageSource, width: number, height: number, signal: AbortSignal,
): Promise<File> {
  signal.throwIfAborted()
  const sizeError = annotationSizeError(0, width, height)
  if (sizeError) throw new Error(sizeError)
  const canvas = document.createElement('canvas')
  try {
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(source, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      try {
        canvas.toBlob((result) => {
          signal.removeEventListener('abort', abort)
          resolve(result)
        }, 'image/png')
      } catch (error) {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    })
    signal.throwIfAborted()
    if (!blob?.size || blob.type !== 'image/png') throw new Error('Canvas export failed')
    const exportError = annotationSizeError(blob.size)
    if (exportError) throw new Error(exportError)
    return new File([blob], 'timeline-picture.png', { type: blob.type })
  } finally {
    canvas.width = canvas.height = 0
  }
}
