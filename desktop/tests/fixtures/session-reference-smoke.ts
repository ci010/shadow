import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const run = (s: string) => window.webContents.executeJavaScript(s)
  try {
    await window.loadURL(new URL('__activity', process.env.ACTIVITY_SMOKE_URL).href)
    for (let i = 0; i < 250 && !await run(`!!document.querySelector('.session-ref-option')`); i++) await delay(40)
    for (const width of [1000, 375]) {
      window.setSize(width, 800)
      await delay(250)
      const metrics = await run(`(() => {
        const menu = document.querySelector('.session-reference-menu'), list = document.querySelector('.session-ref-options'), row = document.querySelector('.session-ref-option'), name = row.querySelector('span');
        return { width:menu.getBoundingClientRect().width, height:menu.getBoundingClientRect().height, scroll:list.scrollWidth, client:list.clientWidth, rowHeight:row.getBoundingClientRect().height, border:getComputedStyle(row).borderTopWidth, ellipsis:getComputedStyle(name).textOverflow, text:menu.textContent, overflow: document.documentElement.scrollWidth > innerWidth, truncated:name.scrollWidth > name.clientWidth };
      })()`)
      assert.ok(metrics.width <= Math.min(480, width - 24), JSON.stringify(metrics))
      assert.ok(metrics.height <= 340 && metrics.height > 100)
      assert.equal(metrics.scroll, metrics.client, 'no horizontal list scroll')
      assert.ok(metrics.rowHeight <= 44, 'no stretched or wrapped rows')
      assert.equal(metrics.border, '0px', 'component styles beat global button defaults')
      assert.equal(metrics.ellipsis, 'ellipsis')
      assert.equal(metrics.truncated, true)
      assert.equal(metrics.overflow, false)
      assert.ok(metrics.text.includes('Long title'))
      assert.ok(!metrics.text.includes('web:chat-'))
      assert.ok(metrics.text.includes('New conversation'))
    }
    console.log('SESSION_REFERENCE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
