import { t } from '../i18n.ts'
import { ref, watch, type Ref } from 'vue'

export function composerDraftKey(apiBase: string, projectId: string, sessionId: string): string {
  return `shadow:composer:v1:${JSON.stringify([apiBase, projectId, sessionId || null])}`
}

// Keep v1 plain-text drafts readable; activity is optional, validated sidecar data.
export const composerDraftRevision = ref(0)
const activityKey = (key: string) => `${key}:activity`
export function composerDraftEditedAt(storage: Pick<Storage, 'getItem'>, key: string): number {
  try {
    const text = storage.getItem(key)
    if (!text?.trim()) return 0
    const value = JSON.parse(storage.getItem(activityKey(key)) ?? 'null')
    return value?.text === text && typeof value.editedAt === 'number' && Number.isFinite(value.editedAt) && value.editedAt > 0
      ? value.editedAt : 0
  } catch { return 0 }
}

export function useComposerDraft(key: Readonly<Ref<string>>, storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const text = ref('')
  const error = ref('')
  let currentKey = ''
  let restoring = false
  let submittedActivity = 0

  function failure(cause: unknown) {
    error.value = t('Draft could not be saved or restored on this device. Copy your text before refreshing. {value1}', { value1: cause instanceof Error ? cause.message : String(cause) })
  }
  function write(target: string, value: string, editedAt = Date.now()): boolean {
    try {
      if (value) storage().setItem(target, value)
      else storage().removeItem(target)
      if (value.trim() && editedAt > 0) storage().setItem(activityKey(target), JSON.stringify({ text: value, editedAt }))
      else storage().removeItem(activityKey(target))
      composerDraftRevision.value++
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
    let editedAt = 0
    try { editedAt = composerDraftEditedAt(storage(), previous) } catch (cause) { failure(cause) }
    if (write(next, text.value, editedAt)) {
      try { storage().removeItem(previous); storage().removeItem(activityKey(previous)); composerDraftRevision.value++ } catch (cause) { failure(cause) }
    }
  }
  function clearSent(target: string, sent: string) {
    try {
      if (storage().getItem(target) === sent) {
        storage().removeItem(target)
        storage().removeItem(activityKey(target))
        composerDraftRevision.value++
      }
      if (currentKey === target && text.value === sent) {
        restoring = true
        text.value = ''
        restoring = false
      }
      error.value = ''
    } catch (cause) { restoring = false; failure(cause) }
  }
  // Clear the visible composer before awaiting network admission. The caller owns
  // the send lifecycle and restores on failure, including after draft migration.
  function clearSubmitting() {
    try { submittedActivity = composerDraftEditedAt(storage(), currentKey) } catch { submittedActivity = 0 }
    text.value = ''
  }
  function restoreUnsent(target: string, sent: string) {
    if (currentKey === target && text.value === '') {
      restoring = true
      text.value = sent
      restoring = false
      write(target, sent, submittedActivity)
    }
  }
  function remove(target: string) {
    try { storage().removeItem(target); storage().removeItem(activityKey(target)); composerDraftRevision.value++ } catch (cause) { failure(cause) }
  }
  return { text, error, migrate, clearSent, clearSubmitting, restoreUnsent, remove }
}
