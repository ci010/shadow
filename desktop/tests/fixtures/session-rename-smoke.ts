import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const click = () => execute(`document.querySelector('[aria-label="Rename session"]').click()`)
  const fill = (value: string) => execute(`(() => {
    const input = document.querySelector('input[aria-label="Session name"]');
    input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  const key = async (keyCode: 'Enter' | 'Escape') => {
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
    const event = { key: keyCode, code: keyCode, windowsVirtualKeyCode: keyCode === 'Enter' ? 13 : 27 }
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', ...event, ...(keyCode === 'Enter' ? { text: '\r' } : {}),
    })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  try {
    await window.loadURL(new URL('__rename', process.env.RENAME_SMOKE_URL).href)
    await wait(`document.querySelector('.heading-folder')?.textContent === 'synthetic'`)
    for (const width of [1200, 390]) {
      window.setContentSize(width, 844)
      await click()
      await wait(`document.activeElement?.getAttribute('aria-label') === 'Session name'`)
      assert.equal(await execute(`document.activeElement.selectionEnd - document.activeElement.selectionStart === document.activeElement.value.length`), true)
      await fill(`  Saved at ${width}  `)
      assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
      await key('Enter')
      await wait(`document.querySelector('#saved-name').textContent === 'Saved at ${width}'`)
      await wait(`document.querySelector('.heading-name').textContent === 'Synthetic project / Saved at ${width}'`)
      await wait(`document.activeElement?.getAttribute('aria-label') === 'Rename session'`)
      assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
    }
    await click()
    await wait(`document.activeElement?.tagName === 'INPUT'`)
    await fill('Do not save')
    await key('Escape')
    await wait(`!document.querySelector('.session-rename')`)
    assert.equal(await execute(`document.querySelector('#saved-name').textContent`), 'Saved at 390')
    await click()
    await wait(`document.activeElement?.tagName === 'INPUT'`)
    await fill('Fail this rename')
    await key('Enter')
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('Retry')`)
    assert.equal(await execute(`document.querySelector('input').value`), 'Fail this rename')
    assert.equal(await execute(`document.querySelector('#saved-name').textContent`), 'Saved at 390')
    console.log('RENAME_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
