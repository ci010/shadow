import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  const base = process.env.IO_SMOKE_URL!
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = async (code: string, gesture = false) => {
    try { return await window.webContents.executeJavaScript(code, gesture) }
    catch (cause) { throw new Error(`Renderer script failed: ${code}`, { cause }) }
  }
  const state = () => execute(`({text:document.body.innerText, acquired:window.__ioSmoke?.acquired, live:window.__ioSmoke?.liveTracks})`)
  const wait = async (condition: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await condition()) return; await delay(50) }
    throw new Error(`${label}\n${JSON.stringify(await state())}`)
  }
  const button = (label: string) => `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
  const click = async (label: string) => {
    assert.equal(await execute(`!!${button(label)} && !${button(label)}.disabled`), true, `${label} is enabled`)
    await execute(`${button(label)}.click()`, true)
  }
  const control = async (command: string) => { assert.equal((await fetch(`${base}/__smoke/${command}`, { method: 'POST' })).ok, true) }
  const capture = async (name: string) => {
    if (process.env.IO_SCREENSHOT_DIR) await writeFile(join(process.env.IO_SCREENSHOT_DIR, name), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadURL(`${base}/__io-rendered`)
    await wait(() => execute(`!!document.querySelector('.chat-messages .io-request')`), 'Requested capture appears inside conversation')
    assert.equal(await execute(`!!document.querySelector('.io-panel')`), false, 'No separate I/O sidebar')
    assert.equal((await state()).acquired, 0, 'No capture on request arrival')
    await wait(() => execute(`document.querySelector('.request-state')?.textContent === 'Connecting'`), 'Connection prepares without a separate user step')
    assert.equal(await execute(`document.querySelector('.io-request .primary').disabled`), true)
    await control('ready')
    await wait(() => execute(`!!${button('Record audio')} && !${button('Record audio')}.disabled`), 'Ready enables explicit recording')
    assert.equal((await state()).acquired, 0, 'Ready alone never captures')
    assert.equal(await execute(`document.querySelector('.capture-details').open`), false, 'Technical details start folded')
    assert.equal(await execute(`document.body.innerText.includes('ws://127.0.0.1')`), false, 'Endpoint is not part of the primary interaction')
    await click('Record audio')
    await wait(async () => (await state()).live > 0, 'Fake microphone is live after Start')
    await wait(() => execute(`document.querySelector('.request-state')?.textContent === 'Recording'`), 'Recording is visibly distinct')
    await wait(() => execute(`[...document.querySelector('.input-device select').options].some(option => option.value === 'fixture-usb')`), 'Microphone options appear after permission')
    const acquired = (await state()).acquired
    await execute(`(() => {
      const select = document.querySelector('.input-device select');
      select.value = [...select.options].find(option => option.value && option.value !== 'default').value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`, true)
    await wait(async () => (await state()).acquired > acquired, 'Changing device acquires a replacement input')
    await wait(async () => (await state()).live === 1, 'Old microphone released after switching')
    await wait(() => execute(`!document.querySelector('.input-device select').disabled`), 'Device switch settles')
    await execute(`(() => { const select = document.querySelector('.input-device select'); select.value = 'fixture-denied'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`, true)
    await wait(() => execute(`document.body.innerText.includes('previous input is still selected') && document.querySelector('.input-device select').value === 'fixture-usb'`), 'Failed switch retains prior selection and gives a visible reason')
    await delay(300)
    assert.equal(await execute(`document.body.innerText.includes('previous input is still selected') && document.querySelector('.request-state').textContent === 'Recording'`), true, 'Device enumeration does not erase the switch error or interrupt recording')
    assert.equal((await state()).live, 1, 'Failed replacement leaves original capture active')
    await execute(`(() => { const select = document.querySelector('.input-device select'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); })()`, true)
    await wait(() => execute(`!document.querySelector('.input-device select').disabled && !document.body.innerText.includes('previous input is still selected')`), 'Switching back to system default succeeds')
    await wait(async () => (await state()).live === 1, 'System default switch releases previous USB input')
    const afterSwitch = (await state()).acquired
    await click('Other conversation')
    await wait(() => execute(`!!document.querySelector('.capture-status') && !document.querySelector('.io-request')`), 'Only compact capture status remains in another conversation')
    assert.equal((await state()).live, 1, 'Conversation navigation keeps input alive')
    await click('Open conversation')
    await wait(() => execute(`!!document.querySelector('.chat-messages .io-request') && !document.querySelector('.capture-status')`), 'Returning restores inline capture controls')
    assert.equal((await state()).acquired, afterSwitch, 'Returning never reacquires the microphone')
    await control('view')
    await wait(() => execute(`!!${button('Recompute')}`), 'Asynchronous backend control appears')
    await execute(`(() => {
      const field = document.querySelector('[data-io-control="notes"]');
      field.focus(); field.value = 'Unsent local notes'; field.setSelectionRange(6, 11);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })()`, true)
    await control('stream-text')
    await wait(() => execute(`document.body.innerText.includes('Streaming result during text edit')`), 'Results refresh during text editing')
    assert.deepEqual(await execute(`(() => {
      const field = document.querySelector('[data-io-control="notes"]');
      return { value: field.value, focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd };
    })()`), { value: 'Unsent local notes', focused: true, start: 6, end: 11 }, 'Streaming view preserves text, focus and selection')
    await execute(`(() => {
      const field = document.querySelector('[data-io-control="threshold"]');
      field.focus(); field.value = '42.5';
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })()`, true)
    await control('stream-number')
    await wait(() => execute(`document.body.innerText.includes('Streaming result during numeric edit')`), 'Results refresh during numeric editing')
    assert.deepEqual(await execute(`(() => {
      const field = document.querySelector('[data-io-control="threshold"]');
      return { value: field.value, focused: document.activeElement === field, notes: document.querySelector('[data-io-control="notes"]').value };
    })()`), { value: '42.5', focused: true, notes: 'Unsent local notes' }, 'Numeric draft and blurred unsent text survive backend replacement')
    await execute(`document.querySelector('[data-io-control="threshold"]').dispatchEvent(new Event('change', { bubbles: true }))`, true)
    await wait(async () => (await (await fetch(`${base}/__smoke/state`)).json()).lastUi?.value === 42.5, 'Committed numeric draft reaches backend as a number')
    await click('Recompute')
    await wait(() => execute(`document.body.innerText.includes('Control acknowledged asynchronously')`), 'Control response arrives after input ACK')
    await capture('io-inline-desktop.png')
    await click('Finish recording')
    await wait(() => execute(`document.querySelector('.request-state')?.textContent === 'Processing'`), 'Finish remains Processing')
    assert.equal((await state()).live, 0, 'Finish releases microphone while backend processes')
    assert.equal((await (await fetch(`${base}/__smoke/state`)).json()).status, 'stopping')
    await control('done')
    await wait(() => execute(`document.querySelector('.request-state')?.textContent === 'Complete' && document.body.innerText.includes('Rendered final result')`), 'Completion and result stay in the conversation')
    assert.equal(await execute(`document.querySelector('.backend-message') === null && document.querySelector('.capture-details').textContent.includes('Last service update:')`), true, 'Completion folds potentially stale service status into Details')
    window.setContentSize(390, 844)
    await execute(`document.documentElement.classList.remove('dark')`)
    await delay(100)
    assert.equal(await execute(`(() => { const card = document.querySelector('.io-request'); const rect = card.getBoundingClientRect(); return rect.width > 0 && rect.right <= innerWidth && rect.left >= 0 })()`), true, 'Card fits the mobile conversation')
    await capture('io-inline-mobile.png')
    await control('new')
    await wait(() => execute(`document.body.innerText.includes('Synthetic capture 2') && !!${button('Record audio')} && !${button('Record audio')}.disabled`), 'Second request prepares in conversation')
    await click('Record audio')
    await wait(async () => (await state()).live > 0, 'Second fake capture active')
    await click('Cancel')
    await wait(async () => (await state()).live === 0, 'Cancel clears all capture tracks')
    await wait(async () => (await (await fetch(`${base}/__smoke/state`)).json()).status === 'cancelled', 'Cancel reaches backend without process termination')
    await control('new')
    await wait(() => execute(`document.body.innerText.includes('Synthetic capture 3') && !!${button('Record audio')} && !${button('Record audio')}.disabled`), 'Failure fixture ready')
    await click('Record audio')
    await wait(async () => (await state()).live > 0, 'Failure fixture capture active')
    await control('invalid-view')
    await wait(async () => (await (await fetch(`${base}/__smoke/state`)).json()).status === 'failed', 'Invalid source fails the run')
    await wait(async () => (await state()).live === 0, 'Failure releases microphone')
    await wait(() => execute(`document.body.innerText.includes('The capture service sent an invalid control')`), 'Readable failure is visible inline')
    await execute(`document.querySelector('.capture-details').open = true`)
    await wait(() => execute(`document.body.innerText.includes('undeclared source "controls"')`), 'Full diagnostic remains available in Details')
    const reloaded = once(window.webContents, 'did-finish-load')
    window.reload()
    await reloaded
    await wait(() => execute(`!!document.querySelector('.io-request .capture-details')`), 'Persisted failure returns inside conversation')
    await execute(`document.querySelector('.capture-details').open = true`)
    await wait(() => execute(`document.body.innerText.includes('undeclared source "controls"') && !document.body.innerText.includes('see panel diagnostics')`), 'Persisted diagnostic visible after reload')
    assert.equal((await state()).acquired, 0, 'Reload never restarts capture')
    await control('new')
    await wait(() => execute(`document.body.innerText.includes('Synthetic capture 4') && !!${button('Record audio')} && !${button('Record audio')}.disabled`), 'Permission denial fixture ready')
    await execute(`void (navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Synthetic microphone access denied', 'NotAllowedError') })`)
    await click('Record audio')
    await wait(async () => (await (await fetch(`${base}/__smoke/state`)).json()).status === 'denied', 'Browser DOMException is classified as denied')
    await wait(() => execute(`document.body.innerText.includes('access was not allowed')`), 'Permission failure has a readable explanation')
    await execute(`document.querySelector('.capture-details').open = true`)
    await wait(() => execute(`document.body.innerText.includes('NotAllowedError: Synthetic microphone access denied')`), 'Permission denial has a persistent named cause')
    assert.equal((await state()).live, 0, 'Denial leaves no live devices')
    console.log('IO_RENDERED_SMOKE_OK inline ready device-switch switch-failure navigation async-control preserved-text-number-focus processing done mobile cancel persistent-failure permission-denial')
  } finally { window.destroy() }
}
void app.whenReady().then(main).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
