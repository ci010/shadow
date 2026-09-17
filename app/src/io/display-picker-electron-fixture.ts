import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { installMediaPermissions } from '../../../desktop/src/media-permissions.ts'
import { resolveRendererTarget } from '../../../desktop/src/renderer-target.ts'
import { secureWebPreferences } from '../../../desktop/src/window-controls.ts'

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  const url = process.env.PICKER_SMOKE_URL!
  const window = new BrowserWindow({ show: false, width: 1040, height: 820, webPreferences: { ...secureWebPreferences(join(process.cwd(), 'preload.cjs')), backgroundThrottling: false } })
  const execute = (code: string, gesture = false) => window.webContents.executeJavaScript(code, gesture)
  let mode: 'ready' | 'empty' | 'error' | 'pending' = 'ready'
  let release!: () => void
  let enumerations = 0
  let selections: string[] = []
  const thumbnail = nativeImage.createFromBitmap(Buffer.from(Array.from({ length: 320 * 180 }, () => [136, 88, 38, 255]).flat()), { width: 320, height: 180 })
  const sources: Electron.DesktopCapturerSource[] = [
    { id: 'screen:synthetic-1', name: 'Synthetic screen', display_id: 'fixture', thumbnail, appIcon: null },
    { id: 'window:synthetic-2', name: 'Synthetic window — project notes with a deliberately long title for narrow layouts', display_id: '', thumbnail, appIcon: null },
    { id: 'window:synthetic-3', name: 'Window without a preview', display_id: '', thumbnail: nativeImage.createEmpty(), appIcon: null },
  ]
  // Exercise Chromium's real getDisplayMedia request and our production handler,
  // but never pass even a synthetic selection to Chromium's device acquisition.
  const session = window.webContents.session
  const original = session.setDisplayMediaRequestHandler.bind(session)
  session.setDisplayMediaRequestHandler = (handler, options) => original(handler && ((request, callback) => {
    handler(request, selection => {
      if (selection.video && 'id' in selection.video) selections.push(selection.video.id)
      try { callback({}) } catch { /* Electron rejects a missing video after denying the request. */ }
    })
  }), options)
  installMediaPermissions(ipcMain, window, resolveRendererTarget({ rendererDistPath: process.cwd(), developmentUrl: url }), {
    async getDisplaySources() {
      enumerations++
      if (mode === 'pending') await new Promise<void>(resolve => { release = resolve })
      if (mode === 'error') throw new Error('Synthetic OS denial; do not display raw details')
      return mode === 'empty' ? [] : sources
    },
  })
  const wait = async (condition: string, label: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(condition)) return; await delay(30) }
    throw new Error(`${label}: ${await execute('document.body.innerText')}`)
  }
  const button = (text: string) => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`
  const click = async (text: string) => {
    assert.equal(await execute(`!!${button(text)} && !${button(text)}.disabled`), true, `${text} enabled`)
    await execute(`${button(text)}.click()`, true)
  }
  const start = async () => {
    selections = []
    await execute(`document.querySelector('#start').focus()`)
    await click('Start capture')
    await wait(`document.querySelector('dialog').open`, 'Picker opens')
  }
  const closed = async () => {
    await wait(`!document.querySelector('dialog').open && window.pickerResult !== 'pending'`, 'Picker and acquisition settle')
    assert.match(await execute('window.pickerResult'), /^(NotAllowedError|AbortError)$/)
    assert.equal(await execute(`document.activeElement.id`), 'start', 'Focus returns to Start')
    await execute(`shadowDesktop.mediaCapture.revoke({runId:window.pickerRun})`)
    await delay(30)
  }
  const capture = async (name: string) => {
    if (process.env.PICKER_SCREENSHOT_DIR) await writeFile(join(process.env.PICKER_SCREENSHOT_DIR, name), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadURL(url)
    await wait(`!!document.querySelector('#start')`, 'Fixture mounts')
    assert.equal(enumerations, 0, 'No enumeration or capture before Start')
    await start()
    await wait(`document.querySelectorAll('input[type=radio]').length === 3`, 'Thumbnails offered')
    assert.equal(await execute(`document.querySelector('.share-source').disabled`), true, 'No default source')
    assert.equal(await execute(`document.querySelector('input:checked') === null`), true)
    assert.equal(await execute(`document.activeElement.textContent`), 'Cancel', 'Safe initial focus')
    await wait(`[...document.querySelectorAll('.source-preview img')].every(img => img.complete && img.naturalWidth > 0)`, 'Real image elements render synthetic thumbnails')
    assert.equal(await execute(`document.querySelectorAll('.preview-unavailable').length`), 1)
    assert.equal(await execute(`document.querySelector('dialog').matches(':modal')`), true, 'Modal top layer traps focus and makes background inert')
    await execute(`document.querySelectorAll('input[type=radio]')[1].click()`, true)
    assert.deepEqual(selections, [], 'Selecting alone never shares')
    await capture('display-picker-desktop.png')
    await click('Share selected')
    await closed()
    assert.deepEqual(selections, ['window:synthetic-2'], 'Exact offered source is resolved in Main')

    window.setContentSize(390, 720)
    await execute(`document.documentElement.classList.add('dark')`)
    await start()
    await wait(`document.querySelectorAll('input[type=radio]').length === 3`, 'New picker ready')
    assert.equal(await execute(`document.querySelector('input:checked') === null`), true, 'New request resets selection')
    assert.equal(await execute(`(() => { const d = document.querySelector('dialog'); const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth })()`), true, 'Mobile dialog fits without horizontal overflow')
    await capture('display-picker-mobile.png')
    await execute(`document.querySelector('input[type=radio]').focus()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
    await wait(`document.querySelectorAll('input[type=radio]')[1].checked`, 'Native radio arrow navigation selects next source')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await closed()
    assert.deepEqual(selections, [], 'Escape denies')

    for (const nextMode of ['empty', 'error', 'pending'] as const) {
      mode = nextMode
      await start()
      await wait(`document.body.innerText.includes(${JSON.stringify(nextMode === 'empty' ? 'No screens or windows' : nextMode === 'error' ? 'Could not load screens' : 'Loading screen')})`, `${nextMode} visible`)
      assert.equal(await execute(`document.querySelector('.share-source').disabled`), true)
      await click('Cancel')
      await closed()
      if (nextMode === 'pending') { release(); await delay(50); assert.equal(await execute(`document.querySelector('dialog').open`), false, 'Late enumeration cannot reopen') }
      assert.deepEqual(selections, [])
    }
    mode = 'pending'
    await start()
    await execute(`shadowDesktop.mediaCapture.revoke({runId:window.pickerRun})`)
    await closed()
    release()
    await delay(50)
    mode = 'pending'
    await execute(`window.pickerDuration = 300`)
    await start()
    await closed()
    release()
    console.log('DISPLAY_PICKER_SMOKE_OK thumbnails explicit-select cancel escape radio-keyboard focus mobile loading empty error revoke expiry late-results no-physical-acquisition')
  } finally { window.destroy() }
}
void app.whenReady().then(main).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
