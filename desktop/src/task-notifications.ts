import type { RendererTarget } from './renderer-target.js'
import { createNavigationPolicy } from './security-policy.js'
import type { WindowControlsIpc } from './window-controls.js'
import { parseTaskCompletionNotification, TASK_NOTIFICATION_CHANNELS } from './task-notifications-contract.js'

interface NotificationWindow {
  isDestroyed(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
  readonly webContents: {
    readonly mainFrame: { readonly url: string }
    isDestroyed(): boolean
    send(channel: string, value: unknown): void
  }
}

interface NativeNotification {
  show(): void
  close(): void
  once(event: 'click' | 'close' | 'failed', listener: (event: unknown, error?: string) => void): unknown
  removeAllListeners(): unknown
}

export function installTaskNotifications(
  ipc: WindowControlsIpc,
  window: NotificationWindow,
  target: RendererTarget,
  notifications: {
    supported(): boolean
    create(input: { title: string; body: string }): NativeNotification
    onError(message: string): void
  },
): () => void {
  const policy = createNavigationPolicy(target)
  const seen = new Set<string>()
  const active = new Set<NativeNotification>()
  let disposed = false
  const trusted = () => !disposed && !window.isDestroyed() && !window.webContents.isDestroyed()
    && policy.isAllowed(window.webContents.mainFrame.url)
  ipc.handle(TASK_NOTIFICATION_CHANNELS.completed, (event, ...args) => {
    if (!trusted() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new TypeError('Task notifications require the trusted Main window')
    }
    if (args.length !== 1) throw new TypeError('Task notifications require one completion')
    const message = parseTaskCompletionNotification(args[0])
    const key = JSON.stringify([message.projectId, message.sessionId, message.turnId])
    if (seen.has(key)) return
    if (!window.isFocused() && !notifications.supported()) throw new Error('System notifications are unavailable')
    seen.add(key)
    if (seen.size > 2000) seen.delete(seen.values().next().value!)
    if (window.isFocused()) return
    const notice = notifications.create({ title: message.title, body: message.body })
    const release = () => { active.delete(notice); notice.removeAllListeners() }
    notice.once('click', () => {
      if (!trusted()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      window.webContents.send(TASK_NOTIFICATION_CHANNELS.activated, {
        projectId: message.projectId, sessionId: message.sessionId,
      })
    })
    notice.once('close', release)
    notice.once('failed', (_event, error) => {
      release()
      notifications.onError(error || 'System task notification failed')
    })
    active.add(notice)
    if (active.size > 64) {
      const oldest = active.values().next().value!
      active.delete(oldest)
      oldest.removeAllListeners()
      oldest.close()
    }
    try { notice.show() } catch (error) { release(); seen.delete(key); throw error }
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    ipc.removeHandler(TASK_NOTIFICATION_CHANNELS.completed)
    window.removeListener('closed', dispose)
    for (const notice of active) { notice.removeAllListeners(); notice.close() }
    active.clear()
    seen.clear()
  }
  window.once('closed', dispose)
  return dispose
}
