import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { checkNativePairing } from './native-pairing-smoke.js'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false, width: 1100, height: 850,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const origin = process.env.WEB_AUTH_SMOKE_URL!
  const code = process.env.WEB_AUTH_SMOKE_CODE!
  const route = '/projects/default/logs?filter=kept#trace'
  const execute = (source: string) => window.webContents.executeJavaScript(source)
  const wait = async (source: string) => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await execute(source)) return
      await delay(50)
    }
    throw new Error(`Timed out: ${source}\n${await execute('document.body.innerText')}`)
  }
  const checkBrowserChrome = async () => {
    assert.equal(await execute('typeof window.shadowDesktop'), 'undefined')
    assert.equal(await execute(`document.querySelectorAll('.browser-access-trigger, .window-controls, .native-desktop, button[aria-label="Minimize window"], button[aria-label="Maximize window"], button[aria-label="Close window"]').length`), 0)
    assert.notEqual(await execute(`getComputedStyle(document.querySelector('.desktop-title-bar')).getPropertyValue('-webkit-app-region')`), 'drag')
  }
  const checkStorage = async () => {
    const storage = await execute('JSON.stringify({ ...localStorage })') as string
    assert.ok(!storage.includes(code))
    assert.ok(!storage.includes('synthetic-browser-smoke-management-credential'))
    assert.equal(await execute(`document.cookie.includes('shadow_web_')`), false)
  }
  try {
    await window.loadURL(origin + route)
    await wait(`!!document.querySelector('#pairing-code')`)
    await execute(`(() => {
      const language = document.querySelector('.language-selector select');
      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await wait(`document.documentElement.lang === 'en'`)
    assert.equal(await execute(`document.querySelectorAll('.app-shell, #protected-route').length`), 0)
    assert.equal(await execute('location.pathname + location.search + location.hash'), route)
    await checkBrowserChrome()
    window.setContentSize(390, 844)
    assert.equal(await execute('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true)
    window.setContentSize(1100, 850)
    await execute(`(() => {
      const input = document.querySelector('#pairing-code');
      input.value = ${JSON.stringify(code)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await wait(`!document.querySelector('button[type="submit"]').disabled`)
    await execute(`document.querySelector('button[type="submit"]').click()`)
    await wait(`document.querySelector('#protected-route')?.getAttribute('data-ready') === 'true'`)
    assert.equal(await execute('location.pathname + location.search + location.hash'), route)
    assert.equal(await execute(`document.querySelectorAll('.app-shell').length`), 1)
    assert.equal(await execute(`document.querySelectorAll('#pairing-code').length`), 0)
    await checkBrowserChrome()
    await checkStorage()
    const cookies = await window.webContents.session.cookies.get({ url: origin })
    const cookie = cookies.find(cookie => cookie.name.startsWith('shadow_web_'))
    assert.ok(cookie, 'Pairing must create the actual browser session cookie')
    assert.equal(cookie.httpOnly, true)
    assert.equal(cookie.sameSite, 'strict')
    assert.ok(Math.abs(cookie.expirationDate! * 1000 - Date.now() - 12 * 60 * 60_000) < 30_000)
    assert.ok(!(await execute('JSON.stringify({ ...localStorage })') as string).includes(cookie.value))
    await execute(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Sign out').click()`)
    await wait(`!!document.querySelector('#pairing-code')`)
    assert.equal(await execute(`document.querySelectorAll('.app-shell, #protected-route').length`), 0)
    assert.equal(await execute('location.pathname + location.search + location.hash'), route)
    assert.equal((await window.webContents.session.cookies.get({ url: origin })).some(value => value.name === cookie.name), false)
    assert.deepEqual(await execute(`Promise.all(['/api/private', '/projects/default/api/private'].map(async path => (await fetch(path, { credentials: 'same-origin' })).status))`), [401, 401])
    const replay = await fetch(origin + '/api/private', { headers: { Cookie: `${cookie.name}=${cookie.value}`, Origin: origin } })
    assert.equal(replay.status, 401, 'Logout revokes the old server-side session, not just the cookie')
    await checkStorage()
    await checkBrowserChrome()
    await checkNativePairing(origin, process.env.WEB_AUTH_SMOKE_CREDENTIAL!)
    console.log('WEB_AUTH_BROWSER_SMOKE_OK')
  } finally {
    window.destroy()
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
