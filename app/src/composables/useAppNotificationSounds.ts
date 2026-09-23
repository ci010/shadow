import { onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { createNotificationSounds, notificationSoundsKey, SOUND_PREFERENCES_KEY } from '../notification-sounds.ts'
import { startSessionSoundMonitor } from '../session-sound-monitor.ts'
import { useLiveClientPool } from './useLiveClient.ts'
import { useProjectLiveState } from './useProjectLiveState.ts'

export function useAppNotificationSounds(source: () => { base: string; allowed: boolean }) {
  const sounds = createNotificationSounds({
    storage: {
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    },
  })
  provide(notificationSoundsKey, sounds)
  const live = useLiveClientPool()
  const state = useProjectLiveState()
  const monitoringError = ref('')
  let stop: (() => void) | undefined
  const stopWatching = watch([
    () => source().base,
    () => source().allowed && sounds.preferences.value.enabled && sounds.ready.value
      && sounds.preferences.value.volume > 0 && (sounds.preferences.value.yield || sounds.preferences.value.idle),
  ], ([base, enabled]) => {
    stop?.()
    stop = enabled ? startSessionSoundMonitor({
      base, live: live.client(base), state, notify: sounds.notify, error: message => { monitoringError.value = message },
    }) : undefined
  }, { immediate: true })
  function unlock(event: Event) { if (event.isTrusted && !sounds.ready.value && !sounds.error.value) void sounds.unlock() }
  function stored(event: StorageEvent) { if (event.key === SOUND_PREFERENCES_KEY || event.key === null) sounds.load() }
  onMounted(() => {
    document.addEventListener('pointerdown', unlock, true)
    document.addEventListener('keydown', unlock, true)
    window.addEventListener('storage', stored)
  })
  onUnmounted(() => {
    stopWatching()
    stop?.()
    document.removeEventListener('pointerdown', unlock, true)
    document.removeEventListener('keydown', unlock, true)
    window.removeEventListener('storage', stored)
    sounds.dispose()
  })
  function toggle() {
    sounds.setPreferences({ enabled: !sounds.preferences.value.enabled })
    if (sounds.preferences.value.enabled) void sounds.unlock()
  }
  return { sounds, monitoringError, toggle }
}
