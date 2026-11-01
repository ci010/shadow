import { t } from '../i18n.ts'
import { onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { apiUrl } from '../api-url.ts'
import { createGitFilesClient, type GitStatus } from '../git-files.ts'
import { isNodeOfflineError } from '../workdir-request-error.ts'

type Source = { apiBase: string; sessionId: string; folderId?: string; sessionWorkspace?: boolean }
type Snapshot = { status?: GitStatus; loading: boolean; error: string; offline: boolean; revision: number }
type Observer = (snapshot: Snapshot) => void
export interface GitPollClock {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}
const clock: GitPollClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** Identity is the actual URL: folder readers ignore session/workspace, but never host/project. */
function identity(source: Source): string {
  const root = source.folderId ? `/api/folders/${encodeURIComponent(source.folderId)}`
    : `/api/sessions/${encodeURIComponent(source.sessionId)}${source.sessionWorkspace ? '/workspace' : ''}`
  return apiUrl(source.apiBase, `${root}/git/status`).toString()
}

/** No persistent result/error cache: the last observer disposes the entire reader. */
export function createWorkdirGitReaders(time: GitPollClock = clock) {
  const readers = new Map<string, ReturnType<typeof createReader>>()
  function createReader(source: Source, key: string) {
    const observers = new Set<Observer>()
    const snapshot: Snapshot = { loading: false, error: '', offline: false, revision: 0 }
    let timer: unknown
    let request: AbortController | undefined
    let pending: Promise<void> | undefined
    let fingerprint = ''
    let delay = 5000
    let explicit = false
    const publish = () => { for (const observer of observers) observer(snapshot) }
    function clearTimer() { if (timer !== undefined) time.clearTimeout(timer); timer = undefined }
    function refresh(manual = false): Promise<void> {
      if (!observers.size) return Promise.resolve()
      clearTimer()
      if (manual) { delay = 5000; explicit = true }
      if (pending) return pending
      const controller = new AbortController()
      request = controller
      snapshot.loading = !snapshot.status || snapshot.offline
      publish()
      pending = (async () => {
        try {
          const next = await createGitFilesClient(source.apiBase, source.sessionId, source.folderId, source.sessionWorkspace).status(controller.signal)
          if (controller.signal.aborted) return
          const nextFingerprint = JSON.stringify(next)
          const changed = nextFingerprint !== fingerprint
          const recovered = !!snapshot.error || snapshot.offline
          snapshot.error = ''
          snapshot.offline = false
          if (changed) { fingerprint = nextFingerprint; snapshot.status = next }
          // Git status does not fingerprint contents of an already-modified file.
          // Keep diff probes alive too, at the shared reader's backed-off cadence.
          snapshot.revision++
          delay = changed || recovered || explicit ? 5000 : Math.min(delay * 2, 60000)
        } catch (cause) {
          if (!controller.signal.aborted) {
            snapshot.offline = isNodeOfflineError(cause)
            snapshot.error = snapshot.offline ? '' : cause instanceof Error ? cause.message : t('Could not load Git changes. Retry.')
            delay = Math.min(delay * 2, 60000)
          }
        } finally {
          if (request === controller) {
            pending = undefined
            request = undefined
            explicit = false
            snapshot.loading = false
            publish()
            if (observers.size) timer = time.setTimeout(() => { timer = undefined; void refresh() }, delay)
          }
        }
      })()
      return pending
    }
    return {
      refresh,
      attach(observer: Observer) {
        observers.add(observer)
        observer(snapshot)
        if (observers.size === 1) void refresh()
        return () => {
          observers.delete(observer)
          if (!observers.size) {
            clearTimer()
            request?.abort()
            request = undefined
            pending = undefined
            readers.delete(key)
          }
        }
      },
    }
  }
  return {
    acquire(source: Source, observer: Observer) {
      const key = identity(source)
      let reader = readers.get(key)
      if (!reader) { reader = createReader({ ...source }, key); readers.set(key, reader) }
      return { release: reader.attach(observer), refresh: () => reader.refresh(true) }
    },
  }
}
const sharedReaders = createWorkdirGitReaders()

export function useWorkdirGit(source: () => Source, active: Ref<boolean>, readers = sharedReaders) {
  const status = shallowRef<GitStatus>()
  const loading = ref(false)
  const error = ref('')
  const offline = ref(false)
  const revision = ref(0)
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  let subscription: ReturnType<typeof readers.acquire> | undefined
  let previousKey = ''
  function stop() { subscription?.release(); subscription = undefined; loading.value = false }
  const visibilityChanged = () => { visible.value = document.visibilityState !== 'hidden' }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged)
  watch(() => {
    const current = source()
    return [current.sessionId || current.folderId ? identity(current) : '', active.value, visible.value] as const
  }, ([key, enabled, shown]) => {
    stop()
    if (key !== previousKey) {
      previousKey = key
      status.value = undefined
      error.value = ''
      offline.value = false
      revision.value++
    }
    if (key && enabled && shown) {
      let readerRevision: number | undefined
      subscription = readers.acquire(source(), next => {
        status.value = next.status
        loading.value = next.loading
        error.value = next.error
        offline.value = next.offline
        if (readerRevision !== next.revision) { readerRevision = next.revision; revision.value++ }
      })
    }
  }, { immediate: true })
  onUnmounted(() => {
    stop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged)
  })
  return { status, loading, error, offline, revision, refresh: () => subscription?.refresh() ?? Promise.resolve() }
}
