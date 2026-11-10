import { onMounted, onUnmounted, readonly, ref } from 'vue'

const now = ref(new Date())
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

/** One shared clock keeps visible message dates fresh across midnight and sleep. */
export function useMessageClock() {
  onMounted(() => {
    now.value = new Date()
    if (subscribers++ === 0) timer = setInterval(() => { now.value = new Date() }, 15_000)
  })
  onUnmounted(() => {
    if (--subscribers === 0) {
      clearInterval(timer)
      timer = undefined
    }
  })
  return readonly(now)
}
