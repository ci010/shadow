export const TASK_NOTIFICATION_CHANNELS = {
  completed: 'shadow:notifications:task-completed',
  activated: 'shadow:notifications:task-activated',
} as const

export interface TaskNotificationTarget {
  readonly projectId: string
  readonly sessionId: string
}

export interface TaskCompletionNotification extends TaskNotificationTarget {
  readonly turnId: string
  readonly title: string
  readonly body: string
}

export interface DesktopTaskNotificationsApi {
  completed(notification: TaskCompletionNotification): Promise<void>
  onActivated(listener: (target: TaskNotificationTarget) => void): () => void
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError('Invalid task notification')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Invalid task notification text')
  }
  return value
}

export function parseTaskNotificationTarget(value: unknown): TaskNotificationTarget {
  const target = fields(value, ['projectId', 'sessionId'])
  return { projectId: text(target.projectId, 512), sessionId: text(target.sessionId, 512) }
}

export function parseTaskCompletionNotification(value: unknown): TaskCompletionNotification {
  const notification = fields(value, ['projectId', 'sessionId', 'turnId', 'title', 'body'])
  return {
    projectId: text(notification.projectId, 512), sessionId: text(notification.sessionId, 512),
    turnId: text(notification.turnId, 512), title: text(notification.title, 256), body: text(notification.body, 2048),
  }
}

export function createTaskNotificationsApi(ipc: {
  invoke(channel: string, value: unknown): Promise<unknown>
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown
}): DesktopTaskNotificationsApi {
  return Object.freeze({
    completed: async (notification: TaskCompletionNotification) => {
      await ipc.invoke(TASK_NOTIFICATION_CHANNELS.completed, parseTaskCompletionNotification(notification))
    },
    onActivated(listener: (target: TaskNotificationTarget) => void) {
      const receive = (_event: unknown, value: unknown) => { listener(parseTaskNotificationTarget(value)) }
      ipc.on(TASK_NOTIFICATION_CHANNELS.activated, receive)
      return () => ipc.removeListener(TASK_NOTIFICATION_CHANNELS.activated, receive)
    },
  })
}
