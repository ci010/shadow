import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  try {
    await window.loadURL(process.env.CONVERSATION_SMOKE_URL!)
    const run = (code: string) => window.webContents.executeJavaScript(code)
    const wait = async (condition: string) => {
      for (let i = 0; i < 250; i++) { if (await run(condition)) return; await delay(50) }
      throw new Error(`Not rendered: ${condition}\n${await run('document.body.innerText')}\n${errors.join('\n')}`)
    }
    await wait('!!window.__fixtureRouter && !!document.querySelector(".draft-heading")')
    const navigate = (id: string) => run(`window.__fixtureRouter.push('/projects/work/chat/${encodeURIComponent(id)}')`)
    const verify = (text: string) => wait(`[...document.querySelectorAll('.chat-history')].some(el => el.getClientRects().length && el.innerText.includes(${JSON.stringify(text)}))`)
    const mark = async () => { await delay(1100); await run(`fetch('/__switch-mark').then(response => response.text())`) }
    await navigate('web:chat-one')
    await verify('snapshot web:chat-one')
    await mark()
    for (const id of ['web:chat-two', 'bot:fixture:readonly']) {
      await navigate(id)
      const transport = process.env.CONVERSATION_SMOKE_TRANSPORT
      await verify(`${transport} snapshot ${id}`)
      if (id === 'web:chat-two') {
        const trigger = '[data-session-work="follow-up"]'
        await wait(`!!document.querySelector(${JSON.stringify(trigger)})`)
        await run(`document.querySelector(${JSON.stringify(trigger)}).click()`)
        await wait('document.querySelector(".follow-up-instruction")?.textContent === "Review the fixture after the timer"')
        if (transport === 'Socket') {
          await run(`fetch('/__follow-up-clear').then(response => response.text())`)
          await wait(`!document.querySelector(${JSON.stringify(trigger)})`)
        }
      }
      await mark()
    }
    assert.deepEqual(errors, [], 'No renderer console errors')
  } finally { window.destroy(); app.quit() }
}
main().catch(error => { console.error(error); app.exit(1) })
