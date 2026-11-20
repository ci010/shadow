import { computed, onBeforeUnmount, ref, watch, type ShallowRef } from 'vue'
import type { ThreeViewer, CaptureView } from '@shadow/three-viewer'
import { registerGltfCaptureViewer, type GltfCaptureRegistration, type GltfCaptureCallback } from '../gltf-capture-bridge.ts'

const MAX_FRAME = 3 * 1024 * 1024 // 4 MiB on the JSON wire, before metadata.
async function encodeFrame(image: Blob, signal: AbortSignal) {
  if (image.size <= MAX_FRAME) return image
  const bitmap = await createImageBitmap(image)
  try {
    signal.throwIfAborted()
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Cannot encode Viewer frame')
    ctx.drawImage(bitmap, 0, 0)
    for (const quality of [0.86, 0.62]) {
      signal.throwIfAborted()
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (blob?.type === 'image/jpeg' && blob.size <= MAX_FRAME) return blob
    }
    throw new Error('Viewer image exceeds 3 MiB. Reduce the viewport size and try again.')
  } finally { bitmap.close() }
}

/** A lease follows a concrete viewer / conversation, not rendering focus or a
 * turn's original model revision. Version rollover never silently rebinds an asset. */
export function useModelCapture(viewer: ShallowRef<ThreeViewer | undefined>, scope: () => {
  apiBase: string; projectId: string; assetId: string; sessionId?: string | null; version?: string
}) {
  const status = ref(''), state = computed(scope)
  const key = computed(() => {
    const { apiBase, projectId, sessionId, assetId, version } = state.value
    return sessionId?.startsWith('web:') && version ? JSON.stringify([apiBase, projectId, sessionId, assetId]) : ''
  })
  let handle: GltfCaptureRegistration | undefined, life: AbortController | undefined, announced: string | undefined
  let registering = Promise.resolve()
  const capture: GltfCaptureCallback = async (request, signal, expected) => {
    const { version } = state.value
    if (!viewer.value || !key.value || !version || version !== expected.version || announced !== version) throw new Error('No matching rendered build')
    const view: CaptureView | undefined = request.mode === 'current' ? undefined : request.mode === 'custom'
      ? { position: request.position, target: request.target } : request.mode
    const frame = await viewer.value.captureFrame(view)
    if (frame.version !== version) throw new Error('Rendered build changed during capture')
    signal.throwIfAborted()
    const image = await encodeFrame(frame.image, signal)
    const bytes = new Uint8Array(await image.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
    signal.throwIfAborted()
    if (state.value.version !== version) throw new Error('Rendered build changed during encoding')
    return { mimeType: image.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', data: btoa(binary), camera: { position: [...frame.camera.position], target: [...frame.camera.target] }, objectIds: [...frame.objectIds] }
  }
  function unlink() { life?.abort(); life = undefined; handle?.(); handle = undefined; announced = undefined }
  async function update() {
    const version = state.value.version, lease = life
    if (!version || !handle || announced === version) return
    announced = version
    try { await handle.updateVersion(version) }
    catch (error) { if (lease === life) { unlink(); status.value = String(error) } }
  }
  async function register() {
    unlink(); status.value = ''
    const { sessionId, version, ...owner } = state.value
    if (!key.value || !sessionId || !version) return
    const lease = life = new AbortController()
    announced = version
    try {
      const registration = await registerGltfCaptureViewer({ ...owner, sessionId, version }, capture, lease.signal)
      if (lease.signal.aborted) { registration(); return }
      handle = registration
      await update()
    } catch (error) { if (life === lease) { unlink(); status.value = String(error) } }
  }
  watch(key, () => { registering = register() }, { flush: 'sync', immediate: true })
  watch(() => state.value.version, update, { flush: 'sync' })
  onBeforeUnmount(unlink)
  return { status, async ready(sessionId: string, version: string) {
    await registering
    return !!handle && state.value.sessionId === sessionId && state.value.version === version && announced === version
  } }
}
