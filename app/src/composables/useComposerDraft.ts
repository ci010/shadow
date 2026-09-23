import { ref, watch, type Ref } from 'vue'

export function composerDraftKey(apiBase: string, projectId: string, sessionId: string): string {
  return `shadow:composer:v1:${JSON.stringify([apiBase, projectId, sessionId || null])}`
}

export function useComposerDraft(key: Readonly<Ref<string>>, storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const text = ref('')
  const error = ref('')
  let currentKey = ''
  let restoring = false

  function failure(cause: unknown) {
    error.value = `Draft could not be saved or restored on this device. Copy your text before refreshing. ${cause instanceof Error ? cause.message : String(cause)}`
  }
  function write(target: string, value: string): boolean {
    try {
      if (value) storage().setItem(target, value)
      else storage().removeItem(target)
      error.value = ''
      return true
    } catch (cause) { failure(cause); return false }
  }
  watch(key, next => {
    if (next === currentKey) return
    currentKey = next
    restoring = true
    try { text.value = storage().getItem(next) ?? ''; error.value = '' }
    catch (cause) { text.value = ''; failure(cause) }
    finally { restoring = false }
  }, { immediate: true, flush: 'sync' })
  watch(text, value => { if (!restoring) write(currentKey, value) }, { flush: 'sync' })

  function migrate(next: string) {
    if (next === currentKey) return
    const previous = currentKey
    currentKey = next
    if (write(next, text.value)) {
      try { storage().removeItem(previous) } catch (cause) { failure(cause) }
    }
  }
  function clearSent(target: string, sent: string) {
    try {
      if (storage().getItem(target) === sent) storage().removeItem(target)
      if (currentKey === target && text.value === sent) {
        restoring = true
        text.value = ''
        restoring = false
      }
      error.value = ''
    } catch (cause) { restoring = false; failure(cause) }
  }
  function remove(target: string) {
    try { storage().removeItem(target) } catch (cause) { failure(cause) }
  }
  return { text, error, migrate, clearSent, remove }
}
