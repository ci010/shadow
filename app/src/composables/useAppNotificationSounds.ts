import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '../i18n.ts'
import { projectChatLocation } from '../projects.ts'
import { createBrowserTaskNotifications, browserTaskNotificationsKey } from '../browser-task-notifications.ts'
import type { TaskNotificationTarget } from '../../../desktop/src/task-notifications-contract.ts'
import { createNotificationSounds, notificationSoundsKey, SOUND_PREFERENCES_KEY } from '../notification-sounds.ts'
import { startSessionSoundMonitor } from '../session-sound-monitor.ts'
import { useLiveClientPool } from './useLiveClient.ts'
import { useProjectLiveState } from './useProjectLiveState.ts'

export function useAppNotificationSounds(source: () => { base: string; allowed: boolean }) {
  const router = useRouter()
  const desktop = window.shadowDesktop?.taskNotifications
  const sounds = createNotificationSounds({
    storage: {
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    },
  })
  provide(notificationSoundsKey, sounds)
  const live = useLiveClientPool()
  const state = useProjectLiveState()
  const sessionError = ref('')
  const notificationError = ref('')
  function openConversation(target: TaskNotificationTarget) {
    if (!source().allowed) return
    void router.push(projectChatLocation(target)).catch(cause => {
      notificationError.value = t('Could not open the completed conversation. {error}', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }
  const browserNotifications = window.shadowDesktop ? null : createBrowserTaskNotifications(window, openConversation)
  provide(browserTaskNotificationsKey, browserNotifications)
  const monitoringError = computed(() => [sessionError.value, notificationError.value, browserNotifications?.error.value].filter(Boolean).join(' '))
  const soundEnabled = () => sounds.preferences.value.enabled && sounds.ready.value
    && sounds.preferences.value.volume > 0 && (sounds.preferences.value.yield || sounds.preferences.value.idle)
  let stop: (() => void) | undefined
  let stopActivation: (() => void) | undefined
  let disposed = false
  const stopWatching = watch([
    () => source().base,
    () => source().allowed && (!!desktop || browserNotifications?.active.value || soundEnabled()),
  ], ([base, enabled]) => {
    stop?.()
    stop = enabled ? startSessionSoundMonitor({
      base, live: live.client(base), state,
      notify: kind => { if (soundEnabled()) sounds.notify(kind) },
      completed: completion => {
        const notifications = desktop || (browserNotifications?.active.value ? browserNotifications : undefined)
        if (!notifications) return
        const compact = (value: string, limit = 300) => [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, limit).join('')
        void notifications.completed({
          projectId: completion.projectId, sessionId: completion.sessionId, turnId: completion.turnId,
          title: t('Task completed: {name}', { name: compact(completion.name, 100) || compact(completion.sessionId, 100) }),
          body: t('Project: {project}', { project: compact(completion.projectName) || compact(completion.projectId) }),
        }).then(() => { if (!disposed) notificationError.value = '' }, cause => {
          if (!disposed) notificationError.value = t('Could not show a system task notification. {error}', {
            error: cause instanceof Error ? cause.message : String(cause),
          })
        })
      },
      error: message => { sessionError.value = message },
    }) : undefined
  }, { immediate: true })
  function unlock(event: Event) { if (event.isTrusted && !sounds.ready.value && !sounds.error.value) void sounds.unlock() }
  function stored(event: StorageEvent) { if (event.key === SOUND_PREFERENCES_KEY || event.key === null) sounds.load() }
  onMounted(() => {
    stopActivation = desktop?.onActivated(openConversation)
    document.addEventListener('pointerdown', unlock, true)
    document.addEventListener('keydown', unlock, true)
    window.addEventListener('storage', stored)
  })
  onUnmounted(() => {
    disposed = true
    stopActivation?.()
    browserNotifications?.dispose()
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
  return { sounds, monitoringError, toggle, browserNotifications }
}
