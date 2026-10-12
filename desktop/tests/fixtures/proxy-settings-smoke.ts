import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  try {
    await window.loadURL(new URL('__proxy', process.env.PROXY_SMOKE_URL).href)
    await wait(`document.querySelector('.proxy-toggle input')?.disabled === false`)
    for (const width of [1200, 390]) {
      window.setContentSize(width, 900)
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth'), true)
      assert.equal(await execute(`document.querySelector('.settings-navigation [aria-current="page"]').textContent.trim()`), 'Proxy')
      assert.equal(await execute(`document.querySelector('.proxy-toggle input').labels.length`), 1)
      assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.proxy-settings input[readonly]'), input => input.value)`), ['http://proxy.example:8080/', 'http://proxy.example:8443/'])
    }
    assert.equal(await execute(`document.body.innerText.includes('on Main, not on this browser device')`), true)
    await execute(`window.fixture.fail = true; document.querySelector('.proxy-toggle input').click()`)
    await wait(`!!document.querySelector('.proxy-settings [role="alert"]')`)
    assert.equal(await execute(`document.querySelector('.proxy-toggle input').checked`), true, 'failed save must restore checkbox')
    assert.equal(await execute(`document.body.innerText.includes('synthetic-private-error')`), false)
    await execute(`window.fixture.fail = false; document.querySelector('.proxy-toggle input').click()`)
    await wait(`document.querySelector('.proxy-settings').getAttribute('aria-busy') === 'false' && !document.querySelector('.proxy-toggle input').checked`)
    assert.deepEqual(await execute(`window.fixture.patches.at(-1)`), { enabled: false })
    await execute(`document.querySelector('.proxy-settings button').click()`)
    await wait(`window.fixture.detections === 1 && document.querySelector('.proxy-settings').getAttribute('aria-busy') === 'false'`)
    assert.equal(await execute(`document.querySelector('.proxy-toggle input').checked`), false)
    assert.equal(await execute(`window.fixture.patches.length`), 2)
    await execute(`Object.assign(window.fixture.state, {source:'windows-auto',http:'',https:''}); document.querySelector('.proxy-settings button').click()`)
    await wait(`document.body.innerText.includes('PAC / auto-detect')`)
    assert.equal(await execute(`document.querySelectorAll('.proxy-settings input[readonly]').length`), 0)
    await execute(`Object.assign(window.fixture.state, {source:'direct',detected:false}); document.querySelector('.proxy-settings button').click()`)
    await wait(`document.body.innerText.includes('No system proxy detected')`)
    console.log('PROXY_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
