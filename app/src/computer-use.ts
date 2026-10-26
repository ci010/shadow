import { computed, onUnmounted, ref, watch } from 'vue'
import { z } from 'zod'
import { useInstallationContext } from './composables/useInstallationContext.ts'
import { apiUrl } from './api-url.ts'
import { t } from './i18n.ts'
import { ComputerStatusSchema, type ComputerStatus } from '../../src/computer/contracts.ts'
import { isPointerAction } from '../../src/execution/computer/contracts.ts'

export interface ComputerSource {
  apiBase: string
  projectId: string
  sessionId: string
  active: boolean
  canSubmit: boolean
  stage?: string | null
}
export function parseComputerStatus(value: unknown, source: Pick<ComputerSource, 'projectId' | 'sessionId'>): ComputerStatus {
  const status = ComputerStatusSchema.parse(value)
  if (status.projectId !== source.projectId || status.sessionId !== source.sessionId) throw new Error('Computer status scope mismatch')
  if (status.pending && status.pending.targetId !== status.grant?.target.id) throw new Error('Computer review target mismatch')
  if (status.pending) {
    const { action, element, frame } = status.pending
    if (isPointerAction(action)) {
      if (element || !frame) throw new Error('Missing coordinate review frame')
      const points = action.kind === 'drag' ? [[action.x, action.y], [action.toX, action.toY]] : [[action.x, action.y]]
      if (points.some(([x, y]) => x >= frame.width || y >= frame.height)) throw new Error('Coordinate review outside frame')
    } else if (!element || frame) throw new Error('Invalid control review')
  }
  return status
}

export function useComputer(source: () => ComputerSource) {
  const installation = useInstallationContext()
  const status = ref<ComputerStatus | null>(null)
  const error = ref('')
  const loading = ref(false)
  const needsReload = ref(false)
  const now = ref(Date.now())
  const operation = ref<'approving' | 'denying' | 'stopping' | null>(null)
  const busy = computed(() => operation.value !== null)
  const enabled = computed(() => installation.value.mode !== 'client' && source().active && source().canSubmit && !!source().projectId && !!source().sessionId)
  const remaining = computed(() => Math.max(0, Math.ceil((Date.parse(status.value?.pending?.expiresAt ?? '') - now.value) / 1000)) || 0)
  const frameUrl = ref('')
  const frameState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const canApprove = computed(() => !!status.value?.pending && !needsReload.value && !busy.value && remaining.value > 0
    && (!isPointerAction(status.value.pending.action) || frameState.value === 'ready' && !!frameUrl.value && frameRequestId === status.value.pending.id))
  let generation = 0
  let read: AbortController | undefined
  let write: AbortController | undefined
  let frameRead: AbortController | undefined
  let frameRequestId: string | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  function endpoint(path = '', global = false) {
    return apiUrl(source().apiBase, `/api/computer/${global ? '' : encodeURIComponent(source().sessionId)}${path}`).toString()
  }
  function clearFrame() {
    frameRead?.abort()
    frameRead = undefined
    frameRequestId = undefined
    if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
    frameUrl.value = ''
    frameState.value = 'idle'
  }
  async function loadFrame() {
    const pending = status.value?.pending
    if (!enabled.value || needsReload.value || busy.value || !remaining.value || !pending?.frame) return
    clearFrame()
    const current = generation
    const controller = new AbortController()
    frameRead = controller
    frameRequestId = pending.id
    frameState.value = 'loading'
    try {
      const response = await fetch(endpoint(`/decisions/${encodeURIComponent(pending.id)}/frame`), {
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok || response.headers.get('content-type') !== 'image/png') throw new Error('Review frame unavailable')
      const image = await response.blob()
      if (!image.size || image.size > 3 * 1024 * 1024) throw new Error('Invalid review image size')
      if (current !== generation || controller.signal.aborted || status.value?.pending?.id !== pending.id || !remaining.value) return
      frameUrl.value = URL.createObjectURL(image)
    } catch {
      if (current === generation && !controller.signal.aborted) frameState.value = 'error'
    } finally {
      if (frameRead === controller) frameRead = undefined
    }
  }
  function frameFailed(url: string) {
    if (!url || url !== frameUrl.value) return
    URL.revokeObjectURL(url)
    frameUrl.value = ''
    frameState.value = 'error'
  }
  function frameLoaded(url: string, width: number, height: number) {
    if (!url || url !== frameUrl.value || frameRequestId !== status.value?.pending?.id) return
    const frame = status.value?.pending?.frame
    if (!frame || frame.width !== width || frame.height !== height) { frameFailed(url); return }
    frameState.value = 'ready'
  }
  function clear() {
    generation++
    read?.abort()
    write?.abort()
    read = write = undefined
    clearFrame()
    if (interval) clearInterval(interval)
    interval = undefined
    status.value = null
    error.value = ''
    loading.value = needsReload.value = false
    operation.value = null
  }
  async function refresh(manual = false) {
    if (!enabled.value || read || write) return
    const current = generation
    const controller = new AbortController()
    read = controller
    loading.value = true
    try {
      const response = await fetch(endpoint(), {
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error('Status unavailable')
      const next = parseComputerStatus(await response.json(), source())
      if (current !== generation || controller.signal.aborted) return
      status.value = next
      now.value = Date.now()
      if (manual) needsReload.value = false
      if (!needsReload.value) error.value = ''
    } catch {
      // Passive discovery must not turn an unrelated chat into an error panel.
      // Once this conversation has desktop access,
      // failures remain visible and block approvals until an explicit reload.
      if (current === generation && !controller.signal.aborted
        && (manual || status.value?.grant || status.value?.pending || status.value?.executing)) {
        needsReload.value = true
        error.value = t('Could not load computer use. Check your local owner connection and reload.')
      }
    } finally {
      if (read === controller) { read = undefined; loading.value = false }
    }
  }
  async function mutate(kind: NonNullable<typeof operation.value>, path: string, body: object | undefined,
    accept: (body: unknown) => void, global = false): Promise<boolean> {
    if (!enabled.value || write && kind !== 'stopping') return false
    read?.abort()
    read = undefined
    loading.value = false
    write?.abort()
    const current = generation
    const controller = new AbortController()
    write = controller
    operation.value = kind
    error.value = ''
    let success = false
    try {
      const response = await fetch(endpoint(path, global), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}), cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      })
      if (!response.ok) throw new Error('Operation not confirmed')
      const value: unknown = await response.json()
      if (current !== generation || controller.signal.aborted) return false
      accept(value)
      needsReload.value = false
      success = true
    } catch {
      if (current === generation && !controller.signal.aborted) {
        needsReload.value = true
        error.value = t('Could not confirm the desktop operation. Reload status before trying again; it will not be repeated automatically.')
      }
    } finally {
      if (write === controller) {
        write = undefined
        operation.value = null
        if (success) await refresh()
      }
    }
    return success
  }
  function decide(approved: boolean) {
    const pending = status.value?.pending
    if (!pending || needsReload.value || remaining.value === 0 || approved && !canApprove.value) return Promise.resolve(false)
    return mutate(approved ? 'approving' : 'denying', `/decisions/${encodeURIComponent(pending.id)}`, { approved }, value => {
      const result = z.object({ requestId: z.literal(pending.id), accepted: z.literal(true) }).strict().parse(value)
      if (result.accepted && status.value?.pending?.id === pending.id) {
        status.value.pending = null
      }
    })
  }
  watch([() => status.value?.pending, enabled, needsReload, remaining, busy], () => {
    if (!enabled.value || needsReload.value || busy.value || !remaining.value || !status.value?.pending?.frame) { clearFrame(); return }
    if (frameRequestId !== status.value.pending.id) void loadFrame()
  }, { flush: 'sync' })
  function stop() {
    return mutate('stopping', 'stop', undefined, value => {
      z.object({ stopped: z.literal(true) }).strict().parse(value)
      if (status.value) status.value = { ...status.value, grant: null, pending: null, executing: false, busy: false }
    }, true)
  }
  watch([() => source().apiBase, () => source().projectId, () => source().sessionId, enabled], () => {
    clear()
    if (!enabled.value) return
    void refresh()
    interval = setInterval(() => {
      now.value = Date.now()
      if (status.value?.grant || source().stage === 'tool') void refresh()
    }, 1000)
  }, { immediate: true, flush: 'sync' })
  onUnmounted(clear)
  return { status, error, loading, needsReload, operation, busy, enabled, remaining,
    frameUrl, frameState, canApprove, frameLoaded, frameFailed, reloadFrame: loadFrame,
    refresh: () => refresh(true), decide, stop }
}
