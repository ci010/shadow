import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { installTaskNotifications } from '../../src/task-notifications.js'

app.setPath('userData', join(process.cwd(), 'profile'))
app.setAppUserModelId('com.shadow.app')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  assert.equal(Notification.isSupported(), true)
  const web = process.env.TASK_NOTIFICATION_WEB === '1'
  const base = process.env.TASK_NOTIFICATION_SMOKE_URL!
  const window = new BrowserWindow({
    width: 700, height: 400, show: false,
    webPreferences: {
      ...(web ? {} : { preload: join(process.cwd(), 'preload.cjs') }),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    },
  })
  if (web) {
    window.showInactive()
    window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'notifications'))
    window.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === 'notifications')
  }
  const notices: Notification[] = []
  let shown = 0
  const errors: string[] = []
  const dispose = installTaskNotifications(ipcMain, window, {
    kind: 'url', url: base, origin: new URL(base).origin,
  }, {
    supported: () => Notification.isSupported(),
    create: message => {
      const notice = new Notification({ ...message, silent: true })
      notice.once('show', () => { shown++ })
      notices.push(notice)
      return notice
    },
    onError: message => { errors.push(message) },
  })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (check: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await check()) return; await delay(25) }
    throw new Error(`Timed out: ${await execute('document.body.innerText')}; ${errors.join('; ')}; ${
      await execute(`JSON.stringify({monitoring:window.fixture?.monitoring(),webNotices:window.fixture?.webNotices.length,
        permission:Notification.permission})`)}`)
  }
  try {
    await window.loadURL(new URL(web ? '__task-notifications?web' : '__task-notifications', base).href)
    await wait(() => execute('!!window.fixture && window.fixture.ready()'))
    await delay(250)
    assert.equal(await execute('window.fixture.muted()'), true)
    assert.equal(window.isFocused(), false)
    if (web) {
      assert.equal(await execute('window.shadowDesktop === undefined'), true)
      assert.equal(await execute('window.fixture.webEnabled()'), false)
      assert.equal(await execute('window.fixture.webNotices.length'), 0, 'There are no automatic web notification requests or toasts')
      await window.webContents.executeJavaScript(`document.querySelector('.browser-notification-settings .btn').click()`, true)
      await wait(() => execute('window.fixture.webEnabled() && window.fixture.monitoring()'))
      await delay(250)
      await execute(`window.fixture.finish('browser-turn')`)
      await wait(() => execute('window.fixture.webNotices.length === 1'))
      assert.deepEqual(await execute(`({title:window.fixture.webNotices[0].title,body:window.fixture.webNotices[0].body})`), {
        title: '任务已完成：Release check', body: '项目：Release Project',
      })
      await execute(`window.fixture.finish('browser-turn')`)
      await delay(200)
      assert.equal(await execute('window.fixture.webNotices.length'), 1)
      await window.webContents.executeJavaScript(`window.fixture.webNotices[0].dispatchEvent(new Event('click'))`, true)
      await wait(() => execute(`window.fixture.path() === '/projects/release/chat/web:check'`))
      window.show()
      window.focus()
      await wait(() => execute('document.hasFocus()'))
      await execute(`window.fixture.finish('browser-focused-turn')`)
      await delay(250)
      assert.equal(await execute('window.fixture.webNotices.length'), 1)
      for (const width of [700, 390]) {
        window.setContentSize(width, 600)
        assert.equal(await execute('document.documentElement.scrollWidth > innerWidth'), false)
        assert.ok(await execute(`document.querySelector('.browser-notification-settings .btn').getBoundingClientRect().height >= 44`))
      }
      await execute(`document.querySelector('.browser-notification-settings .btn').click()`)
      await wait(() => execute('!window.fixture.webEnabled()'))
      assert.equal(await execute('window.fixture.error()'), '')
      await execute('window.fixture.dispose()')
      assert.deepEqual(errors, [])
      console.log('TASK_NOTIFICATION_SMOKE_OK')
      return
    }
    await execute(`window.fixture.finish('background-turn')`)
    await wait(() => notices.length === 1)
    await wait(() => shown === 1)
    const notice = notices[0]!
    assert.equal(notice.title, '任务已完成：Release check')
    assert.equal(notice.body, '项目：Release Project')
    await execute(`window.fixture.finish('background-turn')`)
    await delay(200)
    assert.equal(notices.length, 1, 'Completion replay does not create another system notification')
    window.minimize()
    notice.emit('click', {})
    await wait(() => execute(`window.fixture.path() === '/projects/release/chat/web:check'`))
    assert.equal(window.isMinimized(), false)
    await wait(() => window.isFocused())
    await execute(`window.fixture.finish('focused-turn')`)
    await delay(250)
    assert.equal(notices.length, 1, 'The native focus gate suppresses foreground completions')
    assert.equal(await execute('window.fixture.error()'), '')
    await execute('window.fixture.dispose()')
    assert.deepEqual(errors, [])
    console.log('TASK_NOTIFICATION_SMOKE_OK')
  } finally {
    dispose()
    window.destroy()
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
