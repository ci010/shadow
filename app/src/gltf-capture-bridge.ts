import { apiUrl } from './api-url.ts'
import {
  captureExceedsLimits, captureId, captureRecord, GLTF_CAPTURE_HEADER, GLTF_CAPTURE_PATH, parseCaptureView, sameCaptureScope,
  type GltfCaptureResult, type GltfCaptureScope, type GltfCaptureView,
} from '../../src/gltf-capture-contract.ts'

export type { GltfCaptureResult, GltfCaptureScope, GltfCaptureView }
export type GltfCaptureCallback = (view: GltfCaptureView, signal: AbortSignal, scope: Readonly<GltfCaptureScope>) => Promise<GltfCaptureResult>
export type GltfCaptureRegistration = (() => void) & { updateVersion(version: string): Promise<void> }

type LocalBinding = { endpoint: string; scope: GltfCaptureScope; binding?: string }
const localBindings = new Set<LocalBinding>() // In-memory tab only; never share via storage or a broadcast channel.

/** Only stamp the submitting tab's current Viewer, and only for this exact chat route. */
export function gltfCaptureChatHeaders(apiBase: string, projectId: string, sessionId: string): Record<string, string> {
  const endpoint = apiUrl(apiBase, GLTF_CAPTURE_PATH).href
  const matches = [...localBindings].filter(b => b.endpoint === endpoint && b.scope.projectId === projectId && b.scope.sessionId === sessionId)
  const binding = matches.length === 1 ? matches[0].binding : undefined
  return binding ? { [GLTF_CAPTURE_HEADER]: binding } : {}
}

/** Call only with a real, explicitly linked mounted Viewer. Keep the handle across
 * changes of camera or input focus (including returning to chat), never across
 * assets, logical conversations, or browser identity. For a hot reload the callback
 * must refuse capture until the new render is ready; then announce its version. */
export async function registerGltfCaptureViewer(
  input: GltfCaptureScope & { apiBase: string }, capture: GltfCaptureCallback, lifecycle?: AbortSignal,
): Promise<GltfCaptureRegistration> {
  lifecycle?.throwIfAborted()
  const scope = { projectId: input.projectId, sessionId: input.sessionId, assetId: input.assetId, version: input.version }
  if (!Object.values(scope).every(captureId) || !scope.sessionId.startsWith('web:')) throw new Error('Invalid Viewer capture scope.')
  const binding: LocalBinding = { endpoint: apiUrl(input.apiBase, GLTF_CAPTURE_PATH).href, scope }
  localBindings.add(binding)
  const lifetime = new AbortController()
  let active: AbortController | undefined
  let updateQueue = Promise.resolve()
  let previousVersion = scope.version
  let unregistered = false
  const post = (action: string, body?: unknown, signal?: AbortSignal, keepalive?: boolean) => fetch(`${binding.endpoint}/${action}`, {
    method: 'POST', credentials: 'same-origin', signal, keepalive, redirect: 'error',
    headers: {
      ...(binding.binding ? { [GLTF_CAPTURE_HEADER]: binding.binding } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const dispose = Object.assign(() => {
    localBindings.delete(binding)
    lifetime.abort()
    lifecycle?.removeEventListener('abort', dispose)
    globalThis.removeEventListener?.('pagehide', dispose)
    if (binding.binding && !unregistered) {
      unregistered = true
      void post('unregister', undefined, AbortSignal.timeout(5_000), true).catch(() => {})
    }
  }, {
    updateVersion(version: string) {
      if (!captureId(version) || lifetime.signal.aborted) return Promise.reject(new Error('Viewer binding or version is invalid.'))
      scope.version = version
      active?.abort()
      updateQueue = updateQueue.then(async () => {
        lifetime.signal.throwIfAborted()
        if (previousVersion === version) return
        const response = await post('version', { previousVersion, version }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]))
        if (response.status !== 204) throw new Error('Viewer version update rejected.')
        previousVersion = version
      }).catch(error => { dispose(); throw error })
      return updateQueue
    },
  })
  lifecycle?.addEventListener('abort', dispose, { once: true })
  globalThis.addEventListener?.('pagehide', dispose, { once: true })
  try {
    // Let registration complete if teardown happens during this request, so that
    // we can explicitly revoke a server-side binding rather than await its lease.
    const response = await post('register', scope, AbortSignal.timeout(8_000))
    if (!response.ok) throw new Error('Viewer capture registration rejected.')
    const registered = captureRecord(await response.json())
    if (!captureId(registered?.binding)) throw new Error('Invalid Viewer capture registration.')
    binding.binding = registered.binding
    lifetime.signal.throwIfAborted()
  } catch (error) { dispose(); throw error }

  const run = async () => {
    while (!lifetime.signal.aborted) {
      const response = await post('poll', undefined, AbortSignal.any([lifetime.signal, AbortSignal.timeout(18_000)]))
      if (response.status === 204) continue
      if (!response.ok) throw new Error('Viewer capture binding ended.')
      const job = captureRecord(await response.json())
      const remoteScope = captureRecord(job?.scope)
      const view = parseCaptureView(job?.view)
      const id = job?.id
      const budget = job?.budgetMs
      if (!captureId(id) || !remoteScope || !view || typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0 || budget > 8_000) throw new Error('Invalid Viewer capture request.')
      if (!sameCaptureScope(scope, remoteScope)) continue
      active = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, active.signal, AbortSignal.timeout(budget)])
      try {
        const result = await abortableCapture(capture, view, signal, { ...scope })
        if (signal.aborted || !sameCaptureScope(scope, remoteScope)) continue
        if (captureExceedsLimits(result)) {
          await post('result', { id, result: null, error: 'limits' }, signal)
          continue
        }
        const { mimeType, data, camera, objectIds } = result
        await post('result', { id, result: { mimeType, data, camera: { position: camera.position, target: camera.target }, objectIds } }, signal)
      } catch {
        if (!signal.aborted) await post('result', { id, result: null }, signal).catch(() => {})
      } finally { active = undefined }
    }
  }
  void run().catch(dispose)
  return dispose
}

async function abortableCapture(callback: GltfCaptureCallback, view: GltfCaptureView, signal: AbortSignal, scope: Readonly<GltfCaptureScope>): Promise<GltfCaptureResult> {
  signal.throwIfAborted()
  let abort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([callback(view, signal, scope), stopped]) }
  finally { signal.removeEventListener('abort', abort) }
}
