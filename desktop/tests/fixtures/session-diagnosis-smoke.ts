import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 1100, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const click = (selector: string) => execute(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const scale = () => execute(`document.querySelector('.timeline-scale').innerText`)
  const inspector = () => execute(`document.querySelector('.span-inspector')?.innerText`)
  const pan = (value: number) => execute(`(() => { const input = document.querySelector('.timeline-pan input'); input.value = ${value}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const button = (label: string) => `button[aria-label="${label}"]`
  try {
    await window.loadURL(`${process.env.TRACE_SMOKE_URL}/__trace`)
    await wait(`document.querySelectorAll('.lane-bar').length === 3`)
    assert.match(await scale(), /355m 0s/)
    assert.match(await scale(), /360m 0s/)
    assert.equal(await execute(`document.querySelector('.timeline-pan input').value`), '100')
    assert.equal(await execute(`document.querySelectorAll('.lane-bar[title]').length`), 0)

    await click('.lane-bar.input')
    await wait(`!!document.querySelector('.span-inspector .trace-event-content')`)
    assert.match(await inspector(), /Recent input with complete event content/)
    assert.equal(await execute(`document.querySelector('.lane-bar.input').getAttribute('aria-pressed')`), 'true')
    const scroll = await execute(`document.querySelector('.diagnosis-scroll').scrollTop`)
    await click('.lane-bar.tools')
    await wait(`document.querySelector('.span-inspector')?.innerText.includes('Tool call JSON')`)
    assert.equal(await execute(`document.querySelector('.diagnosis-scroll').scrollTop`), scroll, 'Selection does not jump to event list')
    const call = JSON.parse(await execute(`document.querySelector('.span-inspector .trace-event-content pre').textContent`))
    assert.equal(call.id, 'call-1')
    assert.equal(JSON.parse(call.function.arguments).nested.value, 42)
    assert.match(await inspector(), /Synthetic tool result/)

    await execute(`document.querySelector('.lane-bar.tools').parentElement.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))`)
    await wait(`document.querySelector('[role="tooltip"]')?.textContent.includes('Synthetic metadata')`)
    assert.equal(await execute(`document.querySelector('[role="tooltip"]').parentElement === document.body`), true)
    assert.equal(await execute(`document.querySelector('.lane-bar.tools').getAttribute('aria-describedby') === document.querySelector('[role="tooltip"]').id`), true)
    assert.match(await execute(`document.querySelector('[role="tooltip"]').innerText`), /10.00 s/)
    await execute(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await wait(`!document.querySelector('[role="tooltip"]')`)

    await click('.lane-bar.model')
    assert.match(await inspector(), /Final model return/)
    assert.match(await inspector(), /Returned tool calls/)
    assert.equal(JSON.parse(await execute(`document.querySelector('.span-inspector .trace-event-content pre:nth-of-type(2)').textContent`))[0].id, 'call-1')
    await execute(`document.querySelector('.span-inspector .trace-event-content details').open = true`)
    assert.match(await inspector(), /Synthetic model reasoning/)
    for (const state of ['live', 'failed', 'recorded']) {
      await fetch(`${process.env.TRACE_SMOKE_URL}/__trace/model-${state}`)
      await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh').click()`)
      const text = state === 'live' ? 'Waiting for this model call' : state === 'failed' ? 'failed before returning' : 'Final model return'
      await wait(`document.querySelector('.span-inspector')?.innerText.includes(${JSON.stringify(text)})`)
    }
    await pan(50)
    await wait(`document.querySelector('.trace-timeline').textContent.includes('No recorded activity in this window')`)
    const manual = await scale()
    await fetch(`${process.env.TRACE_SMOKE_URL}/__trace/advance`)
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh').click()`)
    await wait(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Refresh' && !b.disabled)`)
    assert.equal(await scale(), manual, 'Refresh preserves manually positioned window')

    await pan(0)
    await wait(`document.querySelectorAll('.lane-bar').length === 2`)
    await click('.lane-bar.input')
    assert.match(await inspector(), /Old input/)
    await click('.lane-bar.model')
    assert.match(await inspector(), /Historical model return/)
    assert.match(await inspector(), /Historical response matched/)
    assert.equal(await execute(`document.querySelector(${JSON.stringify(button('Previous time window'))}).disabled`), true)
    await click(button('Next time window'))
    assert.match(await scale(), /5m 0s/)
    await click(button('Previous time window'))
    assert.match(await scale(), /0 ms/)
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Latest 5 min').click()`)
    assert.match(await scale(), /356m 0s/)
    assert.match(await scale(), /361m 0s/)

    await click(button('Zoom into trace'))
    assert.match(await scale(), /357m 15s/)
    await click(button('Zoom out of trace'))
    assert.match(await scale(), /356m 0s/)
    for (let i = 0; i < 7; i++) await click(button('Zoom out of trace'))
    assert.equal(await execute(`!!document.querySelector('.timeline-pan')`), false)
    assert.match(await scale(), /0 ms/)
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Latest 5 min').click()`)

    window.setContentSize(390, 844)
    await delay(100)
    assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'Mobile layout has no horizontal page overflow')
    assert.equal(await execute(`document.querySelector('.trace-timeline').scrollWidth <= document.querySelector('.trace-timeline').clientWidth`), true, 'Mobile timeline controls fit')
    await click('.lane-bar.tools')
    assert.match(await inspector(), /Tool call JSON/)
    await click('.lane-bar.model')
    assert.match(await inspector(), /Final model return/)
    const download = new Promise<string>(resolve => {
      window.webContents.session.once('will-download', (event, item) => {
        event.preventDefault()
        resolve(item.getFilename())
      })
    })
    await execute(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export for agent').click()`)
    await wait(`document.body.innerText.includes('Exported a partial snapshot')`)
    assert.equal(await Promise.race([download, delay(5000).then(() => 'download-timeout')]), 'diagnosis-segment.json')
    console.log('TRACE_RENDERED_SMOKE_OK')
  } finally {
    window.destroy()
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
