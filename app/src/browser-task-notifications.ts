import { computed, inject, readonly, ref, type InjectionKey } from 'vue'
import { t } from './i18n.ts'
import { parseTaskCompletionNotification, type TaskCompletionNotification, type TaskNotificationTarget } from '../../desktop/src/task-notifications-contract.ts'

export const BROWSER_TASK_NOTIFICATIONS_KEY = 'shadow:task-notifications:v1'

interface BrowserNotice {
  onclick: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: Event) => void) | null
  close(): void
}

export interface BrowserNotificationHost {
  readonly isSecureContext: boolean
  readonly Notification?: {
    new(title: string, options?: NotificationOptions): BrowserNotice
    readonly permission: NotificationPermission
    requestPermission(): Promise<NotificationPermission>
  }
  readonly document: Pick<Document, 'hasFocus' | 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  readonly localStorage: Pick<Storage, 'getItem' | 'setItem'>
  focus(): void
  addEventListener(event: string, listener: (event: Event) => void): unknown
  removeEventListener(event: string, listener: (event: Event) => void): unknown
}

export function createBrowserTaskNotifications(host: BrowserNotificationHost, activate: (target: TaskNotificationTarget) => void) {
  const supported = host.isSecureContext && typeof host.Notification === 'function'
  const enabled = ref(false)
  const permission = ref<NotificationPermission | 'unsupported'>(supported ? host.Notification!.permission : 'unsupported')
  const requesting = ref(false)
  const preferenceError = ref('')
  const permissionError = ref('')
  const displayError = ref('')
  const error = computed(() => [preferenceError.value, permissionError.value, displayError.value].filter(Boolean).join(' '))
  const active = computed(() => supported && enabled.value && permission.value === 'granted')
  const seen = new Set<string>()
  const notices = new Set<BrowserNotice>()
  let disposed = false
  function refresh() { permission.value = supported ? host.Notification!.permission : 'unsupported' }
  function load() {
    try {
      const value = host.localStorage.getItem(BROWSER_TASK_NOTIFICATIONS_KEY)
      const saved: unknown = value === null ? false : JSON.parse(value)
      if (typeof saved !== 'boolean') throw new TypeError('Invalid browser notification preference')
      enabled.value = saved
      preferenceError.value = ''
    } catch {
      enabled.value = false
      preferenceError.value = t('Could not read browser notification settings. Enable notifications again to save your choice.')
    }
    refresh()
  }
  function save() {
    try {
      host.localStorage.setItem(BROWSER_TASK_NOTIFICATIONS_KEY, JSON.stringify(enabled.value))
      preferenceError.value = ''
    } catch {
      preferenceError.value = t('Browser notification settings changed, but could not be saved on this device.')
    }
  }
  async function setEnabled(value: boolean) {
    if (disposed || requesting.value) return
    permissionError.value = ''
    if (!value) { enabled.value = false; save(); return }
    if (!supported) {
      permissionError.value = t('System notifications require a supported browser and HTTPS or localhost.')
      return
    }
    refresh()
    if (permission.value === 'denied') {
      permissionError.value = t('Browser notifications are blocked. Allow notifications in this site’s browser settings, then try again.')
      return
    }
    requesting.value = true
    try {
      const granted = permission.value === 'granted' ? 'granted' : await host.Notification!.requestPermission()
      if (disposed) return
      permission.value = granted
      if (granted !== 'granted') {
        permissionError.value = t('Notification permission was not granted. Enable notifications again when you are ready.')
        return
      }
      enabled.value = true
      save()
    } catch (cause) {
      permissionError.value = t('Could not request notification permission. {error}', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
    } finally { requesting.value = false }
  }
  async function completed(input: TaskCompletionNotification): Promise<void> {
    if (disposed) return
    refresh()
    if (!active.value) return
    const message = parseTaskCompletionNotification(input)
    const key = JSON.stringify([message.projectId, message.sessionId, message.turnId])
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > 2000) seen.delete(seen.values().next().value!)
    if (host.document.visibilityState === 'visible' && host.document.hasFocus()) return
    let notice: BrowserNotice
    try {
      notice = new host.Notification!(message.title, { body: message.body, tag: `shadow-task:${key}`, silent: true })
    } catch (cause) { seen.delete(key); throw cause }
    displayError.value = ''
    const release = () => { notices.delete(notice); notice.onclick = notice.onerror = notice.onclose = null }
    notice.onclick = () => {
      if (!disposed) { host.focus(); activate({ projectId: message.projectId, sessionId: message.sessionId }) }
      notice.close()
      release()
    }
    notice.onclose = release
    notice.onerror = () => {
      displayError.value = t('The browser could not display the task notification. Check site and system notification settings.')
      release()
    }
    notices.add(notice)
    if (notices.size > 64) {
      const oldest = notices.values().next().value!
      notices.delete(oldest)
      oldest.onclick = oldest.onerror = oldest.onclose = null
      oldest.close()
    }
  }
  const stored = (event: Event) => {
    if ('key' in event && (event.key === BROWSER_TASK_NOTIFICATIONS_KEY || event.key === null)) load()
  }
  load()
  host.addEventListener('focus', refresh)
  host.addEventListener('storage', stored)
  host.document.addEventListener('visibilitychange', refresh)
  return {
    supported, enabled: readonly(enabled), permission: readonly(permission), requesting: readonly(requesting),
    active: readonly(active), error: readonly(error), setEnabled, completed,
    dispose() {
      if (disposed) return
      disposed = true
      host.removeEventListener('focus', refresh)
      host.removeEventListener('storage', stored)
      host.document.removeEventListener('visibilitychange', refresh)
      for (const notice of notices) { notice.onclick = notice.onerror = notice.onclose = null; notice.close() }
      notices.clear()
      seen.clear()
    },
  }
}

export type BrowserTaskNotifications = ReturnType<typeof createBrowserTaskNotifications>
export const browserTaskNotificationsKey: InjectionKey<BrowserTaskNotifications | null> = Symbol('browser-task-notifications')
export function useBrowserTaskNotifications() { return inject(browserTaskNotificationsKey, null) }
