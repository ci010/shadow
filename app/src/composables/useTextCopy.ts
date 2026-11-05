import { t } from '../i18n.ts'
import { onUnmounted, ref, toValue, watch, type WatchSource, type MaybeRefOrGetter } from 'vue'

// Lazy producers must supply a cheap source describing their inputs, not their output.
export function useTextCopy(text: MaybeRefOrGetter<string>, invalidationSource?: WatchSource<unknown>) {
  const copied = ref(false)
  const busy = ref(false)
  const error = ref('')
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  function reset() {
    generation++
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    copied.value = false
    busy.value = false
    error.value = ''
  }
  async function copy() {
    if (busy.value) return
    reset()
    const current = generation
    busy.value = true
    try {
      const value = toValue(text)
      await navigator.clipboard.writeText(value)
      if (generation !== current) return
      copied.value = true
      timer = setTimeout(() => { timer = undefined; copied.value = false }, 2000)
    } catch {
      if (generation === current) error.value = t('Could not copy. Select the value and copy it manually.')
    } finally {
      if (generation === current) busy.value = false
    }
  }
  watch(invalidationSource ?? (() => toValue(text)), reset, { flush: 'sync' })
  onUnmounted(reset)
  return { copied, busy, error, copy, reset }
}
