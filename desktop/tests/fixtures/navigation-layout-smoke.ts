import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 2000, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\nActive: ${await execute('document.activeElement.outerHTML')}`)
  }
  try {
    await window.loadURL(new URL('__navigation', process.env.NAVIGATION_SMOKE_URL).href)
    await wait(`!!document.querySelector('.knowledge')`)
    await execute(`document.querySelector('.knowledge').append(Object.assign(document.createElement('div'), { style:'height:1800px', textContent:'Long knowledge content' }))`)
    for (const width of [2000, 1100, 390]) {
      window.setContentSize(width, 844)
      await execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      const layout = await execute(`(() => {
        const scroll = document.querySelector('.knowledge-scroll');
        const content = document.querySelector('.knowledge');
        return { right:scroll.getBoundingClientRect().right, viewport:innerWidth,
          width:content.getBoundingClientRect().width, scrollable:scroll.scrollHeight > scroll.clientHeight,
          outerOverflow:document.documentElement.scrollWidth > innerWidth,
          left:content.offsetLeft, expectedLeft:(scroll.clientWidth - content.offsetWidth) / 2 };
      })()`)
      assert.equal(layout.right, layout.viewport, 'Scrollbar container must reach the pane edge')
      assert(layout.width <= 1600, 'Content keeps its readable maximum width')
      assert(layout.scrollable)
      assert.equal(layout.outerOverflow, false)
      assert(Math.abs(layout.left - layout.expectedLeft) <= 1, 'Content stays centered inside the scrollport')
      await execute(`document.querySelector('.knowledge-scroll').scrollTop = 500`)
      assert.equal(await execute(`document.querySelector('.knowledge-scroll').scrollTop`), 500)
    }
    await execute(`document.querySelector('#switch').click()`)
    await wait(`document.querySelectorAll('.history-marker').length === 3`)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      await execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      const labels = await execute(`Array.from(document.querySelectorAll('.history-marker'), el => el.getAttribute('aria-label'))`)
      assert.match(labels[0], /User message from Alice/)
      assert.match(labels[1], /Session progress from Reviewer \(web:reviewer\)/)
      assert.match(labels[2], /Agent completed from Worker \(task:worker\)/)
      // Hidden Chromium windows update activeElement without delivering native focus events.
      await execute(`{ const marker = document.querySelectorAll('.history-marker')[1]; marker.focus(); marker.dispatchEvent(new FocusEvent('focus')); }`)
      await wait(`document.querySelector('[role="tooltip"]')?.textContent.includes('web:reviewer')`)
      await execute(`document.querySelectorAll('.history-marker')[1].dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true }))`)
      assert.equal(await execute(`document.activeElement === document.querySelectorAll('.history-marker')[2]`), true)
      await execute(`document.activeElement.dispatchEvent(new FocusEvent('focus'))`)
      await wait(`document.querySelector('[role="tooltip"]')?.textContent.includes('task:worker')`)
      assert.equal(await execute(`(() => { const r = document.querySelector('[role="tooltip"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })()`), true)
      await execute(`document.querySelectorAll('.history-marker')[2].click()`)
      await wait(`Math.abs(document.querySelector('[data-msg-idx="3"]').getBoundingClientRect().top - document.querySelector('.fixture-messages').getBoundingClientRect().top) < 2`)
      await execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`)
      await wait(`!document.querySelector('[role="tooltip"]')`)
      await execute(`document.querySelectorAll('.history-marker')[0].click()`)
      await wait(`document.querySelector('.fixture-messages').scrollTop < 2`)
    }
    await execute(`document.querySelector('#switch').click()`)
    await wait(`document.querySelectorAll('.node rect').length === 3 && !!document.querySelector('.composer-send')`)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      await execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      for (const radius of [0, 10]) {
        await execute(`document.documentElement.style.setProperty('--radius-surface', '${radius}px'); document.documentElement.style.setProperty('--radius-control', '${radius}px')`)
        const radii = await execute(`[
          ...Array.from(document.querySelectorAll('.node rect'), el => getComputedStyle(el).rx),
          ...Array.from(document.querySelectorAll('.resume-bar, .resume-button, .composer-send'), el => getComputedStyle(el).borderTopLeftRadius),
        ]`)
        assert.equal(radii.length, 6)
        assert(radii.every((value: string) => value === `${radius}px`), 'Graph, recovery and actions must follow live global token changes')
      }
      assert.equal(await execute(`document.querySelectorAll('.composer-submit button').length`), 1)
      const sendRect = await execute(`(() => { const r = document.querySelector('.composer-send').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} })()`)
      await execute(`window.__composerFixture.canSend = false`)
      await wait(`document.querySelector('[aria-label="Send message"]')?.disabled`)
      await execute(`window.__composerFixture.canSend = true`)
      await wait(`!document.querySelector('[aria-label="Send message"]').disabled`)
      const sent = await execute(`window.__composerFixture.sent`)
      await execute(`document.querySelector('[aria-label="Send message"]').click()`)
      assert.equal(await execute(`window.__composerFixture.sent`), sent + 1)
      await execute(`window.__composerFixture.requestBusy = true; window.__composerFixture.canSend = false`)
      await wait(`!!document.querySelector('[aria-label="Stop current request"]')`)
      assert.equal(await execute(`document.querySelectorAll('.composer-submit button').length`), 1)
      assert.equal(await execute(`document.querySelector('[aria-label="Stop current request"]').disabled`), false, 'Empty draft must not disable Stop')
      const stopRect = await execute(`(() => { const r = document.querySelector('.composer-stop').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} })()`)
      assert.deepEqual(stopRect, sendRect, 'Stop replaces Send without moving or resizing')
      const stopped = await execute(`window.__composerFixture.stopped`)
      await execute(`document.querySelector('.composer-stop').click()`)
      assert.equal(await execute(`window.__composerFixture.stopped`), stopped + 1)
      await execute(`window.__composerFixture.currentRequest.state.stopping = true`)
      await wait(`document.querySelector('.composer-stop')?.disabled`)
      assert.equal(await execute(`document.querySelector('.composer-stop').getAttribute('aria-busy')`), 'true')
      await execute(`document.querySelector('.composer-stop').click()`)
      assert.equal(await execute(`window.__composerFixture.stopped`), stopped + 1)
      await execute(`window.__composerFixture.currentRequest.state.stopping = false; window.__composerFixture.installation.uiScopes = []`)
      await wait(`document.querySelector('.composer-stop')?.disabled && !document.querySelector('.composer-stop').hasAttribute('aria-busy')`)
      await execute(`window.__composerFixture.requestBusy = false; window.__composerFixture.canSend = true; window.__composerFixture.installation.uiScopes = ['chat:write']`)
      await wait(`!!document.querySelector('[aria-label="Send message"]')`)
    }
    console.log('NAVIGATION_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
