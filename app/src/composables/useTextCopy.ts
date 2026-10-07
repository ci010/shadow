import { t } from '../i18n.ts'
import { onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'

export function useTextCopy(text: MaybeRefOrGetter<string>) {
  const copied = ref(false)
  const busy = ref(false)
  const error = ref('')
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  function reset() {
    generation++
    clearTimeout(timer)
    copied.value = false
    busy.value = false
    error.value = ''
  }
  async function copy() {
    if (busy.value) return
    reset()
    const current = generation
    const value = toValue(text)
    busy.value = true
    try {
      await navigator.clipboard.writeText(value)
      if (generation !== current) return
      copied.value = true
      timer = setTimeout(() => { copied.value = false }, 2000)
    } catch {
      if (generation === current) error.value = t('Could not copy. Select the value and copy it manually.')
    } finally {
      if (generation === current) busy.value = false
    }
  }
  watch(() => toValue(text), reset, { flush: 'sync' })
  onUnmounted(reset)
  return { copied, busy, error, copy, reset }
}
