import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (source: string) => window.webContents.executeJavaScript(source)
  const wait = async (source: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(`Boolean(${source})`)) return; await delay(25) }
    throw new Error(`Timed out: ${source}\n${await execute('document.body.innerText')}`)
  }
  const capture = async (label: string) => {
    if (process.env.CONNECTION_SCREENSHOTS) await writeFile(
      join(process.env.CONNECTION_SCREENSHOTS, `${label}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const geometry = () => execute(`(() => {
    const route = document.querySelector('#route'); const rect = route.getBoundingClientRect();
    const input = document.querySelector('#draft').getBoundingClientRect();
    return { top:rect.top, left:rect.left, width:rect.width, height:rect.height, scroll:route.scrollTop, inputTop:input.top };
  })()`)
  try {
    await window.loadURL(new URL('__connection', process.env.CONNECTION_SMOKE_URL).href)
    await wait(`document.querySelector('#pairing-code')`)
    for (const width of [1200, 390, 320]) {
      window.setContentSize(width, 844)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await delay(50)
        assert.equal(await execute(`(() => {
          const input = document.querySelector('input').getBoundingClientRect();
          const submit = document.querySelector('button[type=submit]').getBoundingClientRect();
          const alternatives = [...document.querySelectorAll('.auth-alternatives button')];
          const rects = alternatives.map(button => button.getBoundingClientRect());
          return Math.abs(input.left - submit.left) < 1 && Math.abs(input.width - submit.width) < 1
            && rects[0].top >= submit.bottom + 20 && rects[1].top >= rects[0].bottom
            && [...document.querySelectorAll('button')].every(button => button.getBoundingClientRect().height >= 44 && getComputedStyle(button).borderRadius === '0px')
            && document.documentElement.scrollWidth <= innerWidth;
        })()`), true, 'Primary action aligns with the field; secondary actions have a stable vertical order')
        if (width !== 320) await capture(`connection-auth-${width}-${dark ? 'dark' : 'light'}`)
      }
    }
    await execute(`window.fixture.mode = 'app'`)
    await wait(`document.querySelector('#route')`)
    for (const width of [1200, 390, 320]) {
      window.setContentSize(width, 844)
      await delay(50)
      await execute(`document.querySelector('#route').scrollTop = 300; document.querySelector('#draft').focus({preventScroll:true})`)
      const before = await geometry()
      await execute(`window.fixture.liveError = 'Live updates disconnected. Reconnecting to Main; saved history remains available.'`)
      await wait(`document.querySelector('.status-trigger')?.getAttribute('aria-expanded') === 'true'`)
      assert.deepEqual(await geometry(), before)
      assert.equal(await execute(`document.activeElement.id`), 'draft', 'New errors must not steal focus')
      await execute(`document.querySelector('.status-notice button').click()`)
      assert.equal(await execute('window.fixture.retries'), [1200, 390, 320].indexOf(width) + 1)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await delay(50)
        assert.equal(await execute(`(() => {
          const panel = document.querySelector('.status-popover').getBoundingClientRect();
          const chrome = document.querySelector('.desktop-title-bar').getBoundingClientRect();
          return panel.top >= chrome.bottom && panel.left >= 11 && panel.right <= innerWidth - 11
            && panel.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth;
        })()`), true)
        if (width !== 320) await capture(`connection-status-${width}-${dark ? 'dark' : 'light'}`)
      }
      await execute(`document.querySelector('.status-notice button').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))`)
      await wait(`document.querySelector('.status-trigger').getAttribute('aria-expanded') === 'false'`)
      assert.equal(await execute(`document.activeElement.matches('.status-trigger')`), true)
      assert.deepEqual(await geometry(), before)
      await execute(`window.fixture.liveError = 'Still reconnecting to Main.'`)
      assert.equal(await execute(`document.querySelector('.status-trigger').getAttribute('aria-expanded')`), 'false', 'Repeated errors do not force dismissed details back open')
      await execute(`window.fixture.childTitle = 'Main is unavailable'; window.fixture.notificationError = 'Notification sounds could not be played.'`)
      await wait(`document.querySelectorAll('.status-notice').length === 3`)
      assert.equal(await execute(`document.querySelector('.status-trigger').getAttribute('aria-expanded')`), 'true')
      assert.deepEqual(await geometry(), before)
      await execute(`document.querySelector('.status-notice button').click()`)
      assert.equal(await execute('window.fixture.managed'), [1200, 390, 320].indexOf(width) + 1)
      await execute(`window.fixture.notificationError = 'A long failure description. '.repeat(120)`)
      await wait(`document.querySelector('.status-popover').scrollHeight > document.querySelector('.status-popover').clientHeight`)
      assert.equal(await execute(`document.querySelector('.status-popover').getBoundingClientRect().bottom <= innerHeight`), true)
      await execute(`document.querySelector('#draft').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))`)
      await wait(`document.querySelector('.status-trigger').getAttribute('aria-expanded') === 'false'`)
      assert.deepEqual(await geometry(), before)
      await execute(`window.fixture.childTitle = ''; window.fixture.liveError = ''; window.fixture.notificationError = ''`)
      await wait(`!document.querySelector('.connection-status')`)
      assert.deepEqual(await geometry(), before)
      assert.equal(await execute(`document.querySelector('#draft').value`), 'Unsent draft')
    }
    console.log('CONNECTION_LAYOUT_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
