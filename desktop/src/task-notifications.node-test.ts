import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { installTaskNotifications } from './task-notifications.js'
import {
  createTaskNotificationsApi, parseTaskCompletionNotification, parseTaskNotificationTarget,
  TASK_NOTIFICATION_CHANNELS, type TaskCompletionNotification,
} from './task-notifications-contract.js'
import type { WindowControlsIpc } from './window-controls.js'

const message: TaskCompletionNotification = {
  projectId: 'project-a', sessionId: 'web:report', turnId: 'turn-1',
  title: 'Task completed', body: 'Release report has completed in Work.',
}

class FakeWindow extends EventEmitter {
  destroyed = false
  focused = false
  minimized = false
  actions: string[] = []
  messages: unknown[] = []
  webContents = {
    mainFrame: { url: 'http://localhost:5173/projects/a/chat' },
    isDestroyed: () => this.destroyed,
    send: (channel: string, value: unknown) => { this.messages.push({ channel, value }) },
  }
  isDestroyed = () => this.destroyed
  isFocused = () => this.focused
  isMinimized = () => this.minimized
  restore = () => { this.actions.push('restore'); this.minimized = false }
  show = () => { this.actions.push('show') }
  focus = () => { this.actions.push('focus'); this.focused = true }
}

class FakeNotice extends EventEmitter {
  shown = 0
  closed = 0
  show() { this.shown++ }
  close() { this.closed++; this.emit('close', {}) }
}

function fixture() {
  const window = new FakeWindow()
  const handlers = new Map<string, Parameters<WindowControlsIpc['handle']>[1]>()
  const ipc: WindowControlsIpc = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: channel => { handlers.delete(channel) },
  }
  const notices: { notice: FakeNotice; input: { title: string; body: string } }[] = []
  const errors: string[] = []
  let supported = true
  const dispose = installTaskNotifications(ipc, window, {
    kind: 'url', url: 'http://localhost:5173/', origin: 'http://localhost:5173',
  }, {
    supported: () => supported,
    create: input => {
      const notice = new FakeNotice()
      notices.push({ notice, input })
      return notice
    },
    onError: message => { errors.push(message) },
  })
  const invoke = (...args: unknown[]) => handlers.get(TASK_NOTIFICATION_CHANNELS.completed)!({
    sender: window.webContents, senderFrame: window.webContents.mainFrame,
  }, ...args)
  return { window, handlers, notices, errors, dispose, invoke, unsupported: () => { supported = false } }
}

test('unfocused and minimized windows show named native completions; focus and duplicate turns stay quiet', t => {
  const f = fixture()
  t.after(f.dispose)
  f.window.focused = true
  f.invoke(message)
  f.window.focused = false
  f.invoke(message)
  assert.equal(f.notices.length, 0, 'A focused completion is never shown later as a backlog')
  f.invoke({ ...message, turnId: 'turn-2' })
  f.invoke({ ...message, turnId: 'turn-2' })
  assert.equal(f.notices.length, 1)
  const first = f.notices[0]
  assert.ok(first)
  assert.equal(first.notice.shown, 1)
  assert.deepEqual(first.input, { title: message.title, body: message.body })
  f.window.minimized = true
  f.invoke({ ...message, projectId: 'project-b', turnId: 'turn-2', body: 'Different Project report completed.' })
  assert.equal(f.notices.length, 2, 'Projects with identical session and turn IDs remain independent')
  const second = f.notices[1]
  assert.ok(second)
  second.notice.emit('click', {})
  assert.deepEqual(f.window.actions, ['restore', 'show', 'focus'])
  assert.deepEqual(f.window.messages, [{
    channel: TASK_NOTIFICATION_CHANNELS.activated,
    value: { projectId: 'project-b', sessionId: 'web:report' },
  }])
})

test('native notification errors are reported and unsupported systems reject explicitly', t => {
  const f = fixture()
  t.after(f.dispose)
  f.invoke(message)
  const first = f.notices[0]
  assert.ok(first)
  first.notice.emit('failed', {}, 'Windows notifications are disabled')
  assert.deepEqual(f.errors, ['Windows notifications are disabled'])
  assert.equal(first.notice.listenerCount('click'), 0)
  f.unsupported()
  assert.throws(() => f.invoke({ ...message, turnId: 'next' }), /unavailable/)
})

test('native notifications validate provenance, documents, payloads and disposal', () => {
  const f = fixture()
  const handler = f.handlers.get(TASK_NOTIFICATION_CHANNELS.completed)!
  for (const event of [
    { sender: {}, senderFrame: f.window.webContents.mainFrame },
    { sender: f.window.webContents, senderFrame: {} },
    { sender: f.window.webContents },
  ]) assert.throws(() => handler(event, message), /trusted Main window/)
  f.window.webContents.mainFrame.url = 'https://untrusted.example/'
  assert.throws(() => f.invoke(message), /trusted Main window/)
  f.window.webContents.mainFrame.url = 'http://localhost:5173/chat'
  assert.throws(() => f.invoke(), /one completion/)
  assert.throws(() => f.invoke(message, message), /one completion/)
  assert.throws(() => f.invoke({ ...message, body: '' }), /Invalid task notification/)
  f.invoke(message)
  const first = f.notices[0]
  assert.ok(first)
  const notice = first.notice
  f.window.webContents.mainFrame.url = 'https://untrusted.example/'
  notice.emit('click', {})
  assert.deepEqual(f.window.actions, [])
  f.window.emit('closed')
  f.dispose()
  assert.equal(f.handlers.size, 0)
  assert.equal(notice.closed, 1)
  assert.equal(notice.listenerCount('click'), 0)
  assert.equal(f.window.listenerCount('closed'), 0)
  assert.throws(() => handler({
    sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame,
  }, message), /trusted Main window/)
})

test('notification contracts reject missing, oversized, control-character and extra fields', () => {
  assert.deepEqual(parseTaskCompletionNotification(message), message)
  assert.deepEqual(parseTaskNotificationTarget({ projectId: 'a', sessionId: 'web:a' }), { projectId: 'a', sessionId: 'web:a' })
  for (const value of [
    null, [], {}, { ...message, turnId: undefined }, { ...message, title: ' ' },
    { ...message, body: 'bad\ntext' }, { ...message, title: 'x'.repeat(257) },
    { ...message, body: 'x'.repeat(2049) }, { ...message, sessionId: 'x'.repeat(513) },
    { ...message, url: 'https://untrusted.example/' },
  ]) assert.throws(() => parseTaskCompletionNotification(value), /Invalid task notification/)
  assert.throws(() => parseTaskNotificationTarget(message), /Invalid task notification/)
})

test('preload exposes only validated completion requests and removable activation callbacks', async () => {
  const events = new EventEmitter()
  const sent: unknown[] = []
  const api = createTaskNotificationsApi({
    invoke: async (channel, value) => { sent.push({ channel, value }) },
    on: (channel, listener) => events.on(channel, listener),
    removeListener: (channel, listener) => events.removeListener(channel, listener),
  })
  assert.equal(Object.isFrozen(api), true)
  await api.completed(message)
  assert.deepEqual(sent, [{ channel: TASK_NOTIFICATION_CHANNELS.completed, value: message }])
  await assert.rejects(api.completed({ ...message, body: '' }), /Invalid task notification/)
  const targets: unknown[] = []
  const stop = api.onActivated(target => { targets.push(target) })
  events.emit(TASK_NOTIFICATION_CHANNELS.activated, {}, { projectId: 'a', sessionId: 'web:report' })
  assert.deepEqual(targets, [{ projectId: 'a', sessionId: 'web:report' }])
  assert.throws(() => events.emit(TASK_NOTIFICATION_CHANNELS.activated, {}, { projectId: 'a', sessionId: 42 }), /Invalid task notification/)
  stop()
  stop()
  assert.equal(events.listenerCount(TASK_NOTIFICATION_CHANNELS.activated), 0)
})
