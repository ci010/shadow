import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../src/ipc-contract.js'
import { installWebPairing } from '../../src/web-pairing.js'
import type { DesktopWebPairing } from '../../src/web-pairing-contract.js'

export async function checkNativePairing(origin: string, token: string) {
  const window = new BrowserWindow({
    show: false, width: 1100, height: 850,
    webPreferences: {
      preload: join(process.cwd(), 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    },
  })
  const execute = (source: string) => window.webContents.executeJavaScript(source)
  const wait = async (source: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await execute(source)) return
      await delay(50)
    }
    throw new Error(`Native pairing timed out: ${source}`)
  }
  let calls = 0
  let mode: 'normal' | 'error' | 'expire' | 'delayed' = 'normal'
  let release: (() => void) | undefined
  const authorization = { apiBase: origin, launchToken: token }
  const dispose = installWebPairing(ipcMain, window, () => authorization, async (input, init) => {
    calls++
    if (mode === 'error') throw new Error(`Synthetic transport failure ${token}`)
    if (mode === 'delayed') await new Promise<void>(resolve => { release = resolve })
    const response = await fetch(input, init)
    if (mode !== 'expire') return response
    assert.equal(response.status, 200)
    const data = await response.json() as DesktopWebPairing
    return Response.json({ ...data, expiresAt: new Date(Date.now() + 1500).toISOString() })
  })
  const opened: string[] = []
  ipcMain.handle(IPC_CHANNELS.openExternal, (_event, url: string) => { opened.push(url) })
  const click = (text: string) => execute(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`)
  const show = () => execute(`document.querySelector('.browser-access-trigger').click()`)
  const close = () => execute(`document.querySelector('button[aria-label="Close browser pairing"]').click()`)
  try {
    await window.loadURL(`${origin}/src/native-pairing-smoke.html`)
    await wait(`!!document.querySelector('.browser-access-trigger')`)
    assert.equal(calls, 0, 'Mounting the header must not issue a code')
    for (const dark of [false, true]) {
      await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
      for (const width of [390, 900, 1440]) {
        window.setContentSize(width, 850)
        const trigger = await execute(`(() => {
          const button = document.querySelector('.browser-access-trigger');
          const icon = button.querySelector('.browser-access-icon');
          const box = button.getBoundingClientRect();
          const glyph = icon.getBoundingClientRect();
          const style = getComputedStyle(button);
          return {
            width: box.width, height: box.height, iconWidth: glyph.width, iconHeight: glyph.height,
            offsetX: glyph.x + glyph.width / 2 - box.x - box.width / 2,
            offsetY: glyph.y + glyph.height / 2 - box.y - box.height / 2,
            text: button.textContent.trim(), title: button.title, label: button.getAttribute('aria-label'),
            padding: style.padding, background: style.backgroundColor, border: style.borderTopWidth,
            drag: style.getPropertyValue('-webkit-app-region'), mask: getComputedStyle(icon).maskImage,
          };
        })()`)
        assert.deepEqual({
          width: trigger.width, height: trigger.height, iconWidth: trigger.iconWidth, iconHeight: trigger.iconHeight,
          offsetX: trigger.offsetX, offsetY: trigger.offsetY, text: trigger.text, title: trigger.title, label: trigger.label,
          padding: trigger.padding, background: trigger.background, drag: trigger.drag,
        }, {
          width: 28, height: 28, iconWidth: 14, iconHeight: 14, offsetX: 0, offsetY: 0, text: '',
          title: 'Connect browser', label: 'Connect browser', padding: '0px',
          background: 'rgba(0, 0, 0, 0)', drag: 'no-drag',
        }, `Compact title-bar action at ${width}px, dark=${dark}`)
        assert.ok(parseFloat(trigger.border) > 0 && parseFloat(trigger.border) <= 1, 'Thin border survives device-pixel snapping')
        assert.notEqual(trigger.mask, 'none', 'The icon must render, not leave an empty button')
      }
    }
    window.setContentSize(1100, 850)
    await execute(`document.querySelector('.browser-access-trigger').focus()`)
    assert.equal(await execute(`document.activeElement === document.querySelector('.browser-access-trigger')`), true)
    window.webContents.debugger.attach('1.3')
    try {
      await window.webContents.debugger.sendCommand('DOM.enable')
      await window.webContents.debugger.sendCommand('CSS.enable')
      const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument')
      const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.browser-access-trigger' })
      await window.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] })
      assert.equal(await execute(`getComputedStyle(document.querySelector('.browser-access-trigger')).outlineStyle`), 'solid')
      assert.ok(await execute(`parseFloat(getComputedStyle(document.querySelector('.browser-access-trigger')).outlineWidth) > 0`))
    } finally { window.webContents.debugger.detach() }
    assert.equal(await execute(`Object.isFrozen(window.shadowDesktop.webPairing)`), true)
    assert.deepEqual(await execute(`Object.keys(window.shadowDesktop.webPairing)`), ['create'])
    await execute(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async value => { if (window.failCopy) throw new Error('denied'); window.copiedCode = value; }
    } })`)
    await show()
    await wait(`!!document.querySelector('.pairing-code')`)
    assert.equal(calls, 1)
    assert.equal(await execute(`document.querySelector('dialog').matches(':modal')`), true)
    assert.equal(await execute(`document.querySelector('dialog').contains(document.activeElement)`), true)
    const code = await execute(`document.querySelector('.pairing-code').textContent`) as string
    assert.match(code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){5}$/)
    assert.equal(await execute(`document.body.innerText.includes(${JSON.stringify(token)})`), false)
    await click('Copy code')
    await wait(`!!document.querySelector('.pairing-copied')`)
    assert.equal(await execute('window.copiedCode'), code)
    await click('Open Web')
    for (let attempt = 0; !opened.length && attempt < 100; attempt++) await delay(10)
    assert.deepEqual(opened, [`${origin}/`], 'Opening Web must never put the code in the URL')
    window.setContentSize(390, 844)
    assert.equal(await execute(`document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth`), true)
    assert.equal(await execute('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true)
    window.setContentSize(1100, 850)
    const pair = () => fetch(`${origin}/api/web-auth/pair`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })
    assert.equal((await pair()).status, 200, 'Native-issued code pairs with the actual backend')
    assert.equal((await pair()).status, 401, 'Native-issued code is single-use')
    await execute('window.failCopy = true')
    await click('Copy code')
    await wait(`document.querySelector('.pairing-error')?.textContent.includes('Could not copy')`)
    await execute('window.failCopy = false')
    await execute(`document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`)
    await wait(`!document.querySelector('dialog')`)
    assert.equal(await execute(`document.activeElement === document.querySelector('.browser-access-trigger')`), true)
    assert.equal(await execute(`document.body.innerText.includes(${JSON.stringify(code)})`), false)

    mode = 'error'
    await show()
    await wait(`document.querySelector('.pairing-error')?.textContent.includes('Could not generate')`)
    assert.equal(await execute(`document.body.innerText.includes(${JSON.stringify(token)})`), false)
    mode = 'normal'
    await click('Retry')
    await wait(`!!document.querySelector('.pairing-code')`)
    mode = 'expire'
    await click('Generate new code')
    await wait(`!!document.querySelector('.pairing-expired')`)
    assert.equal(await execute(`document.querySelectorAll('.pairing-code').length`), 0)
    assert.equal(await execute(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Copy code').disabled`), true)
    mode = 'normal'
    await click('Generate new code')
    await wait(`!!document.querySelector('.pairing-code')`)
    await close()
    await wait(`!document.querySelector('dialog')`)
    mode = 'delayed'
    await show()
    await wait(`document.querySelector('dialog')?.textContent.includes('Generating pairing code')`)
    for (let attempt = 0; !release && attempt < 100; attempt++) await delay(10)
    assert.ok(release, 'The pending IPC must start before testing close')
    await close()
    release?.()
    await delay(300)
    assert.equal(await execute(`document.querySelectorAll('dialog, .pairing-code').length`), 0)
    const storage = await execute('JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })') as string
    assert.ok(!storage.includes(code))
    assert.ok(!storage.includes(token))
    console.log('NATIVE_PAIRING_SMOKE_OK')
  } finally {
    release?.()
    dispose()
    ipcMain.removeHandler(IPC_CHANNELS.openExternal)
    window.destroy()
  }
}
