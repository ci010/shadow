import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BROWSER_TASK_NOTIFICATIONS_KEY, createBrowserTaskNotifications, type BrowserNotificationHost,
} from './browser-task-notifications.ts'

const message = {
  projectId: 'release', sessionId: 'web:check', turnId: 'turn-1',
  title: 'Task completed: Release check', body: 'Project: Release Project',
}

function fixture(options: { secure?: boolean; available?: boolean; saved?: string; storageFailed?: boolean } = {}) {
  const events = new EventTarget()
  const document = new EventTarget()
  const storage = new Map<string, string>()
  if (options.saved !== undefined) storage.set(BROWSER_TASK_NOTIFICATIONS_KEY, options.saved)
  let permission: NotificationPermission = 'default'
  let grant: NotificationPermission = 'granted'
  let focused = false
  let visibility: DocumentVisibilityState = 'hidden'
  let requests = 0
  let focusCalls = 0
  let constructionFailed = false
  const targets: unknown[] = []
  class Notice {
    static get permission() { return permission }
    static async requestPermission() { requests++; permission = grant; return grant }
    onclick: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null
    closed = 0
    constructor(readonly title: string, readonly options?: NotificationOptions) {
      if (constructionFailed) throw new Error('Notification constructor unavailable')
      notices.push(this)
    }
    close() { this.closed++; this.onclose?.(new Event('close')) }
  }
  const notices: Notice[] = []
  const host: BrowserNotificationHost = Object.assign(events, {
    isSecureContext: options.secure !== false,
    Notification: options.available === false ? undefined : Notice,
    document: Object.assign(document, {
      get visibilityState() { return visibility },
      hasFocus: () => focused,
    }),
    localStorage: {
      getItem(key: string) {
        if (options.storageFailed) throw new Error('Storage blocked')
        return storage.get(key) ?? null
      },
      setItem(key: string, value: string) {
        if (options.storageFailed) throw new Error('Storage blocked')
        storage.set(key, value)
      },
    },
    focus: () => { focusCalls++ },
  })
  // Define a live visibility property, rather than Object.assign's getter snapshot.
  Object.defineProperty(host.document, 'visibilityState', { get: () => visibility })
  const controller = createBrowserTaskNotifications(host, target => { targets.push(target) })
  return {
    controller, events, document, storage, notices, targets,
    requests: () => requests, focusCalls: () => focusCalls,
    permission: (value: NotificationPermission) => { permission = value },
    grant: (value: NotificationPermission) => { grant = value },
    focus: (value: boolean, visible: DocumentVisibilityState = 'visible') => { focused = value; visibility = visible },
    failConstruction: () => { constructionFailed = true },
  }
}

test('browser notification permission is requested only by explicit opt-in, independently of audio', async t => {
  const f = fixture()
  t.after(f.controller.dispose)
  assert.equal(f.requests(), 0)
  assert.equal(f.controller.active.value, false)
  await f.controller.completed(message)
  assert.equal(f.notices.length, 0)
  await f.controller.setEnabled(true)
  assert.equal(f.requests(), 1)
  assert.equal(f.controller.active.value, true)
  assert.equal(f.storage.get(BROWSER_TASK_NOTIFICATIONS_KEY), 'true')
  await f.controller.completed(message)
  const notice = f.notices[0]
  assert.ok(notice)
  assert.equal(notice.title, message.title)
  assert.equal(notice.options?.body, message.body)
  assert.equal(notice.options?.silent, true)
  assert.match(notice.options?.tag ?? '', /release.*web:check.*turn-1/)
  notice.onclick?.(new Event('click'))
  assert.equal(f.focusCalls(), 1)
  assert.deepEqual(f.targets, [{ projectId: 'release', sessionId: 'web:check' }])
  assert.equal(notice.closed, 1)
})

test('focus, visibility, disabled preferences and repeated turn identities gate notifications without backlog', async t => {
  const f = fixture({ saved: 'true' })
  t.after(f.controller.dispose)
  f.permission('granted')
  f.events.dispatchEvent(new Event('focus'))
  assert.equal(f.requests(), 0, 'Stored preferences never prompt on load or refresh')
  f.focus(true)
  await f.controller.completed(message)
  f.focus(false)
  await f.controller.completed(message)
  assert.equal(f.notices.length, 0)
  await f.controller.completed({ ...message, turnId: 'turn-2' })
  await f.controller.completed({ ...message, turnId: 'turn-2' })
  assert.equal(f.notices.length, 1)
  f.focus(true, 'hidden')
  await f.controller.completed({ ...message, turnId: 'turn-3' })
  assert.equal(f.notices.length, 2, 'Hidden pages notify even when a browser reports retained focus')
  await f.controller.setEnabled(false)
  await f.controller.completed({ ...message, turnId: 'turn-4' })
  assert.equal(f.notices.length, 2)
  assert.equal(f.storage.get(BROWSER_TASK_NOTIFICATIONS_KEY), 'false')
})

test('denied, dismissed, unsupported and insecure notification permissions have actionable errors', async t => {
  const denied = fixture()
  t.after(denied.controller.dispose)
  denied.grant('denied')
  await denied.controller.setEnabled(true)
  assert.equal(denied.controller.active.value, false)
  await denied.controller.setEnabled(true)
  assert.equal(denied.requests(), 1, 'A denial never triggers repeated permission prompts')
  assert.match(denied.controller.error.value, /site.*browser settings/)
  const dismissed = fixture()
  t.after(dismissed.controller.dispose)
  dismissed.grant('default')
  await dismissed.controller.setEnabled(true)
  assert.match(dismissed.controller.error.value, /not granted/)
  for (const options of [{ secure: false }, { available: false }]) {
    const unsupported = fixture(options)
    t.after(unsupported.controller.dispose)
    await unsupported.controller.setEnabled(true)
    assert.equal(unsupported.requests(), 0)
    assert.equal(unsupported.controller.active.value, false)
    assert.match(unsupported.controller.error.value, /HTTPS or localhost/)
  }
})

test('permission revocation and cross-tab preference changes apply before the next completion', async t => {
  const f = fixture()
  t.after(f.controller.dispose)
  await f.controller.setEnabled(true)
  f.permission('denied')
  await f.controller.completed(message)
  assert.equal(f.notices.length, 0)
  assert.equal(f.controller.active.value, false)
  f.permission('granted')
  f.events.dispatchEvent(new Event('focus'))
  assert.equal(f.controller.active.value, true)
  f.storage.set(BROWSER_TASK_NOTIFICATIONS_KEY, 'false')
  f.events.dispatchEvent(Object.assign(new Event('storage'), { key: BROWSER_TASK_NOTIFICATIONS_KEY }))
  assert.equal(f.controller.active.value, false)
  await f.controller.completed(message)
  assert.equal(f.notices.length, 0)
})

test('storage and notification failures are explicit, and disposal removes callbacks and closes toasts', async () => {
  const broken = fixture({ saved: '{}' })
  assert.match(broken.controller.error.value, /Could not read/)
  await broken.controller.setEnabled(true)
  assert.equal(broken.controller.error.value, '')
  broken.failConstruction()
  await assert.rejects(broken.controller.completed(message), /constructor unavailable/)
  broken.controller.dispose()
  const blocked = fixture({ storageFailed: true })
  await blocked.controller.setEnabled(true)
  assert.match(blocked.controller.error.value, /could not be saved/)
  blocked.controller.dispose()
  const f = fixture()
  await f.controller.setEnabled(true)
  await f.controller.completed(message)
  const first = f.notices[0]
  assert.ok(first)
  first.onerror?.(new Event('error'))
  assert.match(f.controller.error.value, /could not display/)
  await f.controller.completed({ ...message, turnId: 'next' })
  const next = f.notices[1]
  assert.ok(next)
  f.controller.dispose()
  f.controller.dispose()
  assert.equal(next.closed, 1)
  assert.equal(next.onclick, null)
  await f.controller.completed({ ...message, turnId: 'disposed' })
  assert.equal(f.notices.length, 2)
})
