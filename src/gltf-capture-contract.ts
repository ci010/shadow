export const GLTF_CAPTURE_HEADER = 'X-Shadow-Viewer-Binding'
export const GLTF_CAPTURE_PATH = '/api/gltf-capture'
export const GLTF_CAPTURE_MAX_IMAGE = 4 * 1024 * 1024 // Base64 characters; at most 3 MiB of decoded PNG/JPEG bytes.
export const GLTF_CAPTURE_MAX_IDS = 4096
export const GLTF_CAPTURE_MAX_ID_BYTES = 256
export const GLTF_CAPTURE_LIMIT_ERROR = 'Viewer capture exceeds the limit: at most 3 MiB of PNG/JPEG bytes and 4096 object IDs of at most 256 UTF-8 bytes each.'

const encoder = new TextEncoder()
export function captureExceedsLimits(value: { data?: unknown; objectIds?: unknown }): boolean {
  return (typeof value.data === 'string' && value.data.length > GLTF_CAPTURE_MAX_IMAGE) ||
    (Array.isArray(value.objectIds) && (value.objectIds.length > GLTF_CAPTURE_MAX_IDS || value.objectIds.some(id =>
      typeof id === 'string' && (id.length > GLTF_CAPTURE_MAX_ID_BYTES || encoder.encode(id).byteLength > GLTF_CAPTURE_MAX_ID_BYTES))))
}
export interface GltfCaptureScope { projectId: string; sessionId: string; assetId: string; version: string }
export type GltfVector = [number, number, number]
export type GltfCaptureView = { mode: 'current' | 'front' | 'back' | 'top' }
  | { mode: 'custom'; position: GltfVector; target: GltfVector }
export interface GltfCaptureResult {
  mimeType: 'image/png' | 'image/jpeg'
  data: string
  camera: { position: GltfVector; target: GltfVector }
  objectIds: string[]
}
export function captureRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
export function captureId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
}
export function captureVector(value: unknown): value is GltfVector {
  return Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n))
}
export function parseCaptureView(value: unknown): GltfCaptureView | undefined {
  const view = captureRecord(value)
  if (!view) return
  const { position, target } = view
  const mode = view.mode === undefined ? (position === undefined && target === undefined ? 'current' : 'custom') : view.mode
  if (mode === 'custom' && captureVector(position) && captureVector(target) && position.some((n, i) => n !== target[i])) return { mode, position, target }
  if ((mode === 'current' || mode === 'front' || mode === 'back' || mode === 'top') && position === undefined && target === undefined) return { mode }
}
export function sameCaptureScope(left: GltfCaptureScope, right: Record<string, unknown>): boolean {
  return left.projectId === right.projectId && left.sessionId === right.sessionId && left.assetId === right.assetId && left.version === right.version
}
