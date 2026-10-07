import { t } from '../i18n.ts'
import { onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { createGitFilesClient, type GitStatus } from '../git-files.ts'
import { isNodeOfflineError } from '../workdir-request-error.ts'

export function useWorkdirGit(source: () => { apiBase: string; sessionId: string; folderId?: string }, active: Ref<boolean>) {
  const status = shallowRef<GitStatus>()
  const loading = ref(false)
  const error = ref('')
  const offline = ref(false)
  const revision = ref(0)
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let fingerprint = ''
  function stop() {
    clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
    loading.value = false
  }
  async function refresh() {
    stop()
    const current = source()
    if (!active.value || !(current.sessionId || current.folderId)) return
    const request = new AbortController()
    controller = request
    loading.value = !status.value || offline.value
    try {
      const next = await createGitFilesClient(current.apiBase, current.sessionId, current.folderId).status(request.signal)
      if (request.signal.aborted) return
      error.value = ''
      offline.value = false
      const nextFingerprint = JSON.stringify(next)
      if (nextFingerprint !== fingerprint) {
        fingerprint = nextFingerprint
        status.value = next
      }
      revision.value++
    } catch (cause) {
      if (!request.signal.aborted) {
        offline.value = isNodeOfflineError(cause)
        error.value = offline.value ? '' : cause instanceof Error ? cause.message : t('Could not load Git changes. Retry.')
      }
    } finally {
      if (controller === request) {
        controller = undefined
        loading.value = false
        timer = setTimeout(() => { void refresh() }, 5000)
      }
    }
  }
  watch(() => [source().apiBase, source().sessionId, source().folderId], () => {
    stop()
    status.value = undefined
    fingerprint = ''
    error.value = ''
    offline.value = false
    revision.value++
    void refresh()
  }, { immediate: true })
  watch(active, enabled => { if (enabled) void refresh(); else stop() })
  onUnmounted(stop)
  return { status, loading, error, offline, revision, refresh }
}
